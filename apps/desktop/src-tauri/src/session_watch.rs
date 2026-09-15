//! The session watch: one thread that reads the process list every second, opens a session
//! when a supported game starts, keeps a recording running while the player is in the game,
//! feeds the game's provider into the timeline, and ends the session once the player has left.
//!
//! With the background recording on, any other game the capture hooks gets a session too
//! (`SessionGame::Other`), which lasts while its process runs and records in parts the recorder
//! splits off without a gap. A supported game starting meanwhile ends it and takes over.
//!
//! Everything app-specific (the recorder, settings, the window) sits behind [`Host`], so the
//! state machine here runs in tests against a fake one.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};

use crate::sessions::SessionStore;
use crate::timeline::{self, EndReason, Event, GameEvent, Provider, SessionGame, Sighting};

/// How often the watch looks.
pub const TICK: std::time::Duration = std::time::Duration::from_secs(1);

/// How long the game may be gone before the session ends. Covers the tick jitter around a
/// process exit, not a crash-and-relaunch: a relaunch is a new session.
const EXIT_GRACE: Duration = Duration::seconds(10);

/// How long a session stays open while only the game's client runs: League between matches,
/// through queue and champion select.
const CLIENT_GRACE: Duration = Duration::minutes(6);

/// How long to wait before trying again after the recorder refused to start a recording.
const START_RETRY: Duration = Duration::seconds(5);

/// What the watch needs from the app.
pub trait Host: Send + Sync {
    fn running_executables(&self) -> Vec<String>;
    /// The "record whole sessions" setting.
    fn enabled(&self) -> bool;
    /// The "record other games" setting.
    fn other_games_enabled(&self) -> bool {
        false
    }
    /// The executable the game capture has hooked right now, if any.
    fn hooked_executable(&self) -> Option<String> {
        None
    }
    /// How long each part of a recording of `game` runs before the recorder splits the file;
    /// `None` records one file for as long as the recording lasts.
    fn split_every(&self, _game: SessionGame) -> Option<std::time::Duration> {
        None
    }
    /// A part of a split recording was finished.
    fn part_finished(&self, _session_id: i64) {}
    /// Where recording number `n` of a session goes.
    fn recording_path(&self, session_id: i64, n: usize) -> PathBuf;
    /// Starts writing `path`, split into parts of `split` when given; the recorder names the
    /// parts after the first itself, and `current_recording` says which one it is on.
    fn start_recording(&self, path: &Path, split: Option<std::time::Duration>) -> Result<()>;
    /// Stops the recording and returns when the stop was asked for, which is where the file
    /// ends and so what its start is measured back from.
    fn stop_recording(&self) -> Result<DateTime<Utc>>;
    /// The file the recorder is writing right now, if any.
    fn current_recording(&self) -> Option<PathBuf>;
    fn provider(&self, game: SessionGame) -> Option<Box<dyn Provider>>;
    /// The name the clip library files this game under.
    fn game_name(&self, sighting: &Sighting) -> String;
    /// Something on the session's timeline changed; tell the UI.
    fn session_changed(&self, session_id: i64);
    /// The session is over and waits to be processed.
    fn session_ended(&self, session_id: i64);
}

/// The session being played right now.
struct Live {
    id: i64,
    game: SessionGame,
    game_name: String,
    /// The process the session follows; for `Other`, the only way to tell the game still runs.
    executable: String,
    /// The recorder splits this session's recordings into parts.
    split: Option<std::time::Duration>,
    provider: Option<Box<dyn Provider>>,
    reached: bool,
    /// The recording row and file being written.
    recording: Option<(i64, PathBuf)>,
    recordings_made: usize,
    open_match: Option<i64>,
    last_in_game: DateTime<Utc>,
    next_start_attempt: DateTime<Utc>,
    last_start_error: Option<String>,
}

/// A snapshot for the status pill.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct LiveSession {
    pub id: i64,
    pub game: SessionGame,
    pub game_name: String,
    pub recording: bool,
    pub match_id: Option<i64>,
}

pub struct Watch {
    store: Arc<SessionStore>,
    host: Arc<dyn Host>,
    live: Option<Live>,
}

impl Watch {
    pub fn new(store: Arc<SessionStore>, host: Arc<dyn Host>) -> Self {
        Self { store, host, live: None }
    }

    pub fn live(&self) -> Option<LiveSession> {
        self.live.as_ref().map(|l| LiveSession {
            id: l.id,
            game: l.game,
            game_name: l.game_name.clone(),
            recording: l.recording.is_some(),
            match_id: l.open_match,
        })
    }

    /// One look at the world. Errors are logged, never returned: a database hiccup must not
    /// end a session that is still being played.
    pub fn tick(&mut self, now: DateTime<Utc>) {
        let running = self.host.running_executables();
        let sighting = timeline::sight(&running);
        let enabled = self.host.enabled();
        let other_enabled = self.host.other_games_enabled();

        let Some(mut live) = self.live.take() else {
            let found = sighting.filter(|s| s.in_game && enabled).or_else(|| {
                other_enabled
                    .then(|| timeline::sight_other(&running, self.host.hooked_executable().as_deref()))
                    .flatten()
            });
            if let Some(s) = found {
                match self.begin(&s, now) {
                    Ok(live) => self.live = Some(live),
                    Err(e) => log::error!("could not open a session for {}: {e:#}", s.game.id()),
                }
            }
            return;
        };

        let (in_game, client_open, on) = if live.game == SessionGame::Other {
            let runs = running.iter().any(|r| r.eq_ignore_ascii_case(&live.executable));
            // A supported game has a provider and a session of its own; it takes over.
            let supported = sighting.as_ref().is_some_and(|s| s.in_game && enabled);
            if supported {
                log::info!("session {}: a supported game started, ending the background recording", live.id);
            }
            (runs, false, other_enabled && !supported)
        } else {
            let same = sighting.filter(|s| s.game == live.game);
            (same.as_ref().is_some_and(|s| s.in_game), same.is_some(), enabled)
        };
        if in_game {
            live.last_in_game = now;
        }
        let grace = if client_open { CLIENT_GRACE } else { EXIT_GRACE };
        let left = !in_game && now - live.last_in_game >= grace;

        if !on || left {
            let end = if on { live.last_in_game } else { now };
            self.finish(live, end);
            return;
        }

        if in_game {
            self.ensure_recording(&mut live, now);
        } else {
            self.stop_recording(&mut live);
        }
        self.poll_provider(&mut live, now);
        self.live = Some(live);
    }

    fn begin(&self, s: &Sighting, now: DateTime<Utc>) -> Result<Live> {
        let name = self.host.game_name(s);
        let id = self.store.create_session(s.game, &name, now)?;
        log::info!("session {id} started: {name} ({})", s.executable);
        let mut live = Live {
            id,
            game: s.game,
            game_name: name,
            executable: s.executable.clone(),
            split: self.host.split_every(s.game),
            provider: self.host.provider(s.game),
            reached: false,
            recording: None,
            recordings_made: 0,
            open_match: None,
            last_in_game: now,
            next_start_attempt: now,
            last_start_error: None,
        };
        self.ensure_recording(&mut live, now);
        self.host.session_changed(id);
        Ok(live)
    }

    fn ensure_recording(&self, live: &mut Live, now: DateTime<Utc>) {
        if let Some((row, path)) = &live.recording {
            let current = self.host.current_recording();
            if current.as_deref() == Some(path.as_path()) {
                return;
            }
            // Only the recorder moves to another file by itself: that is a split, and the part
            // so far is finished. The next carries on from its last frame.
            if let (Some(next), Some(_)) = (current, live.split) {
                let row = *row;
                if let Err(e) = self.store.stop_recording(row, now) {
                    log::warn!("session {}: {e:#}", live.id);
                }
                match self.store.add_recording_after(live.id, &next, now, Some(row)) {
                    Ok(next_row) => {
                        log::info!("session {}: recording carries on in {}", live.id, next.display());
                        live.recording = Some((next_row, next));
                        live.recordings_made += 1;
                        self.host.session_changed(live.id);
                        self.host.part_finished(live.id);
                    }
                    // The recorder keeps writing; the next tick tries the row again.
                    Err(e) => log::error!("session {}: {e:#}", live.id),
                }
                return;
            }
            // The recorder restarted or the output died. The file so far is still good.
            log::warn!("session {}: recording {} was interrupted", live.id, path.display());
            if let Err(e) = self.store.stop_recording(*row, now) {
                log::warn!("session {}: {e:#}", live.id);
            }
            live.recording = None;
            self.host.session_changed(live.id);
        }
        if now < live.next_start_attempt {
            return;
        }
        let n = live.recordings_made + 1;
        let path = self.host.recording_path(live.id, n);
        // The row goes in first so a file on disk always has one, even after a crash.
        let row = match self.store.add_recording(live.id, &path, now) {
            Ok(row) => row,
            Err(e) => {
                log::error!("session {}: {e:#}", live.id);
                live.next_start_attempt = now + START_RETRY;
                return;
            }
        };
        match self.host.start_recording(&path, live.split) {
            Ok(()) => {
                live.recording = Some((row, path));
                live.recordings_made = n;
                live.last_start_error = None;
                self.host.session_changed(live.id);
            }
            Err(e) => {
                let text = format!("{e:#}");
                // The recorder may be down for a while (first launch, a restart); say so once.
                if live.last_start_error.as_deref() != Some(text.as_str()) {
                    log::warn!("session {}: recording not started: {text}", live.id);
                    live.last_start_error = Some(text);
                }
                if let Err(e) = self.store.delete_recording(row) {
                    log::warn!("session {}: {e:#}", live.id);
                }
                live.next_start_attempt = now + START_RETRY;
            }
        }
    }

    fn stop_recording(&self, live: &mut Live) {
        let Some((row, path)) = live.recording.take() else {
            return;
        };
        match self.host.stop_recording() {
            Ok(at) => {
                if let Err(e) = self.store.stop_recording(row, at) {
                    log::warn!("session {}: {e:#}", live.id);
                }
            }
            // The row keeps no stop time; processing measures the file instead.
            Err(e) => log::warn!("session {}: stopping {}: {e:#}", live.id, path.display()),
        }
        self.host.session_changed(live.id);
    }

    fn poll_provider(&self, live: &mut Live, now: DateTime<Utc>) {
        let Some(provider) = live.provider.as_mut() else {
            return;
        };
        let events = provider.poll(now);
        if !live.reached && provider.reached() {
            live.reached = true;
            if let Err(e) = self.store.set_provider_reached(live.id) {
                log::warn!("session {}: {e:#}", live.id);
            }
        }
        if events.is_empty() {
            return;
        }
        for event in events {
            if let Err(e) = self.apply(live, &event) {
                log::error!("session {}: recording {:?}: {e:#}", live.id, event.event.kind());
            }
        }
        self.host.session_changed(live.id);
    }

    fn apply(&self, live: &mut Live, e: &GameEvent) -> Result<()> {
        match &e.event {
            Event::MatchStart { map, mode } => {
                if let Some(previous) = live.open_match.take() {
                    self.store.add_event(live.id, Some(previous), &GameEvent {
                        at: e.at,
                        event: Event::MatchEnd {
                            ally: None,
                            enemy: None,
                            result: None,
                            reason: EndReason::Superseded,
                        },
                    })?;
                    self.store.close_match(previous, e.at, None, None, None)?;
                }
                let id = self.store.open_match(live.id, e.at, map.as_deref(), mode.as_deref())?;
                log::info!(
                    "session {}: match {id} started ({} / {})",
                    live.id,
                    map.as_deref().unwrap_or("?"),
                    mode.as_deref().unwrap_or("?")
                );
                self.store.add_event(live.id, Some(id), e)?;
                live.open_match = Some(id);
            }
            Event::RoundEnd { ally, enemy, .. } => {
                self.store.add_event(live.id, live.open_match, e)?;
                if let Some(id) = live.open_match {
                    self.store.set_match_score(id, *ally, *enemy)?;
                }
            }
            Event::MatchEnd { ally, enemy, result, .. } => match live.open_match.take() {
                Some(id) => {
                    self.store.add_event(live.id, Some(id), e)?;
                    self.store.close_match(id, e.at, *ally, *enemy, *result)?;
                    log::info!("session {}: match {id} ended", live.id);
                }
                None => {
                    self.store.add_event(live.id, None, e)?;
                }
            },
            Event::Kill { .. }
            | Event::Death { .. }
            | Event::Assist { .. }
            | Event::Multikill { .. }
            | Event::Objective { .. }
            | Event::Marker => {
                self.store.add_event(live.id, live.open_match, e)?;
            }
        }
        Ok(())
    }

    fn finish(&self, mut live: Live, end: DateTime<Utc>) {
        self.stop_recording(&mut live);
        if let Some(id) = live.open_match {
            let event = GameEvent {
                at: end,
                event: Event::MatchEnd {
                    ally: None,
                    enemy: None,
                    result: None,
                    reason: EndReason::SessionEnded,
                },
            };
            if let Err(e) = self.store.add_event(live.id, Some(id), &event) {
                log::warn!("session {}: {e:#}", live.id);
            }
        }
        match self.store.end_session(live.id, end) {
            Ok(()) => {
                log::info!("session {} ended", live.id);
                self.host.session_ended(live.id);
            }
            Err(e) => log::error!("session {} could not be ended: {e:#}", live.id),
        }
    }
}

/// Runs the watch on its own thread for the life of the app. `on_tick` gets the live session
/// after every look, for the status the UI polls.
pub fn spawn(
    store: Arc<SessionStore>,
    host: Arc<dyn Host>,
    on_tick: impl Fn(Option<LiveSession>) + Send + 'static,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("session-watch".into())
        .spawn(move || {
            let mut watch = Watch::new(store, host);
            loop {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    watch.tick(Utc::now());
                }));
                if outcome.is_err() {
                    log::error!("session watch tick panicked; carrying on");
                }
                on_tick(watch.live());
                std::thread::sleep(TICK);
            }
        })
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{MatchStatus, SessionStatus};
    use crate::timeline::Outcome;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[derive(Default)]
    struct World {
        running: Vec<String>,
        enabled: bool,
        recorder_up: bool,
        recording: Option<PathBuf>,
        stopped: Vec<PathBuf>,
        ended: Vec<i64>,
        clock: Option<DateTime<Utc>>,
        /// Events the fake provider hands out on its next polls, one batch per poll.
        script: VecDeque<Vec<GameEvent>>,
        provider_reached: bool,
        other_enabled: bool,
        hooked: Option<String>,
        parts_finished: usize,
    }

    struct FakeHost(Arc<Mutex<World>>);

    struct FakeProvider(Arc<Mutex<World>>);

    impl Provider for FakeProvider {
        fn poll(&mut self, _now: DateTime<Utc>) -> Vec<GameEvent> {
            self.0.lock().unwrap().script.pop_front().unwrap_or_default()
        }
        fn reached(&self) -> bool {
            self.0.lock().unwrap().provider_reached
        }
    }

    impl Host for FakeHost {
        fn running_executables(&self) -> Vec<String> {
            self.0.lock().unwrap().running.clone()
        }
        fn enabled(&self) -> bool {
            self.0.lock().unwrap().enabled
        }
        fn other_games_enabled(&self) -> bool {
            self.0.lock().unwrap().other_enabled
        }
        fn hooked_executable(&self) -> Option<String> {
            self.0.lock().unwrap().hooked.clone()
        }
        fn split_every(&self, game: SessionGame) -> Option<std::time::Duration> {
            (game == SessionGame::Other).then(|| std::time::Duration::from_secs(900))
        }
        fn part_finished(&self, _session_id: i64) {
            self.0.lock().unwrap().parts_finished += 1;
        }
        fn recording_path(&self, session_id: i64, n: usize) -> PathBuf {
            PathBuf::from(format!("C:/rec/session-{session_id}-{n}.mp4"))
        }
        fn start_recording(&self, path: &Path, _split: Option<std::time::Duration>) -> Result<()> {
            let mut w = self.0.lock().unwrap();
            if !w.recorder_up {
                anyhow::bail!("recorder is not running");
            }
            w.recording = Some(path.to_path_buf());
            Ok(())
        }
        fn stop_recording(&self) -> Result<DateTime<Utc>> {
            let mut w = self.0.lock().unwrap();
            if let Some(p) = w.recording.take() {
                w.stopped.push(p);
            }
            Ok(w.clock.unwrap())
        }
        fn current_recording(&self) -> Option<PathBuf> {
            self.0.lock().unwrap().recording.clone()
        }
        fn provider(&self, game: SessionGame) -> Option<Box<dyn Provider>> {
            (game == SessionGame::Valorant).then(|| Box::new(FakeProvider(self.0.clone())) as Box<dyn Provider>)
        }
        fn game_name(&self, s: &Sighting) -> String {
            crate::games::name_for(&s.executable, "").unwrap_or_else(|| s.executable.clone())
        }
        fn session_changed(&self, _session_id: i64) {}
        fn session_ended(&self, session_id: i64) {
            self.0.lock().unwrap().ended.push(session_id);
        }
    }

    struct Rig {
        world: Arc<Mutex<World>>,
        watch: Watch,
        store: Arc<SessionStore>,
        start: DateTime<Utc>,
    }

    impl Rig {
        fn new() -> Rig {
            let dir = std::env::temp_dir().join(format!(
                "cos-nostra-watch-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let store = Arc::new(SessionStore::open(&dir.join("sessions.db")).unwrap());
            let world = Arc::new(Mutex::new(World {
                enabled: true,
                recorder_up: true,
                ..Default::default()
            }));
            let watch = Watch::new(store.clone(), Arc::new(FakeHost(world.clone())));
            Rig {
                world,
                watch,
                store,
                start: DateTime::from_timestamp(1_800_000_000, 0).unwrap(),
            }
        }

        fn at(&self, s: i64) -> DateTime<Utc> {
            self.start + Duration::seconds(s)
        }

        fn tick(&mut self, s: i64) {
            let now = self.at(s);
            self.world.lock().unwrap().clock = Some(now);
            self.watch.tick(now);
        }

        fn run(&self, exes: &[&str]) {
            self.world.lock().unwrap().running = exes.iter().map(|e| e.to_string()).collect();
        }

        fn script(&self, events: Vec<GameEvent>) {
            self.world.lock().unwrap().script.push_back(events);
        }
    }

    const VALORANT: &str = "VALORANT-Win64-Shipping.exe";

    #[test]
    fn a_valorant_session_with_a_match_and_rounds() {
        let mut rig = Rig::new();
        rig.tick(0);
        assert!(rig.watch.live().is_none(), "nothing runs yet");

        rig.run(&["explorer.exe", VALORANT]);
        rig.world.lock().unwrap().provider_reached = true;
        rig.tick(1);
        let live = rig.watch.live().unwrap();
        assert_eq!(live.game, SessionGame::Valorant);
        assert!(live.recording);

        rig.script(vec![GameEvent {
            at: rig.at(60),
            event: Event::MatchStart { map: Some("Ascent".into()), mode: Some("Competitive".into()) },
        }]);
        rig.tick(61);
        rig.script(vec![GameEvent {
            at: rig.at(150),
            event: Event::RoundEnd { round: 1, ally: 1, enemy: 0, won: Some(true) },
        }]);
        rig.tick(151);
        rig.script(vec![GameEvent {
            at: rig.at(1800),
            event: Event::MatchEnd {
                ally: Some(13),
                enemy: Some(4),
                result: Some(Outcome::Win),
                reason: EndReason::Finished,
            },
        }]);
        rig.tick(1801);
        assert_eq!(rig.watch.live().unwrap().match_id, None);

        // The game closes. The session lingers for the grace period, then ends where the
        // game was last seen.
        rig.run(&["explorer.exe"]);
        rig.tick(1805);
        assert!(rig.watch.live().is_some(), "still inside the grace period");
        assert!(!rig.watch.live().unwrap().recording, "recording stops as soon as the game is gone");
        rig.tick(1811);
        assert!(rig.watch.live().is_none());

        let w = rig.world.lock().unwrap();
        assert_eq!(w.ended.len(), 1);
        assert_eq!(w.stopped.len(), 1);
        drop(w);

        let sessions = rig.store.list().unwrap();
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.game_name, "Valorant");
        assert_eq!(s.status, SessionStatus::Processing);
        assert!(s.provider_reached);
        assert_eq!(s.ended_at.as_deref(), Some(crate::sessions::format_time(rig.at(1801)).as_str()));
        assert_eq!(s.matches.len(), 1);
        let m = &s.matches[0];
        assert_eq!(m.map.as_deref(), Some("Ascent"));
        assert_eq!(m.result, Some(Outcome::Win));
        assert_eq!((m.ally_score, m.enemy_score), (Some(13), Some(4)));
        assert_eq!(m.status, MatchStatus::Pending);
        assert_eq!(rig.store.events(m.id).unwrap().len(), 3);

        let recs = rig.store.recordings(s.id).unwrap();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].stopped_at.as_deref(), Some(crate::sessions::format_time(rig.at(1805)).as_str()));
    }

    #[test]
    fn a_recorder_restart_gives_a_second_recording() {
        let mut rig = Rig::new();
        rig.run(&["cs2.exe"]);
        rig.tick(0);
        assert!(rig.watch.live().unwrap().recording);

        // The recorder goes away (a settings change restarts it) and comes back later.
        {
            let mut w = rig.world.lock().unwrap();
            w.recording = None;
            w.recorder_up = false;
        }
        rig.tick(10);
        assert!(!rig.watch.live().unwrap().recording);
        rig.tick(11);
        rig.world.lock().unwrap().recorder_up = true;
        // Retries wait for the back-off.
        rig.tick(12);
        assert!(!rig.watch.live().unwrap().recording);
        rig.tick(16);
        assert!(rig.watch.live().unwrap().recording);

        let id = rig.watch.live().unwrap().id;
        let recs = rig.store.recordings(id).unwrap();
        assert_eq!(recs.len(), 2, "failed starts leave no rows");
        assert!(recs[0].stopped_at.is_some());
        assert!(recs[1].path.ends_with("-2.mp4"));
        assert_eq!(rig.store.session(id).unwrap().unwrap().game_name, "Counter-Strike 2");
    }

    #[test]
    fn league_stays_open_between_games_while_the_client_runs() {
        let mut rig = Rig::new();
        rig.run(&["LeagueClientUx.exe"]);
        rig.tick(0);
        assert!(rig.watch.live().is_none(), "an idle client does not open a session");

        rig.run(&["LeagueClientUx.exe", "League of Legends.exe"]);
        rig.tick(10);
        let id = rig.watch.live().unwrap().id;
        rig.tick(1799);

        rig.run(&["LeagueClientUx.exe"]);
        rig.tick(1800);
        assert!(!rig.watch.live().unwrap().recording);
        rig.tick(1800 + 5 * 60);
        assert_eq!(rig.watch.live().unwrap().id, id, "queueing for the next game");

        rig.run(&["LeagueClientUx.exe", "League of Legends.exe"]);
        rig.tick(2200);
        assert!(rig.watch.live().unwrap().recording);
        assert_eq!(rig.store.recordings(id).unwrap().len(), 2);

        rig.run(&[]);
        rig.tick(4000);
        rig.tick(4011);
        assert!(rig.watch.live().is_none());
        assert_eq!(rig.world.lock().unwrap().ended, vec![id]);
    }

    #[test]
    fn turning_the_setting_off_ends_the_session_and_closes_the_match() {
        let mut rig = Rig::new();
        rig.run(&[VALORANT]);
        rig.tick(0);
        rig.script(vec![GameEvent {
            at: rig.at(5),
            event: Event::MatchStart { map: None, mode: None },
        }]);
        rig.tick(5);
        let live = rig.watch.live().unwrap();
        assert!(live.match_id.is_some());

        rig.world.lock().unwrap().enabled = false;
        rig.tick(30);
        assert!(rig.watch.live().is_none());
        rig.tick(31);
        assert!(rig.watch.live().is_none(), "a disabled watch opens nothing");

        let s = &rig.store.list().unwrap()[0];
        assert_eq!(s.matches[0].status, MatchStatus::Pending);
        let events = rig.store.events(s.matches[0].id).unwrap();
        assert!(matches!(
            events.last().unwrap().event,
            Event::MatchEnd { reason: EndReason::SessionEnded, .. }
        ));
    }

    #[test]
    fn another_game_is_recorded_in_parts_while_it_runs() {
        let mut rig = Rig::new();
        rig.run(&["explorer.exe", "Hades2.exe"]);
        rig.world.lock().unwrap().hooked = Some("Hades2.exe".into());
        rig.tick(0);
        assert!(rig.watch.live().is_none(), "off unless the player asked for it");

        rig.world.lock().unwrap().other_enabled = true;
        rig.tick(1);
        let live = rig.watch.live().unwrap();
        assert_eq!(live.game, SessionGame::Other);
        assert!(live.recording);

        // The recorder split the file by itself: the part so far ends, the next follows it.
        rig.world.lock().unwrap().recording = Some(PathBuf::from("C:/rec/session-1-1-20260915-213000.mp4"));
        rig.tick(900);
        rig.tick(901);
        let recs = rig.store.recordings(live.id).unwrap();
        assert_eq!(recs.len(), 2, "a split is not an interruption");
        assert_eq!(recs[0].stopped_at.as_deref(), Some(crate::sessions::format_time(rig.at(900)).as_str()));
        assert_eq!(recs[1].follows, Some(recs[0].id));
        assert_eq!(rig.world.lock().unwrap().parts_finished, 1);

        // The hook moves on (alt-tab to a browser) but the game still runs: nothing ends.
        rig.world.lock().unwrap().hooked = None;
        rig.tick(1000);
        assert!(rig.watch.live().is_some());

        rig.run(&["explorer.exe"]);
        rig.tick(1100);
        rig.tick(1111);
        assert!(rig.watch.live().is_none());
        assert_eq!(rig.world.lock().unwrap().ended, vec![live.id]);
        assert_eq!(rig.store.session(live.id).unwrap().unwrap().game, "other");
    }

    #[test]
    fn a_supported_game_takes_over_from_the_background_recording() {
        let mut rig = Rig::new();
        {
            let mut w = rig.world.lock().unwrap();
            w.other_enabled = true;
            w.hooked = Some("SomeLauncherGame.exe".into());
        }
        rig.run(&["SomeLauncherGame.exe"]);
        rig.tick(0);
        let other = rig.watch.live().unwrap();
        assert_eq!(other.game, SessionGame::Other);

        rig.run(&["SomeLauncherGame.exe", "cs2.exe"]);
        rig.tick(5);
        assert!(rig.watch.live().is_none(), "the background session ends at once");
        rig.tick(6);
        let cs = rig.watch.live().unwrap();
        assert_eq!(cs.game, SessionGame::CounterStrike);
        assert_ne!(cs.id, other.id);

        // A supported game's own exe is never taken for another game.
        assert!(timeline::sight_other(&["cs2.exe".to_string()], Some("cs2.exe")).is_none());
    }

    #[test]
    fn a_new_match_start_closes_the_previous_one() {
        let mut rig = Rig::new();
        rig.run(&[VALORANT]);
        rig.tick(0);
        rig.script(vec![
            GameEvent { at: rig.at(10), event: Event::MatchStart { map: None, mode: None } },
            GameEvent { at: rig.at(500), event: Event::MatchStart { map: Some("Bind".into()), mode: None } },
        ]);
        rig.tick(501);
        let s = &rig.store.list().unwrap()[0];
        assert_eq!(s.matches.len(), 2);
        assert_eq!(s.matches[0].status, MatchStatus::Pending);
        assert_eq!(s.matches[1].status, MatchStatus::Live);
    }
}

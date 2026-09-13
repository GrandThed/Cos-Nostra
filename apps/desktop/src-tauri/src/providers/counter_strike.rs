//! Counter-Strike 2, read through its Game State Integration (GSI) HTTP push.
//!
//! CS2 (and CS:GO before it) can POST a JSON snapshot of the current match to a local HTTP
//! endpoint named by a `.cfg` file dropped in the game's `csgo/cfg/` folder (see
//! `../../resources/gamestate_integration_cosnostra.cfg`, which names the port below). Unlike
//! Valorant and League, which are polled from here, the game pushes: an HTTP server on its own
//! thread parses every POST and feeds a channel this provider's `poll` drains, so a slow or
//! silent game never blocks the session watch, which calls every provider about once a second.
//!
//! The documented shape (Valve's GSI wiki, carried over from CS:GO to CS2 unchanged) is a
//! handful of top-level objects, each sent whole when something in it changed: `provider`,
//! `map`, `round`, `player`, `previously`, `auth`. A `round.phase` of `"over"` with a
//! `round.win_team` is a round decided; `map.phase` becoming `"gameover"` is the match's end;
//! `map.round` and `map.team_ct` / `map.team_t` carry the score. Fields absent from a POST are
//! unchanged since the last one, so the tracker below keeps the last value of everything it
//! cares about and only reacts to what a POST actually included.
//!
//! `reached()` only flips once `poll` has actually turned a POST into a timeline event (a match
//! starting, a round ending, a match ending) rather than on the first POST that arrives: CS2's
//! heartbeat (configured at 30 s below) POSTs on a schedule regardless of whether anything
//! happened, so a main-menu session would otherwise mark itself reached with nothing played.
//! `cutter.rs` discards a whole session outright once its provider is reached with no matches
//! found, so marking too eagerly would silently throw away a quiet-but-working session.
//!
//! Untested against a real CS2 install (see the crate's top-level report): every transition
//! here is exercised only against hand-written POST bodies shaped like Valve's documented
//! examples, the same way `league.rs` was before its first real match.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

use crate::timeline::{EndReason, Event, GameEvent, Outcome, Provider};

/// Local port the GSI receiver binds. Chosen to be unlikely to collide with anything else on a
/// player's PC; if it ever needs to change, update it here and in
/// `resources/gamestate_integration_cosnostra.cfg` together.
pub const GSI_PORT: u16 = 51122;

/// How long a match survives with no GSI update at all (the game closed, crashed, or the
/// player alt-tabbed out of a frozen state) before it is written off. Comfortably past the
/// `.cfg`'s 30 s heartbeat so one or two missed heartbeats are not mistaken for a lost game.
const LOST_AFTER: Duration = Duration::seconds(90);

/// What one POST changed, relative to whatever the tracker already knew. `None` in any field
/// means "this POST said nothing about it", not "it is now empty" — GSI only sends an object
/// when something in it changed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Delta {
    map_phase: Option<String>,
    map_round: Option<u32>,
    ct_score: Option<u32>,
    t_score: Option<u32>,
    mode: Option<String>,
    map_name: Option<String>,
    round_phase: Option<String>,
    win_team: Option<String>,
    player_team: Option<String>,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn number(v: &Value, key: &str) -> Option<u32> {
    let n = v.get(key)?;
    n.as_u64()
        .or_else(|| n.as_str().and_then(|s| s.trim().parse().ok()))
        .and_then(|n| u32::try_from(n).ok())
}

/// Parses one GSI POST body into what changed. Never fails: a body missing everything this
/// cares about (an unrelated heartbeat) just parses to an all-`None` `Delta`.
fn parse(body: &Value) -> Delta {
    let mut d = Delta::default();
    if let Some(map) = body.get("map") {
        d.map_phase = text(map, "phase");
        d.map_round = number(map, "round");
        d.mode = text(map, "mode");
        d.map_name = text(map, "name");
        if let Some(ct) = map.get("team_ct") {
            d.ct_score = number(ct, "score");
        }
        if let Some(t) = map.get("team_t") {
            d.t_score = number(t, "score");
        }
    }
    if let Some(round) = body.get("round") {
        d.round_phase = text(round, "phase");
        d.win_team = text(round, "win_team");
    }
    if let Some(player) = body.get("player") {
        d.player_team = text(player, "team");
    }
    d
}

/// Turns successive GSI deltas into timeline events. Pure, so every transition is testable
/// without a game running or an HTTP server involved.
#[derive(Debug, Default)]
pub struct Tracker {
    in_match: bool,
    map_phase: Option<String>,
    ct_score: u32,
    t_score: u32,
    mode: Option<String>,
    map_name: Option<String>,
    /// The side the tracked player is on right now: `"CT"` or `"T"`. Can flip mid-match at
    /// halftime; when unknown, CT is assumed as the "ally" side, which is a guess worth being
    /// honest about rather than silently wrong-but-confident.
    player_team: Option<String>,
    /// The `ct_score + t_score` total already reported as a round end, so a throttled repeat of
    /// the same `"over"` phase does not emit twice.
    last_round_total: Option<u32>,
    lost_since: Option<DateTime<Utc>>,
}

/// Phases where a match is actually being played, as opposed to warming up or over.
fn is_live_phase(phase: &str) -> bool {
    matches!(phase, "live" | "freezetime" | "over" | "intermission" | "bomb")
}

impl Tracker {
    /// `delta` is `None` when no POST arrived on this poll.
    pub fn observe(&mut self, now: DateTime<Utc>, delta: Option<&Delta>) -> Vec<GameEvent> {
        let mut out = Vec::new();
        let Some(d) = delta else {
            if self.in_match {
                let since = *self.lost_since.get_or_insert(now);
                if now - since >= LOST_AFTER {
                    log::warn!(
                        "counter_strike: no GSI update for {}s mid-match, ending it",
                        LOST_AFTER.num_seconds()
                    );
                    out.push(self.end(since, EndReason::Lost));
                }
            }
            return out;
        };
        self.lost_since = None;
        if d.map_phase.is_some() {
            self.map_phase = d.map_phase.clone();
        }
        if let Some(s) = d.ct_score {
            self.ct_score = s;
        }
        if let Some(s) = d.t_score {
            self.t_score = s;
        }
        if d.mode.is_some() {
            self.mode = d.mode.clone();
        }
        if d.map_name.is_some() {
            self.map_name = d.map_name.clone();
        }
        if d.player_team.is_some() {
            self.player_team = d.player_team.clone();
        }

        if self.map_phase.as_deref() == Some("gameover") {
            if self.in_match {
                out.push(self.end(now, EndReason::Finished));
            }
            return out;
        }

        let live = self.map_phase.as_deref().is_some_and(is_live_phase);
        if live && !self.in_match {
            self.in_match = true;
            self.last_round_total = None;
            log::info!(
                "counter_strike: match on ({:?}, map {:?}, playing {:?})",
                self.mode,
                self.map_name,
                self.player_team
            );
            out.push(GameEvent {
                at: now,
                event: Event::MatchStart { map: self.map_name.clone(), mode: self.mode.clone() },
            });
        }

        if self.in_match && d.round_phase.as_deref() == Some("over") {
            let total = self.ct_score + self.t_score;
            if self.last_round_total != Some(total) {
                self.last_round_total = Some(total);
                let (ally, enemy) = self.sides();
                let won = d
                    .win_team
                    .as_deref()
                    .zip(self.player_team.as_deref())
                    .map(|(winner, mine)| winner.eq_ignore_ascii_case(mine));
                out.push(GameEvent {
                    at: now,
                    event: Event::RoundEnd { round: total, ally, enemy, won },
                });
            }
        }
        out
    }

    /// `(ally, enemy)` from the raw CT/T scores, oriented by the tracked player's side. CT when
    /// the side is not yet known, which only matters for the handful of seconds before the
    /// first `player` object arrives.
    fn sides(&self) -> (u32, u32) {
        match self.player_team.as_deref() {
            Some(t) if t.eq_ignore_ascii_case("T") => (self.t_score, self.ct_score),
            _ => (self.ct_score, self.t_score),
        }
    }

    fn end(&mut self, at: DateTime<Utc>, reason: EndReason) -> GameEvent {
        self.in_match = false;
        self.lost_since = None;
        let (ally, enemy) = self.sides();
        let scored = ally + enemy > 0;
        GameEvent {
            at,
            event: Event::MatchEnd {
                ally: scored.then_some(ally),
                enemy: scored.then_some(enemy),
                result: (scored && reason == EndReason::Finished).then(|| Outcome::from_score(ally, enemy)),
                reason,
            },
        }
    }
}

/// Binds the GSI receiver and runs it until `stop` is set. Each POST body is parsed and handed
/// to `tx`; the response is always a bare 200, since CS2 does not read it.
fn run_server(port: u16, tx: Sender<Delta>, stop: Arc<AtomicBool>) {
    let server = match tiny_http::Server::http(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(e) => {
            log::error!(
                "counter_strike: could not bind the GSI receiver on 127.0.0.1:{port}: {e}. \
                 Counter-Strike sessions will keep whole recordings, undetected, until this is \
                 free. See resources/gamestate_integration_cosnostra.cfg for the config CS2 needs."
            );
            return;
        }
    };
    log::info!(
        "counter_strike: GSI receiver listening on 127.0.0.1:{port} (needs \
         gamestate_integration_cosnostra.cfg in the game's csgo/cfg folder to receive anything)"
    );
    while !stop.load(Ordering::Relaxed) {
        match server.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(Some(mut request)) => {
                let mut body = String::new();
                if let Err(e) = request.as_reader().read_to_string(&mut body) {
                    log::debug!("counter_strike: could not read a GSI POST: {e}");
                } else {
                    match serde_json::from_str::<Value>(&body) {
                        Ok(json) => {
                            let _ = tx.send(parse(&json));
                        }
                        Err(e) => log::debug!("counter_strike: a GSI POST was not JSON: {e}"),
                    }
                }
                let _ = request.respond(tiny_http::Response::empty(200));
            }
            Ok(None) => {} // recv_timeout expired; loop around to check `stop`.
            Err(e) => {
                log::warn!("counter_strike: GSI receiver stopped answering: {e}");
                break;
            }
        }
    }
    log::info!("counter_strike: GSI receiver stopped");
}

pub struct CounterStrike {
    rx: Receiver<Delta>,
    stop: Arc<AtomicBool>,
    tracker: Tracker,
    reached: bool,
}

impl CounterStrike {
    pub fn new() -> Self {
        Self::on_port(GSI_PORT)
    }

    fn on_port(port: u16) -> Self {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let spawned = std::thread::Builder::new().name("cs2-gsi".into()).spawn(move || {
            run_server(port, tx, thread_stop);
        });
        if let Err(e) = spawned {
            log::error!("counter_strike: could not start the GSI receiver thread: {e}");
        }
        Self { rx, stop, tracker: Tracker::default(), reached: false }
    }
}

impl Default for CounterStrike {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CounterStrike {
    fn drop(&mut self) {
        // The receiver thread checks this at most every 500 ms and then drops the `Server`,
        // closing the socket; nothing here needs to wait for that to happen.
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Provider for CounterStrike {
    fn poll(&mut self, now: DateTime<Utc>) -> Vec<GameEvent> {
        let mut out = Vec::new();
        let mut got_any = false;
        loop {
            match self.rx.try_recv() {
                Ok(delta) => {
                    got_any = true;
                    out.extend(self.tracker.observe(now, Some(&delta)));
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        if !got_any {
            out.extend(self.tracker.observe(now, None));
        }
        // Only a real transition counts as having reached the game: a heartbeat POST alone
        // parses to an all-`None` delta and `observe` returns nothing for it.
        if !out.is_empty() {
            self.reached = true;
        }
        out
    }

    fn reached(&self) -> bool {
        self.reached
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t(s: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + s, 0).unwrap()
    }

    fn body(phase: &str, round: u32, ct: u32, t: u32) -> Value {
        json!({
            "provider": { "name": "Counter-Strike 2", "appid": 730 },
            "map": {
                "mode": "competitive",
                "name": "de_ancient",
                "phase": phase,
                "round": round,
                "team_ct": { "score": ct },
                "team_t": { "score": t }
            }
        })
    }

    fn with_round(mut b: Value, phase: &str, win_team: Option<&str>) -> Value {
        let mut round = json!({ "phase": phase });
        if let Some(w) = win_team {
            round["win_team"] = json!(w);
        }
        b["round"] = round;
        b
    }

    fn with_player(mut b: Value, team: &str) -> Value {
        b["player"] = json!({ "steamid": "1", "name": "me", "team": team });
        b
    }

    #[test]
    fn parses_map_round_and_player() {
        let b = with_player(with_round(body("live", 3, 2, 1), "over", Some("CT")), "CT");
        let d = parse(&b);
        assert_eq!(d.map_phase.as_deref(), Some("live"));
        assert_eq!(d.map_round, Some(3));
        assert_eq!(d.ct_score, Some(2));
        assert_eq!(d.t_score, Some(1));
        assert_eq!(d.mode.as_deref(), Some("competitive"));
        assert_eq!(d.map_name.as_deref(), Some("de_ancient"));
        assert_eq!(d.round_phase.as_deref(), Some("over"));
        assert_eq!(d.win_team.as_deref(), Some("CT"));
        assert_eq!(d.player_team.as_deref(), Some("CT"));

        // A heartbeat with only `provider` carries none of it.
        let heartbeat = parse(&json!({ "provider": { "name": "Counter-Strike 2" } }));
        assert_eq!(heartbeat, Delta::default());
    }

    #[test]
    fn a_match_from_warmup_through_a_win() {
        let mut tr = Tracker::default();
        assert!(tr.observe(t(0), Some(&parse(&body("warmup", 0, 0, 0)))).is_empty());

        let start = tr.observe(t(5), Some(&parse(&with_player(body("live", 0, 0, 0), "CT"))));
        assert_eq!(start.len(), 1);
        assert_eq!(
            start[0].event,
            Event::MatchStart { map: Some("de_ancient".into()), mode: Some("competitive".into()) }
        );

        // Freezetime and live updates with no round result yet: nothing to report.
        assert!(tr.observe(t(20), Some(&parse(&body("freezetime", 0, 0, 0)))).is_empty());

        let r1 = tr.observe(t(60), Some(&parse(&with_round(body("over", 0, 1, 0), "over", Some("CT")))));
        assert_eq!(r1.len(), 1);
        assert_eq!(r1[0].event, Event::RoundEnd { round: 1, ally: 1, enemy: 0, won: Some(true) });

        // A throttled repeat of the same "over" round is not reported twice.
        assert!(tr
            .observe(t(61), Some(&parse(&with_round(body("over", 0, 1, 0), "over", Some("CT")))))
            .is_empty());

        let r2 = tr.observe(t(150), Some(&parse(&with_round(body("over", 1, 1, 1), "over", Some("T")))));
        assert_eq!(r2[0].event, Event::RoundEnd { round: 2, ally: 1, enemy: 1, won: Some(false) });

        let end = tr.observe(t(1600), Some(&parse(&body("gameover", 25, 13, 6))));
        assert_eq!(end.len(), 1);
        assert_eq!(
            end[0].event,
            Event::MatchEnd { ally: Some(13), enemy: Some(6), result: Some(Outcome::Win), reason: EndReason::Finished }
        );
    }

    #[test]
    fn a_player_who_switches_sides_at_halftime_keeps_ally_and_enemy_straight() {
        let mut tr = Tracker::default();
        tr.observe(t(0), Some(&parse(&with_player(body("live", 0, 0, 0), "CT"))));
        let r1 = tr.observe(t(60), Some(&parse(&with_round(body("over", 0, 1, 0), "over", Some("CT")))));
        assert_eq!(r1[0].event, Event::RoundEnd { round: 1, ally: 1, enemy: 0, won: Some(true) });

        // Halftime: the player is now T, and the raw CT/T scores carry on climbing.
        let r2 = tr.observe(
            t(900),
            Some(&parse(&with_player(with_round(body("over", 12, 6, 6), "over", Some("CT")), "T"))),
        );
        // The player is now on the T side (6), which just lost a round to CT (6): ally 6, enemy 6.
        assert_eq!(r2[0].event, Event::RoundEnd { round: 12, ally: 6, enemy: 6, won: Some(false) });
    }

    #[test]
    fn a_match_with_no_updates_for_long_is_lost_where_it_went_quiet() {
        let mut tr = Tracker::default();
        tr.observe(t(0), Some(&parse(&with_player(body("live", 0, 0, 0), "CT"))));
        tr.observe(t(60), Some(&parse(&with_round(body("over", 0, 3, 1), "over", Some("CT")))));
        assert!(tr.observe(t(70), None).is_empty());
        let lost = tr.observe(t(70 + 90), None);
        assert_eq!(lost.len(), 1);
        assert_eq!(lost[0].at, t(70), "the end is when it went quiet, not when we gave up");
        assert!(matches!(
            lost[0].event,
            Event::MatchEnd { ally: Some(3), enemy: Some(1), result: None, reason: EndReason::Lost }
        ));
    }

    #[test]
    fn warmup_never_starts_a_match() {
        let mut tr = Tracker::default();
        assert!(tr.observe(t(0), Some(&parse(&body("warmup", 0, 0, 0)))).is_empty());
        assert!(tr.observe(t(5), Some(&parse(&body("warmup", 0, 0, 0)))).is_empty());
        assert!(!tr.in_match);
    }

    /// The provider only marks itself reached once a POST actually produced an event, not on
    /// the first POST — a quiet main-menu heartbeat must not make a working session look
    /// reached with nothing played, or `cutter.rs` would discard it outright. Built directly
    /// from its parts (no HTTP server involved) and fed through the same channel `poll` reads.
    #[test]
    fn provider_reached_flips_only_on_a_real_transition() {
        let (tx, rx) = mpsc::channel();
        let mut cs = CounterStrike { rx, stop: Arc::new(AtomicBool::new(true)), tracker: Tracker::default(), reached: false };

        tx.send(Delta::default()).unwrap();
        assert!(cs.poll(t(0)).is_empty());
        assert!(!cs.reached(), "a heartbeat with nothing useful must not mark the provider reached");

        tx.send(parse(&with_player(body("live", 0, 0, 0), "CT"))).unwrap();
        let events = cs.poll(t(1));
        assert_eq!(events.len(), 1, "a real map update starts a match");
        assert!(cs.reached());
    }
}

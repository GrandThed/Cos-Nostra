//! League of Legends, read through the game's own Live Client Data API.
//!
//! While a match runs, the game client serves `https://127.0.0.1:2999/liveclientdata/` with
//! everything a spectator overlay needs: the active player, all ten players with their
//! champion and team, the game clock, and an event list (kills, multikills, aces, dragons,
//! towers, the end of the game). It is Riot's documented API for exactly this, needs no login,
//! and answers only while a match is loaded, so reaching it at all means a match is on.
//!
//! Events carry `EventTime`, seconds on the game clock, and every event is placed at the
//! clock's zero in wall-clock time plus its game time. That zero is `now - gameTime` at a
//! poll, but only while the clock runs. The API already answers on the loading screen, with
//! `gameTime` standing still near zero until the game really starts (24 s later in one real
//! match), so a zero read there puts every event that long before it happens in the video. A
//! pause (practice tool, custom games) stops the clock too, and moves the real zero later by
//! however long it lasted.
//!
//! So a poll counts only when the game time moved since the answer before it, and nothing is
//! placed until one has. Among the polls that count, the smallest zero is the least delayed
//! (`now` is taken once the answer is back, so latency only ever makes it later), and one more
//! than [`PAUSE_SLACK`] later than the zero in use means the clock stood still in between: zero
//! moves there, and what was already placed stays where it was. Starting the app in the middle
//! of a match works the same way: the events so far arrive with the second answer, at the times
//! they happened.
//!
//! Names in events are what the game shows, which since Riot IDs is the game name without the
//! tag; the active player is known by Riot ID, game name and legacy summoner name. All of them
//! are compared without the `#tag` and without case.

use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

use crate::timeline::{EndReason, Event, GameEvent, Outcome, Provider};

const URL: &str = "https://127.0.0.1:2999/liveclientdata/allgamedata";
/// How long a match survives with the API gone (a crash, a reconnect) before it is written off.
const LOST_AFTER: Duration = Duration::seconds(45);
/// Between attempts while nothing answers: the client between games, a game still starting.
const RETRY_EVERY: Duration = Duration::seconds(2);
const HTTP_TIMEOUT: StdDuration = StdDuration::from_secs(1);
/// A game clock this far behind the last one seen is a new game, not jitter.
const NEW_GAME_SLACK_SECONDS: f64 = 5.0;
/// How much later than the zero in use a poll may put it before that counts as the clock
/// having stood still in between (a pause) rather than a slow answer. Latency on loopback is
/// milliseconds and `HTTP_TIMEOUT` caps it; a poll that caught the first moment of a pause is
/// off by up to one watch tick, and the polls after the pause put zero right again anyway.
const PAUSE_SLACK: Duration = Duration::milliseconds(1_500);

#[derive(Debug, Clone, PartialEq)]
pub struct Player {
    names: Vec<String>,
    champion: String,
    team: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawEvent {
    id: u64,
    name: String,
    time: f64,
    data: Value,
}

/// One poll of `allgamedata`, reduced to what the timeline uses.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    game_time: f64,
    mode: Option<String>,
    map_number: Option<u32>,
    me: Vec<String>,
    my_team: Option<String>,
    players: Vec<Player>,
    events: Vec<RawEvent>,
}

/// `Name#TAG` and `name` are the same player.
fn norm(name: &str) -> String {
    name.split('#').next().unwrap_or(name).trim().to_lowercase()
}

fn names_of(v: &Value) -> Vec<String> {
    let mut names: Vec<String> = ["riotId", "riotIdGameName", "summonerName"]
        .iter()
        .filter_map(|k| v.get(*k).and_then(Value::as_str))
        .map(norm)
        .filter(|n| !n.is_empty())
        .collect();
    names.sort();
    names.dedup();
    names
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `None` when the answer is not a match (the API says so with an error body, in spectator
/// mode for one). A loading screen does parse, with its clock standing still.
pub fn parse(root: &Value) -> Option<Snapshot> {
    let game = root.get("gameData")?;
    let game_time = game.get("gameTime")?.as_f64()?;
    let me = root.get("activePlayer").map(names_of).unwrap_or_default();
    let players: Vec<Player> = root
        .get("allPlayers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|p| Player {
            names: names_of(p),
            champion: text(p, "championName").unwrap_or_default(),
            team: text(p, "team").unwrap_or_default(),
        })
        .collect();
    let my_team = players
        .iter()
        .find(|p| p.names.iter().any(|n| me.contains(n)))
        .map(|p| p.team.clone())
        .filter(|t| !t.is_empty());
    let events = root
        .get("events")
        .and_then(|e| e.get("Events"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| {
            Some(RawEvent {
                id: e.get("EventID")?.as_u64()?,
                name: text(e, "EventName")?,
                time: e.get("EventTime")?.as_f64()?,
                data: e.clone(),
            })
        })
        .collect();
    Some(Snapshot {
        game_time,
        mode: text(game, "gameMode"),
        map_number: game.get("mapNumber").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()),
        me,
        my_team,
        players,
        events,
    })
}

impl Snapshot {
    fn is_me(&self, name: &str) -> bool {
        let name = norm(name);
        !name.is_empty() && self.me.contains(&name)
    }

    fn player(&self, name: &str) -> Option<&Player> {
        let name = norm(name);
        self.players.iter().find(|p| p.names.contains(&name))
    }

    /// The champion for a player name; turrets and minions keep a readable version of theirs.
    fn who(&self, name: &str) -> String {
        match self.player(name) {
            Some(p) if !p.champion.is_empty() => p.champion.clone(),
            _ if name.starts_with("Turret_") => "a tower".into(),
            _ if name.starts_with("Minion_") => "minions".into(),
            _ => name.to_string(),
        }
    }

    /// The team behind a killer: a player's team, or the side encoded in a unit's name.
    fn team_of(&self, name: &str) -> Option<String> {
        self.player(name)
            .map(|p| p.team.clone())
            .filter(|t| !t.is_empty())
            .or_else(|| side_in(name).map(str::to_string))
    }

    fn ours(&self, team: Option<String>) -> Option<bool> {
        Some(team? == *self.my_team.as_ref()?)
    }
}

/// `Turret_T1_L_03_A`, `Barracks_T2_R1`, `Minion_T1L1S1N1`: T1 is ORDER, T2 is CHAOS.
fn side_in(unit: &str) -> Option<&'static str> {
    let rest = unit.split_once('_')?.1;
    if rest.starts_with("T1") {
        Some("ORDER")
    } else if rest.starts_with("T2") {
        Some("CHAOS")
    } else {
        None
    }
}

pub fn mode_name(mode: &str) -> String {
    match mode {
        "CLASSIC" => "Classic".into(),
        "ARAM" => "ARAM".into(),
        "URF" => "URF".into(),
        "ARURF" => "ARURF".into(),
        "ONEFORALL" => "One for All".into(),
        "NEXUSBLITZ" => "Nexus Blitz".into(),
        "PRACTICETOOL" => "Practice Tool".into(),
        "CHERRY" => "Arena".into(),
        "SWIFTPLAY" => "Swiftplay".into(),
        "ULTBOOK" => "Ultimate Spellbook".into(),
        "STRAWBERRY" => "Swarm".into(),
        "TUTORIAL" | "TUTORIAL_MODULE_1" | "TUTORIAL_MODULE_2" | "TUTORIAL_MODULE_3" => "Tutorial".into(),
        other => {
            let lower = other.to_lowercase();
            let mut chars = lower.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    }
}

pub fn map_name(number: u32) -> Option<&'static str> {
    Some(match number {
        11 => "Summoner's Rift",
        12 => "Howling Abyss",
        21 => "Nexus Blitz",
        30 => "Rings of Wrath",
        _ => return None,
    })
}

/// Turns successive snapshots into timeline events. Pure, so every transition is testable
/// without a game running.
///
/// Nothing comes out, not even the match start, until a running clock has shown where zero is:
/// the loading screen answers with a clock standing still, and taking its zero put a match's
/// every event about 24 s early. Events are marked seen only as they are emitted, so the ones
/// that arrived before zero was known come out with the first poll that knows it. A pause moves
/// zero for what comes after it; what was emitted before keeps its time.
#[derive(Debug, Default)]
pub struct Tracker {
    in_match: bool,
    /// The game reported its end; its snapshots are ignored until a new game's clock starts.
    finished: bool,
    /// Wall-clock time of game clock zero, once a running clock has shown it.
    zero: Option<DateTime<Utc>>,
    /// The game time of the last answer, `None` before the first. Tells a running clock from
    /// one standing still, and a new game from the old one.
    last_game_time: Option<f64>,
    last_event: Option<u64>,
    lost_since: Option<DateTime<Utc>>,
}

impl Tracker {
    /// `snapshot` is `None` when the API did not answer with a match. `now` is when the answer
    /// came back.
    pub fn observe(&mut self, now: DateTime<Utc>, snapshot: Option<&Snapshot>) -> Vec<GameEvent> {
        let mut out = Vec::new();
        let Some(s) = snapshot else {
            if self.in_match {
                let since = *self.lost_since.get_or_insert(now);
                if now - since >= LOST_AFTER {
                    log::warn!("league: the live API has been gone for {}s mid-match, ending it", LOST_AFTER.num_seconds());
                    self.in_match = false;
                    out.push(GameEvent { at: since, event: lost_end() });
                }
            }
            return out;
        };
        self.lost_since = None;

        let previous = self.last_game_time.replace(s.game_time);
        if let Some(last) = previous.filter(|last| s.game_time + NEW_GAME_SLACK_SECONDS < *last) {
            if self.in_match {
                let at = self.at(last);
                out.push(GameEvent { at, event: lost_end() });
            }
            self.in_match = false;
            self.finished = false;
            self.zero = None;
            self.last_event = None;
        }
        if self.finished {
            return out;
        }

        // A first answer, or a clock standing still (a loading screen, a pause), says nothing
        // about where zero is. A new game's first answer is behind the last one, so it waits too.
        if previous.is_some_and(|last| s.game_time > last) {
            let candidate = now - Duration::milliseconds((s.game_time * 1000.0) as i64);
            self.zero = Some(match self.zero {
                Some(zero) if candidate - zero > PAUSE_SLACK => {
                    log::info!(
                        "league: the game clock stood still for {:.1}s (a pause), moving its zero",
                        (candidate - zero).num_milliseconds() as f64 / 1000.0
                    );
                    candidate
                }
                Some(zero) => zero.min(candidate),
                None => candidate,
            });
        }
        let Some(zero) = self.zero else {
            return out;
        };

        if !self.in_match {
            self.in_match = true;
            log::info!(
                "league: match on ({:?}, map {:?}, playing as {:?}, team {:?})",
                s.mode,
                s.map_number,
                s.me,
                s.my_team
            );
            out.push(GameEvent {
                at: zero,
                event: Event::MatchStart {
                    map: s.map_number.and_then(map_name).map(str::to_string),
                    mode: s.mode.as_deref().map(mode_name),
                },
            });
        }

        for raw in &s.events {
            if self.last_event.is_some_and(|last| raw.id <= last) {
                continue;
            }
            self.last_event = Some(raw.id);
            let Some(event) = translate(s, raw) else { continue };
            let ends = matches!(event, Event::MatchEnd { .. });
            out.push(GameEvent { at: self.at(raw.time), event });
            if ends {
                self.in_match = false;
                self.finished = true;
                break;
            }
        }
        out
    }

    fn at(&self, game_seconds: f64) -> DateTime<Utc> {
        self.zero.unwrap_or_else(Utc::now) + Duration::milliseconds((game_seconds * 1000.0) as i64)
    }
}

fn lost_end() -> Event {
    Event::MatchEnd { ally: None, enemy: None, result: None, reason: EndReason::Lost }
}

/// The events the timeline shows. Kills that do not involve the player are left out: ten
/// players make a lot of them, and the player's own moments are what gets clipped.
fn translate(s: &Snapshot, raw: &RawEvent) -> Option<Event> {
    let field = |k: &str| text(&raw.data, k).unwrap_or_default();
    let stolen = || field("Stolen").eq_ignore_ascii_case("true");
    let objective = |name: String, killer: &str| Event::Objective { name, ours: s.ours(s.team_of(killer)) };
    match raw.name.as_str() {
        "ChampionKill" => {
            let killer = field("KillerName");
            let victim = field("VictimName");
            if s.is_me(&killer) {
                Some(Event::Kill { victim: Some(s.who(&victim)), weapon: None, headshot: false })
            } else if s.is_me(&victim) {
                Some(Event::Death { killer: Some(s.who(&killer)), weapon: None })
            } else {
                let assisted = raw
                    .data
                    .get("Assisters")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .any(|a| s.is_me(a));
                assisted.then(|| Event::Assist { victim: Some(s.who(&victim)) })
            }
        }
        "Multikill" => {
            let count = raw.data.get("KillStreak").and_then(Value::as_u64)?;
            s.is_me(&field("KillerName")).then(|| Event::Multikill { count: count as u32 })
        }
        "Ace" => Some(Event::Objective {
            name: "Ace".into(),
            ours: s.ours(Some(field("AcingTeam")).filter(|t| !t.is_empty())),
        }),
        "DragonKill" => {
            let kind = field("DragonType");
            let name = if kind.is_empty() { "Dragon".to_string() } else { format!("{kind} Dragon") };
            let name = if stolen() { format!("{name} (stolen)") } else { name };
            Some(objective(name, &field("KillerName")))
        }
        "HeraldKill" => Some(objective(if stolen() { "Rift Herald (stolen)".into() } else { "Rift Herald".into() }, &field("KillerName"))),
        "BaronKill" => Some(objective(if stolen() { "Baron Nashor (stolen)".into() } else { "Baron Nashor".into() }, &field("KillerName"))),
        "HordeKill" => Some(objective("Voidgrubs".into(), &field("KillerName"))),
        "TurretKilled" | "InhibKilled" => {
            let (name, unit) = if raw.name == "TurretKilled" {
                ("Tower", field("TurretKilled"))
            } else {
                ("Inhibitor", field("InhibKilled"))
            };
            // The structure's side says who lost it, which is surer than who got the last hit.
            let lost_by = side_in(&unit).map(str::to_string);
            let ours = s.ours(lost_by).map(|lost_it| !lost_it);
            Some(Event::Objective { name: name.into(), ours })
        }
        "GameEnd" => {
            let result = match field("Result").as_str() {
                "Win" => Some(Outcome::Win),
                "Lose" => Some(Outcome::Loss),
                _ => None,
            };
            Some(Event::MatchEnd { ally: None, enemy: None, result, reason: EndReason::Finished })
        }
        "GameStart" | "MinionsSpawning" | "FirstBrick" | "FirstBlood" | "InhibRespawningSoon" | "InhibRespawned" => None,
        other => {
            log::debug!("league: event {other} is not on the timeline");
            None
        }
    }
}

pub struct League {
    http: Option<reqwest::blocking::Client>,
    next_try: Option<DateTime<Utc>>,
    reached: bool,
    tracker: Tracker,
}

impl League {
    pub fn new() -> Self {
        let http = reqwest::blocking::Client::builder()
            // The game serves loopback HTTPS with Riot's own self-signed certificate.
            .tls_danger_accept_invalid_certs(true)
            .timeout(HTTP_TIMEOUT)
            .build()
            .map_err(|e| log::error!("league: could not build the live API client: {e}"))
            .ok();
        Self { http, next_try: None, reached: false, tracker: Tracker::default() }
    }

    fn fetch(&self) -> Option<Snapshot> {
        let response = self.http.as_ref()?.get(URL).send().ok()?;
        if !response.status().is_success() {
            return None;
        }
        parse(&response.json::<Value>().ok()?)
    }
}

impl Provider for League {
    fn poll(&mut self, now: DateTime<Utc>) -> Vec<GameEvent> {
        if self.next_try.is_some_and(|t| now < t) {
            return self.tracker.observe(now, None);
        }
        let snapshot = self.fetch();
        // The watch took `now` before its process list and any recorder start, and the game read
        // its clock later than that. Zero is measured from when the answer is back, which is never
        // before the clock was read, so a slow tick or a slow answer can only make it later and
        // the smallest one stays the least delayed.
        let now = Utc::now();
        match &snapshot {
            Some(_) => {
                self.reached = true;
                self.next_try = None;
            }
            None => self.next_try = Some(now + RETRY_EVERY),
        }
        self.tracker.observe(now, snapshot.as_ref())
    }

    fn reached(&self) -> bool {
        self.reached
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t(s: f64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).unwrap() + Duration::milliseconds((s * 1000.0) as i64)
    }

    fn game(game_time: f64, events: Value) -> Value {
        json!({
            "activePlayer": {
                "riotId": "Benja#LAS",
                "riotIdGameName": "Benja",
                "riotIdTagLine": "LAS",
                "summonerName": "Benja#LAS"
            },
            "allPlayers": [
                { "championName": "Ahri", "riotId": "Benja#LAS", "riotIdGameName": "Benja", "summonerName": "Benja#LAS", "team": "ORDER" },
                { "championName": "Jinx", "riotId": "Mate#LAS", "riotIdGameName": "Mate", "summonerName": "Mate#LAS", "team": "ORDER" },
                { "championName": "Zed", "riotId": "Rival#KR1", "riotIdGameName": "Rival", "summonerName": "Rival#KR1", "team": "CHAOS" }
            ],
            "events": { "Events": events },
            "gameData": { "gameMode": "ARAM", "gameTime": game_time, "mapName": "Map12", "mapNumber": 12 }
        })
    }

    fn snap(game_time: f64, events: Value) -> Snapshot {
        parse(&game(game_time, events)).unwrap()
    }

    #[test]
    fn parses_a_snapshot() {
        let s = snap(61.5, json!([{ "EventID": 0, "EventName": "GameStart", "EventTime": 0.03 }]));
        assert_eq!(s.me, vec!["benja".to_string()]);
        assert_eq!(s.my_team.as_deref(), Some("ORDER"));
        assert_eq!(s.players.len(), 3);
        assert_eq!(s.events.len(), 1);
        assert!(s.is_me("BENJA"));
        assert!(s.is_me("Benja#LAS"));
        assert!(!s.is_me("Mate"));
        assert_eq!(s.who("Rival"), "Zed");
        assert_eq!(s.who("Turret_T2_C_05_A"), "a tower");
        // Spectator mode answers with an error body.
        assert!(parse(&json!({ "errorCode": "RESOURCE_NOT_FOUND", "httpStatus": 404 })).is_none());
    }

    #[test]
    fn an_aram_from_start_to_victory() {
        let mut tr = Tracker::default();
        let started = json!([{ "EventID": 0, "EventName": "GameStart", "EventTime": 0.0 }]);
        // One answer cannot tell a running clock from a stopped one.
        assert!(tr.observe(t(4.0), Some(&snap(4.0, started.clone()))).is_empty());
        let start = tr.observe(t(5.0), Some(&snap(5.0, started)));
        assert_eq!(start.len(), 1);
        assert_eq!(start[0].at, t(0.0), "the match starts at game clock zero");
        assert_eq!(
            start[0].event,
            Event::MatchStart { map: Some("Howling Abyss".into()), mode: Some("ARAM".into()) }
        );

        let events = json!([
            { "EventID": 0, "EventName": "GameStart", "EventTime": 0.0 },
            { "EventID": 1, "EventName": "ChampionKill", "EventTime": 95.2, "KillerName": "Benja", "VictimName": "Rival", "Assisters": ["Mate"] },
            { "EventID": 2, "EventName": "Multikill", "EventTime": 95.2, "KillerName": "Benja", "KillStreak": 2 },
            { "EventID": 3, "EventName": "ChampionKill", "EventTime": 120.0, "KillerName": "Rival", "VictimName": "Benja", "Assisters": [] },
            { "EventID": 4, "EventName": "ChampionKill", "EventTime": 130.0, "KillerName": "Mate", "VictimName": "Rival", "Assisters": ["Benja#LAS"] },
            { "EventID": 5, "EventName": "ChampionKill", "EventTime": 131.0, "KillerName": "Rival", "VictimName": "Mate", "Assisters": [] },
            { "EventID": 6, "EventName": "TurretKilled", "EventTime": 400.0, "KillerName": "Minion_T1L1S1N1", "TurretKilled": "Turret_T2_C_07_A", "Assisters": [] },
            { "EventID": 7, "EventName": "InhibKilled", "EventTime": 600.0, "KillerName": "Rival", "InhibKilled": "Barracks_T1_C1", "Assisters": [] },
            { "EventID": 8, "EventName": "Ace", "EventTime": 700.0, "Acer": "Benja", "AcingTeam": "ORDER" }
        ]);
        // A slower answer puts zero a little later, which is latency, not a pause: it stays.
        let mid = tr.observe(t(700.9), Some(&snap(700.5, events.clone())));
        let kinds: Vec<_> = mid.iter().map(|e| e.event.kind()).collect();
        assert_eq!(kinds, vec!["kill", "multikill", "death", "assist", "objective", "objective", "objective"]);
        assert_eq!(mid[0].at, t(95.2));
        assert_eq!(mid[0].event, Event::Kill { victim: Some("Zed".into()), weapon: None, headshot: false });
        assert_eq!(mid[1].event, Event::Multikill { count: 2 });
        assert_eq!(mid[2].event, Event::Death { killer: Some("Zed".into()), weapon: None });
        assert_eq!(mid[4].event, Event::Objective { name: "Tower".into(), ours: Some(true) });
        assert_eq!(mid[5].event, Event::Objective { name: "Inhibitor".into(), ours: Some(false) });
        assert_eq!(mid[6].event, Event::Objective { name: "Ace".into(), ours: Some(true) });

        // Seen events are not repeated.
        assert!(tr.observe(t(702.0), Some(&snap(702.0, events.clone()))).is_empty());

        let mut ended = events.as_array().unwrap().clone();
        ended.push(json!({ "EventID": 9, "EventName": "GameEnd", "EventTime": 900.0, "Result": "Win" }));
        let end = tr.observe(t(901.0), Some(&snap(901.0, Value::Array(ended.clone()))));
        assert_eq!(end.len(), 1);
        assert_eq!(end[0].at, t(900.0));
        assert_eq!(
            end[0].event,
            Event::MatchEnd { ally: None, enemy: None, result: Some(Outcome::Win), reason: EndReason::Finished }
        );
        // The post-game screen keeps the API up; that is still the finished game.
        assert!(tr.observe(t(910.0), Some(&snap(910.0, Value::Array(ended)))).is_empty());

        // The client between games, then the next game's clock starting from zero.
        assert!(tr.observe(t(1000.0), None).is_empty());
        assert!(tr.observe(t(1300.0), Some(&snap(3.0, json!([])))).is_empty());
        let next = tr.observe(t(1301.0), Some(&snap(4.0, json!([]))));
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].event.kind(), "match_start");
        assert_eq!(next[0].at, t(1297.0));
    }

    #[test]
    fn joining_mid_match_places_past_events_where_they_happened() {
        let mut tr = Tracker::default();
        let events = json!([
            { "EventID": 0, "EventName": "GameStart", "EventTime": 0.0 },
            { "EventID": 1, "EventName": "DragonKill", "EventTime": 400.0, "KillerName": "Rival", "DragonType": "Elder", "Stolen": "True", "Assisters": [] }
        ]);
        assert!(tr.observe(t(999.0), Some(&snap(599.0, events.clone()))).is_empty());
        // The events held back by the first answer were not marked seen.
        let out = tr.observe(t(1000.0), Some(&snap(600.0, events)));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].at, t(400.0), "match start at clock zero");
        assert_eq!(out[1].at, t(800.0));
        assert_eq!(out[1].event, Event::Objective { name: "Elder Dragon (stolen)".into(), ours: Some(false) });
    }

    /// The API answers through the loading screen with the clock standing at zero. Zero is where
    /// the clock starts running, not where the loading screen began.
    #[test]
    fn a_loading_screen_does_not_set_the_clock() {
        let mut tr = Tracker::default();
        for s in 0..=24 {
            let s = f64::from(s);
            assert!(tr.observe(t(s), Some(&snap(0.0, json!([])))).is_empty(), "loading at {s}s");
        }
        // The game starts at 24.4 s.
        let start = tr.observe(t(25.0), Some(&snap(0.6, json!([{ "EventID": 0, "EventName": "GameStart", "EventTime": 0.0 }]))));
        assert_eq!(start.len(), 1);
        assert_eq!(start[0].event.kind(), "match_start");
        assert_eq!(start[0].at, t(24.4));

        let kill = json!([
            { "EventID": 0, "EventName": "GameStart", "EventTime": 0.0 },
            { "EventID": 1, "EventName": "ChampionKill", "EventTime": 95.0, "KillerName": "Benja", "VictimName": "Rival", "Assisters": [] }
        ]);
        let out = tr.observe(t(124.4 + 0.05), Some(&snap(100.0, kill)));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].at, t(24.4 + 95.0));
    }

    /// A pause stops the clock; what happens after it is placed where it happened, and what came
    /// before keeps its time.
    #[test]
    fn a_pause_moves_zero_for_what_comes_after() {
        let mut tr = Tracker::default();
        tr.observe(t(9.0), Some(&snap(9.0, json!([]))));
        assert_eq!(tr.observe(t(10.0), Some(&snap(10.0, json!([]))))[0].at, t(0.0));

        let mut events = vec![
            json!({ "EventID": 0, "EventName": "GameStart", "EventTime": 0.0 }),
            json!({ "EventID": 1, "EventName": "ChampionKill", "EventTime": 30.0, "KillerName": "Benja", "VictimName": "Rival", "Assisters": [] }),
        ];
        let before = tr.observe(t(31.0), Some(&snap(31.0, Value::Array(events.clone()))));
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].at, t(30.0));

        // Paused at 50 s on the clock for a minute: the clock stands still, which moves nothing.
        tr.observe(t(50.0), Some(&snap(50.0, Value::Array(events.clone()))));
        for s in 51..=109 {
            assert!(tr.observe(t(f64::from(s)), Some(&snap(50.2, Value::Array(events.clone())))).is_empty());
        }
        // Back at 110.2 s of wall time; a kill 0.5 s of game time later.
        events.push(json!({ "EventID": 2, "EventName": "ChampionKill", "EventTime": 50.7, "KillerName": "Rival", "VictimName": "Benja", "Assisters": [] }));
        let after = tr.observe(t(111.0), Some(&snap(51.0, Value::Array(events.clone()))));
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].event.kind(), "death");
        assert_eq!(after[0].at, t(110.7));

        // A slower answer after that is latency again, and a faster one still wins.
        events.push(json!({ "EventID": 3, "EventName": "ChampionKill", "EventTime": 80.0, "KillerName": "Benja", "VictimName": "Rival", "Assisters": [] }));
        let later = tr.observe(t(141.3), Some(&snap(80.5, Value::Array(events.clone()))));
        assert_eq!(later[0].at, t(140.0));
        events.push(json!({ "EventID": 4, "EventName": "ChampionKill", "EventTime": 90.0, "KillerName": "Benja", "VictimName": "Rival", "Assisters": [] }));
        let faster = tr.observe(t(150.3), Some(&snap(90.5, Value::Array(events))));
        assert_eq!(faster[0].at, t(149.8), "zero at 59.8 s");
    }

    #[test]
    fn a_match_with_the_api_gone_is_lost_where_it_went_quiet() {
        let mut tr = Tracker::default();
        tr.observe(t(9.0), Some(&snap(9.0, json!([]))));
        tr.observe(t(10.0), Some(&snap(10.0, json!([]))));
        assert!(tr.observe(t(20.0), None).is_empty());
        assert!(tr.observe(t(50.0), None).is_empty());
        let lost = tr.observe(t(65.0), None);
        assert_eq!(lost.len(), 1);
        assert_eq!(lost[0].at, t(20.0));
        assert!(matches!(lost[0].event, Event::MatchEnd { reason: EndReason::Lost, .. }));
    }

    #[test]
    fn a_new_game_without_an_end_closes_the_old_one() {
        let mut tr = Tracker::default();
        tr.observe(t(0.0), Some(&snap(0.0, json!([]))));
        tr.observe(t(600.0), Some(&snap(600.0, json!([]))));
        let out = tr.observe(t(700.0), Some(&snap(2.0, json!([]))));
        let kinds: Vec<_> = out.iter().map(|e| e.event.kind()).collect();
        assert_eq!(kinds, vec!["match_end"]);
        assert_eq!(out[0].at, t(600.0));
        let next = tr.observe(t(701.0), Some(&snap(3.0, json!([]))));
        let kinds: Vec<_> = next.iter().map(|e| e.event.kind()).collect();
        assert_eq!(kinds, vec!["match_start"]);
        assert_eq!(next[0].at, t(698.0));
    }

    #[test]
    fn names() {
        assert_eq!(mode_name("CHERRY"), "Arena");
        assert_eq!(mode_name("NEWMODE"), "Newmode");
        assert_eq!(map_name(11), Some("Summoner's Rift"));
        assert_eq!(map_name(99), None);
        assert_eq!(side_in("Barracks_T2_L1"), Some("CHAOS"));
        assert_eq!(side_in("SRU_Baron"), None);
    }
}

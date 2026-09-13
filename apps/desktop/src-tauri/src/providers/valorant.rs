//! Valorant, read through the Riot Client's local API without touching the game process.
//!
//! While the Riot Client runs it writes a lockfile with a port and a password, and serves the
//! player's own presence on `https://127.0.0.1:<port>`. The presence carries a base64 JSON blob
//! with the session loop state (`MENUS`, `PREGAME`, `INGAME`), the queue, the map and the
//! running score. Polling it once a second is enough to see a match start, every round end
//! (the score moves) and the match end. Kills are not in it; they come from the match history
//! once a match is over, which is the next phase.
//!
//! Riot does not document this API, and in 2024 moved the loop state from the top of the blob
//! into `matchPresenceData`. Fields are therefore looked up by name wherever they sit, nested
//! objects first, so the old layout and the new one both read. Anything Riot changes again
//! shows up in the log as a presence with no loop state, not as a crash.
//!
//! Vanguard is a kernel anti-cheat. Nothing here opens the game process or reads its memory:
//! the only inputs are a file the client writes for other programs and a loopback HTTP API.

use std::path::PathBuf;
use std::time::Duration as StdDuration;

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

use crate::timeline::{EndReason, Event, GameEvent, Outcome, Provider};

/// How long a match survives with no presence at all (a client restart, a crash, a
/// disconnect) before it is written off.
const LOST_AFTER: Duration = Duration::seconds(90);
/// Between connection attempts while the Riot Client is not answering.
const RECONNECT_EVERY: Duration = Duration::seconds(5);
const HTTP_TIMEOUT: StdDuration = StdDuration::from_secs(2);

/// Where the Riot Client is in the game loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopState {
    Menus,
    Pregame,
    InGame,
    Other(String),
}

impl LoopState {
    fn parse(s: &str) -> Self {
        match s {
            "MENUS" => Self::Menus,
            "PREGAME" => Self::Pregame,
            "INGAME" => Self::InGame,
            other => Self::Other(other.to_string()),
        }
    }
}

/// The parts of the player's presence the timeline uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Presence {
    pub loop_state: LoopState,
    /// `competitive`, `unrated`, `deathmatch`... Empty for custom games.
    pub queue: Option<String>,
    /// Asset path, e.g. `/Game/Maps/Ascent/Ascent`.
    pub map: Option<String>,
    /// `Matchmaking`, `CustomGame`, `ShootingRange`...
    pub provisioning: Option<String>,
    pub ally: Option<u32>,
    pub enemy: Option<u32>,
}

impl Presence {
    fn in_range(&self) -> bool {
        self.provisioning.as_deref() == Some("ShootingRange")
            || self.map.as_deref().is_some_and(|m| {
                let code = map_code(m);
                code == "Range" || code == "Poveglia"
            })
    }
}

/// Looks `key` up in the presence blob: in the nested groups Riot introduced first, then
/// anywhere at all.
fn find<'a>(root: &'a Value, key: &str) -> Option<&'a Value> {
    for group in ["matchPresenceData", "partyPresenceData", "playerPresenceData"] {
        if let Some(v) = root.get(group).and_then(|g| g.get(key)) {
            return Some(v);
        }
    }
    fn anywhere<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
        match v {
            Value::Object(map) => map
                .get(key)
                .or_else(|| map.values().find_map(|child| anywhere(child, key))),
            Value::Array(items) => items.iter().find_map(|child| anywhere(child, key)),
            _ => None,
        }
    }
    anywhere(root, key)
}

fn text(root: &Value, key: &str) -> Option<String> {
    find(root, key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn number(root: &Value, key: &str) -> Option<u32> {
    let v = find(root, key)?;
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .and_then(|n| u32::try_from(n).ok())
}

/// Decodes the `private` field of a Valorant presence. `None` when it is empty or not the
/// blob this expects; a blob without a loop state is not a Valorant presence we can use.
pub fn decode_presence(private: &str) -> Option<Presence> {
    let private = private.trim();
    if private.is_empty() {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(private)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(private))
        .ok()?;
    let root: Value = serde_json::from_slice(&bytes).ok()?;
    parse_presence(&root)
}

fn parse_presence(root: &Value) -> Option<Presence> {
    let loop_state = LoopState::parse(&text(root, "sessionLoopState")?);
    Some(Presence {
        loop_state,
        queue: text(root, "queueId"),
        map: text(root, "matchMap"),
        provisioning: text(root, "provisioningFlow"),
        ally: number(root, "partyOwnerMatchScoreAllyTeam"),
        enemy: number(root, "partyOwnerMatchScoreEnemyTeam"),
    })
}

/// The last segment of a map asset path: `/Game/Maps/Ascent/Ascent` is `Ascent`.
fn map_code(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// Riot ships maps under code names.
pub fn map_name(path: &str) -> String {
    let code = map_code(path);
    let name = match code {
        "Ascent" => "Ascent",
        "Bonsai" => "Split",
        "Canyon" => "Fracture",
        "Duality" => "Bind",
        "Foxtrot" => "Breeze",
        "Jam" => "Lotus",
        "Juliett" => "Sunset",
        "Pitt" => "Pearl",
        "Port" => "Icebox",
        "Triad" => "Haven",
        "Infinity" => "Abyss",
        "Rook" => "Corrode",
        "HURM_Alley" => "District",
        "HURM_Bowl" => "Kasbah",
        "HURM_Helix" => "Drift",
        "HURM_HighTide" => "Glitch",
        "HURM_Yard" => "Piazza",
        "Range" | "Poveglia" => "The Range",
        other => other,
    };
    name.to_string()
}

pub fn mode_name(queue: Option<&str>, provisioning: Option<&str>) -> String {
    match queue.unwrap_or("") {
        "competitive" => "Competitive".into(),
        "unrated" => "Unrated".into(),
        "swiftplay" => "Swiftplay".into(),
        "spikerush" => "Spike Rush".into(),
        "deathmatch" => "Deathmatch".into(),
        "ggteam" => "Escalation".into(),
        "onefa" => "Replication".into(),
        "hurm" => "Team Deathmatch".into(),
        "premier" => "Premier".into(),
        "snowball" => "Snowball Fight".into(),
        "newmap" => "New Map".into(),
        "" if provisioning == Some("CustomGame") => "Custom".into(),
        "" => "Unknown mode".into(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    }
}

/// Modes where the score counts rounds, so it names a winner. Deathmatch and its cousins
/// report something else in the same fields.
fn scores_rounds(queue: Option<&str>) -> bool {
    matches!(
        queue.unwrap_or(""),
        "competitive" | "unrated" | "swiftplay" | "spikerush" | "premier" | "newmap" | ""
    )
}

/// Turns successive presences into timeline events. Pure, so every transition is testable
/// without a Riot Client.
#[derive(Debug, Default)]
pub struct Tracker {
    in_match: bool,
    queue: Option<String>,
    score: (u32, u32),
    /// When presences stopped arriving mid-match.
    lost_since: Option<DateTime<Utc>>,
    last_state: Option<LoopState>,
}

impl Tracker {
    /// `presence` is `None` when the client could not be read or had no presence for us.
    pub fn observe(&mut self, now: DateTime<Utc>, presence: Option<&Presence>) -> Vec<GameEvent> {
        let mut out = Vec::new();
        let Some(p) = presence else {
            if self.in_match {
                let since = *self.lost_since.get_or_insert(now);
                if now - since >= LOST_AFTER {
                    log::warn!("valorant: no presence for {}s mid-match, ending it", LOST_AFTER.num_seconds());
                    out.push(self.end(since, EndReason::Lost));
                }
            }
            return out;
        };
        self.lost_since = None;
        if self.last_state.as_ref() != Some(&p.loop_state) {
            log::info!(
                "valorant: {:?} (queue {:?}, map {:?}, flow {:?})",
                p.loop_state,
                p.queue,
                p.map,
                p.provisioning
            );
            self.last_state = Some(p.loop_state.clone());
        }

        let playing = p.loop_state == LoopState::InGame && !p.in_range();
        if !playing {
            if self.in_match {
                out.push(self.end(now, EndReason::Finished));
            }
            return out;
        }

        let score = (p.ally.unwrap_or(0), p.enemy.unwrap_or(0));
        if !self.in_match {
            out.push(self.start(now, p, score));
            return out;
        }

        let before = self.score.0 + self.score.1;
        let after = score.0 + score.1;
        if after > before {
            let won = match (score.0 > self.score.0, score.1 > self.score.1) {
                (true, false) => Some(true),
                (false, true) => Some(false),
                _ => None,
            };
            self.score = score;
            out.push(GameEvent {
                at: now,
                event: Event::RoundEnd { round: after, ally: score.0, enemy: score.1, won },
            });
        } else if after < before {
            // The score went back: the client moved straight on to another match.
            out.push(self.end(now, EndReason::Finished));
            out.push(self.start(now, p, score));
        }
        out
    }

    fn start(&mut self, now: DateTime<Utc>, p: &Presence, score: (u32, u32)) -> GameEvent {
        self.in_match = true;
        self.queue = p.queue.clone();
        self.score = score;
        GameEvent {
            at: now,
            event: Event::MatchStart {
                map: p.map.as_deref().map(map_name),
                mode: Some(mode_name(p.queue.as_deref(), p.provisioning.as_deref())),
            },
        }
    }

    fn end(&mut self, at: DateTime<Utc>, reason: EndReason) -> GameEvent {
        self.in_match = false;
        self.lost_since = None;
        let (ally, enemy) = self.score;
        let scored = scores_rounds(self.queue.as_deref()) && ally + enemy > 0;
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

/// The lockfile: `name:pid:port:password:protocol`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lockfile {
    pub port: u16,
    pub password: String,
}

pub fn parse_lockfile(text: &str) -> Option<Lockfile> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if parts.len() < 5 {
        return None;
    }
    let port = parts[2].parse().ok()?;
    // A password never contains a colon in practice, but join what is between the port and
    // the protocol rather than trust that.
    let password = parts[3..parts.len() - 1].join(":");
    (!password.is_empty()).then_some(Lockfile { port, password })
}

fn lockfile_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("Riot Games").join("Riot Client").join("Config").join("lockfile"))
}

/// A reachable Riot Client and the player it belongs to.
struct Client {
    http: reqwest::blocking::Client,
    base: String,
    auth: String,
    puuid: String,
}

impl Client {
    fn connect() -> Result<Client> {
        let path = lockfile_path().context("LOCALAPPDATA is not set")?;
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let lock = parse_lockfile(&text).context("the Riot Client lockfile has an unexpected shape")?;
        let http = reqwest::blocking::Client::builder()
            // The client serves loopback HTTPS with a certificate of its own.
            .tls_danger_accept_invalid_certs(true)
            .timeout(HTTP_TIMEOUT)
            .build()
            .context("building the local API client")?;
        let auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("riot:{}", lock.password))
        );
        let mut client = Client {
            http,
            base: format!("https://127.0.0.1:{}", lock.port),
            auth,
            puuid: String::new(),
        };
        let session = client.get("/chat/v1/session")?;
        let puuid = session
            .get("puuid")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .context("the chat session has no puuid yet")?;
        client.puuid = puuid.to_string();
        Ok(client)
    }

    fn get(&self, path: &str) -> Result<Value> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .header("Authorization", &self.auth)
            .send()
            .with_context(|| format!("GET {path}"))?;
        let status = response.status();
        if !status.is_success() {
            bail!("GET {path}: {status}");
        }
        response.json().with_context(|| format!("GET {path}: not JSON"))
    }

    /// The player's own Valorant presence. `Ok(None)` when the client answers but has none.
    fn presence(&self) -> Result<Option<Presence>> {
        let body = self.get("/chat/v4/presences")?;
        let own = body
            .get("presences")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|p| {
                p.get("puuid").and_then(Value::as_str) == Some(self.puuid.as_str())
                    && p.get("product").and_then(Value::as_str) == Some("valorant")
            });
        let Some(private) = own.and_then(|p| p.get("private")).and_then(Value::as_str) else {
            return Ok(None);
        };
        let presence = decode_presence(private);
        if presence.is_none() {
            log::debug!("valorant: a presence without a loop state: {private}");
        }
        Ok(presence)
    }
}

pub struct Valorant {
    client: Option<Client>,
    next_connect: Option<DateTime<Utc>>,
    reached: bool,
    tracker: Tracker,
    last_error: Option<String>,
}

impl Valorant {
    pub fn new() -> Self {
        Self {
            client: None,
            next_connect: None,
            reached: false,
            tracker: Tracker::default(),
            last_error: None,
        }
    }

    fn note_error(&mut self, e: anyhow::Error) {
        let text = format!("{e:#}");
        if self.last_error.as_deref() != Some(text.as_str()) {
            log::info!("valorant: local API unavailable: {text}");
            self.last_error = Some(text);
        }
    }
}

impl Provider for Valorant {
    fn poll(&mut self, now: DateTime<Utc>) -> Vec<GameEvent> {
        if self.client.is_none() && self.next_connect.is_none_or(|t| now >= t) {
            match Client::connect() {
                Ok(client) => {
                    log::info!("valorant: connected to the local API");
                    self.client = Some(client);
                    self.last_error = None;
                }
                Err(e) => {
                    self.note_error(e);
                    self.next_connect = Some(now + RECONNECT_EVERY);
                }
            }
        }
        let presence = match self.client.as_ref().map(Client::presence) {
            Some(Ok(p)) => {
                if p.is_some() {
                    self.reached = true;
                }
                p
            }
            Some(Err(e)) => {
                // The client restarted (new port and password) or went away.
                self.client = None;
                self.next_connect = Some(now + RECONNECT_EVERY);
                self.note_error(e);
                None
            }
            None => None,
        };
        self.tracker.observe(now, presence.as_ref())
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

    fn encode(v: &Value) -> String {
        base64::engine::general_purpose::STANDARD.encode(v.to_string())
    }

    fn ingame(ally: u32, enemy: u32) -> Presence {
        Presence {
            loop_state: LoopState::InGame,
            queue: Some("competitive".into()),
            map: Some("/Game/Maps/Duality/Duality".into()),
            provisioning: Some("Matchmaking".into()),
            ally: Some(ally),
            enemy: Some(enemy),
        }
    }

    fn menus() -> Presence {
        Presence {
            loop_state: LoopState::Menus,
            queue: Some("competitive".into()),
            map: None,
            provisioning: None,
            ally: Some(0),
            enemy: Some(0),
        }
    }

    #[test]
    fn decodes_the_flat_layout() {
        let blob = json!({
            "isValid": true,
            "sessionLoopState": "INGAME",
            "partyOwnerSessionLoopState": "INGAME",
            "matchMap": "/Game/Maps/Ascent/Ascent",
            "queueId": "competitive",
            "provisioningFlow": "Matchmaking",
            "partyOwnerMatchScoreAllyTeam": 5,
            "partyOwnerMatchScoreEnemyTeam": 3
        });
        let p = decode_presence(&encode(&blob)).unwrap();
        assert_eq!(p.loop_state, LoopState::InGame);
        assert_eq!(p.queue.as_deref(), Some("competitive"));
        assert_eq!((p.ally, p.enemy), (Some(5), Some(3)));
    }

    #[test]
    fn decodes_the_nested_layout_and_prefers_it() {
        let blob = json!({
            "isValid": true,
            // A stale top-level value next to the new nested one: the nested one wins.
            "sessionLoopState": "MENUS",
            "matchPresenceData": {
                "sessionLoopState": "INGAME",
                "provisioningFlow": "Matchmaking",
                "matchMap": "/Game/Maps/HURM/HURM_Yard/HURM_Yard",
                "queueId": "hurm"
            },
            "partyPresenceData": {
                "partyOwnerMatchScoreAllyTeam": "12",
                "partyOwnerMatchScoreEnemyTeam": 40,
                "partyState": "DEFAULT"
            },
            "playerPresenceData": { "accountLevel": 120 }
        });
        let p = decode_presence(&encode(&blob)).unwrap();
        assert_eq!(p.loop_state, LoopState::InGame);
        assert_eq!(map_name(p.map.as_deref().unwrap()), "Piazza");
        assert_eq!(mode_name(p.queue.as_deref(), None), "Team Deathmatch");
        assert_eq!((p.ally, p.enemy), (Some(12), Some(40)));
    }

    #[test]
    fn rejects_what_is_not_a_presence() {
        assert_eq!(decode_presence(""), None);
        assert_eq!(decode_presence("not base64 at all!"), None);
        assert_eq!(decode_presence(&encode(&json!({"isValid": true}))), None);
    }

    #[test]
    fn names() {
        assert_eq!(map_name("/Game/Maps/Bonsai/Bonsai"), "Split");
        assert_eq!(map_name("/Game/Maps/Somewhere/NewCode"), "NewCode");
        assert_eq!(mode_name(Some("spikerush"), None), "Spike Rush");
        assert_eq!(mode_name(Some(""), Some("CustomGame")), "Custom");
        assert_eq!(mode_name(Some("brandnew"), None), "Brandnew");
    }

    #[test]
    fn lockfile() {
        assert_eq!(
            parse_lockfile("Riot Client:12345:54321:s3cr3t-pass:https\r\n"),
            Some(Lockfile { port: 54321, password: "s3cr3t-pass".into() })
        );
        assert_eq!(parse_lockfile("Riot Client:1:notaport:pw:https"), None);
        assert_eq!(parse_lockfile("garbage"), None);
    }

    #[test]
    fn a_competitive_match_from_agent_select_to_the_menus() {
        let mut tr = Tracker::default();
        assert!(tr.observe(t(0), Some(&menus())).is_empty());
        let pregame = Presence { loop_state: LoopState::Pregame, ..menus() };
        assert!(tr.observe(t(10), Some(&pregame)).is_empty(), "agent select is not the match yet");

        let start = tr.observe(t(90), Some(&ingame(0, 0)));
        assert_eq!(
            start,
            vec![GameEvent {
                at: t(90),
                event: Event::MatchStart { map: Some("Bind".into()), mode: Some("Competitive".into()) },
            }]
        );
        assert!(tr.observe(t(91), Some(&ingame(0, 0))).is_empty());

        let r1 = tr.observe(t(200), Some(&ingame(1, 0)));
        assert_eq!(r1[0].event, Event::RoundEnd { round: 1, ally: 1, enemy: 0, won: Some(true) });
        let r2 = tr.observe(t(300), Some(&ingame(1, 1)));
        assert_eq!(r2[0].event, Event::RoundEnd { round: 2, ally: 1, enemy: 1, won: Some(false) });
        // A missed poll: two rounds at once cannot be attributed.
        let r4 = tr.observe(t(500), Some(&ingame(2, 2)));
        assert_eq!(r4[0].event, Event::RoundEnd { round: 4, ally: 2, enemy: 2, won: None });
        assert!(tr.observe(t(501), Some(&ingame(2, 2))).is_empty(), "no change, no event");

        tr.observe(t(1700), Some(&ingame(13, 2)));
        let end = tr.observe(t(1740), Some(&menus()));
        assert_eq!(
            end[0].event,
            Event::MatchEnd {
                ally: Some(13),
                enemy: Some(2),
                result: Some(Outcome::Win),
                reason: EndReason::Finished,
            }
        );
        assert!(tr.observe(t(1741), Some(&menus())).is_empty());
    }

    #[test]
    fn deathmatch_has_no_result_and_the_range_is_no_match() {
        let mut tr = Tracker::default();
        let range = Presence {
            provisioning: Some("ShootingRange".into()),
            map: Some("/Game/Maps/Poveglia/Range".into()),
            ..ingame(0, 0)
        };
        assert!(tr.observe(t(0), Some(&range)).is_empty());

        let dm = Presence { queue: Some("deathmatch".into()), ..ingame(0, 0) };
        let start = tr.observe(t(10), Some(&dm));
        assert!(matches!(&start[0].event, Event::MatchStart { mode: Some(m), .. } if m == "Deathmatch"));
        tr.observe(t(100), Some(&Presence { ally: Some(15), ..dm.clone() }));
        let end = tr.observe(t(600), Some(&menus()));
        assert!(matches!(end[0].event, Event::MatchEnd { result: None, ally: None, .. }));
    }

    #[test]
    fn a_match_without_presence_for_long_is_lost_where_it_went_quiet() {
        let mut tr = Tracker::default();
        tr.observe(t(0), Some(&ingame(0, 0)));
        tr.observe(t(100), Some(&ingame(3, 1)));
        assert!(tr.observe(t(101), None).is_empty());
        assert!(tr.observe(t(150), None).is_empty());
        let lost = tr.observe(t(101 + 90), None);
        assert_eq!(lost[0].at, t(101), "the end is when it went quiet, not when we gave up");
        assert!(matches!(
            lost[0].event,
            Event::MatchEnd { ally: Some(3), enemy: Some(1), result: None, reason: EndReason::Lost }
        ));
        // Presence coming back mid-match within the grace keeps the match.
        let mut tr = Tracker::default();
        tr.observe(t(0), Some(&ingame(0, 0)));
        tr.observe(t(10), None);
        assert!(tr.observe(t(50), Some(&ingame(1, 0)))[0].event.kind() == "round_end");
        assert!(tr.observe(t(200), None).is_empty(), "the quiet clock restarted");
    }

    #[test]
    fn a_score_that_goes_back_is_a_new_match() {
        let mut tr = Tracker::default();
        tr.observe(t(0), Some(&ingame(0, 0)));
        tr.observe(t(100), Some(&ingame(4, 4)));
        let events = tr.observe(t(200), Some(&ingame(0, 0)));
        let kinds: Vec<_> = events.iter().map(|e| e.event.kind()).collect();
        assert_eq!(kinds, vec!["match_end", "match_start"]);
    }
}

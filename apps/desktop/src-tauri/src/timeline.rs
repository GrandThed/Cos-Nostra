//! The game-agnostic timeline every supported game feeds.
//!
//! A *session* is one stretch of playing a game: it opens when the game's process appears and
//! closes once the player has left it. The whole session is recorded to disk, and afterwards
//! each match is cut out of that recording. Inside a session a game's [`Provider`] reports what
//! happened as [`GameEvent`]s: a match starting, a round ending, a match ending, and for games
//! that can tell, kills and deaths.
//!
//! Everything carries the wall-clock time it happened rather than an offset into some file.
//! Recordings, events and the match files cut from them then line up by subtraction, whatever
//! restarted in between: a recorder restart mid-match just leaves two recordings side by side.
//!
//! Detection only ever *labels* footage, it never decides what gets recorded. A provider that
//! misses a match start costs a marker, not the match.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Footage kept before a match starts, so the load-in and the first seconds are not clipped.
pub const PRE_ROLL: Duration = Duration::seconds(10);
/// Footage kept after a match ends, for the scoreboard.
pub const POST_ROLL: Duration = Duration::seconds(8);

/// The games that get whole-session recording. Everything else keeps the replay buffer only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionGame {
    Valorant,
    League,
    CounterStrike,
}

impl SessionGame {
    pub const ALL: [SessionGame; 3] = [Self::Valorant, Self::League, Self::CounterStrike];

    /// Stable id, stored in the database.
    pub fn id(self) -> &'static str {
        match self {
            Self::Valorant => "valorant",
            Self::League => "league",
            Self::CounterStrike => "counter_strike",
        }
    }

    /// Processes that exist only while the player is in the game proper. The session records
    /// while one of these runs. League's `League of Legends.exe` lives for one match; Valorant
    /// and Counter-Strike keep one process from the menus through every match.
    fn game_exes(self) -> &'static [&'static str] {
        match self {
            Self::Valorant => &["VALORANT-Win64-Shipping.exe"],
            Self::League => &["League of Legends.exe"],
            Self::CounterStrike => &["cs2.exe", "csgo.exe"],
        }
    }

    /// Clients whose presence means the player is between matches rather than done, so the
    /// session stays open (without recording) for a while after the game process exits.
    fn client_exes(self) -> &'static [&'static str] {
        match self {
            Self::League => &["LeagueClientUx.exe", "LeagueClient.exe"],
            Self::Valorant | Self::CounterStrike => &[],
        }
    }
}

/// What the process list says about a supported game right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sighting {
    pub game: SessionGame,
    /// The process that was matched, e.g. `cs2.exe`. Used for the display name.
    pub executable: String,
    /// True when the game proper runs; false when only its client does.
    pub in_game: bool,
}

/// Looks for a supported game in a list of running executable names. A running game wins over
/// a client that is merely open, so League's client does not hide a Valorant match.
pub fn sight(running: &[String]) -> Option<Sighting> {
    let find = |names: &[&str]| {
        running
            .iter()
            .find(|r| names.iter().any(|n| n.eq_ignore_ascii_case(r)))
            .cloned()
    };
    for game in SessionGame::ALL {
        if let Some(executable) = find(game.game_exes()) {
            return Some(Sighting { game, executable, in_game: true });
        }
    }
    for game in SessionGame::ALL {
        if let Some(executable) = find(game.client_exes()) {
            return Some(Sighting { game, executable, in_game: false });
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Win,
    Loss,
    Draw,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Win => "win",
            Self::Loss => "loss",
            Self::Draw => "draw",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "win" => Self::Win,
            "loss" => Self::Loss,
            "draw" => Self::Draw,
            _ => return None,
        })
    }

    /// From a final score, when the game reports one.
    pub fn from_score(ally: u32, enemy: u32) -> Self {
        match ally.cmp(&enemy) {
            std::cmp::Ordering::Greater => Self::Win,
            std::cmp::Ordering::Less => Self::Loss,
            std::cmp::Ordering::Equal => Self::Draw,
        }
    }
}

/// Why a match stopped being the current one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    /// The game said the match is over.
    Finished,
    /// The game or the provider went away mid-match: a crash, a disconnect, a closed client.
    Lost,
    /// The session ended while the match was still open.
    SessionEnded,
    /// A new match started before this one reported an end.
    Superseded,
}

/// What happened. Serialised with its `kind` tag into the database and across the bridge, so
/// the variant and field names are part of the UI contract (`types.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    MatchStart {
        map: Option<String>,
        mode: Option<String>,
    },
    /// A round is decided. `round` counts from 1. `won` is `None` when the game reports a
    /// score change it cannot attribute.
    RoundEnd {
        round: u32,
        ally: u32,
        enemy: u32,
        won: Option<bool>,
    },
    MatchEnd {
        ally: Option<u32>,
        enemy: Option<u32>,
        result: Option<Outcome>,
        reason: EndReason,
    },
    /// The player killed someone. For providers that can see it; Valorant's presence cannot.
    Kill {
        victim: Option<String>,
        weapon: Option<String>,
        headshot: bool,
    },
    Death {
        killer: Option<String>,
        weapon: Option<String>,
    },
    Assist {
        victim: Option<String>,
    },
    /// The player's kill streak reached `count` in quick succession: 2 is a double kill, 5 a
    /// penta in League, an ace in a five-a-side shooter.
    Multikill {
        count: u32,
    },
    /// Something the match turns on that is not a kill: a dragon, a tower, a team ace, a bomb
    /// plant. `ours` is true when the player's team got it, false when the other team did, and
    /// `None` when the game does not say.
    Objective {
        name: String,
        ours: Option<bool>,
    },
}

impl Event {
    /// The `kind` tag, for the indexed column.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::MatchStart { .. } => "match_start",
            Self::RoundEnd { .. } => "round_end",
            Self::MatchEnd { .. } => "match_end",
            Self::Kill { .. } => "kill",
            Self::Death { .. } => "death",
            Self::Assist { .. } => "assist",
            Self::Multikill { .. } => "multikill",
            Self::Objective { .. } => "objective",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GameEvent {
    pub at: DateTime<Utc>,
    pub event: Event,
}

/// A game's source of events for one session. Polled about once a second from the session
/// watch thread, so it may block briefly (a local HTTP call with a short timeout) but never for
/// long.
pub trait Provider: Send {
    /// Whatever happened since the last poll, oldest first.
    fn poll(&mut self, now: DateTime<Utc>) -> Vec<GameEvent>;

    /// True once the provider has reached the game's data at least once this session. A
    /// session whose provider worked and saw no match was menus only and is discarded; one
    /// whose provider never worked keeps its footage, because nobody looked.
    fn reached(&self) -> bool;
}

/// A span of wall-clock time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

/// One recording file and the wall-clock time it covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Covered {
    pub recording: i64,
    pub span: Span,
}

/// A range of one recording file, in milliseconds from the start of that file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Piece {
    pub recording: i64,
    pub from_ms: i64,
    pub to_ms: i64,
}

/// Shortest piece worth cutting. Anything shorter is a recorder hiccup at an edge.
const MIN_PIECE_MS: i64 = 1_000;

/// The parts of the recordings that show `want`, in time order. Empty when no footage covers
/// it at all, which is what a match played while the recorder was down looks like.
pub fn pieces(want: Span, recordings: &[Covered]) -> Vec<Piece> {
    let mut sorted: Vec<Covered> = recordings.to_vec();
    sorted.sort_by_key(|c| c.span.start);
    sorted
        .into_iter()
        .filter_map(|c| {
            let start = want.start.max(c.span.start);
            let end = want.end.min(c.span.end);
            let from_ms = (start - c.span.start).num_milliseconds();
            let to_ms = (end - c.span.start).num_milliseconds();
            (to_ms - from_ms >= MIN_PIECE_MS).then_some(Piece {
                recording: c.recording,
                from_ms,
                to_ms,
            })
        })
        .collect()
}

/// The footage a match wants: its own span widened by the pre- and post-roll.
pub fn wanted(start: DateTime<Utc>, end: DateTime<Utc>) -> Span {
    Span {
        start: start - PRE_ROLL,
        end: end + POST_ROLL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + s, 0).unwrap()
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn sights_games_and_clients() {
        assert_eq!(sight(&names(&["explorer.exe", "Discord.exe"])), None);
        let v = sight(&names(&["explorer.exe", "valorant-win64-shipping.exe"])).unwrap();
        assert_eq!(v.game, SessionGame::Valorant);
        assert!(v.in_game);
        assert_eq!(v.executable, "valorant-win64-shipping.exe");

        let client = sight(&names(&["LeagueClientUx.exe"])).unwrap();
        assert_eq!(client.game, SessionGame::League);
        assert!(!client.in_game);

        // A running game beats another game's idle client.
        let both = sight(&names(&["LeagueClientUx.exe", "cs2.exe"])).unwrap();
        assert_eq!(both.game, SessionGame::CounterStrike);
        assert!(both.in_game);

        // Riot's shared client is not a sighting of either Riot game.
        assert_eq!(sight(&names(&["RiotClientServices.exe"])), None);
    }

    #[test]
    fn game_ids_are_distinct_and_match_serde() {
        for g in SessionGame::ALL {
            assert_eq!(serde_json::to_value(g).unwrap(), g.id(), "the UI reads the serde spelling");
        }
    }

    #[test]
    fn events_serialise_with_their_kind() {
        let e = Event::RoundEnd { round: 3, ally: 2, enemy: 1, won: Some(true) };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "round_end");
        assert_eq!(json["ally"], 2);
        assert_eq!(e.kind(), "round_end");
        let back: Event = serde_json::from_value(json).unwrap();
        assert_eq!(back, e);

        let end = Event::MatchEnd {
            ally: Some(13),
            enemy: Some(9),
            result: Some(Outcome::Win),
            reason: EndReason::Finished,
        };
        let json = serde_json::to_value(&end).unwrap();
        assert_eq!(json["result"], "win");
        assert_eq!(json["reason"], "finished");
    }

    #[test]
    fn outcome_from_score() {
        assert_eq!(Outcome::from_score(13, 9), Outcome::Win);
        assert_eq!(Outcome::from_score(9, 13), Outcome::Loss);
        assert_eq!(Outcome::from_score(12, 12), Outcome::Draw);
        assert_eq!(Outcome::parse(Outcome::Loss.as_str()), Some(Outcome::Loss));
    }

    #[test]
    fn pieces_inside_one_recording() {
        let rec = [Covered { recording: 1, span: Span { start: t(0), end: t(3600) } }];
        let p = pieces(Span { start: t(100), end: t(200) }, &rec);
        assert_eq!(p, vec![Piece { recording: 1, from_ms: 100_000, to_ms: 200_000 }]);
    }

    #[test]
    fn pieces_are_clipped_to_the_footage() {
        // The match started before the recorder did, and outlived the recording.
        let rec = [Covered { recording: 7, span: Span { start: t(50), end: t(120) } }];
        let p = pieces(Span { start: t(0), end: t(500) }, &rec);
        assert_eq!(p, vec![Piece { recording: 7, from_ms: 0, to_ms: 70_000 }]);
    }

    #[test]
    fn pieces_span_a_recorder_restart_in_order() {
        let recs = [
            Covered { recording: 2, span: Span { start: t(300), end: t(900) } },
            Covered { recording: 1, span: Span { start: t(0), end: t(290) } },
        ];
        let p = pieces(Span { start: t(200), end: t(400) }, &recs);
        assert_eq!(
            p,
            vec![
                Piece { recording: 1, from_ms: 200_000, to_ms: 290_000 },
                Piece { recording: 2, from_ms: 0, to_ms: 100_000 },
            ]
        );
    }

    #[test]
    fn no_footage_and_slivers_give_no_pieces() {
        let rec = [Covered { recording: 1, span: Span { start: t(0), end: t(100) } }];
        assert!(pieces(Span { start: t(200), end: t(300) }, &rec).is_empty());
        // Half a second of overlap at the edge is not a piece.
        let edge = Span {
            start: t(100) - Duration::milliseconds(500),
            end: t(300),
        };
        assert!(pieces(edge, &rec).is_empty());
    }

    #[test]
    fn wanted_adds_the_rolls() {
        let w = wanted(t(100), t(200));
        assert_eq!(w.start, t(90));
        assert_eq!(w.end, t(208));
    }
}

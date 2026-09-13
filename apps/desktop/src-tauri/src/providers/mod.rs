//! Event providers, one per game that can tell us what is happening in it.
//!
//! A game without a provider still gets its sessions recorded; nothing marks matches in them,
//! so each recording is kept whole.

pub mod counter_strike;
pub mod league;
pub mod valorant;

use crate::timeline::{Provider, SessionGame};

pub fn for_game(game: SessionGame) -> Option<Box<dyn Provider>> {
    match game {
        SessionGame::Valorant => Some(Box::new(valorant::Valorant::new())),
        SessionGame::League => Some(Box::new(league::League::new())),
        SessionGame::CounterStrike => Some(Box::new(counter_strike::CounterStrike::new())),
        // Teamfight Tactics has no provider: its sessions keep whole recordings, the same
        // treatment Counter-Strike had before its GSI provider.
        SessionGame::TeamfightTactics => None,
    }
}

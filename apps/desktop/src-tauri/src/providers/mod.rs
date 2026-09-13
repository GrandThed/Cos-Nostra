//! Event providers, one per game that can tell us what is happening in it.
//!
//! A game without a provider still gets its sessions recorded; nothing marks matches in them,
//! so each recording is kept whole.

pub mod league;
pub mod valorant;

use crate::timeline::{Provider, SessionGame};

pub fn for_game(game: SessionGame) -> Option<Box<dyn Provider>> {
    match game {
        SessionGame::Valorant => Some(Box::new(valorant::Valorant::new())),
        SessionGame::League => Some(Box::new(league::League::new())),
        // Counter-Strike's Game State Integration is the next provider; until then its
        // sessions keep whole recordings.
        SessionGame::CounterStrike => None,
    }
}

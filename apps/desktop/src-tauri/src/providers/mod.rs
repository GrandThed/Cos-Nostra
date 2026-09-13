//! Event providers, one per game that can tell us what is happening in it.
//!
//! A game without a provider still gets its sessions recorded; nothing marks matches in them,
//! so each recording is kept whole.

pub mod valorant;

use crate::timeline::{Provider, SessionGame};

pub fn for_game(game: SessionGame) -> Option<Box<dyn Provider>> {
    match game {
        SessionGame::Valorant => Some(Box::new(valorant::Valorant::new())),
        // League's Live Client Data API and Counter-Strike's Game State Integration are the
        // next providers; until then their sessions keep whole recordings.
        SessionGame::League | SessionGame::CounterStrike => None,
    }
}

//! utilities.mc — Nether <-> Overworld coordinate converter and portal linking (Part 11).
//!
//! Pure Rust, no C dependency. Compiles to `wasm32-unknown-unknown` with plain
//! `wasm-pack`, so it stays on the easy side of the Part 0 libc boundary and must not be
//! moved into `engine/`.
//!
//! Pinned to **Minecraft 1.21.3**, the same version as the rest of the project. Portal
//! search specifics have shifted across versions, so the linking rules in
//! [`linking`] are version-dependent and should be surfaced as such in any UI.

pub mod coords;
pub mod linking;

pub use coords::{convert_y, nether_to_overworld, overworld_to_nether};
pub use linking::{
    Dimension, LinkOutcome, OVERWORLD_SPAN_OF_NETHER_SEARCH, counterpart, links,
    portals_may_collide, search_radius,
};

/// Minecraft version these rules encode. Show it in the UI (same discipline as Part 8).
pub const MC_VERSION: &str = "1.21.3";

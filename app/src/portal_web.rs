//! Thin wasm-bindgen surface over the `portal` crate (Part 11.3 wiring).

use portal::{
    Dimension, LinkOutcome, OVERWORLD_SPAN_OF_NETHER_SEARCH, links, nether_to_overworld,
    overworld_to_nether, portals_may_collide,
};
use wasm_bindgen::prelude::*;

/// Overworld block coords -> Nether, as `[x, z]`. Y is never scaled.
#[wasm_bindgen]
pub fn portal_to_nether(x: i32, z: i32) -> Vec<i32> {
    let (nx, nz) = overworld_to_nether(x, z);
    vec![nx, nz]
}

/// Nether block coords -> Overworld, as `[x, z]`.
#[wasm_bindgen]
pub fn portal_to_overworld(x: i32, z: i32) -> Vec<i32> {
    let (ox, oz) = nether_to_overworld(x, z);
    vec![ox, oz]
}

/// The span of Overworld blocks that share one Nether search area (~128).
#[wasm_bindgen]
pub fn portal_collision_span() -> i32 {
    OVERWORLD_SPAN_OF_NETHER_SEARCH
}

/// Does an Overworld portal at `(from_x, from_z)` link to a Nether portal at `(to_x, to_z)`?
/// Returns "links", "marginal", or "no:<short_by>".
#[wasm_bindgen]
pub fn portal_links_from_overworld(from_x: i32, from_z: i32, to_x: i32, to_z: i32) -> String {
    outcome(links(Dimension::Overworld, (from_x, from_z), (to_x, to_z)))
}

/// Does a Nether portal at `(from_x, from_z)` link to an Overworld portal at `(to_x, to_z)`?
#[wasm_bindgen]
pub fn portal_links_from_nether(from_x: i32, from_z: i32, to_x: i32, to_z: i32) -> String {
    outcome(links(Dimension::Nether, (from_x, from_z), (to_x, to_z)))
}

/// Do two Overworld portals risk collapsing onto the same Nether portal?
#[wasm_bindgen]
pub fn portal_may_collide(ax: i32, az: i32, bx: i32, bz: i32) -> bool {
    portals_may_collide((ax, az), (bx, bz))
}

fn outcome(o: LinkOutcome) -> String {
    match o {
        LinkOutcome::Links => "links".into(),
        LinkOutcome::Marginal => "marginal".into(),
        LinkOutcome::NoLink { short_by } => format!("no:{short_by}"),
    }
}

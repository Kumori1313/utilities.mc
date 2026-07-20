//! utilities.mc — application layer (Part 6).
//!
//! This crate holds **no C dependency**. That is the entire point of the Path A split:
//! Cubiomes is compiled separately by `engine/build.sh` via Emscripten, and this crate
//! reaches it through JS bindings. Adding `cubiomes`/`cubiomes-sys` here would drag the
//! Part 0 libc problem back into a crate that currently builds cleanly on
//! `wasm32-unknown-unknown`.
//!
//! Everything that is genuinely Rust's strength belongs here: view state, an LRU chunk
//! cache, coordinate/chunk math, and post-processing of raw biome data before it reaches
//! the renderer.

use wasm_bindgen::prelude::*;

// Provided by engine/cubiomes.js, which the frontend loads and exposes on `window`
// BEFORE initializing this module (see Part 7 — load order is load-bearing).
#[wasm_bindgen]
extern "C" {
    /// Installs seed/version/dimension on the shim's single generator. Must be called
    /// before any query, and again whenever the world changes. Returns 0, or -1 if the
    /// version or dimension is out of range.
    ///
    /// This is separate from the query calls because `applySeed` builds the entire noise
    /// stack — roughly 13x the cost of a whole 128x128 tile if paid per sample. Hoist it.
    #[wasm_bindgen(js_namespace = window)]
    fn set_world(seed: u64, version: i32, dim: i32) -> i32;

    /// `scale` is 1 for block coordinates or 4 for biome coordinates (block/4); the
    /// shim returns -1 for anything else. It is an explicit parameter because passing
    /// block coordinates at scale 4 silently reads a point 4x further out on every
    /// axis rather than failing.
    #[wasm_bindgen(js_namespace = window)]
    fn get_biome_at(scale: i32, x: i32, y: i32, z: i32) -> i32;
}

/// Smoke test for the two-module wiring: proves this crate can call through to the
/// Emscripten-built Cubiomes module. Replace with real view logic once Part 5 lands.
///
/// Re-seeds on every call, which is exactly what the shim's split exists to avoid — fine
/// for a one-shot smoke test, wrong for the tile loop this becomes. When Part 6 wires up
/// the real view, `set_world` belongs at world-change time and the sampling belongs in
/// `gen_biomes`, which this binding does not yet expose.
#[wasm_bindgen]
pub fn biome_for_view(seed: u64, version: i32, x: i32, z: i32) -> i32 {
    if set_world(seed, version, 0 /* DIM_OVERWORLD */) != 0 {
        return -1;
    }
    get_biome_at(1, x, 64, z)
}

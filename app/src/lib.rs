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
    /// `scale` is 1 for block coordinates or 4 for biome coordinates (block/4); the
    /// shim returns -1 for anything else. It is an explicit parameter because passing
    /// block coordinates at scale 4 silently reads a point 4x further out on every
    /// axis rather than failing.
    #[wasm_bindgen(js_namespace = window)]
    fn get_biome_at(seed: u64, version: i32, scale: i32, x: i32, y: i32, z: i32) -> i32;
}

/// Smoke test for the two-module wiring: proves this crate can call through to the
/// Emscripten-built Cubiomes module. Replace with real view logic once Part 5 lands.
#[wasm_bindgen]
pub fn biome_for_view(seed: u64, version: i32, x: i32, z: i32) -> i32 {
    get_biome_at(seed, version, 1, x, 64, z)
}

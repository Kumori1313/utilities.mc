//! utilities.mc — application layer (Part 6).
//!
//! This crate holds **no C dependency**. That is the entire point of the Path A split:
//! Cubiomes is compiled separately by `engine/build.sh` via Emscripten, and this crate
//! reaches it through JS. Adding `cubiomes`/`cubiomes-sys` here would drag the Part 0 libc
//! problem back into a crate that currently builds cleanly on `wasm32-unknown-unknown`.
//!
//! # Deviation from the guide's Part 6 sketch
//!
//! The guide wraps `get_biome_at` as `biome_for_view(seed, version, cx, cz)`, calling
//! `set_world` **per sample**. That re-seeding is the real cost: `applySeed` rebuilds the
//! whole noise stack, measured at ~13x the cost of an entire tile in Part 3b. Hoisting it
//! to world-change time is the actual win, and this crate's [`View::set_world`] is where
//! that happens.
//!
//! What is *not* a win — and was worth measuring rather than assuming — is reducing the
//! number of JS boundary crossings. Generating a 1200x1200 block region at scale 4
//! (147,456 samples) takes ~284 ms as 36 batched `gen_biomes` calls and ~285 ms as 147,456
//! individual `get_biome_at` calls. Identical. Biome generation dominates so completely
//! that per-call overhead is invisible, so "batch to avoid crossings" is not the reason to
//! prefer tiles.
//!
//! The reason to prefer tiles is **caching**: 160,801 warm lookups through this crate take
//! ~7 ms, versus ~1.9 us per sample to regenerate. That is the ~80x, and it needs a cache
//! keyed by some unit — which is what a tile is.
//!
//! One hard constraint shapes the rest: `gen_biomes` writes into **Emscripten's** heap, and
//! this module is a separate `wasm32-unknown-unknown` instance with its own memory. Rust
//! cannot read that buffer directly, so JS must copy it across regardless. Hence the split:
//! JS generates and copies, this crate owns tile math, caching, and lookups.

pub mod cache;
pub mod tiles;

use cache::{Tile, TileCache, World};
use tiles::{TILE_CELLS, TileKey, index_in_tile, tiles_for_viewport};
use wasm_bindgen::prelude::*;

/// Cubiomes' "no biome" sentinel, returned for uncached lookups.
pub const NO_BIOME: i32 = -1;

/// Returned for an uncached height lookup. NaN rather than 0 so an uncached tile cannot be
/// silently meshed as flat terrain at sea level.
pub const NO_HEIGHT: f32 = f32::NAN;

/// View state: the cache plus the world it belongs to.
///
/// JS drives the loop — ask [`View::tiles_to_fetch`] what is missing, generate those tiles
/// with the engine module, feed them back with [`View::store_tile`], then query.
#[wasm_bindgen]
pub struct View {
    cache: TileCache,
}

#[wasm_bindgen]
impl View {
    /// `capacity` is in tiles. At the default 64x64 cells that is ~16KB per tile, so 256
    /// tiles is roughly 4MB — comfortable, and enough for a large viewport plus margin.
    #[wasm_bindgen(constructor)]
    pub fn new(capacity: usize) -> View {
        View {
            cache: TileCache::new(capacity),
        }
    }

    /// Point the view at a world. Returns true if cached tiles were discarded.
    ///
    /// The caller must also call the engine's own `set_world` — this only manages cache
    /// validity. They are separate because the engine module is reached through JS.
    pub fn set_world(&mut self, seed: u64, version: i32, dimension: i32) -> bool {
        self.cache.set_world(World {
            seed,
            version,
            dimension,
        })
    }

    /// Tiles overlapping the viewport that are not yet cached, as a flat
    /// `[tx, tz, tx, tz, ...]` array — flat because returning a `Vec<TileKey>` across the
    /// boundary would need serialisation for no benefit.
    ///
    /// The scale is carried in each key but is uniform for a request, so it is not
    /// repeated in the output.
    pub fn tiles_to_fetch(
        &self,
        min_x: i32,
        min_z: i32,
        max_x: i32,
        max_z: i32,
        scale: i32,
    ) -> Vec<i32> {
        let wanted = tiles_for_viewport(min_x, min_z, max_x, max_z, scale);
        self.cache
            .missing(&wanted)
            .iter()
            .flat_map(|k| [k.tx, k.tz])
            .collect()
    }

    /// Store a generated tile. Both slices must be exactly `TILE_CELLS * TILE_CELLS`.
    ///
    /// Returns false and stores nothing on a length mismatch — a short buffer would
    /// otherwise be read as valid data with garbage past the end. Heights and biomes are
    /// stored together so a mesh can never be shaped by one tile and coloured by another.
    pub fn store_tile(
        &mut self,
        tx: i32,
        tz: i32,
        scale: i32,
        biomes: &[i32],
        heights: &[f32],
    ) -> bool {
        let expected = (TILE_CELLS * TILE_CELLS) as usize;
        if biomes.len() != expected || heights.len() != expected {
            return false;
        }
        self.cache.put(
            TileKey { tx, tz, scale },
            Tile {
                biomes: biomes.to_vec(),
                heights: heights.to_vec(),
            },
        );
        true
    }

    /// Biome id at a block coordinate, or [`NO_BIOME`] if its tile is not cached.
    pub fn biome_at(&mut self, x: i32, z: i32, scale: i32) -> i32 {
        let key = tiles::tile_for_block(x, z, scale);
        let Some(idx) = index_in_tile(&key, x, z) else {
            return NO_BIOME;
        };
        match self.cache.get(&key) {
            Some(t) => t.biomes.get(idx).copied().unwrap_or(NO_BIOME),
            None => NO_BIOME,
        }
    }

    /// Surface height at a block coordinate, or [`NO_HEIGHT`] if its tile is not cached.
    pub fn height_at(&mut self, x: i32, z: i32, scale: i32) -> f32 {
        let key = tiles::tile_for_block(x, z, scale);
        let Some(idx) = index_in_tile(&key, x, z) else {
            return NO_HEIGHT;
        };
        match self.cache.get(&key) {
            Some(t) => t.heights.get(idx).copied().unwrap_or(NO_HEIGHT),
            None => NO_HEIGHT,
        }
    }

    /// A whole tile's biome ids, for meshing. Empty if not cached.
    ///
    /// The renderer needs the full grid at once; point lookups would be the wrong shape
    /// for building geometry.
    pub fn tile_biomes(&mut self, tx: i32, tz: i32, scale: i32) -> Vec<i32> {
        match self.cache.get(&TileKey { tx, tz, scale }) {
            Some(t) => t.biomes.clone(),
            None => Vec::new(),
        }
    }

    /// A whole tile's surface heights, for meshing. Empty if not cached.
    pub fn tile_heights(&mut self, tx: i32, tz: i32, scale: i32) -> Vec<f32> {
        match self.cache.get(&TileKey { tx, tz, scale }) {
            Some(t) => t.heights.clone(),
            None => Vec::new(),
        }
    }

    /// Cells along a tile edge, so JS can size its `gen_biomes` request without hardcoding.
    #[wasm_bindgen(getter)]
    pub fn tile_cells(&self) -> i32 {
        TILE_CELLS
    }

    /// Block coordinate of a tile's north-west corner, as `[x, z]` — what JS passes to
    /// `gen_biomes` as the region origin.
    pub fn tile_origin_block(&self, tx: i32, tz: i32, scale: i32) -> Vec<i32> {
        let (x, z) = TileKey { tx, tz, scale }.origin_block();
        vec![x, z]
    }

    #[wasm_bindgen(getter)]
    pub fn cached_tiles(&self) -> usize {
        self.cache.len()
    }

    #[wasm_bindgen(getter)]
    pub fn hits(&self) -> u64 {
        self.cache.hits
    }

    #[wasm_bindgen(getter)]
    pub fn misses(&self) -> u64 {
        self.cache.misses
    }

    #[wasm_bindgen(getter)]
    pub fn evictions(&self) -> u64 {
        self.cache.evictions
    }
}

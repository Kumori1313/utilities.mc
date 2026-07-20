//! Coordinate and tile math (Part 6).
//!
//! Pure Rust, no `wasm_bindgen`, so `cargo test` exercises it natively without a browser.
//!
//! # Coordinate spaces
//!
//! Three, and conflating them is the bug that ships:
//!
//! - **block** — what a player sees. What the UI takes as input.
//! - **cell** — one biome sample. At `scale` 1 a cell is a block; at `scale` 4 a cell is
//!   4x4 blocks. This is the space Cubiomes' `gen_biomes` indexes.
//! - **tile** — a fixed square of cells, the unit of caching and of one `gen_biomes` call.
//!
//! All conversions floor rather than truncate, for the same reason Part 11 does: block
//! -1 belongs to cell -1, not cell 0.

/// Cells a tile *owns* along one edge. 64 cells at scale 4 is a 256-block square — big
/// enough that per-call overhead is amortised, small enough that a viewport edge does not
/// drag in a large amount of unseen terrain.
pub const TILE_CELLS: i32 = 64;

/// Cells actually *stored* per edge: the owned cells plus a one-cell skirt.
///
/// Mesh vertices sit at cell centres, so n cells span only n-1 quads and adjacent tiles
/// leave a visible one-cell gap you can see through. Storing one extra row and column —
/// duplicating the neighbour's first cells — lets each tile mesh a full TILE_CELLS quads
/// and meet its neighbour exactly. Costs ~3% redundant samples at 64 cells, which is
/// cheaper than any seam-stitching scheme.
pub const TILE_STRIDE: i32 = TILE_CELLS + 1;

/// Identifies one cached tile. `scale` is part of the key because the same tile index at a
/// different scale covers a different area entirely — omitting it would serve 4x-offset
/// data from the cache.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct TileKey {
    pub tx: i32,
    pub tz: i32,
    pub scale: i32,
}

impl TileKey {
    /// Cell coordinate of the tile's north-west corner.
    pub fn origin_cell(&self) -> (i32, i32) {
        (self.tx * TILE_CELLS, self.tz * TILE_CELLS)
    }

    /// Block coordinate of the tile's north-west corner.
    pub fn origin_block(&self) -> (i32, i32) {
        let (cx, cz) = self.origin_cell();
        (cx * self.scale, cz * self.scale)
    }

    /// Side length in blocks.
    pub fn span_blocks(&self) -> i32 {
        TILE_CELLS * self.scale
    }

    /// Does this tile contain the given block coordinate?
    pub fn contains_block(&self, x: i32, z: i32) -> bool {
        let (ox, oz) = self.origin_block();
        let span = self.span_blocks();
        x >= ox && x < ox + span && z >= oz && z < oz + span
    }
}

/// Block -> cell. Floors, so negative coordinates land in the correct cell.
pub fn block_to_cell(v: i32, scale: i32) -> i32 {
    debug_assert!(
        scale == 1 || scale == 4,
        "scale must be 1 or 4, got {scale}"
    );
    v.div_euclid(scale)
}

/// Cell -> tile index. Floors.
pub fn cell_to_tile(v: i32) -> i32 {
    v.div_euclid(TILE_CELLS)
}

/// The tile containing a block coordinate.
pub fn tile_for_block(x: i32, z: i32, scale: i32) -> TileKey {
    TileKey {
        tx: cell_to_tile(block_to_cell(x, scale)),
        tz: cell_to_tile(block_to_cell(z, scale)),
        scale,
    }
}

/// Index into a tile's cell buffer for a block coordinate, or `None` if outside.
///
/// Row-major with the skirt included, so the stride is [`TILE_STRIDE`], not [`TILE_CELLS`].
/// Lookups only ever address owned cells (0..TILE_CELLS); the skirt exists for meshing.
pub fn index_in_tile(key: &TileKey, x: i32, z: i32) -> Option<usize> {
    if !key.contains_block(x, z) {
        return None;
    }
    let (ocx, ocz) = key.origin_cell();
    let ix = block_to_cell(x, key.scale) - ocx;
    let iz = block_to_cell(z, key.scale) - ocz;
    Some((iz * TILE_STRIDE + ix) as usize)
}

/// Every tile overlapping an axis-aligned block-space viewport, in row-major order.
///
/// `max` is inclusive, so a 1x1 viewport still yields the tile under it.
pub fn tiles_for_viewport(
    min_x: i32,
    min_z: i32,
    max_x: i32,
    max_z: i32,
    scale: i32,
) -> Vec<TileKey> {
    let (min_x, max_x) = (min_x.min(max_x), min_x.max(max_x));
    let (min_z, max_z) = (min_z.min(max_z), min_z.max(max_z));

    let t0 = tile_for_block(min_x, min_z, scale);
    let t1 = tile_for_block(max_x, max_z, scale);

    let mut out = Vec::new();
    for tz in t0.tz..=t1.tz {
        for tx in t0.tx..=t1.tx {
            out.push(TileKey { tx, tz, scale });
        }
    }
    out
}

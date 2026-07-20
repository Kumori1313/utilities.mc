//! Part 6 tile-math tests. Native, no browser — the point of keeping this logic free of
//! `wasm_bindgen`.

use app::tiles::{
    TILE_CELLS, TileKey, block_to_cell, cell_to_tile, index_in_tile, tile_for_block,
    tiles_for_viewport,
};

/// Same failure mode as Part 11: `/` truncates toward zero, so block -1 would land in
/// cell 0 and be read from the wrong tile.
#[test]
fn block_to_cell_floors_on_negatives() {
    assert_eq!(block_to_cell(0, 4), 0);
    assert_eq!(block_to_cell(3, 4), 0);
    assert_eq!(block_to_cell(4, 4), 1);
    assert_eq!(block_to_cell(-1, 4), -1, "must floor, not truncate");
    assert_eq!(block_to_cell(-4, 4), -1);
    assert_eq!(block_to_cell(-5, 4), -2);

    for v in -200..200i32 {
        assert_eq!(
            block_to_cell(v, 4),
            (v as f64 / 4.0).floor() as i32,
            "v={v}"
        );
        assert_eq!(block_to_cell(v, 1), v, "scale 1 is identity");
    }
}

#[test]
fn cell_to_tile_floors_on_negatives() {
    assert_eq!(cell_to_tile(0), 0);
    assert_eq!(cell_to_tile(TILE_CELLS - 1), 0);
    assert_eq!(cell_to_tile(TILE_CELLS), 1);
    assert_eq!(cell_to_tile(-1), -1, "must floor");
    assert_eq!(cell_to_tile(-TILE_CELLS), -1);
    assert_eq!(cell_to_tile(-TILE_CELLS - 1), -2);
}

/// Scale belongs in the key: the same tile index at scale 1 and scale 4 covers different
/// ground, so a scale-blind cache would serve data offset by 4x.
#[test]
fn scale_is_part_of_tile_identity() {
    let a = TileKey {
        tx: 1,
        tz: 1,
        scale: 1,
    };
    let b = TileKey {
        tx: 1,
        tz: 1,
        scale: 4,
    };
    assert_ne!(a, b);
    assert_ne!(a.origin_block(), b.origin_block());
    assert_eq!(a.span_blocks(), TILE_CELLS);
    assert_eq!(b.span_blocks(), TILE_CELLS * 4);
}

/// Every block in a tile must map to a distinct in-bounds index, and every index must be
/// reachable. An off-by-one here silently mixes up neighbouring biomes.
#[test]
fn tile_indices_are_a_bijection() {
    for scale in [1, 4] {
        for &(tx, tz) in &[(0, 0), (-1, -1), (3, -2), (-5, 7)] {
            let key = TileKey { tx, tz, scale };
            let (ox, oz) = key.origin_block();
            let span = key.span_blocks();
            let mut seen = vec![false; (TILE_CELLS * TILE_CELLS) as usize];

            for bz in (oz..oz + span).step_by(scale as usize) {
                for bx in (ox..ox + span).step_by(scale as usize) {
                    let idx = index_in_tile(&key, bx, bz)
                        .unwrap_or_else(|| panic!("({bx},{bz}) outside {key:?}"));
                    assert!(!seen[idx], "index {idx} produced twice in {key:?}");
                    seen[idx] = true;
                    assert_eq!(tile_for_block(bx, bz, scale), key, "tile disagreement");
                }
            }
            assert!(
                seen.iter().all(|&s| s),
                "some indices unreachable in {key:?}"
            );
        }
    }
}

#[test]
fn blocks_outside_a_tile_have_no_index() {
    let key = TileKey {
        tx: 0,
        tz: 0,
        scale: 4,
    };
    let span = key.span_blocks();
    assert!(index_in_tile(&key, -1, 0).is_none());
    assert!(index_in_tile(&key, 0, -1).is_none());
    assert!(index_in_tile(&key, span, 0).is_none());
    assert!(index_in_tile(&key, 0, span).is_none());
    assert!(index_in_tile(&key, 0, 0).is_some());
    assert!(index_in_tile(&key, span - 1, span - 1).is_some());
}

#[test]
fn viewport_covers_every_block_it_spans() {
    let (min_x, min_z, max_x, max_z, scale) = (-300, -50, 700, 400, 4);
    let tiles = tiles_for_viewport(min_x, min_z, max_x, max_z, scale);
    assert!(!tiles.is_empty());

    // Every corner and a sample of interior points must fall inside some returned tile.
    for &(x, z) in &[
        (min_x, min_z),
        (max_x, max_z),
        (min_x, max_z),
        (max_x, min_z),
        (0, 0),
        (123, -7),
    ] {
        assert!(
            tiles.iter().any(|t| t.contains_block(x, z)),
            "({x},{z}) not covered"
        );
    }
    // And no duplicates.
    let mut sorted = tiles.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        tiles.len(),
        "viewport returned duplicate tiles"
    );
}

#[test]
fn viewport_handles_inverted_and_degenerate_bounds() {
    // Inverted bounds should be normalised, not return nothing.
    let a = tiles_for_viewport(100, 100, -100, -100, 4);
    let b = tiles_for_viewport(-100, -100, 100, 100, 4);
    assert_eq!(a, b, "inverted bounds must normalise");

    // A zero-area viewport still needs the tile under it.
    let single = tiles_for_viewport(5, 5, 5, 5, 4);
    assert_eq!(single.len(), 1);
    assert!(single[0].contains_block(5, 5));
}

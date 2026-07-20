//! Part 10.3 checks against the Minecraft Wiki's published level-range tables.
//!
//! These ranges are an independent artifact — derived from the game's observed behaviour
//! rather than from the formula we implemented — so they catch structural errors (wrong
//! seeding, a missing floor, an off-by-one in the slot arithmetic) that a self-consistent
//! reimplementation would otherwise sail through.
//!
//! Source: minecraft.wiki "Enchanting table mechanics", revision 2754638 (2024-11-19),
//! which falls inside the 1.21.3 window this project pins to.

use enchant::{offered_levels, raw_levels};

/// Published (min, max) of each slot's raw level, indexed by bookshelf count 0..=15.
const TOP: [(i32, i32); 16] = [
    (1, 2),
    (1, 3),
    (1, 3),
    (1, 4),
    (1, 4),
    (1, 5),
    (1, 5),
    (1, 6),
    (1, 6),
    (1, 7),
    (2, 7),
    (2, 8),
    (2, 8),
    (2, 9),
    (2, 9),
    (2, 10),
];
const MIDDLE: [(i32, i32); 16] = [
    (1, 6),
    (1, 7),
    (2, 8),
    (2, 9),
    (3, 10),
    (3, 11),
    (3, 12),
    (3, 13),
    (4, 14),
    (4, 15),
    (5, 16),
    (5, 17),
    (5, 18),
    (5, 19),
    (6, 20),
    (6, 21),
];
const BOTTOM: [(i32, i32); 16] = [
    (1, 8),
    (2, 9),
    (4, 11),
    (6, 12),
    (8, 14),
    (10, 15),
    (12, 17),
    (14, 18),
    (16, 20),
    (18, 21),
    (20, 23),
    (22, 24),
    (24, 26),
    (26, 27),
    (28, 29),
    (30, 30),
];

/// Wide enough that every extreme of the distribution is actually reached; a narrow sweep
/// would pass simply by never sampling the ends.
const SEEDS: i32 = 300_000;

#[test]
fn raw_levels_match_published_ranges() {
    for b in 0..=15usize {
        let mut observed = [(i32::MAX, i32::MIN); 3];
        for s in 0..SEEDS {
            let lv = raw_levels(s, b as i32);
            for i in 0..3 {
                observed[i].0 = observed[i].0.min(lv[i]);
                observed[i].1 = observed[i].1.max(lv[i]);
            }
        }
        for (i, expected) in [TOP[b], MIDDLE[b], BOTTOM[b]].iter().enumerate() {
            assert_eq!(
                observed[i], *expected,
                "bookshelves={b} slot={i}: observed range {:?} but wiki publishes {:?}",
                observed[i], expected
            );
        }
    }
}

/// The guide's two sanity checks, stated as executable assertions.
#[test]
fn trivial_cases_hold() {
    // b=0 must never offer anything near 30 in the bottom slot.
    let worst = (0..SEEDS).map(|s| offered_levels(s, 0)[2]).max().unwrap();
    assert_eq!(
        worst, 8,
        "with no bookshelves the bottom slot must top out at 8"
    );

    // b=15 must offer exactly 30 in the bottom slot, always.
    for s in 0..SEEDS {
        assert_eq!(
            offered_levels(s, 15)[2],
            30,
            "seed {s}: 15 shelves must offer 30"
        );
    }
}

/// Slot n is only offered when its level reaches n+1; below that the game shows nothing.
#[test]
fn low_levels_are_zeroed_per_slot() {
    let mut zeroed = [0u32; 3];
    for s in 0..SEEDS {
        let raw = raw_levels(s, 0);
        let shown = offered_levels(s, 0);
        for i in 0..3 {
            if raw[i] < i as i32 + 1 {
                assert_eq!(shown[i], 0, "seed {s} slot {i}: raw {} should zero", raw[i]);
                zeroed[i] += 1;
            } else {
                assert_eq!(shown[i], raw[i], "seed {s} slot {i}: should pass through");
            }
        }
    }
    // Slot 0 can never be zeroed: max(base/3, 1) >= 1 always.
    assert_eq!(zeroed[0], 0, "top slot should never be zeroed");
    assert!(
        zeroed[1] > 0,
        "middle slot must sometimes be empty at 0 bookshelves"
    );
    assert!(
        zeroed[2] > 0,
        "bottom slot must sometimes be empty at 0 bookshelves"
    );
}

/// Bookshelves above 15 have no additional effect.
#[test]
fn bookshelves_are_clamped() {
    for s in 0..2_000 {
        let at15 = offered_levels(s, 15);
        for extra in [16, 30, 100, i32::MAX] {
            assert_eq!(
                offered_levels(s, extra),
                at15,
                "seed {s}: {extra} shelves != 15"
            );
        }
        assert_eq!(
            offered_levels(s, -5),
            offered_levels(s, 0),
            "negative should clamp to 0"
        );
    }
}

/// Pins the seeding regime. If someone "fixes" this to re-seed per slot from
/// `xp_seed + slot` (as the build guide's snippet does), slots 1 and 2 change while slot 0
/// stays put — the exact signature of that bug.
#[test]
fn slots_share_one_stream_seeded_once() {
    use enchant::JavaRandom;
    let (xp_seed, b) = (12345, 10);

    let mut r = JavaRandom::new(xp_seed as i64);
    let mut sequential = [0i32; 3];
    for (slot, cell) in sequential.iter_mut().enumerate() {
        let base = r.next_int_bound(8) + 1 + (b >> 1) + r.next_int_bound(b + 1);
        *cell = match slot {
            0 => (base / 3).max(1),
            1 => base * 2 / 3 + 1,
            _ => base.max(b * 2),
        };
    }
    assert_eq!(
        raw_levels(xp_seed, b),
        sequential,
        "must draw from one continuous stream"
    );

    // And confirm the per-slot re-seeding actually differs, so this test has teeth.
    let mut reseeded = [0i32; 3];
    for (slot, cell) in reseeded.iter_mut().enumerate() {
        let mut r = JavaRandom::new(xp_seed as i64 + slot as i64);
        let base = r.next_int_bound(8) + 1 + (b >> 1) + r.next_int_bound(b + 1);
        *cell = match slot {
            0 => (base / 3).max(1),
            1 => base * 2 / 3 + 1,
            _ => base.max(b * 2),
        };
    }
    assert_ne!(
        reseeded, sequential,
        "the two seeding regimes must be distinguishable"
    );
}

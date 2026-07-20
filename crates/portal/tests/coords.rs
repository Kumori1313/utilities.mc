//! Part 11.1 tests.
//!
//! The whole risk in this feature is negative coordinates, so the north-west quadrant gets
//! the attention. A converter that only ever sees +X/+Z passes a naive test suite while
//! being wrong in three quadrants out of four.

use portal::coords::{BORDER_MAX, BORDER_MIN};
use portal::{convert_y, nether_to_overworld, overworld_to_nether};

#[test]
fn guide_worked_examples() {
    assert_eq!(overworld_to_nether(0, 0), (0, 0));
    assert_eq!(overworld_to_nether(8, 8), (1, 1));
    assert_eq!(overworld_to_nether(-8, -8), (-1, -1));
    // The two that truncation gets wrong:
    assert_eq!(overworld_to_nether(-1, -1), (-1, -1), "floor, not truncate");
    assert_eq!(overworld_to_nether(-9, -9), (-2, -2), "floor, not truncate");
}

/// Pins the exact bug the guide names: `/` truncates toward zero and would give -1 here.
#[test]
fn negative_division_floors_rather_than_truncates() {
    for x in -64..0i32 {
        let expected = (x as f64 / 8.0).floor() as i32;
        assert_eq!(
            overworld_to_nether(x, x),
            (expected, expected),
            "x={x}: must floor"
        );
        // And demonstrate the wrong answer really is different, so this test has teeth.
        if x % 8 != 0 {
            assert_ne!(
                overworld_to_nether(x, x).0,
                x / 8,
                "x={x}: truncation and flooring must differ here"
            );
        }
    }
}

#[test]
fn all_four_quadrants_at_large_magnitude() {
    for &(x, z) in &[
        (1_000_003, 2_000_005),
        (-1_000_003, 2_000_005),
        (1_000_003, -2_000_005),
        (-1_000_003, -2_000_005),
    ] {
        let (nx, nz) = overworld_to_nether(x, z);
        assert_eq!(nx, (x as f64 / 8.0).floor() as i32, "x={x}");
        assert_eq!(nz, (z as f64 / 8.0).floor() as i32, "z={z}");
    }
}

#[test]
fn nether_to_overworld_scales_by_eight() {
    assert_eq!(nether_to_overworld(0, 0), (0, 0));
    assert_eq!(nether_to_overworld(1, 1), (8, 8));
    assert_eq!(nether_to_overworld(-1, -1), (-8, -8));
    assert_eq!(nether_to_overworld(-2, 3), (-16, 24));
}

/// Round-tripping Nether -> Overworld -> Nether is exact, because the multiply lands on a
/// multiple of 8. The reverse is lossy and deliberately not asserted.
#[test]
fn nether_overworld_nether_round_trips() {
    for n in -5_000..5_000i32 {
        let (ox, oz) = nether_to_overworld(n, -n);
        assert_eq!(overworld_to_nether(ox, oz), (n, -n), "n={n}");
    }
}

/// 8 * i32::MAX overflows i32; a debug build would panic and release would wrap to a
/// coordinate on the opposite side of the world.
#[test]
fn extreme_inputs_clamp_to_the_world_border_without_overflowing() {
    assert_eq!(
        nether_to_overworld(i32::MAX, i32::MAX),
        (BORDER_MAX, BORDER_MAX)
    );
    assert_eq!(
        nether_to_overworld(i32::MIN, i32::MIN),
        (BORDER_MIN, BORDER_MIN)
    );

    // Just inside the point where clamping starts to bite (3_749_998 * 8 < BORDER_MAX).
    let (x, _) = nether_to_overworld(3_749_997, 0);
    assert_eq!(x, 29_999_976, "should not be clamped yet");
    let (x, _) = nether_to_overworld(4_000_000, 0);
    assert_eq!(x, BORDER_MAX, "should be clamped");
}

#[test]
fn y_is_never_scaled() {
    for y in [-64, 0, 63, 64, 128, 255, 319] {
        assert_eq!(convert_y(y), y);
    }
}

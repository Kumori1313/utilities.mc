//! Overworld <-> Nether coordinate conversion (Part 11.1).
//!
//! One Nether block is eight Overworld blocks, **horizontally only**. Y is never scaled,
//! in either direction. Y clamping is a portal-*placement* rule and lives in
//! [`crate::linking`], deliberately not here.

/// Horizontal scale factor between the dimensions.
pub const SCALE: i32 = 8;

/// Overworld world-border limits, inclusive. The game constrains the converted X/Z to
/// these, which only bites when travelling Nether -> Overworld beyond +/-3,749,998 in the
/// Nether (3_749_998 * 8 is just under the border).
pub const BORDER_MAX: i32 = 29_999_983;
pub const BORDER_MIN: i32 = -29_999_984;

/// Overworld -> Nether. Divides by 8, **flooring**.
///
/// `div_euclid`, not `/`. Rust's `/` truncates toward zero, so `-9 / 8 == -1` where block
/// space needs `-2`. Truncation gives a converter that is correct in the +X/+Z quadrant
/// and wrong in the other three — the classic way this tool ships broken.
pub fn overworld_to_nether(x: i32, z: i32) -> (i32, i32) {
    (x.div_euclid(SCALE), z.div_euclid(SCALE))
}

/// Nether -> Overworld. Multiplies by 8 and clamps to the world border.
///
/// Uses i64 internally: 8 * i32::MAX overflows i32, and a debug build would panic while
/// release silently wrapped to a coordinate on the far side of the world.
pub fn nether_to_overworld(x: i32, z: i32) -> (i32, i32) {
    let scale = |v: i32| -> i32 {
        (v as i64 * SCALE as i64).clamp(BORDER_MIN as i64, BORDER_MAX as i64) as i32
    };
    (scale(x), scale(z))
}

/// Y is identical in both dimensions. Provided so callers do not have to remember that,
/// and so the absence of scaling is visible at the call site.
pub fn convert_y(y: i32) -> i32 {
    y
}

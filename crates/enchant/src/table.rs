//! Offered levels — the three numbers on the enchanting table's slots (Part 10.3).
//!
//! # Deviation from the build guide
//!
//! The guide's 10.3 snippet is wrong in two ways, both verified against the Minecraft
//! Wiki's pinned 1.21.3-era revision and against Earthcomputer/EnchantmentCracker:
//!
//! 1. **Seeding.** The guide re-seeds per slot from `xp_seed + slot` and states this
//!    emphatically. That is 10.4's behaviour, not 10.3's. The offered levels come from a
//!    stream seeded **once** with `xp_seed`, with the three slots drawing sequentially —
//!    EnchantmentCracker's caller carries the comment "Important they're done in a row
//!    like this because RNG is not reset in between". Re-seeding per slot gives three
//!    plausible-looking but wrong numbers.
//! 2. **Slot 0 floor.** The guide computes `base / 3`; the game computes
//!    `max(base / 3, 1)`. Without the floor, low `base` yields 0 in the top slot where
//!    the game shows 1.
//!
//! Both are the sort of error that still produces believable output, which is why the
//! published level-range tables are checked in `tests/table.rs` rather than trusted.
//!
//! # Version audit (Part 13.4)
//!
//! Version-independent across the 1.8.9+ floor, so this takes no version argument. The whole
//! 3-slot / xp-seed / bookshelf system arrived in 1.8 (`14w02a`) and the wiki records no
//! formula change since; the bookshelf cap of 15 dates to 1.3.1, below the floor. If the
//! calculator's floor is ever lowered below 1.8, this is one of the rules that would need a
//! second, structurally different implementation rather than a parameter tweak.

use crate::JavaRandom;

/// Bookshelf count is capped at 15 by the game regardless of how many are placed.
pub const MAX_BOOKSHELVES: i32 = 15;

/// Slot levels *before* the "slot n requires level >= n+1" rule zeroes them.
///
/// Exposed because the wiki's published level ranges describe these raw values; the
/// zeroing is a separate display rule applied on top.
pub fn raw_levels(xp_seed: i32, bookshelves: i32) -> [i32; 3] {
    let b = bookshelves.clamp(0, MAX_BOOKSHELVES);

    // Seeded ONCE. All three slots draw from this single stream, in order.
    let mut r = JavaRandom::new(xp_seed as i64);

    let mut out = [0i32; 3];
    for (slot, cell) in out.iter_mut().enumerate() {
        let base = r.next_int_bound(8) + 1 + (b >> 1) + r.next_int_bound(b + 1);
        *cell = match slot {
            0 => (base / 3).max(1),
            1 => base * 2 / 3 + 1,
            _ => base.max(b * 2),
        };
    }
    out
}

/// The three levels as displayed by the enchanting table.
///
/// A slot showing 0 is not offered: slot *n* requires a level of at least *n+1*, so the
/// middle and bottom slots go empty at low bookshelf counts.
///
/// Assumes an enchantable item. The game skips this computation entirely for items with
/// zero enchantability, so it does not consume RNG for them.
pub fn offered_levels(xp_seed: i32, bookshelves: i32) -> [i32; 3] {
    let mut out = raw_levels(xp_seed, bookshelves);
    for (slot, cell) in out.iter_mut().enumerate() {
        if *cell < slot as i32 + 1 {
            *cell = 0;
        }
    }
    out
}

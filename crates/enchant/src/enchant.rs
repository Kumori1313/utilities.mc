//! Rolling the actual enchantments for a slot (Part 10.4).
//!
//! # Deviations from the build guide
//!
//! The guide's 10.4 sketch differs from the game in four ways. All were checked against
//! Earthcomputer/EnchantmentCracker's `addRandomEnchantments`, which mirrors vanilla's
//! `EnchantmentHelper.selectEnchantment`.
//!
//! 1. **Loop order.** The guide halves the level at the *top* of the loop, before the
//!    continue-roll. The game rolls first against the *current* level and halves at the
//!    *end*. The guide's order makes the first extra enchantment far less likely than it
//!    should be.
//! 2. **Candidate collection.** The guide says to collect "every `(enchantment, level)`
//!    candidate" whose window contains the level. The game takes at most **one** candidate
//!    per enchantment — the highest level that fits — which changes the weighted draw,
//!    since a multi-level enchantment would otherwise get its weight counted repeatedly.
//! 3. **The ±15% bonus.** The guide computes `round(level * (1 + f))`. The game computes
//!    `level + round(level * f)`. These agree at the precisions involved here, but the
//!    game's form is used to keep the arithmetic bit-exact by construction rather than by
//!    argument.
//! 4. **Books.** The guide notes books accept more enchantments but omits that after
//!    rolling, a book with more than one enchantment has one removed at random. That draw
//!    consumes RNG, so omitting it desyncs everything after it.

use crate::JavaRandom;
use crate::data::{ENCHANTMENTS, EnchantmentData, enchantability};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Roll {
    /// Index into [`ENCHANTMENTS`].
    pub enchantment: usize,
    pub level: i32,
}

impl Roll {
    pub fn data(&self) -> &'static EnchantmentData {
        &ENCHANTMENTS[self.enchantment]
    }

    pub fn name(&self) -> &'static str {
        self.data().name
    }
}

/// Java's `Math.round(float)`, defined as `floor(x + 0.5)`.
///
/// Rust's `f32::round` rounds half away from zero, which agrees only for positive values.
/// Spelling out Java's definition avoids depending on that coincidence.
fn java_round(x: f32) -> i32 {
    (x + 0.5).floor() as i32
}

/// Applies the enchantability modifier and the triangular ±15% bonus.
///
/// The two `next_float` calls are **separate draws** — that is what makes the bonus
/// triangular rather than uniform. Summing one doubled draw would be uniform and wrong.
fn modify_level(r: &mut JavaRandom, level: i32, ench: i32) -> i32 {
    let level = level + 1 + r.next_int_bound(ench / 4 + 1) + r.next_int_bound(ench / 4 + 1);
    let pct = (r.next_float() + r.next_float() - 1.0) * 0.15;
    let level = level + java_round(level as f32 * pct);
    level.max(1)
}

/// Every enchantment a table could roll onto `item` whose cost window contains `level`,
/// at the highest level that fits — at most one entry per enchantment.
///
/// Two gates beyond the cost window, both of which produce plausible-looking but wrong
/// output if missed:
///
/// - `in_enchanting_table`: 7 of the 42 enchantments (mending, frost_walker, soul_speed,
///   swift_sneak, wind_burst, and the two curses) are never table-obtainable. Filtering
///   only on item applicability rolls them anyway, since they still declare item tags.
/// - Books accept **any** table enchantment regardless of item applicability — vanilla's
///   check is `isPrimaryItem(stack) || stack.is(Items.BOOK)`. Without the bypass a book
///   matches nothing at all and rolls empty.
fn candidates(item: &str, level: i32) -> Vec<Roll> {
    let is_book = item == "book";
    let mut out = Vec::new();
    for (i, e) in ENCHANTMENTS.iter().enumerate() {
        if !e.in_enchanting_table {
            continue;
        }
        if !is_book && !e.applies_to(item) {
            continue;
        }
        for lv in (1..=e.max_level).rev() {
            if level >= e.min_cost(lv) && level <= e.max_cost(lv) {
                out.push(Roll {
                    enchantment: i,
                    level: lv,
                });
                break; // highest fitting level only
            }
        }
    }
    out
}

/// Java's `WeightedRandom.getRandomItem`: draw in `[0, total)`, then walk subtracting.
fn weighted_pick(r: &mut JavaRandom, pool: &[Roll]) -> Option<Roll> {
    let total: i32 = pool.iter().map(|c| c.data().weight).sum();
    if total <= 0 {
        return None;
    }
    let mut w = r.next_int_bound(total);
    for c in pool {
        w -= c.data().weight;
        if w < 0 {
            return Some(*c);
        }
    }
    None
}

fn compatible(a: usize, b: usize) -> bool {
    a != b && !ENCHANTMENTS[a].exclusive_with.contains(&b)
}

/// Roll the enchantments a table slot would produce.
///
/// `level` is the slot's offered level from [`crate::offered_levels`]. Returns an empty
/// list if the item is unknown or has zero enchantability, matching the game's early-out.
pub fn enchantments_in_slot(xp_seed: i32, slot: usize, item: &str, level: i32) -> Vec<Roll> {
    let Some(ench) = enchantability(item) else {
        return Vec::new();
    };
    if ench <= 0 {
        return Vec::new();
    }

    // Unlike the offered levels, the roll DOES re-seed per slot — this is the
    // `xp_seed + slot` seeding the guide mistakenly applied to 10.3 as well.
    let mut r = JavaRandom::new(xp_seed as i64 + slot as i64);

    let mut level = modify_level(&mut r, level, ench);
    let mut pool = candidates(item, level);
    let mut picked: Vec<Roll> = Vec::new();

    if pool.is_empty() {
        return picked;
    }
    if let Some(first) = weighted_pick(&mut r, &pool) {
        picked.push(first);
    }

    // Roll against the CURRENT level, then halve at the end — not the other way round.
    while r.next_int_bound(50) <= level {
        if let Some(last) = picked.last() {
            let last_idx = last.enchantment;
            pool.retain(|c| compatible(c.enchantment, last_idx));
        }
        if pool.is_empty() {
            break;
        }
        match weighted_pick(&mut r, &pool) {
            Some(next) => picked.push(next),
            None => break,
        }
        level /= 2;
    }

    // A book with multiple enchantments loses one at random. This draw consumes RNG.
    if item == "book" && picked.len() > 1 {
        let drop = r.next_int_bound(picked.len() as i32) as usize;
        picked.remove(drop);
    }

    picked
}

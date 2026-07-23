//! Anvil combine-cost calculator (Part 10.6).
//!
//! Fully deterministic — no `JavaRandom`, no xp seed. Combining is integer arithmetic over
//! the same 10.2 data tables, so it is far easier to make bit-exact than the table roll and
//! its results can be cross-checked directly against the level cost an in-game anvil shows.
//!
//! # Constants, and how they were pinned
//!
//! The one dangerous constant is the per-enchantment cost multiplier. Our data's `anvil_cost`
//! is the **item** multiplier; a book's is half. This direction is verified, not assumed:
//! the Minecraft Wiki states fire_aspect costs "4x from item but 2x from book", and our
//! `anvil_cost` for fire_aspect is 4. Getting it backwards makes every book combine ~4x off.
//!
//! # Scope
//!
//! Models enchantment merging + renaming. It does **not** model material repair (e.g.
//! combining a tool with its raw material) or durability repair, which add their own costs —
//! those are out of scope for an enchantment planner.

use crate::data::EnchantmentData;

/// Survival anvils refuse an operation costing more than this many levels.
pub const TOO_EXPENSIVE_LIMIT: i32 = 39;

/// One item entering the anvil: what it is, how many times it has been worked, and its
/// enchantments as (enchantment index, level) pairs.
#[derive(Clone, Debug)]
pub struct AnvilItem {
    /// Item id (e.g. "diamond_sword") or "book" / "enchanted_book".
    pub item: String,
    /// Number of prior anvil operations on this item. The stored penalty is `2^work - 1`.
    pub prior_work: u32,
    /// (index into [`ENCHANTMENTS`], level).
    pub enchantments: Vec<(usize, i32)>,
}

impl AnvilItem {
    pub fn new(item: &str, prior_work: u32, enchantments: Vec<(usize, i32)>) -> Self {
        Self {
            item: item.to_string(),
            prior_work,
            enchantments,
        }
    }

    pub fn is_book(&self) -> bool {
        self.item == "book" || self.item == "enchanted_book"
    }

    /// `2^work - 1` — the penalty this item contributes to a combine, and what it stores.
    pub fn prior_work_penalty(&self) -> i32 {
        (1i64 << self.prior_work.min(31)) as i32 - 1
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CombineResult {
    /// Total level cost of the operation, prior-work penalty included.
    pub cost: i32,
    /// True if a survival anvil would refuse it (cost > [`TOO_EXPENSIVE_LIMIT`]). Creative
    /// ignores the cap, so this is advisory, not an error.
    pub too_expensive: bool,
    /// The resulting item's enchantments.
    pub result: Vec<(usize, i32)>,
    /// The resulting item's prior-work count, for chaining further combines.
    pub result_prior_work: u32,
}

/// Book cost multiplier for an enchantment: half the item multiplier, floored, min 1.
///
/// For the values that occur (1, 2, 4, 8) this reproduces the legacy rarity pairs exactly:
/// item 1/2/4/8 -> book 1/1/2/4.
pub fn book_cost_multiplier(anvil_cost: i32) -> i32 {
    (anvil_cost / 2).max(1)
}

/// How many enchantments already present conflict with `ench`. Normally 0 or 1, since
/// conflicting enchantments form mutually-exclusive groups a valid item holds one of — but
/// the anvil charges "+1 per incompatible enchantment on the target", so count rather than
/// flag.
fn conflict_count(table: &[EnchantmentData], ench: usize, present: &[(usize, i32)]) -> i32 {
    present
        .iter()
        .filter(|&&(other, _)| other != ench && table[ench].exclusive_with.contains(&other))
        .count() as i32
}

fn applies_to(table: &[EnchantmentData], ench: usize, target: &AnvilItem) -> bool {
    // A book target accepts any enchantment. Otherwise the enchantment must support the
    // item type — the broad `supported_items`, not the table-only `primary_items`.
    target.is_book() || table[ench].supported_items.contains(&target.item.as_str())
}

/// Combine `sacrifice` into `target`, optionally renaming. `target` keeps its form; the
/// sacrifice's enchantments transfer onto it. Enchantment indices in both items are scoped
/// to `table`.
///
/// Cost = both items' prior-work penalties + per-enchantment costs + 1 per incompatible
/// sacrifice enchantment + 1 if renamed.
pub fn combine(
    table: &[EnchantmentData],
    target: &AnvilItem,
    sacrifice: &AnvilItem,
    rename: bool,
) -> CombineResult {
    let mut cost = target.prior_work_penalty() + sacrifice.prior_work_penalty();
    if rename {
        cost += 1;
    }

    let mut result = target.enchantments.clone();

    for &(ench, slvl) in &sacrifice.enchantments {
        // An enchantment the target item cannot hold is simply not transferred, at no cost
        // — unless the target is a book, which holds anything.
        if !applies_to(table, ench, target) {
            continue;
        }

        // Incompatible with something already on the result: not applied, +1 per conflict.
        let conflicts = conflict_count(table, ench, &result);
        if conflicts > 0 {
            cost += conflicts;
            continue;
        }

        let max = table[ench].max_level;
        let existing = result.iter().position(|&(e, _)| e == ench);
        let tlvl = existing.map(|i| result[i].1).unwrap_or(0);

        // Equal and below max -> +1 level; otherwise the higher of the two. Capped at max.
        let new_level = if tlvl == slvl && slvl < max {
            slvl + 1
        } else {
            tlvl.max(slvl)
        }
        .min(max);

        let mult = if sacrifice.is_book() {
            book_cost_multiplier(table[ench].anvil_cost)
        } else {
            table[ench].anvil_cost
        };
        cost += new_level * mult;

        match existing {
            Some(i) => result[i].1 = new_level,
            None => result.push((ench, new_level)),
        }
    }

    CombineResult {
        cost,
        too_expensive: cost > TOO_EXPENSIVE_LIMIT,
        result,
        // Only the higher input penalty counts; the result is worked once more.
        result_prior_work: target.prior_work.max(sacrifice.prior_work) + 1,
    }
}

/// Fold a list of sacrifices into a target left to right, summing cost. Returns the total
/// and the final item. Order matters: prior-work penalty compounds, so a different order
/// can cost differently — see [`cheapest_linear_order`].
pub fn combine_sequence(
    table: &[EnchantmentData],
    target: &AnvilItem,
    sacrifices: &[AnvilItem],
) -> (i32, AnvilItem) {
    let mut current = target.clone();
    let mut total = 0;
    for s in sacrifices {
        let r = combine(table, &current, s, false);
        total += r.cost;
        current = AnvilItem {
            item: current.item,
            prior_work: r.result_prior_work,
            enchantments: r.result,
        };
    }
    (total, current)
}

/// Cheapest order to apply all `sacrifices` to `target` as a **linear chain**, by trying
/// every permutation. Exhaustive, so keep the list small (<= 8 or so).
///
/// Known limitation, deliberately surfaced rather than hidden: this searches linear orders
/// only. A balanced binary combine (merge books into books first, then onto the tool) can
/// sometimes beat every linear order because prior-work penalty grows with depth. This
/// finds the best *chain*, which is what a player adding items one at a time actually does,
/// and never claims more.
pub fn cheapest_linear_order(
    table: &[EnchantmentData],
    target: &AnvilItem,
    sacrifices: &[AnvilItem],
) -> (i32, Vec<usize>) {
    let n = sacrifices.len();
    let mut idx: Vec<usize> = (0..n).collect();
    let mut best_cost = i32::MAX;
    let mut best_order = idx.clone();

    permute(&mut idx, 0, &mut |order| {
        let seq: Vec<AnvilItem> = order.iter().map(|&i| sacrifices[i].clone()).collect();
        let (cost, _) = combine_sequence(table, target, &seq);
        if cost < best_cost {
            best_cost = cost;
            best_order = order.to_vec();
        }
    });

    (best_cost, best_order)
}

fn permute(a: &mut [usize], k: usize, f: &mut impl FnMut(&[usize])) {
    if k == a.len() {
        f(a);
        return;
    }
    for i in k..a.len() {
        a.swap(k, i);
        permute(a, k + 1, f);
        a.swap(k, i);
    }
}

//! Part 10.6 anvil tests.
//!
//! Every expected number here is hand-derived from the documented rules (prior-work penalty
//! 2^n-1 on both inputs, per-enchantment cost = level x multiplier, book multiplier = half
//! the item's, +1 per incompatible, level-merge rules, 40-level cap), NOT copied from
//! in-game observation. They pin the implementation to the rules; cross-checking the rules
//! themselves against a real anvil is the separate manual step Part 10.6 calls for.

use enchant::anvil::{
    TOO_EXPENSIVE_LIMIT, book_cost_multiplier, cheapest_linear_order, combine_sequence,
};
use enchant::data::{ENCHANTMENTS, index_of};
use enchant::{AnvilItem, combine};

fn ix(name: &str) -> usize {
    index_of(name).unwrap_or_else(|| panic!("{name} not in table"))
}

fn item(name: &str, pw: u32, ench: &[(&str, i32)]) -> AnvilItem {
    AnvilItem::new(name, pw, ench.iter().map(|&(n, l)| (ix(n), l)).collect())
}

fn book(pw: u32, ench: &[(&str, i32)]) -> AnvilItem {
    item("book", pw, ench)
}

/// anvil_cost is the item multiplier; the book multiplier is half (min 1). These are the
/// values that make the whole calculator right or 2x wrong, so pin them explicitly.
#[test]
fn cost_multipliers_match_the_wiki() {
    assert_eq!(ENCHANTMENTS[ix("sharpness")].anvil_cost, 1);
    assert_eq!(
        ENCHANTMENTS[ix("fire_aspect")].anvil_cost,
        4,
        "wiki: 4x from item"
    );
    assert_eq!(book_cost_multiplier(4), 2, "wiki: fire_aspect 2x from book");
    assert_eq!(book_cost_multiplier(1), 1, "never rounds to 0");
    assert_eq!(book_cost_multiplier(2), 1);
    assert_eq!(book_cost_multiplier(8), 4);
}

/// A book applied to a fresh item: no prior work, cost is just level x book-multiplier.
#[test]
fn book_onto_fresh_item() {
    // Fire Aspect II book -> sword: 2 * bookMult(4)=2 => 4.
    let r = combine(
        &item("diamond_sword", 0, &[]),
        &book(0, &[("fire_aspect", 2)]),
        false,
    );
    assert_eq!(r.cost, 4);
    assert_eq!(r.result, vec![(ix("fire_aspect"), 2)]);
    assert_eq!(r.result_prior_work, 1);
    assert!(!r.too_expensive);
}

/// The same enchantment from an ITEM costs the full multiplier — double the book.
#[test]
fn item_source_costs_double_the_book() {
    let from_book = combine(
        &item("diamond_sword", 0, &[]),
        &book(0, &[("fire_aspect", 2)]),
        false,
    );
    let from_item = combine(
        &item("diamond_sword", 0, &[]),
        &item("diamond_sword", 0, &[("fire_aspect", 2)]),
        false,
    );
    assert_eq!(from_book.cost, 4);
    assert_eq!(from_item.cost, 8);
}

/// Two equal levels below max combine to one higher; the cost uses the *resulting* level.
#[test]
fn equal_levels_combine_up() {
    // Sharpness III + III -> IV, cost 4 * itemMult(1) = 4.
    let r = combine(
        &item("diamond_sword", 0, &[("sharpness", 3)]),
        &item("diamond_sword", 0, &[("sharpness", 3)]),
        false,
    );
    assert_eq!(r.result, vec![(ix("sharpness"), 4)]);
    assert_eq!(r.cost, 4);
}

/// Max level does not exceed the cap when two maxed enchantments merge.
#[test]
fn max_level_is_capped() {
    let r = combine(
        &item("diamond_sword", 0, &[("sharpness", 5)]),
        &item("diamond_sword", 0, &[("sharpness", 5)]),
        false,
    );
    assert_eq!(
        r.result,
        vec![(ix("sharpness"), 5)],
        "cannot exceed max level 5"
    );
    assert_eq!(r.cost, 5, "5 * itemMult(1)");
}

/// Unequal levels take the higher, target-higher leaves it unchanged.
#[test]
fn unequal_levels_take_the_higher() {
    let sac_higher = combine(
        &item("diamond_sword", 0, &[("sharpness", 2)]),
        &book(0, &[("sharpness", 4)]),
        false,
    );
    assert_eq!(sac_higher.result, vec![(ix("sharpness"), 4)]);

    let target_higher = combine(
        &item("diamond_sword", 0, &[("sharpness", 4)]),
        &book(0, &[("sharpness", 2)]),
        false,
    );
    assert_eq!(target_higher.result, vec![(ix("sharpness"), 4)]);
    assert_eq!(
        target_higher.cost, 4,
        "still charged for the resulting level"
    );
}

/// Prior-work penalty is 2^n-1 on BOTH inputs and dominates the total.
#[test]
fn prior_work_penalty_is_exponential_on_both_items() {
    // Both worked 3 times -> penalty 7 each = 14, plus a trivial enchantment cost.
    let r = combine(
        &item("diamond_sword", 3, &[]),
        &book(3, &[("sharpness", 1)]),
        false,
    );
    assert_eq!(
        r.cost,
        7 + 7 + 1,
        "2^3-1 twice, plus sharpness I book (1*1)"
    );
    assert_eq!(r.result_prior_work, 4, "max(3,3)+1");
}

#[test]
fn rename_adds_one_level() {
    let plain = combine(
        &item("diamond_sword", 0, &[]),
        &book(0, &[("unbreaking", 1)]),
        false,
    );
    let renamed = combine(
        &item("diamond_sword", 0, &[]),
        &book(0, &[("unbreaking", 1)]),
        true,
    );
    assert_eq!(renamed.cost, plain.cost + 1);
}

/// An incompatible enchantment is not applied and costs +1.
#[test]
fn incompatible_enchantment_costs_one_and_is_dropped() {
    // Sword has Smite; a Sharpness book conflicts (same exclusive set).
    let r = combine(
        &item("diamond_sword", 0, &[("smite", 4)]),
        &book(0, &[("sharpness", 5)]),
        false,
    );
    assert_eq!(r.cost, 1, "+1 for the conflict, sharpness not applied");
    assert_eq!(
        r.result,
        vec![(ix("smite"), 4)],
        "sharpness must not appear"
    );
}

/// An enchantment the target item cannot hold is silently dropped at no cost.
#[test]
fn inapplicable_enchantment_is_dropped_free() {
    // Sharpness supports swords and axes, not pickaxes.
    let r = combine(
        &item("diamond_pickaxe", 0, &[]),
        &book(0, &[("sharpness", 5)]),
        false,
    );
    assert_eq!(r.cost, 0);
    assert!(r.result.is_empty());
}

/// A book target accepts enchantments regardless of item type.
#[test]
fn book_target_accepts_anything() {
    let r = combine(&book(0, &[]), &book(0, &[("sharpness", 5)]), false);
    assert_eq!(r.result, vec![(ix("sharpness"), 5)]);
}

/// The 40-level cap is reported (survival), driven here purely by prior work.
#[test]
fn too_expensive_over_the_cap() {
    let r = combine(
        &item("diamond_sword", 6, &[]),
        &book(0, &[("sharpness", 1)]),
        false,
    );
    assert!(r.cost > TOO_EXPENSIVE_LIMIT, "2^6-1 = 63 alone exceeds 39");
    assert!(r.too_expensive);
}

/// Order changes the total because prior work compounds; the solver finds the best chain.
#[test]
fn cheapest_order_is_no_worse_than_any_order() {
    let target = item("diamond_sword", 0, &[]);
    let sacs = [
        book(0, &[("sharpness", 5)]),
        book(0, &[("unbreaking", 3)]),
        book(0, &[("mending", 1)]),
        book(0, &[("fire_aspect", 2)]),
    ];
    let (best, order) = cheapest_linear_order(&target, &sacs);
    let (as_given, _) = combine_sequence(&target, &sacs);
    assert!(
        best <= as_given,
        "solver must not be worse than the given order"
    );
    assert_eq!(order.len(), sacs.len());
    // Every index used exactly once.
    let mut seen = order.clone();
    seen.sort();
    assert_eq!(seen, vec![0, 1, 2, 3]);
}

/// Folding a sequence chains prior work correctly: each step works the result once more.
#[test]
fn sequence_chains_prior_work() {
    let target = item("diamond_sword", 0, &[]);
    let (_total, final_item) = combine_sequence(
        &target,
        &[book(0, &[("sharpness", 5)]), book(0, &[("unbreaking", 3)])],
    );
    // fresh(0) + book -> pw 1; that(1) + book -> pw 2.
    assert_eq!(final_item.prior_work, 2);
    assert_eq!(final_item.enchantments.len(), 2);
}

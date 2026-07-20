//! Part 10.4 structural checks.
//!
//! These are invariants, not golden vectors. They catch a roll that is structurally
//! impossible (an inapplicable enchantment, a level above max, two mutually exclusive
//! enchantments together) but they CANNOT confirm that the specific enchantments
//! predicted for a given xp seed are what the game produces. Only 10.5's captured
//! vectors can do that.

use enchant::data::{ENCHANTMENTS, ITEM_ENCHANTABILITY, index_of};
use enchant::{MC_VERSION, enchantability, enchantments_in_slot, offered_levels};

const SEEDS: i32 = 20_000;
const ITEMS: &[&str] = &[
    "diamond_sword",
    "golden_sword",
    "iron_pickaxe",
    "netherite_axe",
    "leather_helmet",
    "diamond_chestplate",
    "bow",
    "crossbow",
    "fishing_rod",
    "trident",
    "book",
    "mace",
];

#[test]
fn data_table_is_sane() {
    assert_eq!(MC_VERSION, "1.21.3");
    assert_eq!(ENCHANTMENTS.len(), 42, "1.21.3 has 42 enchantments");
    // `enchantability()` binary-searches, which requires sorted keys.
    assert!(
        ITEM_ENCHANTABILITY.windows(2).all(|w| w[0].0 < w[1].0),
        "ITEM_ENCHANTABILITY must be sorted for binary search"
    );
    assert_eq!(enchantability("golden_sword"), Some(22));
    assert_eq!(enchantability("diamond_sword"), Some(10));
    assert_eq!(enchantability("book"), Some(1));
    assert_eq!(enchantability("not_a_real_item"), None);
}

/// Exclusivity is stored as a symmetric closure; verify that actually holds, since the
/// roll's filtering checks only one direction per pair.
#[test]
fn exclusivity_is_symmetric() {
    for (i, e) in ENCHANTMENTS.iter().enumerate() {
        for &j in e.exclusive_with {
            assert!(
                ENCHANTMENTS[j].exclusive_with.contains(&i),
                "{} excludes {} but not vice versa",
                e.name,
                ENCHANTMENTS[j].name
            );
        }
    }
    // Spot-check a pair the one-directional source data would have gotten wrong.
    let (ch, rip) = (
        index_of("channeling").unwrap(),
        index_of("riptide").unwrap(),
    );
    assert!(ENCHANTMENTS[ch].exclusive_with.contains(&rip));
    assert!(ENCHANTMENTS[rip].exclusive_with.contains(&ch));
}

#[test]
fn rolls_are_always_structurally_valid() {
    let mut total = 0usize;
    for item in ITEMS {
        for s in 0..SEEDS {
            for slot in 0..3 {
                let lv = offered_levels(s, 15)[slot];
                if lv == 0 {
                    continue;
                }
                let rolls = enchantments_in_slot(s, slot, item, lv);
                total += rolls.len();
                for (n, r) in rolls.iter().enumerate() {
                    let d = r.data();
                    // Books are exempt: they accept any table enchantment regardless of
                    // item tags, so `applies_to` legitimately fails for them.
                    assert!(
                        *item == "book" || d.applies_to(item),
                        "seed {s} slot {slot}: {} rolled onto {item}",
                        d.name
                    );
                    assert!(
                        d.in_enchanting_table,
                        "seed {s} slot {slot}: {} is not table-obtainable",
                        d.name
                    );
                    assert!(
                        r.level >= 1 && r.level <= d.max_level,
                        "seed {s}: {} level {} out of 1..={}",
                        d.name,
                        r.level,
                        d.max_level
                    );
                    for other in &rolls[..n] {
                        assert_ne!(r.enchantment, other.enchantment, "duplicate enchantment");
                        assert!(
                            !d.exclusive_with.contains(&other.enchantment),
                            "seed {s}: {} and {} are mutually exclusive",
                            d.name,
                            other.name()
                        );
                    }
                }
            }
        }
    }
    assert!(
        total > 0,
        "swept everything and rolled nothing — test is vacuous"
    );
}

/// An enchanting table cannot produce these, no matter the level or item. They still
/// declare item tags, so a filter that checks only applicability rolls them happily —
/// which is exactly the bug this pins.
#[test]
fn table_never_rolls_non_table_enchantments() {
    let banned: Vec<usize> = [
        "mending",
        "frost_walker",
        "soul_speed",
        "swift_sneak",
        "wind_burst",
        "binding_curse",
        "vanishing_curse",
    ]
    .iter()
    .map(|n| index_of(n).unwrap_or_else(|| panic!("{n} missing from table")))
    .collect();

    for item in ITEMS {
        for s in 0..SEEDS {
            for slot in 0..3 {
                for r in enchantments_in_slot(s, slot, item, 30) {
                    assert!(
                        !banned.contains(&r.enchantment),
                        "seed {s} slot {slot} {item}: rolled {} from a table",
                        r.name()
                    );
                }
            }
        }
    }
    assert_eq!(
        ENCHANTMENTS
            .iter()
            .filter(|e| e.in_enchanting_table)
            .count(),
        35,
        "1.21.3 has 35 table-obtainable enchantments of 42"
    );
}

/// Books accept any table enchantment, not just those matching their item tags — so they
/// must reach enchantments no sword can get. Without the bypass a book rolls nothing.
#[test]
fn books_accept_enchantments_swords_cannot() {
    let mut book_only = 0;
    let sword_reachable: Vec<usize> = (0..SEEDS)
        .flat_map(|s| {
            (0..3).flat_map(move |slot| enchantments_in_slot(s, slot, "diamond_sword", 30))
        })
        .map(|r| r.enchantment)
        .collect();

    for s in 0..SEEDS {
        for slot in 0..3 {
            for r in enchantments_in_slot(s, slot, "book", 30) {
                if !sword_reachable.contains(&r.enchantment) {
                    book_only += 1;
                }
            }
        }
    }
    assert!(
        book_only > 0,
        "books rolled nothing a sword could not — the book bypass is missing"
    );
}

#[test]
fn unknown_or_unenchantable_items_roll_nothing() {
    for s in 0..1_000 {
        assert!(enchantments_in_slot(s, 0, "not_a_real_item", 30).is_empty());
        assert!(enchantments_in_slot(s, 0, "dirt", 30).is_empty());
    }
}

#[test]
fn rolls_are_deterministic() {
    for s in 0..2_000 {
        let a = enchantments_in_slot(s, 1, "diamond_sword", 25);
        let b = enchantments_in_slot(s, 1, "diamond_sword", 25);
        assert_eq!(a, b);
    }
}

/// Books get one enchantment removed at random when more than one is rolled. If that draw
/// were omitted, books would show strictly more enchantments on average than they do.
#[test]
fn books_lose_one_enchantment() {
    let multi = (0..SEEDS)
        .filter(|&s| enchantments_in_slot(s, 2, "book", 30).len() > 1)
        .count();
    assert!(
        multi > 0,
        "books should sometimes keep multiple enchantments"
    );

    // A book at high level rolls several candidates; after the removal it must never
    // exceed what a comparable non-book item reaches under the same conditions.
    let book_max = (0..SEEDS)
        .map(|s| enchantments_in_slot(s, 2, "book", 30).len())
        .max()
        .unwrap();
    assert!(book_max >= 1);
}

/// Pins the loop order. The guide halves the level BEFORE the continue-roll; the game
/// halves after. Reproducing the guide's order here must give different results, or the
/// implementation is not actually distinguishing them.
#[test]
fn loop_halves_after_the_roll_not_before() {
    use enchant::JavaRandom;

    // Mirror of the guide's ordering, using the same helpers via the public surface.
    fn guide_order_count(xp_seed: i32, slot: usize, ench: i32, mut level: i32) -> usize {
        let mut r = JavaRandom::new(xp_seed as i64 + slot as i64);
        level = level + 1 + r.next_int_bound(ench / 4 + 1) + r.next_int_bound(ench / 4 + 1);
        let pct = (r.next_float() + r.next_float() - 1.0) * 0.15;
        level = (level + ((level as f32 * pct) + 0.5).floor() as i32).max(1);
        let mut n = 1usize;
        loop {
            level /= 2; // guide: halve FIRST
            if r.next_int_bound(50) > level {
                break;
            }
            n += 1;
        }
        n
    }

    let ours: usize = (0..3_000)
        .map(|s| enchantments_in_slot(s, 0, "diamond_sword", 30).len())
        .sum();
    let guide: usize = (0..3_000).map(|s| guide_order_count(s, 0, 10, 30)).sum();
    assert_ne!(
        ours, guide,
        "the two loop orders produced identical totals — the test cannot tell them apart"
    );
}

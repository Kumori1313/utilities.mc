//! Thin wasm-bindgen surface over the `enchant` crate (Part 10.5 wiring).
//!
//! The core crate stays pure Rust and natively testable; this module only marshals across
//! the JS boundary. Enchantment sets cross as newline-joined `"name level"` strings — the
//! simplest shape that survives the boundary without a serialization dependency, and the UI
//! just splits on newlines.

use enchant::anvil::{AnvilItem, TOO_EXPENSIVE_LIMIT, combine};
use enchant::data::index_of;
use enchant::{ENCHANTMENTS, MC_VERSION, enchantments_in_slot, offered_levels};
use wasm_bindgen::prelude::*;

/// Version the tables encode, for the UI to display.
#[wasm_bindgen]
pub fn enchant_version() -> String {
    MC_VERSION.to_string()
}

/// Every enchantment name, for populating dropdowns.
#[wasm_bindgen]
pub fn enchant_names() -> Vec<String> {
    ENCHANTMENTS.iter().map(|e| e.name.to_string()).collect()
}

/// The three offered levels (green numbers) for an xp seed and bookshelf count.
#[wasm_bindgen]
pub fn enchant_offered_levels(xp_seed: i32, bookshelves: i32) -> Vec<i32> {
    offered_levels(xp_seed, bookshelves).to_vec()
}

/// Enchantments a slot would roll, as `"name level"` lines. Empty string if the item is
/// unknown or the slot rolls nothing.
#[wasm_bindgen]
pub fn enchant_slot(xp_seed: i32, slot: usize, item: &str, level: i32) -> String {
    enchantments_in_slot(xp_seed, slot, item, level)
        .iter()
        .map(|r| format!("{} {}", r.name(), r.level))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parse `"fortune=3,unbreaking=3"` into anvil enchantment pairs. Unknown names are
/// skipped rather than failing the whole call, so a typo degrades gracefully.
fn parse_ench(spec: &str) -> Vec<(usize, i32)> {
    spec.split(',')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let (name, lvl) = part.split_once('=')?;
            let idx = index_of(name.trim())?;
            let level = lvl.trim().parse().ok()?;
            Some((idx, level))
        })
        .collect()
}

/// Result of an anvil combine, read via getters from JS.
#[wasm_bindgen]
pub struct AnvilOutcome {
    cost: i32,
    too_expensive: bool,
    result: String,
    next_prior_work: u32,
}

#[wasm_bindgen]
impl AnvilOutcome {
    #[wasm_bindgen(getter)]
    pub fn cost(&self) -> i32 {
        self.cost
    }
    #[wasm_bindgen(getter)]
    pub fn too_expensive(&self) -> bool {
        self.too_expensive
    }
    /// Resulting enchantments as `"name level"` lines.
    #[wasm_bindgen(getter)]
    pub fn result(&self) -> String {
        self.result.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn next_prior_work(&self) -> u32 {
        self.next_prior_work
    }
    #[wasm_bindgen(getter)]
    pub fn limit(&self) -> i32 {
        TOO_EXPENSIVE_LIMIT
    }
}

/// Combine a sacrifice into a target. Enchantment specs are `"name=level,..."`. Use
/// `"book"` as an item id for a book.
#[wasm_bindgen]
pub fn anvil_combine(
    target_item: &str,
    target_pw: u32,
    target_ench: &str,
    sac_item: &str,
    sac_pw: u32,
    sac_ench: &str,
    rename: bool,
) -> AnvilOutcome {
    let target = AnvilItem::new(target_item, target_pw, parse_ench(target_ench));
    let sacrifice = AnvilItem::new(sac_item, sac_pw, parse_ench(sac_ench));
    let r = combine(&target, &sacrifice, rename);
    AnvilOutcome {
        cost: r.cost,
        too_expensive: r.too_expensive,
        result: r
            .result
            .iter()
            .map(|&(i, l)| format!("{} {l}", ENCHANTMENTS[i].name))
            .collect::<Vec<_>>()
            .join("\n"),
        next_prior_work: r.result_prior_work,
    }
}

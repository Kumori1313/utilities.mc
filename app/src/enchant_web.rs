//! Thin wasm-bindgen surface over the `enchant` crate (Part 10.5 wiring).
//!
//! The core crate stays pure Rust and natively testable; this module only marshals across
//! the JS boundary. Enchantment sets cross as newline-joined `"name level"` strings — the
//! simplest shape that survives the boundary without a serialization dependency, and the UI
//! just splits on newlines.

use enchant::anvil::{AnvilItem, TOO_EXPENSIVE_LIMIT, combine};
use enchant::data::index_of;
use enchant::optimize::optimal_plan;
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

// ---- grid UI support (Part 10.6 overhaul) --------------------------------------------

/// Enchantment names that can be applied to `item` — the grid's rows. A book accepts any
/// enchantment; any other item accepts those whose `supported_items` include it (broader
/// than the table's primary set: e.g. sharpness applies to axes as well as swords).
#[wasm_bindgen]
pub fn enchant_applicable(item: &str) -> Vec<String> {
    let is_book = item == "book" || item == "enchanted_book";
    ENCHANTMENTS
        .iter()
        .filter(|e| is_book || e.supported_items.contains(&item))
        .map(|e| e.name.to_string())
        .collect()
}

/// Max level of an enchantment (number of tier columns to enable in the grid).
#[wasm_bindgen]
pub fn enchant_max_level(name: &str) -> i32 {
    index_of(name).map(|i| ENCHANTMENTS[i].max_level).unwrap_or(0)
}

/// Names that conflict with `name` (mutually exclusive). Selecting one disables these in the
/// grid unless the bypass toggle is on.
#[wasm_bindgen]
pub fn enchant_conflicts(name: &str) -> Vec<String> {
    match index_of(name) {
        Some(i) => ENCHANTMENTS[i]
            .exclusive_with
            .iter()
            .map(|&j| ENCHANTMENTS[j].name.to_string())
            .collect(),
        None => Vec::new(),
    }
}

/// The optimal plan, read via getters from JS.
#[wasm_bindgen]
pub struct OptimizePlan {
    total: i32,
    max_step: i32,
    too_expensive: bool,
    steps: String,
}

#[wasm_bindgen]
impl OptimizePlan {
    #[wasm_bindgen(getter)]
    pub fn total(&self) -> i32 {
        self.total
    }
    #[wasm_bindgen(getter)]
    pub fn max_step(&self) -> i32 {
        self.max_step
    }
    #[wasm_bindgen(getter)]
    pub fn too_expensive(&self) -> bool {
        self.too_expensive
    }
    /// One `"target | sacrifice | cost"` line per operation, in execution order.
    #[wasm_bindgen(getter)]
    pub fn steps(&self) -> String {
        self.steps.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn limit(&self) -> i32 {
        TOO_EXPENSIVE_LIMIT
    }
}

/// Cheapest order to apply `new_ench` (a `"name=level,..."` spec) onto an item that already
/// carries `tool_prior_work` prior anvil operations. Existing enchantments are not passed —
/// they only affect cost through the prior-work count. Returns null if the enchantment count
/// exceeds the solver's cap.
#[wasm_bindgen]
pub fn anvil_optimize(new_ench: &str, tool_prior_work: u32) -> Option<OptimizePlan> {
    let ench = parse_ench(new_ench);
    let level_of: std::collections::HashMap<usize, i32> = ench.iter().copied().collect();
    let plan = optimal_plan(&ench, tool_prior_work)?;

    // "fortune 3, unbreaking 3" for a set of enchantment indices.
    let label = |ids: &[usize]| -> String {
        ids.iter()
            .map(|&i| format!("{} {}", ENCHANTMENTS[i].name, level_of.get(&i).copied().unwrap_or(0)))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let steps = plan
        .steps
        .iter()
        .map(|s| {
            let target = if s.onto_tool {
                if s.target.is_empty() { "tool".to_string() } else { format!("tool [{}]", label(&s.target)) }
            } else {
                format!("book [{}]", label(&s.target))
            };
            format!("{target} | book [{}] | {}", label(&s.sacrifice), s.cost)
        })
        .collect::<Vec<_>>()
        .join("\n");

    Some(OptimizePlan {
        total: plan.total,
        max_step: plan.max_step,
        too_expensive: plan.max_step > TOO_EXPENSIVE_LIMIT,
        steps,
    })
}

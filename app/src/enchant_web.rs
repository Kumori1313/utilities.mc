//! Thin wasm-bindgen surface over the `enchant` crate (Part 10.5 wiring).
//!
//! The core crate stays pure Rust and natively testable; this module only marshals across
//! the JS boundary. Enchantment sets cross as newline-joined `"name level"` strings — the
//! simplest shape that survives the boundary without a serialization dependency, and the UI
//! just splits on newlines.

use enchant::anvil::{AnvilItem, TOO_EXPENSIVE_LIMIT, combine};
use enchant::data::VersionTable;
use enchant::optimize::optimal_plan;
use enchant::{default_table, enchantments_in_slot, offered_levels, table, versions};
use wasm_bindgen::prelude::*;

/// Resolve a version string to its table, falling back to the newest if the string is not
/// one this crate carries. Enchantment indices are version-scoped (Part 13.3), so EVERY
/// binding resolves the table once here and never mixes indices across a version change.
fn resolve(version: &str) -> &'static VersionTable {
    table(version).unwrap_or_else(default_table)
}

/// Every enchantment version this calculator carries, newest first. The enchant tab builds
/// its own picker from this — deliberately independent of the seed map's version list, since
/// the two halves support different sets of versions (Part 13.1).
#[wasm_bindgen]
pub fn enchant_versions() -> Vec<String> {
    versions().iter().map(|v| v.to_string()).collect()
}

/// The newest version this calculator carries — the default selection.
#[wasm_bindgen]
pub fn enchant_default_version() -> String {
    default_table().mc_version.to_string()
}

/// Every enchantment name in `version`, for populating dropdowns.
#[wasm_bindgen]
pub fn enchant_names(version: &str) -> Vec<String> {
    resolve(version)
        .enchantments
        .iter()
        .map(|e| e.name.to_string())
        .collect()
}

/// The three offered levels (green numbers) for an xp seed and bookshelf count.
///
/// Not version-parameterised: the offered-level formula is pure xp-seed RNG with no table
/// dependency, and is currently believed identical across the offered range. That belief is
/// the 13.4 audit's to confirm; when a version-dependent case is found, thread `version`
/// through here as the other bindings already do.
#[wasm_bindgen]
pub fn enchant_offered_levels(xp_seed: i32, bookshelves: i32) -> Vec<i32> {
    offered_levels(xp_seed, bookshelves).to_vec()
}

/// Enchantments a slot would roll under `version`, as `"name level"` lines. Empty string if
/// the item is unknown or the slot rolls nothing.
#[wasm_bindgen]
pub fn enchant_slot(version: &str, xp_seed: i32, slot: usize, item: &str, level: i32) -> String {
    let t = resolve(version);
    enchantments_in_slot(t, xp_seed, slot, item, level)
        .iter()
        .map(|r| format!("{} {}", r.name(t), r.level))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parse `"fortune=3,unbreaking=3"` into anvil enchantment pairs, resolving names against
/// `table`. Unknown names are skipped rather than failing the whole call, so a typo degrades
/// gracefully — and a name that does not exist in the selected version is simply dropped.
fn parse_ench(table: &VersionTable, spec: &str) -> Vec<(usize, i32)> {
    spec.split(',')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let (name, lvl) = part.split_once('=')?;
            let idx = table.index_of(name.trim())?;
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
    version: &str,
    target_item: &str,
    target_pw: u32,
    target_ench: &str,
    sac_item: &str,
    sac_pw: u32,
    sac_ench: &str,
    rename: bool,
) -> AnvilOutcome {
    let t = resolve(version);
    let target = AnvilItem::new(target_item, target_pw, parse_ench(t, target_ench));
    let sacrifice = AnvilItem::new(sac_item, sac_pw, parse_ench(t, sac_ench));
    let r = combine(t.enchantments, &target, &sacrifice, rename);
    AnvilOutcome {
        cost: r.cost,
        too_expensive: r.too_expensive,
        result: r
            .result
            .iter()
            .map(|&(i, l)| format!("{} {l}", t.get(i).name))
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
pub fn enchant_applicable(version: &str, item: &str) -> Vec<String> {
    let is_book = item == "book" || item == "enchanted_book";
    resolve(version)
        .enchantments
        .iter()
        .filter(|e| is_book || e.supported_items.contains(&item))
        .map(|e| e.name.to_string())
        .collect()
}

/// Material prefixes; stripping one yields the kind. Ordered so that one list reads correctly
/// for both families: tools skip leather/chainmail, armour skips wooden/stone, and each still
/// runs weakest to strongest. (`kind_of` only needs the prefixes, which are disjoint.)
const MATERIALS: [&str; 8] = [
    "leather_",
    "wooden_",
    "stone_",
    "chainmail_",
    "iron_",
    "golden_",
    "diamond_",
    "netherite_",
];

/// Kinds in a sensible dropdown order; anything unlisted sorts after these, alphabetically.
const KIND_ORDER: [&str; 22] = [
    "sword",
    "axe",
    "pickaxe",
    "shovel",
    "hoe",
    "helmet",
    "chestplate",
    "leggings",
    "boots",
    "bow",
    "crossbow",
    "trident",
    "mace",
    "shield",
    "elytra",
    "fishing_rod",
    "shears",
    "flint_and_steel",
    "brush",
    "carrot_on_a_stick",
    "warped_fungus_on_a_stick",
    "book",
];

/// Kind of an item: `diamond_sword` -> `sword`, `turtle_helmet` -> `helmet`, every mob head
/// -> `mob_head`. An item with no material variants is its own kind.
fn kind_of(item: &str) -> &str {
    if let Some(k) = MATERIALS.iter().find_map(|m| item.strip_prefix(m)) {
        return k;
    }
    if item == "turtle_helmet" {
        return "helmet";
    }
    if item.ends_with("_head") || item.ends_with("_skull") {
        return "mob_head";
    }
    item
}

fn kind_rank(kind: &str) -> usize {
    KIND_ORDER
        .iter()
        .position(|k| *k == kind)
        .unwrap_or(usize::MAX)
}

fn material_rank(item: &str) -> usize {
    MATERIALS
        .iter()
        .position(|m| item.starts_with(m))
        .unwrap_or(if item == "turtle_helmet" { 8 } else { 0 })
}

/// Every enchantable item in `table`, ordered by kind then material. Books accept any
/// enchantment but are not listed in any `supported_items`, so they are added explicitly.
fn all_items(table: &VersionTable) -> Vec<&'static str> {
    let mut v: Vec<&'static str> = vec!["book"];
    for e in table.enchantments {
        for &i in e.supported_items {
            if !v.contains(&i) {
                v.push(i);
            }
        }
    }
    v.sort_by_key(|i| (kind_rank(kind_of(i)), kind_of(i), material_rank(i), *i));
    v
}

/// `"kind|item_id"` lines for the enchanting-table dropdown. Every material variant appears:
/// enchantability is per-item and changes what a slot rolls, so a golden sword and a diamond
/// one are genuinely different questions. Items a table cannot enchant (mob heads, compasses
/// — anvil-only curse carriers) are excluded.
#[wasm_bindgen]
pub fn enchant_table_items(version: &str) -> Vec<String> {
    let t = resolve(version);
    all_items(t)
        .into_iter()
        .filter(|i| {
            t.enchantability(i).is_some()
                && (*i == "book"
                    || t.enchantments
                        .iter()
                        .any(|e| e.in_enchanting_table && e.supported_items.contains(i)))
        })
        .map(|i| format!("{}|{}", kind_of(i), i))
        .collect()
}

/// `"kind|item_id"` lines for the anvil planner: one representative per kind. Material cannot
/// affect an anvil plan — the applicable enchantment set is identical across every variant of
/// a kind, and cost depends only on the enchantments and prior work — so listing the variants
/// would offer several ways to pick the same thing.
#[wasm_bindgen]
pub fn anvil_items(version: &str) -> Vec<String> {
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for i in all_items(resolve(version)) {
        let k = kind_of(i);
        if !seen.contains(&k) {
            seen.push(k);
            out.push(format!("{k}|{i}"));
        }
    }
    out
}

/// Max level of an enchantment in `version` (number of tier columns to enable in the grid).
#[wasm_bindgen]
pub fn enchant_max_level(version: &str, name: &str) -> i32 {
    let t = resolve(version);
    t.index_of(name).map(|i| t.get(i).max_level).unwrap_or(0)
}

/// Names that conflict with `name` in `version` (mutually exclusive). Selecting one disables
/// these in the grid unless the bypass toggle is on.
#[wasm_bindgen]
pub fn enchant_conflicts(version: &str, name: &str) -> Vec<String> {
    let t = resolve(version);
    match t.index_of(name) {
        Some(i) => t
            .get(i)
            .exclusive_with
            .iter()
            .map(|&j| t.get(j).name.to_string())
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
pub fn anvil_optimize(version: &str, new_ench: &str, tool_prior_work: u32) -> Option<OptimizePlan> {
    let t = resolve(version);
    let ench = parse_ench(t, new_ench);
    let level_of: std::collections::HashMap<usize, i32> = ench.iter().copied().collect();
    let plan = optimal_plan(t.enchantments, &ench, tool_prior_work)?;

    // "fortune 3, unbreaking 3" for a set of enchantment indices.
    let label = |ids: &[usize]| -> String {
        ids.iter()
            .map(|&i| {
                format!(
                    "{} {}",
                    t.get(i).name,
                    level_of.get(&i).copied().unwrap_or(0)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let steps = plan
        .steps
        .iter()
        .map(|s| {
            let target = if s.onto_tool {
                if s.target.is_empty() {
                    "tool".to_string()
                } else {
                    format!("tool [{}]", label(&s.target))
                }
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

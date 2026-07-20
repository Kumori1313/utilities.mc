//! Static enchantment tables, generated at build time from
//! `data/enchantments-1.21.3.json`. See `build.rs`.

include!(concat!(env!("OUT_DIR"), "/tables.rs"));

/// Enchantability of an item, or `None` if the item is unknown to the table.
///
/// An unknown item is deliberately not defaulted to 1: the game skips enchanting
/// entirely for zero-enchantability items, and silently substituting a plausible value
/// would produce confident predictions for an item we have no data for.
pub fn enchantability(item: &str) -> Option<i32> {
    ITEM_ENCHANTABILITY
        .binary_search_by_key(&item, |(k, _)| k)
        .ok()
        .map(|i| ITEM_ENCHANTABILITY[i].1)
}

/// Index of an enchantment by name.
pub fn index_of(name: &str) -> Option<usize> {
    ENCHANTMENTS.iter().position(|e| e.name == name)
}

impl EnchantmentData {
    /// Cost window for a given level: `base + (level - 1) * per_level`.
    pub fn min_cost(&self, level: i32) -> i32 {
        self.min_cost.0 + (level - 1) * self.min_cost.1
    }

    pub fn max_cost(&self, level: i32) -> i32 {
        self.max_cost.0 + (level - 1) * self.max_cost.1
    }

    pub fn applies_to(&self, item: &str) -> bool {
        self.primary_items.contains(&item)
    }
}

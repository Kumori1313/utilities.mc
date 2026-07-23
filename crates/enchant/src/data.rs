//! Static enchantment tables, generated at build time from `data/enchantments-*.json`.
//! See `build.rs`.
//!
//! Multi-version (Part 13.3). Each dataset becomes one [`VersionTable`] in [`TABLES`],
//! ordered newest-first. Everything downstream takes a `&VersionTable` explicitly rather
//! than reading a global — because enchantment **indices are version-scoped**. An index
//! resolved against one version's table names a different enchantment under another's, with
//! no type-level guard, so an index must never outlive the table it was resolved against.

include!(concat!(env!("OUT_DIR"), "/tables.rs"));

/// One version's complete enchantment data: the ordered enchantment list (indices point
/// into `enchantments`) and the per-item enchantability lookup.
pub struct VersionTable {
    pub mc_version: &'static str,
    pub enchantments: &'static [EnchantmentData],
    /// Sorted by item name; look up with a binary search.
    pub item_enchantability: &'static [(&'static str, i32)],
}

impl VersionTable {
    /// Enchantability of an item, or `None` if the item is unknown to this table.
    ///
    /// An unknown item is deliberately not defaulted to 1: the game skips enchanting
    /// entirely for zero-enchantability items, and silently substituting a plausible value
    /// would produce confident predictions for an item we have no data for.
    pub fn enchantability(&self, item: &str) -> Option<i32> {
        self.item_enchantability
            .binary_search_by_key(&item, |(k, _)| k)
            .ok()
            .map(|i| self.item_enchantability[i].1)
    }

    /// Index of an enchantment by name, within THIS table. The result is only meaningful
    /// against this same table.
    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.enchantments.iter().position(|e| e.name == name)
    }

    /// The enchantment at `index`, which must have been resolved against this table.
    pub fn get(&self, index: usize) -> &'static EnchantmentData {
        &self.enchantments[index]
    }
}

/// The default table — the newest offered version. `TABLES` is newest-first, so this is
/// `TABLES[0]`.
pub fn default_table() -> &'static VersionTable {
    &TABLES[0]
}

/// The table for a version string (e.g. `"1.21.3"`), or `None` if not offered.
pub fn table(version: &str) -> Option<&'static VersionTable> {
    TABLES.iter().find(|t| t.mc_version == version)
}

/// Every offered version string, newest first — for a version picker.
pub fn versions() -> Vec<&'static str> {
    TABLES.iter().map(|t| t.mc_version).collect()
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

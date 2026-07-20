//! LRU tile cache (Part 6).
//!
//! Pure Rust, natively testable.
//!
//! # World generation counter
//!
//! The cache is keyed by tile position, which says nothing about *which world* the data
//! came from. Changing seed, version, or dimension therefore invalidates every entry — and
//! a stale hit after a seed change is a silent wrong-biome bug that looks exactly like
//! correct output. [`TileCache::set_world`] bumps a generation counter and drops
//! everything; there is deliberately no way to change worlds without going through it.

use crate::tiles::TileKey;
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct World {
    pub seed: u64,
    pub version: i32,
    pub dimension: i32,
}

/// One cached tile: biome ids and surface heights for the same grid, kept together
/// because `gen_heights` produces both in a single pass and a mesh needs both. Splitting
/// them into separate caches would allow one to be evicted while the other survives,
/// leaving terrain shaped by one tile and coloured by another.
#[derive(Clone, Debug, PartialEq)]
pub struct Tile {
    pub biomes: Vec<i32>,
    pub heights: Vec<f32>,
}

struct Entry {
    data: Tile,
    /// Monotonic stamp for LRU ordering. Not a timestamp — a counter, so it cannot go
    /// backwards under a clock adjustment.
    last_used: u64,
}

pub struct TileCache {
    entries: HashMap<TileKey, Entry>,
    capacity: usize,
    clock: u64,
    world: Option<World>,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

impl TileCache {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "capacity must be non-zero");
        Self {
            entries: HashMap::new(),
            capacity,
            clock: 0,
            world: None,
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    pub fn world(&self) -> Option<World> {
        self.world
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Point the cache at a world. Clears everything if the world actually changed;
    /// re-setting the same world is a no-op so a redundant call does not throw away
    /// warm tiles. Returns true if the cache was cleared.
    pub fn set_world(&mut self, world: World) -> bool {
        if self.world == Some(world) {
            return false;
        }
        self.world = Some(world);
        self.entries.clear();
        true
    }

    pub fn get(&mut self, key: &TileKey) -> Option<&Tile> {
        self.clock += 1;
        let clock = self.clock;
        match self.entries.get_mut(key) {
            Some(e) => {
                e.last_used = clock;
                self.hits += 1;
                // Reborrow immutably; the borrow checker will not let the &mut escape.
                Some(&self.entries.get(key).unwrap().data)
            }
            None => {
                self.misses += 1;
                None
            }
        }
    }

    /// Insert a tile, evicting the least recently used entry if at capacity.
    ///
    /// Panics if no world is set: storing tiles for an unspecified world is how stale data
    /// gets in, so it is a programming error rather than something to paper over.
    pub fn put(&mut self, key: TileKey, data: Tile) {
        assert!(
            self.world.is_some(),
            "set_world must be called before caching tiles"
        );
        self.clock += 1;

        // Only evict when this is a genuinely new key: replacing an existing tile does not
        // grow the map, so evicting there would discard a live tile for nothing.
        let at_capacity = !self.entries.contains_key(&key) && self.entries.len() >= self.capacity;
        if let Some(victim) = at_capacity
            .then(|| {
                self.entries
                    .iter()
                    .min_by_key(|(_, e)| e.last_used)
                    .map(|(k, _)| *k)
            })
            .flatten()
        {
            self.entries.remove(&victim);
            self.evictions += 1;
        }

        self.entries.insert(
            key,
            Entry {
                data,
                last_used: self.clock,
            },
        );
    }

    /// Which of `wanted` are not currently cached, preserving the requested order.
    ///
    /// Does not count as a hit or miss: this is a planning query, not a lookup.
    pub fn missing(&self, wanted: &[TileKey]) -> Vec<TileKey> {
        wanted
            .iter()
            .filter(|k| !self.entries.contains_key(k))
            .copied()
            .collect()
    }
}

//! Part 6 cache tests, with emphasis on world invalidation — a stale hit after a seed
//! change is a silent wrong-biome bug indistinguishable from correct output.

use app::cache::{TileCache, World};
use app::tiles::TileKey;

fn key(tx: i32, tz: i32) -> TileKey {
    TileKey { tx, tz, scale: 4 }
}

fn world(seed: u64) -> World {
    World {
        seed,
        version: 27,
        dimension: 0,
    }
}

fn cache_with_world(cap: usize) -> TileCache {
    let mut c = TileCache::new(cap);
    c.set_world(world(1));
    c
}

#[test]
fn stores_and_retrieves() {
    let mut c = cache_with_world(4);
    c.put(key(0, 0), vec![7; 16]);
    assert_eq!(c.get(&key(0, 0)), Some(&[7; 16][..]));
    assert_eq!(c.get(&key(1, 0)), None);
    assert_eq!(c.hits, 1);
    assert_eq!(c.misses, 1);
}

#[test]
fn evicts_least_recently_used() {
    let mut c = cache_with_world(3);
    c.put(key(0, 0), vec![0]);
    c.put(key(1, 0), vec![1]);
    c.put(key(2, 0), vec![2]);

    // Touch 0 and 2 so 1 becomes the coldest.
    assert!(c.get(&key(0, 0)).is_some());
    assert!(c.get(&key(2, 0)).is_some());

    c.put(key(3, 0), vec![3]);
    assert_eq!(c.len(), 3);
    assert_eq!(c.evictions, 1);
    assert!(c.get(&key(1, 0)).is_none(), "coldest entry should be gone");
    assert!(c.get(&key(0, 0)).is_some());
    assert!(c.get(&key(2, 0)).is_some());
    assert!(c.get(&key(3, 0)).is_some());
}

#[test]
fn overwriting_an_existing_key_does_not_evict() {
    let mut c = cache_with_world(2);
    c.put(key(0, 0), vec![0]);
    c.put(key(1, 0), vec![1]);
    c.put(key(0, 0), vec![99]);
    assert_eq!(c.len(), 2);
    assert_eq!(c.evictions, 0, "replacing a key must not evict another");
    assert_eq!(c.get(&key(0, 0)), Some(&[99][..]));
}

/// The important one: cached tiles must not survive a world change.
#[test]
fn changing_world_clears_the_cache() {
    let mut c = cache_with_world(8);
    c.put(key(0, 0), vec![42]);
    assert!(c.get(&key(0, 0)).is_some());

    assert!(c.set_world(world(2)), "seed change should report a clear");
    assert!(
        c.get(&key(0, 0)).is_none(),
        "tile from seed 1 served after switching to seed 2"
    );
    assert_eq!(c.len(), 0);
}

#[test]
fn version_and_dimension_changes_also_clear() {
    for other in [
        World {
            seed: 1,
            version: 26,
            dimension: 0,
        },
        World {
            seed: 1,
            version: 27,
            dimension: -1,
        },
    ] {
        let mut c = cache_with_world(8);
        c.put(key(0, 0), vec![42]);
        assert!(c.set_world(other), "{other:?} should clear");
        assert!(c.get(&key(0, 0)).is_none(), "{other:?} left a stale tile");
    }
}

#[test]
fn resetting_the_same_world_keeps_warm_tiles() {
    let mut c = cache_with_world(8);
    c.put(key(0, 0), vec![42]);
    assert!(!c.set_world(world(1)), "same world should be a no-op");
    assert!(
        c.get(&key(0, 0)).is_some(),
        "redundant set_world discarded warm tiles"
    );
}

#[test]
#[should_panic(expected = "set_world")]
fn caching_without_a_world_panics() {
    let mut c = TileCache::new(4);
    c.put(key(0, 0), vec![0]);
}

#[test]
fn missing_reports_uncached_keys_in_order() {
    let mut c = cache_with_world(8);
    c.put(key(1, 0), vec![1]);
    let wanted = [key(0, 0), key(1, 0), key(2, 0)];
    assert_eq!(c.missing(&wanted), vec![key(0, 0), key(2, 0)]);
    // Planning must not pollute hit/miss stats.
    assert_eq!(c.hits, 0);
    assert_eq!(c.misses, 0);
}

/// Same tile index at a different scale is a different tile; the cache must not conflate
/// them.
#[test]
fn scale_is_not_conflated() {
    let mut c = cache_with_world(8);
    let s1 = TileKey {
        tx: 0,
        tz: 0,
        scale: 1,
    };
    let s4 = TileKey {
        tx: 0,
        tz: 0,
        scale: 4,
    };
    c.put(s1, vec![111]);
    c.put(s4, vec![444]);
    assert_eq!(c.get(&s1), Some(&[111][..]));
    assert_eq!(c.get(&s4), Some(&[444][..]));
}

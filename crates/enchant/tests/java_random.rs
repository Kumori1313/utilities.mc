//! Part 10.1 hard gate: JavaRandom must reproduce a real JDK exactly.
//!
//! The vectors are GENERATED, not transcribed — see scripts/gen-java-vectors.sh. A typo in
//! a hand-copied expectation is indistinguishable from a bug in the implementation, which
//! would defeat the purpose of having a reference at all.
//!
//! Until `vectors/java_random.rs` exists, the gate is UNMET and the test fails loudly
//! rather than passing vacuously — a skipped foundational test that silently reports
//! success is worse than no test.

use enchant::JavaRandom;

// In a subdirectory so cargo does not auto-discover it as a (test-free) integration
// target of its own. Regenerate with:
//   scripts/gen-java-vectors.sh > crates/enchant/tests/vectors/java_random.rs && cargo fmt
// The trailing `cargo fmt` matters: the checked-in file is rustfmt-formatted, so skipping
// it leaves a large whitespace-only diff that obscures whether any value actually moved.
#[path = "vectors/java_random.rs"]
mod vectors;

#[test]
fn next_int_bound_matches_jdk() {
    for &(seed, bound, expected) in vectors::NEXT_INT_BOUND {
        let mut r = JavaRandom::new(seed);
        let got: Vec<i32> = (0..10).map(|_| r.next_int_bound(bound)).collect();
        assert_eq!(
            got.as_slice(),
            expected.as_slice(),
            "nextInt({bound}) diverged for seed {seed}"
        );
    }
}

#[test]
fn next_int_matches_jdk() {
    for &(seed, expected) in vectors::NEXT_INT {
        let mut r = JavaRandom::new(seed);
        let got: Vec<i32> = (0..10).map(|_| r.next_int()).collect();
        assert_eq!(
            got.as_slice(),
            expected.as_slice(),
            "nextInt() diverged for seed {seed}"
        );
    }
}

#[test]
fn next_float_matches_jdk_bit_for_bit() {
    for &(seed, expected) in vectors::NEXT_FLOAT_BITS {
        let mut r = JavaRandom::new(seed);
        let got: Vec<u32> = (0..10).map(|_| r.next_float().to_bits()).collect();
        assert_eq!(
            got.as_slice(),
            expected.as_slice(),
            "nextFloat() diverged for seed {seed} (compared as raw bits)"
        );
    }
}

#[test]
fn next_long_matches_jdk() {
    for &(seed, expected) in vectors::NEXT_LONG {
        let mut r = JavaRandom::new(seed);
        let got: Vec<i64> = (0..6).map(|_| r.next_long()).collect();
        assert_eq!(
            got.as_slice(),
            expected.as_slice(),
            "nextLong() diverged for seed {seed}"
        );
    }
}

/// Every other vector re-seeds and then calls a single method, so none of them would
/// notice a method that advances the stream by the wrong number of steps. This one would.
#[test]
fn interleaved_calls_stay_in_sync() {
    let mut r = JavaRandom::new(12345);
    for (i, &(op, expected)) in vectors::MIXED.iter().enumerate() {
        let got: i64 = match op {
            0 => r.next_int_bound(100) as i64,
            1 => r.next_int_bound(16) as i64,
            2 => r.next_float().to_bits() as i64,
            _ => r.next_int() as i64,
        };
        assert_eq!(got, expected, "stream desynced at call {i} (op {op})");
    }
}

/// Not JDK-sourced — a structural check that the power-of-two branch is actually reachable
/// and distinct. If someone deletes it, the bound-16 vectors above fail; this pins down
/// *why* by showing the two paths are not interchangeable.
#[test]
fn power_of_two_branch_is_distinct_from_general_path() {
    let general = {
        let mut r = JavaRandom::new(999);
        (0..8).map(|_| r.next_int_bound(15)).collect::<Vec<_>>()
    };
    let pow2 = {
        let mut r = JavaRandom::new(999);
        (0..8).map(|_| r.next_int_bound(16)).collect::<Vec<_>>()
    };
    assert_ne!(
        general, pow2,
        "bound 15 and 16 produced identical streams — the power-of-two branch is likely missing"
    );
}

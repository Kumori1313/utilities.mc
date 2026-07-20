//! Bit-exact reimplementation of `java.util.Random` (Part 10.1).
//!
//! This is a fully specified algorithm — the `java.util.Random` javadoc gives the exact
//! arithmetic — so there is one correct answer and "close enough" is worthless. A single
//! wrong bit desynchronizes the stream and every prediction after it is garbage.
//!
//! The state is a 48-bit LCG. Java's `int` is a wrapping 32-bit signed integer, so every
//! place the Java source relies on silent overflow uses an explicit `wrapping_*` here:
//! Rust panics on overflow in debug builds, which would otherwise make debug and release
//! disagree — the worst possible failure mode for something meant to be bit-exact.

const MULTIPLIER: u64 = 0x5DEECE66D;
const ADDEND: u64 = 0xB;
const MASK: u64 = (1 << 48) - 1;

#[derive(Clone, Debug)]
pub struct JavaRandom {
    seed: u64,
}

impl JavaRandom {
    /// Matches `new Random(seed)`, including the initial scramble. Note that seeding is
    /// NOT the identity: `new Random(0)` does not start from state 0.
    pub fn new(seed: i64) -> Self {
        Self {
            seed: (seed as u64 ^ MULTIPLIER) & MASK,
        }
    }

    /// Matches `setSeed`. Enchanting re-seeds constantly (each table slot starts a fresh
    /// stream from `xp_seed + slot`), so this is a hot path, not a convenience.
    pub fn set_seed(&mut self, seed: i64) {
        self.seed = (seed as u64 ^ MULTIPLIER) & MASK;
    }

    /// Matches the protected `next(int bits)`. The shift is a logical shift on the 48-bit
    /// state, hence `u64` here rather than a sign-propagating shift.
    fn next(&mut self, bits: u32) -> i32 {
        debug_assert!((1..=32).contains(&bits));
        self.seed = self.seed.wrapping_mul(MULTIPLIER).wrapping_add(ADDEND) & MASK;
        (self.seed >> (48 - bits)) as u32 as i32
    }

    /// Matches `nextInt()`.
    pub fn next_int(&mut self) -> i32 {
        self.next(32)
    }

    /// Matches `nextInt(bound)`.
    ///
    /// Two things here are load-bearing and neither is an optimization:
    ///
    /// The power-of-two branch consumes the stream differently from the general path, so
    /// dropping it silently desyncs on `nextInt(2)`, `nextInt(4)`, `nextInt(16)` — bounds
    /// enchanting hits constantly.
    ///
    /// The rejection loop removes modulo bias. `bits % bound` alone is right the
    /// overwhelming majority of the time, which is exactly what makes omitting it such a
    /// miserable bug to find later.
    pub fn next_int_bound(&mut self, bound: i32) -> i32 {
        assert!(bound > 0, "bound must be positive, got {bound}");

        // `bound & -bound == bound` is Java's power-of-two test.
        if (bound & bound.wrapping_neg()) == bound {
            return ((bound as i64).wrapping_mul(self.next(31) as i64) >> 31) as i32;
        }

        loop {
            let bits = self.next(31);
            let val = bits % bound;
            // Java: `bits - val + (bound - 1) < 0` detects i32 overflow and retries.
            if bits.wrapping_sub(val).wrapping_add(bound.wrapping_sub(1)) >= 0 {
                return val;
            }
        }
    }

    /// Matches `nextFloat()`. The divisor is exactly 2^24.
    pub fn next_float(&mut self) -> f32 {
        self.next(24) as f32 / (1u32 << 24) as f32
    }

    /// Matches `nextLong()`. Java composes this from two `next(32)` draws, and the
    /// addition wraps — the high word is signed, so this is not a plain bit-concatenation.
    pub fn next_long(&mut self) -> i64 {
        let hi = (self.next(32) as i64) << 32;
        hi.wrapping_add(self.next(32) as i64)
    }
}

//! utilities.mc — enchantment calculator (Part 10).
//!
//! Pure Rust, no C dependency: enchanting is Java's 48-bit LCG, a weighted pick from a
//! static table, and integer arithmetic. This crate therefore compiles to
//! `wasm32-unknown-unknown` with plain `wasm-pack` — the naive path that fails for
//! Cubiomes in Part 3a works fine here, which is why this must NOT live in `engine/`.
//!
//! Build order is gated (Part 10.1): `java_random` has to be proven bit-exact against a
//! real JDK before anything is stacked on top of it, because a desynchronized stream
//! makes every layer above it produce confident nonsense.

pub mod anvil;
pub mod data;
pub mod enchant;
pub mod java_random;
pub mod table;

pub use anvil::{AnvilItem, CombineResult, combine, combine_sequence};
pub use data::{ENCHANTMENTS, MC_VERSION, enchantability};
pub use enchant::{Roll, enchantments_in_slot};
pub use java_random::JavaRandom;
pub use table::{offered_levels, raw_levels};

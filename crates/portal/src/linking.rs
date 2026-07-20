//! Portal linking — "will my two portals actually pair?" (Part 11.2).
//!
//! # Correction to the build guide
//!
//! The guide states the search radius is "128 blocks in the destination's own scale" and
//! concludes that "a 128-block search radius in the Nether covers 1024 Overworld blocks".
//! Both are wrong. Per the Minecraft Wiki's "Nether Portal" revision 2762332 (2024-11,
//! inside the 1.21.3 window):
//!
//! > The point of interest can be within a 17x17 chunk area in the Overworld and a 33x33
//! > block area in the Nether.
//!
//! So the radius is **asymmetric**: +/-128 blocks when searching the Overworld, but only
//! +/-16 when searching the Nether. The two are equivalent once scaled — 16 Nether blocks
//! *is* 128 Overworld blocks — which is presumably where the guide's confusion came from.
//!
//! The practical warning the guide wants is still real, just with a different number: a
//! Nether search covers **128 Overworld blocks**, not 1024. Two Overworld portals within
//! that of each other can collapse onto one Nether portal.
//!
//! # Modelling caveat
//!
//! The Overworld search is chunk-granular (17x17 chunks around the target's chunk), so its
//! true extent depends on where the target sits within its chunk and is not a clean
//! +/-128 box. This module models a symmetric Chebyshev radius, which is right in the
//! interior and can disagree within roughly a chunk of the boundary. Treat results near
//! the limit as "marginal" rather than definitive — [`LinkOutcome::Marginal`] exists for
//! exactly that.

use crate::coords::{nether_to_overworld, overworld_to_nether};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dimension {
    Overworld,
    Nether,
}

/// Horizontal search radius, in blocks of the dimension being searched.
///
/// Asymmetric on purpose — see the module docs.
pub const fn search_radius(searching: Dimension) -> i32 {
    match searching {
        Dimension::Overworld => 128,
        Dimension::Nether => 16,
    }
}

/// How far from the search boundary a result is still considered uncertain, because the
/// Overworld search is chunk-granular rather than a clean box.
pub const MARGINAL_BAND: i32 = 16;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LinkOutcome {
    /// Comfortably inside the search area.
    Links,
    /// Within one chunk of the boundary — the chunk-granular search makes this
    /// unreliable to call either way. See the module's modelling caveat.
    Marginal,
    /// Outside the search area; a new portal would be generated instead.
    NoLink { short_by: i32 },
}

/// Chebyshev (square) distance — the search area is a square, not a circle.
fn chebyshev(a: (i32, i32), b: (i32, i32)) -> i32 {
    (a.0 - b.0).abs().max((a.1 - b.1).abs())
}

/// Does a portal at `from` (in `from_dim`) link to an existing portal at `to`?
///
/// `to` is given in the *destination* dimension's coordinates.
pub fn links(from_dim: Dimension, from: (i32, i32), to: (i32, i32)) -> LinkOutcome {
    let (target, searching) = match from_dim {
        Dimension::Overworld => (overworld_to_nether(from.0, from.1), Dimension::Nether),
        Dimension::Nether => (nether_to_overworld(from.0, from.1), Dimension::Overworld),
    };
    let radius = search_radius(searching);
    let d = chebyshev(target, to);

    if d > radius {
        LinkOutcome::NoLink {
            short_by: d - radius,
        }
    } else if radius - d < MARGINAL_BAND {
        LinkOutcome::Marginal
    } else {
        LinkOutcome::Links
    }
}

/// Where to build the counterpart so it links to `from`.
///
/// Returns the ideal target; anything within [`search_radius`] of it also works.
pub fn counterpart(from_dim: Dimension, from: (i32, i32)) -> ((i32, i32), i32) {
    match from_dim {
        Dimension::Overworld => (
            overworld_to_nether(from.0, from.1),
            search_radius(Dimension::Nether),
        ),
        Dimension::Nether => (
            nether_to_overworld(from.0, from.1),
            search_radius(Dimension::Overworld),
        ),
    }
}

/// The span of Overworld blocks that collapse into a single Nether search area.
///
/// This is the number worth surfacing: a Nether search of +/-16 blocks corresponds to
/// +/-128 Overworld blocks, so two Overworld portals closer than this can end up sharing
/// one Nether portal — the most common portal-linking complaint there is.
pub const OVERWORLD_SPAN_OF_NETHER_SEARCH: i32 =
    search_radius(Dimension::Nether) * crate::coords::SCALE;

/// Do two Overworld portals risk collapsing onto the same Nether portal?
///
/// Compares their Nether targets, since that is where the collision actually happens —
/// two portals can be far apart in the Overworld yet share a Nether target after flooring.
pub fn portals_may_collide(a: (i32, i32), b: (i32, i32)) -> bool {
    let (ta, tb) = (overworld_to_nether(a.0, a.1), overworld_to_nether(b.0, b.1));
    chebyshev(ta, tb) <= search_radius(Dimension::Nether)
}

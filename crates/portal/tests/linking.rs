//! Part 11.2 tests.

use portal::linking::MARGINAL_BAND;
use portal::{
    Dimension, LinkOutcome, OVERWORLD_SPAN_OF_NETHER_SEARCH, counterpart, links,
    portals_may_collide, search_radius,
};

/// The correction to the guide, stated as an assertion: the radius is asymmetric.
#[test]
fn search_radius_is_asymmetric() {
    assert_eq!(search_radius(Dimension::Overworld), 128);
    assert_eq!(
        search_radius(Dimension::Nether),
        16,
        "NOT 128 — see module docs"
    );

    // 16 Nether blocks is 128 Overworld blocks. The guide's "1024" came from applying the
    // Overworld radius in the Nether.
    assert_eq!(OVERWORLD_SPAN_OF_NETHER_SEARCH, 128);
    assert_ne!(OVERWORLD_SPAN_OF_NETHER_SEARCH, 1024);
}

#[test]
fn a_portal_links_to_its_own_counterpart() {
    for &(x, z) in &[(0, 0), (100, -240), (-1_000, 5_000), (-7, -7)] {
        let (target, _) = counterpart(Dimension::Overworld, (x, z));
        assert_eq!(
            links(Dimension::Overworld, (x, z), target),
            LinkOutcome::Links,
            "({x},{z}) should link to its own computed counterpart"
        );
    }
}

#[test]
fn links_inside_and_fails_outside_the_nether_radius() {
    let from = (0, 0); // Nether target (0, 0)
    let r = search_radius(Dimension::Nether);

    // Well inside.
    assert_eq!(
        links(Dimension::Overworld, from, (0, 0)),
        LinkOutcome::Links
    );
    // Just past the edge.
    assert!(matches!(
        links(Dimension::Overworld, from, (r + 1, 0)),
        LinkOutcome::NoLink { short_by: 1 }
    ));
    assert!(matches!(
        links(Dimension::Overworld, from, (0, -(r + 5))),
        LinkOutcome::NoLink { short_by: 5 }
    ));
    // At the boundary the chunk-granular search makes this unreliable, so it must not
    // claim a definite answer.
    assert_eq!(
        links(Dimension::Overworld, from, (r, 0)),
        LinkOutcome::Marginal
    );
}

/// The search area is a square, not a circle: a diagonal offset of (16, 16) is inside,
/// even though its Euclidean distance exceeds 16.
#[test]
fn search_area_is_square_not_circular() {
    let r = search_radius(Dimension::Nether);
    assert_ne!(
        links(Dimension::Overworld, (0, 0), (r, r)),
        LinkOutcome::NoLink { short_by: 6 },
        "diagonal corner must be inside the square"
    );
    assert!(matches!(
        links(Dimension::Overworld, (0, 0), (r, r)),
        LinkOutcome::Marginal | LinkOutcome::Links
    ));
}

#[test]
fn nether_side_uses_the_overworld_radius() {
    let from = (10, 10); // -> Overworld (80, 80)
    assert_eq!(links(Dimension::Nether, from, (80, 80)), LinkOutcome::Links);
    // 128 blocks away in the Overworld is the boundary, not a comfortable link.
    assert_eq!(
        links(Dimension::Nether, from, (80 + 128, 80)),
        LinkOutcome::Marginal
    );
    assert!(matches!(
        links(Dimension::Nether, from, (80 + 200, 80)),
        LinkOutcome::NoLink { .. }
    ));
    // Being generous with the Nether radius here would wrongly report a link.
    assert!(matches!(
        links(Dimension::Nether, from, (80, 80 + 129 + MARGINAL_BAND)),
        LinkOutcome::NoLink { .. }
    ));
}

/// The player-facing warning: two Overworld portals within ~128 blocks share a Nether
/// target. This is the guide's point, with the corrected figure.
#[test]
fn nearby_overworld_portals_collide() {
    let a = (0, 0);
    assert!(
        portals_may_collide(a, (100, 0)),
        "100 blocks apart should collide"
    );
    assert!(
        portals_may_collide(a, (0, 127)),
        "just under the span should collide"
    );
    assert!(
        !portals_may_collide(a, (2_000, 0)),
        "2000 blocks apart must not collide"
    );

    // Find the actual separation at which collision stops, and confirm it matches the
    // corrected span rather than the guide's 1024.
    let first_safe = (1..4_000)
        .find(|&d| !portals_may_collide(a, (d, 0)))
        .unwrap();
    assert!(
        (129..=136).contains(&first_safe),
        "collision should stop near {OVERWORLD_SPAN_OF_NETHER_SEARCH} blocks, got {first_safe}"
    );
}

/// Flooring means two portals straddling a multiple of 8 can be 1 block apart and still
/// land on different Nether targets — collision is about the *targets*, not raw distance.
#[test]
fn collision_is_measured_on_nether_targets() {
    assert!(portals_may_collide((7, 0), (8, 0)));
    // And far-apart portals never collide regardless of alignment.
    assert!(!portals_may_collide((-5_000, 0), (5_000, 0)));
}

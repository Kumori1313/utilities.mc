//! Flight movement math for the 3D view (Part 12.5).
//!
//! Split out from map3d.js purely so it can be tested without a browser: left/right
//! handedness and diagonal normalisation are both easy to get subtly wrong and impossible to
//! confirm by reading, and everything here is pure vector arithmetic over a camera.

import * as THREE from 'three';

const fwd = new THREE.Vector3();
const right = new THREE.Vector3();

/// Movement delta for the currently held keys, or null if none of them move the camera.
///
/// `out` is written in place and returned, so the caller can hold one vector rather than
/// allocating per frame.
export function flyDelta(keys, camera, dt, out = new THREE.Vector3()) {
  let x = 0, z = 0, y = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) z += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) z -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('Space')) y += 1;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) y -= 1;
  // Opposing keys cancel, which is not the same as no keys held.
  if (!x && !y && !z) return null;

  // Forward is the view direction flattened onto the ground plane, so looking down at the
  // terrain — the normal way to use this map — does not reduce W to a crawl.
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); // camera pointing straight down
  fwd.normalize();
  right.crossVectors(fwd, camera.up).normalize();

  out.set(0, 0, 0).addScaledVector(fwd, z).addScaledVector(right, x);
  if (out.lengthSq() > 0) out.normalize(); // or diagonals travel 1.41x faster
  out.y = y;
  // Speed scales with altitude: a fixed rate feels glacial when zoomed out far enough to see
  // a whole region, and twitchy down near the surface.
  return out.multiplyScalar(Math.max(60, camera.position.y * 1.2) * dt);
}

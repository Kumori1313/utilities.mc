//! Tile -> Three.js mesh (Part 7).
//!
//! One `BufferGeometry` per tile rather than a `PlaneGeometry`, because the vertex grid has
//! to line up exactly with the biome/height grid — a PlaneGeometry's segment count and the
//! cell count are easy to get subtly out of step, and the result is terrain offset by half
//! a cell from its colours.

import * as THREE from 'three';

/// Vertical exaggeration. Cubiomes' approximate heights span a modest range, and at true
/// 1:1 against a 256-block-wide tile the terrain reads as almost flat.
export const Y_SCALE = 1.6;

/// Build a mesh for one tile. `n` is cells per edge, `scale` blocks per cell.
///
/// Vertices sit at cell centres, so a tile of n cells produces an (n-1)x(n-1) quad grid.
/// Neighbouring tiles therefore leave a one-cell seam; that is a known limitation, noted
/// rather than hidden — closing it needs an overlapping fetch of n+1 cells per tile.
export function buildTileMesh(biomes, heights, n, scale, originX, originZ, palette) {
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const h = heights[k];
      positions[k * 3] = originX + i * scale;
      // NaN would poison the whole geometry's bounding sphere and silently blank the
      // mesh, so guard rather than trust the buffer.
      positions[k * 3 + 1] = Number.isFinite(h) ? h * Y_SCALE : 0;
      positions[k * 3 + 2] = originZ + j * scale;

      const id = biomes[k];
      const p = (id >= 0 && id < 256) ? id * 3 : 0;
      // sRGB -> linear, since the renderer works in linear space; skipping this makes
      // everything look washed out.
      colors[k * 3] = srgbToLinear(palette[p] / 255);
      colors[k * 3 + 1] = srgbToLinear(palette[p + 1] / 255);
      colors[k * 3 + 2] = srgbToLinear(palette[p + 2] / 255);
    }
  }

  // Two triangles per quad. 16-bit indices overflow past 65535 vertices, so pick the
  // index width from the actual vertex count instead of assuming.
  const quads = (n - 1) * (n - 1);
  const IndexArray = n * n > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(quads * 6);
  let o = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices[o++] = a; indices[o++] = c; indices[o++] = b;
      indices[o++] = b; indices[o++] = c; indices[o++] = d;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeVertexNormals(); // needed for lighting to read slopes at all

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.matrixAutoUpdate = false; // static geometry; skip per-frame matrix recomputation
  return mesh;
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function disposeMesh(mesh) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}

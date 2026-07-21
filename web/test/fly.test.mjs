import * as THREE from 'three';
import { flyDelta } from '../src/fly.js';

let bad = 0;
const ok = (label, cond, extra = '') => {
  if (cond) console.log(`  ok    ${label}`);
  else { bad++; console.log(`  FAIL  ${label} ${extra}`); }
};
const K = (...k) => new Set(k);

// A camera at altitude looking north-west and downward — a realistic map pose, not an
// axis-aligned one that would hide a handedness error.
function cam(yaw = 0, pitch = -0.6, y = 300) {
  const c = new THREE.PerspectiveCamera(55, 1.5, 1, 6000);
  c.position.set(0, y, 0);
  c.rotation.order = 'YXZ';
  c.rotation.set(pitch, yaw, 0);
  c.updateMatrixWorld(true);
  return c;
}

const dt = 1 / 60;
const c = cam();
const fwdFlat = new THREE.Vector3();
c.getWorldDirection(fwdFlat); fwdFlat.y = 0; fwdFlat.normalize();

const w = flyDelta(K('KeyW'), c, dt).clone();
ok('W travels along the flattened view direction',
   w.clone().setY(0).normalize().distanceTo(fwdFlat) < 1e-6, `got ${w.toArray()}`);

const s = flyDelta(K('KeyS'), c, dt).clone();
ok('S is exactly opposite W', s.clone().add(w).length() < 1e-6);

const d = flyDelta(K('KeyD'), c, dt).clone();
const a = flyDelta(K('KeyA'), c, dt).clone();
ok('A is exactly opposite D', a.clone().add(d).length() < 1e-6);
ok('D is perpendicular to forward', Math.abs(d.clone().setY(0).normalize().dot(fwdFlat)) < 1e-6);
// Right-handed check: forward x right must point DOWN (-Y) for a right-handed basis with +Y up,
// i.e. D is to the camera's right, not its left. This is the bug that swaps A and D.
ok('D is the camera\'s right, not its left',
   fwdFlat.clone().cross(d.clone().setY(0).normalize()).y < 0);

// Diagonals must not be faster.
const wd = flyDelta(K('KeyW', 'KeyD'), c, dt).clone();
ok('diagonal speed equals cardinal speed', Math.abs(wd.length() - w.length()) < 1e-9,
   `${wd.length()} vs ${w.length()}`);

// Vertical.
const up = flyDelta(K('Space'), c, dt).clone();
ok('Space is purely vertical, upward', up.x === 0 && up.z === 0 && up.y > 0);
const dn = flyDelta(K('ShiftLeft'), c, dt).clone();
ok('Shift is purely vertical, downward', dn.x === 0 && dn.z === 0 && dn.y < 0);

// Opposing keys cancel; no keys is null.
ok('W+S cancels to null', flyDelta(K('KeyW', 'KeyS'), c, dt) === null);
ok('no keys returns null', flyDelta(K(), c, dt) === null);
ok('unrelated keys return null', flyDelta(K('KeyQ', 'Enter'), c, dt) === null);

// Arrows mirror WASD.
ok('ArrowUp matches W', flyDelta(K('ArrowUp'), c, dt).distanceTo(w) < 1e-9);
ok('ArrowRight matches D', flyDelta(K('ArrowRight'), c, dt).distanceTo(d) < 1e-9);

// --- looking straight down: the degenerate case for a flattened forward ---
//
// This originally only asserted the delta was finite and non-zero. It passed while the code
// fell back to a FIXED world axis, so W moved the same compass direction no matter which way
// the camera was turned — smooth, finite, and wrong. Finiteness was never the property that
// mattered; direction was.
const down = cam(0, -Math.PI / 2);
const dd = flyDelta(K('KeyW'), down, dt);
ok('looking straight down yields a finite delta',
   dd && Number.isFinite(dd.x) && Number.isFinite(dd.z) && dd.length() > 0, `got ${dd?.toArray()}`);

// Screen-up maps to a world direction even when the view direction is vertical; W must follow
// it, so that yawing the camera yaws the movement.
for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 4, 2.3]) {
  const c2 = cam(yaw, -Math.PI / 2);
  const want = new THREE.Vector3(0, 1, 0).applyQuaternion(c2.quaternion).setY(0).normalize();
  const got = flyDelta(K('KeyW'), c2, dt).clone().setY(0).normalize();
  ok(`straight down, yaw ${yaw.toFixed(2)}: W follows screen-up`,
     got.distanceTo(want) < 1e-6, `got ${got.toArray().map(n => n.toFixed(3))} want ${want.toArray().map(n => n.toFixed(3))}`);
}

// The decisive property: two different yaws must give two different movement directions.
const d0 = flyDelta(K('KeyW'), cam(0, -Math.PI / 2), dt).clone().setY(0).normalize();
const d90 = flyDelta(K('KeyW'), cam(Math.PI / 2, -Math.PI / 2), dt).clone().setY(0).normalize();
ok('straight down: yaw changes the direction of travel', d0.distanceTo(d90) > 0.5,
   `yaw 0 -> ${d0.toArray().map(n => n.toFixed(3))}, yaw 90 -> ${d90.toArray().map(n => n.toFixed(3))}`);

// A/D must stay perpendicular to W and keep their handedness in this pose too.
const dnA = flyDelta(K('KeyA'), down, dt).clone().setY(0).normalize();
const dnD = flyDelta(K('KeyD'), down, dt).clone().setY(0).normalize();
const dnW = dd.clone().setY(0).normalize();
ok('straight down: D is perpendicular to W', Math.abs(dnD.dot(dnW)) < 1e-6);
ok('straight down: A is opposite D', dnA.clone().add(dnD).length() < 1e-6);
ok('straight down: D is still the camera\'s right', dnW.clone().cross(dnD).y < 0);

// Altitude scaling, and its floor.
const hi = flyDelta(K('KeyW'), cam(0, -0.6, 2000), dt).length();
const lo = flyDelta(K('KeyW'), cam(0, -0.6, 300), dt).length();
const floor1 = flyDelta(K('KeyW'), cam(0, -0.6, 1), dt).length();
const floor2 = flyDelta(K('KeyW'), cam(0, -0.6, 40), dt).length();
ok('speed grows with altitude', hi > lo);
ok('speed has a floor near the ground', Math.abs(floor1 - floor2) < 1e-9);

// Yaw must rotate the movement basis.
const east = cam(-Math.PI / 2);
const we = flyDelta(K('KeyW'), east, dt).clone().setY(0).normalize();
ok('yaw rotates the movement basis', we.distanceTo(fwdFlat) > 0.5, `got ${we.toArray()}`);

console.log(bad ? `\n${bad} FAILURE(S)` : '\nall flight-math checks passed');
process.exit(bad ? 1 : 0);

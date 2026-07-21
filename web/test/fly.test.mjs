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

// Straight down must not produce NaN — the degenerate case for a flattened forward.
const down = cam(0, -Math.PI / 2);
const dd = flyDelta(K('KeyW'), down, dt);
ok('looking straight down yields a finite delta',
   dd && Number.isFinite(dd.x) && Number.isFinite(dd.z) && dd.length() > 0, `got ${dd?.toArray()}`);

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

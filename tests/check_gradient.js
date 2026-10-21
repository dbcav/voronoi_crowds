// Checks that the Voronoi pressure force is exactly -dE/dx (finite differences).
// Run from this folder:  node check_gradient.js
require("../js/voronoi.js"); require("../js/shapes.js"); require("../js/swarm.js");

const S = new VC.Swarm();
Object.assign(S.p, { n: 200, scene: "open" });
S.p.start.R = 0.14; S.p.start.shape = "pair";
S.reset();
const n = S.p.n, g = S.p.gamma;
const rnd = VC.rng(3);
for (let i = 0; i < 2 * n; i++) S.x[i] += 0.006 * (rnd() - 0.5); // ragged crowd edge

function energy() {
  S.geometry(false);
  let e = 0;
  for (let i = 0; i < n; i++) { const A = S.cap.area[i]; e += (A * Math.pow(S.a0 / A, g)) / (g - 1); }
  return e;
}
energy();
const C = (S.p.strength * S.p.speed) / (Math.PI * S.p.personal * S.r); // velocity = -C dE/dx
const v = new Float64Array(2 * n);
S.pressureVelocity(v);

let worst = 0;
const h = 1e-7;
for (let i = 0; i < n; i += 7) for (const c of [0, 1]) {
  const x0 = S.x[2 * i + c];
  S.x[2 * i + c] = x0 + h; const ep = energy();
  S.x[2 * i + c] = x0 - h; const em = energy();
  S.x[2 * i + c] = x0;
  const fd = (ep - em) / (2 * h), formula = -v[2 * i + c] / C;
  worst = Math.max(worst, Math.abs(fd - formula) / (Math.abs(fd) + 1e-14));
}
console.log(`largest relative gap between formula and finite differences: ${worst.toExponential(2)}`);
console.log(worst < 1e-5 ? "OK: the pressure force is the exact gradient of the crowding energy" : "MISMATCH");

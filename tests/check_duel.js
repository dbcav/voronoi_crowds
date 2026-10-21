// Solves the game, draws N agents from its starting density, and checks that agents
// following the equilibrium pay what the equilibrium says, term by term.
// Run from this folder:  node check_duel.js [scene] [agents]
require("../js/voronoi.js"); require("../js/shapes.js"); require("../js/swarm.js"); require("../js/mfg.js"); require("../js/duel.js");

const S = new VC.MFG();
S.p.scene = process.argv[2] || "twodoors";
S.buildMesh();
const aware = S.solveSync(), blind = S.solveSync(0);
S.solveSync(); // leave the mesh's geodesic data consistent (same for both)
const f = (x) => x.toFixed(3);
const t0 = performance.now();
const D = new VC.Duel(); D.p.n = +(process.argv[3] || 300);
D.setup(S, aware, blind);
while (!D.finished) D.step();
console.log(`simulated ${D.p.n} agents x 3 crowds in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const e = D.equilibriumCost();
console.log(`equilibrium        ${f(e.total)} = move ${f(e.move)} + crowd ${f(e.crowd)} + left ${f(e.terminal)}`);
for (const [k, name] of [["plan", "planning"], ["blind", "crowd-blind plan"], ["react", "reacting"]]) {
  const s = D.summary(k);
  console.log(`${name.padEnd(18)} ${f(s.total)} = move ${f(s.move)} + crowd ${f(s.crowd)} + left ${f(s.terminal)} | reached ${(100 * s.arrived).toFixed(0)}% | doors ${s.doors} | most touching ${s.peakTouch}`);
}

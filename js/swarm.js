/*
 * Sheet 1: a live, myopic crowd whose agents are the Voronoi seeds.
 *
 * Crowding energy      E(X) = sum_i |V_i| U(rho_i),  rho_i = a0 / |V_i|,
 *                      U(rho) = rho^g / (g - 1),     pressure P = rho U' - U = rho^g.
 * Its exact gradient   dE/dx_i = - sum_j (S_ij / d_ij) (P_i - P_j) (c_ij - x_i)
 * (S_ij shared edge length, d_ij seed distance, c_ij edge midpoint) only needs
 * the agent's own cell and its neighbours' pressures, so every agent can compute
 * it locally. The "Voronoi pressure" model is gradient descent on E, plus a
 * walking drift toward each agent's own target. Faces shared with walls are
 * treated as rigid and contribute nothing.
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});

  const DOOR = { x: 0.5, w: 0.03, h: 0.14 }; // vertical wall with a door, centred
  const PILLARS = (() => {
    const out = [];
    const cols = [0.38, 0.5, 0.62];
    cols.forEach((x, c) => {
      const ys = c === 1 ? [0.28, 0.5, 0.72] : [0.17, 0.39, 0.61, 0.83];
      ys.forEach((y) => out.push({ x, y, r: 0.04 }));
    });
    return out;
  })();
  VC.SCENES = [
    { id: "open", label: "Open floor" },
    { id: "door", label: "Wall with a door" },
    { id: "pillars", label: "Pillars" },
  ];

  function sceneObstacles(scene) {
    if (scene === "door") {
      const x0 = DOOR.x - DOOR.w / 2, x1 = DOOR.x + DOOR.w / 2;
      const lo = 0.5 - DOOR.h / 2, hi = 0.5 + DOOR.h / 2;
      return {
        rects: [ { x0, y0: 0, x1, y1: lo }, { x0, y0: hi, x1, y1: 1 } ],
        circles: [],
        door: { x0, x1, lo, hi },
      };
    }
    if (scene === "pillars") return { rects: [], circles: PILLARS.slice(), door: null };
    return { rects: [], circles: [], door: null };
  }
  VC.sceneObstacles = sceneObstacles;

  // Static "ghost" seeds lining every obstacle surface. They take part in the
  // tessellation (so agent cells stop at walls) but never move.
  function ghostSeeds(obs, spacing) {
    const pts = [];
    for (const r of obs.rects) {
      const edges = [ [r.x0, r.y0, r.x1, r.y0], [r.x1, r.y0, r.x1, r.y1], [r.x1, r.y1, r.x0, r.y1], [r.x0, r.y1, r.x0, r.y0] ];
      for (const [ax, ay, bx, by] of edges) {
        const L = Math.hypot(bx - ax, by - ay);
        const m = Math.max(1, Math.ceil(L / spacing));
        for (let k = 0; k < m; k++) {
          const t = k / m;
          const px = ax + t * (bx - ax), py = ay + t * (by - ay);
          if (px <= 1e-9 || px >= 1 - 1e-9 || py <= 1e-9 || py >= 1 - 1e-9) continue;
          pts.push(px, py);
        }
      }
      // a spine down the middle keeps the two faces from seeing each other
      const cxm = 0.5 * (r.x0 + r.x1);
      const m = Math.ceil((r.y1 - r.y0) / spacing);
      for (let k = 1; k < m; k++) pts.push(cxm, r.y0 + (k / m) * (r.y1 - r.y0));
    }
    for (const c of obs.circles) {
      const m = Math.max(12, Math.ceil((2 * Math.PI * c.r) / spacing));
      for (let k = 0; k < m; k++) {
        const th = (2 * Math.PI * k) / m;
        pts.push(c.x + c.r * Math.cos(th), c.y + c.r * Math.sin(th));
      }
      pts.push(c.x, c.y);
    }
    return new Float64Array(pts);
  }

  class Swarm {
    constructor() {
      this.p = {
        n: 300,
        pressure: true,       // Voronoi crowd pressure on/off
        repulsion: false,     // short-range pairwise repulsion on/off
        strength: 1.0,        // multiplier on the Voronoi pressure
        repStrength: 1.0,     // multiplier on the pairwise repulsion
        personal: 1.8,        // comfort radius / body radius
        gamma: 6,             // pressure stiffness
        bubble: 1.6,          // cells are capped by a disk of radius bubble * comfort radius
        noise: 0.0,           // diffusion coefficient
        speed: 0.12,          // preferred walking speed (domain units / s)
        scene: "door",
        start: { shape: "disk", x: 0.22, y: 0.5, R: 0.16 },
        target: { shape: "disk", x: 0.78, y: 0.5, R: 0.19 },
        matching: "optimal",  // optimal | mirrored | shuffled
        seed: 1,
      };
      this.history = [];
      this.reset();
    }

    get bodyRadius() {
      if (this.radiusOverride) return this.radiusOverride;
      return Math.min(0.02, Math.max(0.0025, 0.1 / Math.sqrt(this.p.n)));
    }

    reset() {
      const p = this.p, n = p.n;
      this.rnd = VC.rng(p.seed * 7919 + n);
      this.r = this.bodyRadius;
      this.obs = sceneObstacles(p.scene);
      this.ghosts = ghostSeeds(this.obs, Math.max(0.0045, Math.min(0.009, this.r)));
      this.nG = this.ghosts.length / 2;
      this.x = VC.layout(p.start.shape, n, p.start.x, p.start.y, p.start.R, this.rnd, 0.15 * this.r);
      for (let i = 0; i < n; i++) this.project(i);
      this.vx = new Float64Array(n); this.vy = new Float64Array(n);
      this.t = 0;
      this.touching = new Uint8Array(n);
      this.peakTouching = 0;
      this.arrivedAt = null;
      this.history = [];
      this.assignTargets();
      this.geometry();
      this.measure();
    }

    /**
     * Put this crowd in an arbitrary room of rectangular walls, at the given
     * positions, all heading for one target point (used by the comparison sheet).
     */
    useRoom(rects, positions, target) {
      const n = this.p.n;
      this.r = this.bodyRadius;
      this.obs = { rects, circles: [], door: null };
      this.ghosts = ghostSeeds(this.obs, Math.max(0.0045, Math.min(0.009, this.r)));
      this.nG = this.ghosts.length / 2;
      this.x = Float64Array.from(positions);
      for (let i = 0; i < n; i++) this.project(i);
      this.tgt = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) { this.tgt[2 * i] = target.x; this.tgt[2 * i + 1] = target.y; }
      this.vx = new Float64Array(n); this.vy = new Float64Array(n);
      this.t = 0; this.history = []; this.touching = new Uint8Array(n);
      this.peakTouching = 0; this.arrivedAt = null;
      this.geometry();
      this.measure();
    }

    /** Re-lay agents at the start region without re-matching (cheap; used while dragging). */
    previewStart() {
      const p = this.p;
      this.x = VC.layout(p.start.shape, p.n, p.start.x, p.start.y, p.start.R, VC.rng(p.seed * 7919 + p.n), 0.15 * this.r);
      for (let i = 0; i < p.n; i++) this.project(i);
      this.t = 0;
      this.touching = new Uint8Array(p.n);
      this.geometry();
    }

    /** Re-sample target points and match them to agents (from start layout). */
    assignTargets(fromCurrent) {
      const p = this.p, n = p.n;
      const Q = VC.layout(p.target.shape, n, p.target.x, p.target.y, p.target.R, this.rnd, 0);
      const P = fromCurrent ? this.x : VC.layout(p.start.shape, n, p.start.x, p.start.y, p.start.R, null, 0);
      let perm;
      if (p.matching === "shuffled") perm = VC.assignShuffled(n, VC.rng(p.seed * 31 + 5));
      else if (p.matching === "mirrored") {
        // reflect each agent through the start centre, then match optimally:
        // everyone heads for the far side of the target — a head-on crossing.
        const M = new Float64Array(2 * n);
        const sx = fromCurrent ? mean(P, 0, n) : p.start.x, sy = fromCurrent ? mean(P, 1, n) : p.start.y;
        const scale = p.target.R / Math.max(p.start.R, 1e-6);
        for (let i = 0; i < n; i++) {
          M[2 * i] = p.target.x - (P[2 * i] - sx) * scale;
          M[2 * i + 1] = p.target.y - (P[2 * i + 1] - sy) * scale;
        }
        perm = VC.assignOptimal(M, Q, n);
      } else perm = VC.assignOptimal(P, Q, n);
      this.tgt = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        this.tgt[2 * i] = Q[2 * perm[i]];
        this.tgt[2 * i + 1] = Q[2 * perm[i] + 1];
      }
      this.clampTargets();
    }

    /** Shift all targets rigidly (used while dragging the target handle). */
    shiftTargets(dx, dy) {
      for (let i = 0; i < this.p.n; i++) { this.tgt[2 * i] += dx; this.tgt[2 * i + 1] += dy; }
      this.clampTargets();
    }

    clampTargets() {
      // keep every target spot reachable: out of walls and pillars, inside the room
      for (let i = 0; i < this.p.n; i++) {
        const q = this.pushOut(this.tgt[2 * i], this.tgt[2 * i + 1], 1.5 * this.r);
        this.tgt[2 * i] = q[0]; this.tgt[2 * i + 1] = q[1];
      }
    }

    /** Nearest point outside walls/pillars (expanded by margin) and inside the box. */
    pushOut(px, py, margin) {
      const r = margin, o = this.obs;
      for (const R of o.rects) {
        const ax0 = R.x0 - r, ax1 = R.x1 + r, ay0 = R.y0 - (R.y0 > 0 ? r : 1), ay1 = R.y1 + (R.y1 < 1 ? r : 1);
        if (px > ax0 && px < ax1 && py > ay0 && py < ay1) {
          const dl = px - ax0, dr = ax1 - px, dd = py - ay0, du = ay1 - py;
          const m = Math.min(dl, dr, dd, du);
          if (m === dl) px = ax0; else if (m === dr) px = ax1; else if (m === dd) py = ay0; else py = ay1;
        }
      }
      for (const c of o.circles) {
        const dx = px - c.x, dy = py - c.y, d = Math.hypot(dx, dy), R = c.r + r;
        if (d < R) {
          if (d < 1e-9) { px = c.x + R; } else { px = c.x + (dx / d) * R; py = c.y + (dy / d) * R; }
        }
      }
      return [Math.min(1 - r, Math.max(r, px)), Math.min(1 - r, Math.max(r, py))];
    }

    /** Push agent i out of walls/pillars and back into the box. */
    project(i) {
      const q = this.pushOut(this.x[2 * i], this.x[2 * i + 1], this.r);
      this.x[2 * i] = q[0]; this.x[2 * i + 1] = q[1];
    }

    /** Tessellate agents + wall ghosts; cap cells by personal disks; density and pressure. */
    geometry(wantOutline) {
      const n = this.p.n, nG = this.nG, N = n + nG;
      if (!this.sx || this.sx.length !== N) { this.sx = new Float64Array(N); this.sy = new Float64Array(N); }
      for (let i = 0; i < n; i++) { this.sx[i] = this.x[2 * i]; this.sy[i] = this.x[2 * i + 1]; }
      for (let g = 0; g < nG; g++) { this.sx[n + g] = this.ghosts[2 * g]; this.sy[n + g] = this.ghosts[2 * g + 1]; }
      const rc = this.p.personal * this.r;
      this.a0 = Math.PI * rc * rc;
      this.Rs = this.p.bubble * rc;
      // cells only matter inside each agent's bubble, so truncate them there
      this.vor = VC.voronoi(this.sx, this.sy, N, { x0: 0, y0: 0, x1: 1, y1: 1 }, { maxR: this.Rs * 1.001 });
      this.cap = VC.capCells(this.vor, this.sx, this.sy, n, this.Rs, wantOutline !== false);
      this.rho = new Float64Array(n); this.P = new Float64Array(n);
      const g = this.p.gamma;
      let E = 0;
      for (let i = 0; i < n; i++) {
        const A = Math.max(this.cap.area[i], 1e-14);
        const rho = this.a0 / A;
        this.rho[i] = rho; this.P[i] = Math.pow(Math.min(rho, 6), g);
        E += (A * this.P[i]) / (g - 1);
      }
      this.energy = E / (n * this.a0); // per unit of personal area, comparable across n
    }

    pressureVelocity(out, stiff) {
      // v_i = C [ sum_j (S_ij/d_ij)(P_i - P_j)(c_ij - x_i) + P_i * (integral of n over the cell's arc) ]
      // which is -C dE/dx_i for the disk-capped energy (wall faces held rigid).
      const n = this.p.n, f = this.cap, x = this.x;
      const rc = this.p.personal * this.r;
      const C = (this.p.strength * this.p.speed) / (Math.PI * rc); // = k v0 rc / a0
      for (let i = 0; i < n; i++) {
        const xi = x[2 * i], yi = x[2 * i + 1], Pi = this.P[i];
        let fx = Pi * f.arcX[i], fy = Pi * f.arcY[i], Pm = Pi;
        for (let k = f.nbrStart[i]; k < f.nbrStart[i + 1]; k++) {
          const j = f.nbr[k];
          if (j >= n) continue; // rigid wall face
          const d = Math.hypot(x[2 * j] - xi, x[2 * j + 1] - yi);
          if (d < 1e-12) continue;
          const w = (f.faceLen[k] / d) * (Pi - this.P[j]);
          fx += w * (f.faceMx[k] - xi);
          fy += w * (f.faceMy[k] - yi);
          if (this.P[j] > Pm) Pm = this.P[j];
        }
        out[2 * i] += C * fx; out[2 * i + 1] += C * fy;
        if (stiff) stiff[i] += 0.5 * C * this.p.gamma * Pm;
      }
    }

    // Uniform-grid neighbour search for repulsion and contact counting.
    buildHash(cell) {
      const n = this.p.n, x = this.x;
      const m = Math.max(1, Math.floor(1 / cell));
      const head = new Int32Array(m * m).fill(-1), next = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const gx = Math.min(m - 1, Math.max(0, Math.floor(x[2 * i] * m)));
        const gy = Math.min(m - 1, Math.max(0, Math.floor(x[2 * i + 1] * m)));
        const c = gy * m + gx; next[i] = head[c]; head[c] = i;
      }
      return { m, head, next };
    }

    forEachPair(radius, fn) {
      const h = this.buildHash(Math.max(radius, 1e-3)), x = this.x, n = this.p.n, r2 = radius * radius;
      for (let i = 0; i < n; i++) {
        const gx = Math.min(h.m - 1, Math.max(0, Math.floor(x[2 * i] * h.m)));
        const gy = Math.min(h.m - 1, Math.max(0, Math.floor(x[2 * i + 1] * h.m)));
        for (let dy = -1; dy <= 1; dy++) {
          const yy = gy + dy; if (yy < 0 || yy >= h.m) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = gx + dx; if (xx < 0 || xx >= h.m) continue;
            for (let j = h.head[yy * h.m + xx]; j >= 0; j = h.next[j]) {
              if (j <= i) continue;
              const ddx = x[2 * i] - x[2 * j], ddy = x[2 * i + 1] - x[2 * j + 1];
              const d2 = ddx * ddx + ddy * ddy;
              if (d2 < r2) fn(i, j, ddx, ddy, Math.sqrt(d2));
            }
          }
        }
      }
    }

    repulsionVelocity(out, stiff) {
      const rc = this.p.personal * this.r, R = 2 * rc;
      const C = this.p.repStrength * this.p.speed;
      const dmin = 0.3 * this.r;
      this.forEachPair(R, (i, j, dx, dy, d) => {
        const dd = Math.max(d, dmin);
        const w = (C * (1 - dd / R) * (rc / dd) * (rc / dd)) / Math.max(d, 1e-12);
        out[2 * i] += w * dx; out[2 * i + 1] += w * dy;
        out[2 * j] -= w * dx; out[2 * j + 1] -= w * dy;
        if (stiff) {
          const k = (2 * C * rc * rc) / (dd * dd * dd);
          stiff[i] += k; stiff[j] += k;
        }
      });
    }

    /** Desired walking velocity toward the target (with door/pillar routing). */
    walkVelocity(out) {
      const n = this.p.n, x = this.x, tg = this.tgt, v0 = this.p.speed, r = this.r;
      const o = this.obs, door = o.door;
      const slow = 4 * r;
      for (let i = 0; i < n; i++) {
        let px = x[2 * i], py = x[2 * i + 1];
        let gx = tg[2 * i], gy = tg[2 * i + 1];
        let waypoint = false;
        if (door) {
          const half = DOOR.w / 2, side = Math.sign(px - 0.5) || 1, tside = Math.sign(gx - 0.5) || 1;
          const lo = door.lo + 1.6 * r, hi = door.hi - 1.6 * r;
          const inCorridor = Math.abs(px - 0.5) < half + 2 * r && py > door.lo && py < door.hi;
          if (inCorridor) {
            // keep walking straight through and out the other side
            gx = 0.5 + tside * (half + 0.05); gy = Math.min(hi, Math.max(lo, py)); waypoint = true;
          } else if (side !== tside) {
            // Head straight for a point beyond the opening if it is visible
            // through the door; otherwise round the nearer door post.
            const fx = 0.5 + tside * (half + 0.05), fy = Math.min(hi, Math.max(lo, py));
            const nearX = 0.5 - tside * half, farX = 0.5 + tside * half;
            const yAt = (X) => py + ((X - px) / (fx - px || 1e-9)) * (fy - py);
            const y1 = yAt(nearX), y2 = yAt(farX);
            if (y1 > door.lo + r && y1 < door.hi - r && y2 > door.lo + r && y2 < door.hi - r) {
              gx = fx; gy = fy;
            } else {
              gx = 0.5 - tside * (half + 3 * r);
              gy = py > hi ? hi : lo;
            }
            waypoint = true;
          }
        }
        let dx = gx - px, dy = gy - py;
        const d = Math.hypot(dx, dy);
        const s = v0 / Math.max(d, waypoint ? 1e-9 : slow);
        let vx = s * dx, vy = s * dy;
        for (const c of o.circles) {
          const ex = px - c.x, ey = py - c.y, de = Math.hypot(ex, ey);
          if (de < c.r + 5 * r && de > 1e-9) {
            const nx = ex / de, ny = ey / de, vn = vx * nx + vy * ny;
            if (vn < 0) {
              // swap the head-on part of the step for a sideways one
              const sp = Math.hypot(vx, vy);
              let tx = vx - vn * nx, ty = vy - vn * ny;
              let tl = Math.hypot(tx, ty);
              if (tl < 1e-6 * sp) { tx = -ny; ty = nx; tl = 1; }
              vx = (tx / tl) * sp; vy = (ty / tl) * sp;
            }
          }
        }
        out[2 * i] = vx; out[2 * i + 1] = vy;
      }
    }

    step(dt) {
      const n = this.p.n, x = this.x, v = new Float64Array(2 * n);
      const stiff = new Float64Array(n);
      this.walkVelocity(v);
      if (this.p.pressure) this.pressureVelocity(v, stiff);
      if (this.p.repulsion) this.repulsionVelocity(v, stiff);
      const cap = 3 * this.p.speed;
      const sig = Math.sqrt(2 * this.p.noise * dt);
      for (let i = 0; i < n; i++) {
        // Dividing the whole velocity by (1 + dt*stiffness) is a backward-Euler
        // step on the diagonal: stable for stiff pressure, same resting states,
        // and agents in a tight crowd simply move more slowly.
        const damp = 1 / (1 + dt * stiff[i]);
        let vx = v[2 * i] * damp, vy = v[2 * i + 1] * damp;
        const s = Math.hypot(vx, vy);
        if (s > cap) { vx *= cap / s; vy *= cap / s; }
        this.vx[i] = vx; this.vy[i] = vy;
        x[2 * i] += dt * vx; x[2 * i + 1] += dt * vy;
        if (sig > 0) { x[2 * i] += sig * VC.gauss(this.rnd); x[2 * i + 1] += sig * VC.gauss(this.rnd); }
        if (this.noiseHook) this.noiseHook(i, dt);
        this.project(i);
      }
      this.t += dt;
      // agents that never use pressure and are never drawn as cells can skip the tessellation
      if (!this.skipGeometry || this.p.pressure) this.geometry();
      this.measure();
    }

    measure() {
      const n = this.p.n, r = this.r;
      let touching = 0;
      this.touching.fill(0);
      this.forEachPair(2 * r, (i, j) => { touching++; this.touching[i] = 1; this.touching[j] = 1; });
      this.touchingNow = touching;
      this.peakTouching = Math.max(this.peakTouching || 0, touching);
      let arrived = 0;
      for (let i = 0; i < n; i++) {
        if (Math.hypot(this.x[2 * i] - this.tgt[2 * i], this.x[2 * i + 1] - this.tgt[2 * i + 1]) < 2.5 * r) arrived++;
      }
      this.arrived = arrived / n;
      if (this.arrivedAt == null && this.arrived >= 0.95) this.arrivedAt = this.t;
      this.history.push(this.t, touching);
      if (this.history.length > 2 * 7200) this.history.splice(0, 2);
    }
  }

  function mean(A, off, n) { let s = 0; for (let i = 0; i < n; i++) s += A[2 * i + off]; return s / n; }

  VC.Swarm = Swarm;
  VC.DOOR = DOOR;
  VC.ghostSeeds = ghostSeeds;
})(typeof window !== "undefined" ? window : globalThis);

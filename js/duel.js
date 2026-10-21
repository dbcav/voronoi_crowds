/*
 * From the equilibrium back to agents.
 *
 * N starting spots are drawn once from the equilibrium's initial density m0.
 * Three crowds start from them, in the same room with the same target zone,
 * horizon T, top speed and randomness:
 *
 *  - react: walks down the terminal cost (urgency x walking distance to the
 *    target zone), i.e. a zero-horizon plan, and reacts to the crowd it sees
 *    right now through Voronoi pressure (sheet 1's force).
 *  - plan:  every agent applies the crowd-aware equilibrium feedback,
 *    v = -grad u(t, x), read off the discrete controls, plus the spread of the
 *    equilibrium's own jump process. Agents never look at each other.
 *  - blind: the same, with the crowd-blind equilibrium (kappa = 0).
 *
 * Every agent is billed with the game's cost (with the real kappa, so
 * crowd-blind plans pay for the crowding they cause):
 *   int_0^T ( |v|^2 / 2 + kappa * m_hat(t, x) ) dt + urgency * D(x_T),
 * where m_hat is the crowd's own density on the game's mesh, pooled over each
 * cell and its neighbours, leaving the agent itself out (unbiased).
 *
 * Every step is recorded so the page can scrub back and forth.
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});
  const KEYS = ["react", "plan", "blind"];

  class Duel {
    constructor() {
      this.p = { n: 300, pressure: true, repulsion: false, spread: true, seed: 11, steps: 320 };
      this.ready = false;
    }

    /**
     * @param {VC.MFG} mfg   solved game (mesh, params, geodesic distance)
     * @param {object} aware result of mfg.solve(kappa)
     * @param {object} blind result of mfg.solve(0)
     */
    setup(mfg, aware, blind) {
      const M = mfg.mesh, P = mfg.p, n = this.p.n;
      this.M = M; this.aware = aware; this.blind = blind;
      this.T = P.T; this.kappa = P.kappa; this.urgency = P.urgency; this.nu = P.nu;
      this.dt = P.T / this.p.steps;
      this.walls = VC.mfgWalls(P.scene); this.target = { ...P.target }; this.start = { ...P.start };
      this.scene = P.scene;
      this.geo = Float64Array.from(mfg.geo);
      this._eq = null; this.poolArea = null;
      this.buildLookup();

      // bodies: the densest part of m0 sits at comfort spacing, pi (1.8 r)^2 = 1 / (N max m0)
      let m0max = 0; for (let i = 0; i < M.n; i++) m0max = Math.max(m0max, aware.m0[i]);
      this.m0max = m0max;
      this.radius = Math.sqrt(1 / (n * m0max * Math.PI)) / 1.8;

      this.startPos = this.sampleStart(aware.m0, n, VC.rng(this.p.seed * 977 + n));
      const self = this;
      const make = (pressure, plan) => {
        const s = new VC.Swarm();
        s.p.n = n; s.p.scene = "open"; s.radiusOverride = this.radius;
        s.p.pressure = pressure; s.p.repulsion = this.p.repulsion;
        s.p.speed = this.urgency; s.p.noise = this.nu;
        s.reset();
        s.useRoom(this.walls, this.startPos, this.target);
        s.skipGeometry = true;
        if (!plan) {
          const field = this.cellVelocity(aware.g, null); // zero-horizon value = terminal cost
          s.walkVelocity = function (out) { self.fieldVelocity(this, field, out); };
        } else {
          const cache = new Map(), covs = new Map();
          s.walkVelocity = function (out) { self.fieldVelocity(this, self.planField(plan, this.t, cache), out); };
          if (this.p.spread) {
            s.p.noise = 0; // the jump-process spread below already contains nu
            s.noiseHook = function (i, dt) {
              const C = self.planCov(plan, this.t, covs), c = self.cellAt(this.x[2 * i], this.x[2 * i + 1]);
              const a = C.xx[c], b = C.xy[c], d = C.yy[c];
              const l11 = Math.sqrt(Math.max(a, 0)), l21 = l11 > 0 ? b / l11 : 0, l22 = Math.sqrt(Math.max(d - l21 * l21, 0));
              const sq = Math.sqrt(dt), z1 = VC.gauss(this.rnd), z2 = VC.gauss(this.rnd);
              this.x[2 * i] += sq * l11 * z1; this.x[2 * i + 1] += sq * (l21 * z1 + l22 * z2);
            };
          }
        }
        return s;
      };
      this.crowds = { react: make(this.p.pressure, null), plan: make(false, aware), blind: make(false, blind) };
      this.stats = {};
      this.frames = { t: [] };
      for (const k of KEYS) {
        this.stats[k] = {
          move: new Float64Array(n), crowd: new Float64Array(n), peakRel: 0, peakTouch: 0,
          side: Int8Array.from({ length: n }, (_, i) => Math.sign(this.startPos[2 * i] - 0.5)), door: new Int8Array(n).fill(-1),
          done: false,
        };
        this.frames[k] = { pos: [], touch: [], count: [] };
      }
      this.frames.reactDens = [];
      this.record();
      this.ready = true;
    }

    /* ---------- fields read off the mesh ---------- */

    buildLookup() {
      const M = this.M, G = Math.max(4, Math.round(Math.sqrt(M.n) / 1.5));
      const cells = Array.from({ length: G * G }, () => []);
      for (let i = 0; i < M.n; i++) {
        const gx = Math.min(G - 1, Math.floor(M.xs[i] * G)), gy = Math.min(G - 1, Math.floor(M.ys[i] * G));
        cells[gy * G + gx].push(i);
      }
      this.grid = { G, cells };
      this.h2 = 1 / M.n;
    }

    cellAt(x, y) {
      const { G, cells } = this.grid, M = this.M;
      const gx = Math.min(G - 1, Math.max(0, Math.floor(x * G))), gy = Math.min(G - 1, Math.max(0, Math.floor(y * G)));
      let best = -1, bd = Infinity;
      for (let r = 0; r <= G; r++) {
        for (let yy = Math.max(0, gy - r); yy <= Math.min(G - 1, gy + r); yy++)
          for (let xx = Math.max(0, gx - r); xx <= Math.min(G - 1, gx + r); xx++) {
            if (Math.max(Math.abs(xx - gx), Math.abs(yy - gy)) !== r) continue;
            for (const i of cells[yy * G + xx]) {
              const d = (M.xs[i] - x) ** 2 + (M.ys[i] - y) ** 2;
              if (d < bd) { bd = d; best = i; }
            }
          }
        if (best >= 0 && r >= 1 && Math.sqrt(bd) < r / G) break;
      }
      return best;
    }

    /** cell drift v_i = sum_j S_ij b_ij n_ij / |V_i|, with b = (phi_i - phi_j)^+ or given face controls */
    cellVelocity(phi, bFace) {
      const M = this.M, vx = new Float64Array(M.n), vy = new Float64Array(M.n);
      for (let i = 0; i < M.n; i++) {
        let sx = 0, sy = 0;
        for (let k = M.start[i]; k < M.start[i + 1]; k++) {
          const b = bFace ? bFace[k] : Math.max(0, phi[i] - phi[M.nbr[k]]), w = M.tau[k] * M.dist[k] * b;
          sx += w * M.nx[k]; sy += w * M.ny[k];
        }
        vx[i] = sx / M.area[i]; vy[i] = sy / M.area[i];
      }
      return { vx, vy };
    }

    stepIndex(sol, t) { const Nt = sol.bHist.length; return Math.min(Nt - 1, Math.max(0, Math.floor((t / this.T) * Nt))); }

    planField(sol, t, cache) {
      const k = this.stepIndex(sol, t);
      let v = cache.get(k);
      if (!v) { v = this.cellVelocity(null, sol.bHist[k]); cache.set(k, v); }
      return v;
    }

    /** covariance rate of the equilibrium's jump process: sum_j rate_ij d_ij^2 n n^T */
    planCov(sol, t, cache) {
      const k = this.stepIndex(sol, t);
      let C = cache.get(k);
      if (C) return C;
      const M = this.M, b = sol.bHist[k], nu = this.nu;
      const xx = new Float64Array(M.n), xy = new Float64Array(M.n), yy = new Float64Array(M.n);
      for (let i = 0; i < M.n; i++) for (let q = M.start[i]; q < M.start[i + 1]; q++) {
        const rate = (M.tau[q] * (b[q] + nu)) / M.area[i], d2 = M.dist[q] * M.dist[q];
        xx[i] += rate * d2 * M.nx[q] * M.nx[q]; xy[i] += rate * d2 * M.nx[q] * M.ny[q]; yy[i] += rate * d2 * M.ny[q] * M.ny[q];
      }
      C = { xx, xy, yy }; cache.set(k, C);
      return C;
    }

    /** smoothly blended cell velocity at each agent (own cell + graph neighbours) */
    fieldVelocity(sim, field, out) {
      const M = this.M, n = sim.p.n, x = sim.x, h2 = this.h2;
      for (let a = 0; a < n; a++) {
        const px = x[2 * a], py = x[2 * a + 1], i = this.cellAt(px, py);
        let w = Math.exp(-((M.xs[i] - px) ** 2 + (M.ys[i] - py) ** 2) / h2), W = w;
        let vx = w * field.vx[i], vy = w * field.vy[i];
        for (let k = M.start[i]; k < M.start[i + 1]; k++) {
          const j = M.nbr[k];
          w = Math.exp(-((M.xs[j] - px) ** 2 + (M.ys[j] - py) ** 2) / h2);
          vx += w * field.vx[j]; vy += w * field.vy[j]; W += w;
        }
        out[2 * a] = vx / W; out[2 * a + 1] = vy / W;
      }
    }

    sampleStart(m0, n, rnd) {
      const M = this.M, cum = new Float64Array(M.n);
      let s = 0;
      for (let i = 0; i < M.n; i++) { s += M.area[i] * m0[i]; cum[i] = s; }
      const pos = new Float64Array(2 * n);
      for (let a = 0; a < n; a++) {
        const u = rnd() * s;
        let lo = 0, hi = M.n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
        const poly = M.vor.polys[lo], m = poly.length / 2; // uniform point in the cell (fan triangulation)
        let A = 0; const areas = [];
        for (let k = 1; k < m - 1; k++) {
          const t = Math.abs((poly[2 * k] - poly[0]) * (poly[2 * k + 3] - poly[1]) - (poly[2 * k + 2] - poly[0]) * (poly[2 * k + 1] - poly[1])) / 2;
          areas.push(t); A += t;
        }
        let r = rnd() * A, k = 1;
        while (k < m - 2 && r > areas[k - 1]) { r -= areas[k - 1]; k++; }
        let u1 = rnd(), u2 = rnd();
        if (u1 + u2 > 1) { u1 = 1 - u1; u2 = 1 - u2; }
        pos[2 * a] = poly[0] + u1 * (poly[2 * k] - poly[0]) + u2 * (poly[2 * k + 2] - poly[0]);
        pos[2 * a + 1] = poly[1] + u1 * (poly[2 * k + 1] - poly[1]) + u2 * (poly[2 * k + 3] - poly[1]);
      }
      return pos;
    }

    /** crowd density on the mesh, pooled over cell + neighbours; seenBy leaves each agent out */
    meshDensity(sim) {
      const M = this.M, n = sim.p.n, count = new Float64Array(M.n), cellOf = new Int32Array(n);
      for (let a = 0; a < n; a++) { const c = this.cellAt(sim.x[2 * a], sim.x[2 * a + 1]); cellOf[a] = c; count[c]++; }
      if (!this.poolArea) {
        this.poolArea = new Float64Array(M.n);
        for (let i = 0; i < M.n; i++) { let A = M.area[i]; for (let k = M.start[i]; k < M.start[i + 1]; k++) A += M.area[M.nbr[k]]; this.poolArea[i] = A; }
      }
      const dens = new Float64Array(M.n), pooled = new Float64Array(M.n);
      let peak = 0;
      for (let i = 0; i < M.n; i++) {
        let c = count[i]; for (let k = M.start[i]; k < M.start[i + 1]; k++) c += count[M.nbr[k]];
        pooled[i] = c; dens[i] = c / (n * this.poolArea[i]); if (dens[i] > peak) peak = dens[i];
      }
      const seenBy = new Float64Array(n);
      for (let a = 0; a < n; a++) { const c = cellOf[a]; seenBy[a] = (pooled[c] - 1) / (n * this.poolArea[c]); }
      return { seenBy, peak, dens };
    }

    /* ---------- running ---------- */

    get t() { return this.ready ? this.crowds.react.t : 0; }
    get finished() { return this.ready && this.crowds.react.t >= this.T - 1e-9; }
    get progress() { return this.ready ? Math.min(1, this.t / this.T) : 0; }

    step() {
      if (!this.ready || this.finished) return;
      const dt = Math.min(this.dt, this.T - this.t), n = this.p.n;
      this.lastReactDens = null;
      for (const key of KEYS) {
        const s = this.crowds[key], st = this.stats[key];
        s.step(dt);
        const d = this.meshDensity(s);
        if (key === "react") this.lastReactDens = d.dens;
        for (let i = 0; i < n; i++) {
          st.move[i] += 0.5 * (s.vx[i] * s.vx[i] + s.vy[i] * s.vy[i]) * dt;
          st.crowd[i] += this.kappa * d.seenBy[i] * dt;
          // which door did each agent go through first?
          const side = Math.sign(s.x[2 * i] - 0.5);
          if (side !== 0 && side !== st.side[i]) {
            if (st.door[i] < 0) st.door[i] = s.x[2 * i + 1] < 0.5 ? 0 : 1;
            st.side[i] = side;
          }
        }
        st.peakRel = Math.max(st.peakRel, d.peak / this.m0max);
        st.peakTouch = Math.max(st.peakTouch, s.touchingNow);
      }
      this.record();
      if (this.finished) this.closeBooks();
    }

    record() {
      this.frames.t.push(this.t);
      for (const key of KEYS) {
        const s = this.crowds[key], f = this.frames[key];
        f.pos.push(Float32Array.from(s.x)); f.touch.push(Uint8Array.from(s.touching)); f.count.push(s.touchingNow);
      }
      const d = this.lastReactDens || this.meshDensity(this.crowds.react).dens;
      this.frames.reactDens.push(Float32Array.from(d));
    }

    closeBooks() {
      const n = this.p.n;
      for (const key of KEYS) {
        const s = this.crowds[key], st = this.stats[key];
        let term = 0, arrived = 0;
        for (let i = 0; i < n; i++) {
          const cell = this.cellAt(s.x[2 * i], s.x[2 * i + 1]);
          term += this.urgency * this.geo[cell];
          if (this.geo[cell] < 0.02) arrived++;
        }
        st.terminal = term / n; st.arrived = arrived / n; st.done = true;
      }
    }

    /** running totals while step 3 is still going (the distance-left bill comes at the end) */
    partial(key) {
      const st = this.stats[key], n = this.p.n;
      const mean = (a) => a.reduce((x, y) => x + y, 0) / n;
      const used = [0, 0]; for (let i = 0; i < n; i++) if (st.door[i] >= 0) used[st.door[i]]++;
      return { move: mean(st.move), crowd: mean(st.crowd), peakRel: st.peakRel, peakTouch: st.peakTouch, doors: used };
    }

    summary(key) {
      const st = this.stats[key], n = this.p.n;
      if (!st.done) return null;
      const mean = (a) => a.reduce((x, y) => x + y, 0) / n;
      const move = mean(st.move), crowd = mean(st.crowd);
      const used = [0, 0]; for (let i = 0; i < n; i++) if (st.door[i] >= 0) used[st.door[i]]++;
      return { move, crowd, terminal: st.terminal, total: move + crowd + st.terminal, arrived: st.arrived, peakRel: st.peakRel, peakTouch: st.peakTouch, doors: used };
    }

    /** the crowd-aware equilibrium's own cost, split the same way */
    equilibriumCost() {
      if (this._eq) return this._eq;
      const M = this.M, res = this.aware, Nt = res.bHist.length, dt = this.T / Nt;
      let move = 0, crowd = 0, left = 0, arrived = 0;
      for (let t = 0; t < Nt; t++) {
        const b = res.bHist[t], m = res.mHist[t + 1];
        for (let i = 0; i < M.n; i++) {
          let L = 0; for (let k = M.start[i]; k < M.start[i + 1]; k++) L += 0.5 * M.tau[k] * b[k] * b[k];
          move += dt * m[i] * L; crowd += dt * M.area[i] * m[i] * this.kappa * m[i];
        }
      }
      for (let i = 0; i < M.n; i++) { const w = M.area[i] * res.mHist[Nt][i]; left += w * res.g[i]; if (this.geo[i] < 0.02) arrived += w; }
      return (this._eq = { move, crowd, terminal: left, total: move + crowd + left, arrived });
    }
  }

  VC.Duel = Duel;
  VC.DUEL_KEYS = KEYS;
})(typeof window !== "undefined" ? window : globalThis);

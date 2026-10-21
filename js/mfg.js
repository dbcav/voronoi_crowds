/*
 * Sheet 2: a mean field game solved on a fixed Voronoi mesh.
 *
 * Cells i with area |V_i|, neighbours j, shared edge S_ij, seed distance d_ij,
 * transmissibility tau_ij = S_ij / d_ij.
 *
 * An agent in cell i chooses a non-negative speed b_ij / d_ij across each face;
 * the jump rate to j is tau_ij (b_ij + nu) / |V_i| (the nu part is diffusion).
 * Running cost  1/2 sum_j tau_ij b_ij^2 / |V_i|  + kappa * m_i  (congestion),
 * terminal cost g_i = urgency * (geodesic distance from cell i to the target).
 *
 * HJB (backward, implicit, policy iteration), multiplied through by |V_i|:
 *   |V_i| u_i^n/dt + sum_j tau_ij (b_ij + nu)(u_i^n - u_j^n)
 *       = |V_i| (u_i^{n+1}/dt + kappa m_i^{n+1}) + 1/2 sum_j tau_ij b_ij^2,
 *   b_ij = (u_i^n - u_j^n)^+          (monotone upwind Hamiltonian)
 * Call the left-hand matrix A^n. The Fokker-Planck step uses its transpose:
 *   (A^n)^T m^{n+1} = |V| m^n / dt,
 * so mass is conserved exactly, densities stay non-negative, and the discrete
 * FP equation is the adjoint of the linearised discrete HJB equation.
 * The coupled system is solved by fictitious play: average the best responses.
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});

  VC.MFG_SCENES = [
    { id: "open", label: "Open room" },
    { id: "door", label: "One door" },
    { id: "twodoors", label: "Two doors" },
  ];
  VC.MFG_MESHES = [
    { id: "lloyd", label: "Relaxed" },
    { id: "poisson", label: "Poisson disk" },
    { id: "random", label: "Random" },
  ];

  function mfgWalls(scene) {
    const t = 0.04, x0 = 0.5 - t / 2, x1 = 0.5 + t / 2;
    if (scene === "door") return [ { x0, x1, y0: 0, y1: 0.44 }, { x0, x1, y0: 0.56, y1: 1 } ];
    if (scene === "twodoors") return [ { x0, x1, y0: 0, y1: 0.2 }, { x0, x1, y0: 0.3, y1: 0.66 }, { x0, x1, y0: 0.76, y1: 1 } ];
    return [];
  }
  VC.mfgWalls = mfgWalls;
  const inWalls = (walls, x, y, pad) => walls.some((w) => x > w.x0 - pad && x < w.x1 + pad && y > w.y0 - pad && y < w.y1 + pad);

  function sampleSeeds(n, type, rnd) {
    const pts = [];
    if (type === "random") {
      for (let i = 0; i < n; i++) pts.push(rnd(), rnd());
      return pts;
    }
    // dart throwing with a background grid (Poisson disk), then optional Lloyd
    const rad = 0.72 / Math.sqrt(n);
    const gs = rad / Math.SQRT2, G = Math.ceil(1 / gs);
    const grid = new Int32Array(G * G).fill(-1);
    let tries = 0;
    while (pts.length / 2 < n && tries < n * 60) {
      tries++;
      const x = rnd(), y = rnd();
      const gx = Math.floor(x / gs), gy = Math.floor(y / gs);
      let ok = true;
      for (let yy = Math.max(0, gy - 2); ok && yy <= Math.min(G - 1, gy + 2); yy++)
        for (let xx = Math.max(0, gx - 2); xx <= Math.min(G - 1, gx + 2); xx++) {
          const q = grid[yy * G + xx];
          if (q >= 0 && (pts[2 * q] - x) ** 2 + (pts[2 * q + 1] - y) ** 2 < rad * rad) { ok = false; break; }
        }
      if (ok) { grid[gy * G + gx] = pts.length / 2; pts.push(x, y); }
    }
    while (pts.length / 2 < n) pts.push(rnd(), rnd());
    return pts;
  }

  class MFG {
    constructor() {
      this.p = {
        cells: 800, mesh: "lloyd", scene: "twodoors", seed: 3,
        start: { x: 0.22, y: 0.55, R: 0.13 },
        target: { x: 0.84, y: 0.36, R: 0.1 },
        kappa: 0.004, nu: 0.002, T: 1.6, steps: 64, urgency: 1.0, iters: 30,
      };
    }

    /** Build the mesh, walls and graph. */
    buildMesh() {
      const p = this.p, rnd = VC.rng(p.seed * 101 + p.cells);
      const walls = mfgWalls(p.scene);
      let pts = sampleSeeds(p.cells, p.mesh, rnd);
      const h = 1 / Math.sqrt(p.cells);
      if (p.mesh === "lloyd") {
        for (let it = 0; it < 12; it++) {
          const n = pts.length / 2, xs = new Float64Array(n), ys = new Float64Array(n);
          for (let i = 0; i < n; i++) { xs[i] = pts[2 * i]; ys[i] = pts[2 * i + 1]; }
          const v = VC.voronoi(xs, ys, n, { x0: 0, y0: 0, x1: 1, y1: 1 }, { keepPolys: false });
          for (let i = 0; i < n; i++) { pts[2 * i] = v.cx[i]; pts[2 * i + 1] = v.cy[i]; }
        }
      }
      // drop seeds inside walls, then line the walls with blocked seeds
      const free = [];
      for (let i = 0; i < pts.length / 2; i++) if (!inWalls(walls, pts[2 * i], pts[2 * i + 1], 0.3 * h)) free.push(pts[2 * i], pts[2 * i + 1]);
      const blocked = [];
      const ws = 0.45 * h;
      for (const w of walls) {
        const nx = Math.max(2, Math.ceil((w.x1 - w.x0) / ws) + 1), ny = Math.max(2, Math.ceil((w.y1 - w.y0) / ws) + 1);
        for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) {
          const x = w.x0 + ((w.x1 - w.x0) * a) / (nx - 1), y = w.y0 + ((w.y1 - w.y0) * b) / (ny - 1);
          if (y <= 0 || y >= 1) continue;
          blocked.push(x, y);
        }
      }
      const nF = free.length / 2, nB = blocked.length / 2, N = nF + nB;
      const xs = new Float64Array(N), ys = new Float64Array(N);
      for (let i = 0; i < nF; i++) { xs[i] = free[2 * i]; ys[i] = free[2 * i + 1]; }
      for (let i = 0; i < nB; i++) { xs[nF + i] = blocked[2 * i]; ys[nF + i] = blocked[2 * i + 1]; }
      const vor = VC.voronoi(xs, ys, N, { x0: 0, y0: 0, x1: 1, y1: 1 });

      // graph over free cells only
      const start = new Int32Array(nF + 1), nbr = [], tau = [], dist = [], nx = [], ny = [];
      for (let i = 0; i < nF; i++) {
        start[i] = nbr.length;
        for (let k = vor.nbrStart[i]; k < vor.nbrStart[i + 1]; k++) {
          const j = vor.nbr[k];
          if (j >= nF) continue;
          const dx = xs[j] - xs[i], dy = ys[j] - ys[i], d = Math.hypot(dx, dy);
          nbr.push(j); tau.push(vor.faceLen[k] / d); dist.push(d); nx.push(dx / d); ny.push(dy / d);
        }
      }
      start[nF] = nbr.length;
      // index of the reverse face j->i for every face i->j
      const rev = new Int32Array(nbr.length);
      for (let i = 0; i < nF; i++) for (let k = start[i]; k < start[i + 1]; k++) {
        const j = nbr[k];
        for (let q = start[j]; q < start[j + 1]; q++) if (nbr[q] === i) { rev[k] = q; break; }
      }
      this.mesh = {
        n: nF, nBlocked: nB, xs, ys, vor, walls,
        area: vor.area.slice(0, nF), start, nbr: Int32Array.from(nbr), tau: Float64Array.from(tau),
        dist: Float64Array.from(dist), nx: Float64Array.from(nx), ny: Float64Array.from(ny), rev,
      };
      return this.mesh;
    }

    cellAt(x, y) {
      const M = this.mesh; let best = 0, bd = Infinity;
      for (let i = 0; i < M.n; i++) { const d = (M.xs[i] - x) ** 2 + (M.ys[i] - y) ** 2; if (d < bd) { bd = d; best = i; } }
      return best;
    }

    /** Terminal cost from graph-geodesic distance to the target (Dijkstra). */
    terminalCost() {
      const M = this.mesh, n = M.n, p = this.p;
      const D = new Float64Array(n).fill(Infinity), done = new Uint8Array(n);
      // the target is a zone: every cell whose seed lies inside it costs nothing
      const t = this.cellAt(p.target.x, p.target.y), R = p.target.R || 0;
      const heap = [];
      for (let i = 0; i < n; i++) if (Math.hypot(M.xs[i] - p.target.x, M.ys[i] - p.target.y) <= R) { D[i] = 0; heap.push([0, i]); }
      if (!heap.length) { D[t] = Math.max(0, Math.hypot(M.xs[t] - p.target.x, M.ys[t] - p.target.y) - R); heap.push([D[t], t]); }
      const push = (e) => { heap.push(e); let c = heap.length - 1; while (c > 0) { const q = (c - 1) >> 1; if (heap[q][0] <= heap[c][0]) break; [heap[q], heap[c]] = [heap[c], heap[q]]; c = q; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
      while (heap.length) {
        const [d, i] = pop();
        if (done[i]) continue; done[i] = 1;
        for (let k = M.start[i]; k < M.start[i + 1]; k++) {
          const j = M.nbr[k], nd = d + M.dist[k];
          if (nd < D[j]) { D[j] = nd; push([nd, j]); }
        }
      }
      let Dmax = 0; for (let i = 0; i < n; i++) if (isFinite(D[i]) && D[i] > Dmax) Dmax = D[i];
      for (let i = 0; i < n; i++) if (!isFinite(D[i])) D[i] = Dmax; // unreachable pockets
      this.geo = D;
      // sweep order for Gauss-Seidel: information in the HJB flows outward from
      // the target, mass in the FP flows toward it
      this.order = Int32Array.from(Array.from({ length: n }, (_, i) => i).sort((a, b) => D[a] - D[b]));
      const g = new Float64Array(n);
      for (let i = 0; i < n; i++) g[i] = p.urgency * D[i];
      return g;
    }

    initialDensity() {
      const M = this.mesh, p = this.p, s = p.start;
      const m = new Float64Array(M.n);
      let mass = 0;
      for (let i = 0; i < M.n; i++) {
        const r2 = ((M.xs[i] - s.x) ** 2 + (M.ys[i] - s.y) ** 2) / (s.R * s.R);
        // smooth bump with compact-ish support
        m[i] = r2 < 1 ? Math.pow(1 - r2, 2) : 0;
        mass += m[i] * M.area[i];
      }
      if (mass <= 0) { const c = this.cellAt(s.x, s.y); m[c] = 1 / M.area[c]; mass = 1; }
      for (let i = 0; i < M.n; i++) m[i] /= mass;
      return m;
    }

    /** Backward HJB given a density history; returns u history and controls b. */
    solveHJB(mHist, g, kappa, warm) {
      const M = this.mesh, n = M.n, nf = M.nbr.length, Nt = this.p.steps, dt = this.p.T / Nt, nu = this.p.nu;
      const uHist = new Array(Nt + 1), bHist = new Array(Nt);
      uHist[Nt] = Float64Array.from(g);
      const rhs0 = new Float64Array(n);
      for (let t = Nt - 1; t >= 0; t--) {
        const up = uHist[t + 1], mN = mHist[t + 1];
        const u = Float64Array.from(warm ? warm[t] : up); // warm start from the previous play if we have it
        const b = new Float64Array(nf);
        for (let i = 0; i < n; i++) rhs0[i] = M.area[i] * (up[i] / dt + kappa * mN[i]);
        // Nonlinear Gauss-Seidel: each cell solves its own scalar equation
        //   a v + sum_j tau_ij [ nu (v - u_j) + 1/2 ((v - u_j)^+)^2 ] = rhs_i,  a = |V_i|/dt,
        // which is increasing and convex in v, by a few Newton steps.
        const ord = this.order;
        for (let sweep = 0; sweep < 200; sweep++) {
          let delta = 0;
          const fwd = sweep % 2 === 0;
          for (let q = 0; q < n; q++) {
            const i = ord[fwd ? q : n - 1 - q];
            const a = M.area[i] / dt, k0 = M.start[i], k1 = M.start[i + 1];
            let v = u[i];
            for (let newton = 0; newton < 8; newton++) {
              let F = a * v - rhs0[i], dF = a;
              for (let k = k0; k < k1; k++) {
                const diff = v - u[M.nbr[k]], tk = M.tau[k];
                F += tk * nu * diff; dF += tk * nu;
                if (diff > 0) { F += 0.5 * tk * diff * diff; dF += tk * diff; }
              }
              const step = F / dF;
              v -= step;
              if (Math.abs(step) < 1e-12) break;
            }
            const dd = Math.abs(v - u[i]); if (dd > delta) delta = dd;
            u[i] = v;
          }
          if (delta < 1e-9) break;
        }
        // final policy consistent with u^n
        for (let i = 0; i < n; i++) for (let k = M.start[i]; k < M.start[i + 1]; k++) b[k] = Math.max(0, u[i] - u[M.nbr[k]]);
        uHist[t] = u; bHist[t] = b;
      }
      return { uHist, bHist };
    }

    /** Forward FP with the transposed operator. */
    solveFP(m0, bHist, warm) {
      const M = this.mesh, n = M.n, Nt = this.p.steps, dt = this.p.T / Nt, nu = this.p.nu;
      const mHist = new Array(Nt + 1);
      mHist[0] = Float64Array.from(m0);
      for (let t = 0; t < Nt; t++) {
        const b = bHist[t], mp = mHist[t], m = Float64Array.from(warm ? warm[t + 1] : mp);
        const ord = this.order;
        for (let sweep = 0; sweep < 200; sweep++) {
          let delta = 0;
          const fwd = sweep % 2 === 1;
          for (let q = 0; q < n; q++) {
            const i = ord[fwd ? q : n - 1 - q];
            let diag = M.area[i] / dt, acc = (M.area[i] * mp[i]) / dt;
            for (let k = M.start[i]; k < M.start[i + 1]; k++) {
              diag += M.tau[k] * (b[k] + nu);                 // outflow from i
              acc += M.tau[k] * (b[M.rev[k]] + nu) * m[M.nbr[k]]; // inflow from j
            }
            const nv = acc / diag;
            const dd = Math.abs(nv - m[i]); if (dd > delta) delta = dd;
            m[i] = nv;
          }
          if (delta < 1e-9) break;
        }
        mHist[t + 1] = m;
      }
      return mHist;
    }

    l1(a, b) { const M = this.mesh; let s = 0; for (let i = 0; i < M.n; i++) s += M.area[i] * Math.abs(a[i] - b[i]); return s; }

    /**
     * Fictitious play. A generator so the page can draw progress between
     * iterations: each yield reports { k, residual }.
     */
    *solve(kappa) {
      const p = this.p, Nt = p.steps;
      if (kappa == null) kappa = p.kappa;
      const g = this.terminalCost(), m0 = this.initialDensity();
      let mBar = new Array(Nt + 1).fill(null).map(() => Float64Array.from(m0));
      const residuals = [];
      const iters = kappa === 0 ? 1 : p.iters;
      let last = null, lastM = null;
      for (let k = 0; k < iters; k++) {
        const { uHist, bHist } = this.solveHJB(mBar, g, kappa, last && last.uHist);
        const mBR = this.solveFP(m0, bHist, lastM);
        lastM = mBR;
        let res = 0;
        for (let t = 0; t <= Nt; t++) res = Math.max(res, this.l1(mBR[t], mBar[t]));
        residuals.push(res);
        const theta = k === 0 ? 1 : 1 / (k + 1);
        for (let t = 0; t <= Nt; t++) { const a = mBar[t], c = mBR[t]; for (let i = 0; i < a.length; i++) a[i] += theta * (c[i] - a[i]); }
        last = { uHist, bHist };
        yield { k, residual: res, residuals, mBar };
      }
      // value and controls that respond to the final averaged density
      const fin = this.solveHJB(mBar, g, kappa, last && last.uHist);
      this.result = { kappa, mHist: mBar, uHist: fin.uHist, bHist: fin.bHist, residuals, g, m0 };
      return this.result;
    }

    /** Run solve() to completion synchronously (tests / small problems). */
    solveSync(kappa) { const it = this.solve(kappa); let r; while (!(r = it.next()).done); return this.result; }

    /** Cell-centred velocity at time step t: v_i = sum_j S_ij b_ij n_ij / |V_i|. */
    velocity(res, t) {
      const M = this.mesh, n = M.n, b = res.bHist[Math.min(t, res.bHist.length - 1)];
      const vx = new Float64Array(n), vy = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sx = 0, sy = 0;
        for (let k = M.start[i]; k < M.start[i + 1]; k++) { const w = M.tau[k] * M.dist[k] * b[k]; sx += w * M.nx[k]; sy += w * M.ny[k]; }
        vx[i] = sx / M.area[i]; vy[i] = sy / M.area[i];
      }
      return { vx, vy };
    }
  }

  VC.MFG = MFG;
})(typeof window !== "undefined" ? window : globalThis);

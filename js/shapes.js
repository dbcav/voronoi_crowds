/*
 * Point layouts for start / target regions, and the assignment of targets to
 * agents (auction algorithm for the optimal matching).
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});
  const GOLD = Math.PI * (3 - Math.sqrt(5));

  // Deterministic PRNG so "reset" reproduces a layout.
  VC.rng = function (seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  };
  VC.gauss = function (rnd) {
    const u = Math.max(rnd(), 1e-12), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  function sunflower(n, cx, cy, R, out, off, rIn) {
    rIn = rIn || 0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const r = Math.sqrt(rIn * rIn + (R * R - rIn * rIn) * t);
      const th = k * GOLD;
      out[2 * (off + k)] = cx + r * Math.cos(th);
      out[2 * (off + k) + 1] = cy + r * Math.sin(th);
    }
  }

  function block(n, cx, cy, w, h, out, off) {
    // near-square lattice filling a w x h rectangle
    const cols = Math.max(1, Math.round(Math.sqrt((n * w) / h)));
    const rows = Math.ceil(n / cols);
    const dx = w / cols, dy = h / rows;
    for (let k = 0; k < n; k++) {
      const c = k % cols, r = Math.floor(k / cols);
      const shift = r % 2 ? 0.25 * dx : -0.25 * dx;
      out[2 * (off + k)] = cx - w / 2 + (c + 0.5) * dx + shift;
      out[2 * (off + k) + 1] = cy - h / 2 + (r + 0.5) * dy;
    }
  }

  VC.SHAPES = [
    { id: "disk", label: "Disk" },
    { id: "ring", label: "Ring" },
    { id: "square", label: "Square" },
    { id: "column", label: "Column" },
    { id: "pair", label: "Two groups" },
  ];

  /** Fill out[2n] with n points of the given shape centred at (cx,cy), size R. */
  VC.layout = function (shape, n, cx, cy, R, rnd, jitter) {
    const out = new Float64Array(2 * n);
    switch (shape) {
      case "ring": sunflower(n, cx, cy, R, out, 0, R * 0.62); break;
      case "square": { const s = R * 1.772; block(n, cx, cy, s, s, out, 0); break; }
      case "column": block(n, cx, cy, R * 0.75, R * 2, out, 0); break;
      case "pair": {
        const n1 = Math.ceil(n / 2), r2 = R * 0.62;
        sunflower(n1, cx, cy - R * 0.62, r2, out, 0);
        sunflower(n - n1, cx, cy + R * 0.62, r2, out, n1);
        break;
      }
      default: sunflower(n, cx, cy, R, out, 0);
    }
    if (jitter && rnd) {
      for (let k = 0; k < 2 * n; k++) out[k] += jitter * (rnd() - 0.5);
    }
    return out;
  };

  /**
   * Optimal assignment (min sum of squared distances) by the auction algorithm
   * with epsilon scaling. Returns perm with perm[i] = index of target for person i.
   */
  VC.assignOptimal = function (P, Q, n) {
    const cost = new Float64Array(n * n);
    let cmax = 0;
    for (let i = 0; i < n; i++) {
      const px = P[2 * i], py = P[2 * i + 1];
      for (let j = 0; j < n; j++) {
        const dx = px - Q[2 * j], dy = py - Q[2 * j + 1];
        const c = dx * dx + dy * dy;
        cost[i * n + j] = c;
        if (c > cmax) cmax = c;
      }
    }
    const price = new Float64Array(n);
    const owner = new Int32Array(n).fill(-1);
    const assigned = new Int32Array(n).fill(-1);
    const epsFinal = (cmax * 1e-7) / Math.max(n, 1);
    let eps = cmax / 8;
    const queue = new Int32Array(n);
    let guard = 0;
    while (true) {
      owner.fill(-1); assigned.fill(-1);
      let qh = 0, qt = 0;
      for (let i = 0; i < n; i++) queue[i] = i;
      qt = 0; // queue is full: tail wraps to 0
      let qlen = n;
      while (qlen > 0) {
        const i = queue[qh]; qh = (qh + 1) % n; qlen--;
        // best and second-best value of (-cost - price)
        let b1 = -Infinity, b2 = -Infinity, jb = -1;
        const row = i * n;
        for (let j = 0; j < n; j++) {
          const v = -cost[row + j] - price[j];
          if (v > b1) { b2 = b1; b1 = v; jb = j; } else if (v > b2) b2 = v;
        }
        if (b2 === -Infinity) b2 = b1;
        price[jb] += b1 - b2 + eps;
        const prev = owner[jb];
        owner[jb] = i; assigned[i] = jb;
        if (prev >= 0) { assigned[prev] = -1; queue[qt] = prev; qt = (qt + 1) % n; qlen++; }
        if (++guard > 5e7) break; // safety valve
      }
      if (eps <= epsFinal || guard > 5e7) break;
      eps = Math.max(eps / 6, epsFinal);
    }
    return assigned;
  };

  VC.assignShuffled = function (n, rnd) {
    const p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    return p;
  };
})(typeof window !== "undefined" ? window : globalThis);

/*
 * Bounded Voronoi tessellation, no dependencies.
 *
 * Each cell is built by starting from the bounding box and clipping it by the
 * bisector half-planes of nearby seeds, nearest first. A seed farther than
 * twice the cell's current radius cannot cut the cell, so we stop once every
 * unvisited seed is beyond that ("security radius"). Each polygon edge remembers
 * which neighbour created it, which gives us face lengths and face midpoints
 * directly — exactly what the finite-volume and pressure formulas need.
 *
 * Output (all flat typed arrays, CSR layout for neighbours):
 *   area[i]                   cell area
 *   cx[i], cy[i]              cell centroid
 *   nbrStart[i]..nbrStart[i+1]  range into the face arrays for cell i
 *   nbr[k]                    neighbour index for face k
 *   faceLen[k]                shared edge length S_ij
 *   faceMx[k], faceMy[k]      shared edge midpoint c_ij
 *   polys[i]                  Float64Array [x0,y0,x1,y1,...] (for drawing)
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});

  function buildGrid(xs, ys, n, b, cellSize) {
    const nx = Math.max(1, Math.ceil((b.x1 - b.x0) / cellSize));
    const ny = Math.max(1, Math.ceil((b.y1 - b.y0) / cellSize));
    const count = new Int32Array(nx * ny + 1);
    const where = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let gx = Math.floor((xs[i] - b.x0) / cellSize);
      let gy = Math.floor((ys[i] - b.y0) / cellSize);
      gx = gx < 0 ? 0 : gx >= nx ? nx - 1 : gx;
      gy = gy < 0 ? 0 : gy >= ny ? ny - 1 : gy;
      where[i] = gy * nx + gx;
      count[where[i] + 1]++;
    }
    for (let c = 0; c < nx * ny; c++) count[c + 1] += count[c];
    const fill = count.slice(0, nx * ny);
    const items = new Int32Array(n);
    for (let i = 0; i < n; i++) items[fill[where[i]]++] = i;
    return { nx, ny, start: count, items, cellSize, x0: b.x0, y0: b.y0 };
  }

  // Scratch buffers reused across cells (polygons rarely exceed ~20 vertices).
  let PX = new Float64Array(64), PY = new Float64Array(64), PL = new Int32Array(64);
  let QX = new Float64Array(64), QY = new Float64Array(64), QL = new Int32Array(64);
  function ensure(cap) {
    if (PX.length >= cap) return;
    const c = Math.max(cap, PX.length * 2);
    PX = new Float64Array(c); PY = new Float64Array(c); PL = new Int32Array(c);
    QX = new Float64Array(c); QY = new Float64Array(c); QL = new Int32Array(c);
  }

  // Clip polygon (PX,PY,PL,len) by half-plane {y : (y-m)·e <= 0} labelled j.
  function clip(len, mx, my, ex, ey, j) {
    ensure(len * 2 + 4);
    let out = 0;
    for (let k = 0; k < len; k++) {
      const k1 = k + 1 === len ? 0 : k + 1;
      const ax = PX[k], ay = PY[k], bx = PX[k1], by = PY[k1];
      const fa = (ax - mx) * ex + (ay - my) * ey;
      const fb = (bx - mx) * ex + (by - my) * ey;
      const ina = fa <= 0, inb = fb <= 0;
      if (ina) {
        QX[out] = ax; QY[out] = ay; QL[out] = PL[k]; out++;
        if (!inb) {
          const t = fa / (fa - fb);
          QX[out] = ax + t * (bx - ax); QY[out] = ay + t * (by - ay); QL[out] = j; out++;
        }
      } else if (inb) {
        const t = fa / (fa - fb);
        QX[out] = ax + t * (bx - ax); QY[out] = ay + t * (by - ay); QL[out] = PL[k]; out++;
      }
    }
    // swap buffers
    let tx = PX; PX = QX; QX = tx;
    tx = PY; PY = QY; QY = tx;
    const tl = PL; PL = QL; QL = tl;
    return out;
  }

  /**
   * @param {Float64Array} xs seed x
   * @param {Float64Array} ys seed y
   * @param {number} n number of seeds
   * @param {{x0,y0,x1,y1}} b bounding box
   * @param {object} [opts] { keepPolys: true, maxR: 0 }  maxR > 0 truncates every
   *   cell to the square [x-maxR, x+maxR]^2 (exact inside the disk of radius maxR).
   */
  VC.voronoi = function (xs, ys, n, b, opts) {
    opts = opts || {};
    const keepPolys = opts.keepPolys !== false;
    const maxR = opts.maxR || 0;
    const W = b.x1 - b.x0, H = b.y1 - b.y0;
    const cellSize = Math.sqrt((W * H) / Math.max(n, 1)) * 1.0;
    const g = buildGrid(xs, ys, n, b, cellSize);

    const area = new Float64Array(n), cx = new Float64Array(n), cy = new Float64Array(n);
    const nbrStart = new Int32Array(n + 1);
    let cap = n * 8;
    let nbr = new Int32Array(cap), faceLen = new Float64Array(cap);
    let faceMx = new Float64Array(cap), faceMy = new Float64Array(cap);
    let nf = 0;
    const polys = keepPolys ? new Array(n) : null;
    const labels = keepPolys ? new Array(n) : null; // neighbour across each polygon edge (-1 = box)

    const cand = [];      // candidate indices for current ring batch
    const candD = [];

    for (let i = 0; i < n; i++) {
      const xi = xs[i], yi = ys[i];
      // start with the box (optionally shrunk to a square of half-width maxR
      // around the seed, when only a capped cell is needed)
      let len = 4;
      const bx0 = maxR ? Math.max(b.x0, xi - maxR) : b.x0, bx1 = maxR ? Math.min(b.x1, xi + maxR) : b.x1;
      const by0 = maxR ? Math.max(b.y0, yi - maxR) : b.y0, by1 = maxR ? Math.min(b.y1, yi + maxR) : b.y1;
      PX[0] = bx0; PY[0] = by0; PL[0] = -1;
      PX[1] = bx1; PY[1] = by0; PL[1] = -1;
      PX[2] = bx1; PY[2] = by1; PL[2] = -1;
      PX[3] = bx0; PY[3] = by1; PL[3] = -1;

      let gx = Math.floor((xi - g.x0) / g.cellSize), gy = Math.floor((yi - g.y0) / g.cellSize);
      gx = gx < 0 ? 0 : gx >= g.nx ? g.nx - 1 : gx;
      gy = gy < 0 ? 0 : gy >= g.ny ? g.ny - 1 : gy;
      const maxRing = Math.max(g.nx, g.ny);

      for (let ring = 0; ring <= maxRing; ring++) {
        // gather the ring (ring 0 and 1 processed together for better ordering)
        cand.length = 0; candD.length = 0;
        const rlo = ring === 1 ? 2 : ring; // ring 1 was merged into ring 0
        if (ring === 1) continue;
        const r0 = ring === 0 ? 0 : rlo, r1 = ring === 0 ? 1 : rlo;
        for (let r = r0; r <= r1; r++) {
          for (let dy = -r; dy <= r; dy++) {
            const yy = gy + dy;
            if (yy < 0 || yy >= g.ny) continue;
            const edge = dy === -r || dy === r;
            const step = edge ? 1 : 2 * r;
            for (let dx = -r; dx <= r; dx += step || 1) {
              const xx = gx + dx;
              if (xx < 0 || xx >= g.nx) continue;
              const c = yy * g.nx + xx;
              for (let p = g.start[c]; p < g.start[c + 1]; p++) {
                const j = g.items[p];
                if (j === i) continue;
                const ddx = xs[j] - xi, ddy = ys[j] - yi;
                cand.push(j); candD.push(ddx * ddx + ddy * ddy);
              }
              if (r === 0) break;
            }
          }
        }
        // sort candidates by distance (insertion sort; batches are small)
        for (let a = 1; a < cand.length; a++) {
          const vj = cand[a], vd = candD[a];
          let q = a - 1;
          while (q >= 0 && candD[q] > vd) { cand[q + 1] = cand[q]; candD[q + 1] = candD[q]; q--; }
          cand[q + 1] = vj; candD[q + 1] = vd;
        }
        for (let a = 0; a < cand.length; a++) {
          const j = cand[a];
          if (candD[a] < 1e-24) continue; // coincident seed: skip
          const ex = xs[j] - xi, ey = ys[j] - yi;
          len = clip(len, 0.5 * (xs[j] + xi), 0.5 * (ys[j] + yi), ex, ey, j);
          if (len === 0) break;
        }
        // security radius: every unvisited seed is at least (r1)*cellSize away
        let rmax2 = 0;
        for (let k = 0; k < len; k++) {
          const dx = PX[k] - xi, dy = PY[k] - yi;
          const d2 = dx * dx + dy * dy;
          if (d2 > rmax2) rmax2 = d2;
        }
        const safe = r1 * g.cellSize;
        if (4 * rmax2 <= safe * safe) break;
      }

      // area, centroid, faces
      let A = 0, Cx = 0, Cy = 0;
      nbrStart[i] = nf;
      for (let k = 0; k < len; k++) {
        const k1 = k + 1 === len ? 0 : k + 1;
        const cr = PX[k] * PY[k1] - PX[k1] * PY[k];
        A += cr; Cx += (PX[k] + PX[k1]) * cr; Cy += (PY[k] + PY[k1]) * cr;
        const lab = PL[k];
        if (lab >= 0) {
          const L = Math.hypot(PX[k1] - PX[k], PY[k1] - PY[k]);
          if (L > 1e-14) {
            if (nf >= cap) {
              cap *= 2;
              const grow = (arr, T) => { const z = new T(cap); z.set(arr); return z; };
              nbr = grow(nbr, Int32Array); faceLen = grow(faceLen, Float64Array);
              faceMx = grow(faceMx, Float64Array); faceMy = grow(faceMy, Float64Array);
            }
            nbr[nf] = lab; faceLen[nf] = L;
            faceMx[nf] = 0.5 * (PX[k] + PX[k1]); faceMy[nf] = 0.5 * (PY[k] + PY[k1]);
            nf++;
          }
        }
      }
      A *= 0.5;
      area[i] = Math.abs(A);
      if (Math.abs(A) > 1e-18) { cx[i] = Cx / (6 * A); cy[i] = Cy / (6 * A); }
      else { cx[i] = xi; cy[i] = yi; }
      if (keepPolys) {
        const poly = new Float64Array(2 * len);
        for (let k = 0; k < len; k++) { poly[2 * k] = PX[k]; poly[2 * k + 1] = PY[k]; }
        polys[i] = poly;
        labels[i] = PL.slice(0, len);
      }
    }
    nbrStart[n] = nf;
    return {
      n, area, cx, cy, nbrStart,
      nbr: nbr.subarray(0, nf), faceLen: faceLen.subarray(0, nf),
      faceMx: faceMx.subarray(0, nf), faceMy: faceMy.subarray(0, nf),
      polys, labels,
    };
  };

  /**
   * Cap every cell by a disk of radius R around its own seed: W_i = V_i ∩ B(x_i, R).
   * Returns the capped area, the part of each shared edge that lies inside the
   * disk (length + midpoint, CSR like the uncapped faces), the integral of the
   * outward normal over the cell's circular arcs (needed for the energy
   * gradient), and an outline for drawing.
   */
  VC.capCells = function (vor, xs, ys, n, R, wantOutline) {
    const area = new Float64Array(n), arcX = new Float64Array(n), arcY = new Float64Array(n);
    const start = new Int32Array(n + 1);
    const nb = [], fl = [], fmx = [], fmy = [];
    const outlines = wantOutline ? new Array(n) : null;
    const R2 = R * R, STEP = 0.3; // radians between outline points on arcs
    for (let i = 0; i < n; i++) {
      const poly = vor.polys[i], lab = vor.labels[i], m = lab.length;
      const cx = xs[i], cy = ys[i];
      start[i] = nb.length;
      let A = 0, ax = 0, ay = 0;
      const out = wantOutline ? [] : null;
      for (let k = 0; k < m; k++) {
        const k1 = k + 1 === m ? 0 : k + 1;
        const px = poly[2 * k] - cx, py = poly[2 * k + 1] - cy;
        const qx = poly[2 * k1] - cx, qy = poly[2 * k1 + 1] - cy;
        const dx = qx - px, dy = qy - py;
        // |p + t d|^2 = R^2
        const a = dx * dx + dy * dy, b = 2 * (px * dx + py * dy), c = px * px + py * py - R2;
        let t0 = 1, t1 = 0; // empty inside-interval by default
        const disc = b * b - 4 * a * c;
        if (a > 0 && disc > 0) {
          const sq = Math.sqrt(disc);
          t0 = Math.max(0, (-b - sq) / (2 * a));
          t1 = Math.min(1, (-b + sq) / (2 * a));
        }
        const pieces = [];
        if (t0 < t1) {
          if (t0 > 0) pieces.push([0, t0, false]);
          pieces.push([t0, t1, true]);
          if (t1 < 1) pieces.push([t1, 1, false]);
        } else pieces.push([0, 1, false]);
        for (const [s0, s1, inside] of pieces) {
          const ux = px + s0 * dx, uy = py + s0 * dy, vx = px + s1 * dx, vy = py + s1 * dy;
          if (inside) {
            A += 0.5 * (ux * vy - uy * vx);
            if (out) out.push(cx + ux, cy + uy);
            if (lab[k] >= 0) {
              const L = Math.hypot(vx - ux, vy - uy);
              if (L > 1e-14) { nb.push(lab[k]); fl.push(L); fmx.push(cx + 0.5 * (ux + vx)); fmy.push(cy + 0.5 * (uy + vy)); }
            }
          } else {
            const th0 = Math.atan2(uy, ux);
            let dth = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
            if (dth < 0) dth += 2 * Math.PI; // CCW sweep
            if (dth > 2 * Math.PI - 1e-12) dth = 0;
            A += 0.5 * R2 * dth;
            const th1 = th0 + dth;
            ax += R * (Math.sin(th1) - Math.sin(th0));
            ay += R * (Math.cos(th0) - Math.cos(th1));
            if (out) {
              const steps = Math.max(1, Math.ceil(dth / STEP));
              for (let s = 0; s < steps; s++) {
                const th = th0 + (dth * s) / steps;
                out.push(cx + R * Math.cos(th), cy + R * Math.sin(th));
              }
            }
          }
        }
      }
      area[i] = A; arcX[i] = ax; arcY[i] = ay;
      if (out) outlines[i] = new Float64Array(out);
    }
    start[n] = nb.length;
    return {
      area, arcX, arcY, nbrStart: start,
      nbr: Int32Array.from(nb), faceLen: Float64Array.from(fl),
      faceMx: Float64Array.from(fmx), faceMy: Float64Array.from(fmy), outlines,
    };
  };
})(typeof window !== "undefined" ? window : globalThis);

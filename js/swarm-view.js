/*
 * Sheet 1 view: runs VC.Swarm live, draws it, wires the title-block controls.
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});
  const $ = (id) => document.getElementById(id);

  class SwarmView {
    constructor() {
      this.sim = new VC.Swarm();
      this.stage = new VC.Stage($("swarm-canvas"), () => this.draw());
      this.running = !VC.reducedMotion;
      this.visible = true;
      this.showCells = true;
      this.showTargets = true;
      this.playback = 1;
      this.prevRun = null;
      this.chart = new VC.LineChart($("swarm-chart"), {
        xLabel: "time (s)", yLabel: "pairs touching", aria: "Pairs of agents touching over time, this run and the previous run",
        height: 160, xFmt: (v) => (+v).toFixed(v < 10 ? 1 : 0), yFmt: (v) => Math.round(v).toString(),
      });
      const key = $("swarm-key-bar");
      if (key) key.style.background = `linear-gradient(to right, ${VC.divergeStops(9).join(", ")})`;
      this.bindControls();
      this.bindCanvas();
      this.runLabel = this.describe();
      this.updatePlay();
      this.lastChart = 0;
      this.draw();
    }

    describe() {
      const p = this.sim.p;
      const what = p.pressure && p.repulsion ? "pressure + repulsion" : p.pressure ? "Voronoi pressure" : p.repulsion ? "contact repulsion" : "no interaction";
      return `${what}, ${p.n} agents`;
    }

    /** Restart from the start layout; the run that just ended becomes the comparison. */
    restart() {
      const s = this.sim;
      if (s.t > 1.5) {
        const h = s.history, xs = [], ys = [];
        for (let i = 0; i < h.length; i += 2) { xs.push(h[i]); ys.push(h[i + 1]); }
        this.prevRun = { name: `Previous: ${this.runLabel}`, short: "previous", color: VC.COLORS.seriesPrev, dash: "5 4", xs, ys };
      }
      s.reset();
      this.runLabel = this.describe();
      this.updateChart(true);
      this.draw();
    }

    bindControls() {
      const p = this.sim.p;
      VC.fillSelect($("sw-start-shape"), VC.SHAPES, p.start.shape);
      VC.fillSelect($("sw-target-shape"), VC.SHAPES, p.target.shape);
      VC.bindRange($("sw-n"), $("sw-n-out"), (v) => v, null, (v) => { p.n = v; this.restart(); });
      document.querySelectorAll('#swarm-controls input[name="scene"]').forEach((r) => r.addEventListener("change", () => { p.scene = r.value; this.restart(); }));
      document.querySelectorAll('#swarm-controls input[name="matching"]').forEach((r) => r.addEventListener("change", () => { p.matching = r.value; this.restart(); }));
      $("sw-start-shape").addEventListener("change", (e) => { p.start.shape = e.target.value; this.restart(); });
      $("sw-target-shape").addEventListener("change", (e) => { p.target.shape = e.target.value; this.sim.assignTargets(this.sim.t > 0); this.draw(); });
      const press = $("sw-pressure"), rep = $("sw-repulsion");
      const syncModel = () => {
        p.pressure = press.checked; p.repulsion = rep.checked;
        $("sw-pressure-k").disabled = !p.pressure; $("sw-repulsion-k").disabled = !p.repulsion;
        this.runLabel = this.describe();
      };
      press.addEventListener("change", syncModel); rep.addEventListener("change", syncModel); syncModel();
      VC.bindRange($("sw-pressure-k"), null, null, (v) => { p.strength = v; });
      VC.bindRange($("sw-repulsion-k"), null, null, (v) => { p.repStrength = v; });
      VC.bindRange($("sw-personal"), $("sw-personal-out"), (v) => v.toFixed(1) + "×", (v) => { p.personal = v; this.sim.geometry(); this.draw(); });
      VC.bindRange($("sw-noise"), $("sw-noise-out"), (v) => (v === 0 ? "none" : v), (v) => { p.noise = v * 2e-5; });
      VC.bindRange($("sw-speed"), $("sw-speed-out"), (v) => v + "×", (v) => { this.playback = v; });
      $("sw-show-cells").addEventListener("change", (e) => { this.showCells = e.target.checked; this.draw(); });
      $("sw-show-targets").addEventListener("change", (e) => { this.showTargets = e.target.checked; this.draw(); });
      $("swarm-play").addEventListener("click", () => { this.running = !this.running; this.updatePlay(); });
      $("swarm-restart").addEventListener("click", () => { this.restart(); this.running = true; this.updatePlay(); });
    }

    updatePlay() {
      const b = $("swarm-play");
      b.textContent = this.running ? "Pause" : "Play";
      b.setAttribute("aria-pressed", String(this.running));
    }

    bindCanvas() {
      const p = this.sim.p, sim = this.sim;
      let wasRunning = false;
      this.handles = [
        {
          id: "target", resizable: true,
          get: () => p.target,
          onMove: (x, y, R, phase) => {
            if (phase === "start") return;
            const dx = x - p.target.x, dy = y - p.target.y, scale = R / p.target.R;
            if (scale !== 1) {
              for (let i = 0; i < p.n; i++) {
                sim.tgt[2 * i] = x + (sim.tgt[2 * i] - p.target.x) * scale;
                sim.tgt[2 * i + 1] = y + (sim.tgt[2 * i + 1] - p.target.y) * scale;
              }
            } else sim.shiftTargets(dx, dy);
            p.target.x = x; p.target.y = y; p.target.R = R;
            if (phase === "end") sim.assignTargets(sim.t > 0);
            this.draw();
          },
        },
        {
          id: "start", resizable: true,
          get: () => p.start,
          onMove: (x, y, R, phase) => {
            if (phase === "start") { wasRunning = this.running; this.running = false; return; }
            p.start.x = x; p.start.y = y; p.start.R = R;
            sim.previewStart();
            if (phase === "end") { this.restart(); this.running = wasRunning; this.updatePlay(); }
            this.draw();
          },
        },
      ];
      VC.attachHandles(this.stage, this.handles);
      VC.attachKeys(this.stage.canvas, this.handles);
    }

    frame(now) {
      if (this.running && this.visible) {
        const dt = (1 / 60) * this.playback;
        const sub = this.playback > 1 ? Math.ceil(this.playback) : 1;
        for (let s = 0; s < sub; s++) this.sim.step(dt / sub);
        this.draw();
        if (now - this.lastChart > 250) { this.updateChart(); this.lastChart = now; }
        this.updateReadouts();
      }
    }

    updateReadouts() {
      const s = this.sim;
      $("swarm-time").textContent = s.t.toFixed(1) + " s";
      $("swarm-arrived").textContent = Math.round(100 * s.arrived) + "%";
      $("swarm-touch").textContent = s.touchingNow;
      $("swarm-peak").textContent = s.peakTouching;
    }

    updateChart() {
      const h = this.sim.history, xs = [], ys = [];
      const stride = Math.max(2, 2 * Math.floor(h.length / 2 / 600));
      for (let i = 0; i < h.length; i += stride) { xs.push(h[i]); ys.push(h[i + 1]); }
      const now = { name: `This run: ${this.runLabel}`, short: "this run", color: VC.COLORS.seriesNow, xs, ys };
      this.chart.setSeries(this.prevRun ? [now, this.prevRun] : [now]);
      this.updateReadouts();
    }

    draw() {
      const s = this.sim, C = VC.COLORS, c = this.stage.ctx, k = this.stage.k;
      VC.drawCrowd(this.stage, s, { cells: this.showCells, targets: this.showTargets, grid: true });
      // handles
      VC.drawHandle(c, k, s.p.start, { color: C.ink, dash: [5, 4], resizable: true, label: "start", knobFill: C.paper });
      VC.drawHandle(c, k, s.p.target, { color: C.exit, lineWidth: 2, resizable: true, label: "target", knobFill: C.paper });
    }
  }

  // Cell colour is log(crowding) on a diverging scale centred on comfortable spacing
  // (rho = 1): full blue at rho = 1/1.8 (lots of room), full red at rho = 1.8 (squeezed).
  const LOG_RHO_SPAN = Math.log(1.8);

  /** Draw a crowd (cells, walls, targets, bodies) onto a Stage. */
  VC.drawCrowd = function (stage, s, opts) {
    const c = stage.ctx, k = stage.k, n = s.p.n, C = VC.COLORS;
    stage.clear(C.paper);
    if (opts.grid) {
      c.lineWidth = 1 / k; c.strokeStyle = C.grid;
      c.beginPath();
      for (let g = 1; g < 10; g++) { c.moveTo(g / 10, 0); c.lineTo(g / 10, 1); c.moveTo(0, g / 10); c.lineTo(1, g / 10); }
      c.stroke();
    }
    if (opts.cells && s.cap && s.cap.outlines) {
      const ol = s.cap.outlines;
      c.lineWidth = 1.2 / k; c.strokeStyle = C.paper; c.lineJoin = "round";
      for (let i = 0; i < n; i++) {
        const poly = ol[i]; if (!poly || poly.length < 6) continue;
        c.beginPath(); c.moveTo(poly[0], poly[1]);
        for (let q = 2; q < poly.length; q += 2) c.lineTo(poly[q], poly[q + 1]);
        c.closePath();
        c.fillStyle = VC.diverge(Math.log(s.rho[i]) / LOG_RHO_SPAN);
        c.fill(); c.stroke();
      }
    }
    c.fillStyle = C.ink;
    for (const r of s.obs.rects) c.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    for (const p of s.obs.circles) { c.beginPath(); c.arc(p.x, p.y, p.r, 0, 2 * Math.PI); c.fill(); }
    if (opts.targets) {
      c.fillStyle = C.exit; c.globalAlpha = 0.55;
      const tr = Math.max(1.1 / k, s.r * 0.45);
      c.beginPath();
      for (let i = 0; i < n; i++) { const x = s.tgt[2 * i], y = s.tgt[2 * i + 1]; c.moveTo(x + tr, y); c.arc(x, y, tr, 0, 2 * Math.PI); }
      c.fill();
      c.globalAlpha = 1;
    }
    // bodies: filled; agents touching someone are drawn hollow
    const br = Math.max(1.4 / k, s.r);
    c.fillStyle = C.ink;
    c.beginPath();
    for (let i = 0; i < n; i++) if (!s.touching[i]) { const x = s.x[2 * i], y = s.x[2 * i + 1]; c.moveTo(x + br, y); c.arc(x, y, br, 0, 2 * Math.PI); }
    c.fill();
    c.strokeStyle = C.ink; c.lineWidth = Math.max(1, Math.min(2, br * k * 0.35)) / k; c.fillStyle = C.paper;
    c.beginPath();
    for (let i = 0; i < n; i++) if (s.touching[i]) { const x = s.x[2 * i], y = s.x[2 * i + 1]; c.moveTo(x + br, y); c.arc(x, y, br, 0, 2 * Math.PI); }
    c.fill(); c.stroke();
  };

  VC.SwarmView = SwarmView;
})(typeof window !== "undefined" ? window : globalThis);

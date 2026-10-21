/*
 * Sheet 2: one pipeline from the game to agents.
 *
 *   1. Solve the game  (fictitious play, crowd-aware, then crowd-blind)
 *   2. Draw N agents from the solved starting density
 *   3. Run three crowds from those spots: planning (crowd-aware plan),
 *      crowd-blind planners, and reacting agents
 *
 * The work is done a slice per animation frame so the page stays responsive,
 * and the clock follows the work as it happens. Every agent step is recorded,
 * so afterwards one scrubber drives the equilibrium density and all agents.
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});
  const $ = (id) => document.getElementById(id);
  const PLAY_SECONDS = 6;  // real seconds for one pass through [0, T]
  const DRAW_SECONDS = 0.9; // the "agents appear" moment in step 2
  const f3 = (v) => (v == null || !isFinite(v) ? "–" : v.toFixed(3));
  const pct = (v) => (v == null || !isFinite(v) ? "–" : Math.round(100 * Math.max(0, Math.min(1, v))) + "%");

  class MFGView {
    constructor() {
      this.mfg = new VC.MFG();
      this.duel = new VC.Duel();
      this.stage = new VC.Stage($("mfg-canvas"), () => this.draw());
      this.stageR = new VC.Stage($("react-canvas"), () => this.draw());
      this.view = "aware";
      this.showMesh = false; this.showFlow = false; this.showAgents = true;
      this.tFrac = 0; this.playing = false;
      this.aware = null; this.blind = null;
      this.job = null; this.stale = true; this.meshDirty = true;
      this.phase = "idle"; // idle | solve | draw | run | done
      this.chart = new VC.LineChart($("mfg-chart"), {
        xLabel: "round", yLabel: "gap", logY: true, aria: "Gap between the averaged crowd and the best response, per round of fictitious play",
        height: 170, xFmt: (v) => Math.round(v).toString(), yFmt: (v) => (+v).toPrecision(2),
      });
      this.touchChart = new VC.LineChart($("duel-chart"), {
        xLabel: "time", yLabel: "pairs touching", aria: "Pairs of agents touching over time for the reacting and planning crowds",
        height: 170, xFmt: (v) => (+v).toFixed(1), yFmt: (v) => Math.round(v).toString(),
      });
      this.bindControls();
      this.bindCanvas();
      this.solveTimer = null;
      this.setSteps();
    }

    /* ---------------- controls ---------------- */

    bindControls() {
      const p = this.mfg.p, d = this.duel.p;
      VC.fillSelect($("mf-mesh"), VC.MFG_MESHES, p.mesh);
      const resolve = () => this.requestSolve();
      $("mf-mesh").addEventListener("change", (e) => { p.mesh = e.target.value; this.meshDirty = true; resolve(); });
      document.querySelectorAll('#mfg-controls input[name="scene"]').forEach((r) => r.addEventListener("change", () => {
        p.scene = r.value; this.meshDirty = true; this.fixTarget(); resolve();
      }));
      VC.bindRange($("mf-cells"), $("mf-cells-out"), (v) => v, null, (v) => { p.cells = v; this.meshDirty = true; resolve(); });
      VC.bindRange($("mf-kappa"), $("mf-kappa-out"), (v) => v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""), null, (v) => { p.kappa = v; resolve(); });
      VC.bindRange($("mf-urgency"), $("mf-urgency-out"), (v) => v.toFixed(1), null, (v) => { p.urgency = v; resolve(); });
      VC.bindRange($("mf-nu"), $("mf-nu-out"), (v) => (v === 0 ? "0" : v.toFixed(4).replace(/0+$/, "")), null, (v) => { p.nu = v; resolve(); });
      VC.bindRange($("mf-T"), $("mf-T-out"), (v) => v.toFixed(1), null, (v) => { p.T = v; resolve(); });
      VC.bindRange($("mf-iters"), $("mf-iters-out"), (v) => v, null, (v) => { p.iters = v; resolve(); });
      // agent settings only redo steps 2 and 3
      const rerun = () => this.requestAgents();
      VC.bindRange($("duel-n"), $("duel-n-out"), (v) => v, (v) => { document.querySelectorAll(".pl-n").forEach((e) => (e.textContent = v)); }, (v) => { d.n = v; rerun(); });
      $("duel-pressure").addEventListener("change", (e) => { d.pressure = e.target.checked; rerun(); });
      $("duel-repulsion").addEventListener("change", (e) => { d.repulsion = e.target.checked; rerun(); });
      $("duel-spread").addEventListener("change", (e) => { d.spread = e.target.checked; rerun(); });
      $("mf-show-mesh").addEventListener("change", (e) => { this.showMesh = e.target.checked; this.draw(); });
      $("mf-show-flow").addEventListener("change", (e) => { this.showFlow = e.target.checked; this.draw(); });
      $("mf-show-agents").addEventListener("change", (e) => { this.showAgents = e.target.checked; this.draw(); });
      document.querySelectorAll('input[name="mfg-view"]').forEach((r) => r.addEventListener("change", () => { this.view = r.value; this.draw(); this.updateTouchChart(); }));
      $("mfg-play").addEventListener("click", () => {
        this.playing = !this.playing;
        if (this.playing && this.tFrac >= 1) this.tFrac = 0;
        this.updatePlay();
      });
      $("mfg-time").addEventListener("input", (e) => {
        this.tFrac = Math.min(+e.target.value / 1000, this.frontier());
        this.playing = false; this.updatePlay(); this.draw();
      });
    }

    fixTarget() {
      const t = this.mfg.p.target;
      for (const w of VC.mfgWalls(this.mfg.p.scene)) {
        if (t.x > w.x0 - 0.03 && t.x < w.x1 + 0.03 && t.y > w.y0 && t.y < w.y1) t.x = w.x1 + t.R + 0.02;
      }
    }

    bindCanvas() {
      const p = this.mfg.p;
      const handles = [
        {
          id: "target", resizable: true,
          get: () => p.target,
          onMove: (x, y, R, phase) => {
            if (phase === "move") { p.target.x = x; p.target.y = y; p.target.R = Math.min(0.2, Math.max(0.04, R)); this.fixTarget(); this.markStale(); }
            if (phase === "end") this.requestSolve();
          },
        },
        {
          id: "start", resizable: true,
          get: () => p.start,
          onMove: (x, y, R, phase) => {
            if (phase === "move") { p.start.x = x; p.start.y = y; p.start.R = Math.min(R, 0.3); this.markStale(); }
            if (phase === "end") this.requestSolve();
          },
        },
      ];
      VC.attachHandles(this.stage, handles);
      VC.attachKeys(this.stage.canvas, handles);
    }

    /* ---------------- the pipeline ---------------- */

    markStale() { this.stale = true; this.job = null; this.draw(); }

    requestSolve() {
      this.markStale();
      clearTimeout(this.solveTimer);
      this.solveTimer = setTimeout(() => this.startSolve(), 0);
    }

    /** agent settings changed: keep the solved game, redo steps 2 and 3 */
    requestAgents() {
      if (!this.aware || this.phase === "solve") return; // the solve in progress will pick them up
      clearTimeout(this.solveTimer);
      this.solveTimer = setTimeout(() => this.startAgents(), 0);
    }

    startSolve() {
      const m = this.mfg;
      if (this.meshDirty || !m.mesh) { m.buildMesh(); this.meshDirty = false; }
      this.aware = this.blind = null;
      this.duel.ready = false;
      this.job = { phase: "aware", gen: m.solve(m.p.kappa), residuals: [], mBar: null };
      this.phase = "solve"; this.tFrac = 0; this.playing = false;
      this.chart.setSeries([]); this.touchChart.setSeries([]);
      this.clearTable();
      this.setSteps();
      this.updatePlay();
    }

    startAgents() {
      this.duel.setup(this.mfg, this.aware.res, this.blind.res);
      this.phase = "draw"; this.drawStart = performance.now(); this.stale = false;
      this.tFrac = 0; this.playing = false; this.job = null;
      this.runSettings = this.snapshot();
      this.clearTable();
      this.fillEquilibrium();
      this.touchChart.setSeries([]);
      this.setSteps();
      this.updatePlay();
      if (VC.reducedMotion) this.drawStart -= DRAW_SECONDS * 1000;
    }

    /** how far the clock may go: everything simulated so far */
    frontier() {
      if (this.phase === "done") return 1;
      if (this.phase === "run" || this.phase === "draw") return this.duel.ready ? this.duel.progress : 0;
      return this.aware ? 1 : 0;
    }

    pump(now) {
      if (this.phase === "solve" && this.job) {
        const t0 = performance.now(), m = this.mfg;
        while (performance.now() - t0 < 24 && this.job) {
          const r = this.job.gen.next();
          if (r.done) {
            if (this.job.phase === "aware") {
              this.aware = this.summarise(m.result);
              this.job = { phase: "blind", gen: m.solve(0), residuals: this.job.residuals, mBar: null };
            } else {
              this.blind = this.summarise(m.result);
              this.job = null;
              this.chart.setSeries([{ name: "gap", color: VC.COLORS.seriesNow, xs: this.aware.res.residuals.map((_, i) => i + 1), ys: this.aware.res.residuals.slice() }]);
              this.startAgents();
              return;
            }
          } else if (this.job.phase === "aware") {
            this.job.residuals = r.value.residuals; this.job.mBar = r.value.mBar;
          }
        }
        if (this.job && this.job.phase === "aware" && this.job.residuals.length) {
          const rs = this.job.residuals;
          this.chart.setSeries([{ name: "gap", color: VC.COLORS.seriesNow, xs: rs.map((_, i) => i + 1), ys: rs.slice() }]);
        }
        this.setSteps();
        this.draw();
      } else if (this.phase === "draw") {
        if ((now - this.drawStart) / 1000 >= DRAW_SECONDS) { this.phase = "run"; this.playing = !VC.reducedMotion; this.updatePlay(); }
        this.setSteps();
        this.draw();
      } else if (this.phase === "run") {
        const t0 = performance.now(), D = this.duel;
        // simulate in the background, ~20 ms a frame; the clock never runs ahead of it
        while (performance.now() - t0 < 20 && !D.finished) D.step();
        if (D.finished) { this.phase = "done"; this.fillTable(); this.logRun(); }
        else if (!this.lastTable || now - this.lastTable > 200) { this.fillTable(); this.lastTable = now; }
        this.setSteps();
        if (!this.lastChart || now - this.lastChart > 250 || this.phase === "done") { this.updateTouchChart(); this.lastChart = now; }
      }
    }

    frame(now, dtReal) {
      this.pump(now);
      if (this.playing && this.aware && (this.phase === "run" || this.phase === "done")) {
        const lim = this.frontier();
        this.tFrac = Math.min(this.tFrac + dtReal / PLAY_SECONDS, this.phase === "done" ? 1.2 : lim);
        if (this.tFrac >= 1.2) this.tFrac = 0; // short hold at the end, then loop
        $("mfg-time").value = Math.round(Math.min(1, this.tFrac) * 1000);
        this.draw();
      }
    }

    setSteps() {
      const st = (id, state, text) => { const li = $(id); li.dataset.state = state; $(id + "-state").textContent = text; };
      const ph = this.phase, m = this.mfg.p;
      if (ph === "solve") {
        const k = this.job && this.job.residuals ? this.job.residuals.length : 0;
        st("pl-solve", "active", this.job && this.job.phase === "blind" ? "and the crowd-blind version" : `round ${k} of ${m.iters}`);
      } else if (this.aware) {
        const r = this.aware.res.residuals;
        st("pl-solve", "done", `gap ${r[r.length - 1].toExponential(1)} after ${r.length} rounds`);
      } else st("pl-solve", "waiting", "waiting");
      const n = this.duel.p.n;
      if (ph === "draw") st("pl-draw", "active", `${n} spots, drawn in proportion to the density`);
      else if (ph === "run" || ph === "done") st("pl-draw", "done", `${n} spots, shared by all three crowds`);
      else st("pl-draw", "waiting", "waiting");
      if (ph === "run") st("pl-run", "active", `${Math.round(100 * this.duel.progress)}% simulated`);
      else if (ph === "done") st("pl-run", "done", "done: scrub, replay, compare below");
      else st("pl-run", "waiting", "waiting");
      $("mfg-status").textContent = ph === "solve" ? "Solving the game" : this.stale && ph !== "draw" ? "Settings changed" : "";
    }

    /* ---------------- results ---------------- */

    summarise(res) {
      const M = this.mfg.mesh, n = M.n, Nt = res.mHist.length - 1, dt = this.mfg.p.T / Nt, nu = this.mfg.p.nu;
      let m0max = 0; for (let i = 0; i < n; i++) m0max = Math.max(m0max, res.m0[i]);
      let peak = 0; for (const m of res.mHist) for (let i = 0; i < n; i++) if (m[i] > peak) peak = m[i];
      const doors = [0, 0];
      if (this.mfg.p.scene === "twodoors") {
        for (let t = 0; t < Nt; t++) {
          const b = res.bHist[t], m = res.mHist[t + 1];
          for (let i = 0; i < n; i++) {
            if (M.xs[i] >= 0.5) continue;
            for (let k = M.start[i]; k < M.start[i + 1]; k++) {
              const j = M.nbr[k];
              if (M.xs[j] < 0.5) continue;
              const flux = M.tau[k] * ((b[k] + nu) * m[i] - (b[M.rev[k]] + nu) * m[j]);
              doors[0.5 * (M.ys[i] + M.ys[j]) < 0.5 ? 0 : 1] += dt * flux;
            }
          }
        }
      }
      return { res, scale: m0max, peakRel: peak / m0max, doors, velCache: new Map() };
    }

    /* ---- the results table, written from whatever game was just played ---- */

    snapshot() {
      const p = this.mfg.p, d = this.duel.p;
      return {
        scene: p.scene, kappa: p.kappa, urgency: p.urgency, nu: p.nu, T: p.T, cells: p.cells, mesh: p.mesh, iters: p.iters,
        n: d.n, pressure: d.pressure, repulsion: d.repulsion, spread: d.spread,
        start: { ...p.start }, target: { ...p.target },
      };
    }

    describe(s) {
      const room = { open: "An open room", door: "One door", twodoors: "Two doors" }[s.scene];
      const mesh = (VC.MFG_MESHES.find((m) => m.id === s.mesh) || { label: s.mesh }).label.toLowerCase();
      let t = `${room}, dislike of crowds κ = ${s.kappa}, urgency ${s.urgency.toFixed(1)}, randomness ${s.nu}, time allowed ${s.T.toFixed(1)}, ${s.cells}-cell ${mesh} mesh, ${s.n} agents`;
      const extras = [];
      if (!s.pressure) extras.push("reacting agents without Voronoi pressure");
      if (s.repulsion) extras.push("contact repulsion for everyone");
      if (!s.spread) extras.push("planners on the mean drift only");
      if (extras.length) t += `, ${extras.join(", ")}`;
      return t + ".";
    }

    /** what changed between two runs, in words */
    changes(a, b) {
      if (!a) return "first run";
      const out = [], fmt = (v) => (typeof v === "number" ? +v.toFixed(4) : v);
      const names = { kappa: "κ", urgency: "urgency", nu: "randomness", T: "time", cells: "cells", iters: "rounds", n: "agents" };
      for (const k in names) if (a[k] !== b[k]) out.push(`${names[k]} ${fmt(a[k])} → ${fmt(b[k])}`);
      if (a.scene !== b.scene) out.push(`room: ${{ open: "open", door: "one door", twodoors: "two doors" }[b.scene]}`);
      if (a.mesh !== b.mesh) out.push(`mesh: ${b.mesh}`);
      for (const k of ["pressure", "repulsion", "spread"]) if (a[k] !== b[k]) out.push(`${{ pressure: "pressure", repulsion: "repulsion", spread: "spread" }[k]} ${b[k] ? "on" : "off"}`);
      const moved = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) > 1e-6 || Math.abs(p.R - q.R) > 1e-6;
      if (moved(a.start, b.start)) out.push("start moved");
      if (moved(a.target, b.target)) out.push("target moved");
      return out.length ? out.join(", ") : "same settings, new draw";
    }

    tableStatus(text) { $("du-status").textContent = text; }

    clearTable() {
      document.querySelectorAll(".compare-4 td[id]").forEach((td) => (td.textContent = "–"));
      $("du-door-row").hidden = this.mfg.p.scene !== "twodoors";
      $("du-table").classList.add("live");
      this.tableStatus(this.phase === "solve" ? `Solving the game for: ${this.describe(this.snapshot())}` : "");
    }

    farDoor() { const bd = this.blind.doors; return bd[0] < bd[1] ? 0 : 1; }

    fillEquilibrium() {
      const D = this.duel, set = (id, v) => { $(id).textContent = v; }, eq = D.equilibriumCost();
      const two = this.mfg.p.scene === "twodoors", far = this.farDoor();
      set("du-tot-eq", f3(eq.total)); set("du-mov-eq", f3(eq.move)); set("du-cro-eq", f3(eq.crowd)); set("du-ter-eq", f3(eq.terminal));
      set("du-arr-eq", pct(eq.arrived)); set("du-pk-eq", this.aware.peakRel.toFixed(1) + "×");
      if (two) set("du-door-eq", pct(this.aware.doors[far] / Math.max(1e-12, this.aware.doors[0] + this.aware.doors[1])));
      this.tableStatus(`Running ${this.runSettings.n} agents for: ${this.describe(this.runSettings)}`);
    }

    /** live while step 3 runs (costs so far), final once it is done */
    fillTable() {
      const D = this.duel, set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      const done = this.phase === "done", two = this.mfg.p.scene === "twodoors", far = this.farDoor();
      $("du-door-row").hidden = !two;
      $("du-table").classList.toggle("live", !done);
      const share = (d) => (d[0] + d[1] > 0 ? d[far] / (d[0] + d[1]) : null);
      for (const key of VC.DUEL_KEYS) {
        const s = done ? D.summary(key) : D.partial(key);
        set(`du-mov-${key}`, f3(s.move)); set(`du-cro-${key}`, f3(s.crowd));
        set(`du-tot-${key}`, done ? f3(s.total) : f3(s.move + s.crowd) + " so far");
        set(`du-ter-${key}`, done ? f3(s.terminal) : "billed at the end");
        set(`du-arr-${key}`, done ? pct(s.arrived) : "…");
        set(`du-pk-${key}`, s.peakRel.toFixed(1) + "×"); set(`du-tch-${key}`, String(s.peakTouch));
        if (two) set(`du-door-${key}`, pct(share(s.doors)));
      }
      const t = (D.t).toFixed(2), T = D.T.toFixed(1);
      this.tableStatus(done ? `Final numbers for: ${this.describe(this.runSettings)}` : `Costs so far at t = ${t} of ${T}, for: ${this.describe(this.runSettings)}`);
    }

    /** one row per finished run, newest first, so slider changes can be compared */
    logRun() {
      const D = this.duel, s = this.runSettings, prev = this.runs && this.runs.length ? this.runs[0].settings : null;
      const sum = (k) => D.summary(k).total, eq = D.equilibriumCost().total;
      this.runs = this.runs || [];
      this.runCount = (this.runCount || 0) + 1;
      this.runs.unshift({ id: this.runCount, settings: s, change: this.changes(prev, s), react: sum("react"), plan: sum("plan"), blind: sum("blind"), eq });
      if (this.runs.length > 12) this.runs.pop();
      const body = $("du-log-body");
      body.innerHTML = "";
      this.runs.forEach((r, i) => {
        const tr = document.createElement("tr");
        if (i === 0) tr.className = "latest";
        const cells = [String(r.id), r.change, f3(r.react), f3(r.plan), f3(r.blind), f3(r.eq), (r.react / r.plan).toFixed(1) + "×"];
        cells.forEach((v, j) => { const c = document.createElement(j === 0 ? "th" : "td"); if (j === 0) c.scope = "row"; c.textContent = v; if (j === 1) c.title = this.describe(r.settings); tr.appendChild(c); });
        body.appendChild(tr);
      });
      $("du-log").hidden = false;
    }

    updateTouchChart() {
      const D = this.duel;
      if (!D.ready) return;
      const ts = D.frames.t;
      const ser = (key, name, short, color, dash) => ({ name, short, color, dash, xs: ts.slice(), ys: D.frames[key].count.slice() });
      const planKey = this.view === "aware" ? "plan" : "blind";
      this.touchChart.setSeries([
        ser("react", "Reacting agents", "reacting", VC.COLORS.seriesNow),
        ser(planKey, this.view === "aware" ? "Planning agents" : "Crowd-blind planners", "planning", VC.COLORS.seriesPrev, "5 4"),
      ]);
    }

    updatePlay() {
      const b = $("mfg-play");
      b.textContent = this.playing ? "Pause" : "Play";
      b.setAttribute("aria-pressed", String(this.playing));
      b.disabled = !(this.phase === "run" || this.phase === "done");
    }

    /* ---------------- drawing ---------------- */

    densityAt(sol, tf) {
      const H = sol.res.mHist, Nt = H.length - 1;
      const x = Math.min(1, Math.max(0, tf)) * Nt, i0 = Math.min(Nt - 1, Math.floor(x)), a = x - i0;
      const A = H[i0], B = H[i0 + 1], out = new Float64Array(A.length);
      for (let i = 0; i < A.length; i++) out[i] = (1 - a) * A[i] + a * B[i];
      return { m: out, step: i0 };
    }

    fillCells(st, dens, scale, alpha) {
      const c = st.ctx, k = st.k, C = VC.COLORS, M = this.mfg.mesh;
      if (!M) return;
      c.globalAlpha = alpha; c.lineJoin = "round";
      for (let i = 0; i < M.n; i++) {
        const poly = M.vor.polys[i];
        c.beginPath(); c.moveTo(poly[0], poly[1]);
        for (let q = 2; q < poly.length; q += 2) c.lineTo(poly[q], poly[q + 1]);
        c.closePath();
        const col = dens ? VC.ramp(dens[i] / (scale * 0.9)) : C.paper;
        c.fillStyle = col; c.fill();
        c.lineWidth = (this.showMesh ? 0.8 : 0.6) / k;
        c.strokeStyle = this.showMesh ? C.rule : col;
        c.stroke();
      }
      c.globalAlpha = 1;
    }

    drawAgents(st, pos, touch, alpha) {
      if (!pos || !this.showAgents) return;
      const c = st.ctx, k = st.k, C = VC.COLORS, n = pos.length / 2;
      const br = Math.max(1.5 / k, this.duel.radius || 0);
      c.globalAlpha = alpha;
      c.fillStyle = C.ink; c.beginPath();
      for (let i = 0; i < n; i++) if (!touch || !touch[i]) { c.moveTo(pos[2 * i] + br, pos[2 * i + 1]); c.arc(pos[2 * i], pos[2 * i + 1], br, 0, 2 * Math.PI); }
      c.fill();
      if (touch) {
        c.fillStyle = C.paper; c.strokeStyle = C.ink; c.lineWidth = 1 / k; c.beginPath();
        for (let i = 0; i < n; i++) if (touch[i]) { c.moveTo(pos[2 * i] + br, pos[2 * i + 1]); c.arc(pos[2 * i], pos[2 * i + 1], br, 0, 2 * Math.PI); }
        c.fill(); c.stroke();
      }
      c.globalAlpha = 1;
    }

    drawRoom(st, handles) {
      const c = st.ctx, k = st.k, C = VC.COLORS, m = this.mfg;
      c.fillStyle = C.ink;
      for (const w of VC.mfgWalls(m.p.scene)) c.fillRect(w.x0, w.y0, w.x1 - w.x0, w.y1 - w.y0);
      VC.drawHandle(c, k, m.p.start, { color: C.ink, dash: [5, 4], resizable: handles, label: "start", knobFill: C.paper });
      VC.drawHandle(c, k, m.p.target, { color: C.exit, lineWidth: 2.5, resizable: handles, label: "target", knobFill: C.paper });
    }

    draw() {
      const C = VC.COLORS, m = this.mfg, M = m.mesh, D = this.duel;
      const L = this.stage, R = this.stageR;
      L.clear(C.paper); R.clear(C.paper);
      const tFrac = Math.min(1, this.tFrac);
      $("mfg-time-out").textContent = `t = ${(tFrac * m.p.T).toFixed(2)}`;

      const sol = this.view === "aware" ? this.aware : this.blind;
      const dim = this.stale && this.phase !== "solve" ? 0.35 : 1;

      // left: the equilibrium density (live preview while solving)
      if (this.phase === "solve" && this.job && this.job.mBar && M) {
        const H = this.job.mBar, t = Math.round(tFrac * (H.length - 1));
        let sc = 0; for (let i = 0; i < H[0].length; i++) sc = Math.max(sc, H[0][i]);
        this.fillCells(L, H[t], sc, 1);
      } else if (sol && M && sol.res.mHist[0].length === M.n) {
        const d = this.densityAt(sol, tFrac);
        this.fillCells(L, d.m, this.aware.scale, dim);
        if (this.showFlow && !this.stale) this.drawFlow(L, sol, d.step, d.m, this.aware.scale);
      } else if (M) this.fillCells(L, null, 1, 1);

      // agents (left: planners of the chosen game; right: reacting)
      if (D.ready && !this.stale) {
        const frames = D.frames, nF = frames.t.length;
        const idx = Math.min(nF - 1, Math.round(tFrac * D.p.steps));
        const appear = this.phase === "draw" ? Math.min(1, (performance.now() - this.drawStart) / (DRAW_SECONDS * 1000)) : 1;
        const planKey = this.view === "aware" ? "plan" : "blind";
        this.drawAgents(L, frames[planKey].pos[idx], frames[planKey].touch[idx], appear);
        // right: reacting crowd's own density on the mesh, then its agents
        if (this.phase !== "draw") this.fillCells(R, frames.reactDens[idx], this.aware.scale, 1);
        else if (sol) this.fillCells(R, this.densityAt(this.aware, 0).m, this.aware.scale, 1 - appear);
        this.drawAgents(R, frames.react.pos[idx], frames.react.touch[idx], appear);
      } else if (this.aware && M) {
        this.fillCells(R, this.densityAt(this.aware, 0).m, this.aware.scale, 0.35);
      }
      this.drawRoom(L, true);
      this.drawRoom(R, false);
    }

    drawFlow(st, sol, step, dens, scale) {
      const c = st.ctx, k = st.k, C = VC.COLORS, m = this.mfg, M = m.mesh;
      let v = sol.velCache.get(step);
      if (!v) { v = m.velocity(sol.res, step); sol.velCache.set(step, v); }
      c.strokeStyle = C.ink; c.lineWidth = 1.1 / k; c.globalAlpha = 0.6;
      c.beginPath();
      for (let i = 0; i < M.n; i++) {
        if (dens[i] < 0.12 * scale) continue;
        const vx = v.vx[i], vy = v.vy[i], sp = Math.hypot(vx, vy);
        if (sp < 1e-4) continue;
        const Lh = Math.min(0.035, sp * 0.03), ux = vx / sp, uy = vy / sp;
        const x0 = M.xs[i] - 0.5 * Lh * ux, y0 = M.ys[i] - 0.5 * Lh * uy, x1 = x0 + Lh * ux, y1 = y0 + Lh * uy;
        const hd = Math.min(0.4 * Lh, 4 / k);
        c.moveTo(x0, y0); c.lineTo(x1, y1);
        c.moveTo(x1, y1); c.lineTo(x1 - hd * (ux - 0.5 * uy), y1 - hd * (uy + 0.5 * ux));
        c.moveTo(x1, y1); c.lineTo(x1 - hd * (ux + 0.5 * uy), y1 - hd * (uy - 0.5 * ux));
      }
      c.stroke(); c.globalAlpha = 1;
    }
  }

  VC.MFGView = MFGView;
})(typeof window !== "undefined" ? window : globalThis);

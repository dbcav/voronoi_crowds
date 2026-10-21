/*
 * A small SVG line chart: thin lines, recessive axes, legend + direct labels,
 * crosshair tooltip on hover. Enough for "touching pairs over time" and
 * "fictitious-play residual per iteration".
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  function niceTicks(lo, hi, count) {
    const span = hi - lo || 1;
    const step0 = span / count, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const err = step0 / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * step; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  const fmt = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Math.abs(v) >= 10 ? Math.round(v) : +v.toPrecision(2));

  class LineChart {
    /**
     * @param {HTMLElement} host
     * @param {{xLabel:string, yLabel:string, logY?:boolean, height?:number, xFmt?:Function, yFmt?:Function}} opts
     */
    constructor(host, opts) {
      this.host = host;
      this.o = Object.assign({ height: 150, xFmt: fmt, yFmt: fmt }, opts);
      this.series = [];
      host.classList.add("chart");
      this.legend = document.createElement("div");
      this.legend.className = "chart-legend";
      host.appendChild(this.legend);
      this.svg = el("svg", { role: "img", "aria-label": opts.aria || opts.yLabel }, host);
      this.tip = document.createElement("div");
      this.tip.className = "chart-tip";
      this.tip.hidden = true;
      host.appendChild(this.tip);
      this.svg.addEventListener("pointermove", (e) => this.hover(e));
      this.svg.addEventListener("pointerleave", () => this.unhover());
      new ResizeObserver(() => this.render()).observe(host);
    }

    /** series: [{ name, color, dash, xs:Float64Array|number[], ys }] */
    setSeries(series) { this.series = series.filter((s) => s && s.xs.length); this.render(); }

    scales() {
      const W = Math.max(200, this.host.clientWidth), H = this.o.height;
      const m = { l: 44, r: 92, t: 10, b: 30 };
      let x0 = Infinity, x1 = -Infinity, y0 = this.o.logY ? Infinity : 0, y1 = -Infinity;
      for (const s of this.series) for (let i = 0; i < s.xs.length; i++) {
        x0 = Math.min(x0, s.xs[i]); x1 = Math.max(x1, s.xs[i]);
        const y = s.ys[i];
        if (this.o.logY) { if (y > 0) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); } } else y1 = Math.max(y1, y);
      }
      if (!isFinite(x0)) { x0 = 0; x1 = 1; }
      if (x1 === x0) x1 = x0 + 1;
      if (this.o.logY) {
        if (!isFinite(y0)) { y0 = 1e-3; y1 = 1; }
        y0 = Math.pow(10, Math.floor(Math.log10(y0))); y1 = Math.pow(10, Math.ceil(Math.log10(y1)));
        if (y1 === y0) y1 = y0 * 10;
      } else { if (!(y1 > 0)) y1 = 1; y1 = niceTicks(0, y1 * 1.05, 4).slice(-1)[0] || y1; }
      const sx = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
      const sy = this.o.logY
        ? (v) => m.t + (1 - (Math.log10(Math.max(v, y0)) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0))) * (H - m.t - m.b)
        : (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
      return { W, H, m, x0, x1, y0, y1, sx, sy };
    }

    render() {
      const svg = this.svg, S = this.scales();
      this.S = S;
      svg.setAttribute("viewBox", `0 0 ${S.W} ${S.H}`);
      svg.setAttribute("width", S.W); svg.setAttribute("height", S.H);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const g = el("g", { class: "axes" }, svg);
      // y grid + labels
      const yt = this.o.logY
        ? (() => { const t = []; for (let e = Math.log10(S.y0); e <= Math.log10(S.y1) + 1e-9; e++) t.push(Math.pow(10, e)); return t; })()
        : niceTicks(S.y0, S.y1, 4);
      for (const v of yt) {
        const y = S.sy(v);
        el("line", { x1: S.m.l, x2: S.W - S.m.r, y1: y, y2: y, class: "grid" }, g);
        const t = el("text", { x: S.m.l - 6, y: y + 4, class: "tick", "text-anchor": "end" }, g);
        t.textContent = this.o.logY ? `1e${Math.round(Math.log10(v))}` : this.o.yFmt(v);
      }
      for (const v of niceTicks(S.x0, S.x1, 5)) {
        const x = S.sx(v);
        const t = el("text", { x, y: S.H - S.m.b + 16, class: "tick", "text-anchor": "middle" }, g);
        t.textContent = this.o.xFmt(v);
      }
      el("line", { x1: S.m.l, x2: S.W - S.m.r, y1: S.H - S.m.b, y2: S.H - S.m.b, class: "baseline" }, g);
      const xl = el("text", { x: S.W - S.m.r, y: S.H - 2, class: "axis-label", "text-anchor": "end" }, g);
      xl.textContent = this.o.xLabel;

      // lines + direct labels at the right end
      const labels = [];
      for (const s of this.series) {
        let d = "";
        for (let i = 0; i < s.xs.length; i++) {
          if (this.o.logY && !(s.ys[i] > 0)) continue;
          d += (d ? "L" : "M") + S.sx(s.xs[i]).toFixed(1) + "," + S.sy(s.ys[i]).toFixed(1);
        }
        el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dash || "none" }, svg);
        const last = s.xs.length - 1;
        labels.push({ s, y: S.sy(s.ys[last]), x: S.sx(s.xs[last]) });
      }
      labels.sort((a, b) => a.y - b.y);
      for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
      for (const L of labels) {
        el("circle", { cx: L.x, cy: S.sy(L.s.ys[L.s.ys.length - 1]), r: 3, fill: L.s.color }, svg);
        const t = el("text", { x: Math.min(L.x, S.W - S.m.r) + 8, y: L.y + 4, class: "direct-label" }, svg);
        t.textContent = L.s.short || L.s.name;
      }
      this.cross = el("line", { y1: S.m.t, y2: S.H - S.m.b, class: "crosshair", visibility: "hidden" }, svg);

      // legend (always present for 2+ series)
      this.legend.innerHTML = "";
      if (this.series.length > 1) {
        for (const s of this.series) {
          const item = document.createElement("span");
          item.className = "legend-item";
          item.innerHTML = `<svg width="22" height="8" aria-hidden="true"><line x1="1" x2="21" y1="4" y2="4" stroke="${s.color}" stroke-width="2" stroke-dasharray="${s.dash || "none"}"/></svg>`;
          item.appendChild(document.createTextNode(s.name));
          this.legend.appendChild(item);
        }
      }
    }

    hover(e) {
      if (!this.S || !this.series.length) return;
      const r = this.svg.getBoundingClientRect(), S = this.S;
      const px = ((e.clientX - r.left) / r.width) * S.W;
      if (px < S.m.l || px > S.W - S.m.r) return this.unhover();
      const xv = S.x0 + ((px - S.m.l) / (S.W - S.m.l - S.m.r)) * (S.x1 - S.x0);
      let html = `<b>${this.o.xLabel.split(" (")[0]} ${this.o.xFmt(xv)}</b>`;
      for (const s of this.series) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < s.xs.length; i++) { const d = Math.abs(s.xs[i] - xv); if (d < bd) { bd = d; best = i; } }
        html += `<span><i style="background:${s.color}"></i>${s.name}: ${this.o.yFmt(s.ys[best])}</span>`;
      }
      this.cross.setAttribute("x1", px); this.cross.setAttribute("x2", px);
      this.cross.setAttribute("visibility", "visible");
      this.tip.innerHTML = html;
      this.tip.hidden = false;
      const left = Math.min(r.width - this.tip.offsetWidth - 4, Math.max(0, (px / S.W) * r.width + 12));
      this.tip.style.left = left + "px";
    }
    unhover() { this.tip.hidden = true; if (this.cross) this.cross.setAttribute("visibility", "hidden"); }
  }

  VC.LineChart = LineChart;
})(typeof window !== "undefined" ? window : globalThis);

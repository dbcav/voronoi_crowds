/*
 * Shared UI plumbing: HiDPI canvas sizing, world <-> pixel transforms,
 * draggable circular handles (move by the body, resize by the rim square),
 * and small form helpers.
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});

  /** Keeps a canvas sized to its box at device resolution; world is [0,1]^2. */
  class Stage {
    constructor(canvas, onResize) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.onResize = onResize;
      this.size = 1;
      this.resize();
      new ResizeObserver(() => { this.resize(); if (this.onResize) this.onResize(); }).observe(canvas.parentElement);
    }
    resize() {
      const box = this.canvas.parentElement.getBoundingClientRect();
      const s = Math.max(120, Math.floor(Math.min(box.width, box.height || box.width)));
      const dpr = Math.min(global.devicePixelRatio || 1, 2.5);
      this.size = s; this.dpr = dpr;
      this.canvas.width = Math.round(s * dpr);
      this.canvas.height = Math.round(s * dpr);
      this.canvas.style.width = s + "px";
      this.canvas.style.height = s + "px";
      this.ctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0); // draw in world units
    }
    /** pixels per world unit (CSS px) */
    get k() { return this.size; }
    toWorld(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    }
    clear(color) {
      const c = this.ctx;
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = color; c.fillRect(0, 0, this.canvas.width, this.canvas.height);
      c.restore();
    }
  }
  VC.Stage = Stage;

  /**
   * Draggable circles. handles: [{ id, get(): {x,y,R}, resizable, onMove(x,y,R,phase) }]
   * phase is "start" | "move" | "end".
   */
  VC.attachHandles = function (stage, handles, onHover) {
    const cv = stage.canvas;
    let drag = null;
    const knob = (h) => { const s = h.get(); const a = -Math.PI / 4; return { x: s.x + s.R * Math.cos(a), y: s.y + s.R * Math.sin(a) }; };
    function hit(p) {
      const tol = 12 / stage.k;
      for (const h of handles) {
        if (!h.resizable) continue;
        const kn = knob(h);
        if (Math.hypot(p.x - kn.x, p.y - kn.y) < tol) return { h, mode: "resize" };
      }
      for (const h of handles) {
        const s = h.get();
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        if (d < Math.max(s.R, 16 / stage.k)) return { h, mode: "move" };
      }
      return null;
    }
    cv.addEventListener("pointerdown", (e) => {
      const p = stage.toWorld(e), t = hit(p);
      if (!t) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      const s = t.h.get();
      drag = { ...t, ox: p.x - s.x, oy: p.y - s.y };
      cv.style.cursor = t.mode === "resize" ? "nesw-resize" : "grabbing";
      t.h.onMove(s.x, s.y, s.R, "start");
    });
    cv.addEventListener("pointermove", (e) => {
      const p = stage.toWorld(e);
      if (!drag) {
        const t = hit(p);
        cv.style.cursor = !t ? "default" : t.mode === "resize" ? "nesw-resize" : "grab";
        if (onHover) onHover(t ? t.h.id : null);
        return;
      }
      const s = drag.h.get();
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      if (drag.mode === "move") {
        drag.h.onMove(clamp(p.x - drag.ox, 0.02, 0.98), clamp(p.y - drag.oy, 0.02, 0.98), s.R, "move");
      } else {
        const R = clamp(Math.hypot(p.x - s.x, p.y - s.y), 0.03, 0.45);
        drag.h.onMove(s.x, s.y, R, "move");
      }
    });
    const end = (e) => {
      if (!drag) return;
      const s = drag.h.get();
      drag.h.onMove(s.x, s.y, s.R, "end");
      drag = null;
      cv.style.cursor = "default";
      try { cv.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    return { knob, isDragging: () => !!drag };
  };

  /** Arrow keys on a focused canvas: target by default, start with shift. */
  VC.attachKeys = function (canvas, handles) {
    canvas.addEventListener("keydown", (e) => {
      const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!dirs[e.key]) return;
      e.preventDefault();
      const h = e.shiftKey ? handles.find((q) => q.id === "start") : handles.find((q) => q.id === "target");
      if (!h) return;
      const s = h.get(), d = 0.02;
      const x = Math.min(0.98, Math.max(0.02, s.x + dirs[e.key][0] * d));
      const y = Math.min(0.98, Math.max(0.02, s.y + dirs[e.key][1] * d));
      h.onMove(s.x, s.y, s.R, "start");
      h.onMove(x, y, s.R, "move");
      h.onMove(x, y, s.R, "end");
    });
  };

  /** Draw a handle: circle, centre mark, rim square. */
  VC.drawHandle = function (ctx, k, s, opts) {
    ctx.save();
    ctx.lineWidth = (opts.lineWidth || 1.5) / k;
    ctx.strokeStyle = opts.color;
    if (opts.dash) ctx.setLineDash(opts.dash.map((v) => v / k));
    ctx.beginPath(); ctx.arc(s.x, s.y, s.R, 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([]);
    // centre cross
    const c = 5 / k;
    ctx.beginPath(); ctx.moveTo(s.x - c, s.y); ctx.lineTo(s.x + c, s.y); ctx.moveTo(s.x, s.y - c); ctx.lineTo(s.x, s.y + c); ctx.stroke();
    if (opts.resizable) {
      const a = -Math.PI / 4, kx = s.x + s.R * Math.cos(a), ky = s.y + s.R * Math.sin(a), q = 4.5 / k;
      ctx.fillStyle = opts.knobFill || "#fff";
      ctx.fillRect(kx - q, ky - q, 2 * q, 2 * q);
      ctx.strokeRect(kx - q, ky - q, 2 * q, 2 * q);
    }
    if (opts.label) {
      ctx.font = `600 ${15 / k}px "Barlow Condensed", "Arial Narrow", sans-serif`;
      ctx.fillStyle = opts.color;
      ctx.textBaseline = "bottom";
      const lx = Math.min(0.97 - 0.06, Math.max(0.01, s.x - s.R * 0.7));
      const ly = Math.max(16 / k, s.y - s.R - 4 / k);
      ctx.fillText(opts.label, lx, ly);
    }
    ctx.restore();
  };

  /** Fill a <select> from [{id,label}] */
  VC.fillSelect = function (sel, items, value) {
    sel.innerHTML = "";
    for (const it of items) { const o = document.createElement("option"); o.value = it.id; o.textContent = it.label; sel.appendChild(o); }
    sel.value = value;
  };

  /** Bind a range input to an <output>. */
  VC.bindRange = function (input, out, fmt, onInput, onChange) {
    const show = () => { if (out) out.textContent = fmt(+input.value); };
    input.addEventListener("input", () => { show(); if (onInput) onInput(+input.value); });
    if (onChange) input.addEventListener("change", () => onChange(+input.value));
    show();
  };

  VC.reducedMotion = !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
})(typeof window !== "undefined" ? window : globalThis);

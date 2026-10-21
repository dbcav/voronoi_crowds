/*
 * Colour tokens shared by the canvases and charts, the sequential ramp used for
 * crowding (a single red hue, light to dark, built in OKLCH so the lightness
 * steps are even), and a diverging version of it centred on comfort for sheet 1.
 */
(function (global) {
  "use strict";
  const VC = (global.VC = global.VC || {});

  VC.COLORS = {
    paper: "#EEF1EC",
    ink: "#1E2A3A",
    ink2: "#4A5868",
    rule: "#C3CBC4",
    grid: "#DCE1DB",
    exit: "#0F7B53",
    seriesNow: "#2B67B5",
    seriesPrev: "#C9731C",
  };

  function oklchToRgb(L, C, hDeg) {
    const h = (hDeg * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return lin.map((c) => {
      c = Math.min(1, Math.max(0, c));
      const g = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      return Math.round(255 * g);
    });
  }

  // 256-step crowding ramp: near-paper at 0, deep wine at 1.
  const RAMP = [];
  for (let k = 0; k < 256; k++) {
    const t = k / 255;
    const L = 0.955 - 0.64 * Math.pow(t, 0.9);
    const C = 0.004 + 0.135 * Math.sin(Math.PI * Math.min(1, t * 0.95)) + 0.03 * t;
    const H = 32 - 14 * t; // drifts slightly from coral to wine, stays one hue family
    const [r, g, b] = oklchToRgb(L, C, H);
    RAMP.push(`rgb(${r},${g},${b})`);
  }
  /** colour for a value in [0, 1] (clamped) */
  VC.ramp = function (t) {
    if (!(t > 0.012)) return VC.COLORS.paper; // empty floor is just paper
    return RAMP[t >= 1 ? 255 : Math.floor(t * 255)];
  };
  VC.rampStops = function (k) {
    const out = [];
    for (let i = 0; i < k; i++) out.push(RAMP[Math.round((i * 255) / (k - 1))]);
    return out;
  };

  // Diverging ramp for sheet 1, centred on comfortable spacing: a quiet blue for
  // room to spare (t < 0), paper at t = 0, and the crowding reds for t > 0.
  const COOL = [];
  for (let k = 0; k < 128; k++) {
    const t = k / 127;
    const [r, g, b] = oklchToRgb(0.955 - 0.25 * t, 0.006 + 0.075 * t, 245);
    COOL.push(`rgb(${r},${g},${b})`);
  }
  /** colour for a value in [-1, 1] (clamped): negative is roomy, positive is squeezed */
  VC.diverge = function (t) {
    if (!(t === t)) return VC.COLORS.paper;
    if (t < 0) return COOL[t <= -1 ? 127 : Math.floor(-t * 127)];
    return RAMP[t >= 1 ? 216 : Math.floor(t * 216)];
  };
  VC.divergeStops = function (k) {
    const out = [];
    for (let i = 0; i < k; i++) out.push(VC.diverge(-1 + (2 * i) / (k - 1)));
    return out;
  };
})(typeof window !== "undefined" ? window : globalThis);

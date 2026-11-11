/* stage-screen.js — R135: what the stage backdrop screen and the standalone screens SHOW.
 *
 * One shared "screen content" model kept in item.properties (all optional, all plain text):
 *   screenTheme  '' (current look) | corporate | royal | floral | minimal | neon
 *   title        big event title          e.g. "Annual Day"
 *   brand        company / couple / host  e.g. "CRISKA"
 *   tagline      small line under brand   e.g. "Building intelligent futures"
 *   subtitle     line under the title     e.g. "Celebrating success, together"
 *   dateLine     date / venue line        e.g. "12 Dec 2026 · Hyderabad"
 *   screenMirror true = show the same content as the main stage screen (side / extra screens)
 * Every text is length-capped (60) and only ever drawn as TEXT (SVG textContent / canvas fillText),
 * never as HTML. Old layouts carry none of these keys, so they look exactly as before.
 * Pure data + drawing helpers: no DOM writes, no network. Browser: window.HelmScreen; Node: module.exports.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HelmScreen = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX = 60;
  var FIELDS = [
    ['title', 'Event title', 'Annual Day'],
    ['brand', 'Brand / company / couple', 'Company or couple name'],
    ['tagline', 'Tagline', 'Building intelligent futures'],
    ['subtitle', 'Subtitle', 'Celebrating success, together'],
    ['dateLine', 'Date / venue line', '12 Dec 2026 · Hyderabad']
  ];
  // '' = the builder's existing look (blue screen); the five themes are the owner's ask (R135)
  var THEMES = {
    '':        { name: 'Default',       bg: '#2f6fed', bg2: '#1d4fc4', accent: '#9cc2ff', ink: '#ffffff', sub: '#dbe7ff', motif: 'none' },
    corporate: { name: 'Corporate',     bg: '#0b2a5b', bg2: '#1e5bb8', accent: '#7cc4ff', ink: '#ffffff', sub: '#cfe3ff', motif: 'waves' },
    royal:     { name: 'Royal Gold',    bg: '#4a0b18', bg2: '#8a1c2e', accent: '#d4af37', ink: '#f8e7b0', sub: '#f3d98b', motif: 'border' },
    floral:    { name: 'Floral Pastel', bg: '#fff7f5', bg2: '#fde2e4', accent: '#e86a8c', ink: '#5b2a3a', sub: '#9b5a6b', motif: 'florals' },
    minimal:   { name: 'Minimal White', bg: '#ffffff', bg2: '#f1f1f1', accent: '#111111', ink: '#111111', sub: '#555555', motif: 'rule' },
    neon:      { name: 'Concert Neon',  bg: '#0a0614', bg2: '#1f0b3a', accent: '#ff3df2', ink: '#ffffff', sub: '#f5d0fe', motif: 'neon', accent2: '#22d3ee' }
  };
  var THEME_ORDER = ['', 'corporate', 'royal', 'floral', 'minimal', 'neon'];
  // which builder item types carry a screen: 'main' = the stage backdrop, 'side' = portrait side panel
  var SCREEN_TYPES = { stage: 'main', ledscreen: 'screen', videowall: 'screen', led: 'screen', sidescreen: 'side', brandwall: 'screen', backdrop: 'screen' };
  var PLACEHOLDER = 'Tap to add name & brand';
  var own = Object.prototype.hasOwnProperty;

  function cleanText(s) {
    if (typeof s !== 'string') return '';
    // control chars and markup-ish characters out, whitespace collapsed, hard length cap
    return s.replace(/[\u0000-\u001f\u007f<>{}`\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX);
  }
  function isScreenType(type) { return own.call(SCREEN_TYPES, String(type || '')); }
  function themeOf(key) { return own.call(THEMES, key) ? THEMES[key] : THEMES['']; }
  // coerce untrusted (imported / stored) screen props in place; unknown keys are left alone
  function sanitize(p) {
    if (!p || typeof p !== 'object') return p;
    FIELDS.forEach(function (f) { var k = f[0]; if (!own.call(p, k)) return; var v = cleanText(p[k]); if (v) p[k] = v; else delete p[k]; });
    if (own.call(p, 'screenTheme')) { if (typeof p.screenTheme !== 'string' || !own.call(THEMES, p.screenTheme) || !p.screenTheme) delete p.screenTheme; }
    if (own.call(p, 'screenMirror')) { if (p.screenMirror === true) p.screenMirror = true; else delete p.screenMirror; }
    return p;
  }
  function rawContent(p) {
    p = p || {};
    var c = { theme: (typeof p.screenTheme === 'string' && own.call(THEMES, p.screenTheme)) ? p.screenTheme : '' };
    FIELDS.forEach(function (f) { c[f[0]] = cleanText(p[f[0]]); });
    return c;
  }
  function hasText(c) { return !!(c && (c.title || c.brand || c.tagline || c.subtitle || c.dateLine)); }
  function hasContent(c) { return !!(c && (c.theme || hasText(c))); }
  // the stage whose screen is "the main screen" (first stage with content, else the first stage)
  function mainScreen(items) {
    var stages = (items || []).filter(function (o) { return o && o.type === 'stage'; });
    for (var i = 0; i < stages.length; i++) if (hasContent(rawContent(stages[i].properties))) return stages[i];
    return stages[0] || null;
  }
  // what this item's screen shows (mirror resolved). Returns null for non-screen types.
  function contentOf(it, items) {
    if (!it || !isScreenType(it.type)) return null;
    var p = it.properties || {};
    if (p.screenMirror === true && it.type !== 'stage') {
      var m = mainScreen(items);
      if (m && m !== it) { var mc = rawContent(m.properties); mc.mirrored = true; return mc; }
    }
    return rawContent(p);
  }
  function monogram(brand) { var m = String(brand || '').match(/[A-Za-z0-9]/); return m ? m[0].toUpperCase() : ''; }
  // one-line text for a small 2D band
  function shortLine(c) { if (!c) return ''; return [c.brand, c.title].filter(Boolean).join(' · ') || c.tagline || c.subtitle || c.dateLine || ''; }
  // stable key: the 3D view redraws a screen texture only when this changes
  function keyOf(c, side, w, h) { return [c.theme, c.title, c.brand, c.tagline, c.subtitle, c.dateLine, side ? 's' : 'm', w, h].join('\u0001'); }

  /* ---- canvas drawing (3D CanvasTexture). ctx = CanvasRenderingContext2D, W x H px. ---- */
  function fit(ctx, text, maxW, size, weight, family) {
    var s = size;
    for (; s > 8; s -= 2) { ctx.font = weight + ' ' + s + 'px ' + family; if (ctx.measureText(text).width <= maxW) break; }
    return s;
  }
  function line(ctx, text, x, y, maxW, size, weight, family, color) {
    if (!text) return 0; fit(ctx, text, maxW, size, weight, family); ctx.fillStyle = color; ctx.fillText(text, x, y); return 1;
  }
  function motif(ctx, W, H, T) {
    ctx.save();
    if (T.motif === 'waves') {
      for (var k = 0; k < 5; k++) {
        ctx.strokeStyle = 'rgba(124,196,255,' + (0.10 + k * 0.06) + ')'; ctx.lineWidth = Math.max(2, H * 0.012);
        ctx.beginPath(); var y0 = H * (0.72 + k * 0.05);
        ctx.moveTo(0, y0); ctx.bezierCurveTo(W * 0.3, y0 - H * 0.18, W * 0.6, y0 + H * 0.16, W, y0 - H * 0.06); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.beginPath(); ctx.arc(W * 0.9, H * 0.1, H * 0.5, 0, Math.PI * 2); ctx.fill();
    } else if (T.motif === 'border') {
      var m = Math.min(W, H) * 0.04; ctx.strokeStyle = T.accent; ctx.lineWidth = Math.max(2, m * 0.25);
      ctx.strokeRect(m, m, W - 2 * m, H - 2 * m); ctx.lineWidth = Math.max(1, m * 0.1); ctx.strokeRect(m * 1.6, m * 1.6, W - 3.2 * m, H - 3.2 * m);
      [[m * 1.6, m * 1.6], [W - m * 1.6, m * 1.6], [m * 1.6, H - m * 1.6], [W - m * 1.6, H - m * 1.6]].forEach(function (p) {
        ctx.fillStyle = T.accent; ctx.beginPath(); ctx.arc(p[0], p[1], m * 0.5, 0, Math.PI * 2); ctx.fill(); });
    } else if (T.motif === 'florals') {
      var R = Math.min(W, H) * 0.09, tones = ['#f6c1cc', '#f29bb0', '#fde2e4', '#e86a8c', '#c7e3c1'];
      [[0, 0], [W, 0], [0, H], [W, H]].forEach(function (p, i) {
        for (var j = 0; j < 7; j++) { var a = j / 7 * Math.PI * 2 + i; ctx.fillStyle = tones[(i + j) % tones.length];
          ctx.beginPath(); ctx.arc(p[0] + Math.cos(a) * R * 1.1, p[1] + Math.sin(a) * R * 1.1, R * (0.55 + (j % 3) * 0.12), 0, Math.PI * 2); ctx.fill(); }
      });
    } else if (T.motif === 'rule') {
      ctx.fillStyle = T.accent; ctx.fillRect(W * 0.4, H * 0.5 - 1, W * 0.2, Math.max(2, H * 0.006));
    } else if (T.motif === 'neon') {
      var g = ctx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, T.accent); g.addColorStop(1, T.accent2 || T.accent);
      ctx.strokeStyle = g; ctx.lineWidth = Math.max(3, H * 0.014); ctx.shadowColor = T.accent; ctx.shadowBlur = H * 0.04;
      ctx.strokeRect(W * 0.04, H * 0.06, W * 0.92, H * 0.88);
    }
    ctx.restore();
  }
  // draws a full screen face. opts.side = portrait side panel (brand + tagline only)
  function draw(ctx, W, H, c, opts) {
    opts = opts || {}; c = c || rawContent({});
    var T = themeOf(c.theme), sans = '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif', serif = 'Georgia, "Times New Roman", serif';
    var g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, T.bg); g.addColorStop(1, T.bg2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    motif(ctx, W, H, T);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var mono = monogram(c.brand), cx = W / 2;
    if (opts.side) {
      var r = Math.min(W * 0.28, H * 0.1);
      if (mono) { ctx.fillStyle = T.accent; ctx.beginPath(); ctx.arc(cx, H * 0.3, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = T.bg; ctx.font = '700 ' + Math.round(r * 1.1) + 'px ' + sans; ctx.fillText(mono, cx, H * 0.3 + r * 0.05); }
      line(ctx, c.brand, cx, H * 0.48, W * 0.86, Math.round(W * 0.16), '700', sans, T.ink);
      line(ctx, (c.tagline || '').toUpperCase(), cx, H * 0.56, W * 0.86, Math.round(W * 0.07), '600', sans, T.sub);
      line(ctx, c.title, cx, H * 0.7, W * 0.86, Math.round(W * 0.12), 'italic 700', serif, T.ink);
      return;
    }
    var r2 = H * 0.07, topY = H * 0.16;
    if (mono) {
      ctx.fillStyle = T.accent; ctx.beginPath(); ctx.arc(cx - Math.min(W * 0.18, r2 * 4.2), topY, r2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = T.bg; ctx.font = '700 ' + Math.round(r2 * 1.15) + 'px ' + sans; ctx.fillText(mono, cx - Math.min(W * 0.18, r2 * 4.2), topY + r2 * 0.05);
    }
    line(ctx, c.brand, cx + (mono ? r2 * 0.8 : 0), topY, W * 0.5, Math.round(H * 0.1), '700', sans, T.ink);
    line(ctx, (c.tagline || '').toUpperCase(), cx, topY + H * 0.1, W * 0.7, Math.round(H * 0.045), '600', sans, T.sub);
    line(ctx, c.title, cx, H * 0.5, W * 0.86, Math.round(H * 0.2), 'italic 700', serif, T.ink);
    line(ctx, (c.subtitle || '').toUpperCase(), cx, H * 0.66, W * 0.8, Math.round(H * 0.055), '600', sans, T.sub);
    line(ctx, c.dateLine, cx, H * 0.8, W * 0.7, Math.round(H * 0.05), '500', sans, T.sub);
  }
  return Object.freeze({
    MAX: MAX, FIELDS: FIELDS, THEMES: THEMES, THEME_ORDER: THEME_ORDER, SCREEN_TYPES: SCREEN_TYPES, PLACEHOLDER: PLACEHOLDER,
    cleanText: cleanText, isScreenType: isScreenType, themeOf: themeOf, sanitize: sanitize, rawContent: rawContent,
    hasText: hasText, hasContent: hasContent, mainScreen: mainScreen, contentOf: contentOf, monogram: monogram,
    shortLine: shortLine, keyOf: keyOf, draw: draw
  });
});

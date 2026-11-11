/* stage-screen.js — R135 + R137: what the stage backdrop screen and the standalone screens SHOW.
 *
 * One shared "screen content" model kept in item.properties (all optional):
 *   screenTheme  '' (current look) | corporate | royal | floral | minimal | neon | marigold | blackgold | tech
 *   title        big event title          e.g. "Annual Day"
 *   brand        company / couple / host  e.g. "CRISKA"
 *   tagline      small line under brand   e.g. "Building intelligent futures"
 *   subtitle     line under the title     e.g. "Celebrating success, together"
 *   dateLine     date / venue line        e.g. "12 Dec 2026 · Hyderabad"
 *   screenMirror true = show the same content as the main stage screen (side / extra screens)
 *   R137:
 *   screenLayout (stage only) '' = the look before R137 (centre screen; + two side panels once themed) |
 *                single | triple | wide | none
 *   screenBg     '#rrggbb' background colour over the theme's (text colour then picked for contrast)
 *   screenLogo   a REFERENCE to a logo picture, never the picture itself and never a data: URL:
 *                'studio' (the studio logo from Settings) or an invite-media storage path
 *                "<org uuid>/<event uuid>/<uuid>.(png|jpg|webp)" (private bucket, per-studio rules, signed to show)
 * Every text is length-capped (60) and only ever drawn as TEXT (SVG textContent / canvas fillText),
 * never as HTML. Old layouts carry none of these keys, so they look exactly as before.
 * Pure data + drawing helpers + a small logo image cache. Browser: window.HelmScreen; Node: module.exports.
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
  // '' = the builder's existing look (blue screen); five themes from R135, three more from R137
  var THEMES = {
    '':        { name: 'Default',       bg: '#2f6fed', bg2: '#1d4fc4', accent: '#9cc2ff', ink: '#ffffff', sub: '#dbe7ff', motif: 'none' },
    corporate: { name: 'Corporate',     bg: '#0b2a5b', bg2: '#1e5bb8', accent: '#7cc4ff', ink: '#ffffff', sub: '#cfe3ff', motif: 'waves' },
    royal:     { name: 'Royal Gold',    bg: '#4a0b18', bg2: '#8a1c2e', accent: '#d4af37', ink: '#f8e7b0', sub: '#f3d98b', motif: 'border' },
    floral:    { name: 'Floral Pastel', bg: '#fff7f5', bg2: '#fde2e4', accent: '#e86a8c', ink: '#5b2a3a', sub: '#9b5a6b', motif: 'florals' },
    minimal:   { name: 'Minimal White', bg: '#ffffff', bg2: '#f1f1f1', accent: '#111111', ink: '#111111', sub: '#555555', motif: 'rule' },
    neon:      { name: 'Concert Neon',  bg: '#0a0614', bg2: '#1f0b3a', accent: '#ff3df2', ink: '#ffffff', sub: '#f5d0fe', motif: 'neon', accent2: '#22d3ee' },
    marigold:  { name: 'Festive Marigold', bg: '#ffb703', bg2: '#fb8500', accent: '#9a1b1b', ink: '#4a0b0b', sub: '#5c1a0a', motif: 'marigold', accent2: '#2f7d32' },
    blackgold: { name: 'Elegant Black-Gold', bg: '#0b0b0d', bg2: '#24211b', accent: '#d4af37', ink: '#f5e6b8', sub: '#d9c38a', motif: 'deco' },
    tech:      { name: 'Tech Gradient', bg: '#2b1055', bg2: '#0f6ad8', accent: '#00e5ff', ink: '#ffffff', sub: '#d6f6ff', motif: 'grid', accent2: '#a855f7' }
  };
  var THEME_ORDER = ['', 'corporate', 'royal', 'floral', 'minimal', 'neon', 'marigold', 'blackgold', 'tech'];
  // R137 stage screen layouts ('' = exactly the look before R137)
  var LAYOUTS = [
    ['', 'Standard (as before)'],
    ['single', 'Single – one wide centre screen'],
    ['triple', 'Triple – centre + left & right panels'],
    ['wide', 'Wide LED wall – one full-width screen'],
    ['none', 'None – plain backdrop, no screen']
  ];
  var BG_SWATCHES = ['#0b2a5b', '#4a0b18', '#0a0614', '#ffffff', '#ffb703', '#14532d', '#1f2937', '#0f766e'];
  // which builder item types carry a screen: 'main' = the stage backdrop, 'side' = portrait side panel
  var SCREEN_TYPES = { stage: 'main', ledscreen: 'screen', videowall: 'screen', led: 'screen', sidescreen: 'side', brandwall: 'screen', backdrop: 'screen' };
  var PLACEHOLDER = 'Tap to add name & brand';
  var own = Object.prototype.hasOwnProperty;
  var HEX_RE = /^#[0-9a-f]{6}$/;
  // an invite-media object key as storage_key_ok (0027) accepts it, minus GIF: <org>/<event>/<random>.<ext>
  var UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  var LOGO_PATH_RE = new RegExp('^' + UUID + '/' + UUID + '/(?:' + UUID + '|[0-9a-f]{32})\\.(?:png|jpg|webp)$');
  var LOGO_MAX_BYTES = 2 * 1024 * 1024, LOGO_MAX_PX = 512;

  function cleanText(s) {
    if (typeof s !== 'string') return '';
    // control chars and markup-ish characters out, whitespace collapsed, hard length cap
    return s.replace(/[\u0000-\u001f\u007f<>{}`\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX);
  }
  function cleanHex(v) { if (typeof v !== 'string') return ''; var s = v.trim().toLowerCase(); return HEX_RE.test(s) ? s : ''; }
  function cleanLogo(v) { if (typeof v !== 'string') return ''; if (v === 'studio') return 'studio'; return LOGO_PATH_RE.test(v) ? v : ''; }
  function cleanLayout(v) { return (typeof v === 'string' && v && LAYOUTS.some(function (l) { return l[0] === v; })) ? v : ''; }
  function isScreenType(type) { return own.call(SCREEN_TYPES, String(type || '')); }
  function themeOf(key) { return own.call(THEMES, key) ? THEMES[key] : THEMES['']; }

  /* ---- colour: WCAG relative luminance + contrast; custom background -> readable text ---- */
  function rgb(h) { h = cleanHex(h) || '#000000'; return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function hex(c) { return '#' + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function luminance(h) {
    var c = rgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { var la = luminance(a), lb = luminance(b), hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }
  function mix(a, b, t) { var x = rgb(a), y = rgb(b); return hex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * t; })); }
  // the theme's own ink when it already reads at >= 4.5:1 on this background, else near-black / white (whichever is higher)
  function inkFor(bg, preferred) {
    if (preferred && cleanHex(preferred) && contrast(bg, preferred) >= 4.5) return preferred;
    var w = contrast(bg, '#ffffff'), k = contrast(bg, '#111111');
    if (Math.max(w, k) >= 4.5) return w >= k ? '#ffffff' : '#111111';
    return w >= contrast(bg, '#000000') ? '#ffffff' : '#000000';   // mid tones: pure black or white always reaches 4.5:1
  }
  // the effective palette of a content object: the theme, with the custom background (and readable text) over it
  function paletteOf(c) {
    var T = themeOf(c && c.theme);
    if (!c || !c.bg) return T;
    var bg = c.bg, dark = luminance(bg) < 0.18, ink = inkFor(bg, T.ink);
    var sub = contrast(bg, T.sub) >= 4.5 ? T.sub : mix(ink, bg, 0.15);
    if (contrast(bg, sub) < 4.5) sub = ink;
    var out = {}; for (var k in T) if (own.call(T, k)) out[k] = T[k];
    out.bg = bg; out.bg2 = mix(bg, dark ? '#ffffff' : '#000000', 0.14); out.ink = ink; out.sub = sub; out.custom = true;
    return out;
  }

  // coerce untrusted (imported / stored) screen props in place; unknown keys are left alone
  function sanitize(p) {
    if (!p || typeof p !== 'object') return p;
    FIELDS.forEach(function (f) { var k = f[0]; if (!own.call(p, k)) return; var v = cleanText(p[k]); if (v) p[k] = v; else delete p[k]; });
    if (own.call(p, 'screenTheme')) { if (typeof p.screenTheme !== 'string' || !own.call(THEMES, p.screenTheme) || !p.screenTheme) delete p.screenTheme; }
    if (own.call(p, 'screenMirror')) { if (p.screenMirror === true) p.screenMirror = true; else delete p.screenMirror; }
    if (own.call(p, 'screenLayout')) { var l = cleanLayout(p.screenLayout); if (l) p.screenLayout = l; else delete p.screenLayout; }
    if (own.call(p, 'screenBg')) { var b = cleanHex(p.screenBg); if (b) p.screenBg = b; else delete p.screenBg; }
    if (own.call(p, 'screenLogo')) { var g = cleanLogo(p.screenLogo); if (g) p.screenLogo = g; else delete p.screenLogo; }
    return p;
  }
  function rawContent(p) {
    p = p || {};
    var c = { theme: (typeof p.screenTheme === 'string' && own.call(THEMES, p.screenTheme)) ? p.screenTheme : '' };
    FIELDS.forEach(function (f) { c[f[0]] = cleanText(p[f[0]]); });
    c.layout = cleanLayout(p.screenLayout); c.bg = cleanHex(p.screenBg); c.logo = cleanLogo(p.screenLogo);
    return c;
  }
  function hasText(c) { return !!(c && (c.title || c.brand || c.tagline || c.subtitle || c.dateLine)); }
  function hasContent(c) { return !!(c && (c.theme || hasText(c) || c.bg || c.logo || (c.layout && c.layout !== 'none'))); }
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
      if (m && m !== it) { var mc = rawContent(m.properties); mc.layout = ''; mc.mirrored = true; return mc; }
    }
    var c = rawContent(p); if (it.type !== 'stage') c.layout = '';
    return c;
  }
  /* R137 screen layout of a stage: the screens on its backdrop wall, as fractions of the stage width (x = centre,
     w = width) and of the backdrop height (y = centre above the deck, h = height). '' keeps the pre-R137 look:
     one centre screen ('legacy' = the plain blue box), plus two portrait side panels once the screen has content. */
  function layoutOf(c) { var l = c && c.layout; if (l) return l; return hasContent(c) ? 'triple' : 'legacy'; }
  function stageSegments(layout, wFt) {
    var w = Math.max(1, +wFt || 1), pw = Math.max(1.5, w * 0.1) / w;
    if (layout === 'none') return [];
    if (layout === 'wide') return [{ x: 0, w: 0.9, y: 0.55, h: 0.72, side: false, slot: '' }];
    if (layout === 'single') return [{ x: 0, w: 0.56, y: 0.6, h: 0.52, side: false, slot: '' }];
    if (layout === 'legacy') return [{ x: 0, w: 0.42, y: 0.6, h: 0.45, side: false, slot: '' }];
    return [{ x: 0, w: 0.42, y: 0.6, h: 0.45, side: false, slot: '' },
      { x: -0.34, w: pw, y: 0.52, h: 0.62, side: true, slot: ':side' }, { x: 0.34, w: pw, y: 0.52, h: 0.62, side: true, slot: ':side' }];
  }
  function monogram(brand) { var m = String(brand || '').match(/[A-Za-z0-9]/); return m ? m[0].toUpperCase() : ''; }
  // one-line text for a small 2D band
  function shortLine(c) { if (!c) return ''; return [c.brand, c.title].filter(Boolean).join(' · ') || c.tagline || c.subtitle || c.dateLine || ''; }
  // stable key: the 3D view redraws a screen texture only when this changes (logo: only whether its picture is ready)
  function keyOf(c, side, w, h) {
    return [c.theme, c.title, c.brand, c.tagline, c.subtitle, c.dateLine, side ? 's' : 'm', w, h, c.bg || '', c.logo ? c.logo + ':' + logoState(c.logo) : ''].join('\u0001');
  }

  /* ---- R137 logo picture: validation (bytes, never the file name / declared type), then a small image cache ---- */
  // first bytes -> { mime, ext } for PNG / JPEG / WebP only. SVG (can carry script) and GIF are refused.
  function sniffLogo(bytes) {
    var b = bytes || [], at = function (i) { return b[i] | 0; };
    if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return { mime: 'image/png', ext: 'png' };
    if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
    if (b.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return { mime: 'image/webp', ext: 'webp' };
    return null;
  }
  // { ok:true, mime, ext } or { ok:false, reason } (plain words for the owner)
  function validateLogo(file, bytes) {
    var size = file && +file.size, type = String((file && file.type) || '').toLowerCase(), name = String((file && file.name) || '').toLowerCase();
    if (!file || !(size > 0)) return { ok: false, reason: 'That file is empty.' };
    if (/svg/.test(type) || /\.svgz?$/.test(name)) return { ok: false, reason: 'SVG logos are not accepted. Please use a PNG, JPG or WebP picture.' };
    if (size > LOGO_MAX_BYTES) return { ok: false, reason: 'That picture is over 2 MB. Please use a smaller PNG, JPG or WebP.' };
    var s = sniffLogo(bytes);
    if (!s) return { ok: false, reason: 'That is not a PNG, JPG or WebP picture.' };
    return { ok: true, mime: s.mime, ext: s.ext };
  }
  // the size a logo is shrunk to before upload (longest side <= 512 px, never enlarged)
  function fitLogoSize(w, h, max) {
    max = max || LOGO_MAX_PX; w = Math.max(1, Math.round(+w || 1)); h = Math.max(1, Math.round(+h || 1));
    var k = Math.min(1, max / Math.max(w, h)); return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  // logo images: ref -> { state: 'loading' | 'ok' | 'fail', img }. The page sets the resolver (ref -> signed https URL).
  var LOGO = new Map(), resolver = null, listeners = [];
  function setLogoResolver(fn) { resolver = typeof fn === 'function' ? fn : null; }
  function onLogoChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function logoState(ref) { var e = ref && LOGO.get(ref); return e ? e.state : 'none'; }
  function settle(ref, state, img) { LOGO.set(ref, { state: state, img: img || null }); listeners.forEach(function (f) { try { f(ref, state); } catch (e) {} }); }
  function okUrl(u) { return typeof u === 'string' && u.length <= 2000 && /^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)[^\s"'<>]+$/i.test(u); }
  // the loaded image for a logo reference, or null (still loading, failed, no resolver, not a browser): callers then
  // draw the brand monogram. Starts the load on first ask; the listeners re-render when it lands.
  function logoImage(ref) {
    ref = cleanLogo(ref); if (!ref) return null;
    var e = LOGO.get(ref); if (e) return e.state === 'ok' ? e.img : null;
    if (!resolver || typeof Image === 'undefined') return null;
    LOGO.set(ref, { state: 'loading', img: null });
    Promise.resolve().then(function () { return resolver(ref); }).then(function (url) {
      if (!okUrl(url)) { settle(ref, 'fail'); return; }
      var img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
      img.onload = function () { settle(ref, img.naturalWidth > 0 ? 'ok' : 'fail', img); };
      img.onerror = function () { settle(ref, 'fail'); };
      img.src = url;
    }).catch(function () { settle(ref, 'fail'); });
    return null;
  }
  function logoUrl(ref) { var e = LOGO.get(cleanLogo(ref)); return e && e.state === 'ok' && e.img ? e.img.src : ''; }
  function forgetLogo(ref) { LOGO.delete(ref); }

  /* ---- canvas drawing (3D CanvasTexture). ctx = CanvasRenderingContext2D, W x H px. ---- */
  function fit(ctx, text, maxW, size, weight, family) {
    var s = size;
    for (; s > 8; s -= 2) { ctx.font = weight + ' ' + s + 'px ' + family; if (ctx.measureText(text).width <= maxW) break; }
    return s;
  }
  function line(ctx, text, x, y, maxW, size, weight, family, color) {
    if (!text) return 0; fit(ctx, text, maxW, size, weight, family); ctx.fillStyle = color; ctx.fillText(text, x, y); return 1;
  }
  // gradients that degrade to a flat colour on a minimal context (tests / old browsers)
  function grad(ctx, kind, args, stops, fallback) {
    var g = null; try { g = kind === 'r' ? ctx.createRadialGradient.apply(ctx, args) : ctx.createLinearGradient.apply(ctx, args); } catch (e) { g = null; }
    if (!g || typeof g.addColorStop !== 'function') return fallback;
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); }); return g;
  }
  function rgba(h, a) { var c = rgb(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function flower(ctx, x, y, r, petals, c1, c2) {
    for (var j = 0; j < petals; j++) { var a = j / petals * Math.PI * 2, px = x + Math.cos(a) * r * 0.55, py = y + Math.sin(a) * r * 0.55;
      ctx.fillStyle = c1; ctx.beginPath();
      if (typeof ctx.ellipse === 'function') ctx.ellipse(px, py, r * 0.5, r * 0.28, a, 0, Math.PI * 2); else ctx.arc(px, py, r * 0.35, 0, Math.PI * 2);
      ctx.fill(); }
    ctx.fillStyle = c2; ctx.beginPath(); ctx.arc(x, y, r * 0.24, 0, Math.PI * 2); ctx.fill();
  }
  function leaf(ctx, x, y, len, ang, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.5, -len * 0.3, len, 0); ctx.quadraticCurveTo(len * 0.5, len * 0.3, 0, 0); ctx.fill(); ctx.restore();
  }
  function marigoldBall(ctx, x, y, r, c) {
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120,40,0,0.35)'; ctx.lineWidth = Math.max(1, r * 0.12);
    for (var k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(x, y, r * (0.35 + k * 0.22), 0.3 + k, 2.4 + k); ctx.stroke(); }
  }
  // the background (gradient + a soft glow), drawn under the ornament and the text
  function backdrop(ctx, W, H, T) {
    ctx.fillStyle = grad(ctx, 'l', [0, 0, W, H], [[0, T.bg], [1, T.bg2]], T.bg); ctx.fillRect(0, 0, W, H);
    if (T.motif !== 'rule') {
      ctx.fillStyle = grad(ctx, 'r', [W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.7], [[0, 'rgba(255,255,255,0.10)'], [1, 'rgba(0,0,0,0.16)']], 'rgba(0,0,0,0)');
      ctx.fillRect(0, 0, W, H);
    }
  }
  function motif(ctx, W, H, T) {
    ctx.save();
    var m = Math.min(W, H);
    if (T.motif === 'waves') {            // Corporate: layered flowing wave lines + a light band + a soft orb
      for (var k = 0; k < 7; k++) {
        ctx.strokeStyle = rgba(T.accent, 0.08 + k * 0.05); ctx.lineWidth = Math.max(2, H * (0.006 + k * 0.002));
        ctx.beginPath(); var y0 = H * (0.66 + k * 0.045);
        ctx.moveTo(-W * 0.05, y0); ctx.bezierCurveTo(W * 0.28, y0 - H * 0.2, W * 0.62, y0 + H * 0.18, W * 1.05, y0 - H * 0.08); ctx.stroke();
      }
      ctx.fillStyle = grad(ctx, 'l', [0, H * 0.8, W, H], [[0, rgba(T.accent, 0)], [0.5, rgba(T.accent, 0.22)], [1, rgba(T.accent, 0)]], rgba(T.accent, 0.12));
      ctx.beginPath(); ctx.moveTo(0, H); ctx.bezierCurveTo(W * 0.3, H * 0.78, W * 0.7, H * 0.98, W, H * 0.8); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.beginPath(); ctx.arc(W * 0.9, H * 0.1, H * 0.5, 0, Math.PI * 2); ctx.fill();
    } else if (T.motif === 'border') {     // Royal Gold: maroon velvet folds + double gold border with filigree corners
      for (var v = 0; v < 14; v++) { ctx.fillStyle = v % 2 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.035)'; ctx.fillRect(W * v / 14, 0, W / 28, H); }
      var b = m * 0.04; ctx.strokeStyle = T.accent; ctx.lineWidth = Math.max(2, b * 0.28);
      ctx.strokeRect(b, b, W - 2 * b, H - 2 * b); ctx.lineWidth = Math.max(1, b * 0.1); ctx.strokeRect(b * 1.7, b * 1.7, W - 3.4 * b, H - 3.4 * b);
      [[b * 1.7, b * 1.7, 1, 1], [W - b * 1.7, b * 1.7, -1, 1], [b * 1.7, H - b * 1.7, 1, -1], [W - b * 1.7, H - b * 1.7, -1, -1]].forEach(function (p) {
        ctx.strokeStyle = T.accent; ctx.lineWidth = Math.max(1, b * 0.12);
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.bezierCurveTo(p[0] + p[2] * b * 3, p[1], p[0] + p[2] * b * 2, p[1] + p[3] * b * 2, p[0] + p[2] * b * 4.5, p[1] + p[3] * b * 0.6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.bezierCurveTo(p[0], p[1] + p[3] * b * 3, p[0] + p[2] * b * 2, p[1] + p[3] * b * 2, p[0] + p[2] * b * 0.6, p[1] + p[3] * b * 4.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(p[0] + p[2] * b * 1.2, p[1] + p[3] * b * 1.2); ctx.quadraticCurveTo(p[0] + p[2] * b * 2.6, p[1] + p[3] * b * 0.4, p[0] + p[2] * b * 3.2, p[1] + p[3] * b * 1.6); ctx.stroke();
        ctx.fillStyle = T.accent; ctx.beginPath(); ctx.arc(p[0], p[1], b * 0.45, 0, Math.PI * 2); ctx.fill(); });
      ctx.lineWidth = Math.max(1, b * 0.08);   // top centre crest
      ctx.beginPath(); ctx.moveTo(W * 0.42, b * 1.7); ctx.quadraticCurveTo(W * 0.5, b * 4.2, W * 0.58, b * 1.7); ctx.stroke();
    } else if (T.motif === 'florals') {    // Floral Pastel: corner sprays (petal flowers, leaves on curved stems, buds)
      var R = m * 0.075, tones = ['#f6c1cc', '#f29bb0', '#fbd3dc', '#e86a8c'];
      [[0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]].forEach(function (p, i) {
        ctx.strokeStyle = '#7fae7a'; ctx.lineWidth = Math.max(1.5, R * 0.08);
        for (var s = 0; s < 3; s++) {
          ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.quadraticCurveTo(p[0] + p[2] * R * (2 + s), p[1] + p[3] * R * 0.6, p[0] + p[2] * R * (3.4 + s * 0.8), p[1] + p[3] * R * (1.2 + s * 0.9)); ctx.stroke();
          leaf(ctx, p[0] + p[2] * R * (2.2 + s * 0.7), p[1] + p[3] * R * (0.8 + s * 0.6), R * 0.9, Math.atan2(p[3], p[2]) + (s - 1) * 0.6, s % 2 ? '#9cc79a' : '#b9dbb4');
        }
        for (var j = 0; j < 5; j++) { var a = j / 5 * Math.PI / 2, rr = R * (1.1 + (j % 2) * 0.9);
          flower(ctx, p[0] + p[2] * Math.cos(a) * rr * 1.3, p[1] + p[3] * Math.sin(a) * rr * 1.3, R * (0.75 + (j % 3) * 0.18), 6, tones[(i + j) % tones.length], '#f7d774'); }
        ctx.fillStyle = '#fff3f6'; for (var d = 0; d < 4; d++) { ctx.beginPath(); ctx.arc(p[0] + p[2] * R * (3 + d * 0.6), p[1] + p[3] * R * (0.4 + d * 0.5), R * 0.12, 0, Math.PI * 2); ctx.fill(); }
      });
    } else if (T.motif === 'rule') {       // Minimal White: thin frame + centred hairline rules
      ctx.strokeStyle = 'rgba(17,17,17,0.18)'; ctx.lineWidth = Math.max(1, H * 0.003); ctx.strokeRect(m * 0.05, m * 0.05, W - m * 0.1, H - m * 0.1);
      ctx.fillStyle = T.accent; ctx.fillRect(W * 0.42, H * 0.5 - 1, W * 0.16, Math.max(2, H * 0.004));
      ctx.fillStyle = 'rgba(17,17,17,0.35)'; ctx.fillRect(W * 0.3, H * 0.9, W * 0.4, Math.max(1, H * 0.002));
    } else if (T.motif === 'neon') {       // Concert Neon: light beams + glowing double frame (shadowBlur)
      ctx.globalAlpha = 0.16;
      for (var q = 0; q < 6; q++) { ctx.fillStyle = q % 2 ? T.accent : (T.accent2 || T.accent);
        ctx.beginPath(); ctx.moveTo(W * (0.1 + q * 0.16), 0); ctx.lineTo(W * (0.05 + q * 0.16), H); ctx.lineTo(W * (0.13 + q * 0.16), H); ctx.closePath(); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = grad(ctx, 'l', [0, 0, W, 0], [[0, T.accent], [1, T.accent2 || T.accent]], T.accent);
      ctx.lineWidth = Math.max(3, H * 0.014); ctx.shadowColor = T.accent; ctx.shadowBlur = H * 0.05;
      ctx.strokeRect(W * 0.04, H * 0.06, W * 0.92, H * 0.88);
      ctx.shadowColor = T.accent2 || T.accent; ctx.lineWidth = Math.max(2, H * 0.006); ctx.strokeRect(W * 0.06, H * 0.1, W * 0.88, H * 0.8);
    } else if (T.motif === 'marigold') {   // Festive Marigold: a marigold garland swag on top, strings down the sides, mango leaves
      var gr = m * 0.035, cols = ['#ff9f1c', '#ffbf00', '#f77f00'];
      for (var x = gr; x < W; x += gr * 1.7) marigoldBall(ctx, x, gr * 1.2 + Math.sin(x / W * Math.PI) * H * 0.07, gr, cols[Math.round(x / gr) % 3]);
      for (var lx = gr * 3; lx < W; lx += gr * 6) leaf(ctx, lx, gr * 2.4 + Math.sin(lx / W * Math.PI) * H * 0.07, gr * 2.2, Math.PI / 2, T.accent2);
      [gr * 1.2, W - gr * 1.2].forEach(function (sx) { for (var y2 = gr * 3; y2 < H - gr; y2 += gr * 1.7) marigoldBall(ctx, sx, y2, gr * 0.9, cols[Math.round(y2 / gr) % 3]); });
      ctx.strokeStyle = rgba(T.accent, 0.35); ctx.lineWidth = Math.max(1, m * 0.006); ctx.strokeRect(m * 0.09, m * 0.16, W - m * 0.18, H - m * 0.24);
    } else if (T.motif === 'deco') {       // Elegant Black-Gold: art-deco fan rays, gold double rule, stepped corners, gold dust
      ctx.strokeStyle = rgba(T.accent, 0.22); ctx.lineWidth = Math.max(1, H * 0.003);
      for (var r2 = 0; r2 < 18; r2++) { var an = Math.PI + r2 / 17 * Math.PI; ctx.beginPath(); ctx.moveTo(W / 2, H * 1.05); ctx.lineTo(W / 2 + Math.cos(an) * W, H * 1.05 + Math.sin(an) * W); ctx.stroke(); }
      ctx.strokeStyle = T.accent; ctx.lineWidth = Math.max(2, m * 0.008); ctx.strokeRect(m * 0.05, m * 0.05, W - m * 0.1, H - m * 0.1);
      ctx.lineWidth = Math.max(1, m * 0.003); ctx.strokeRect(m * 0.075, m * 0.075, W - m * 0.15, H - m * 0.15);
      [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(function (s) { var cx = s[0] > 0 ? m * 0.075 : W - m * 0.075, cy = s[1] > 0 ? m * 0.075 : H - m * 0.075;
        for (var st = 1; st <= 3; st++) { ctx.beginPath(); ctx.moveTo(cx + s[0] * m * 0.04 * st, cy); ctx.lineTo(cx + s[0] * m * 0.04 * st, cy + s[1] * m * 0.04 * st); ctx.lineTo(cx, cy + s[1] * m * 0.04 * st); ctx.stroke(); } });
      ctx.fillStyle = rgba(T.accent, 0.5); for (var sp = 0; sp < 40; sp++) ctx.fillRect((sp * 97 % 100) / 100 * W, (sp * 61 % 100) / 100 * H, 2, 2);
    } else if (T.motif === 'grid') {       // Tech Gradient: perspective grid floor, circuit traces with glowing nodes
      ctx.strokeStyle = rgba(T.accent, 0.25); ctx.lineWidth = Math.max(1, H * 0.003);
      var hz = H * 0.72;
      for (var gx = -10; gx <= 10; gx++) { ctx.beginPath(); ctx.moveTo(W / 2 + gx * W * 0.02, hz); ctx.lineTo(W / 2 + gx * W * 0.12, H); ctx.stroke(); }
      for (var gy = 0; gy < 6; gy++) { var yh = hz + (H - hz) * Math.pow(gy / 5, 1.8); ctx.beginPath(); ctx.moveTo(0, yh); ctx.lineTo(W, yh); ctx.stroke(); }
      ctx.strokeStyle = rgba(T.accent2 || T.accent, 0.45); ctx.lineWidth = Math.max(1, H * 0.004);
      [[0.05, 0.2, 0.18, 0.2, 0.22, 0.3], [0.95, 0.25, 0.8, 0.25, 0.77, 0.36], [0.06, 0.6, 0.14, 0.6, 0.17, 0.52]].forEach(function (p) {
        ctx.beginPath(); ctx.moveTo(W * p[0], H * p[1]); ctx.lineTo(W * p[2], H * p[3]); ctx.lineTo(W * p[4], H * p[5]); ctx.stroke();
        ctx.fillStyle = T.accent; ctx.shadowColor = T.accent; ctx.shadowBlur = H * 0.02; ctx.beginPath(); ctx.arc(W * p[4], H * p[5], H * 0.008, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; });
    }
    ctx.restore();
  }
  // the brand mark: the logo picture when it is loaded, else the monogram letter in a disc (what R135 drew)
  function mark(ctx, x, y, r, mono, T, img, sans) {
    if (img && img.naturalWidth > 0) {
      var iw = img.naturalWidth, ih = img.naturalHeight || 1, k = Math.min(r * 2.8 / iw, r * 2.1 / ih);
      try { ctx.drawImage(img, x - iw * k / 2, y - ih * k / 2, iw * k, ih * k); return true; } catch (e) { /* fall back to the letter */ }
    }
    if (!mono) return false;
    ctx.fillStyle = T.accent; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = T.bg; ctx.font = '700 ' + Math.round(r * 1.1) + 'px ' + sans; ctx.fillText(mono, x, y + r * 0.05); return true;
  }
  // draws a full screen face. opts.side = portrait side panel (brand + tagline only); opts.logo = the loaded logo image
  function draw(ctx, W, H, c, opts) {
    opts = opts || {}; c = c || rawContent({});
    var T = paletteOf(c), sans = '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif', serif = 'Georgia, "Times New Roman", serif';
    backdrop(ctx, W, H, T);
    motif(ctx, W, H, T);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var mono = monogram(c.brand), cx = W / 2, img = c.logo ? (opts.logo || null) : null, pic = !!(img && img.naturalWidth > 0);
    if (opts.side) {
      var r = Math.min(W * 0.28, H * 0.1);
      mark(ctx, cx, H * 0.3, r, mono, T, img, sans);
      line(ctx, c.brand, cx, H * 0.48, W * 0.86, Math.round(W * 0.16), '700', sans, T.ink);
      line(ctx, (c.tagline || '').toUpperCase(), cx, H * 0.56, W * 0.86, Math.round(W * 0.07), '600', sans, T.sub);
      line(ctx, c.title, cx, H * 0.7, W * 0.86, Math.round(W * 0.12), 'italic 700', serif, T.ink);
      return;
    }
    var r2 = H * 0.07, topY = H * 0.16, mx = (!c.brand && pic) ? cx : cx - Math.min(W * 0.18, r2 * 4.2);
    mark(ctx, mx, topY, r2, mono, T, img, sans);
    line(ctx, c.brand, cx + ((pic || mono) ? r2 * 0.8 : 0), topY, W * 0.5, Math.round(H * 0.1), '700', sans, T.ink);
    line(ctx, (c.tagline || '').toUpperCase(), cx, topY + H * 0.1, W * 0.7, Math.round(H * 0.045), '600', sans, T.sub);
    line(ctx, c.title, cx, H * 0.5, W * 0.86, Math.round(H * 0.2), 'italic 700', serif, T.ink);
    line(ctx, (c.subtitle || '').toUpperCase(), cx, H * 0.66, W * 0.8, Math.round(H * 0.055), '600', sans, T.sub);
    line(ctx, c.dateLine, cx, H * 0.8, W * 0.7, Math.round(H * 0.05), '500', sans, T.sub);
  }
  return Object.freeze({
    MAX: MAX, FIELDS: FIELDS, THEMES: THEMES, THEME_ORDER: THEME_ORDER, SCREEN_TYPES: SCREEN_TYPES, PLACEHOLDER: PLACEHOLDER,
    LAYOUTS: LAYOUTS, BG_SWATCHES: BG_SWATCHES, LOGO_MAX_BYTES: LOGO_MAX_BYTES, LOGO_MAX_PX: LOGO_MAX_PX, LOGO_PATH_RE: LOGO_PATH_RE,
    cleanText: cleanText, cleanHex: cleanHex, cleanLogo: cleanLogo, cleanLayout: cleanLayout, isScreenType: isScreenType, themeOf: themeOf,
    sanitize: sanitize, rawContent: rawContent, hasText: hasText, hasContent: hasContent, mainScreen: mainScreen, contentOf: contentOf,
    layoutOf: layoutOf, stageSegments: stageSegments, monogram: monogram, shortLine: shortLine, keyOf: keyOf, draw: draw,
    luminance: luminance, contrast: contrast, inkFor: inkFor, paletteOf: paletteOf,
    sniffLogo: sniffLogo, validateLogo: validateLogo, fitLogoSize: fitLogoSize,
    setLogoResolver: setLogoResolver, onLogoChange: onLogoChange, logoState: logoState, logoImage: logoImage, logoUrl: logoUrl, forgetLogo: forgetLogo
  });
});

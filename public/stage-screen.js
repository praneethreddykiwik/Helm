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
 *   R200 (picture screens + welcome board):
 *   screenMode   'pic' = the screen shows an uploaded PICTURE instead of the theme + text (absent = text, as before;
 *                switching back keeps the picture for later)
 *   screenPic    the picture REFERENCE (same rules as screenLogo, never 'studio', never the picture / a data: URL)
 *   screenFit    'cover' = Fill (edges may be cropped) | absent = Fit (whole picture, nothing cut - the default)
 *   screenPicW/H the uploaded picture's pixel size (whole numbers) - only to warn when its shape differs
 *   screenAspect standalone screens: '' (as before) | 16:9 | 4:3 | 21:9 | 32:9 | 9:16 | 1:1 | custom (+ screenH ft)
 *   boardSize    welcome board: 2x3 | 3x4 | 4x6 | custom (+ boardW / boardH ft); absent = the size before R200
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
  var SCREEN_TYPES = { stage: 'main', ledscreen: 'screen', videowall: 'screen', led: 'screen', sidescreen: 'side', brandwall: 'screen', backdrop: 'screen', welcomeboard: 'board' };
  // R200: picture fit, standalone screen shapes, welcome board sizes and the board's template words
  var FITS = [['contain', 'Fit - whole picture, nothing cut'], ['cover', 'Fill - covers it all, edges cropped']];
  var ASPECTS = [['', 'Standard (as before)'], ['16:9', '16:9 widescreen (most screens)'], ['4:3', '4:3 classic'], ['21:9', '21:9 ultra-wide'],
    ['32:9', '32:9 super-wide LED'], ['9:16', '9:16 portrait'], ['1:1', '1:1 square'], ['custom', 'Custom height']];
  var ASPECT_TYPES = { ledscreen: 1, led: 1, videowall: 1, sidescreen: 1 };
  var BOARD_SIZES = [['', 'Standard (as before)'], ['2x3', '2 x 3 ft'], ['3x4', '3 x 4 ft'], ['4x6', '4 x 6 ft'], ['custom', 'Custom size']];
  var BOARD_FIELDS = [
    ['subtitle', 'Heading', 'Welcome'],
    ['tagline', 'Small line', 'to the wedding of'],
    ['brand', 'Couple / host names', 'Priya & Arjun'],
    ['title', 'Event name', 'Sangeet Night'],
    ['dateLine', 'Date / venue', '12 Dec 2026 · Hyderabad']
  ];
  var BOARD_THEMES = ['floral', 'royal', 'minimal', 'marigold', 'blackgold'];   // the built-in welcome board designs
  var PIC_MAX_BYTES = 15 * 1024 * 1024, PIC_MAX_PX = 2560;
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
  function cleanPic(v) { return (typeof v === 'string' && LOGO_PATH_RE.test(v)) ? v : ''; }
  function cleanNum(v, lo, hi) { var n = +v; if (typeof v === 'boolean' || v === null || v === '' || !isFinite(n)) return 0; return Math.round(Math.max(lo, Math.min(hi, n)) * 10) / 10; }
  function inList(list, v) { return typeof v === 'string' && !!v && list.some(function (l) { return l[0] === v; }); }
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
    // R200
    if (own.call(p, 'screenMode')) { if (p.screenMode !== 'pic') delete p.screenMode; }
    if (own.call(p, 'screenPic')) { var pc = cleanPic(p.screenPic); if (pc) p.screenPic = pc; else delete p.screenPic; }
    if (own.call(p, 'screenFit')) { if (p.screenFit !== 'cover') delete p.screenFit; }
    ['screenPicW', 'screenPicH'].forEach(function (k) { if (!own.call(p, k)) return; var n = Math.round(+p[k]); if (typeof p[k] === 'number' && n >= 1 && n <= 20000) p[k] = n; else delete p[k]; });
    if (own.call(p, 'screenAspect')) { if (!inList(ASPECTS, p.screenAspect)) delete p.screenAspect; }
    if (own.call(p, 'screenH')) { var sh = cleanNum(p.screenH, 1, 60); if (sh) p.screenH = sh; else delete p.screenH; }
    if (own.call(p, 'boardSize')) { if (!inList(BOARD_SIZES, p.boardSize)) delete p.boardSize; }
    ['boardW', 'boardH'].forEach(function (k) { if (!own.call(p, k)) return; var n = cleanNum(p[k], 1, 12); if (n) p[k] = n; else delete p[k]; });
    return p;
  }
  function rawContent(p) {
    p = p || {};
    var c = { theme: (typeof p.screenTheme === 'string' && own.call(THEMES, p.screenTheme)) ? p.screenTheme : '' };
    FIELDS.forEach(function (f) { c[f[0]] = cleanText(p[f[0]]); });
    c.layout = cleanLayout(p.screenLayout); c.bg = cleanHex(p.screenBg); c.logo = cleanLogo(p.screenLogo);
    // R200: the picture shows only in picture mode; Fit (contain) unless Fill was chosen
    c.pic = p.screenMode === 'pic' ? cleanPic(p.screenPic) : ''; c.fit = p.screenFit === 'cover' ? 'cover' : 'contain';
    return c;
  }
  function hasText(c) { return !!(c && (c.title || c.brand || c.tagline || c.subtitle || c.dateLine)); }
  function hasContent(c) { return !!(c && (c.theme || hasText(c) || c.bg || c.logo || c.pic || (c.layout && c.layout !== 'none'))); }
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
    if (SCREEN_TYPES[it.type] === 'board') c.board = true;
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
    return [c.theme, c.title, c.brand, c.tagline, c.subtitle, c.dateLine, side ? 's' : 'm', w, h, c.bg || '', c.logo ? c.logo + ':' + logoState(c.logo) : '',
      c.pic ? c.pic + ':' + logoState(c.pic) + ':' + c.fit : '', c.board ? 'b' : ''].join('\u0001');
  }

  /* ---- R200 real screen size (ft) + picture guidance. faceOf mirrors the 3D models exactly (builder-3d.js reads the
     frame height from here), so the size shown next to the upload is the size the picture is drawn on. ---- */
  function aspectNum(a) { var m = /^(\d+):(\d+)$/.exec(String(a || '')); return m ? (+m[1]) / (+m[2]) : 0; }
  // the screen face's wanted height for a face width, or 0 = keep the model's own height (Standard)
  function wantH(p, fw) {
    var a = aspectNum(p.screenAspect); if (a) return fw / a;
    if (p.screenAspect === 'custom') return cleanNum(p.screenH, 1, 60);
    return 0;
  }
  // welcome board panel size: { w, h } ft (portrait). Standard = the board before R200 (follows the item width)
  function boardOf(it) {
    var p = (it && it.properties) || {}, w = Math.max(0.5, +(it && it.width) || 3), s = p.boardSize;
    if (s === '2x3') return { w: 2, h: 3, sized: true };
    if (s === '3x4') return { w: 3, h: 4, sized: true };
    if (s === '4x6') return { w: 4, h: 6, sized: true };
    if (s === 'custom') { var bw = cleanNum(p.boardW, 1, 12) || 3, bh = cleanNum(p.boardH, 1, 12) || 4; return { w: bw, h: bh, sized: true }; }
    var b = Math.max(2.4, w * 0.85); return { w: b, h: b * 1.3, sized: false };
  }
  // { w, h } = the visible screen face in ft, frame = the model's frame height (3D), or null (not a screen / no screen)
  function faceOf(it, items) {
    if (!it || !isScreenType(it.type)) return null;
    var p = it.properties || {}, w = Math.max(0.5, +it.width || 1), d = Math.max(0.5, +it.height || 1), t = it.type;
    var curved = p.style === 'curvedled' && (t === 'ledscreen' || t === 'videowall'), fw, fh, fr, k, H;
    if (t === 'ledscreen' || t === 'videowall' || t === 'led' || t === 'sidescreen') {
      fr = t === 'ledscreen' ? Math.max(8, w * 0.4) : t === 'videowall' ? Math.max(8, d) : t === 'led' ? Math.max(6, Math.round(w * 9 / 16)) : Math.max(9, Math.min(16, w * 1.8));
      if (curved) { fw = w * 0.97; k = 0.94; }
      else if (t === 'ledscreen') { fw = Math.max(0.5, w - 1); k = 0; }
      else { fw = w * (t === 'sidescreen' ? 0.94 : 0.96); k = t === 'videowall' ? 0.9 : t === 'led' ? 0.94 : 0.95; }
      H = wantH(p, fw);
      if (H) { H = Math.max(1, Math.min(60, H)); fh = H; fr = k ? H / k : H + 1; }
      else fh = k ? fr * k : fr - 1;
      return { w: fw, h: fh, frame: fr };
    }
    if (t === 'brandwall') return { w: w * 0.96, h: 8 * 0.92, frame: 8 };
    if (t === 'backdrop') return { w: w * 0.96, h: 8 * 0.9, frame: 8 };
    if (t === 'welcomeboard') { var b = boardOf(it); return { w: b.w, h: b.h, frame: b.h }; }
    if (t === 'stage') {
      var c = contentOf(it, items || []), lay = layoutOf(c), bh = Math.min(14, Math.max(8, d * 0.8));
      var seg = stageSegments(lay, w).filter(function (sg) { return !sg.side; })[0];
      return seg ? { w: w * seg.w, h: bh * seg.h, frame: bh } : null;
    }
    return null;
  }
  var RATIOS = [[16, 9], [9, 16], [4, 3], [3, 4], [21, 9], [32, 9], [3, 2], [2, 3], [1, 1], [2, 1], [1, 2], [5, 4], [4, 5], [5, 2], [3, 1]];
  // "16:9" for a shape close (within 1.5%) to a common ratio, else "2.71:1" (or "1:1.5" when portrait)
  function ratioLabel(w, h) {
    w = +w; h = +h; if (!(w > 0) || !(h > 0)) return '';
    var r = w / h;
    for (var i = 0; i < RATIOS.length; i++) { var q = RATIOS[i][0] / RATIOS[i][1]; if (Math.abs(r / q - 1) <= 0.015) return RATIOS[i][0] + ':' + RATIOS[i][1]; }
    return r >= 1 ? (Math.round(r * 100) / 100) + ':1' : '1:' + (Math.round(100 / r) / 100);
  }
  // the picture size to make for a w x h ft face: long side 1920 px for screens (Full HD), 2400 px for printed boards
  function recommendPx(w, h, print) {
    w = +w; h = +h; if (!(w > 0) || !(h > 0)) return null;
    var L = print ? 2400 : 1920, r = w / h, pw, ph;
    if (r >= 1) { pw = L; ph = Math.round(L / r); } else { ph = L; pw = Math.round(L * r); }
    if (!print && Math.abs(r / (16 / 9) - 1) <= 0.015) { pw = 1920; ph = 1080; }
    if (!print && Math.abs(r / (9 / 16) - 1) <= 0.015) { pw = 1080; ph = 1920; }
    return { w: Math.max(1, pw), h: Math.max(1, ph), ratio: ratioLabel(w, h) };
  }
  // how far (in %) a picture's shape is from the face's shape; > 5 = warn and offer Fit / Fill
  function shapeDiff(pw, ph, w, h) {
    pw = +pw; ph = +ph; w = +w; h = +h; if (!(pw > 0 && ph > 0 && w > 0 && h > 0)) return 0;
    var a = (pw / ph) / (w / h); return Math.round(Math.abs(a >= 1 ? a - 1 : 1 / a - 1) * 1000) / 10;
  }
  function ft(n) { var v = Math.round(+n * 10) / 10; return (v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1)); }
  // "16 ft x 9 ft (4.9 x 2.7 m)"
  function sizeText(w, h) { return ft(w) + ' ft × ' + ft(h) + ' ft (' + (Math.round(w * 0.3048 * 10) / 10) + ' × ' + (Math.round(h * 0.3048 * 10) / 10) + ' m)'; }
  // the plain-words guidance shown next to the upload: { size, ratio, px, line }
  function guidance(it, items) {
    var f = faceOf(it, items); if (!f) return null;
    var print = it.type === 'welcomeboard' || it.type === 'brandwall' || it.type === 'backdrop', rp = recommendPx(f.w, f.h, print);
    return { w: f.w, h: f.h, size: sizeText(f.w, f.h), ratio: rp.ratio, pxW: rp.w, pxH: rp.h, print: print,
      line: 'Make the picture ' + rp.w + ' × ' + rp.h + ' px (' + rp.ratio + ')' + (print ? ' or larger for print.' : ' or larger, same shape.') };
  }
  // { ok, reason } for a picture file (bytes sniffed, never the name / declared type). PNG / JPG / WebP, <= 15 MB.
  function validatePicture(file, bytes) {
    var size = file && +file.size, type = String((file && file.type) || '').toLowerCase(), name = String((file && file.name) || '').toLowerCase();
    if (!file || !(size > 0)) return { ok: false, reason: 'That file is empty.' };
    if (/svg/.test(type) || /\.svgz?$/.test(name)) return { ok: false, reason: 'SVG files are not accepted. Please use a PNG, JPG or WebP picture.' };
    if (size > PIC_MAX_BYTES) return { ok: false, reason: 'That picture is over 15 MB. Please save it smaller (PNG, JPG or WebP) and try again.' };
    var s = sniffLogo(bytes);
    if (!s) return { ok: false, reason: 'That is not a picture Helm can use. Please choose a PNG, JPG or WebP image.' };
    return { ok: true, mime: s.mime, ext: s.ext };
  }
  // canvas: a picture over the whole W x H face - Fit (contain, dark bars) or Fill (cover, centred crop)
  function drawPicture(ctx, W, H, img, fit) {
    ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, W, H);
    if (!img || !(img.naturalWidth > 0 || img.width > 0)) return false;
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height || 1;
    var k = fit === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih), dw = iw * k, dh = ih * k;
    try { ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh); return true; } catch (e) { return false; }
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
  // R154: the signed link behind a loaded logo expires (1 h); after LOGO_REFRESH_MS a fresh one is fetched in the
  // background (the old picture keeps showing), so a long-open builder never ends up pointing at an expired link
  var LOGO_REFRESH_MS = 45 * 60 * 1000, LOGO_RETRY_MS = 60 * 1000;
  var now = function () { return Date.now(); };
  function settle(ref, state, img) { LOGO.set(ref, { state: state, img: img || null, at: now() }); listeners.forEach(function (f) { try { f(ref, state); } catch (e) {} }); }
  function okUrl(u) { return typeof u === 'string' && u.length <= 2000 && /^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)[^\s"'<>]+$/i.test(u); }
  // the loaded image for a logo reference, or null (still loading, failed, no resolver, not a browser): callers then
  // draw the brand monogram. Starts the load on first ask; the listeners re-render when it lands.
  function loadLogo(ref, onOk, onFail) {
    Promise.resolve().then(function () { return resolver(ref); }).then(function (url) {
      if (!okUrl(url)) { onFail(); return; }
      var img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
      img.onload = function () { if (img.naturalWidth > 0) onOk(img); else onFail(); };
      img.onerror = function () { onFail(); };
      img.src = url;
    }).catch(function () { onFail(); });
  }
  function logoImage(ref) {
    ref = cleanLogo(ref); if (!ref) return null;
    var e = LOGO.get(ref);
    if (e) {
      if (e.state === 'ok' && resolver && !e.refreshing && e.at && now() - e.at > LOGO_REFRESH_MS) {   // R154 silent refresh
        e.refreshing = true;
        loadLogo(ref, function (img) { if (LOGO.get(ref) === e) settle(ref, 'ok', img); },
          function () { e.refreshing = false; e.at = now() - LOGO_REFRESH_MS + LOGO_RETRY_MS; });
      }
      return e.state === 'ok' ? e.img : null;
    }
    if (!resolver || typeof Image === 'undefined') return null;
    LOGO.set(ref, { state: 'loading', img: null });
    loadLogo(ref, function (img) { settle(ref, 'ok', img); }, function () { settle(ref, 'fail'); });
    return null;
  }
  // R154: start loading every logo in refs and resolve once none is still loading (or after ms), so a client-image
  // capture right after opening / adding a logo bakes the picture instead of the brand letter
  function whenLogos(refs, ms) {
    var list = (Array.isArray(refs) ? refs : []).map(cleanLogo).filter(function (r, i, a) { return r && a.indexOf(r) === i; });
    list.forEach(logoImage);
    var t0 = now(), limit = Math.max(0, +ms || 5000);
    return new Promise(function (done) {
      (function poll() {
        if (list.every(function (r) { return logoState(r) !== 'loading'; }) || now() - t0 >= limit) { done(list.map(logoState)); return; }
        setTimeout(poll, 80);
      })();
    });
  }
  // R154: the loaded logo as PNG pixels (a data: URL) for an exported floor-plan picture only - never stored, never the
  // signed link. '' when it is not loaded or the canvas refuses (the export then leaves the logo out, as before).
  function logoSnapshot(ref) {
    var e = LOGO.get(cleanLogo(ref)), img = e && e.state === 'ok' ? e.img : null;
    if (!img || !(img.naturalWidth > 0) || typeof document === 'undefined') return '';
    try {
      var z = fitLogoSize(img.naturalWidth, img.naturalHeight, LOGO_MAX_PX), cv = document.createElement('canvas'); cv.width = z.w; cv.height = z.h;
      var x = cv.getContext('2d'); if (!x) return ''; x.drawImage(img, 0, 0, z.w, z.h);
      var u = cv.toDataURL('image/png'); return /^data:image\/png;base64,/.test(u) ? u : '';
    } catch (err) { return ''; }
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
    if (c.pic) { drawPicture(ctx, W, H, opts.pic || null, c.fit); return; }   // R200: picture mode = the picture only
    var T = paletteOf(c), sans = '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif', serif = 'Georgia, "Times New Roman", serif';
    backdrop(ctx, W, H, T);
    motif(ctx, W, H, T);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var mono = monogram(c.brand), cx = W / 2, img = c.logo ? (opts.logo || null) : null, pic = !!(img && img.naturalWidth > 0);
    if (c.board || opts.board) { drawBoard(ctx, W, H, c, T, img, mono, sans, serif); return; }
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

  // R200 welcome board template (portrait): heading, small line, names, event name, date, logo / monogram at the foot
  function drawBoard(ctx, W, H, c, T, img, mono, sans, serif) {
    var cx = W / 2;
    line(ctx, c.subtitle || 'Welcome', cx, H * 0.2, W * 0.8, Math.round(W * 0.16), 'italic 700', serif, T.ink);
    line(ctx, (c.tagline || '').toUpperCase(), cx, H * 0.32, W * 0.8, Math.round(W * 0.05), '600', sans, T.sub);
    var names = String(c.brand || ''), amp = names.indexOf('&');
    if (amp > 0 && amp < names.length - 1) {
      line(ctx, names.slice(0, amp).trim(), cx, H * 0.43, W * 0.8, Math.round(W * 0.12), '700', serif, T.ink);
      line(ctx, '&', cx, H * 0.5, W * 0.3, Math.round(W * 0.08), 'italic 400', serif, T.accent || T.sub);
      line(ctx, names.slice(amp + 1).trim(), cx, H * 0.57, W * 0.8, Math.round(W * 0.12), '700', serif, T.ink);
    } else line(ctx, names, cx, H * 0.5, W * 0.8, Math.round(W * 0.12), '700', serif, T.ink);
    line(ctx, c.title, cx, H * 0.68, W * 0.8, Math.round(W * 0.075), '600', sans, T.ink);
    line(ctx, c.dateLine, cx, H * 0.76, W * 0.8, Math.round(W * 0.05), '500', sans, T.sub);
    mark(ctx, cx, H * 0.87, Math.min(W * 0.08, H * 0.05), mono, T, img, sans);
  }
  /* R160: what every screen of a layout shows, for the photo render (render-photo builds its SCREEN CONTENT
     section from this, and the dialog draws each spec as a flat artwork reference picture). Identical contents
     (mirrored side screens, copies) are merged with a count; screens with nothing on them are left out; the main
     stage screen comes first. Plain data only: cleaned text, validated #rrggbb colours, whitelisted keys, and
     logo = true/false (the reference itself stays in the browser as logoRef and is never sent). At most `max` (4). */
  function photoSpecs(items, max) {
    var list = Array.isArray(items) ? items : [], out = [], byKey = {}, main = mainScreen(list);
    var ordered = list.filter(function (it) { return it && isScreenType(it.type); });
    if (main) ordered = [main].concat(ordered.filter(function (it) { return it !== main; }));
    ordered.forEach(function (it) {
      var c = contentOf(it, list); if (!c || !hasContent(c)) return;
      var stage = it.type === 'stage', lay = stage ? layoutOf(c) : '';
      if (lay === 'none') return;                               // a plain backdrop: no screen to show anything on
      var kind = stage ? 'stage' : (SCREEN_TYPES[it.type] === 'side' ? 'side' : 'screen');
      var T = paletteOf(c);
      var k = [kind, it.type, lay, c.theme, c.bg, c.logo, c.title, c.brand, c.tagline, c.subtitle, c.dateLine, c.pic || '', c.pic ? c.fit : ''].join('\u0001');   // R200: + picture
      if (own.call(byKey, k)) { byKey[k].count++; return; }
      var s = { kind: kind, type: String(it.type), count: 1, layout: lay === 'legacy' ? 'single' : lay, theme: c.theme, themeName: themeOf(c.theme).name,
        bg: T.bg, ink: T.ink, sub: T.sub, accent: cleanHex(T.accent), accent2: cleanHex(T.accent2 || ''), customBg: !!c.bg,
        title: c.title, brand: c.brand, tagline: c.tagline, subtitle: c.subtitle, dateLine: c.dateLine,
        logo: !!c.logo, logoRef: c.logo, mirrored: !!c.mirrored, content: c };
      byKey[k] = s; out.push(s);
    });
    return out.slice(0, Math.max(1, Math.min(4, +max || 4)));
  }
  return Object.freeze({
    photoSpecs: photoSpecs,
    MAX: MAX, FIELDS: FIELDS, THEMES: THEMES, THEME_ORDER: THEME_ORDER, SCREEN_TYPES: SCREEN_TYPES, PLACEHOLDER: PLACEHOLDER,
    LAYOUTS: LAYOUTS, BG_SWATCHES: BG_SWATCHES, LOGO_MAX_BYTES: LOGO_MAX_BYTES, LOGO_MAX_PX: LOGO_MAX_PX, LOGO_PATH_RE: LOGO_PATH_RE,
    cleanText: cleanText, cleanHex: cleanHex, cleanLogo: cleanLogo, cleanLayout: cleanLayout, isScreenType: isScreenType, themeOf: themeOf,
    sanitize: sanitize, rawContent: rawContent, hasText: hasText, hasContent: hasContent, mainScreen: mainScreen, contentOf: contentOf,
    layoutOf: layoutOf, stageSegments: stageSegments, monogram: monogram, shortLine: shortLine, keyOf: keyOf, draw: draw,
    luminance: luminance, contrast: contrast, inkFor: inkFor, paletteOf: paletteOf,
    sniffLogo: sniffLogo, validateLogo: validateLogo, fitLogoSize: fitLogoSize,
    setLogoResolver: setLogoResolver, onLogoChange: onLogoChange, logoState: logoState, logoImage: logoImage, logoUrl: logoUrl, forgetLogo: forgetLogo,
    whenLogos: whenLogos, logoSnapshot: logoSnapshot, LOGO_REFRESH_MS: LOGO_REFRESH_MS,
    // R200
    FITS: FITS, ASPECTS: ASPECTS, ASPECT_TYPES: ASPECT_TYPES, BOARD_SIZES: BOARD_SIZES, BOARD_FIELDS: BOARD_FIELDS, BOARD_THEMES: BOARD_THEMES,
    PIC_MAX_BYTES: PIC_MAX_BYTES, PIC_MAX_PX: PIC_MAX_PX, cleanPic: cleanPic, aspectNum: aspectNum, boardOf: boardOf, faceOf: faceOf,
    ratioLabel: ratioLabel, recommendPx: recommendPx, shapeDiff: shapeDiff, sizeText: sizeText, guidance: guidance,
    validatePicture: validatePicture, drawPicture: drawPicture
  });
});

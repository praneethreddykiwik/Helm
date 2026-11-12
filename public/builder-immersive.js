/* builder-immersive.js (R164) - the floor builder on a PHONE (upright or sideways) as a full-screen editor.
 * Owner feedback after R157: the top bar was congested on a phone. Like the full-screen editors of good apps
 * (maps, design tools) the floor now gets the whole screen and the controls float over it:
 *   - top-left:  Back (+ Tools drawer)                top-right: Inspector drawer, More (the full top bar), Save
 *   - left edge: 2D / 3D / Walkthrough, stacked       right edge: zoom in / zoom out / fit (+ full screen, tour)
 *   - the app's bottom tab bar (mobile-nav.js) is folded away in the builder; a small handle on the right
 *     brings it up / down
 *   - full screen: the whole page goes full screen (Fullscreen API where the browser has it - Android; iPhone
 *     Safari has none, so fullscreen.js falls back to an app-level immersive mode). The floating controls keep
 *     working there and Back turns into a clear "Exit" button.
 * Every floating button only CLICKS the existing control (#toolsToggle, #saveBtn, #viewSeg ..., header .brand),
 * so saving, the drawers, unsaved-change guards and the 2D / 3D switch behave exactly as before.
 * Phones only (same media query as builder-immersive.css); tablets, laptops and desktops are untouched.
 * No-op in the /try sandbox and the headless picture host. DOM API only (createElement / textContent). */
(function () {
  'use strict';
  var doc = document, html = doc.documentElement;
  if (html.classList.contains('helm-sandbox') || doc.querySelector('meta[name="helm-capture"]')) return;
  if (!window.matchMedia) return;
  var PHONE_Q = '(pointer:coarse) and (orientation:landscape) and (max-height:500px), (pointer:coarse) and (orientation:portrait) and (max-width:599px)';
  var NAV_KEY = 'helm.builder.navOpen';
  var mq = matchMedia(PHONE_Q);
  var onMq = function (fn) { if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn); };
  var $ = function (s) { return doc.querySelector(s); };

  function el(tag, cls, text, attrs) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function btn(id, ico, label, title) {
    var b = el('button', 'bim-b', null, { type: 'button', id: id, 'aria-label': title || label, title: title || label });
    b.appendChild(el('span', 'bim-i', ico, { 'aria-hidden': 'true' }));
    if (label) b.appendChild(el('span', 'bim-t', label));
    return b;
  }
  var press = function (sel) { var t = typeof sel === 'string' ? $(sel) : sel; if (t && !t.disabled) t.click(); };
  var shown = function (n) { if (!n || n.hidden) return false; try { return getComputedStyle(n).display !== 'none'; } catch (_) { return true; } };

  /* ---------------- build ---------------- */
  var tl = el('div', 'bim-cluster bim-tl bim-keep', null, { id: 'bimTL', role: 'toolbar', 'aria-label': 'Builder' });
  var tr = el('div', 'bim-cluster bim-tr bim-keep', null, { id: 'bimTR', role: 'toolbar', 'aria-label': 'Layout' });
  var rail = el('div', 'bim-rail bim-keep', null, { id: 'bimRail', role: 'group', 'aria-label': 'View' });
  var bBack = btn('bimBack', '←', null, 'Back');
  var bExit = btn('bimExit', '✕', 'Exit', 'Exit full screen (Esc)'); bExit.classList.add('bim-exit'); bExit.hidden = true;
  var bTools = btn('bimTools', '🧰', 'Tools', 'Tools: the asset toolbox'); bTools.setAttribute('aria-controls', 'leftPanel'); bTools.setAttribute('aria-expanded', 'false');
  var bInsp = btn('bimInsp', '☰', null, 'Inspector: price, menu package and the selected object'); bInsp.setAttribute('aria-controls', 'rightPanel'); bInsp.setAttribute('aria-expanded', 'false');
  var bMore = btn('bimMore', '⋯', null, 'More: template, units, grid, measure, undo, name, open, capacity'); bMore.setAttribute('aria-expanded', 'false'); bMore.setAttribute('aria-haspopup', 'true');
  var bSave = btn('bimSave', '💾', 'Save', 'Save a new version'); bSave.classList.add('bim-primary');
  var v2 = btn('bimV2d', null, '2D', 'Show the 2D plan'); v2.setAttribute('data-v', '2d');
  var v3 = btn('bimV3d', null, '3D', 'Show the 3D view'); v3.setAttribute('data-v', '3d');
  var vW = btn('bimWalk', null, 'Walk', 'Walkthrough: a guided walk around the venue in 3D');
  tl.append(bBack, bExit, bTools);
  tr.append(bInsp, bMore, bSave);
  rail.append(v2, v3, vW);
  var nav = btn('bimNav', '▴', null, 'Show the app bar'); nav.classList.add('bim-navh'); nav.setAttribute('aria-expanded', 'false');
  var menuX = el('button', 'tbtn bim-menux', '✕ Close', { type: 'button', id: 'bimMenuClose', 'aria-label': 'Close the menu' });

  /* ---------------- wiring: every button clicks the real control ---------------- */
  bBack.addEventListener('click', function () { press('header .brand'); });
  bExit.addEventListener('click', function () { var u = window.HelmFullscreen && HelmFullscreen._ui; if (u && u.exit) u.exit(); });
  bTools.addEventListener('click', function () { setMenu(false); press('#toolsToggle'); });
  bInsp.addEventListener('click', function () { setMenu(false); press('#inspToggle'); });
  bSave.addEventListener('click', function () { press('#saveBtn'); });
  bMore.addEventListener('click', function () { setMenu(!html.classList.contains('bim-menu')); });
  menuX.addEventListener('click', function () { setMenu(false, true); });
  [v2, v3].forEach(function (b) {
    b.addEventListener('click', function () {
      try { var w = window.HelmWalkthrough && HelmWalkthrough._ui; if (w && w.exit && doc.body.classList.contains('wt-on')) w.exit(); } catch (_) {}
      press('#viewSeg [data-v="' + b.getAttribute('data-v') + '"]'); later(syncView);
    });
  });
  vW.addEventListener('click', function () {
    var w = window.HelmWalkthrough && HelmWalkthrough._ui; if (!w) return;
    try { if (doc.body.classList.contains('wt-on')) { if (w.exit) w.exit(); } else if (w.start) Promise.resolve(w.start()).then(syncView, syncView); } catch (_) {}
    later(syncView);
  });
  nav.addEventListener('click', function () { setNav(!html.classList.contains('bim-nav-open'), true); });
  // keep pointer / touch / wheel events off the canvas underneath (no marquee, drag or orbit starts on a button)
  [tl, tr, rail, nav].forEach(function (c) {
    ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'wheel'].forEach(function (t) { c.addEventListener(t, function (e) { e.stopPropagation(); }, { passive: true }); });
  });

  function later(fn) { setTimeout(fn, 60); setTimeout(fn, 700); setTimeout(fn, 2500); }

  /* ---------------- state mirrors ---------------- */
  function syncView() {
    var on3 = !!(window.__helm3D && __helm3D.isActive && __helm3D.isActive());
    var walk = doc.body.classList.contains('wt-on');
    v2.setAttribute('aria-pressed', String(!on3 && !walk)); v3.setAttribute('aria-pressed', String(on3 && !walk)); vW.setAttribute('aria-pressed', String(walk));
  }
  function syncMirror() {
    var t = $('#toolsToggle'), i = $('#inspToggle'), s = $('#saveBtn');
    if (t) bTools.setAttribute('aria-expanded', t.getAttribute('aria-expanded') || 'false');
    if (i) bInsp.setAttribute('aria-expanded', i.getAttribute('aria-expanded') || 'false');
    // Save follows the real button: hidden for a read-only role / a version being viewed, disabled while it is
    var sv = !!s && !s.hidden && !s.closest('[hidden]');
    bSave.hidden = !sv; bSave.disabled = !!(s && s.disabled);
    var wt = !!(window.HelmWalkthrough && HelmWalkthrough._ui && HelmWalkthrough._ui.start);
    vW.hidden = !wt;
  }
  function syncFs() {
    var on = doc.body.classList.contains('fs-on');
    bExit.hidden = !on; bBack.hidden = on;
    if (on) setMenu(false);
  }

  /* ---------------- the "More" menu: the full top bar as a sheet ---------------- */
  var opener = null;
  function setMenu(on, focusBack) {
    var was = html.classList.contains('bim-menu');
    on = !!on && mq.matches;
    html.classList.toggle('bim-menu', on);
    bMore.setAttribute('aria-expanded', String(on));
    if (on && !was) {
      opener = doc.activeElement;
      var f = $('header #preset') || menuX;
      setTimeout(function () { try { (shown(f) ? f : menuX).focus({ preventScroll: true }); } catch (_) {} }, 30);
    } else if (!on && was) {
      try { var hd = $('header'); hd && hd.querySelectorAll('details.hmenu[open]').forEach(function (d) { d.open = false; }); } catch (_) {}
      if (focusBack) { try { (opener && doc.contains(opener) ? opener : bMore).focus({ preventScroll: true }); } catch (_) {} }
    }
  }
  doc.addEventListener('pointerdown', function (e) {
    if (!html.classList.contains('bim-menu')) return;
    var t = e.target;
    if (t && t.closest && t.closest('header,#bimMore,.hmenu-pop,.modal,.bpui-overlay,[data-bpui],.hs-overlay')) return;
    setMenu(false);
  }, true);
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && html.classList.contains('bim-menu')) { e.preventDefault(); e.stopPropagation(); setMenu(false, true); }
  }, true);
  // a dialog opened from the menu (Template, Open, Create layout ...) closes the sheet behind it
  doc.addEventListener('click', function (e) {
    if (!html.classList.contains('bim-menu')) return;
    var t = e.target; if (!t || !t.closest) return;
    if (t.closest('#customBtn,#loadBtn,#clientImgBtn,#viewSeg [data-v="render"],#viewSeg [data-v="2d"],#viewSeg [data-v="3d"],.hmenu-pop .tbtn')) setTimeout(function () { setMenu(false); }, 0);
  });

  /* ---------------- the app's bottom tab bar: folded away, a handle brings it up ---------------- */
  function setNav(on, remember) {
    html.classList.toggle('bim-nav-open', !!on);
    nav.setAttribute('aria-expanded', String(!!on));
    nav.setAttribute('aria-label', on ? 'Hide the app bar' : 'Show the app bar'); nav.title = nav.getAttribute('aria-label');
    nav.firstChild.textContent = on ? '▾' : '▴';
    if (remember) { try { sessionStorage.setItem(NAV_KEY, on ? '1' : '0'); } catch (_) {} }
  }
  var navOpen = false;
  try { navOpen = sessionStorage.getItem(NAV_KEY) === '1'; } catch (_) { navOpen = false; }

  /* ---------------- mount ---------------- */
  function mount() {
    if (!doc.body || doc.getElementById('bimTL')) return;
    doc.body.append(tl, tr, rail, nav);
    var hd = $('header'); if (hd) hd.appendChild(menuX);
    setNav(navOpen, false);
    syncMirror(); syncView(); syncFs();
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () { syncMirror(); syncView(); syncFs(); });
      ['#toolsToggle', '#inspToggle', '#saveBtn'].forEach(function (s) { var n = $(s); if (n) mo.observe(n, { attributes: true, attributeFilter: ['aria-expanded', 'hidden', 'disabled', 'class'] }); });
      var hdr = $('header'); if (hdr) mo.observe(hdr, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
      mo.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
      var st = $('#stage3d'); if (st) mo.observe(st, { attributes: true, attributeFilter: ['hidden'] });
    }
    // the walkthrough script may load after this one
    later(syncMirror);
  }
  onMq(function () { if (!mq.matches) setMenu(false); syncFs(); });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount); else mount();

  window.__helmImmersive = { query: PHONE_Q, isPhone: function () { return mq.matches; }, setMenu: setMenu, setNav: setNav };
})();

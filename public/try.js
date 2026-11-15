/* try.js — the public "Try the planner" mini-demo (public/try.html, generated
   from builder.html by scripts/gen-try.mjs). Loaded FIRST, in <head>:
     1. no Supabase: the config is blanked, so store-api.js runs its browser-only
        localStorage tier (layouts live in this browser and nowhere else);
     2. network guard: only same-origin static GETs are allowed (three.js is self-hosted
        under /vendor/) — every API / Supabase / write request is refused;
     3. theme (the builder's inline theme script is not carried over);
     4. after load: a pre-made wedding banquet, the 2D / 3D / Measure toggle (m / ft),
        a 5-item "Add item" tray, rotate and reset (builder.js window.__helmSandbox hook). */
(function () {
  'use strict';
  var W = window;
  try { Object.defineProperty(W, 'HELM_SANDBOX', { value: true, writable: false, configurable: false }); } catch (e) {}
  try { Object.defineProperty(W, 'SUPABASE_CONFIG', { value: Object.freeze({ url: '', anonKey: '' }), writable: false, configurable: false }); } catch (e) {}

  /* ---- 2. network guard ---- */
  var CDN = [];   // three.js is same-origin now (/vendor/three-<ver>/, loaded by /three-boot.js)
  function okUrl(u, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return false;
    var url; try { url = new URL(String(u), location.href); } catch (e) { return false; }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
    if (url.origin === location.origin) return !/^\/(api|functions|rest|auth|storage)(\/|$)/.test(url.pathname);
    for (var i = 0; i < CDN.length; i++) if (url.href.indexOf(CDN[i]) === 0) return true;
    return false;
  }
  W.__trySandboxOk = okUrl;   // for tests / debugging only
  var realFetch = W.fetch;
  if (realFetch) {
    W.fetch = function (input, init) {
      var u = input && typeof input === 'object' && 'url' in input ? input.url : input;
      var m = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      if (!okUrl(u, m)) return Promise.reject(new TypeError('Sandbox: network request blocked'));
      return realFetch.apply(this, arguments);
    };
  }
  if (W.XMLHttpRequest) {
    var open = W.XMLHttpRequest.prototype.open;
    W.XMLHttpRequest.prototype.open = function (m, u) {
      if (!okUrl(u, m)) throw new TypeError('Sandbox: network request blocked');
      return open.apply(this, arguments);
    };
  }
  try { if (navigator.sendBeacon) navigator.sendBeacon = function () { return false; }; } catch (e) {}
  if (W.WebSocket) W.WebSocket = function () { throw new TypeError('Sandbox: network request blocked'); };

  /* ---- 3. theme (same key as the builder) ---- */
  try {
    var t = window.HELM_DARK_MODE === true ? localStorage.getItem('bps.theme') : 'light';   // dark mode off for now: always light
    document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
  } catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }

  /* ---- 4. the focused mini-demo: a pre-made wedding banquet, 3 modes, a 5-item tray ---- */
  var HALL = { w: 80, h: 54 };                       // ft (about 24.4 × 16.5 m)
  var DEMO = [
    { t: 'stagebackdrop', x: 25, y: 1,  o: { width: 30, label: 'Floral backdrop' } },
    { t: 'stage',         x: 25, y: 3,  o: { width: 30, height: 11, label: 'Stage' } },
    { t: 'lightingtree',  x: 19, y: 5,  o: { label: 'Light' } },
    { t: 'lightingtree',  x: 58, y: 5,  o: { label: 'Light' } },
    { t: 'dancefloor',    x: 30, y: 19, o: { width: 20, height: 15, label: 'Dance floor' } },
    { t: 'buffet',        x: 3,  y: 49, o: { width: 16, label: 'Buffet' } },
    { t: 'sofa',          x: 61, y: 49, o: { label: 'Lounge', rotation: 180 } },   // R72: face INTO the room (toward the dance floor / stage), not the south wall
    { t: 'sofa',          x: 70, y: 49, o: { label: 'Lounge', rotation: 180 } },
    { t: 'floralentrance',x: 33, y: 49, o: { label: 'Entrance arch' } },
    { t: 'lightingtree',  x: 28, y: 50, o: { label: 'Light' } },
    { t: 'lightingtree',  x: 49, y: 50, o: { label: 'Light' } }
  ];
  (function () {
    var n = 1, P = [[6, 18], [16, 18], [58, 18], [68, 18], [6, 28], [16, 28], [58, 28], [68, 28], [6, 38], [16, 38], [58, 38], [68, 38], [27, 39], [47, 39]];
    for (var i = 0; i < P.length; i++) DEMO.push({ t: 'table', x: P[i][0], y: P[i][1], o: { label: 'T' + (n++) } });
  })();
  var COLORS = {"stagebackdrop": "#c0607a", "stage": "#0f5c45", "lightingtree": "#c99a3e", "dancefloor": "#b8955a", "buffet": "#9a6b3f", "sofa": "#6b5a8e", "floralentrance": "#c0607a", "table": "#3f7d68", "floralarch": "#c0607a"};
  for (var di = 0; di < DEMO.length; di++) { DEMO[di].o.color = COLORS[DEMO[di].t]; DEMO[di].o.colorCustom = true; }
  var state = { mode: '2d', unit: 'm' };
  function api() { return W.__helmSandbox; }
  function $(id) { return document.getElementById(id); }

  /* ---- 3D bundle: not needed for first paint, so gen-try.mjs marks it <script type="text/plain" data-try-lazy>
     (never fetched). We inject the real scripts, in order, the first time the viewer reaches for 3D / Render.
     This keeps ~300KB+ of JS (builder-3d, walkthrough, dancers, capture-frame) off the initial load. ---- */
  var threeDReady = false, load3D = null;
  function ensure3D() {
    if (load3D) return load3D;
    var els = [].slice.call(document.querySelectorAll('script[data-try-lazy]'));
    load3D = els.reduce(function (pr, s) {
      return pr.then(function () {
        return new Promise(function (res, rej) {
          var el = document.createElement('script');
          el.src = s.getAttribute('src'); el.defer = false; el.async = false;
          el.onload = function () { res(); };
          el.onerror = function () { rej(new Error('Sandbox: failed to load ' + el.src)); };
          (document.head || document.documentElement).appendChild(el);
        });
      });
    }, Promise.resolve());
    return load3D;
  }
  function reduced() { try { return W.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function loadDemo() { var A = api(); if (!A) return false; A.load(DEMO, HALL); A.unit(state.unit); return true; }
  function swapFx() {
    if (reduced()) return;
    var r = document.documentElement; r.classList.remove('try-swap'); void r.offsetWidth; r.classList.add('try-swap');
    setTimeout(function () { r.classList.remove('try-swap'); }, 420);
  }
  function setMode(m) {
    var A = api(); if (!A || (m !== '2d' && m !== '3d' && m !== 'measure')) return;
    if (m === state.mode) return;
    // 3D needs its bundle: load it (once) before switching, so keyboard / programmatic entry works too
    if (m === '3d' && !threeDReady) { ensure3D().then(function () { threeDReady = true; setMode('3d'); }, function () {}); return; }
    swapFx();
    var seg = document.getElementById('viewSeg');
    var want = m === '3d' ? '3d' : '2d';
    if (m !== 'measure') A.measure(false);
    var b = seg && seg.querySelector('[data-v="' + want + '"]');
    if (b && !b.classList.contains('on')) b.click();
    if (m === 'measure') A.measure(true);
    state.mode = m;
    document.documentElement.setAttribute('data-try-mode', m);
    var bs = document.querySelectorAll('#tryModes [data-m]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-checked', String(bs[i].getAttribute('data-m') === m));
    $('tryUnits').hidden = m !== 'measure';
    $('tryHint').textContent = m === '3d' ? 'Drag to orbit · scroll or pinch to zoom' :
      m === 'measure' ? 'Tap an item to see its distance to every wall and neighbour' : 'Drag any item to move it · R or the round handle to rotate';
    if (m !== '3d') setTimeout(function () { A.fit(); }, 30);
    else [300, 1200].forEach(function (ms) { setTimeout(function () { if (state.mode === '3d' && typeof W.__zoom3D === 'function') W.__zoom3D('fit'); }, ms); });
    if (m === '3d') setTimeout(function () { if (state.mode === '3d' && typeof W.__zoom3D === 'function') W.__zoom3D(0.72); }, 1700);
  }
  function setUnit(u) {
    var A = api(); if (!A || (u !== 'm' && u !== 'ft')) return;
    state.unit = u; A.unit(u);
    var bs = document.querySelectorAll('#tryUnits [data-u]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-checked', String(bs[i].getAttribute('data-u') === u));
  }
  // nothing here is ever saved — skip the builder's "leave with unsaved changes?" prompt
  if (typeof W.addEventListener !== 'function') return;   // not a browser (unit tests)
  W.addEventListener('beforeunload', function (e) { e.stopImmediatePropagation(); }, true);
  W.__trySandbox = { setMode: setMode, setUnit: setUnit, reset: loadDemo };
  // the real builder's own 3D controls (header "3D View" / "Render", the phone's floating 3D button) click
  // #viewSeg buttons directly — builder-3d.js binds those, and it isn't loaded yet. Intercept the first such
  // click, load the bundle, then replay the click so the now-present handler runs.
  document.addEventListener('click', function (e) {
    if (threeDReady || !e.target.closest) return;
    var t = e.target.closest('#viewSeg [data-v="3d"],#viewSeg [data-v="render"]');
    if (!t) return;
    e.preventDefault(); e.stopImmediatePropagation();
    ensure3D().then(function () { threeDReady = true; setTimeout(function () { t.click(); }, 0); }, function () {});
  }, true);
  W.addEventListener('load', function () {
    if (!loadDemo()) return;
    document.documentElement.setAttribute('data-try-mode', '2d');
    // CLS: the demo is loaded + sized; fit it, then reveal the floor on the next frame (try.css hides #svg until
    // .try-ready) so its 0→full-size growth never shifts the page.
    try { api().fit(); } catch (e) {}
    var reveal = function () { document.documentElement.classList.add('try-ready'); };
    if (typeof W.requestAnimationFrame === 'function') W.requestAnimationFrame(function () { W.requestAnimationFrame(reveal); });
    else setTimeout(reveal, 60);
    var modes = $('tryModes');
    modes.addEventListener('click', function (e) { var b = e.target.closest('[data-m]'); if (b) setMode(b.getAttribute('data-m')); });
    modes.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var order = ['2d', '3d', 'measure'], i = order.indexOf(state.mode);
      i = (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3; setMode(order[i]);
      var nb = modes.querySelector('[data-m="' + order[i] + '"]'); if (nb) nb.focus(); e.preventDefault();
    });
    $('tryUnits').addEventListener('click', function (e) { var b = e.target.closest('[data-u]'); if (b) setUnit(b.getAttribute('data-u')); });
    var tray = $('tryTray'), add = $('tryAdd');
    function tray_(open) { tray.hidden = !open; add.setAttribute('aria-expanded', String(open)); }
    add.addEventListener('click', function () { tray_(tray.hidden); });
    tray.addEventListener('click', function (e) {
      var b = e.target.closest('[data-add]'); if (!b) return;
      if (state.mode === '3d') setMode('2d');
      api().add(b.getAttribute('data-add'), { color: COLORS[b.getAttribute('data-add')] }); tray_(false);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !tray.hidden) tray_(false); });
    $('tryRotate').addEventListener('click', function () { api().rotate(); });
    $('tryReset').addEventListener('click', function () { setMode('2d'); loadDemo(); });
    var rt; W.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (state.mode !== '3d') api().fit(); }, 150); });
  });
})();

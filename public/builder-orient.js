/* builder-orient.js (R154i) - the floor builder on a phone.
 *  1. Portrait phone (touch screen, short side under 600px): a friendly card "Turn your phone sideways for the
 *     best view" with "Continue anyway" (remembered for this browser tab via sessionStorage). Where the browser
 *     really supports it (Android Chrome: fullscreen + screen.orientation.lock) a "Rotate for me" button tries
 *     it after the user's tap; it is never relied on - the card simply goes away once the phone is sideways.
 *     Tablets, laptops and desktops never see the card.
 *  2. Phone in landscape (builder-landscape.css): two fingers on the 2D floor zoom it (one finger pans the
 *     floor natively, objects drag as before); a rotation re-fits the 2D floor / re-sizes the 3D view once the
 *     browser has settled; a text field opened in a drawer is scrolled into view above the keyboard.
 * Everything is guarded: no-op in the /try sandbox and the headless picture host, and on any missing API. */
(function () {
  'use strict';
  var doc = document, html = doc.documentElement;
  if (html.classList.contains('helm-sandbox') || doc.querySelector('meta[name="helm-capture"]')) return;
  if (!window.matchMedia) return;
  var PORTRAIT_Q = '(orientation:portrait) and (pointer:coarse) and (max-width:599px)';
  var LAND_Q = '(orientation:landscape) and (max-height:500px) and (pointer:coarse)';
  var KEY = 'helm.builder.portraitOk';
  // R164: the floor is a full-screen editor on a phone held either way (builder-immersive.css) - two fingers zoom it upright too
  var PHONE_Q = '(pointer:coarse) and (orientation:landscape) and (max-height:500px), (pointer:coarse) and (orientation:portrait) and (max-width:599px)';
  var portraitMq = matchMedia(PORTRAIT_Q), landMq = matchMedia(LAND_Q), phoneMq = matchMedia(PHONE_Q);
  var onMq = function (mq, fn) { if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn); };
  var typing = function () { var a = doc.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };

  /* ---------------- 1. "Turn your phone sideways" card ---------------- */
  var dismissed = false;
  try { dismissed = sessionStorage.getItem(KEY) === '1'; } catch (_) { dismissed = false; }
  var card = null, opener = null;
  var canLock = function () {
    try { return !!(screen.orientation && typeof screen.orientation.lock === 'function' && html.requestFullscreen && doc.fullscreenEnabled !== false); }
    catch (_) { return false; }
  };
  function svg(tag, attrs) { var n = doc.createElementNS('http://www.w3.org/2000/svg', tag); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function build() {
    var c = doc.createElement('div');
    c.className = 'orient-card'; c.id = 'orientCard'; c.hidden = true;
    c.setAttribute('role', 'dialog'); c.setAttribute('aria-modal', 'true'); c.setAttribute('aria-labelledby', 'orientTitle'); c.setAttribute('aria-describedby', 'orientDesc');
    var box = doc.createElement('div'); box.className = 'orient-box';
    var ico = svg('svg', { 'class': 'orient-ico', viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' });
    var g = svg('g', { 'class': 'oi-phone' });
    g.appendChild(svg('rect', { x: '20', y: '8', width: '24', height: '48', rx: '4', fill: 'none', stroke: 'currentColor', 'stroke-width': '3' }));
    g.appendChild(svg('line', { x1: '28', y1: '50', x2: '36', y2: '50', stroke: 'currentColor', 'stroke-width': '3', 'stroke-linecap': 'round' }));
    ico.appendChild(g);
    ico.appendChild(svg('path', { d: 'M50 14a20 20 0 0 1 6 14', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.5', 'stroke-linecap': 'round', opacity: '.6' }));
    ico.appendChild(svg('path', { d: 'M52.5 27.5 56 30l2.5-3.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: '.6' }));
    var h = doc.createElement('h2'); h.id = 'orientTitle'; h.textContent = 'Turn your phone sideways for the best view';
    var p = doc.createElement('p'); p.id = 'orientDesc'; p.textContent = 'The floor builder has more room for the plan, the toolbox and the price panel when your phone is held sideways.';
    var acts = doc.createElement('div'); acts.className = 'orient-acts';
    var lock = doc.createElement('button'); lock.type = 'button'; lock.className = 'oc-lock'; lock.id = 'orientLock'; lock.textContent = 'Rotate for me'; lock.hidden = !canLock();
    var go = doc.createElement('button'); go.type = 'button'; go.className = 'oc-go'; go.id = 'orientContinue'; go.textContent = 'Continue anyway';
    acts.appendChild(lock); acts.appendChild(go);
    box.appendChild(ico); box.appendChild(h); box.appendChild(p); box.appendChild(acts); c.appendChild(box);
    go.addEventListener('click', function () {
      dismissed = true; try { sessionStorage.setItem(KEY, '1'); } catch (_) {}
      hide();
    });
    lock.addEventListener('click', function () {
      // only after this tap, and only where supported: fullscreen first (the lock needs it), then landscape.
      // Any refusal is fine - the card stays and "Continue anyway" still works.
      try {
        var fs = html.requestFullscreen({ navigationUI: 'hide' });
        Promise.resolve(fs).then(function () { return screen.orientation.lock('landscape'); })
          .catch(function () { try { if (doc.fullscreenElement && doc.exitFullscreen) doc.exitFullscreen().catch(function () {}); } catch (_) {} lock.hidden = true; });
      } catch (_) { lock.hidden = true; }
    });
    c.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); go.click(); return; }
      if (e.key === 'Tab') {   // keep focus on the card while it is up
        var f = [lock, go].filter(function (b) { return !b.hidden; }); if (!f.length) return;
        var i = f.indexOf(doc.activeElement);
        if (e.shiftKey ? i <= 0 : i === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
      }
    });
    doc.body.appendChild(c);
    return c;
  }
  function show() {
    if (!card) card = build();
    if (!card.hidden) return;
    opener = doc.activeElement;
    card.hidden = false;
    // the page is hidden until sign-in is checked (html.auth-pending), so keep trying for a moment until focus lands
    var go = doc.getElementById('orientContinue'), tries = 0;
    var focusGo = function () {
      if (!go || card.hidden || doc.activeElement === go || card.contains(doc.activeElement) || ++tries > 40) return;
      try { go.focus({ preventScroll: true }); } catch (_) {}
      if (doc.activeElement !== go) setTimeout(focusGo, 250);
    };
    setTimeout(focusGo, 0);
  }
  function hide() {
    if (!card || card.hidden) return;
    var had = card.contains(doc.activeElement);
    card.hidden = true;
    if (had && opener && opener.focus && opener !== doc.body) { try { opener.focus({ preventScroll: true }); } catch (_) {} }
  }
  function syncCard() {
    if (typing()) return;                          // a keyboard that squeezes the screen is not a rotation
    if (portraitMq.matches && !dismissed) show(); else hide();
  }
  function bootCard() { if (doc.body) syncCard(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bootCard); else bootCard();
  onMq(portraitMq, syncCard);

  /* ---------------- 2a. rotation: re-fit once the browser has settled ---------------- */
  var settleT = 0;
  function settle() {
    clearTimeout(settleT);
    settleT = setTimeout(function () {
      try { window.dispatchEvent(new Event('resize')); } catch (_) {}          // builder-3d.js: setSize + camera aspect
      try { if (typeof viewAtFit !== 'undefined' && viewAtFit && typeof is3DActive === 'function' && !is3DActive() && typeof fitView === 'function') fitView(); } catch (_) {}
      try { if (typeof renderRulers === 'function') renderRulers(); } catch (_) {}
    }, 260);
  }
  window.addEventListener('orientationchange', settle);
  onMq(landMq, settle);
  try { if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', settle); } catch (_) {}

  /* ---------------- 2b. two-finger zoom on the 2D floor (phone landscape only) ---------------- */
  var scrollEl = doc.getElementById('scroll');
  var pinch = null;
  var dist = function (t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); };
  if (scrollEl && typeof setZoom === 'function') {
    scrollEl.addEventListener('touchstart', function (e) {
      if (!(landMq.matches || phoneMq.matches) || e.touches.length !== 2) return;
      if (typeof is3DActive === 'function' && is3DActive()) return;
      var z0 = (typeof store !== 'undefined' && store.view && store.view.zoom) || 1, d0 = dist(e.touches);
      if (!(d0 > 0)) return;
      // a one-finger drag that was starting becomes the pinch: finish it cleanly first
      try { if (typeof drag !== 'undefined' && drag && typeof endDrag === 'function') endDrag({}); } catch (_) {}
      pinch = { d0: d0, z0: z0 };
    }, { passive: true });
    scrollEl.addEventListener('touchmove', function (e) {
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      var r = scrollEl.getBoundingClientRect();
      var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
      var z = pinch.z0 * dist(e.touches) / pinch.d0;
      try { setZoom(z, { x: scrollEl.scrollLeft + mx, y: scrollEl.scrollTop + my, sx: mx, sy: my }); } catch (_) { pinch = null; }
    }, { passive: false });
    var endPinch = function (e) { if (pinch && (!e.touches || e.touches.length < 2)) pinch = null; };
    scrollEl.addEventListener('touchend', endPinch, { passive: true });
    scrollEl.addEventListener('touchcancel', endPinch, { passive: true });
  }

  /* ---------------- 2c. keyboard: keep a focused field in a drawer / dialog visible ---------------- */
  doc.addEventListener('focusin', function (e) {
    if (!landMq.matches) return;
    var t = e.target;
    if (!t || !/^(INPUT|TEXTAREA)$/.test(t.tagName) || !t.closest || !t.closest('aside,.modal,.sheet')) return;
    setTimeout(function () { try { t.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {} }, 320);   // after the keyboard animates in
  });

  window.__helmOrient = { portraitQuery: PORTRAIT_Q, landscapeQuery: LAND_Q, sync: syncCard, isDismissed: function () { return dismissed; } };
})();

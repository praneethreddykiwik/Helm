/* login-submit-guard.js - r84: until login.html's page script has attached its submit handlers, a click on "Sign in"
   would do a NATIVE form submit: the page reloads (the e-mail + password land in the URL) and what was typed is lost.
   This tiny early script holds any submit on the page until the handlers are ready, then replays the last one once.
   R224 (faster first paint): it also loads the page's app scripts AFTER the first paint. login.html carries them as inert
   <script type="text/plain" data-login-lazy src=...> tags (never fetched by the browser on their own); right after the
   first frame they are added, in document order, as ordered scripts (async=false: they run one after another exactly
   like the old `defer` tags). When every one has loaded (or failed) the event "helm:login-ready" fires: the page script
   runs on it, and the held submit is replayed a tick later. External file (strict CSP, no inline). */
(function () {
  "use strict";
  var ready = false, pending = null, submitter = null, started = false;
  document.addEventListener("submit", function (e) {
    if (ready) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    pending = e.target;
    submitter = e.submitter || null;
  }, true);
  // R146 (faster first paint): the stylesheets only the sign-up / plan / onboarding steps use (ui-pickers, trial-terms,
  // plan-cards, referral-signup) are in login.html as <link media="print" data-lazy-css>: they download early but do
  // not hold the first paint. They are switched on here, at DOMContentLoaded - before the page script (which now runs
  // on "helm:login-ready", later still) shows any of those steps - so every step still has its styles when it appears.
  document.addEventListener("DOMContentLoaded", function () {
    try {
      var ls = document.querySelectorAll("link[data-lazy-css]");
      for (var i = 0; i < ls.length; i++) ls[i].media = "all";
    } catch (err) { /* never break the page */ }
  });
  function replay() {
    // the page script's "helm:login-ready" listener ran inside dispatchEvent (before this tick): its handlers are attached
    setTimeout(function () {
      ready = true;
      window.HelmLoginSubmitReady = true;
      var f = pending; pending = null;
      if (f && f.isConnected && !f.hidden) {
        try { if (f.requestSubmit) f.requestSubmit(submitter && submitter.form === f ? submitter : undefined); }
        catch (err) { /* ignore: the person can click again */ }
      }
    }, 0);
  }
  function fireReady() {
    window.HelmLoginLazyLoaded = true;
    var ev = null;
    try { ev = new CustomEvent("helm:login-ready"); }
    catch (err) { try { ev = document.createEvent("Event"); ev.initEvent("helm:login-ready", false, false); } catch (e2) { ev = null; } }
    try { if (ev) document.dispatchEvent(ev); } catch (err) { /* the page reports its own errors */ }
    replay();
  }
  // add the inert app-script tags as real ordered scripts; "ready" once every one has loaded or failed (a failed one is
  // simply missing, as a failed `defer` tag was)
  function loadLazy() {
    if (started) return;
    started = true;
    var tags = [];
    try { tags = Array.prototype.slice.call(document.querySelectorAll('script[type="text/plain"][data-login-lazy]')); } catch (err) { tags = []; }
    var left = tags.length;
    if (!left) { fireReady(); return; }
    var settle = function () { left--; if (left === 0) fireReady(); };
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i], s = document.createElement("script");
      s.async = false;
      s.addEventListener("load", settle);
      s.addEventListener("error", settle);
      s.src = t.getAttribute("src");
      t.parentNode.insertBefore(s, t.nextSibling);
    }
  }
  // after the first paint: the browser's own "first-contentful-paint" entry (reported once the frame is on screen), or
  // two animation frames where paint timing is missing; a timer is the back-up (a tab opened in the background paints
  // nothing until it is shown)
  function afterFirstPaint(fn) {
    var done = false, w = window;
    var go = function () { if (done) return; done = true; setTimeout(fn, 0); };
    var frames = function () {
      if (typeof w.requestAnimationFrame === "function") w.requestAnimationFrame(function () { w.requestAnimationFrame(go); });
      else go();
    };
    try {
      var P = w.performance;
      if (P && P.getEntriesByName && P.getEntriesByName("first-contentful-paint").length) { go(); }
      else if (typeof w.PerformanceObserver === "function" && (w.PerformanceObserver.supportedEntryTypes || []).indexOf("paint") !== -1) {
        var po = new w.PerformanceObserver(function (list) {
          if (list.getEntriesByName("first-contentful-paint").length) { try { po.disconnect(); } catch (e) {} go(); }
        });
        po.observe({ type: "paint", buffered: true });
      } else frames();
    } catch (err) { frames(); }
    setTimeout(go, 1000);
  }
  document.addEventListener("DOMContentLoaded", function () { afterFirstPaint(loadLazy); });
})();

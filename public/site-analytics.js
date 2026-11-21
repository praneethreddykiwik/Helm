/* site-analytics.js - R243 (P11 + owner 20 Nov 2026): Vercel Web Analytics on the PUBLIC marketing pages only.
   Cookie-free and aggregate (Vercel counts page views; no cookie, no personal profile, no consent banner needed).
   Loaded ONLY by the public pages (home, pricing, about, services, contact-sales, demo, try, login / signup and the
   legal pages) - never by the signed-in app or by a client / crew link page (booklet, approve, portal, invite, /i/,
   work / staff task links), so a private link never reaches Vercel.
   Belt and braces, in this order:
     1. the queue stub Vercel documents (window.va / window.vaq), so beforeSend is registered before their script runs;
     2. beforeSend: sends ONLY this origin + a path on the allowlist below, with the query string and #hash removed
        (tokens, ?plan=, ?invite=, #access_token never leave the browser); any other page / host is dropped;
     3. the Vercel script itself (/_vercel/insights/script.js, served by Vercel from THIS origin once Web Analytics is
        enabled in the project) is added only on a deployed site - never on localhost / *.localhost / *.test.
   Same origin only, so the CSP needs nothing new ('self' already covers the script and its /_vercel/insights/view beacon).
   Turning it off: remove this script tag from the pages, or switch Web Analytics off in Vercel (the script then 404s
   quietly and nothing is sent). */
(function (w, d) {
  "use strict";
  var ALLOW = /^\/(?:(?:index|pricing|about|services|contact-sales|demo|try|login|signup|terms|privacy|cookie-policy|acceptable-use|accessibility|ai-notice|copyright|data-deletion|dpa|grievance|refund-policy|referral-terms|security|sla|subprocessors)(?:\.html)?\/?)?$/;
  function host() { try { return String(w.location.hostname || ""); } catch (e) { return ""; } }
  function isLocal(hn) { return !hn || hn === "localhost" || hn === "127.0.0.1" || hn === "[::1]" || hn === "::1" || /\.(?:localhost|test)$/.test(hn); }
  // what Vercel is allowed to see of a URL: this origin + an allowlisted path, nothing else
  function clean(u) {
    try {
      if (!/^https?:\/\//i.test(String(u || ""))) return null;   // only a full address (what Vercel passes)
      var x = new URL(String(u));
      if (x.origin !== w.location.origin) return null;
      if (!ALLOW.test(x.pathname)) return null;
      return x.origin + x.pathname;
    } catch (e) { return null; }
  }
  function beforeSend(ev) {
    if (!ev || typeof ev.url !== "string") return null;
    var u = clean(ev.url); if (!u) return null;
    var out = {}; for (var k in ev) if (Object.prototype.hasOwnProperty.call(ev, k)) out[k] = ev[k];
    out.url = u;
    return out;
  }
  w.HelmSiteAnalytics = { clean: clean, beforeSend: beforeSend, allowed: function (p) { return ALLOW.test(String(p || "")); } };
  if (isLocal(host())) return;
  if (!clean(String(w.location.href))) return;            // not a public page (copied onto the wrong page by mistake): load nothing
  w.va = w.va || function () { (w.vaq = w.vaq || []).push(arguments); };
  w.va("beforeSend", beforeSend);
  try {
    var s = d.createElement("script");
    s.defer = true;
    s.src = "/_vercel/insights/script.js";
    (d.head || d.documentElement).appendChild(s);
  } catch (e) { /* analytics is optional: never break the page */ }
})(window, document);

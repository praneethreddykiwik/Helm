/* browser-check.js - R243 (P11 DEV-01 + DEV-03): a polite banner when this browser is too old for Helm, or when it
   blocks site storage (sign-in and drafts need it). FEATURE checks only - never the browser's name (no UA sniffing).
   Written in old JavaScript on purpose (var / function, no arrows, no classes) so it still runs in the very browsers
   it warns about, even when the page's own modern scripts fail to load there.
   Supported (published in the PR + VERCEL-ANALYTICS-SETUP.md): Chrome / Edge / Samsung Internet from 2020 (Chrome 80+),
   Safari 13.1+ (iPhone iOS 13.4+), Firefox 78+. What is checked = what Helm's own scripts use:
     - Promise, fetch, URLSearchParams, Promise.allSettled, Object.fromEntries, globalThis
     - Unicode letter matching in patterns (new RegExp("\\p{L}", "u")) - the name / address checks use it
   Shown once per tab (a "Got it" button hides it; remembered for the tab only when storage works). Never blocks the page. */
(function (w, d) {
  "use strict";
  if (!w || !d || w.__helmBrowserCheck) return;
  w.__helmBrowserCheck = true;

  function modernOk() {
    try {
      if (typeof w.Promise !== "function" || typeof w.Promise.allSettled !== "function") return false;
      if (typeof w.fetch !== "function" || typeof w.URLSearchParams !== "function") return false;
      if (typeof Object.fromEntries !== "function" || typeof Object.assign !== "function") return false;
      if (typeof globalThis === "undefined") return false;
      new RegExp("\\p{L}", "u");            // throws (SyntaxError) where Unicode property escapes are missing
      return true;
    } catch (e) { return false; }
  }
  function storageOk() {
    try {
      var k = "__helm_sc", s = w.localStorage;
      if (!s) return false;
      s.setItem(k, "1"); var ok = s.getItem(k) === "1"; s.removeItem(k);
      return ok;
    } catch (e) { return false; }
  }
  function seen(key) { try { return w.sessionStorage && w.sessionStorage.getItem(key) === "1"; } catch (e) { return false; } }
  function remember(key) { try { if (w.sessionStorage) w.sessionStorage.setItem(key, "1"); } catch (e) {} }

  function banner(id, title, text) {
    if (d.getElementById(id) || !d.body) return;
    var box = d.createElement("div");
    box.id = id; box.className = "helm-browser-note";
    box.setAttribute("role", "alert");
    var st = box.style;   // CSSOM properties (allowed by the CSP; no inline style attribute)
    st.position = "relative"; st.zIndex = "2147483000"; st.margin = "0"; st.padding = "12px 16px";
    st.background = "#fff7e6"; st.color = "#5c3d00"; st.borderBottom = "1px solid #f0c36d";
    st.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"; st.fontSize = "14px"; st.lineHeight = "1.45";
    var b = d.createElement("strong"); b.appendChild(d.createTextNode(title)); box.appendChild(b);
    box.appendChild(d.createTextNode(" " + text + " "));
    var btn = d.createElement("button");
    btn.type = "button"; btn.appendChild(d.createTextNode("Got it"));
    var bs = btn.style;
    bs.marginLeft = "6px"; bs.padding = "4px 12px"; bs.border = "1px solid #c98a12"; bs.borderRadius = "8px";
    bs.background = "#fff"; bs.color = "#5c3d00"; bs.font = "inherit"; bs.cursor = "pointer";
    btn.onclick = function () { remember(id); if (box.parentNode) box.parentNode.removeChild(box); };
    box.appendChild(btn);
    d.body.insertBefore(box, d.body.firstChild);
  }

  function run() {
    if (!modernOk()) {
      if (!seen("helmOldBrowser")) banner("helmOldBrowser", "This browser is too old for Helm.",
        "Some buttons or pages may not work. Please update Chrome, Safari, Edge or Firefox to a recent version - it is free.");
      return;   // one note at a time
    }
    if (!storageOk() && !seen("helmNoStorage")) banner("helmNoStorage", "This browser is blocking site storage.",
      "Signing in and saved drafts need it. Turn off private / incognito mode, or allow site data for this site in your browser settings.");
  }
  w.HelmBrowserCheck = { modernOk: modernOk, storageOk: storageOk, run: run };
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", run); else run();
})(typeof window !== "undefined" ? window : null, typeof document !== "undefined" ? document : null);

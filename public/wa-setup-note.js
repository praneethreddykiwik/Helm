/* wa-setup-note.js - R130 (owner, 9 Nov 2026): "only the studio number, not Helm's. If it is not set up, show a message
   that it is not set up, go to Integrations and set it up, with a direct button."
   HelmWaSetupNote.mount(host[, { store, what }]) -> Promise<boolean connected>
     Shows nothing when the studio's own WhatsApp number is connected. Otherwise:
       "WhatsApp isn't set up for your studio yet, so <what> can't go out on WhatsApp. Connect your studio's WhatsApp number on
        the Integrations page." [Set up WhatsApp ->]   (+ "Only the studio admin can connect it.")
     Unknown (server without 0337 / not signed in): stays hidden - never a wrong warning.
   CSP-safe: createElement / textContent only. */
(function (global) {
  "use strict";
  var HREF = "integrations.html#whatsapp";
  function text(what) {
    return "WhatsApp isn't set up for your studio yet, so " + (what || "messages") + " can't go out on WhatsApp. Connect your studio's own WhatsApp number on the Integrations page.";
  }
  function build(host, what) {
    var doc = host.ownerDocument || global.document;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.classList.add("wa-setup-note"); host.setAttribute("role", "note");
    var p = doc.createElement("p"); p.className = "wsn-t"; p.textContent = text(what); host.appendChild(p);
    var a = doc.createElement("a"); a.className = "btn sm primary wsn-btn"; a.href = HREF; a.textContent = "Set up WhatsApp →"; host.appendChild(a);
    var s = doc.createElement("span"); s.className = "wsn-s muted"; s.textContent = "Only the studio admin can connect it."; host.appendChild(s);
    host.hidden = false;
  }
  function mount(host, opts) {
    if (!host) return Promise.resolve(null);
    var S = (opts && opts.store) || global.BPStore, I = S && S.integrations;
    host.hidden = true;
    if (!I || typeof I.waReady !== "function") return Promise.resolve(null);
    return Promise.resolve().then(function () { return I.waReady(); }).then(function (r) {
      if (!r || typeof r !== "object") return null;            // unknown -> no warning
      if (r.connected === true) { host.hidden = true; return true; }
      build(host, opts && opts.what);
      return false;
    }, function () { return null; });
  }
  var api = { mount: mount, text: text, HREF: HREF };
  global.HelmWaSetupNote = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

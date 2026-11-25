/* resource-steps.js - R255 (owner, 25 Nov 2026: "when I open the crew, the 4 above are missing"): ONE strip with the four steps that
 * cover an event, the same on Inventory (for an event), Tasks & Crew, Resource plan and Budget:
 *   1 Reserve our stock -> 2 Get what's missing from vendors -> 3 Assign our people -> 4 Check budget & margin
 *   (R257, owner: "first inventory, then vendors, then task and crew": people are briefed once it is known what is coming)
 *
 *   <nav class="rs" data-resource-steps="stock|vendors|people|budget"></nav>   filled by itself (the event from the page address)
 *   HelmResourceSteps.mount(host, { current, quoteId })                        the same, when the page knows the event
 *   HelmResourceSteps.href(key, quoteId)                                       the page of a step, for this event
 *   HelmResourceSteps.firstOpen(can, quoteId)                                  step 1, else the first step this person may open
 *
 * A step this person may not open is left out (the numbers stay). "Next" goes to the next step they may open. Links only, no writes,
 * no reads of its own except the role check the pages already make. DOM: createElement / textContent. */
(function (global) {
  "use strict";
  var STEPS = [
    { key: "stock", n: 1, label: "Reserve our stock", page: "inventory.html", area: "inventory" },
    { key: "vendors", n: 2, label: "Get what's missing from vendors", page: "resources.html", area: "resources" },
    { key: "people", n: 3, label: "Assign our people", page: "ops.html", area: "staff", hash: "#assign" },
    { key: "budget", n: 4, label: "Check budget & margin", page: "budget.html", area: "finance" }];
  function step(key) { return STEPS.filter(function (s) { return s.key === key; })[0] || null; }
  function href(key, quoteId) {
    var s = step(key); if (!s || !quoteId) return "";
    var h = s.page + "?quote=" + encodeURIComponent(quoteId) + (s.hash || "");   // R261: "Assign our people" opens Tasks & Crew with the assigning part only
    try { if (global.HelmUrl && global.HelmUrl.upgrade) h = global.HelmUrl.upgrade(h); } catch (e) {}
    return h;
  }
  // can = { inventory, staff, resources, finance } -> false only when known to be refused
  function open(can) { return STEPS.filter(function (s) { return !can || can[s.area] !== false; }); }
  function next(current, can) { var c = step(current); return c ? open(can).filter(function (s) { return s.n > c.n; })[0] || null : null; }
  function firstOpen(can, quoteId) { var l = open(can); return l.length ? href(l[0].key, quoteId) : ""; }

  var api = { STEPS: STEPS, href: href, open: open, next: next, firstOpen: firstOpen };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  var doc = global.document;
  function h(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function draw(host, current, quoteId, can) {
    host.textContent = ""; host.classList.add("rs"); host.hidden = false;
    host.setAttribute("aria-label", "How to cover this event, 4 steps");
    var ol = h("ol", "rs-list"), cur = null;
    open(can).forEach(function (s) {
      var li = h("li"), on = s.key === current, a = h(on ? "span" : "a", "rs-a" + (on ? " on" : ""));
      a.appendChild(h("span", "rs-n", String(s.n))); a.appendChild(h("span", null, s.label));
      if (on) { a.setAttribute("aria-current", "step"); cur = a; } else a.setAttribute("href", href(s.key, quoteId));
      li.appendChild(a); ol.appendChild(li);
    });
    host.appendChild(ol);
    var nx = next(current, can);
    var b = h("a", "rs-next", nx ? "Next →" : "Back to event");
    if (nx) { b.setAttribute("href", href(nx.key, quoteId)); b.setAttribute("aria-label", "Next: " + nx.n + " " + nx.label); b.setAttribute("title", nx.n + " " + nx.label); }
    else { var eh = "event.html?id=" + encodeURIComponent(quoteId); try { if (global.HelmUrl && global.HelmUrl.upgrade) eh = global.HelmUrl.upgrade(eh); } catch (e) {} b.setAttribute("href", eh); }
    host.appendChild(b);
    // a phone: the strip scrolls inside its own bar, with the step you are on in view (the page itself never moves)
    if (cur) { try { ol.scrollLeft = Math.max(0, cur.offsetLeft - Math.max(4, (ol.clientWidth - cur.offsetWidth) / 2)); } catch (e) {} }
  }
  function access() {
    var A = global.BPStore && global.BPStore.auth; if (!A || !A.canView) return Promise.resolve(null);
    var can = {};
    return Promise.all(STEPS.map(function (s) { return Promise.resolve().then(function () { return A.canView(s.area); }).then(function (v) { can[s.area] = v !== false; }, function () {}); })).then(function () { return can; });
  }
  function mount(host, o) {
    o = o || {}; if (!host || !o.quoteId || !step(o.current)) { if (host) host.hidden = true; return Promise.resolve(false); }
    host.dataset.rsMounted = "1"; draw(host, o.current, o.quoteId, null);
    return access().then(function (can) { if (can) draw(host, o.current, o.quoteId, can); return true; }).catch(function () { return true; });
  }
  function fromUrl() {
    var v = ""; try { var p = new URLSearchParams(global.location.search); v = p.get("quote") || p.get("id") || ""; } catch (e) {}
    try { if (global.HelmUrl && global.HelmUrl.get && global.HelmUrl.route && global.HelmUrl.route()) return Promise.resolve(global.HelmUrl.get("quote", v)).catch(function () { return v; }); } catch (e) {}
    return Promise.resolve(v);
  }
  function auto() {
    Array.prototype.forEach.call(doc.querySelectorAll("[data-resource-steps]"), function (host) {
      if (host.dataset.rsMounted) return; host.dataset.rsMounted = "1";
      fromUrl().then(function (q) {
        if (!q) { host.hidden = true; return; }
        var ready = global.BPStore && global.BPStore.init ? Promise.resolve(global.BPStore.init()).catch(function () {}) : Promise.resolve();
        return ready.then(function () { return mount(host, { current: host.getAttribute("data-resource-steps"), quoteId: q }); });
      });
    });
  }
  api.mount = mount; global.HelmResourceSteps = api;
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", auto); else auto();
})(typeof window !== "undefined" ? window : this);

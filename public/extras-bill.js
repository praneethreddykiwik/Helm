/* extras-bill.js - R257 (owner, 25 Nov: an extra marked "Bill to client" was not seen on the settlement): the extras of the day (0440) on the money
 * pages, so none is forgotten.
 *   HelmExtrasBill.mount(host, { quoteId, money(n), warn })
 *     Payments & invoice   every extra that is undecided or marked "Bill to client": cost, where it stands, and "Add to the bill" (opens Budget with
 *                          the New change form filled in - the person checks the price and saves, then approves it as always)
 *     Closing (warn:true)  only while something is undecided or not on the bill yet: a warning, it never stops the closing
 *   HelmExtrasBill.prefill(quoteId)   Budget: #extra-<id> -> { title, detail, cost } for the New change form, or null
 * NOTHING HERE CHANGES MONEY: it reads BPStore.extras.list and the change requests, and may save the existing "Bill to client / Our cost" mark.
 * Shown only to someone who may see the costs (the server's see_cost); a database without 0440 = nothing. A change request made from an extra
 * carries "Extra ref x-<first 8 of its id>" in its detail: that is how the page knows it is on the bill. DOM calls only (textContent). */
(function (global) {
  "use strict";
  var doc = global.document;
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function ref(x) { return "x-" + String((x && x.id) || "").replace(/-/g, "").slice(0, 8); }
  function title(x) { var q = num(x && x.qty); return String((x && x.what) || "Extra").slice(0, 200) + (q && q !== 1 ? " × " + (Math.round(q * 100) / 100) : ""); }
  // what the pages show: [{ x, state }] state = decide | bill | asked | billed | refused (our cost / cancelled are left out)
  function rows(list, changes) {
    var ch = (changes || []).filter(Boolean);
    return ((list && list.items) || []).filter(function (x) { return x && !x.cancelled_at && x.decision !== "our_cost"; }).map(function (x) {
      var r = ref(x), mine = ch.filter(function (c) { return String(c.detail || "").indexOf("Extra ref " + r) >= 0; });
      var st = mine.some(function (c) { return c.status === "approved"; }) ? "billed" : mine.some(function (c) { return c.status !== "rejected" && c.status !== "declined" && c.status !== "cancelled"; }) ? "asked"
        : x.decision !== "bill" ? "decide" : mine.length ? "refused" : "bill";
      return { x: x, state: st };
    });
  }
  function open(rs) { return (rs || []).filter(function (r) { return r.state !== "billed"; }); }
  // the one sentence of the closing warning ("" = nothing to say)
  function warnText(rs) {
    var n = function (k) { return rs.filter(function (r) { return k.indexOf(r.state) >= 0; }).length; }, b = n(["bill", "refused"]), a = n(["asked"]), d = n(["decide"]), out = [];
    var e = function (k) { return k + (k === 1 ? " extra" : " extras"); };
    if (b) out.push(e(b) + " marked “Bill to client” " + (b === 1 ? "is" : "are") + " not on the bill yet");
    if (a) out.push(e(a) + " " + (a === 1 ? "waits" : "wait") + " as a change request that is not approved");
    if (d) out.push(e(d) + " " + (d === 1 ? "is" : "are") + " not decided (bill to client or our cost)");
    return out.length ? out.join(". ") + ". You can still close." : "";
  }
  var pure = { ref: ref, title: title, rows: rows, open: open, warnText: warnText };
  var api = global.HelmExtrasBill = { _pure: pure };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!doc || !doc.createElement) return;

  function B() { return global.BPStore; }
  function el(t, c, s) { var e = doc.createElement(t); if (c) e.className = c; if (s != null) e.textContent = s; return e; }
  function href(q, x) { return "budget.html?quote=" + encodeURIComponent(q) + (x ? "#extra-" + encodeURIComponent(x.id) : ""); }
  async function read(q) {
    var X = B() && B().extras; if (!X || !q) return null;
    var l = null; try { l = await X.list(q); } catch (e) { return null; }           // not allowed / offline: nothing is shown
    if (!l || l.see_cost !== true) return null;
    var ch = []; try { ch = (await B().budget.listChanges(q)) || []; } catch (e) { return null; }
    return { list: l, rows: rows(l, ch) };
  }
  var WORDS = { decide: ["To decide", "warn"], bill: ["Not on the bill yet", "warn"], refused: ["Change request refused", "warn"], asked: ["Change request - not approved yet", "info"], billed: ["On the bill", "ok"] };
  async function mount(host, o) {
    o = o || {}; if (!host) return null; var q = String(o.quoteId || ""), d = await read(q);
    var rs = d ? d.rows : [], show = o.warn ? open(rs) : rs;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.hidden = !show.length; if (host.hidden) return d;
    var money = typeof o.money === "function" ? o.money : function (n) { return String(n); };
    host.classList.add("card", "xb-card"); if (o.warn) host.classList.add("is-warn");
    host.appendChild(el("h2", "xb-h", o.warn ? "Extras from the day" : "Extras to decide / to bill"));
    host.appendChild(el("p", "sub", o.warn ? warnText(rs) : "What was added on the day. Nothing is billed by itself: add it as a change request, check the price, and approve it."));
    var ul = el("ul", "xb-list");
    show.forEach(function (r) {
      var x = r.x, li = el("li", "xb-row"), g = el("div", "xb-g"), w = WORDS[r.state]; g.appendChild(el("b", "", title(x)));
      var sub = el("span", "xb-sub"), bits = [x.asked_by ? "asked by " + x.asked_by : "", x.approved_by ? "approved by " + x.approved_by : "", x.note || ""].filter(Boolean).join(" · ");
      if (bits) { sub.textContent = bits; g.appendChild(sub); }
      li.appendChild(g);
      var c = el("span", "xb-c", x.cost != null ? money(x.cost) : "no cost typed"); if (x.cost != null) c.setAttribute("data-money", ""); li.appendChild(c);
      li.appendChild(el("span", "xb-st " + w[1], w[0]));
      var a = el("span", "xb-a");
      if (r.state === "decide" && d.list.can_decide) [["bill", "Bill to client"], ["our_cost", "Our cost"]].forEach(function (k) {
        var b = el("button", "btn sm", k[1]); b.type = "button"; b.setAttribute("aria-label", k[1] + ": " + title(x));
        b.addEventListener("click", async function () {
          if (b.disabled) return; Array.prototype.forEach.call(a.querySelectorAll("button"), function (z) { z.disabled = true; });
          try { await B().extras.decide(x.id, k[0]); } catch (e) { try { global.BPUI.toast(global.BPUI.friendlyError(e, { action: "save the choice" }), { type: "err" }); } catch (z) {} }
          mount(host, o);
        });
        a.appendChild(b); });
      if (r.state === "bill" || r.state === "refused") { var l = el("a", "btn sm primary", "Add to the bill"); l.href = href(q, x); l.setAttribute("aria-label", "Add to the bill: " + title(x)); a.appendChild(l); }
      if (r.state === "asked") { var m = el("a", "btn sm", "Open change requests"); m.href = href(q); a.appendChild(m); }
      li.appendChild(a); ul.appendChild(li);
    });
    host.appendChild(ul); return d;
  }
  // Budget: the extra named in the address (#extra-<id>), while it is not on a change request yet
  async function prefill(q) {
    var m = /^#extra-([0-9a-f-]{36})$/i.exec(String((global.location && global.location.hash) || "")); if (!m) return null;
    var d = await read(q), r = d ? d.rows.filter(function (z) { return String(z.x.id).toLowerCase() === m[1].toLowerCase(); })[0] : null;
    if (!r) return null;
    if (r.state === "asked" || r.state === "billed") return { already: r.state };
    return { title: title(r.x).slice(0, 120), detail: ("Added on the day" + (r.x.asked_by ? ", asked by " + r.x.asked_by : "") + ". Extra ref " + ref(r.x)).slice(0, 300), cost: r.x.cost != null ? num(r.x.cost) : null };
  }
  api.mount = mount; api.prefill = prefill; api.read = read;
})(typeof window !== "undefined" ? window : globalThis);

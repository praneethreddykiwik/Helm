/* event-extras.js - R255 (owner, 25 Nov: "extra food, extra stuff made that day should be there too"): the extras of one event.
 *
 *   HelmEventExtras.card(host, ctx)   the Extras card of On the event (Tasks & Crew): what was added, how many, cost, who asked / approved, note
 *   Wrap-up block "extras"            (HelmWrapDo.register) each one: Bill to client / Our cost - a mark, nothing else
 *   ctx: { quoteId, show, quote, tz, toast }
 *
 * A LIST ONLY: nothing here changes the bill, the budget or a payment. Nothing is deleted: "Undo" cancels the row with a reason and it stays
 * under "Cancelled". Data: BPStore.extras (0440; Issues - Can view / Can change; the cost needs Budget view). A database without 0440 or a role
 * that may not see it = the card is hidden. DOM calls only (textContent). Unit-tested in test/r255-c.test.mjs. */
(function (global) {
  "use strict";
  var doc = global.document, FRESH = 25000;
  /* ---------------- pure ---------------- */
  function clean(v, n) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n); }
  function numText(v) { var n = Number(v); return v == null || v === "" || !isFinite(n) ? "" : String(Math.round(n * 100) / 100); }
  // the form -> { item } or { error, field }
  function readForm(f) {
    f = f || {}; var what = clean(f.what, 201), qty = clean(f.qty, 20), cost = clean(f.cost, 20).replace(/,/g, "");
    if (!what) return { error: "Say what was added.", field: "what" };
    if (what.length > 200) return { error: "Keep it under 200 characters.", field: "what" };
    if (qty && !(/^\d{1,7}(\.\d{1,2})?$/.test(qty) && Number(qty) > 0)) return { error: "How many: a number above 0.", field: "qty" };
    if (cost && !/^\d{1,9}(\.\d{1,2})?$/.test(cost)) return { error: "Cost: a number, or leave it empty.", field: "cost" };
    return { item: { what: what, qty: qty || null, cost: cost || null, asked_by: clean(f.asked_by, 120) || null, approved_by: clean(f.approved_by, 120) || null, note: clean(f.note, 500) || null } };
  }
  function split(items) { var a = (items || []).filter(Boolean); return { live: a.filter(function (x) { return !x.cancelled_at; }), gone: a.filter(function (x) { return x.cancelled_at; }) }; }
  function title(x) { var q = numText(x.qty); return (x.what || "Extra") + (q && q !== "1" ? " × " + q : ""); }
  var DEC = { bill: "Bill to client", our_cost: "Our cost" };
  var pure = { readForm: readForm, split: split, title: title, numText: numText, DEC: DEC };
  var api = global.HelmEventExtras = { _pure: pure };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!doc || !doc.createElement || !global.HelmWrapDo || !global.HelmWrapDo._ui) return;

  var U = global.HelmWrapDo._ui, h = U.h, btn = U.btn;
  function B() { return global.BPStore; }
  function money(v) { var n = numText(v); if (!n) return ""; var t = null; try { t = B().studioTax && B().studioTax(); } catch (e) {} var sym = (t && t.symbol) || "₹", loc = "en-IN"; try { loc = B().studioLocale() || loc; } catch (e) {} try { return String(sym).trim() + Number(n).toLocaleString(loc); } catch (e) { return String(sym) + n; } }
  function line(ctx, x) { return [U.clock(ctx, x.at), x.asked_by ? "asked by " + x.asked_by : "", x.approved_by ? "approved by " + x.approved_by : "", x.cost != null ? "cost " + money(x.cost) : "", x.note || "", x.by ? "added by " + x.by : ""].filter(Boolean).join(" · "); }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  /* ---------------- the card (On the event) ---------------- */
  function card(host, ctx) {
    if (!host) return; var q = ctx && ctx.quoteId && ctx.quoteId !== "all" ? String(ctx.quoteId) : "", X = B() && B().extras; host._xctx = ctx;
    if (!q || !ctx.show || !X) { host.hidden = true; return; }
    var again = function () { card(host, host._xctx); }, S = host._xs; if (!S || S.q !== q) { S = host._xs = { q: q, at: 0, sig: "", form: null }; clear(host); host.hidden = true; }
    S.repaint = again;
    var load = function () { if (S.busy) return S.busy; S.at = Date.now(); S.busy = Promise.resolve().then(function () { return X.list(q); }).then(function (r) { S.data = r || null; S.no = !r; S.err = false; },
      function (e) { var c = String((e && e.code) || ""); if (c === "42501" || c === "PGRST301") { S.no = true; S.data = null; } else S.err = true; }).then(function () { S.busy = null; again(); }); return S.busy; };
    S.load = load;
    if (Date.now() - S.at > (S.no ? 300000 : FRESH)) load();
    host.hidden = !!S.no || (!S.data && !S.err); if (host.hidden) return;
    var d = S.data || { items: [] }, s = split(d.items), env = { q: q, ctx: ctx, reload: load }, off = U.busy(q + ":extras");
    if (S.form && S.form.open && host.contains(doc.activeElement) && S.sig) return;   // somebody is typing: the list waits for them
    var sig = JSON.stringify([d, S.err, off, !!(S.form && S.form.open), S.gone]); if (S.sig === sig) return; S.sig = sig;
    var keep = doc.activeElement && host.contains(doc.activeElement) ? doc.activeElement.getAttribute("data-key") : null; clear(host);
    var head = h("div", { cls: "tc-side-h" }, [h("h3", { cls: "tc-h2" }, ["Extras ", h("span", { cls: "tc-count", text: S.err && !S.data ? "not checked" : s.live.length ? String(s.live.length) : "none" })])]);
    if (d.can_edit) head.appendChild(h("span", { cls: "tc-iss-acts" }, [h("button", { type: "button", cls: "tc-btn sm", "data-key": "x:add", "aria-expanded": String(!!(S.form && S.form.open)), text: "+ Add an extra", on: { click: function () { S.form = { open: true, key: B().extras.newKey() }; S.sig = ""; again(); var i = host.querySelector("input"); if (i) i.focus(); } } })]));
    host.appendChild(head);
    if (S.err) host.appendChild(h("p", { cls: "hwd-why", role: "status" }, ["Couldn’t check the extras. ", btn("Try again", "x:retry", function () { load(); })]));
    if (S.form && S.form.open) host.appendChild(form(host, S, env, again));
    if (!s.live.length && !(S.form && S.form.open) && !S.err) host.appendChild(h("p", { cls: "tc-aempty", text: "Extra food, an extra table, anything added on the day: note it here so it is not forgotten. The client's bill does not change by itself." }));
    if (s.live.length) host.appendChild(list(s.live, ctx, function (x) { return [x.decision ? h("span", { cls: "hwd-pill is-left", text: DEC[x.decision] }) : null, d.can_edit ? btn("Undo", "x:undo:" + x.id, function () { undo(S, env, x); }, { ghost: true, off: off, label: "Undo: " + title(x) }) : null]; }));
    if (s.gone.length) { var det = h("details", { cls: "tc-xgone" }, [h("summary", { text: s.gone.length + " cancelled" }), list(s.gone, ctx, function () { return []; }, true)]); det.open = !!S.gone; det.addEventListener("toggle", function () { S.gone = det.open; }); host.appendChild(det); }
    if (keep) { var n = host.querySelector('[data-key="' + String(keep).replace(/["\\]/g, "") + '"]'); if (n) try { n.focus({ preventScroll: true }); } catch (e) {} }
  }
  function list(items, ctx, acts, gone) {
    return h("ul", { cls: "hwd-list" }, items.map(function (x) { var a = acts(x).filter(Boolean);
      return h("li", { cls: "hwd-row" + (gone ? " is-gone" : "") }, [h("span", { cls: "hwd-main" }, [h("b", { text: title(x) }), h("small", { text: gone ? "Cancelled" + (x.cancelled_by ? " by " + x.cancelled_by : "") + ": " + (x.cancel_reason || "") : line(ctx, x) })]), a.length ? h("span", { cls: "hwd-acts" }, a) : null]); }));
  }
  async function undo(S, env, x) {
    var r = await global.BPUI.prompt("It stays on the list as cancelled. Why?", { title: "Undo " + title(x) + "?", label: "Reason (required)", required: true, requiredMessage: "Give a short reason.", okLabel: "Undo it" });
    if (r === null) return; r = clean(r, 300); if (r.length < 3) { U.say(env.ctx, "The reason must be at least 3 characters.", "err"); return; }
    U.run(S, env, "extras", "undo it", async function () { var a = await B().extras.cancel(x.id, r); return a && a.changed === false ? { type: "info", text: "Already cancelled by someone else." } : title(x) + " cancelled."; });
  }
  function form(host, S, env, again) {
    var f = {}, err = h("p", { cls: "hwd-err", role: "alert", hidden: true }), id = (host.id || "xtra") + "F", sym = "₹"; try { var t = B().studioTax && B().studioTax(); if (t && t.symbol) sym = String(t.symbol).trim() || sym; } catch (e) {}
    function fld(k, label, o) { o = o || {}; var i = h("input", Object.assign({ cls: "tc-inp", id: id + k, "data-key": "x:f:" + k, autocomplete: "off" }, o.a || {})); i.value = (S.form.v || {})[k] || ""; i.addEventListener("input", function () { (S.form.v = S.form.v || {})[k] = i.value; }); f[k] = i;
      return h("label", { cls: "tc-xf" + (o.wide ? " wide" : ""), "for": id + k }, [h("span", null, [label, o.req ? h("b", { cls: "tc-xreq", "aria-hidden": "true", text: " *" }) : null]), i]); }
    var el = h("form", { cls: "tc-xform", novalidate: true, "aria-label": "Add an extra" }, [
      fld("what", "What was added", { req: true, wide: true, a: { maxlength: "200", placeholder: "e.g. 20 extra dinner plates", "aria-required": "true" } }),
      fld("qty", "How many (optional)", { a: { inputmode: "decimal", maxlength: "10" } }), fld("cost", "Cost in " + sym + " (optional)", { a: { inputmode: "decimal", maxlength: "14" } }),
      fld("asked_by", "Asked by (optional)", { a: { maxlength: "120" } }), fld("approved_by", "Approved by (optional)", { a: { maxlength: "120" } }),
      fld("note", "Note (optional)", { wide: true, a: { maxlength: "500" } }), err,
      h("p", { cls: "tc-hint wide", text: "This is a note for Wrap-up. It does not change the client's bill." }),
      h("span", { cls: "hwd-acts wide" }, [h("button", { type: "submit", cls: "tc-btn sm hwd-b is-main", "data-key": "x:save", text: "Add it" }), btn("Cancel", "x:close", function () { S.form = null; S.sig = ""; again(); var b = host.querySelector('[data-key="x:add"]'); if (b) b.focus(); }, { ghost: true })])]);
    el.addEventListener("submit", function (e) {
      e.preventDefault(); var v = {}; Object.keys(f).forEach(function (k) { v[k] = f[k].value; f[k].removeAttribute("aria-invalid"); });
      var r = readForm(v); if (r.error) { err.textContent = r.error; err.hidden = false; f[r.field].setAttribute("aria-invalid", "true"); f[r.field].focus(); return; }
      err.hidden = true; var key = S.form.key, done = false; if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
      U.run(S, env, "extras", "add the extra", async function () { await B().extras.add(env.q, r.item, key); done = true; S.form = null; return "Added: " + title(r.item) + "."; })
        .then(function () { S.sig = ""; again(); var b = host.querySelector(done ? '[data-key="x:add"]' : '[data-key="x:f:what"]'); if (b) try { b.focus({ preventScroll: true }); } catch (x) {} });
    });
    return el;
  }
  api.card = card;

  /* ---------------- Wrap-up: "Extras to decide" ---------------- */
  global.HelmWrapDo.register("extras", function block(host, env) {
    var d = env.data && env.data.extras; if (!d || d === "err" || !d.items) return false;
    var live = split(d.items).live; if (!live.length) { clear(host); return false; }
    var S = U.state(host, function () { block(host, env); }), off = U.busy(env.q + ":extras");
    U.draw(S, host, JSON.stringify([live, d.can_decide, off]), function (n) {
      n.appendChild(h("ul", { cls: "hwd-list" }, live.map(function (x) {
        var acts = h("span", { cls: "hwd-acts", role: "group", "aria-label": title(x) });
        ["bill", "our_cost"].forEach(function (k) {
          if (!d.can_decide) return; var on = x.decision === k, b = btn(DEC[k], "x:" + k + ":" + x.id, function () {
            U.run(S, env, "extras", "save the mark", async function () { var r = await B().extras.decide(x.id, on ? null : k); return r && r.changed === false ? { type: "err", text: "This changed meanwhile - the new state is shown." } : title(x) + (on ? ": not decided." : ": " + DEC[k].toLowerCase() + ". The bill is not changed."); }); }, { main: on, ghost: !on, off: off });
          b.setAttribute("aria-pressed", String(on)); acts.appendChild(b);
        });
        return h("li", { cls: "hwd-row" }, [h("span", { cls: "hwd-main" }, [h("b", { text: title(x) }), h("small", { text: line(env.ctx, x) })]), x.decision && !d.can_decide ? h("span", { cls: "hwd-pill is-left", text: DEC[x.decision] }) : !x.decision ? h("span", { cls: "hwd-pill is-arrived", text: "To decide" }) : null, d.can_decide ? acts : null]);
      })));
      n.appendChild(h("p", { cls: "hwd-why", text: "A mark for the people who do the money. Nothing is added to the bill by itself." + (d.can_decide ? "" : " Marking needs Budget - Can change.") }));
    });
    return true;
  });
})(typeof window !== "undefined" ? window : globalThis);

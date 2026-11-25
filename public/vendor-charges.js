/* vendor-charges.js - R261 (owner: "missing or damaged items pay for vendors is also not there ... to keep perfect track of P and L"): what a vendor charges
 * for their missing / broken items (0450), the same block on Wrap-up > Vendors, Teardown, Settlement and the vendor's request card:
 *   HelmVendorCharges.paint(host, { quoteId, bookingId, vendor, items, onDone })   the charges of one booking + "Charge from the vendor"
 *   HelmVendorCharges.total(state, bookingId)   { agreed, asked, n } for a line of text
 * Asked = not agreed yet (expected cost). Agreed = one vendor bill of its own (paid on the Vendor bills card). Already in their invoice = no bill, never
 * counted twice. Taken back keeps the row, with the reason. Hidden without the right to see money or on a database without 0450. Prices carry data-money.
 * DOM calls only (textContent). Tests: test/r261-b.test.mjs. */
(function (global) {
  "use strict";
  var doc = global.document, WORD = { asked: "Asked, not agreed yet", agreed: "Agreed", in_invoice: "Already in their invoice", "void": "Taken back" };
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmtQ(v) { return String(Math.round(num(v) * 100) / 100); }
  function rowsOf(st, bid) { return ((st && st.rows) || []).filter(function (r) { return r && r.booking === bid; }); }
  function total(st, bid) { var t = { agreed: 0, asked: 0, paid: 0, n: 0 }; rowsOf(st, bid).forEach(function (r) { if (r.state === "agreed") { t.agreed += num(r.amount); t.paid += num(r.paid); t.n++; } else if (r.state === "asked") { t.asked += num(r.amount); t.n++; } }); return t; }
  // what was missing / broken, as a first suggestion for the form: [{ label, qty }]
  function suggest(problems) { var by = {}, out = []; (problems || []).forEach(function (p) { var q = num(p && p.missing) + num(p && p.damaged); if (!p || !p.label || !(q > 0)) return; if (!by[p.label]) { by[p.label] = { label: p.label, qty: 0, note: "" }; out.push(by[p.label]); } by[p.label].qty += q; if (p.note && !by[p.label].note) by[p.label].note = p.note; }); return out; }
  // the typed amount -> number, NaN = wrong
  function amount(v) { var t = String(v == null ? "" : v).replace(/[\s,₹]/g, ""); return /^\d{1,10}(\.\d{1,2})?$/.test(t) && Number(t) > 0 ? Number(t) : NaN; }
  function check(f) {
    if (!String(f.label || "").trim()) return { error: "Say what is missing or broken.", field: "label" };
    if (/[<>]/.test(String(f.label) + String(f.note || ""))) return { error: "Leave out < and >.", field: /[<>]/.test(f.label) ? "label" : "note" };
    var q = String(f.qty == null ? "" : f.qty).trim(); if (q && !(Number(q) > 0)) return { error: "How many? Use a number above 0, or leave it empty.", field: "qty" };
    var a = amount(f.amount); if (isNaN(a)) return { error: "Enter the amount they charge, for example 500.", field: "amount" };
    if (!WORD[f.state] || f.state === "void") return { error: "Choose whether you agreed.", field: "state" };
    return { row: { label: String(f.label).replace(/\s+/g, " ").trim().slice(0, 120), qty: q ? Number(q) : null, amount: a, note: String(f.note || "").replace(/\s+/g, " ").trim().slice(0, 300) || null, state: f.state } };
  }
  var api = global.HelmVendorCharges = { _pure: { total: total, suggest: suggest, amount: amount, check: check }, total: total, WORD: WORD };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!doc || !doc.createElement) return;

  function S() { return global.BPStore; }
  function h(t, at, kids) { var e = doc.createElement(t); Object.keys(at || {}).forEach(function (k) { var v = at[k]; if (v == null || v === false) return; if (k === "text") e.textContent = v; else if (k === "cls") e.className = v; else if (k === "on") e.addEventListener("click", v); else e.setAttribute(k, v === true ? "" : v); }); (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); }); return e; }
  function toast(m, t) { try { global.BPUI.toast(m, { type: t || "ok" }); } catch (e) {} }
  function friendly(e, a) { if (e && /^r450_/.test(String(e.hint || "")) && e.message) return e.message; try { return global.BPUI.friendlyError(e, { action: a }); } catch (x) { return (e && e.message) || "Something went wrong."; } }
  function money(n, cur) { try { return S().moneyIn(num(n), cur || S().studioCurrency()); } catch (e) { return String(num(n)); } }
  function css() { if (doc.querySelector('link[href*="vendor-charges.css"]')) return; doc.head.appendChild(h("link", { rel: "stylesheet", href: "/vendor-charges.css?v=1" })); }
  var uid = 0;

  // one block: lines + the button / the form. Never throws; empty (hidden) when there is nothing to say
  api.paint = function (host, o) {
    if (!host || !S() || !S().vendorCharges) { if (host) host.hidden = true; return Promise.resolve(null); }
    css(); host.classList.add("hvc"); host._o = o;
    return S().vendorCharges.get(o.quoteId, o.fresh ? 0 : 8000).then(function (st) { if (host._o === o) draw(host, o, st); return st; }, function () { if (!host.firstChild) host.hidden = true; return null; });
  };
  function draw(host, o, st) {
    var rows = rowsOf(st, o.bookingId), can = !!(st && st.can_edit), open = host._form;
    while (host.firstChild) host.removeChild(host.firstChild);
    if (o.add === false && !rows.length && !open) can = false;
    host.hidden = !st || (!rows.length && !can); if (host.hidden) return;
    var say = function (nst, text) { toast(text); host._form = null; draw(host, o, nst); try { doc.dispatchEvent(new global.CustomEvent("helm:vendor-charges", { detail: { quote: o.quoteId } })); } catch (e) {} if (o.onDone) o.onDone(nst); };
    if (rows.length) {
      host.appendChild(h("p", { cls: "hvc-h", text: "Charged for missing or broken items" }));
      var ul = h("ul", { cls: "hvc-list" });
      rows.forEach(function (r) {
        var off = r.state === "void", li = h("li", { cls: "hvc-row" + (off ? " is-off" : "") }, [h("span", { cls: "hvc-main" }, [h("b", { text: r.label + (r.qty ? " ×" + fmtQ(r.qty) : "") }), h("small", { text: [r.note, r.state === "void" ? "taken back: " + (r.reason || "") : "", r.by ? "by " + r.by : ""].filter(Boolean).join(" · ") })]),
          h("b", { cls: "hvc-amt", "data-money": "", text: money(r.amount, st.currency) }), h("span", { cls: "hvc-pill is-" + r.state, text: r.state === "agreed" && num(r.paid) >= num(r.amount) - 0.005 ? "Paid" : r.state === "agreed" && num(r.paid) > 0 ? "Part paid" : WORD[r.state] || r.state })]);
        if (can && !off) {
          var acts = h("span", { cls: "hvc-acts" }), go = function (to, text) { return function (e) { move(e.currentTarget, host, o, r, to, null, text, say); }; };
          if (r.state !== "agreed") acts.appendChild(h("button", { type: "button", cls: "hvc-btn is-main", text: "Agree", "aria-label": "Agree to pay for " + r.label, on: go("agreed", "Agreed. It is a vendor bill now - record the payment there.") }));
          if (r.state === "asked") acts.appendChild(h("button", { type: "button", cls: "hvc-btn", text: "It is in their invoice", "aria-label": r.label + ": it is in their invoice", on: go("in_invoice", "Kept. It is not counted a second time.") }));
          if (!(num(r.paid) > 0)) acts.appendChild(h("button", { type: "button", cls: "hvc-btn is-quiet", text: "Take back", "aria-label": "Take back the charge for " + r.label, on: function (e) { var b = e.currentTarget; ask(r).then(function (why) { if (why) move(b, host, o, r, "void", why, "Taken back. It is kept on record.", say); }); } }));
          if (r.state === "agreed" && num(r.paid) < num(r.amount) - 0.005) acts.appendChild(h("a", { cls: "hvc-btn", href: "settlement.html?quote=" + encodeURIComponent(o.quoteId) + "#vendorBills", text: "Pay it" }));
          li.appendChild(acts);
        }
        ul.appendChild(li);
      });
      host.appendChild(ul);
    }
    if (!can) return;
    if (!open) { host.appendChild(h("button", { type: "button", cls: "hvc-btn hvc-add", text: "+ Charge from the vendor", "aria-label": "Add what " + (o.vendor || "the vendor") + " charges for missing or broken items", on: function () { var g = suggest(o.items)[0] || { label: "", qty: "", note: "" }; host._form = { label: g.label, qty: g.qty ? fmtQ(g.qty) : "", amount: "", note: g.note || "", state: "", key: S().vendorCharges.newKey() }; draw(host, o, st); var f = host.querySelector(host._form.label ? '[name="amount"]' : '[name="label"]'); if (f) f.focus(); } })); return; }
    host.appendChild(form(host, o, st, open, say));
  }
  function fld(label, input, cls) { input.id = "hvc" + (++uid); return h("div", { cls: "hvc-f" + (cls ? " " + cls : "") }, [h("label", { "for": input.id, text: label }), input]); }
  function form(host, o, st, f, say) {
    var mk = function (name, at) { var i = h("input", Object.assign({ cls: "hvc-in", name: name, autocomplete: "off", value: f[name] }, at)); i.addEventListener("input", function () { f[name] = i.value; }); return i; };
    var label = mk("label", { maxlength: "120", placeholder: "e.g. Round table" }), qty = mk("qty", { inputmode: "decimal", maxlength: "9", placeholder: "Optional" }), amt = mk("amount", { inputmode: "decimal", maxlength: "14", placeholder: "e.g. 500" }), note = mk("note", { maxlength: "300", placeholder: "e.g. leg broken, they charge for a new one" });
    var sel = h("select", { cls: "hvc-in", name: "state" }, [["", "Choose"], ["agreed", "Yes, we agreed - pay it"], ["asked", "Not yet - they asked"], ["in_invoice", "It is already in their invoice"]].map(function (x) { return h("option", { value: x[0], text: x[1] }); })); sel.value = f.state; sel.addEventListener("change", function () { f.state = sel.value; });
    var cur = ""; try { cur = S().currencySymbol ? S().currencySymbol(st.currency) : ""; } catch (e) {} if (!cur) cur = !st.currency || st.currency === "INR" ? "₹" : st.currency;
    var err = h("p", { cls: "hvc-err", role: "alert", hidden: true }), save = h("button", { type: "submit", cls: "hvc-btn is-main", text: "Save the charge" });
    var el = h("form", { cls: "hvc-form", novalidate: true, "aria-label": "Charge from " + (o.vendor || "the vendor") }, [h("div", { cls: "hvc-g" }, [fld("What is missing or broken?", label, "is-wide"), fld("How many", qty), fld("They charge (" + cur + ")", amt), fld("Did you agree?", sel), fld("Note", note, "is-wide")]), err,
      h("span", { cls: "hvc-acts" }, [save, h("button", { type: "button", cls: "hvc-btn is-quiet", text: "Cancel", on: function () { host._form = null; draw(host, o, st); } })])]);
    var at = { label: label, qty: qty, amount: amt, note: note, state: sel };
    el.addEventListener("submit", function (e) {
      e.preventDefault(); if (save.disabled) return; var c = check(f);
      if (c.error) { err.textContent = c.error; err.hidden = false; if (at[c.field]) at[c.field].focus(); return; }
      save.disabled = true; err.hidden = true;
      S().vendorCharges.add(o.quoteId, Object.assign({ booking: o.bookingId }, c.row), f.key).then(function (r) { say(r && r.state, c.row.state === "agreed" ? "Saved. It is a vendor bill now - record the payment on Payments & invoice." : c.row.state === "asked" ? "Saved. It counts as expected until you agree." : "Saved. It is not counted a second time."); },
        function (x) { save.disabled = false; err.textContent = friendly(x, "save the charge"); err.hidden = false; });
    });
    return el;
  }
  function ask(r) { try { return Promise.resolve(global.BPUI.prompt("Why is the charge for " + r.label + " taken back? It stays on record.", { title: "Take the charge back?", label: "Reason", maxLength: 300, required: true })).then(function (v) { v = String(v || "").replace(/\s+/g, " ").trim(); if (!v) return ""; if (v.length < 3 || /[<>]/.test(v)) { toast("Say why in at least 3 characters, without < and >.", "err"); return ""; } return v; }); } catch (e) { return Promise.resolve(""); } }
  function move(b, host, o, r, to, why, text, say) {
    if (b.disabled) return; b.disabled = true;
    S().vendorCharges.set(o.quoteId, r.id, r.state, to, why).then(function (x) { if (x && x.changed) { toast("This changed meanwhile - nothing was saved. The new state is shown.", "err"); draw(host, o, x.state); return; } say(x && x.state, text); },
      function (e) { b.disabled = false; toast(friendly(e, "change the charge"), "err"); });
  }
})(typeof window !== "undefined" ? window : globalThis);

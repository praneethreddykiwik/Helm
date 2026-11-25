/* vendor-items.js - R260 (owner, 25 Nov 2026: "On Pre-event: vendor check-in items and all; check-out on the Wrap-up"): the items of the booked vendors,
 * the same on Tasks & Crew and the Event-day monitor. Loaded after event-wrap.js, which draws the Vendors card and Wrap-up > Vendors and calls:
 *
 *   HelmVendorItems.preList(n, S, env, rows, p, V)   Vendors card: one card per vendor - arrived / did not come, then CHECK IN ITEMS
 *   HelmVendorItems.out(S, env, r, p, ret)           Wrap-up > Vendors: CHECK OUT ITEMS of one booking (null = nothing to check out)
 *   HelmVendorItems.load(q, maxAge) / get(q) / sum   one read per event (event_vendor_items_get), kept for a few seconds and shared by every card
 *   HelmVendorItems.lines(quoteId, root)             money pages: under every element with data-vi="<booking id>" the line "Items: 1 missing on arrival,
 *                                                    1 broken at return" with the notes (read only; nothing when there is nothing to say)
 * The database (0448) keeps every answer as one new row with who and when; Undo is a row too; it works out what is missing, asks for a note and refuses
 * what somebody else changed meanwhile. Stock, bookings, costs and bills are never touched. Vendor items are "checked in / out"; our own stock stays
 * "given out / back". A database without 0448 (or no right to see it) = null: the pages stay as they were. DOM calls only. Tests: test/r260.test.mjs. */
(function (global) {
  "use strict";
  var doc = global.document, NOTE_MAX = 300;
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(v) { return String(Math.round(num(v) * 100) / 100); }
  function pl(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }

  /* ---------------- pure ---------------- */
  function came(it) { return it && it["in"] ? num(it["in"].ok) + num(it["in"].damaged) : null; }
  // how many can go back: what came in; not checked in = what was expected
  function base(it) { var c = came(it); return c == null ? num(it && it.expected) : c; }
  function live(v) { return !!(v && v.items && v.status !== "cancelled" && v.arrival !== "no_show"); }
  function unitOf(it) { return it && it.unit ? " " + it.unit : ""; }
  // "Got 10 of 12, 1 damaged, 1 missing" / "12 came in, 11 back, 1 broken"
  function words(it, phase) {
    var r = it && it[phase]; if (!r) return phase === "in" ? "Expected " + fmt(it && it.expected) + unitOf(it) : came(it) == null ? "Not checked in (expected " + fmt(it && it.expected) + unitOf(it) + ")" : fmt(came(it)) + unitOf(it) + " came in";
    if (phase === "in") return "Got " + fmt(num(r.ok) + num(r.damaged)) + " of " + fmt(r.expected) + unitOf(it) + (num(r.damaged) ? ", " + fmt(r.damaged) + " damaged" : "") + (num(r.missing) ? ", " + fmt(r.missing) + " missing" : "");
    return fmt(r.expected) + unitOf(it) + (it["in"] ? " came in, " : " expected, ") + fmt(r.ok) + " back" + (num(r.damaged) ? ", " + fmt(r.damaged) + " broken" : "") + (num(r.missing) ? ", " + fmt(r.missing) + " not returned" : "");
  }
  function pill(it, phase) {
    var r = it[phase]; if (!r) return ["expected", phase === "in" ? "Not in yet" : "Not back yet"];
    if (r.state === "ok") return ["ok", phase === "in" ? "In" : "Back"];
    return ["no_show", r.state === "missing" ? fmt(r.missing) + (phase === "in" ? " missing" : " not returned") : fmt(r.damaged) + (phase === "in" ? " damaged" : " broken")];
  }
  // what one person types -> { ok, damaged, missing, error, note (a note is needed) }
  function count(b, okV, dmgV, phase) {
    var rd = function (v) { var s = String(v == null ? "" : v).trim().replace(",", "."); if (s === "") return 0; return /^\d{1,9}(\.\d{1,2})?$/.test(s) ? Number(s) : NaN; }, ok = rd(okV), d = rd(dmgV), t;
    if (isNaN(ok) || isNaN(d)) return { error: "Use numbers of 0 or more." }; t = Math.round((ok + d) * 100) / 100;
    if (phase === "out" && t > b) return { error: "Only " + fmt(b) + " came in." };
    if (phase === "in" && t > b * 10) return { error: "That is far more than the " + fmt(b) + " expected. Check the number." };
    var m = Math.max(Math.round((b - t) * 100) / 100, 0); return { ok: ok, damaged: d, missing: m, note: m > 0 || d > 0 };
  }
  function inCount(v) { var l = (v && v.items) || [], r = { total: l.length, done: 0, missing: 0, damaged: 0 }; l.forEach(function (it) { if (!it["in"]) return; r.done++; r.missing += num(it["in"].missing); r.damaged += num(it["in"].damaged); }); return r; }
  // Wrap-up counts an item once somebody checked it in (or out) - a studio that does not use this is never asked for it
  function outItems(v) { return live(v) ? v.items.filter(function (it) { return it.out || (it["in"] && came(it) > 0); }) : []; }
  // of one event: { total, done, missing, damaged, open [{ name, done, total }], outTotal, outDone } or null (not read / no list here)
  function sumOf(st) {
    if (!st || !st.vendors || !st.full) return null; var r = { total: 0, done: 0, missing: 0, damaged: 0, open: [], outTotal: 0, outDone: 0 }, by = {};
    Object.keys(st.vendors).forEach(function (id) {
      var v = st.vendors[id]; if (!live(v)) return; var c = inCount(v), o = outItems(v); r.total += c.total; r.done += c.done; r.missing += c.missing; r.damaged += c.damaged; r.outTotal += o.length; r.outDone += o.filter(function (it) { return it.out; }).length;
      if (c.total && v.status !== "delivered") { var k = v.vendor_id || id, g = by[k] || (by[k] = { name: v.vendor || v.label || "Vendor", done: 0, total: 0 }); g.done += c.done; g.total += c.total; }
    });
    r.open = Object.keys(by).map(function (k) { return by[k]; }).filter(function (g) { return g.done < g.total; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    return r;
  }
  function bad(s) { return [s.missing ? fmt(s.missing) + " missing" : "", s.damaged ? fmt(s.damaged) + " damaged" : ""].filter(Boolean).join(", "); }
  // "8 of 10 items in, 1 missing" ("" = no lists)
  function inLine(s) { return !s || !s.total ? "" : s.done + " of " + pl(s.total, "item") + " in" + (bad(s) ? ", " + bad(s) : ""); }
  function openWords(s) { return s ? s.open.map(function (g) { return g.name + " (" + g.done + " of " + g.total + " in)"; }) : []; }
  // one vendor's problems -> { text: "Items: 1 missing on arrival, 1 broken at return", notes: [...] } or null
  function problemLine(list) {
    var n = { im: 0, id: 0, om: 0, od: 0 }, some = [], notes = [];
    (list || []).forEach(function (p) { if (!p) return; var i = p.phase !== "out";
      if (p.missing == null && p.damaged == null) some.push(p.state === "missing" ? "some missing on arrival" : "a problem on arrival"); else { n[i ? "im" : "om"] += num(p.missing); n[i ? "id" : "od"] += num(p.damaged); }
      if (p.note) notes.push((p.label ? p.label + ", " : "") + (i ? "on arrival" : "at return") + ": " + p.note); });
    var a = [n.im ? fmt(n.im) + " missing on arrival" : "", n.id ? fmt(n.id) + " damaged on arrival" : ""].concat(some, [n.om ? fmt(n.om) + " not returned" : "", n.od ? fmt(n.od) + " broken at return" : ""]).filter(Boolean);
    return a.length ? { text: "Items: " + a.join(", "), notes: notes } : null;
  }
  // for "Notes from the day"
  function notes(st) {
    var out = []; if (!st || !st.vendors || !st.full) return out;
    Object.keys(st.vendors).forEach(function (id) { var v = st.vendors[id]; (v.problems || []).forEach(function (p) { var l = problemLine([Object.assign({}, p, { note: "" })]); if (l) out.push({ at: p.at, kind: "Vendor", text: (v.vendor || "Vendor") + ": " + (p.label ? p.label + " - " : "") + l.text.replace(/^Items: /, "") + (p.note ? " - " + p.note : ""), who: p.by || "" }); }); });
    return out;
  }
  var pure = { came: came, base: base, words: words, pill: pill, count: count, inCount: inCount, outItems: outItems, sumOf: sumOf, inLine: inLine, openWords: openWords, problemLine: problemLine, notes: notes };
  var api = global.HelmVendorItems = { _pure: pure };
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  /* ---------------- the one read ---------------- */
  var C = {};
  function store() { return global.BPStore && global.BPStore.wrapRecords; }
  function str(x) { try { return JSON.stringify(x || null); } catch (e) { return ""; } }
  // a changed state is told to the page (the "Before guests arrive" card follows)
  function put(q, st) { var was = C[q] ? C[q].st : null; C[q] = { at: Date.now(), st: st || null }; if (doc && doc.dispatchEvent && str(was) !== str(st)) try { doc.dispatchEvent(new global.CustomEvent("helm:vendor-items")); } catch (e) {} }
  // never rejects: the state, null (no 0448 / not allowed), or what was read before when this time failed
  function load(q, maxAge) {
    var c = C[q], W = store(); if (!q || !W || !W.items) return Promise.resolve(null);
    if (c && c.busy) return c.busy; if (c && Date.now() - c.at < (maxAge || 0)) return Promise.resolve(c.st);
    c = C[q] = { at: c ? c.at : 0, st: c ? c.st : null };
    c.busy = Promise.resolve().then(function () { return W.items(q); }).then(function (r) { return r && r.vendors ? r : null; }, function (e) { var k = String((e && e.code) || ""); return k === "42501" || k === "P0002" ? null : c.st; })
      .then(function (st) { if (C[q] === c) put(q, st); return get(q); });
    return c.busy;
  }
  function get(q) { return C[q] ? C[q].st : null; }
  api.load = load; api.get = get; api.put = put; api.sum = function (q) { return sumOf(get(q)); }; api._reset = function () { C = {}; };
  api.inLine = inLine; api.openWords = openWords; api.notes = notes; api.outOpen = function (st) { var s = sumOf(st); return s ? s.outTotal - s.outDone : 0; };
  api.openVendors = function (q) { var s = sumOf(get(q)); return s ? openWords(s) : null; };
  if (!doc || !doc.createElement) return;

  /* ---------------- money pages: what was wrong, read only ---------------- */
  function el(t, c, s) { var e = doc.createElement(t); if (c) e.className = c; if (s != null) e.textContent = s; return e; }
  api.lines = async function (q, root) {
    try {
      var st = await load(String(q || ""), 20000); if (!root) return;
      Array.prototype.forEach.call(root.querySelectorAll("[data-vi]"), function (n) {
        var old = n.querySelector(".vi-line"), v = st && st.vendors && st.vendors[n.getAttribute("data-vi")], l = v && problemLine(v.problems); if (old) n.removeChild(old); if (!l) return;
        var d = el("div", "vi-line efl-note warn"); d.appendChild(el("b", "", l.text)); l.notes.forEach(function (t) { d.appendChild(el("span", "vi-line-n", t)); }); n.appendChild(d);
      });
    } catch (e) {}
  };

  /* ---------------- the event day (needs event-wrap.js) ---------------- */
  var U = global.HelmWrapDo && global.HelmWrapDo._ui; if (!U) return;
  var h = U.h, btn = U.btn;
  var CHANGED = { type: "err", text: "This changed meanwhile - nothing was saved. The new state is shown." }, NOSAVE = { type: "err", text: "That was not saved. Your role may not be allowed to change it." };
  function redo(S) { S.sig = ""; S.repaint(); }
  function focusOn(key) { setTimeout(function () { var n = doc.querySelector('[data-key="' + String(key).replace(/["\\]/g, "") + '"]'); if (n) try { n.focus(); } catch (e) {} }, 40); }
  function blur() { try { if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur(); } catch (e) {} }
  // what the redraw of the host depends on
  api.sig = function (q, S) { return [get(q), S && S.viForm && [S.viForm.k, S.viForm.kind], S && S.viErr]; };
  function ui(S) { S.viVal = S.viVal || {}; S.viOpen = S.viOpen || {}; return S; }
  function stamp(env, r) { return [r.by ? "by " + r.by : "", U.clock(env.ctx, r.at)].filter(Boolean).join(", "); }
  function save(S, env, phase, items, said, V) {
    blur(); var key = store().newKey ? store().newKey() : null; S.viErr = null;
    return U.run(S, env, "vendors", "save it", async function () {
      var r = await store().itemsSet(env.q, phase, items, key); if (r && r.state) put(env.q, r.state);
      if (r && r.changed) return CHANGED; if (!r || !r.ok) return NOSAVE; S.viForm = null; items.forEach(function (i) { delete S.viVal[phase + ":" + i.booking + ":" + i.key]; }); return said;
    }).then(function (ok) { redo(S); if (ok) { if (V && V.ring) V.ring(); else try { doc.dispatchEvent(new global.CustomEvent("helm:vendors")); } catch (e) {} } return ok; });
  }
  function noteBad(t) { return !t ? "Write a short note." : /[<>]/.test(t) ? "Leave out < and >." : ""; }
  function field(label, input, wide) { return h("label", { cls: wide ? "wide" : null }, [label, input]); }
  function numIn(S, k, dv, o) { var i = h("input", Object.assign({ cls: "tc-inp vi-num", type: "text", inputmode: "decimal", maxlength: "12", autocomplete: "off", "data-key": k }, o || {})); i.value = S.viVal[k] != null ? S.viVal[k] : dv; i.addEventListener("input", function () { S.viVal[k] = i.value; }); return i; }
  function formEl(S, label, kids, go) {
    var err = h("p", { cls: "hwd-err", role: "alert", hidden: true });
    var f = h("form", { cls: "hwd-form vi-form", novalidate: true, "aria-label": label }, kids.concat([h("span", { cls: "hwd-acts" }, [h("button", { type: "submit", cls: "tc-btn sm hwd-b is-main", text: "Save" }), btn("Cancel", "vi:cancel:" + S.viForm.k, function () { var k = S.viForm && S.viForm.back; S.viForm = null; blur(); redo(S); if (k) focusOn(k); }, { ghost: true })]), err]));
    f.addEventListener("submit", function (e) { e.preventDefault(); var b = go(); if (b) { err.textContent = b[0]; err.hidden = false; if (b[1]) b[1].focus(); } });
    return f;
  }
  function noteIn(S, ph) { var f = S.viForm, i = h("input", { cls: "tc-inp", type: "text", maxlength: String(NOTE_MAX), autocomplete: "off", "aria-required": "true", "data-key": "vi:note:" + f.k, placeholder: ph }); i.value = f.note || ""; i.addEventListener("input", function () { f.note = i.value; }); return i; }
  function clean(v) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim(); }
  // one item: name + what is known + what can be pressed
  function row(S, env, phase, x, can, off, V) {
    var it = x.it, rec = it[phase], k = phase + ":" + x.id + ":" + it.key, b = phase === "in" ? num(it.expected) : base(it), f = S.viForm && S.viForm.k === k ? S.viForm : null, p = pill(it, phase), nm = it.label;
    var sub = [h("small", { text: words(it, phase) + (rec && stamp(env, rec) ? " · " + stamp(env, rec) : "") })];
    if (phase === "out" && it["in"] && it["in"].state !== "ok") sub.push(h("small", { cls: "vi-was", text: "On arrival: " + words(it, "in").replace(/^Got /, "got ") + (it["in"].note ? " - " + it["in"].note : "") }));
    if (phase === "in" && rec && it.listed && num(rec.expected) !== num(it.expected)) sub.push(h("small", { cls: "vi-was", text: "Booked now: " + fmt(it.expected) + unitOf(it) }));
    var li = h("li", { cls: "vi-row" + (rec ? " is-done" : "") }, [h("span", { cls: "hwd-main" }, [h("b", { text: nm })].concat(sub))]);
    var none = phase === "out" && !rec && b <= 0;
    if (rec || none || !can) li.appendChild(h("span", { cls: "hwd-pill is-" + (none ? "expected" : p[0]), text: none ? "None came" : p[1] }));
    if (rec) {
      if (can && !(phase === "in" && it.out)) li.appendChild(btn("Undo", "vi:undo:" + k, function () { save(S, env, phase, [{ booking: x.id, key: it.key, undo: true, seen: rec.id }], nm + ": undone.", V); }, { ghost: true, off: off, label: "Undo: " + nm + ", " + p[1].toLowerCase() }));
      if (rec.note) li.appendChild(h("p", { cls: "hwd-note vi-note", text: "Note: " + rec.note }));
      return li;
    }
    if (!can || none) return li;
    var send = function (c, note) { return save(S, env, phase, [{ booking: x.id, key: it.key, seen: it[phase + "_seen"] || null, ok: c.ok, damaged: c.damaged, note: note || null }], nm + ": " + (c.missing || c.damaged ? (phase === "in" ? "checked in, " : "checked out, ") + [c.missing ? fmt(c.missing) + (phase === "in" ? " missing" : " not returned") : "", c.damaged ? fmt(c.damaged) + (phase === "in" ? " damaged" : " broken") : ""].filter(Boolean).join(", ") + "." : phase === "in" ? "checked in." : "checked out."), V); };
    var open = function (ok) { S.viErr = null; S.viForm = { k: k, kind: "bad", good: ok, dmg: "", note: "", back: "vi:bad:" + k }; blur(); redo(S); focusOn("vi:good:" + k); };
    if (f) {
      var good = h("input", { cls: "tc-inp vi-num", type: "text", inputmode: "decimal", maxlength: "12", autocomplete: "off", "data-key": "vi:good:" + k }), dm = h("input", { cls: "tc-inp vi-num", type: "text", inputmode: "decimal", maxlength: "12", autocomplete: "off", placeholder: "0", "data-key": "vi:dmg:" + k }), note = noteIn(S, phase === "in" ? "e.g. one box short, they bring it at 6" : "e.g. one leg broken, they will claim");
      var miss = h("p", { cls: "vi-miss", role: "status" }), show = function () { f.good = good.value; f.dmg = dm.value; var c = count(b, good.value, dm.value, phase); miss.textContent = c.error || (c.missing ? fmt(c.missing) + (phase === "in" ? " of " + fmt(b) + " missing" : " of " + fmt(b) + " not returned") : phase === "in" ? "None missing" : "All " + fmt(b) + " handed back"); };
      good.value = f.good == null ? "" : f.good; dm.value = f.dmg || ""; good.addEventListener("input", show); dm.addEventListener("input", show); show();
      li.appendChild(formEl(S, (phase === "in" ? "Missing or damaged on arrival, " : "Not returned or damaged, ") + nm, [field(phase === "in" ? "Arrived fine" : "Handed back fine", good), field("Damaged", dm), miss, field("Note", note, true)], function () {
        var c = count(b, good.value, dm.value, phase), t = clean(note.value); if (c.error) return [c.error, good]; if (c.note && noteBad(t)) return [noteBad(t), note]; if (t && noteBad(t)) return [noteBad(t), note]; f.note = t; send(c, t); return null; }));
      return li;
    }
    var i = numIn(S, k, fmt(b), { "aria-label": (phase === "in" ? "Got, " : "Back, ") + nm }), er = S.viErr && S.viErr.k === k ? S.viErr.t : "";
    var go = function () { var c = count(b, i.value, 0, phase); if (String(i.value).trim() === "") c = { error: "Type how many." }; if (c.error) { S.viErr = { k: k, t: c.error }; blur(); redo(S); focusOn(k); return; } if (c.note) { open(String(i.value).trim()); return; } send(c); };
    i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } });
    li.appendChild(h("span", { cls: "vi-ctl" }, [h("span", { cls: "vi-of" }, [phase === "in" ? "Got " : "Back ", i, " of " + fmt(b)]), btn(phase === "in" ? "Check in" : "Check out", "vi:ok:" + k, go, { main: true, off: off, label: (phase === "in" ? "Check in " : "Check out ") + nm }), btn("Problem", "vi:bad:" + k, function () { open(String(i.value).trim()); }, { ghost: true, off: off, label: (phase === "in" ? "Missing or damaged on arrival: " : "Not returned or damaged: ") + nm })]));
    if (er) li.appendChild(h("p", { cls: "hwd-err", role: "alert", text: er }));
    return li;
  }
  function fold(S, key, title, open) { var d = h("details", { cls: "vi-fold" }, [h("summary", { cls: "hwd-sumline", "data-key": "vi:sum:" + key, text: title })]); d.open = S.viOpen[key] != null ? S.viOpen[key] : !!open; d.addEventListener("toggle", function () { S.viOpen[key] = d.open; }); return d; }
  function bar(done, total) { return h("progress", { max: String(total), value: String(done), "aria-hidden": "true" }); }

  // what came: list, all in one press, added items - of one vendor (one or more bookings)
  function inPart(S, env, g, st, can, off, V, closedList) {
    var xs = [], rowsNo = []; g.rows.forEach(function (r) { var v = st.vendors[r.id]; if (!v) return; if (!v.items.length) rowsNo.push(r); v.items.forEach(function (it) { xs.push({ id: r.id, it: it }); }); });
    var box = h("div", { cls: "hwd-ret vi" }), open = xs.filter(function (x) { return !x.it["in"]; }), c = { total: xs.length, done: xs.length - open.length, missing: 0, damaged: 0 }; xs.forEach(function (x) { var r = x.it["in"]; if (r) { c.missing += num(r.missing); c.damaged += num(r.damaged); } });
    if (!xs.length || rowsNo.some(function (r) { return st.vendors[r.id].all; })) rowsNo.forEach(function (r) { if (!xs.length || st.vendors[r.id].all) askAll(S, env, box, r, st.vendors[r.id], g, can, off, V); });
    if (xs.length) {
      var into = box, adding = S.viForm && S.viForm.kind === "add" && S.viForm.k === "add:" + g.key, busyForm = S.viForm && S.viForm.k.indexOf("in:") === 0 && xs.some(function (x) { return S.viForm.k === "in:" + x.id + ":" + x.it.key; });
      if ((closedList || !open.length) && !busyForm) { into = fold(S, "in:" + g.key, "Items: " + inLine(c), !!adding); box.appendChild(into); }
      else { box.appendChild(h("div", { cls: "vi-head" }, [h("p", { cls: "hwd-q" }, ["Check in items", h("span", { cls: "vi-n", text: inLine(c) })]), bar(c.done, c.total),
        can && open.length > 1 ? btn("All items arrived", "vi:all:" + g.key, function () { save(S, env, "in", open.map(function (x) { return { booking: x.id, key: x.it.key, seen: x.it.in_seen || null, ok: num(x.it.expected), damaged: 0 }; }), g.name + ": all " + pl(open.length, "item") + " checked in.", V); }, { main: true, off: off, label: "All items of " + g.name + " arrived (" + open.length + ")" }) : null])); }
      into.appendChild(h("ul", { cls: "vi-list" }, xs.map(function (x) { return row(S, env, "in", x, can, off, V); })));
    }
    if (can) (xs.length && !open.length && into && into !== box ? into : box).appendChild(addPart(S, env, g, off, V));
    return box;
  }
  // a vendor without a list
  function askAll(S, env, box, r, v, g, can, off, V) {
    var a = v.all, W = { ok: "All arrived", missing: "Some missing", damaged: "With a problem" }, k = "all:" + r.id, f = S.viForm && S.viForm.k === k ? S.viForm : null;
    box.appendChild(h("p", { cls: "hwd-q", text: "All their items arrived?" + (g.rows.length > 1 ? " (" + r.label + ")" : "") }));
    if (a) {
      box.appendChild(h("div", { cls: "hwd-ans" }, [h("span", { cls: "hwd-pill is-" + (a.state === "ok" ? "ok" : "no_show"), text: W[a.state] }), h("small", { text: stamp(env, a) }), can ? btn("Undo", "vi:undo:" + k, function () { save(S, env, "in", [{ booking: r.id, key: "*", undo: true, seen: a.id }], g.name + ": undone.", V); }, { ghost: true, off: off, label: "Undo: " + W[a.state].toLowerCase() + ", " + g.name }) : null]));
      if (a.note) box.appendChild(h("p", { cls: "hwd-note", text: "Note: " + a.note })); return;
    }
    if (!can) { box.appendChild(h("p", { cls: "hwd-why", text: "Not answered yet." })); return; }
    var set = function (ans, note) { return save(S, env, "in", [{ booking: r.id, key: "*", seen: v.all_seen || null, answer: ans, note: note || null }], g.name + ": " + W[ans].toLowerCase() + ".", V); };
    box.appendChild(h("span", { cls: "hwd-acts" }, [btn("Yes", "vi:yes:" + k, function () { set("ok"); }, { main: true, off: off, label: "All items of " + g.name + " arrived" })].concat([["missing", "Some missing"], ["damaged", "With a problem"]].map(function (o) {
      var b = btn(o[1], "vi:" + o[0] + ":" + k, function () { S.viForm = f && f.kind === o[0] ? null : { k: k, kind: o[0], note: f ? f.note : "", back: "vi:" + o[0] + ":" + k }; redo(S); if (S.viForm) focusOn("vi:note:" + k); }, { off: off, label: o[1] + ", " + g.name }); b.setAttribute("aria-expanded", String(!!(f && f.kind === o[0]))); return b; }))));
    if (f) { var note = noteIn(S, f.kind === "missing" ? "e.g. 2 speakers come at 6" : "e.g. one screen is scratched"); box.appendChild(formEl(S, W[f.kind] + ", " + g.name, [field(f.kind === "missing" ? "What is missing?" : "What is wrong?", note, true)], function () { var t = clean(note.value), b = noteBad(t); if (b) return [b, note]; f.note = t; set(f.kind, t); return null; })); }
  }
  function addPart(S, env, g, off, V) {
    var k = "add:" + g.key, f = S.viForm && S.viForm.k === k ? S.viForm : null;
    if (!f) return h("div", { cls: "hwd-foot" }, [btn("+ Add an item", "vi:add:" + k, function () { S.viForm = { k: k, kind: "add", name: "", qty: "", back: "vi:add:" + k }; redo(S); focusOn("vi:name:" + k); }, { ghost: true, off: off, label: "Add an item that is not listed, " + g.name })]);
    var nm = h("input", { cls: "tc-inp", type: "text", maxlength: "120", autocomplete: "off", "data-key": "vi:name:" + k, placeholder: "e.g. Extension boards" }), q = h("input", { cls: "tc-inp vi-num", type: "text", inputmode: "decimal", maxlength: "10", autocomplete: "off", "data-key": "vi:qty:" + k });
    nm.value = f.name || ""; q.value = f.qty || ""; nm.addEventListener("input", function () { f.name = nm.value; }); q.addEventListener("input", function () { f.qty = q.value; });
    return formEl(S, "Add an item, " + g.name, [field("What came?", nm, true), field("How many?", q), h("small", { text: "It is saved as arrived." })], function () {
      var t = clean(nm.value), n = String(q.value).trim().replace(",", "."); if (!t) return ["Write what came.", nm]; if (/[<>]/.test(t)) return ["Leave out < and >.", nm]; if (!/^\d{1,7}(\.\d{1,2})?$/.test(n) || !(Number(n) > 0)) return ["How many came? Use a number above 0.", q];
      save(S, env, "in", [{ booking: g.rows[0].id, label: t, qty: Number(n) }], t + ": added and checked in.", V); return null; });
  }

  // the Vendors card: one card per vendor
  function groups(rows, st) {
    var by = {}, out = []; rows.forEach(function (r) { var v = st.vendors[r.id], k = r.vendor || r.id, g = by[k]; if (!g) { g = by[k] = { key: k, name: (v && v.vendor) || r.label, rows: [] }; out.push(g); } g.rows.push(r); });
    return out;
  }
  function moveAll(S, env, g, rows, to, V) {
    return U.run(S, env, "vendors", "update the vendor", async function () { var m = null; for (var i = 0; i < rows.length; i++) { m = await V.move(env, rows[i], to); if (m && m.type === "err") return m; } return rows.length === 1 ? m : g.name + ": " + V.WORD[to].toLowerCase() + "."; }).then(V.ring);
  }
  function moveBtns(S, env, g, rows, p, off, V, what) {
    var acts = h("span", { cls: "hwd-acts" }); if (p.command) V.moves(rows[0]).forEach(function (m) { acts.appendChild(btn(m[1], "v:" + m[0] + ":" + rows[0].id, function () { moveAll(S, env, g, rows, m[0], V); }, { main: m[2], ghost: !m[2], off: off, label: (m[1] === "Undo" ? "Undo: " + V.WORD[rows[0].state].toLowerCase() : m[1]) + ", " + what })); }); return acts;
  }
  function when(env, r, V) { var t = r.at && r.state !== "expected" ? U.clock(env.ctx, r.at) : ""; return (r.arrivedAt ? "Arrived " + U.clock(env.ctx, r.arrivedAt) + " · " : "") + (r.arrivedAt ? V.WORD[r.state].toLowerCase() : V.WORD[r.state]) + (t ? " " + t : "") + (r.exited ? " · all returned" : r.status === "booked" ? " · not confirmed" : ""); }
  api.preList = function (n, S, env, rows, p, V) {
    var st = get(env.q); if (!st) return false; ui(S); var off = U.busy(env.q + ":vendors"), can = !!(st.can_edit && p.command), gs = groups(rows, st), ul = h("ul", { cls: "hwd-cards vi-cards" }), onday = env.ctx && env.ctx.win === "onday", s = sumOf(st);
    if (s && s.total) n.appendChild(h("div", { cls: "vi-top" }, [h("b", { text: inLine(s) }), bar(s.done, s.total)]));
    gs.forEach(function (g) {
      var one = g.rows.every(function (r) { return r.state === g.rows[0].state && r.exited === g.rows[0].exited; }), r0 = g.rows[0], labels = g.rows.map(function (r) { return r.label; }).filter(function (l, i, a) { return l !== g.name && a.indexOf(l) === i; }).join(", ");
      var card = h("li", { cls: "hwd-vc", "aria-label": g.name }, [h("div", { cls: "hwd-vh" }, [h("span", { cls: "hwd-main" }, [h("b", { text: g.name }), labels ? h("small", { text: labels }) : null]), one ? h("span", { cls: "hwd-pill is-" + r0.state, text: V.WORD[r0.state] }) : null])]);
      if (one) card.appendChild(h("div", { cls: "hwd-came" }, [h("small", { cls: "vi-when", text: when(env, r0, V) }), moveBtns(S, env, g, g.rows, p, off, V, g.name)]));
      else card.appendChild(h("ul", { cls: "hwd-list" }, g.rows.map(function (r) { return h("li", { cls: "hwd-row" }, [h("span", { cls: "hwd-main" }, [h("b", { text: r.label }), h("small", { text: when(env, r, V) })]), h("span", { cls: "hwd-pill is-" + r.state, text: V.WORD[r.state] }), moveBtns(S, env, g, [r], p, off, V, r.label + ", " + g.name)]); })));
      var here = { key: g.key, name: g.name, rows: g.rows.filter(function (r) { var v = st.vendors[r.id]; return v && (r.state === "arrived" || r.state === "left" || (r.state !== "no_show" && (v.all || v.items.some(function (it) { return it["in"]; })))); }) };
      if (here.rows.length) card.appendChild(inPart(S, env, here, st, can, off, V, onday));
      else {
        var todo = []; g.rows.forEach(function (r) { var v = st.vendors[r.id]; if (r.state === "expected" && v) todo = todo.concat(v.items); });
        if (todo.length) { var d = fold(S, "wait:" + g.key, pl(todo.length, "item") + " to check in when they arrive"); d.appendChild(h("ul", { cls: "vi-list" }, todo.map(function (it) { return h("li", { cls: "vi-row" }, [h("span", { cls: "hwd-main" }, [h("b", { text: it.label }), h("small", { text: words(it, "in") })])]); }))); card.appendChild(d); }
      }
      ul.appendChild(card);
    });
    n.appendChild(ul);
    if (st.closed) n.appendChild(h("p", { cls: "hwd-why", text: "This event is closed - the items can be seen, not changed." }));
    else if (!p.command) n.appendChild(h("p", { cls: "hwd-why", text: "Your role can see this, not change it (Event-day command - Can change)." }));
    return true;
  };

  // Wrap-up: what goes back with this vendor. ret = the answer that is shown (0444 or worked out)
  api.out = function (S, env, r, p, ret, V) {
    var st = get(env.q), v = st && st.full && st.vendors[r.id]; if (!v || !v.items) return null; ui(S);
    var list = v.items.filter(function (it) { return it.out || it["in"] || r.state === "arrived" || r.state === "left"; }); if (!list.length) return null;
    var can = !!(st.can_edit && p.command), off = U.busy(env.q + ":vendors"), xs = list.map(function (it) { return { id: r.id, it: it }; }), due = xs.filter(function (x) { return x.it.out || base(x.it) > 0; }), open = due.filter(function (x) { return !x.it.out; }), done = due.length - open.length, nm = v.vendor || r.label;
    if (!due.length && !xs.some(function (x) { return x.it["in"]; })) return null;
    var line = done + " of " + pl(due.length, "item") + " checked out", key = "out:" + r.id, mine = S.viForm && S.viForm.k.indexOf("out:" + r.id) === 0, box = h("div", { cls: "vi" }), into = box;
    if (((ret && !ret.items) || !open.length) && !mine) { into = fold(S, key, "Rented from them: " + line, xs.some(function (x) { return x.it.out && x.it.out.state !== "ok"; })); box.appendChild(into); }
    else box.appendChild(h("div", { cls: "vi-head" }, [h("p", { cls: "hwd-q" }, ["Check out items (rented from them)", h("span", { cls: "vi-n", text: line })]), bar(done, due.length),
      can && open.length > 1 ? btn("All handed back", "vi:all:" + key, function () { save(S, env, "out", open.map(function (x) { return { booking: x.id, key: x.it.key, seen: x.it.out_seen || null, ok: base(x.it), damaged: 0 }; }), nm + ": all " + pl(open.length, "item") + " handed back."); }, { main: true, off: off, label: "All items of " + nm + " handed back (" + open.length + ")" }) : null]));
    into.appendChild(h("ul", { cls: "vi-list" }, xs.map(function (x) { return row(S, env, "out", x, can, off); })));
    return { node: box, open: open.length, total: due.length };
  };
  // the one answer for everything (0444) folded away while there is a list
  api.foldAnswer = function (S, box, id, open) { ui(S); var d = fold(S, "ans:" + id, "Or one answer for all their items", open), i = h("div", { cls: "vi-ans" }); d.appendChild(i); box.appendChild(d); return i; };
})(typeof window !== "undefined" ? window : globalThis);

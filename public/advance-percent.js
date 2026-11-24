/* advance-percent.js - R252 (0435). Two small things for the quote flow's payment step (step 10):
   1. HelmAdvance.mount(box, opts): the advance percentage of ONE quote when the studio fixed it (Settings -> Payment schedules). Shown as text,
      with a quiet "Change for this quote" only when the server says this person may (can_override): new %, a reason (5+ characters), Save; then
      "40% - changed by <name>: <reason>" with Undo. Reads / writes ONLY BPStore.paySchedule.advanceGet / advanceSet / advanceClear (the database
      checks the right and keeps the record). null = an older database, or the studio did not fix it: the box stays hidden, the page as before.
   2. HelmAdvance.ask(kind, text, opts): BPUI.confirm / alert for a question about money. While amounts are hidden the question gets a
      "Show amount" button = the one existing unlock (the studio PIN, HelmPrivacy.show). Nothing is ever shown without it, and what was
      unlocked for the question is hidden again when the question closes.
   DOM API only (createElement + textContent). */
(function (global) {
  "use strict";
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function trim2(n) { return Math.round(Number(n) * 100) / 100; }
  // the typed % and reason -> { ok, pct, reason, error }
  function check(pct, reason) {
    var raw = String(pct == null ? "" : pct).trim(), r = String(reason == null ? "" : reason).replace(/\s+/g, " ").trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw) || Number(raw) > 100) return { ok: false, field: "pct", error: "Enter a percentage from 0 to 100." };
    if (r.length < 5) return { ok: false, field: "reason", error: "Give a reason of at least 5 characters." };
    if (/[<>]/.test(r)) return { ok: false, field: "reason", error: "Leave out < and > in the reason." };
    if (r.length > 300) return { ok: false, field: "reason", error: "Keep the reason under 300 characters." };
    return { ok: true, pct: Number(raw), reason: r, error: "" };
  }
  // what the line says -> { pct, text, note, changed }
  function words(a) {
    var o = a && a.override;
    if (o && o.pct != null) return { pct: trim2(o.pct), head: "Advance " + trim2(o.pct) + "%", note: " - changed by " + (String(o.by || "").trim() || "your team") + (o.reason ? ": " + o.reason : ""), changed: true };
    return { pct: trim2(a && a.pct), head: "Advance " + trim2(a && a.pct) + "%", note: " (your studio's setting)", changed: false };
  }
  function usable(a) { var v = a && a.fixed === true ? (a.override && a.override.pct != null ? a.override.pct : a.pct) : null; return v != null && v !== "" && isFinite(Number(v)); }
  function errText(e) {
    var s = String((e && e.message) || "");
    if (/not authori[sz]ed|42501/i.test(s + " " + ((e && e.code) || ""))) return "You don't have permission to change the advance for this quote.";
    try { if (global.BPUI && global.BPUI.friendlyError && (!s || /fetch|network/i.test(s))) return global.BPUI.friendlyError(e, { action: "change the advance" }); } catch (x) {}
    return s || "Couldn't save - please try again.";
  }
  function mount(box, opts) {
    opts = opts || {};
    var B = global.BPStore, api = B && B.paySchedule, data = null, busy = false, seq = 0;
    if (!box || !api || !api.advanceGet || !opts.quoteId) return null;
    function clear() { while (box.firstChild) box.removeChild(box.firstChild); }
    function tell() { if (typeof opts.onChange === "function") { var w = data ? words(data) : null; try { opts.onChange(usable(data) ? { pct: w.pct, changed: w.changed } : null, data); } catch (e) {} } }
    async function load() {
      var my = ++seq, a = null;
      try { a = await api.advanceGet(opts.quoteId); } catch (e) { a = data; }   // no answer: what is on screen stays
      if (my !== seq) return; data = a || null; paint(false); tell();
    }
    // the page read it already (payment_schedule_for_quote carries it): no second read
    function set(a) { seq++; if (busy || (box.querySelector && box.querySelector("form"))) { data = a || null; return; } data = a || null; paint(false); tell(); }
    function paint(open) {
      clear(); box.hidden = !usable(data); if (box.hidden) return;
      var w = words(data), line = el("div", "adv-line"), t = el("span"); t.setAttribute("role", "status");
      t.appendChild(el("b", "", w.head)); t.appendChild(document.createTextNode(w.note)); line.appendChild(t); box.appendChild(line);
      if (!data.can_override) return;
      if (w.changed) { var un = el("button", "adv-quiet", "Undo"); un.type = "button"; un.setAttribute("aria-label", "Undo: go back to your studio's advance"); un.addEventListener("click", undo); line.appendChild(un); }
      var ch = el("button", "adv-quiet", w.changed ? "Change again" : "Change for this quote"); ch.type = "button"; ch.setAttribute("aria-expanded", String(!!open));
      ch.addEventListener("click", function () { paint(!open); if (!open) { var i = box.querySelector("input"); if (i) i.focus(); } else focusLink(); }); line.appendChild(ch);
      if (open) box.appendChild(form());
    }
    function focusLink() { var l = box.querySelectorAll ? box.querySelectorAll(".adv-quiet") : []; if (l.length) l[l.length - 1].focus(); }
    function form() {
      var f = el("form", "adv-form"); f.setAttribute("novalidate", "");
      function fld(cls, label, input, id) { var w = el("div", "psch-fld " + cls), l = el("label", "psch-sel-lbl", label); input.id = id; l.htmlFor = id; w.appendChild(l); w.appendChild(input); f.appendChild(w); return input; }
      var p = el("input", "psch-in"); p.type = "number"; p.min = "0"; p.max = "100"; p.step = "0.01"; p.inputMode = "decimal"; p.value = String(words(data).pct); fld("adv-n", "New advance %", p, "adv_new_pct");
      var r = el("input", "psch-in"); r.type = "text"; r.maxLength = 300; r.placeholder = "e.g. Agreed with the client on the phone"; fld("", "Reason", r, "adv_reason");
      var s = el("button", "btn primary", "Save"); s.type = "submit"; var c = el("button", "btn", "Cancel"); c.type = "button";
      var err = el("p", "psch-err"); err.setAttribute("role", "alert"); err.hidden = true;
      c.addEventListener("click", function () { paint(false); focusLink(); });
      f.addEventListener("submit", async function (e) {
        if (e && e.preventDefault) e.preventDefault(); if (busy) return;
        var k = check(p.value, r.value);
        if (!k.ok) { err.textContent = k.error; err.hidden = false; (k.field === "pct" ? p : r).focus(); return; }
        busy = true; s.disabled = true; err.hidden = true;
        try { await api.advanceSet(opts.quoteId, k.pct, k.reason); await load(); focusLink(); toast("The advance for this quote is now " + trim2(k.pct) + "%."); }
        catch (x) { err.textContent = errText(x); err.hidden = false; }
        finally { busy = false; s.disabled = false; }
      });
      f.appendChild(s); f.appendChild(c); f.appendChild(err); return f;
    }
    function toast(t, kind) { if (global.BPUI && global.BPUI.toast) global.BPUI.toast(t, { type: kind || "ok" }); }
    async function undo() {
      if (busy) return; var U = global.BPUI;
      if (U && U.confirm && !(await U.confirm("Go back to your studio's advance percentage for this quote? Nothing already recorded changes.", { title: "Undo the change?", okLabel: "Undo" }))) return;
      busy = true;
      try { await api.advanceClear(opts.quoteId); await load(); focusLink(); toast("Back to your studio's advance."); } catch (x) { toast(errText(x), "err"); } finally { busy = false; }
    }
    if (opts.wait !== true) load();
    return { reload: load, set: set, get data() { return data; } };
  }

  // ---- a question about money while amounts are hidden ------------------------------------------------------------------
  function ask(kind, text, o) {
    var U = global.BPUI, HP = global.HelmPrivacy, hid = false;
    try { hid = !!(HP && HP.isHidden && HP.isHidden() && HP.show); } catch (e) { hid = false; }
    if (!hid) return U[kind](text, o);
    var shown = false, mo = null, p = U[kind](text, o);
    setTimeout(function () {   // the question is on screen now: add the one extra button
      var all = document.querySelectorAll(".bpui-dialog"), dlg = all[all.length - 1]; if (!dlg || !HP.isHidden()) return;
      var acts = dlg.querySelector(".bpui-actions"); if (!acts) return;
      var hint = el("p", "ask-hidden", "Amounts are hidden. Show the amount to check it first - it is hidden again when you close this."), b = el("button", "bpui-btn", "Show amount"); b.type = "button";
      b.addEventListener("click", function () { HP.show(); });
      dlg.insertBefore(hint, acts); acts.insertBefore(b, acts.firstChild);
      if (global.MutationObserver) {
        mo = new global.MutationObserver(function () { if (HP.isHidden()) return; shown = true; mo.disconnect(); if (hint.parentNode) hint.parentNode.removeChild(hint); if (b.parentNode) b.parentNode.removeChild(b);
          // the amount is on screen: the focus goes to Cancel, so one more Enter after the PIN never confirms by itself
          setTimeout(function () { var c = dlg.querySelector("[data-close]") || dlg.querySelector("button"); if (c) try { c.focus(); } catch (e) {} }, 0); });
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      }
    }, 0);
    function done(v) { if (mo) mo.disconnect(); if (shown) { try { if (!HP.isHidden()) HP.hide(); } catch (e) {} } return v; }
    return p.then(done, function (e) { done(); throw e; });
  }

  var out = { mount: mount, check: check, words: words, usable: usable, ask: ask };
  global.HelmAdvance = out;
  if (typeof module !== "undefined" && module.exports) module.exports = out;
})(typeof window !== "undefined" ? window : globalThis);

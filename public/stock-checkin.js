/* =========================================================================
   HelmStockCheckin (R191, 0374) - ONE "Mark back" dialog + the follow-up
   actions on a line, used by Inventory and Teardown & returns.

   Mark back:
     Reusable    came back OK + damaged; the rest is Missing - or tick
                 "Some are still out" and the rest stays Out (coming back later)
     Consumable  how many are left over (back to stock); the rest was used
     Photo       needed for a damaged / missing line when the studio asks for
                 one (setting, on by default); re-encoded in the browser
     Who pays    Finance edit only: decide later / studio absorbs / charge the
                 client (one pending "Recover from client" in Settlement)
   Line follow-up: Found (late return), Send to repair -> Repaired / Can't be
   fixed, Add photo, Who pays. Amounts only for people with Finance view.

   DOM only (no innerHTML). Browser: window.HelmStockCheckin. The pure helpers
   (plan / badges) are also exported for Node tests.
   ========================================================================= */
(function (root) {
  "use strict";

  function n(x) { var v = Number(x); return isFinite(v) ? v : 0; }
  function whole(x) { var s = String(x == null ? "" : x).trim(); if (s === "") return 0; var v = Number(s); return isFinite(v) && v >= 0 && Math.floor(v) === v ? v : NaN; }

  // what a check-in will do (pure): { left, ok, dmg, miss, used, part, photoNeeded, error }
  function plan(o) {
    o = o || {};
    var left = Math.max(n(o.out) - n(o.prior), 0), ok = whole(o.ok), dmg = o.consumable ? 0 : whole(o.damaged);
    if (isNaN(ok) || isNaN(dmg)) return { left: left, error: "Use whole numbers, 0 or more." };
    if (ok + dmg > left) return { left: left, error: "Only " + left + " still out - OK + damaged can be at most " + left + "." };
    var part = !!o.restOut && ok + dmg < left;
    if (part && ok + dmg === 0) return { left: left, error: "Count what came back now (the rest stays out)." };
    var miss = 0, used = 0;
    if (o.consumable) { if (!part) used = left - ok; }
    else if (!part) miss = left - ok - dmg;
    var photoNeeded = !o.consumable && !!o.photoProof && (miss > 0 || dmg > 0);
    return { left: left, ok: ok, dmg: dmg, miss: miss, used: used, part: part, stillOut: part ? left - ok - dmg : 0, photoNeeded: photoNeeded, error: "" };
  }

  // small plain-word chips for a line of the story (pure)
  function badges(line, ctx) {
    line = line || {}; ctx = ctx || {};
    var out = [];
    if (n(line.found)) out.push({ cls: "back", text: n(line.found) + " found later" });
    if (n(line.in_repair)) out.push({ cls: "out", text: n(line.in_repair) + " in repair" });
    if (n(line.repaired)) out.push({ cls: "back", text: n(line.repaired) + " repaired" });
    if (n(line.scrapped)) out.push({ cls: "missing", text: n(line.scrapped) + " can't be fixed" });
    if (line.photo_needed) out.push({ cls: "missing", text: "Photo needed" });
    else if ((line.photos || []).length) out.push({ cls: "released", text: (line.photos || []).length + " photo" + ((line.photos || []).length === 1 ? "" : "s") });
    if (line.decision === "absorb") out.push({ cls: "released", text: "Studio absorbs" });
    if (line.decision === "charge_client") {
      var st = line.charge_status === "processed" ? "paid" : line.charge_status === "rejected" || line.charge_status === "removed" ? "not charged" : "to collect";
      var amt = ctx.can_money && line.charge_amount != null && ctx.money ? " " + ctx.money(line.charge_amount) : "";
      out.push({ cls: st === "paid" ? "back" : st === "not charged" ? "released" : "reserved", text: "Charged to client" + amt + " - " + st });
    }
    return out;
  }

  var api = { plan: plan, badges: badges };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  var doc = root.document;
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "text") el.textContent = String(v);
      else if (k === "cls") el.className = v;
      else if (k === "on") Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function field(label, input, hint) {
    return h("label", { cls: "sc-fld" }, [h("span", { text: label }), input, hint ? h("small", { text: hint }) : null]);
  }
  function S() { return root.BPStore; }
  function toast(msg, type) { try { root.BPUI.toast(msg, { type: type || "ok" }); } catch (e) {} }
  function friendly(e, action) { try { return root.BPUI.friendlyError(e, { action: action }); } catch (_) { return (e && e.message) || "Something went wrong."; } }
  function money(v) { try { return S().studioMoney(v); } catch (e) { return String(v); } }

  var openSheet = null;
  function close() { if (openSheet) { try { openSheet.remove(); } catch (e) {} openSheet = null; } }
  function sheet(title, body, foot) {
    close();
    var err = h("div", { cls: "sc-err", role: "alert", "aria-live": "assertive", hidden: true });
    var x = h("button", { type: "button", cls: "sc-x", "aria-label": "Close", text: "×", on: { click: close } });
    var box = h("div", { cls: "sc-sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
      [h("div", { cls: "sc-head" }, [h("h3", { text: title }), x]), body, err, h("div", { cls: "sc-foot" }, foot)]);
    var wrap = h("div", { cls: "sc-modal", on: { click: function (e) { if (e.target === wrap) close(); } } }, [box]);
    wrap.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    doc.body.appendChild(wrap); openSheet = wrap;
    return { el: box, err: function (m) { err.textContent = m || ""; err.hidden = !m; } };
  }

  // photo picker: phone camera first; returns { get() -> File|null }
  function photoInput(label) {
    var inp = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", capture: "environment" });
    return { el: field(label, inp, "A clear photo of the item(s). It is shrunk and its location data removed before upload."),
      get: function () { return inp.files && inp.files[0] ? inp.files[0] : null; } };
  }
  async function upload(quoteId, file) { return S().inventory.stock.uploadStockPhoto(quoteId || null, file); }

  // ---- Mark back ----------------------------------------------------------------------------------------------
  function open(o) {
    o = o || {};
    var c = o.checkout || {}, it = o.item || {}, ctx = o.ctx || {}, unit = it.unit || "";
    var consumable = it.item_kind === "consumable";
    var left = Math.max(n(c.qty_out) - n(c.qty_in), 0);
    var okIn = h("input", { type: "number", min: "0", step: "1", inputmode: "numeric", value: String(left) });
    var dmgIn = h("input", { type: "number", min: "0", step: "1", inputmode: "numeric", value: "0" });
    var rest = h("input", { type: "checkbox" });
    var byIn = h("input", { type: "text", maxlength: "200", placeholder: "e.g. Ravi" });
    var info = h("p", { cls: "sc-info", role: "status", "aria-live": "polite" });
    var photo = photoInput("Photo of the damaged / missing items");
    var decSel = h("select", {}, [h("option", { value: "", text: "Decide later" }), h("option", { value: "absorb", text: "Studio absorbs the loss" }),
      h("option", { value: "charge", text: "Charge the client" })]);
    var amtIn = h("input", { type: "number", min: "0", step: "0.01", inputmode: "decimal" });
    var amtFld = field("Amount to charge", amtIn, "Goes to Settlement as “Recover from client” (pending until collected).");
    var decBox = ctx.can_decide ? h("div", { cls: "sc-dec" }, [field("Who pays for the loss?", decSel), amtFld]) : null;
    var kids = [
      h("p", { cls: "sc-sub", text: (it.name || "Item") + " · " + left + " " + unit + " still out" + (c.issued_to ? " with " + c.issued_to : "") }),
      h("div", { cls: "sc-grid" }, consumable
        ? [field("Left over (back to stock)", okIn), field("Your name", byIn)]
        : [field("Came back OK", okIn), field("Damaged", dmgIn), field("Your name", byIn)]),
      h("label", { cls: "sc-check" }, [rest, h("span", { text: "Some are still out — they come back later (the rest stays Out)" })]),
      info, photo.el, decBox
    ];
    var save = h("button", { type: "button", cls: "btn primary", text: "Mark back" });
    var cancel = h("button", { type: "button", cls: "btn", text: "Cancel", on: { click: close } });
    var sh = sheet("Mark back", h("div", { cls: "sc-body" }, kids), [cancel, save]);
    function cur() { return plan({ out: c.qty_out, prior: c.qty_in, ok: okIn.value, damaged: dmgIn.value, restOut: rest.checked, consumable: consumable, photoProof: ctx.photo_proof !== false }); }
    function refresh() {
      var p = cur(); sh.err("");
      if (p.error) { info.textContent = p.error; photo.el.hidden = true; if (decBox) decBox.hidden = true; return; }
      var bits = [];
      if (p.part) bits.push(p.stillOut + " stay Out (mark them back when they return)");
      if (p.used) bits.push(p.used + " " + unit + " used (costed on this event)");
      if (p.miss) bits.push(p.miss + " missing");
      if (p.dmg) bits.push(p.dmg + " damaged");
      if (p.miss || p.dmg) bits.push("missing and damaged come off what you own" + (ctx.can_cost && it.unit_cost != null ? " (" + money((p.miss + p.dmg) * n(it.unit_cost)) + ")" : ""));
      info.textContent = bits.length ? bits.join(" · ") + "." : "Everything is back.";
      photo.el.hidden = !(p.miss > 0 || p.dmg > 0);
      if (photo.el.firstChild) photo.el.firstChild.textContent = p.photoNeeded ? "Photo of the damaged / missing items (needed)" : "Photo (optional)";
      if (decBox) { decBox.hidden = !(p.miss > 0 || p.dmg > 0) || p.part; amtFld.hidden = decSel.value !== "charge";
        if (decSel.value === "charge" && !amtIn.value && ctx.can_money && it.unit_cost != null) amtIn.value = String(Math.round((p.miss + p.dmg) * n(it.unit_cost) * 100) / 100); }
    }
    [okIn, dmgIn].forEach(function (x) { x.addEventListener("input", refresh); });
    rest.addEventListener("change", refresh); decSel.addEventListener("change", refresh);
    refresh(); setTimeout(function () { try { okIn.focus(); okIn.select(); } catch (e) {} }, 30);
    save.addEventListener("click", function () {
      var p = cur(); if (p.error) { sh.err(p.error); return; }
      var file = photo.get();
      if (p.photoNeeded && !file) { sh.err("Add a photo of the damaged or missing items (your studio asks for one)."); return; }
      var dec = decBox && !decBox.hidden ? decSel.value : "";
      if (dec === "charge" && !(n(amtIn.value) > 0)) { sh.err("Enter the amount to charge (above 0)."); return; }
      var run = async function () {
        try {
          var path = file && (p.miss > 0 || p.dmg > 0) ? await upload(o.quoteId || c.quote_id, file) : null;
          var r = await S().inventory.checkouts.backV2(c.id, { ok: p.ok, damaged: p.dmg, by: byIn.value.trim() || null, restOut: p.part,
            photoPath: path, decision: dec || null, charge: dec === "charge" ? amtIn.value : null });
          close();
          toast(p.part ? "Recorded - " + p.stillOut + " still out." : "Marked back.");
          if (o.onDone) await o.onDone(r);
        } catch (e) { sh.err(friendly(e, "mark it back")); }
      };
      try { if (root.BPUI && root.BPUI.guard) return root.BPUI.guard(save, run, { busyLabel: "Saving…" }); } catch (e) {}
      return run();
    });
  }

  // ---- follow-up on a line that came back short / broken ----------------------------------------------------------
  function lineActions(host, o) {
    o = o || {};
    var line = o.line || {}, ctx = o.ctx || {}, c = o.checkout || {}, it = o.item || {};
    if (!host) return;
    host.textContent = "";
    var chips = h("div", { cls: "sc-chips" }, badges(line, { can_money: ctx.can_money, money: money }).map(function (b) { return h("span", { cls: "sf-pill " + b.cls, text: b.text }); }));
    host.appendChild(chips);
    if (!o.canEdit) return;
    var acts = h("div", { cls: "sf-acts sc-acts" });
    var missingOpen = Math.max(n(line.missing) - n(line.found), 0);
    var damagedOpen = Math.max(n(line.damaged) - n(line.in_repair) - n(line.repaired) - n(line.scrapped), 0);
    function btn(label, fn) { acts.appendChild(h("button", { type: "button", cls: "btn sm", text: label, on: { click: fn } })); }
    if (missingOpen > 0) btn("Found", function () { found(o, missingOpen); });
    if (damagedOpen > 0) btn("Send to repair", function () { repair(o, "start", damagedOpen); });
    if (n(line.in_repair) > 0) { btn("Repaired", function () { repair(o, "done", n(line.in_repair)); }); btn("Can't be fixed", function () { repair(o, "scrap", n(line.in_repair)); }); }
    if (it.item_kind !== "consumable" && (n(line.missing) > 0 || n(line.damaged) > 0)) btn(line.photo_needed ? "Add photo (needed)" : "Add photo", function () { addPhoto(o); });
    if ((line.photos || []).length) btn("See photos", function () { seePhotos(o); });
    var lossLeft = n(line.missing) + n(line.damaged) - n(line.found) - n(line.repaired);
    if (ctx.can_decide && lossLeft > 0 && (!line.decision || line.decision === "absorb" || line.charge_status === "rejected" || line.charge_status === "removed"))
      btn(line.decision ? "Change who pays" : "Who pays?", function () { decide(o, lossLeft); });
    if (acts.childNodes.length) host.appendChild(acts);
  }

  function qtyForm(title, sub, max, extra, onSave) {
    var q = h("input", { type: "number", min: "1", step: "1", max: String(max), value: String(max), inputmode: "numeric" });
    var note = h("input", { type: "text", maxlength: "500", placeholder: "Optional" });
    var body = h("div", { cls: "sc-body" }, [h("p", { cls: "sc-sub", text: sub }), h("div", { cls: "sc-grid" }, [field("How many", q), field("Note", note)].concat(extra || []))]);
    var save = h("button", { type: "button", cls: "btn primary", text: "Save" });
    var sh = sheet(title, body, [h("button", { type: "button", cls: "btn", text: "Cancel", on: { click: close } }), save]);
    save.addEventListener("click", function () {
      var v = whole(q.value);
      if (isNaN(v) || v < 1) { sh.err("Enter a whole number above 0."); return; }
      if (v > max) { sh.err("At most " + max + "."); return; }
      var run = async function () { try { await onSave(v, note.value.trim() || null); close(); } catch (e) { sh.err(friendly(e, "save it")); } };
      try { if (root.BPUI && root.BPUI.guard) return root.BPUI.guard(save, run, { busyLabel: "Saving…" }); } catch (e) {}
      return run();
    });
    setTimeout(function () { try { q.focus(); } catch (e) {} }, 30);
  }
  function found(o, max) {
    var it = o.item || {};
    qtyForm("Found (late return)", (it.name || "Item") + " · " + max + " still missing. They go back into stock; the loss on the event is credited.", max, null,
      async function (v, note) { await S().inventory.stock.found(o.checkout.id, v, note); toast("Back in stock."); if (o.onDone) await o.onDone(); });
  }
  function repair(o, action, max) {
    var it = o.item || {}, ctx = o.ctx || {};
    var cost = h("input", { type: "number", min: "0", step: "0.01", inputmode: "decimal" });
    var extra = action === "done" && ctx.can_decide ? [field("Repair cost (optional)", cost)] : null;
    var t = action === "start" ? "Send to repair" : action === "done" ? "Repaired" : "Can't be fixed";
    var sub = action === "start" ? "Under repair = not usable, not lost." : action === "done" ? "Back in stock. The repair cost goes on this event." : "They stay off your stock.";
    qtyForm(t, (it.name || "Item") + " · " + sub, max, extra, async function (v, note) {
      await S().inventory.stock.repair(o.checkout.id, action, v, extra && cost.value !== "" ? cost.value : null, note);
      toast(action === "done" ? "Back in stock." : "Saved."); if (o.onDone) await o.onDone();
    });
  }
  function addPhoto(o) {
    var ph = photoInput("Photo");
    var save = h("button", { type: "button", cls: "btn primary", text: "Add photo" });
    var sh = sheet("Add photo", h("div", { cls: "sc-body" }, [h("p", { cls: "sc-sub", text: (o.item && o.item.name) || "Item" }), ph.el]),
      [h("button", { type: "button", cls: "btn", text: "Cancel", on: { click: close } }), save]);
    save.addEventListener("click", function () {
      var f = ph.get(); if (!f) { sh.err("Choose a photo first."); return; }
      var run = async function () { try { var path = await upload(o.quoteId || o.checkout.quote_id, f); await S().inventory.stock.addPhoto(o.checkout.id, path);
        close(); toast("Photo added."); if (o.onDone) await o.onDone(); } catch (e) { sh.err(friendly(e, "add the photo")); } };
      try { if (root.BPUI && root.BPUI.guard) return root.BPUI.guard(save, run, { busyLabel: "Uploading…" }); } catch (e) {}
      return run();
    });
  }
  async function seePhotos(o) {
    var paths = (o.line && o.line.photos) || [];
    var grid = h("div", { cls: "sc-photos" }, [h("p", { cls: "sc-sub", text: "Loading…" })]);
    sheet("Photos", h("div", { cls: "sc-body" }, [grid]), [h("button", { type: "button", cls: "btn", text: "Close", on: { click: close } })]);
    try {
      var urls = await S().inventory.stock.photoUrls(paths, 300);
      grid.textContent = "";
      paths.forEach(function (p) { if (urls[p]) grid.appendChild(h("a", { href: urls[p], target: "_blank", rel: "noopener noreferrer" }, [h("img", { src: urls[p], alt: "Stock photo", loading: "lazy" })])); });
      if (!grid.childNodes.length) grid.appendChild(h("p", { cls: "sc-sub", text: "These photos can't be shown right now." }));
    } catch (e) { grid.textContent = ""; grid.appendChild(h("p", { cls: "sc-sub", text: friendly(e, "show the photos") })); }
  }
  function decide(o, units) {
    var it = o.item || {}, ctx = o.ctx || {};
    var sel = h("select", {}, [h("option", { value: "absorb", text: "Studio absorbs the loss" }), h("option", { value: "charge", text: "Charge the client" })]);
    var amt = h("input", { type: "number", min: "0", step: "0.01", inputmode: "decimal",
      value: ctx.can_money && it.unit_cost != null ? String(Math.round(units * n(it.unit_cost) * 100) / 100) : "" });
    var amtF = field("Amount to charge", amt, "Goes to Settlement as “Recover from client” (pending until collected).");
    var body = h("div", { cls: "sc-body" }, [h("p", { cls: "sc-sub", text: (it.name || "Item") + " · " + units + " lost or damaged" }),
      h("div", { cls: "sc-grid" }, [field("Who pays?", sel), amtF])]);
    var save = h("button", { type: "button", cls: "btn primary", text: "Save" });
    var sh = sheet("Who pays for the loss?", body, [h("button", { type: "button", cls: "btn", text: "Cancel", on: { click: close } }), save]);
    var sync = function () { amtF.hidden = sel.value !== "charge"; }; sel.addEventListener("change", sync); sync();
    save.addEventListener("click", function () {
      if (sel.value === "charge" && !(n(amt.value) > 0)) { sh.err("Enter the amount to charge (above 0)."); return; }
      var run = async function () { try { await S().inventory.stock.decide(o.checkout.id, sel.value, sel.value === "charge" ? amt.value : null);
        close(); toast(sel.value === "charge" ? "Added to Settlement as Recover from client." : "Saved - the studio absorbs it."); if (o.onDone) await o.onDone(); }
        catch (e) { sh.err(friendly(e, "save the decision")); } };
      try { if (root.BPUI && root.BPUI.guard) return root.BPUI.guard(save, run, { busyLabel: "Saving…" }); } catch (e) {}
      return run();
    });
  }

  api.open = open; api.lineActions = lineActions; api.close = close;
  root.HelmStockCheckin = api;
})(typeof window !== "undefined" ? window : this);

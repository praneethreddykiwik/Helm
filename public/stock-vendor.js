/* stock-vendor.js - R252 (owner 24 Nov): "Get it from a vendor", one dialog for a missing thing, used by the event-day pages and
 * Inventory.
 *
 *   HelmStockVendor.open({ quoteId, label, qty, itemId, layoutType, onDone, returnFocus })
 *        -> Promise of the result (also given to onDone) or null when it was closed without saving
 *        result: { ok, how: "stock" | "need" | "updated" | "exists", vendorId, vendorName, qty, reserved, bookingId, needId, job }
 *   HelmStockVendor.canUse()                     -> Promise<boolean>: may this person use it (to show the button at all)
 *   HelmStockVendor.sourcing(thing, data)        -> the vendors already asked for it (pure; no read)
 *
 * It saves with the flow the resource plan already uses, never with a new one:
 *   - a linked stock item with nothing free: reserve_inventory_with_sourcing (the shortfall is recorded and the vendor is noted on
 *     the event as Asked). Some still free: the same call, only when "Reserve the ones we have first" is ticked;
 *   - anything else: ONE resource need + ONE vendor booking in status enquiry ("Asked") tied to it.
 *   The same thing + vendor + event is never written twice: the event's bookings and needs are read again right before saving.
 * No price is asked for or shown. Nothing is sent to the vendor unless "Also send them this as a job" is ticked (off by default).
 * R259: "Ask them now" opens the Ask vendor dialog (vendor-flow.js) for the booking that was just made - availability and price; sent only there.
 * Permission: the one of the resource plan (Resources - can change), plus Vendors - can change, which the database asks for.
 * DOM calls only (textContent), no HTML strings, no inline styles. Unit-tested in test/r252-stock-vendor.test.mjs. */
(function (root) {
  "use strict";
  var doc = root.document, MAX_QTY = 1000000, MAX_SHOWN = 60;
  var STATUS = { enquiry: "Asked", booked: "Booked", confirmed: "Confirmed", delivered: "Delivered", cancelled: "Cancelled" };
  var VKIND = { vendor: "Vendor", freelancer: "Freelancer", rental: "Rental", supplier: "Supplier", internal: "In-house" };

  /* ---------------- pure ---------------- */
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(v) { return Math.round(num(v)).toLocaleString("en-IN"); }
  function nl(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase(); }
  function statusText(s) { return STATUS[s] || String(s || ""); }
  // a positive whole number, or null ("12", " 12 ", 12 - never "1.5", "1e3", "-2")
  function parseQty(v) {
    var s = String(v == null ? "" : v).trim(); if (!/^\d{1,7}$/.test(s)) return null;
    var n = Number(s); return n >= 1 && n <= MAX_QTY ? n : null;
  }
  // the label reserve_inventory_with_sourcing gives a booking: "Chiavari chair - rent 20 (stock shortfall)"
  var RENT = /^(.*) - rent (\d+(?:\.\d+)?) \(stock shortfall\)$/;
  function rentOf(label) { var m = RENT.exec(String(label || "").trim()); return m ? { name: m[1], qty: Number(m[2]) } : null; }
  // the need of this event for the same thing: the same stock item, else the same words
  function findNeed(thing, needs) {
    var list = (needs || []).filter(function (n) { return n && n.kind !== "staff"; }), t = thing || {}, k = nl(t.label);
    var byItem = t.itemId ? list.filter(function (n) { return n.item_id === t.itemId; }) : [];
    if (byItem.length) return byItem[0];
    var byName = k ? list.filter(function (n) { return nl(n.label) === k && !(t.itemId && n.item_id && n.item_id !== t.itemId); }) : [];
    return byName[0] || null;
  }
  function sameThing(b, thing, needs, shortages) {
    var t = thing || {}, k = nl(t.label), r = rentOf(b.label);
    if (b.need_id) {
      var n = (needs || []).filter(function (x) { return x && x.id === b.need_id; })[0];
      if (n) return !!((t.itemId && n.item_id === t.itemId) || (k && nl(n.label) === k && !(t.itemId && n.item_id && n.item_id !== t.itemId)));
    }
    if (t.itemId && (shortages || []).some(function (s) { return s && s.booking_id === b.id && s.item_id === t.itemId; })) return true;
    return !!(k && (nl(b.label) === k || (r && nl(r.name) === k)));
  }
  // the vendors already on the event for this thing (cancelled ones left out)
  function sourcing(thing, data) {
    var d = data || {}, byV = {};
    (d.vendors || []).forEach(function (v) { if (v) byV[v.id] = v; });
    return (d.bookings || []).filter(function (b) { return b && b.status !== "cancelled" && sameThing(b, thing, d.needs, d.shortages); }).map(function (b) {
      var v = byV[b.vendor_id], r = rentOf(b.label);
      var fromStock = !!r || (d.shortages || []).some(function (s) { return s && s.booking_id === b.id; });
      return { bookingId: b.id, vendorId: b.vendor_id || null, vendorName: (v && v.name) || (d.names && d.names[b.vendor_id]) || "Vendor",
        qty: b.qty != null ? num(b.qty) : (r ? r.qty : 0), status: b.status || "enquiry", statusText: statusText(b.status || "enquiry"),
        fromStock: fromStock, needId: b.need_id || null, priced: b.cost != null };
    });
  }
  function sourcedQty(list) { return (list || []).reduce(function (a, s) { return a + Math.max(num(s.qty), 0); }, 0); }
  // what pressing the button with this vendor + number does:
  //   new    nothing there yet
  //   update the vendor is only Asked, no price and not a stock shortfall: the number is changed on the same booking
  //   exists leave it alone and say so
  function decide(existing, qty) {
    if (!existing) return { act: "new" };
    if (num(existing.qty) === num(qty)) return { act: "exists", why: "same" };
    if (existing.status !== "enquiry") return { act: "exists", why: "agreed" };
    if (existing.priced) return { act: "exists", why: "priced" };
    if (existing.fromStock) return { act: "exists", why: "stock" };
    return { act: "update" };
  }
  // a shortfall of this item is already recorded on the event with no vendor ("decide later"): the stock call would record a second one
  function shortOpen(itemId, shortages) { return !!itemId && (shortages || []).some(function (s) { return s && s.item_id === itemId && !s.booking_id; }); }
  // stock item: which way to save. free = units still free on the event's stock days (null = not a stock item / not allowed)
  function route(o) {
    if (!o || !o.itemId || !o.canInv || o.free == null || o.shortOpen) return { how: "need", call: 0, reserve: 0 };
    var f = Math.max(0, Math.floor(num(o.free)));
    if (f === 0) return { how: "stock", call: o.qty, reserve: 0 };
    return o.reserveFree ? { how: "stock", call: o.qty + f, reserve: f } : { how: "need", call: 0, reserve: 0 };
  }
  // this event's vendors first, then the rest; both by name; search looks at name, category, kind, services
  function vendorList(vendors, bookings, query) {
    var here = {}; (bookings || []).forEach(function (b) { if (b && b.vendor_id && b.status !== "cancelled") here[b.vendor_id] = 1; });
    var q = nl(query);
    var hit = function (v) {
      if (!q) return true;
      var s = [v.name, v.category, VKIND[v.kind] || v.kind].concat(Array.isArray(v.services) ? v.services : []).map(nl).join(" ");
      return q.split(" ").every(function (w) { return s.indexOf(w) >= 0; });
    };
    var list = (vendors || []).filter(function (v) { return v && v.id && v.active !== false && hit(v); })
      .sort(function (a, b) { return nl(a.name).localeCompare(nl(b.name)); });
    return { event: list.filter(function (v) { return here[v.id]; }), other: list.filter(function (v) { return !here[v.id]; }) };
  }
  // a need the plan may call covered: what vendors bring + what we hold reaches the number asked for (never a false "covered")
  function needMet(need, vendorQty, held) { return num(vendorQty) + Math.max(num(held), 0) >= num(need && need.qty); }
  function jobTitle(label, qty) { return ("Bring " + fmt(qty) + " x " + String(label || "").trim()).slice(0, 120); }
  function hasPhone(v) { return String((v && v.phone) || "").replace(/\D/g, "").length >= 8; }
  function textBad(s) { return /[<>]/.test(String(s || "")); }

  var api = { parseQty: parseQty, rentOf: rentOf, findNeed: findNeed, sourcing: sourcing, sourcedQty: sourcedQty, decide: decide, route: route, shortOpen: shortOpen,
    vendorList: vendorList, needMet: needMet, jobTitle: jobTitle, hasPhone: hasPhone, statusText: statusText };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; if (!doc) return; }
  if (!doc || !doc.createElement) { root.HelmStockVendor = api; return; }

  /* ---------------- dialog ---------------- */
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function S() { return root.BPStore || null; }
  function sn(s) { try { if (S() && typeof S().sampleName === "function") return S().sampleName(s); } catch (e) {} return String(s == null ? "" : s); }
  function friendly(e, action) { try { return root.BPUI.friendlyError(e, { action: action }); } catch (x) { return (e && e.message) || "Something went wrong."; } }
  function toast(msg, type) { try { root.BPUI.toast(msg, { type: type || "ok", timeout: 7000 }); } catch (e) {} }
  function may(area) { try { return Promise.resolve(S().auth.canEditArea(area)).then(Boolean, function () { return false; }); } catch (e) { return Promise.resolve(false); } }
  function mayAssign() { try { var A = S().auth; return Promise.resolve(A.canAssignTasks ? A.canAssignTasks() : A.canEditArea("staff")).then(Boolean, function () { return false; }); } catch (e) { return Promise.resolve(false); } }
  function lockError(e) { try { return !!S().ops.planLock.isLockError(e); } catch (x) { return /plan_locked/.test(String((e && e.message) || "")); } }
  function canUse() {
    if (!S() || !S().auth || !S().bookings || !S().resources || !S().vendors) return Promise.resolve(false);
    return Promise.all([may("resources"), may("vendors")]).then(function (r) { return r[0] && r[1]; });
  }

  // the event's own rows, read together (a refused or failed read is an error here: without them a second copy could be written)
  function readEvent(o) {
    return Promise.all([
      S().bookings.list(o.quoteId), S().resources.listNeeds(o.quoteId),
      o.itemId ? Promise.resolve(S().inventory.shortages(o.quoteId)).catch(function () { return []; }) : []
    ]).then(function (r) { return { bookings: r[0] || [], needs: r[1] || [], shortages: r[2] || [] }; });
  }
  // how many of our own are still free on the event's stock days + does the floor plan say they are all needed
  function readFree(o) {
    if (!o.itemId) return Promise.resolve(null);
    var L = S().inventory && S().inventory.layout;
    return Promise.resolve(L && L.needs ? Promise.resolve(L.needs(o.quoteId)).catch(function () { return null; }) : null).then(function (b) {
      var it = ((b && b.items) || []).filter(function (x) { return x && x.item_id === o.itemId; })[0];
      if (it) { var f = Math.max(0, Math.floor(num(it.free))), rest = Math.max(num(it.needed) - num(it.held), 0); return { free: f, needed: rest >= f }; }
      return Promise.resolve(S().inventory.availability(o.quoteId, [o.itemId])).then(function (m) {
        var a = m && m[o.itemId]; if (!a) return null;
        return { free: Math.max(0, Math.floor(num(a.availableOnEvent != null ? a.availableOnEvent : a.available))), needed: false };
      });
    });
  }

  var openNow = null;
  function open(opts) {
    var o = Object.assign({}, opts || {});
    o.label = String(o.label || "").replace(/\s+/g, " ").trim().slice(0, 200) || "Item";
    if (openNow) { try { openNow.focus(); } catch (e) {} return openNow.promise; }
    var back = o.returnFocus && o.returnFocus.focus ? o.returnFocus : doc.activeElement;
    var resolveOut, promise = new Promise(function (r) { resolveOut = r; });
    var uid = "hsv" + Math.random().toString(36).slice(2, 8), busy = false, closed = false, data = null, vendors = [], freeInfo = null, canInv = false, canJob = false, picked = null, query = "";

    var x = h("button", { type: "button", cls: "hsv-x", "aria-label": "Close", "data-close": true, text: "×" });
    var body = h("div", { cls: "hsv-body" });
    var err = h("p", { cls: "hsv-err", role: "alert", hidden: true });
    var cancel = h("button", { type: "button", cls: "hsv-btn", text: "Cancel" });
    var ok = h("button", { type: "button", cls: "hsv-btn hsv-primary", text: "Ask this vendor", disabled: true });
    var sheet = h("div", { cls: "hsv-sheet" }, [h("div", { cls: "hsv-head" }, [h("h2", { id: uid + "t", cls: "hsv-h", text: "Get it from a vendor" }), x]), body, err,
      h("div", { cls: "hsv-foot" }, [cancel, ok])]);
    var wrap = h("div", { cls: "hsv", role: "dialog", "aria-modal": "true", "aria-labelledby": uid + "t" }, [sheet]);

    function close(result) {
      if (closed) return; closed = true; openNow = null;
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      setTimeout(function () { try { if (back && back.isConnected !== false) back.focus(); } catch (e) {} }, 0);
      if (result) { try { if (typeof o.onDone === "function") o.onDone(result); } catch (e) { try { console.warn("stock vendor: onDone", e); } catch (z) {} } }
      resolveOut(result || null);
    }
    function dismiss() { if (!busy) close(null); }
    function fail(msg, field) { err.textContent = msg; err.hidden = false; if (field && field.focus) { try { field.focus(); } catch (e) {} } }
    function okErr() { err.hidden = true; err.textContent = ""; }
    function planLink(text) { return h("a", { cls: "hsv-link", href: "resources.html?quote=" + encodeURIComponent(o.quoteId), text: text }); }
    x.addEventListener("click", dismiss); cancel.addEventListener("click", dismiss);
    wrap.addEventListener("mousedown", function (e) { if (e.target === wrap) dismiss(); });
    wrap.addEventListener("keydown", function (e) { if (e.key === "Escape" && !busy) { e.stopPropagation(); e.preventDefault(); dismiss(); } });

    function message(text, retry) {
      clear(body); ok.disabled = true;
      body.appendChild(h("p", { cls: "hsv-note", text: text }));
      if (retry) { var b = h("button", { type: "button", cls: "hsv-btn", text: "Try again" }); b.addEventListener("click", load); body.appendChild(b); }
    }

    /* the form */
    var qtyIn, noteIn, jobIn, jobLine, askIn, resIn, listBox, doneBox, freeBox, vmsg;
    function existing() { return picked ? sourcing({ itemId: o.itemId, label: o.label }, withNames()).filter(function (s) { return s.vendorId === picked; })[0] || null : null; }
    function withNames() { return Object.assign({ vendors: vendors }, data); }
    function vendorOf(id) { return vendors.filter(function (v) { return v.id === id; })[0] || null; }
    var WHY = { same: "is already asked for this many.", agreed: "is already agreed for this. Change it in the resource plan.", priced: "already has a price for this. Change it in the resource plan.",
      stock: "is already asked for this. Change it in the resource plan." };
    function refreshButton() {
      var v = vendorOf(picked), ex = existing(), q = parseQty(qtyIn.value);
      clear(vmsg); vmsg.hidden = true; ok.disabled = !v; ok.textContent = "Ask this vendor";
      if (v && ex) {
        var d = q ? decide(ex, q) : { act: "exists", why: "same" };
        if (d.act === "update") { ok.textContent = "Change to " + fmt(q); vmsg.appendChild(doc.createTextNode(sn(v.name) + " is asked for " + fmt(ex.qty) + ". The number is changed, nothing is added twice.")); }
        else { ok.disabled = true; vmsg.appendChild(doc.createTextNode(sn(v.name) + " (" + fmt(ex.qty) + ", " + ex.statusText + ") " + WHY[d.why] + " ")); vmsg.appendChild(planLink("Open the resource plan")); }
        vmsg.hidden = false;
      }
      if (jobIn) {
        var can = canJob && v && hasPhone(v);
        jobIn.disabled = !can; if (!can) jobIn.checked = false;
        jobLine.textContent = !v ? "Pick the vendor first." : can ? "They get a link to accept it and mark it done, on their phone number. Off: nothing is sent." : sn(v.name) + " has no phone number. Add it in Vendors to send a job.";
      }
    }
    function renderVendors() {
      var g = vendorList(vendors, data.bookings, query), shown = 0;
      clear(listBox);
      [["On this event", g.event], [g.event.length ? "All other vendors" : "Vendors", g.other]].forEach(function (pair) {
        if (!pair[1].length) return;
        listBox.appendChild(h("p", { cls: "hsv-grp", text: pair[0] }));
        pair[1].forEach(function (v) {
          if (shown >= MAX_SHOWN && v.id !== picked) return; shown++;
          var r = h("input", { type: "radio", name: uid + "v", value: v.id, cls: "hsv-radio" });
          if (v.id === picked) r.checked = true;
          r.addEventListener("change", function () { if (r.checked) { picked = v.id; okErr(); refreshButton(); } });
          var sub = [VKIND[v.kind] || v.kind, v.category].filter(Boolean).join(" · ");
          listBox.appendChild(h("label", { cls: "hsv-v" }, [r, h("span", { cls: "hsv-vt" }, [h("b", { text: sn(v.name) }), sub ? h("small", { text: sub }) : null])]));
        });
      });
      if (!shown) listBox.appendChild(h("p", { cls: "hsv-note", text: vendors.length ? "No vendor matches this search." : "No vendors yet. Add one first." }));
      else if (g.event.length + g.other.length > shown) listBox.appendChild(h("p", { cls: "hsv-note", text: "Showing " + shown + " of " + (g.event.length + g.other.length) + ". Search to find the rest." }));
    }
    function renderForm() {
      clear(body);
      var have = sourcing({ itemId: o.itemId, label: o.label }, withNames()), left = Math.max(Math.ceil(num(o.qty)) - sourcedQty(have), 0);
      body.appendChild(h("p", { cls: "hsv-what" }, [h("span", { cls: "hsv-lbl", text: "What" }), h("b", { text: sn(o.label) })]));
      doneBox = h("div", { cls: "hsv-have", hidden: !have.length });
      have.forEach(function (s) { doneBox.appendChild(h("p", { text: "Already asked: " + sn(s.vendorName) + " - " + fmt(s.qty) + " (" + s.statusText + ")" })); });
      if (have.length && num(o.qty) > 0 && !left) doneBox.appendChild(h("p", { text: "That covers all " + fmt(o.qty) + "." }));
      body.appendChild(doneBox);
      qtyIn = h("input", { id: uid + "q", type: "text", inputmode: "numeric", autocomplete: "off", maxlength: "7", cls: "hsv-in hsv-qty", value: String(Math.max(left, 0) || (num(o.qty) > 0 ? Math.ceil(num(o.qty)) : 1)) });
      qtyIn.addEventListener("input", function () { okErr(); refreshButton(); });
      body.appendChild(h("div", { cls: "hsv-f" }, [h("label", { cls: "hsv-lbl", "for": uid + "q", text: "How many from the vendor" }), qtyIn]));
      resIn = null; freeBox = null;
      if (o.itemId && canInv && freeInfo && freeInfo.free > 0 && !shortOpen(o.itemId, data.shortages)) {
        resIn = h("input", { type: "checkbox", id: uid + "r", checked: freeInfo.needed }); resIn.checked = !!freeInfo.needed;
        freeBox = h("label", { cls: "hsv-chk", "for": uid + "r" }, [resIn, h("span", {}, [h("b", { text: "Reserve the " + fmt(freeInfo.free) + " we have first" }),
          h("small", { text: fmt(freeInfo.free) + " of our own are still free that day. Ticked: they are held for this event too." })])]);
        body.appendChild(freeBox);
      }
      var search = h("input", { id: uid + "s", type: "search", autocomplete: "off", cls: "hsv-in", placeholder: "Search vendors", "aria-label": "Search vendors" });
      var timer = null;
      search.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { query = search.value; renderVendors(); }, 120); });
      search.addEventListener("keydown", function (e) { if (e.key === "Enter") e.preventDefault(); });
      listBox = h("div", { cls: "hsv-list", tabindex: "0", role: "group", "aria-label": "Vendors" });
      vmsg = h("p", { cls: "hsv-note", role: "status", "aria-live": "polite", hidden: true });
      body.appendChild(h("fieldset", { cls: "hsv-set" }, [h("legend", { cls: "hsv-lbl", text: "Vendor" }), search, listBox,
        h("p", { cls: "hsv-add" }, [h("a", { cls: "hsv-link", href: "vendors.html", target: "_blank", rel: "noopener", text: "Add a vendor (opens Vendors)" }),
          (function () { var b = h("button", { type: "button", cls: "hsv-link", text: "Reload list" }); b.addEventListener("click", function () { if (!busy) reloadVendors(b); }); return b; })()]), vmsg]));
      noteIn = h("input", { id: uid + "n", type: "text", maxlength: "300", autocomplete: "off", cls: "hsv-in", placeholder: "Optional" });
      body.appendChild(h("div", { cls: "hsv-f" }, [h("label", { cls: "hsv-lbl", "for": uid + "n", text: "Note" }), noteIn]));
      jobIn = null; jobLine = null;
      if (canJob) {
        jobIn = h("input", { type: "checkbox", id: uid + "j", "aria-describedby": uid + "jd" }); jobLine = h("small", { id: uid + "jd" });
        body.appendChild(h("label", { cls: "hsv-chk", "for": uid + "j" }, [jobIn, h("span", {}, [h("b", { text: "Also send them this as a job" }), jobLine])]));
      }
      askIn = null;
      if (S().vendorRequests && S().vendorRequests.ask) {
        askIn = h("input", { type: "checkbox", id: uid + "a" });
        body.appendChild(h("label", { cls: "hsv-chk", "for": uid + "a" }, [askIn, h("span", {}, [h("b", { text: "Ask them now for availability and price" }), h("small", { text: "Next you check the request. Nothing is sent before that." })])]));
      }
      body.appendChild(h("p", { cls: "hsv-note" }, ["The vendor is noted on the event as Asked. You can also send the request later from the ", planLink("resource plan"), "."]));
      if (picked && !vendorOf(picked)) picked = null;
      renderVendors(); refreshButton();
      if (!wrap.contains(doc.activeElement)) { try { qtyIn.focus(); } catch (e) {} }
    }
    function reloadVendors(btn) {
      btn.disabled = true;
      Promise.resolve(S().vendors.listAll(false)).then(function (v) { vendors = v || []; if (picked && !vendorOf(picked)) picked = null; renderVendors(); refreshButton(); })
        .catch(function (e) { fail(friendly(e, "load the vendors")); }).then(function () { btn.disabled = false; });
    }
    function load() {
      okErr(); clear(body); ok.disabled = true;
      body.appendChild(h("p", { cls: "hsv-note", role: "status", text: "Loading..." }));
      if (!o.quoteId || !S()) { message("This needs an event. Open it from one event."); return; }
      Promise.all([canUse(), o.itemId ? may("inventory") : false, mayAssign()]).then(function (p) {
        if (closed) return null;
        if (!p[0]) { message("Your role can't add vendors to an event. Ask a manager to do it in the resource plan."); return null; }
        canInv = p[1]; canJob = p[2];
        return Promise.all([readEvent(o), S().vendors.listAll(false), canInv ? readFree(o) : null]).then(function (r) {
          if (closed) return; data = r[0]; vendors = r[1] || []; freeInfo = r[2];
          if (canInv && o.itemId && !freeInfo) canInv = false;   // not in the stock list any more: the plain need + vendor path
          renderForm();
        });
      }).catch(function () { if (!closed) message("Couldn't load the vendors and what is already asked for.", true); });
    }

    function heldQty() {
      if (!o.itemId) return Promise.resolve(0);
      return Promise.resolve(S().inventory.reservations(o.quoteId, [o.itemId])).then(function (rs) {
        return (rs || []).reduce(function (a, r) { return a + (r && r.item_id === o.itemId && (r.status === "reserved" || r.status === "allocated") ? num(r.qty) : 0); }, 0); });
    }
    function vendorTotal(qty) { return sourcedQty(sourcing({ itemId: o.itemId, label: o.label }, data)) + num(qty); }
    // a need that is already on the plan: the stock call's booking is tied to it (as the resource plan does), so it is not asked twice
    function linkNeed(need, res) {
      if (!need || need.status === "outsourced" || !res.bookingId) return null;
      return heldQty().then(function (held) {
        if (!needMet(need, vendorTotal(res.qty), held)) return null;
        return S().bookings.update(res.bookingId, { need_id: need.id }).then(function () { res.needId = need.id; return S().resources.updateNeed(need.id, { status: "outsourced" }); });
      }).catch(function (e) { try { console.warn("vendor saved, but couldn't link it to the need:", (e && e.message) || e); } catch (z) {} });
    }
    // bookings.add marks the need covered; a vendor who brings only part of it must not hide the rest
    function keepOpen(need, res) {
      return heldQty().then(function (held) { return needMet(need, vendorTotal(res.qty), held) ? null : S().resources.updateNeed(need.id, { status: "open" }); })
        .catch(function (e) { try { console.warn("vendor saved, but couldn't keep the need open:", (e && e.message) || e); } catch (z) {} });
    }
    function sendJob(vendor, qty) {
      if (!jobIn || !jobIn.checked) return Promise.resolve(null);
      var title = jobTitle(o.label, qty);
      return Promise.resolve(S().ops.listTasks(o.quoteId)).catch(function () { return []; }).then(function (ts) {
        var dup = (ts || []).some(function (t) { return t && t.vendor_id === vendor.id && nl(t.title) === nl(title) && t.status !== "cancelled" && t.status !== "rejected"; });
        if (dup) return "exists";
        return S().ops.assignTasksVendor(o.quoteId, "Vendors", [title], vendor.id).then(function () { return "sent"; });
      });
    }
    function save() {
      if (busy || ok.disabled) return; okErr();
      var qty = parseQty(qtyIn.value), vendor = vendorOf(picked), note = noteIn.value.trim();
      if (!qty) { fail("How many: a whole number, 1 or more.", qtyIn); return; }
      if (!vendor) { fail("Pick the vendor."); return; }
      if (textBad(note)) { fail("The note can't contain < or >.", noteIn); return; }
      var shown = existing(), vname = sn(vendor.name), label = sn(o.label);
      busy = true; ok.disabled = true; cancel.disabled = true; x.disabled = true; var was = ok.textContent; ok.textContent = "Saving..."; ok.setAttribute("aria-busy", "true");
      var res = { ok: true, vendorId: vendor.id, vendorName: vendor.name, qty: qty, reserved: 0, bookingId: null, needId: null, job: null };
      readEvent(o).then(function (fresh) {
        data = fresh;
        var now = existing(), d = decide(now, qty);
        if (now && !shown) { var e1 = new Error("there"); e1.userText = vname + " was added to this event for this a moment ago (" + fmt(now.qty) + ", " + now.statusText + "). Nothing was added twice."; e1.redraw = true; throw e1; }
        if (d.act === "exists") { res.how = "exists"; res.qty = num(now.qty); res.bookingId = now.bookingId; return null; }
        if (d.act === "update") {
          return Promise.resolve(S().vendorRequests && S().vendorRequests.list ? S().vendorRequests.list(o.quoteId, vendor.id) : []).then(function (rq) {
            if ((rq || []).some(function (r) { return r && r.booking_id === now.bookingId && (r.status === "sent" || r.status === "accepted"); })) {
              var e2 = new Error("sent"); e2.userText = vname + " already has a request for this. Change it in the resource plan, so they see the new number."; throw e2; }
            var patch = { qty: qty }; if (note) patch.note = note;
            return S().bookings.update(now.bookingId, patch).then(function () { res.how = "updated"; res.bookingId = now.bookingId; });
          });
        }
        return (canInv && o.itemId ? readFree(o) : Promise.resolve(null)).then(function (fi) {
          var r = route({ itemId: o.itemId, canInv: canInv, free: fi ? fi.free : null, qty: qty, reserveFree: !!(resIn && resIn.checked), shortOpen: shortOpen(o.itemId, fresh.shortages) });
          if (fi && freeInfo && fi.free !== freeInfo.free) {
            freeInfo = fi; var e3 = new Error("stock moved"); e3.userText = "The free stock just changed: " + fmt(fi.free) + " of our own are free now. Check the numbers and press again."; e3.redraw = true; throw e3; }
          if (r.how === "stock") {
            return S().inventory.reserveWithSourcing(o.itemId, o.quoteId, r.call, "Event stock", { source: "vendor", vendorId: vendor.id, vendorName: vendor.name, sourceNote: note || null }).then(function (a) {
              res.how = "stock"; res.reserved = num(a && a.reserved); res.qty = a && a.short != null ? num(a.short) : qty; res.bookingId = (a && a.booking_id) || null;
              return linkNeed(findNeed({ itemId: o.itemId, label: o.label }, fresh.needs), res);
            });
          }
          var need = findNeed({ itemId: o.itemId, label: o.label }, fresh.needs);
          return Promise.resolve(need || S().resources.addNeed(o.quoteId, Object.assign({ kind: o.itemId ? "inventory" : "other", label: o.label, qty: qty, note: o.layoutType ? "From the 2D / 3D layout" : "Missing for the event" },
            o.itemId ? { item_id: o.itemId } : {}))).then(function (n) {
            res.needId = n && n.id; if (!res.needId) throw new Error("the need was not saved");
            return S().bookings.add(o.quoteId, { vendor_id: vendor.id, need_id: res.needId, kind: vendor.kind || null, label: o.label, qty: qty, status: "enquiry", note: note || null })
              .then(function (b) { res.how = "need"; res.bookingId = b && b.id; return need && need.status !== "outsourced" ? keepOpen(need, res) : null; });
          });
        });
      }).then(function () {
        return sendJob(vendor, res.qty).then(function (j) { res.job = j; }, function (e) { res.job = "failed"; res.jobError = lockError(e) ? "the database still refuses changes on the event day (needs database update 0442)" : friendly(e, "send the job"); });
      }).then(function () {
        var msg = res.how === "exists" ? vname + " is already asked for " + fmt(res.qty) + " x " + label + "."
          : res.how === "updated" ? vname + " is now asked for " + fmt(res.qty) + " x " + label + "."
          : res.qty > 0 ? vname + " is noted for " + fmt(res.qty) + " x " + label + " (Asked)." + (res.reserved ? " " + fmt(res.reserved) + " of our own reserved." : "")
          : "Our own stock covered it: " + fmt(res.reserved) + " reserved, no vendor needed.";
        if (res.job === "sent") msg += " The job is sent."; else if (res.job === "exists") msg += " They already have this job."; else if (res.job === "failed") msg += " The job was not sent: " + res.jobError;
        toast(msg, res.job === "failed" ? "info" : "ok");
        busy = false; var now = !!(askIn && askIn.checked) && res.bookingId && res.qty > 0; close(res);
        if (now) flowLib().then(function (F) { return F.ask({ quoteId: o.quoteId, vendorId: res.vendorId, lockVendor: true, bookingId: res.bookingId, lines: [{ name: String(o.label || "").slice(0, 120), qty: res.qty, need_id: res.needId || null }], returnFocus: o.returnFocus }); })
          .then(function (row) { if (row) try { doc.dispatchEvent(new root.CustomEvent("helm:vendors")); } catch (e) {} }, function () { toast("Couldn't open the request. Send it from the resource plan.", "info"); });
      }).catch(function (e) {
        busy = false; ok.removeAttribute("aria-busy"); ok.textContent = was; ok.disabled = false; cancel.disabled = false; x.disabled = false;
        var keep = { q: qtyIn.value, n: noteIn.value, j: !!(jobIn && jobIn.checked) };
        if (e && e.redraw) { renderForm(); qtyIn.value = keep.q; noteIn.value = keep.n; refreshButton(); if (jobIn && !jobIn.disabled) jobIn.checked = keep.j; }
        fail((e && e.userText) || friendly(e, "ask the vendor"));
      });
    }
    ok.addEventListener("click", save);

    doc.body.appendChild(wrap);
    openNow = { promise: promise, focus: function () { (qtyIn || x).focus(); } };
    load();
    setTimeout(function () { if (!closed && !wrap.contains(doc.activeElement)) { try { x.focus(); } catch (e) {} } }, 30);
    return promise;
  }

  // R259: the Ask vendor dialog, loaded when it is first needed
  var flowP = null;
  function flowLib() {
    if (root.HelmVendorFlow) return Promise.resolve(root.HelmVendorFlow);
    if (!flowP) flowP = new Promise(function (ok2, no) { var sc = doc.createElement("script"); sc.src = "/vendor-flow.js?v=1"; sc.onload = function () { ok2(root.HelmVendorFlow); }; sc.onerror = function () { flowP = null; sc.remove(); no(new Error("vendor-flow")); }; doc.head.appendChild(sc); });
    return flowP;
  }
  api.open = open; api.canUse = canUse;
  root.HelmStockVendor = api;
})(typeof window !== "undefined" ? window : this);

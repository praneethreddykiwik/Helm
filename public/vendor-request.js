/* vendor-request.js - /vendor-request?t=<64 hex> (0256). A vendor answers a studio's request without signing in
   (Accept / Decline with a comment) and, once accepted, sends their tax invoice from the same link (number, date,
   taxable value, CGST + SGST or IGST, GSTIN, one PDF / photo). Talks only to the public RPCs vendor_link_get /
   vendor_link_respond / vendor_invoice_upload / vendor_invoice_submit and to the private 'vendor-invoices' bucket
   with the one-time key the upload RPC grants (the token is the only key; the database keeps only its hash).
   R259 (0447): available / not available, a price per product (or one total), fewer pieces, charges, discount, note and one file (vendor_link_offer /
   vendor_offer_upload); it can be changed until the studio confirms. The invoice starts from the confirmed products. A server that does not say
   flow 447 gets the older Accept / Decline page. The total is worked out here and again on the server.
   Text only (textContent), no inline script. */
(function () {
  "use strict";
  var TOKEN_RE = /^[0-9a-f]{64}$/;
  var KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png|webp)$/;
  var MAX_BYTES = 10 * 1024 * 1024;
  var LABEL = { sent: "Waiting for your answer", accepted: "Accepted", rejected: "Declined", cancelled: "Cancelled by the studio",
    reassigned: "Given to another vendor" };
  var INV = { submitted: "Sent - waiting for approval", queried: "Question from the studio", approved: "Approved", rejected: "Rejected",
    superseded: "Replaced by a corrected invoice" };
  var PAY = { due: "not paid yet", partial: "part paid", paid: "paid" };
  var $ = function (id) { return document.getElementById(id); };
  var token = String(new URLSearchParams(location.search).get("t") || "").trim().toLowerCase();
  var cfg = window.SUPABASE_CONFIG || {};
  var base = String(cfg.url || "").replace(/\/+$/, "");
  var cur = null, answer = null, replaces = null;
  var lastKey = null, lastSig = "";   // the same answer pressed twice = one (a changed answer gets a new key)

  // money in the event's currency (INR when the server does not say)
  function ccy() { var c = String((cur && cur.currency) || "INR"); return /^[A-Z]{3}$/.test(c) ? c : "INR"; }
  function sym() {
    var c = ccy(); if (c === "INR") return "₹";
    try { var p = new Intl.NumberFormat("en", { style: "currency", currency: c, currencyDisplay: "narrowSymbol" }).formatToParts(0).filter(function (x) { return x.type === "currency"; })[0]; return p ? p.value : c; } catch (e) { return c; }
  }
  function inr(n) {
    var v = Number(n); if (!isFinite(v)) return "";
    var s = v.toLocaleString(ccy() === "INR" ? "en-IN" : "en", { minimumFractionDigits: Math.round(v * 100) % 100 ? 2 : 0, maximumFractionDigits: 2 }), y = sym();
    return y + (/^[A-Z]{3}$/.test(y) ? " " : "") + s;
  }
  // "27/11/2026, 07:57 PM" -> "27 Nov 2026, 07:57 PM" (reads the same in every country)
  function pd(t) { return String(t || "").replace(/\b(\d\d)\/(\d\d)\/(\d{4})/g, function (m, d, o, y) { var n = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(o) - 1]; return n ? Number(d) + " " + n + " " + y : m; }); }
  function flow() { return !!(cur && Number(cur.flow) === 447); }
  function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function qn(n) { return Number(n).toLocaleString(ccy() === "INR" ? "en-IN" : "en", { maximumFractionDigits: 2 }); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function empty(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  // "1,250.50" -> 1250.5; "" -> null; anything else -> NaN (0 or more, at most 2 decimals)
  function amount(v) {
    var t = String(v == null ? "" : v).replace(/[\s,]/g, ""); if (t === "") return null;
    if (!/^\d{1,12}(\.\d{0,2})?$/.test(t)) return NaN; return Number(t);
  }
  function uuid() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* older phone */ }
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  function keyFor(sig) { if (sig !== lastSig || !lastKey) { lastSig = sig; lastKey = uuid(); } return lastKey; }
  function rpc(fn, body) {
    if (!base || !cfg.anonKey) return Promise.resolve({ ok: false, error: "config" });
    return fetch(base + "/rest/v1/rpc/" + fn, { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey },
      body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return r.ok ? { ok: true, data: j } : { ok: false, error: String((j && j.message) || "") }; }, function () { return { ok: false, error: "" }; }); })
      .catch(function () { return { ok: false, error: "network" }; });
  }
  function fact(dl, k, v) { if (!v) return; var dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; dl.appendChild(dt); dl.appendChild(dd); }
  function bad(title, msg) {
    $("vr-title").textContent = title; $("vr-msg").textContent = msg;
    ["vr-facts", "vr-now", "vr-answer", "vr-invoice", "vr-invoices", "vr-items", "vr-offer", "vr-change"].forEach(function (id) { $(id).hidden = true; });
  }
  function err(id, msg) { var el = $(id); el.textContent = msg || ""; el.hidden = !msg; }
  // the server's message when it is one of ours (plain words), else a generic one
  function say(e, fallback) {
    var m = String(e || "");
    if (/^(enter|attach|the |please|an |invoice|charge|CGST|GST|only|upload|too many|say|comment|notes|this )/i.test(m) && m.length < 200) return m.charAt(0).toUpperCase() + m.slice(1);
    return fallback;
  }

  function render(d) {
    if (!d || d.ok !== true) {
      if (d && d.reason === "cancelled") return bad("This event has been cancelled", "This link is no longer active - there is nothing more to do. Thank you.");   // r23-0260
      if (d && d.reason === "paused") return bad("Link not active", "This link has expired. Ask the studio to share it again.");   // r23-0260: restored, not re-shared yet
      if (d && d.reason === "rate") return bad("Please wait a moment", "Too many tries from this link. Try again in a few minutes.");
      if (d && d.reason === "closed" && d.status) { /* fall through with the fresh state */ }
      else return bad("This link isn't available", "Please ask the person who sent it to you for a new one.");
    }
    cur = d;
    Array.prototype.forEach.call(document.querySelectorAll("[data-cur]"), function (x) { x.textContent = sym(); });
    var item = String(d.what || "") + (Number(d.qty) > 0 ? " × " + Number(d.qty).toLocaleString("en-IN") : "");
    $("vr-title").textContent = item || "Vendor request";
    if ($("vr-brand")) $("vr-brand").textContent = String(d.studio || "Your event planner");   // R257: the studio's page, not Helm's
    $("vr-msg").textContent = "Request from " + (d.studio || "your event planner") + (d.vendor_name ? " for " + d.vendor_name : "");
    var dl = $("vr-facts"); while (dl.firstChild) dl.removeChild(dl.firstChild);
    fact(dl, "Event", (d.event || "") + (d.event_date ? " on " + pd(d.event_date) : ""));
    fact(dl, "Venue", d.venue || "");
    if (!(flow() && d.invoice_only)) fact(dl, "When", pd(d.when_text));
    fact(dl, "Where", d.where_text || "");
    fact(dl, "Details", d.details || "");
    if (!flow()) fact(dl, "Agreed amount", d.agreed_amount != null ? inr(d.agreed_amount) : "");
    if (d.status === "sent" && !flow()) fact(dl, "Please reply by", d.respond_by_text || "");
    if (d.response_note && (!flow() || d.status === "rejected")) fact(dl, "Your comment", d.response_note);
    dl.hidden = false;
    $("vr-now").textContent = flow() ? nowText(d) : "Status: " + (LABEL[d.status] || d.status);
    $("vr-now").hidden = false;
    $("vr-answer").hidden = d.can_respond !== true;
    $("vr-answer-form").hidden = true; $("vr-offer").hidden = true; $("vr-change").hidden = true; $("vr-items").hidden = true;
    $("vr-answer").querySelector(".vr-actions").hidden = false;
    if (flow()) renderFlow(d);
    renderInvoices(d.invoices || []);
    $("vr-invoice").hidden = d.can_invoice !== true;
    if (d.can_invoice !== true) $("vr-inv-form").hidden = true;
    if (flow()) $("vr-inv-open").textContent = (d.invoices || []).some(function (i) { return i.status === "submitted" || i.status === "approved"; }) ? "Send another invoice" : "Send an invoice";
    if (flow() && d.can_invoice === true && d.invoice_only && !(d.invoices || []).length && $("vr-inv-form").hidden) openInvoice(null);
  }
  // ---- R259: where the request stands, in one sentence ----
  function nowText(d) {
    var o = d.offer, st = String(d.studio || "The studio");
    if (d.status === "cancelled") return "Cancelled by " + st + ". There is nothing more to do.";
    if (d.status === "reassigned") return st + " gave this to another vendor. Thank you.";
    if (d.status === "rejected") return d.declined_by === "studio" ? st + " did not take your offer this time. Thank you." : "You said it is not available." + (d.can_respond ? " Plans changed? You can still answer." : "");
    if (d.status === "accepted") {
      if (d.invoice_only) return "Please send your invoice below.";
      var c = d.confirmed || {}; return "Booking confirmed" + (c.total != null ? " at " + inr(c.total) : "") + ". Thank you.";
    }
    if (o && o.status === "offered") return "Your offer of " + inr(o.total) + " was sent. " + st + " will confirm it.";
    if (o && o.status === "change_asked") return st + " asks you to change your offer.";
    return ((d.lines || []).length > 1 ? "Are these products available?" : "Is this product available?") + (d.respond_by_text ? " Please reply by " + pd(d.respond_by_text) + "." : "");
  }
  function itemRow(name, qty, unit, right, sub) {
    var li = el("li", "vr-item"), l = el("div", "vr-item-l");
    l.appendChild(el("b", "", name)); l.appendChild(el("span", "", qn(qty) + (unit ? " " + unit : "") + (sub ? " · " + sub : "")));
    li.appendChild(l); if (right) li.appendChild(el("span", "vr-item-r", right)); return li;
  }
  function totalRow(ul, k, v, big) { var li = el("li", "vr-item vr-item-sum" + (big ? " is-big" : "")); li.appendChild(el("span", "", k)); li.appendChild(el("b", "", v)); ul.appendChild(li); }
  function renderFlow(d) {
    var o = d.offer, ul = $("vr-items-list"); empty(ul);
    var conf = d.status === "accepted" ? d.confirmed : null, mine = d.status === "sent" && o && (o.status === "offered" || o.status === "change_asked") ? o : null;
    var rows = conf ? conf.lines : mine ? mine.lines : d.lines;
    $("vr-items-h").textContent = conf ? (d.invoice_only ? "Products" : "Confirmed") : mine ? "Your offer" : "What is asked for";
    (rows || []).forEach(function (l) {
      var q = Number(l.qty), p = l.price == null ? null : Number(l.price), less = mine && Number(l.asked_qty) > q ? "asked " + qn(l.asked_qty) : "";
      if (mine && !(q > 0)) return ul.appendChild(itemRow(l.name, 0, l.unit, "", "asked " + qn(l.asked_qty)));
      ul.appendChild(itemRow(l.name, q, l.unit, p != null ? inr(r2(p * q)) : "", [p != null ? inr(p) + " each" : "", less].filter(Boolean).join(" · ")));
    });
    var src = conf || mine;
    if (src) {
      if (Number(src.charges) > 0) totalRow(ul, "Delivery / other charges", inr(src.charges));
      if (Number(src.discount) > 0) totalRow(ul, "Discount", "- " + inr(src.discount));
      if (src.total != null) totalRow(ul, conf ? "Agreed total" : "Your total", inr(src.total), true);
    } else if (d.agreed_amount != null) totalRow(ul, "Agreed total", inr(d.agreed_amount), true);
    else if (d.status === "sent" && d.price_open) totalRow(ul, "Price", "Please tell us yours");
    if (mine && mine.note) { var n = el("li", "vr-item-note", "Your note: " + mine.note); ul.appendChild(n); }
    if (mine && mine.has_file) ul.appendChild(el("li", "vr-item-note", "Your file was received."));
    $("vr-items").hidden = !ul.childNodes.length || d.status === "cancelled" || d.status === "reassigned";
    if (mine && o.status === "change_asked" && o.review_note) {
      var box = $("vr-change"); empty(box); box.appendChild(el("b", "", String(d.studio || "The studio") + " asks:")); box.appendChild(el("p", "", o.review_note)); box.hidden = false;
    }
    if (d.can_respond === true) {
      $("vr-accept").textContent = mine ? (o.status === "change_asked" ? "Send a new offer" : "Change my offer") : d.status === "rejected" ? "It is available now" : (d.lines || []).length > 1 ? "Yes, products available" : "Yes, product available";
      $("vr-reject").textContent = "Not available"; $("vr-reject").hidden = d.status === "rejected";
    }
    $("vr-inv-hint").textContent = "Your products and prices are filled in. Add the invoice number and attach your invoice. " + String(d.studio || "The studio") + " checks it, and you can see here when it is approved and paid.";
  }
  // ---- R259: the offer form ----
  function field(id, label, val, o) {
    var w = el("div"), l = el("label", "", label), i = el("input"); l.htmlFor = id; i.id = id; i.value = val == null ? "" : String(val); i.autocomplete = "off"; i.setAttribute("inputmode", "decimal"); i.maxLength = 13;
    if (o && o.ph) i.placeholder = o.ph; w.appendChild(l); w.appendChild(i); return { box: w, input: i };
  }
  var offerRows = [];
  function openOffer() {
    var d = cur, o = d.offer && (d.offer.status === "offered" || d.offer.status === "change_asked") ? d.offer : null, box = $("vo-lines"); empty(box); offerRows = [];
    var one = !!(o && o.mode === "total");
    (d.lines || []).forEach(function (l, i) {
      var was = o ? (o.lines || []).filter(function (x) { return x.id === l.id; })[0] : null;
      var row = el("fieldset", "vo-line"), lg = el("legend", "", l.name); row.appendChild(lg);
      var asked = Number(l.qty), g = el("div", "vo-line-g");
      var q = field("vo-q" + i, "Quantity (of " + qn(asked) + (l.unit ? " " + l.unit : "") + ")", was ? was.qty : asked), p = field("vo-p" + i, "Price each (" + sym() + ")", was && was.price != null ? was.price : l.price != null ? l.price : "", { ph: "0" });
      var t = el("p", "vo-line-t"); t.setAttribute("aria-live", "polite");
      g.appendChild(q.box); g.appendChild(p.box); row.appendChild(g); row.appendChild(t); box.appendChild(row);
      q.input.addEventListener("input", sumOffer); p.input.addEventListener("input", sumOffer);
      var r = { l: l, q: q.input, p: p.input, pw: p.box, t: t, asked: asked };
      if ((d.lines || []).length > 1) {   // R262: one of several products can be not available
        var nl = el("label", "vr-check vo-none"), nb = el("input"); nb.type = "checkbox"; nb.id = "vo-n" + i; nb.checked = !!(was && Number(was.qty) === 0); nl.appendChild(nb); nl.appendChild(el("span", "", "Not available")); row.appendChild(nl); r.none = nb;
        nb.addEventListener("change", function () { q.input.value = nb.checked ? "0" : String(asked); sumOffer(); });
        q.input.addEventListener("input", function () { nb.checked = amount(q.input.value) === 0; });
      }
      offerRows.push(r);
    });
    // an agreed total without prices per product is easiest as one total
    if (!o && d.agreed_amount != null && !(d.lines || []).some(function (l) { return l.price != null; })) one = true;
    $("vo-one").checked = one; $("vo-total").value = one ? (o ? o.total : d.agreed_amount != null ? d.agreed_amount : "") : "";
    $("vo-charges").value = o && Number(o.charges) > 0 ? o.charges : ""; $("vo-discount").value = o && Number(o.discount) > 0 ? o.discount : ""; $("vo-note").value = o && o.note ? o.note : ""; $("vo-file").value = "";
    $("vo-had").hidden = !(o && o.has_file); $("vo-had").textContent = "You attached a file before. Attach it again to send it with the new answer.";
    $("vo-hint").textContent = d.price_open ? "Enter your price for each product. Bring fewer? Change the quantity." : "The agreed price is filled in. Change it only if you need to. Bring fewer? Change the quantity.";
    err("vo-err", ""); $("vr-answer").querySelector(".vr-actions").hidden = true; $("vr-offer").hidden = false; sumOffer();
    setTimeout(function () { var f = one ? $("vo-total") : (offerRows[0] && (offerRows[0].p.value === "" ? offerRows[0].p : offerRows[0].q)); try { f.focus({ preventScroll: true }); $("vr-offer").scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) { /* ignore */ } }, 30);
  }
  function closeOffer() { $("vr-offer").hidden = true; $("vr-answer").querySelector(".vr-actions").hidden = false; }
  // { total, lines, charges, discount, err, el }
  function readOffer() {
    var one = $("vo-one").checked, sum = 0, any = 0, bad = null, lines = offerRows.map(function (r) {
      var q = amount(r.q.value), p = amount(r.p.value);
      if (!bad && (q === null || isNaN(q))) bad = { err: "Enter how many of " + r.l.name + " you bring (0 if none).", el: r.q };
      if (!bad && q > r.asked) bad = { err: "Only " + qn(r.asked) + " of " + r.l.name + " are asked for.", el: r.q };
      if (!one && !bad && q > 0 && (p === null || isNaN(p))) bad = { err: "Enter the price of " + r.l.name + ".", el: r.p };
      var t = !one && q > 0 && p != null && !isNaN(p) ? r2(q * p) : 0; sum += t; any += q > 0 ? q : 0;
      return { id: r.l.id, qty: q, price: one ? null : q > 0 ? p : (p == null || isNaN(p) ? 0 : p) };
    });
    var ch = one ? 0 : amount($("vo-charges").value) || 0, di = one ? 0 : amount($("vo-discount").value) || 0;
    if (!bad && !one && isNaN(amount($("vo-charges").value))) bad = { err: "Enter the charges as a number, or leave them empty.", el: $("vo-charges") };
    if (!bad && !one && isNaN(amount($("vo-discount").value))) bad = { err: "Enter the discount as a number, or leave it empty.", el: $("vo-discount") };
    if (!bad && !(any > 0)) bad = { err: "Enter a quantity for at least one product, or choose Not available.", el: offerRows[0] && offerRows[0].q };
    var tot = one ? amount($("vo-total").value) : r2(sum + ch - di);
    if (!bad && one && !(tot > 0)) bad = { err: "Enter the total price.", el: $("vo-total") };
    if (!bad && !one && di > sum + ch) bad = { err: "The discount cannot be more than the price.", el: $("vo-discount") };
    if (!bad && !(tot > 0) && (cur.price_open || Number(cur.agreed_amount) > 0)) bad = { err: "Enter your price.", el: offerRows[0] && offerRows[0].p };
    return Object.assign({ one: one, lines: lines, charges: ch, discount: di, total: tot }, bad || {});
  }
  function sumOffer() {
    var one = $("vo-one").checked; $("vo-total-w").hidden = !one; $("vo-extra").hidden = one;
    offerRows.forEach(function (r) {
      var q = amount(r.q.value), p = amount(r.p.value); r.pw.hidden = one;
      r.t.hidden = one; r.t.textContent = q > 0 && p != null && !isNaN(p) && !one ? qn(q) + " x " + inr(p) + " = " + inr(r2(q * p)) : q === 0 ? "You do not bring this one." : "";
    });
    var v = readOffer(), n = v.total; $("vo-sum-n").textContent = n != null && isFinite(n) && n >= 0 ? inr(n) : "-";
    var a = cur.agreed_amount, dd = $("vo-diff"); dd.hidden = !(a != null && n != null && isFinite(n) && Math.abs(n - Number(a)) > 0.004);
    if (!dd.hidden) dd.textContent = inr(Math.abs(n - Number(a))) + (n > Number(a) ? " more than" : " less than") + " the agreed " + inr(a) + ". The studio will check it.";
    err("vo-err", "");
  }
  function sendOffer(ev) {
    if (ev) ev.preventDefault();
    var v = readOffer(), note = $("vo-note").value.trim(), f = $("vo-file").files && $("vo-file").files[0];
    if (!v.err && /[<>]/.test(note)) { v.err = "Please don't use < or >."; v.el = $("vo-note"); }
    if (!v.err && f && f.size > MAX_BYTES) { v.err = "The file is larger than 10 MB."; v.el = $("vo-file"); }
    if (v.err) { err("vo-err", v.err); try { v.el.focus(); } catch (e) { /* ignore */ } return; }
    var body = { available: true, mode: v.one ? "total" : "lines", lines: v.lines, total: v.total };
    if (!v.one) { body.charges = v.charges; body.discount = v.discount; }
    if (note) body.note = note;
    body.key = keyFor(JSON.stringify([body, f ? [f.name, f.size, f.lastModified] : null]));
    var b = $("vo-send"), done = function (m) { b.disabled = false; b.textContent = "Send my answer"; if (m) err("vo-err", m); };
    b.disabled = true; b.textContent = "Sending…"; err("vo-err", "");
    (f ? upload(f, "vendor_offer_upload") : Promise.resolve({})).then(function (u) {
      if (u.err) return done(u.err);
      if (u.path) body.file_path = u.path;
      return rpc("vendor_link_offer", { p_token: token, p: body }).then(function (r) {
        if (!r.ok) return done(say(r.error, "Could not send that just now. Please try again."));
        done(); render(r.data);
        if (r.data && r.data.ok) { lastKey = null; lastSig = ""; top(); }
      });
    });
  }
  function top() { try { $("vr-now").scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { /* ignore */ } }
  // a file -> { path } | { err } (one-time key from the server, private bucket, never overwrites)
  function upload(file, fn) {
    return sniff(file).then(function (mime) {
      if (!mime) return { err: "The file must be a PDF, JPEG, PNG or WebP." };
      return rpc(fn, { p_token: token, p_mime: mime }).then(function (g) {
        if (!g.ok || !g.data || !KEY_RE.test(String(g.data.path || ""))) return { err: say(g.error, "Could not prepare the upload. Please try again.") };
        return fetch(base + "/storage/v1/object/vendor-invoices/" + g.data.path, { method: "POST", credentials: "omit",
          headers: { apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey, "Content-Type": mime, "x-upsert": "false" }, body: file })
          .then(function (up) { return up.ok ? { path: g.data.path } : { err: "The file could not be uploaded. Please try again." }; },
            function () { return { err: "The file could not be uploaded. Please check your connection." }; });
      });
    }, function () { return { err: "The file could not be read. Please choose it again." }; });
  }

  function renderInvoices(list) {
    var ul = $("vr-inv-list"); while (ul.firstChild) ul.removeChild(ul.firstChild);
    var shown = list.filter(function (i) { return i.status !== "superseded"; });
    $("vr-invoices").hidden = !shown.length;
    shown.forEach(function (i) {
      var li = document.createElement("li"); li.className = "vr-inv vr-inv-" + i.status;
      var top = document.createElement("div"); top.className = "vr-inv-top";
      var no = document.createElement("b"); no.textContent = "Invoice " + i.invoice_no; top.appendChild(no);
      var amt = document.createElement("span"); amt.textContent = inr(i.total_amount) + " · " + pd(i.invoice_date); top.appendChild(amt);
      li.appendChild(top);
      (Array.isArray(i.lines) ? i.lines : []).forEach(function (l) { li.appendChild(el("div", "vr-inv-l", l.name + ": " + qn(l.qty) + " x " + inr(l.price) + " = " + inr(l.total))); });
      var st = document.createElement("div"); st.className = "vr-inv-st";
      st.textContent = (INV[i.status] || i.status) + (i.status === "approved" && i.pay_status ? " · " + PAY[i.pay_status] + (i.pay_status === "partial" ? " (" + inr(i.paid) + " paid)" : "") : "");
      li.appendChild(st);
      if (i.review_note && (i.status === "queried" || i.status === "rejected")) {
        var n = document.createElement("div"); n.className = "vr-inv-note"; n.textContent = "Studio: " + i.review_note; li.appendChild(n);
      }
      if (i.status === "queried" && cur && cur.can_invoice) {
        var b = document.createElement("button"); b.type = "button"; b.className = "vr-btn vr-ghost vr-sm"; b.textContent = "Send a corrected invoice";
        b.addEventListener("click", function () { openInvoice(i); }); li.appendChild(b);
      }
      ul.appendChild(li);
    });
  }

  // ---- accept / decline ----
  function openAnswer(a) {
    if (a === "accept" && flow()) return openOffer();
    answer = a; err("vr-answer-err", "");
    $("vr-comment-l").textContent = a === "reject" ? "Why can't you take this? (required)" : "Comment (optional, e.g. delivery time)";
    $("vr-comment").value = "";
    $("vr-answer-send").textContent = a === "reject" ? (flow() ? "Send: not available" : "Decline the request") : "Accept the request";
    $("vr-answer").querySelector(".vr-actions").hidden = true; $("vr-answer-form").hidden = false;
    setTimeout(function () { $("vr-comment").focus(); }, 0);
  }
  function sendAnswer(ev) {
    if (ev) ev.preventDefault();
    var c = $("vr-comment").value.trim();
    if (answer === "reject" && c.length < 3) { err("vr-answer-err", "Please say why you can't take this."); $("vr-comment").focus(); return; }
    if (/[<>]/.test(c)) { err("vr-answer-err", "Please don't use < or >."); return; }
    $("vr-answer-send").disabled = true;
    (flow() ? rpc("vendor_link_offer", { p_token: token, p: { available: false, reason: c } })
            : rpc("vendor_link_respond", { p_token: token, p_action: answer, p_comment: c || null })).then(function (r) {
      $("vr-answer-send").disabled = false;
      if (!r.ok) { err("vr-answer-err", say(r.error, "Could not send that just now. Please try again.")); return; }
      render(r.data);
      if (flow()) { top(); return; }
      if (r.data && r.data.ok) $("vr-now").textContent = "Thank you - " + (answer === "accept" ? "you accepted this request." : "you declined this request.") + " " + (r.data.studio || "The studio") + " has been told.";
    });
  }

  // ---- invoice ----
  // R259: the products of the invoice (from what was confirmed; a corrected one from the queried invoice)
  var invRows = [];
  // R262 (0452): an approved price stays: the products and prices are fixed, fewer pieces and a discount are fine
  function locked() { var c = cur && cur.confirmed; return !!(c && c.total != null && Number(c.total) > 0 && !cur.invoice_only && (c.lines || []).length); }
  function agreedLine(name) { var k = String(name || "").trim().toLowerCase(); return ((cur && cur.confirmed && cur.confirmed.lines) || []).filter(function (l) { return String(l.name || "").trim().toLowerCase() === k; })[0] || null; }
  function addInvRow(l) {
    var i = invRows.length, n = invRows.seq = (invRows.seq || 0) + 1, row = el("fieldset", "vo-line"), lg = el("legend", "sr", "Product " + (i + 1)); row.appendChild(lg);
    var nw = el("div"), nl = el("label", "", "Product"), ni = el("input"); nl.htmlFor = ni.id = "vi-n" + n; ni.maxLength = 120; ni.autocomplete = "off"; ni.value = l && l.name ? l.name : ""; nw.appendChild(nl); nw.appendChild(ni); row.appendChild(nw);
    var g = el("div", "vo-line-g"), q = field("vi-q" + n, "Quantity" + (l && l.unit ? " (" + l.unit + ")" : ""), l ? l.qty : 1), p = field("vi-p" + n, "Price each (" + sym() + ")", l && l.price != null ? l.price : "", { ph: "0" });
    g.appendChild(q.box); g.appendChild(p.box); row.appendChild(g);
    var f = el("div", "vo-line-f"), t = el("p", "vo-line-t"), x = el("button", "vr-x", "Remove"); x.type = "button"; f.appendChild(t); f.appendChild(x); row.appendChild(f);
    var rec = { n: ni, q: q.input, p: p.input, t: t, unit: l && l.unit ? l.unit : null, row: row, x: x };
    x.addEventListener("click", function () { if (invRows.length < 2) return; invRows.splice(invRows.indexOf(rec), 1); row.parentNode.removeChild(row); invSum(); });
    [ni, q.input, p.input].forEach(function (k) { k.addEventListener("input", invSum); });
    var ag = locked() && l ? agreedLine(l.name) : null;
    if (ag) { rec.ag = ag; ni.readOnly = true; row.classList.add("is-lock"); if (l.price != null) { p.input.readOnly = true; rec.lockPrice = true; } }
    invRows.push(rec); $("vi-lines").appendChild(row); return rec;
  }
  function invoiceLines(prev) {
    var on = flow(), box = $("vi-lines"); empty(box); invRows = [];
    $("vi-products").hidden = !on; $("vi-taxable-w").hidden = on; $("vi-sum").hidden = !on;
    var g = !on || cur.gst !== false; $("vi-gst-w").hidden = !g; $("vi-tax-w").hidden = g; if (!g) $("vi-gst").value = "none";
    if (!on) return;
    var c = cur.confirmed || {}, src = prev && Array.isArray(prev.lines) && prev.lines.length ? prev : c, ls = (src.lines || cur.lines || []).slice(0, 30);
    var lk = locked(); $("vi-lock").hidden = !lk; $("vi-lock").textContent = lk ? "The price was approved, so it stays as it is. Bring fewer? Lower the quantity. An extra cost? Ask " + String(cur.studio || "the studio") + " to add it." : "";
    if (lk) ls = ls.filter(function (l) { return agreedLine(l.name); }); if (lk && !ls.length) ls = c.lines.slice(0, 30);
    ls.forEach(function (l) {
      var ag = lk ? agreedLine(l.name) : null; if (ag && ag.price != null) l = Object.assign({}, l, { price: ag.price, qty: Math.min(Number(l.qty), Number(ag.qty)) });
      var p = l.price; if (p == null && ls.length === 1 && src.total != null && Number(l.qty) > 0 && r2(r2(src.total / l.qty) * l.qty) === r2(src.total)) p = r2(src.total / l.qty);
      addInvRow({ name: l.name, unit: l.unit, qty: l.qty, price: p });
    });
    if (!invRows.length) addInvRow({ name: String(cur.what || "").slice(0, 120), qty: 1 });
    $("vi-charges").value = Number(src.charges) > 0 ? src.charges : ""; $("vi-discount").value = Number(src.discount) > 0 ? src.discount : ""; $("vi-tax").value = prev && Number(prev.tax_amount) > 0 ? prev.tax_amount : "";
    invSum();
  }
  function readInv() {
    var sum = 0, bad = null, lines = invRows.map(function (r) {
      var n = r.n.value.replace(/\s+/g, " ").trim(), q = amount(r.q.value), p = amount(r.p.value);
      if (!bad && (!n || /[<>]/.test(n))) bad = { err: "Enter the product name (no < or >).", el: r.n.id };
      if (!bad && !(q > 0)) bad = { err: "Enter the quantity of " + n + ".", el: r.q.id };
      if (!bad && (p === null || isNaN(p))) bad = { err: "Enter the price of " + n + ".", el: r.p.id };
      if (!bad && r.ag && q > Number(r.ag.qty)) bad = { err: "Only " + qn(r.ag.qty) + " of " + n + " were approved.", el: r.q.id };
      if (q > 0 && p != null && !isNaN(p)) sum += r2(q * p);
      return { name: n, unit: r.unit, qty: q, price: p };
    });
    var ch = amount($("vi-charges").value), di = amount($("vi-discount").value), tx = amount($("vi-tax").value);
    if (!bad && isNaN(ch)) bad = { err: "Enter the charges as a number, or leave them empty.", el: "vi-charges" };
    if (!bad && isNaN(di)) bad = { err: "Enter the discount as a number, or leave it empty.", el: "vi-discount" };
    if (!bad && isNaN(tx)) bad = { err: "Enter the tax as a number, or leave it empty.", el: "vi-tax" };
    ch = ch || 0; di = di || 0; tx = cur.gst === false ? tx || 0 : 0;
    if (!bad && di > sum + ch) bad = { err: "The discount cannot be more than the price.", el: "vi-discount" };
    if (locked()) {
      var lc = cur.confirmed, mc = Number(lc.charges) || 0;
      if (!bad && ch > mc + 0.005) bad = { err: mc > 0 ? "The approved charges are " + inr(mc) + "." : "No extra charges were approved. Ask the studio to add them.", el: "vi-charges" };
      if (!bad && r2(sum + ch - di) > Number(lc.total) + 0.005) bad = { err: "The approved price is " + inr(lc.total) + " (before tax).", el: invRows[0] && invRows[0].p.id };
    }
    return Object.assign({ lines: lines, charges: ch, discount: di, tax: tx, taxable: r2(sum + ch - di) }, bad || {});
  }
  function invSum() {
    if (!flow()) return;
    invRows.forEach(function (r) { var q = amount(r.q.value), p = amount(r.p.value); r.t.textContent = q > 0 && p != null && !isNaN(p) ? qn(q) + " x " + inr(p) + " = " + inr(r2(q * p)) : ""; r.x.hidden = invRows.length < 2; });
    $("vi-add").hidden = invRows.length >= 30 || locked();
    var v = readInv(); $("vi-taxable").value = v.taxable > 0 ? v.taxable : ""; autoGst(); total();
  }
  function num(id) { var v = $(id).value.trim(); if (v === "") return 0; var n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : NaN; }
  function gstMode() { return $("vi-gst").value; }
  function autoGst() {
    var t = num("vi-taxable"), rate = Number($("vi-rate").value) || 0;
    if (!(t > 0)) return;
    if (gstMode() === "intra") { var half = Math.round(t * rate / 2) / 100; $("vi-cgst").value = half.toFixed(2); $("vi-sgst").value = half.toFixed(2); }
    if (gstMode() === "inter") $("vi-igst").value = (Math.round(t * rate) / 100).toFixed(2);
    total();
  }
  function showGst() {
    var m = gstMode();
    $("vi-rate-w").hidden = m === "none"; $("vi-cgst-w").hidden = m !== "intra"; $("vi-sgst-w").hidden = m !== "intra";
    $("vi-igst-w").hidden = m !== "inter"; $("vi-gstin-w").hidden = m === "none";
    autoGst(); total();
  }
  function parts() {
    var m = gstMode();
    return { taxable: num("vi-taxable"), cgst: m === "intra" ? num("vi-cgst") : 0, sgst: m === "intra" ? num("vi-sgst") : 0, igst: m === "inter" ? num("vi-igst") : 0 };
  }
  function total() {
    var p = parts(), t = p.taxable + p.cgst + p.sgst + p.igst;
    if (flow()) {
      t = r2(t + (readInv().tax || 0)); $("vi-sum-n").textContent = p.taxable > 0 && isFinite(t) ? inr(t) : "-";
      var ag = cur.agreed_amount; $("vi-total").textContent = !locked() && p.taxable > 0 && ag != null && Number(ag) > 0 && t > Number(ag) + 0.005 ? "This is above the agreed " + inr(ag) + ". The studio will check it." : "";
      return;
    }
    $("vi-total").textContent = isFinite(t) && p.taxable > 0 ? "Invoice total: " + inr(t) + (cur && Number(cur.agreed_amount) > 0 && t > Number(cur.agreed_amount) + 0.005 ? " (above the agreed " + inr(cur.agreed_amount) + " - the studio will check it)" : "") : "";
  }
  function openInvoice(prev) {
    replaces = prev && prev.status === "queried" ? prev.id : null;
    $("vr-inv-title").textContent = replaces ? "Send a corrected invoice" : "Send your invoice";
    $("vi-no").value = prev ? prev.invoice_no : "";
    // r37: the studio's day (India time; the vendor link does not carry the studio zone), not the vendor's browser day
    var iso = (function () { try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); } catch (e) { var t = new Date(); return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); } })();
    if (cur && /^\d{4}-\d{2}-\d{2}$/.test(String(cur.today || ""))) iso = cur.today;   // R259: the studio's own day
    $("vi-date").value = prev && prev.invoice_date_iso ? String(prev.invoice_date_iso).slice(0, 10) : iso;
    $("vi-taxable").value = prev ? prev.taxable_amount : "";
    $("vi-gst").value = prev ? (Number(prev.igst) > 0 ? "inter" : Number(prev.cgst) > 0 ? "intra" : "none") : "none";
    $("vi-cgst").value = prev ? prev.cgst : ""; $("vi-sgst").value = prev ? prev.sgst : ""; $("vi-igst").value = prev ? prev.igst : "";
    $("vi-gstin").value = prev && prev.vendor_gstin ? prev.vendor_gstin : ""; $("vi-notes").value = ""; $("vi-file").value = "";
    err("vi-err", ""); $("vr-inv-open").hidden = true; $("vr-inv-form").hidden = false;
    invoiceLines(prev); showGst(); if (prev) { $("vi-cgst").value = prev.cgst || ""; $("vi-sgst").value = prev.sgst || ""; $("vi-igst").value = prev.igst || ""; total(); }
    setTimeout(function () { $("vi-no").focus(); }, 0);
  }
  function closeInvoice() { $("vr-inv-form").hidden = true; $("vr-inv-open").hidden = false; replaces = null; }
  // the file's real type from its first bytes (never from its name)
  function sniff(file) {
    return file.slice(0, 16).arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf), s = function (i, arr) { return arr.every(function (x, k) { return b[i + k] === x; }); };
      if (s(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
      if (s(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
      if (s(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
      if (s(0, [0x52, 0x49, 0x46, 0x46]) && s(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
      return null;
    });
  }
  function validate() {
    var no = $("vi-no").value.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z0-9\/-]{1,16}$/.test(no)) return { err: "Invoice number: up to 16 letters, digits, - or /.", el: "vi-no" };
    var d = $("vi-date").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { err: "Enter the invoice date.", el: "vi-date" };
    var iv = flow() ? readInv() : null;
    if (iv && iv.err) return { err: iv.err, el: iv.el };
    var p = parts(); if (iv) p.taxable = iv.taxable;
    if (!(p.taxable > 0)) return { err: iv ? "Enter your prices." : "Enter the taxable value (above 0).", el: iv ? invRows[0].p.id : "vi-taxable" };
    if ([p.cgst, p.sgst, p.igst].some(function (x) { return !isFinite(x) || x < 0; })) return { err: "GST amounts must be 0 or more.", el: "vi-cgst" };
    if (gstMode() === "intra" && Math.abs(p.cgst - p.sgst) > 1) return { err: "CGST and SGST must be the same amount.", el: "vi-sgst" };
    var gstin = $("vi-gstin").value.replace(/\s+/g, "").toUpperCase();
    if (gstMode() !== "none" && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return { err: "Enter your 15-character GSTIN (e.g. 36ABCDE1234F1Z5).", el: "vi-gstin" };
    var notes = $("vi-notes").value.trim();
    if (/[<>]/.test(notes)) return { err: "Notes may not contain < or >.", el: "vi-notes" };
    var f = $("vi-file").files && $("vi-file").files[0];
    if (!f) return { err: "Attach the invoice (PDF or photo).", el: "vi-file" };
    if (f.size > MAX_BYTES) return { err: "The file is larger than 10 MB.", el: "vi-file" };
    return { no: no, date: d, p: p, gstin: gstMode() === "none" ? null : gstin, notes: notes || null, file: f, inv: iv };
  }
  function sendInvoice(ev) {
    if (ev) ev.preventDefault();
    var v = validate();
    if (v.err) { err("vi-err", v.err); try { $(v.el).focus(); } catch (e) { /* ignore */ } return; }
    err("vi-err", ""); $("vi-send").disabled = true; $("vi-send").textContent = "Sending…";
    var done = function (m) { $("vi-send").disabled = false; $("vi-send").textContent = "Send invoice"; if (m) err("vi-err", m); };
    upload(v.file, "vendor_invoice_upload").then(function (u) {
      if (u.err) return done(u.err);
      var body = { invoice_no: v.no, invoice_date: v.date, taxable_amount: v.p.taxable, cgst: v.p.cgst, sgst: v.p.sgst, igst: v.p.igst,
        vendor_gstin: v.gstin, notes: v.notes, file_path: u.path };
      if (replaces) body.replaces_id = replaces;
      if (v.inv) { body.lines = v.inv.lines; body.charges = v.inv.charges; body.discount = v.inv.discount; if (v.inv.tax > 0) body.tax = v.inv.tax;
        body.key = keyFor(JSON.stringify([v.no, v.date, v.p, v.inv.lines, v.inv.charges, v.inv.discount, v.inv.tax, v.file.name, v.file.size, replaces])); }
      return rpc("vendor_invoice_submit", { p_token: token, p: body }).then(function (r) {
        if (!r.ok) return done(say(r.error, "Could not send the invoice just now. Please try again."));
        if (!r.data || r.data.ok !== true) { done(); return render(r.data); }
        done(); closeInvoice(); lastKey = null; lastSig = ""; render(r.data);
        $("vr-now").textContent = "Thank you - invoice " + (r.data.submitted || v.no) + " was sent to " + (r.data.studio || "the studio") + " for approval.";
        if (flow()) top();
      });
    });
  }

  function start() {
    $("vr-accept").addEventListener("click", function () { openAnswer("accept"); });
    $("vr-reject").addEventListener("click", function () { openAnswer("reject"); });
    $("vr-answer-form").addEventListener("submit", sendAnswer);
    $("vr-answer-back").addEventListener("click", function () { $("vr-answer-form").hidden = true; $("vr-answer").querySelector(".vr-actions").hidden = false; });
    $("vr-offer").addEventListener("submit", sendOffer);
    $("vo-back").addEventListener("click", closeOffer);
    $("vo-one").addEventListener("change", sumOffer);
    ["vo-total", "vo-charges", "vo-discount"].forEach(function (id) { $(id).addEventListener("input", sumOffer); });
    $("vi-add").addEventListener("click", function () { if (invRows.length < 30) { var r = addInvRow(null); invSum(); r.n.focus(); } });
    ["vi-charges", "vi-discount", "vi-tax"].forEach(function (id) { $(id).addEventListener("input", invSum); });
    $("vr-inv-open").addEventListener("click", function () { openInvoice(null); });
    $("vi-cancel").addEventListener("click", closeInvoice);
    $("vr-inv-form").addEventListener("submit", sendInvoice);
    $("vi-gst").addEventListener("change", showGst);
    $("vi-rate").addEventListener("change", autoGst);
    $("vi-taxable").addEventListener("input", autoGst);
    ["vi-cgst", "vi-sgst", "vi-igst"].forEach(function (id) { $(id).addEventListener("input", total); });
    if (!TOKEN_RE.test(token)) return render(null);
    rpc("vendor_link_get", { p_token: token }).then(function (r) {
      if (!r.ok) return bad("Something went wrong", "We could not load this link just now. Please try again in a minute.");
      render(r.data);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();

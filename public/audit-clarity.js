/* audit-clarity.js - R136: the audit log in plain words (owner, 11 Nov 2026).
 *   1  Changes Helm makes by itself on a person's behalf read "Helm (automatic)" with "from quote ... after <person> saved it"
 *      (new rows: changed._via = 'quote_sync', migration 0340; old rows only when it is safely deducible - see autoInfo()).
 *   2  The quote's client details show before -> after for non-sensitive fields only (budget, guests, city, date ...);
 *      phone / e-mail / address and anything not on the allow-list stay names-only ("Phone changed").
 *   3  One summary line per editing session (same person, same event, within 5 minutes), expandable to every step with
 *      seconds; exact duplicate rows fold into one with a x2 badge. Server-side search / area filter still pick the rows.
 *   4  Money in the studio's currency (Indian grouping for INR, via BPStore.studioMoney / HelmCountry.formatMoney),
 *      "(empty)" instead of the empty-set sign, technical tokens and snake_case names in plain words, seconds on hover.
 *   5  Event column: "<event name> . <client name>" with the code underneath (one batched, RLS-scoped read).
 * DOM is built with createElement + textContent only (strict CSP + Trusted Types). Money values carry data-money so the
 * "Hide amounts" screen (shell-b-privacy.js) masks them here too. Pure helpers are unit-tested in
 * test/r136-audit-clarity.test.mjs (node: module.exports; browser: window.AuditClarity). */
(function (root) {
  "use strict";
  var GAP_MS = 5 * 60 * 1000, SPAN_MS = 30 * 60 * 1000, DUP_MS = 3000, MAX_LINES = 5, MAX_BITS = 6;
  var EMPTY = "(empty)";

  function B() { return root && root.BPStore ? root.BPStore : null; }
  function AF() { return (root && root.AuditFormat) || null; }
  function snake(k) { return String(k == null ? "" : k).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s.-]+/g, "_").toLowerCase(); }
  function titleWords(s) {
    s = snake(s).replace(/_+/g, " ").trim();
    return s ? s.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }) : "";
  }
  function sentence(s) { s = String(s == null ? "" : s).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function isEmpty(v) { return v == null || v === "" || (typeof v === "string" && !v.trim()); }
  function obj(v) { if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { return null; } } return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  function numeric(v) { if (typeof v === "number") return isFinite(v) ? v : null; if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v); return null; }
  function trunc(s, n) { s = String(s); n = n || 60; return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  /* ---- money ---------------------------------------------------------------------------------------------------- */
  var MONEY_RE = /(^|_)(budget|total|subtotal|grand_total|amount|amounts|price|prices|payment|payments|paid|discount|advance|balance|fee|fees|cost|costs|revenue|deposit|per_person|value|charge|charges|refund|payout)(_|$)/;
  var NOT_MONEY_RE = /(^|_)(pct|percent|percentage|rate|count|qty|quantity|at|id|by|type|kind|mode|status|method|reason|ref|currency|no|number|on|date)$/;
  function isMoneyKey(k) { var s = snake(k); return MONEY_RE.test(s) && !NOT_MONEY_RE.test(s); }
  // the studio's currency: ctx.money(n) when given (tests), else BPStore.studioMoney (India: Rs with en-IN grouping;
  // UAE: AED 800,000), else country-profile.js for ctx.country (default India). Never a new formatter.
  function money(n, ctx) {
    ctx = ctx || {}; var x = Number(n); if (!isFinite(x)) return String(n);
    if (typeof ctx.money === "function") return ctx.money(x);
    var b = B(); if (!ctx.country && b && typeof b.studioMoney === "function") { try { return b.studioMoney(x); } catch (e) {} }
    var C = (root && root.HelmCountry) || ctx.HelmCountry || null;
    if (C && typeof C.formatMoney === "function") return C.formatMoney(x, ctx.country || "IN");
    return "₹" + x.toLocaleString("en-IN");
  }

  /* ---- privacy: which values may be shown ----------------------------------------------------------------------- */
  // contact / identity details: a substring anywhere in the name, or a whole word of it ("pan" yes, "company" no)
  var SENSITIVE_SUB = /(phone|mobile|whatsapp|e_?mail|address|birth|password|passcode|secret|token)/;
  var SENSITIVE_WORD = { addr: 1, pan: 1, aadhaar: 1, aadhar: 1, gstin: 1, gst_no: 1, passport: 1, dob: 1, emergency: 1, bank: 1, ifsc: 1, upi: 1, otp: 1, pin: 1, contact: 1 };
  function isSensitiveKey(k) { var s = snake(k); return SENSITIVE_SUB.test(s) || s.split("_").some(function (w) { return !!SENSITIVE_WORD[w]; }); }
  // the quote's client details whose VALUE may appear in the log (everything else: field name only)
  var CLIENT_SHOW = { name: 1, company: 1, budget: 1, guests: 1, guest_count: 1, chairs: 1, tables: 1, plates: 1, rounds: 1, adults: 1,
    kids: 1, city: 1, state: 1, region: 1, country: 1, event_date: 1, event_type: 1, event_time: 1, date: 1, time: 1, type: 1 };

  /* ---- labels + values ------------------------------------------------------------------------------------------ */
  var LABELS = { guests: "Guests", guest_count: "Guests", budget: "Budget", event_date: "Event date", event_type: "Event type",
    event_time: "Event time", current_version: "Quote version", deleted_reason: "Reason", archived_reason: "Archive reason",
    lifecycle_stage: "Stage", approval_status: "Client approval", status: "Status", source: "Source", name: "Name", city: "City",
    state: "State", company: "Company", chairs: "Chairs", tables: "Tables", notes: "Notes", title: "Event name", code: "Code" };
  // the summary line's field name (quotes.client.guests and leads.guest_count are the same thing)
  var FIELD_ALIAS = { guest_count: "guests", event_date: "event date", event_type: "event type" };
  function fieldLabel(k) { var s = snake(k); return LABELS[s] || titleWords(s) || "Field"; }
  function fieldName(k) { var s = snake(k); return FIELD_ALIAS[s] || fieldLabel(s).toLowerCase(); }
  var TOKENS = { auto_empty_draft: "removed automatically because it was left empty", link_expired: "the client link expired",
    manual: "removed by hand", quote_sync: "kept in step with the quote" };
  var ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, ISO_D = /^\d{4}-\d{2}-\d{2}$/;
  // one value as display segments: [{t, money?}]
  function valueSegs(k, v, ctx) {
    if (isEmpty(v)) return [{ t: EMPTY }];
    if (typeof v === "boolean") return [{ t: v ? "Yes" : "No" }];
    var n = numeric(v);
    if (n != null && isMoneyKey(k)) return [{ t: money(n, ctx), money: true }];
    if (n != null) return [{ t: String(n) }];
    if (typeof v === "object") return [{ t: "(details)" }];
    var s = String(v), f = AF();
    if (TOKENS[s]) return [{ t: TOKENS[s] }];
    if (ISO_TS.test(s) && f && f.fmtTs) return [{ t: f.fmtTs(s) }];
    if (ISO_D.test(s) && f && f.fmtDate) return [{ t: f.fmtDate(s) }];
    if (/^[a-z]+(_[a-z]+)+$/.test(s) || /^(status|approval_status|lifecycle_stage|stage|source|role|kind)$/.test(snake(k))) return [{ t: sentence(s) }];
    return [{ t: trunc(s, 60) }];
  }
  function segText(segs) { return (segs || []).map(function (s) { return s.t; }).join(""); }

  /* ---- one row -> lines ------------------------------------------------------------------------------------------ */
  // line = { segs, field (summary name) | null, sum (segments for the summary value) | null }
  function line(segs, field, sum) { return { segs: segs, field: field || null, sum: sum || null }; }
  function changeLine(k, o, n, ctx, label) {
    var lab = label || fieldLabel(k), fname = fieldName(k);
    if (isSensitiveKey(k)) {
      var verb = isEmpty(o) ? (isEmpty(n) ? "changed" : "added") : (isEmpty(n) ? "removed" : "changed");
      return line([{ t: lab + " " + verb }], fname, null);
    }
    var nv = valueSegs(k, n, ctx), ov = valueSegs(k, o, ctx);
    var showSum = numeric(n) != null && (isMoneyKey(k) || /guest|chair|table|plate|round|adult|kid/.test(snake(k)));
    // "(empty)" is never struck through / coloured
    var mark = function (cls, v) { return function (s) { return Object.assign({ cls: isEmpty(v) ? "muted" : cls }, s); }; };
    return line([{ t: lab + ": " }].concat(ov.map(mark("o", o)), [{ t: " → " }], nv.map(mark("n", n))), fname, showSum ? nv : null);
  }
  var SKIP_KEYS = { updated_at: 1, confirmed_at: 1, _via: 1, _via_quote: 1, deleted_by: 1, auto_discarded_at: 1, org_id: 1, id: 1 };
  function clientLines(o, n, ctx) {
    var a = obj(o) || {}, b = obj(n) || {}, out = [];
    var keys = Object.keys(Object.assign({}, a, b)).filter(function (f) { return JSON.stringify(a[f]) !== JSON.stringify(b[f]); });
    if (!a.name && b.name) out.push(line([{ t: "Client set to " + trunc(b.name, 40) }], "client", null));
    keys.forEach(function (f) {
      if (f === "name" && !a.name && b.name) return;
      var s = snake(f);
      if (!CLIENT_SHOW[s] || isSensitiveKey(s)) { out.push(line([{ t: fieldLabel(s) + " changed" }], fieldName(s), null)); return; }
      out.push(changeLine(s, a[f], b[f], ctx));
    });
    if (!out.length) out.push(line([{ t: "Client details updated" }], "client", null));
    return out;
  }
  function totalOf(v) { var o = obj(v); if (o) { var t = o.total != null && o.total !== "" ? o.total : (o.grand_total != null && o.grand_total !== "" ? o.grand_total : o.grandTotal); return numeric(t); } return numeric(v); }
  function updateLines(c, ctx) {
    var out = [];
    Object.keys(c || {}).forEach(function (k) {
      if (SKIP_KEYS[k]) return;
      var p = c[k], pair = Array.isArray(p) && p.length === 2, o = pair ? p[0] : null, n = pair ? p[1] : p, f = AF();
      switch (k) {
        case "client": out.push.apply(out, clientLines(o, n, ctx)); return;
        case "pricing": { var a = totalOf(o), b = totalOf(n);
          if (b == null) { out.push(line([{ t: a == null ? "Pricing updated" : "Pricing cleared" }], "pricing", null)); return; }
          if (a == null) { out.push(line([{ t: "Total set to " }, { t: money(b, ctx), money: true, cls: "n" }], "total", [{ t: money(b, ctx), money: true }])); return; }
          if (a === b) { out.push(line([{ t: "Pricing details updated (total " }, { t: money(b, ctx), money: true }, { t: ")" }], "pricing", null)); return; }
          out.push(line([{ t: "Total: " }, { t: money(a, ctx), money: true, cls: "o" }, { t: " → " }, { t: money(b, ctx), money: true, cls: "n" }], "total", [{ t: money(b, ctx), money: true }])); return; }
        case "current_version": out.push(line([{ t: "Saved quote version " + trunc(n == null ? "" : n, 10) }], "saved version " + trunc(n == null ? "" : n, 10), null)); return;
        case "deleted_reason":
          if (n === "auto_empty_draft") { out.push(line([{ t: "Removed automatically because it was left empty" }], "removed (empty draft)", null)); return; }
          if (isEmpty(n)) return;   // restored: the deleted_at line says so
          out.push(line([{ t: "Reason: " + segText(valueSegs(k, n, ctx)) }], "reason", null)); return;
        case "deleted_at": out.push(line([{ t: isEmpty(n) ? "Restored from the bin" : "Moved to the bin" }], isEmpty(n) ? "restored" : "moved to the bin", null)); return;
        case "archived_at": out.push(line([{ t: isEmpty(n) ? "Taken out of the archive" : "Archived" }], isEmpty(n) ? "unarchived" : "archived", null)); return;
        case "tax_snapshot": case "event_date": case "approval_token": case "share_token": case "token": case "portal_token":
          if (f && f.describe) { out.push(line([{ t: f.describe(k, o, n) }], k === "event_date" ? "event date" : k === "tax_snapshot" ? "tax" : "approval link", null)); return; }
          break;
        default: break;
      }
      if (!pair) { out.push(line([{ t: fieldLabel(k) + ": " }].concat(valueSegs(k, n, ctx)), fieldName(k), null)); return; }
      if (obj(o) || obj(n) || Array.isArray(o) || Array.isArray(n)) { out.push(line([{ t: fieldLabel(k) + " updated" }], fieldName(k), null)); return; }
      out.push(changeLine(k, o, n, ctx));
    });
    return out;
  }
  var PICK = ["code", "title", "name", "status", "role", "amount", "price", "qty", "kind", "key"];
  function pickSegs(c, ctx) {
    var segs = [];
    PICK.filter(function (k) { return c[k] != null && c[k] !== ""; }).slice(0, 4).forEach(function (k, i) {
      if (i) segs.push({ t: " · " });
      if (k === "name" || k === "title" || k === "code") { segs.push({ t: trunc(c[k], 40) }); return; }
      segs.push({ t: fieldLabel(k).toLowerCase() + " " }); segs.push.apply(segs, valueSegs(k, c[k], ctx));
    });
    return segs;
  }
  // plain sentences for the settings actions ("comms_settings.set" read "Comms settings set")
  var ACTION_TEXT = { "comms_settings.set": "Changed message settings", "studio_email_settings.set": "Changed e-mail settings",
    "delivery_settings.set": "Changed delivery reminder settings", "automation_settings.set": "Changed automation settings",
    "inbox_settings.set": "Changed inbox settings", "privacy_pin.set": "Changed the Hide amounts PIN", "privacy_pin.reset": "Reset the Hide amounts PIN to 0000",
    "pricing.update": "Changed pricing settings" };
  function actionLabel(a, ctx) {
    a = String(a || "");
    if (/\.set$/.test(a)) return "Changed";
    if (/\.reset$/.test(a)) return "Reset";
    if (ctx && typeof ctx.actionLabel === "function") return ctx.actionLabel(a);
    return { insert: "Created", update: "Edited", delete: "Deleted" }[a] || sentence(a.split(".").pop());
  }
  function describe(r, ctx) {
    r = r || {}; ctx = ctx || {}; var a = String(r.action || ""), c = (r.changed && typeof r.changed === "object") ? r.changed : {};
    if (ACTION_TEXT[a]) return [line([{ t: ACTION_TEXT[a] }], null, null)];
    if (/^profile\./.test(a)) {
      var out = Object.keys(c).filter(function (k) { return k !== "by"; }).map(function (k) { var v = c[k];
        if (v && typeof v === "object" && !Array.isArray(v)) {
          if ("changed" in v) return line([{ t: fieldLabel(k) + (v.set ? " changed" : " removed") }], fieldName(k), null);
          if ("old" in v || "new" in v) return changeLine(k, v.old, v["new"], ctx);   // server-masked values (0041)
        }
        return line([{ t: fieldLabel(k) + ": " }].concat(valueSegs(k, v, ctx)), fieldName(k), null); });
      if (c.by === "admin") out.push(line([{ t: "(by an admin)" }], null, null));
      return out.length ? out : [line([{ t: "Profile updated" }], null, null)];
    }
    if (a === "update") { var u = updateLines(c, ctx); return u.length ? u : [line([{ t: "Edited" }], null, null)]; }
    if (a === "insert" || a === "delete") {
      var p = pickSegs(c, ctx), noun = r.entity === "leads" ? "lead " : "";
      return [line([{ t: (a === "insert" ? "Created " : "Deleted ") + (p.length ? noun : "a record") }].concat(p), a === "insert" ? "created" : "deleted", null)];
    }
    var d = typeof ctx.describe === "function" ? ctx.describe(r) : null;
    return [line([{ t: d != null ? String(d) : (sentence(a.replace(/\./g, " ")) || "Activity") }], null, null)];
  }

  /* ---- who: a person, or Helm acting for them ------------------------------------------------------------------- */
  var LEAD_SYNC_KEYS = { name: 1, email: 1, phone: 1, event_type: 1, event_date: 1, budget: 1, guest_count: 1, status: 1, quote_id: 1 };
  function personKey(r) { return String((r && (r.actor || r.actor_email || (r.changed && r.changed.run_by))) || "system"); }
  // { auto, probable, kind, quoteId } or null. probable = an OLD row (before 0340) that can only be the quote -> lead
  // sync: a lead change in the very same transaction (identical time) as a change to that quote by the same person.
  function autoInfo(r, rows) {
    var c = (r && r.changed && typeof r.changed === "object") ? r.changed : {};
    if (c._via === "quote_sync") return { auto: true, probable: false, kind: "quote_sync", quoteId: c._via_quote || r.quote_id || null };
    if (r.entity === "quotes" && r.action === "update" && Array.isArray(c.deleted_reason) && c.deleted_reason[1] === "auto_empty_draft")
      return { auto: true, probable: false, kind: "empty_draft", quoteId: r.quote_id || null };
    if (/^quote\.moved_to_(deleted|archive)$/.test(String(r.action || "")) && c.auto === true)
      return { auto: true, probable: false, kind: r.action === "quote.moved_to_archive" ? "auto_archive" : "auto_bin", quoteId: r.quote_id || null };
    if (r.entity !== "leads" || !r.quote_id || !r.at || !(r.action === "insert" || r.action === "update")) return null;
    if (r.action === "insert" && c.source !== "quote") return null;
    if (r.action === "update" && Object.keys(c).some(function (k) { return !LEAD_SYNC_KEYS[k]; })) return null;
    var sib = (rows || []).some(function (x) { return x && x !== r && x.entity === "quotes" && x.quote_id === r.quote_id
      && String(x.at) === String(r.at) && personKey(x) === personKey(r); });
    return sib ? { auto: true, probable: true, kind: "quote_sync", quoteId: r.quote_id } : null;
  }
  function personLabel(r, ctx) {
    var w = typeof ctx.who === "function" ? ctx.who(r) : null;
    if (w && w.text) return w;
    return { text: (r && r.actor_email) || "System", title: (r && r.actor_email) || "" };
  }
  function who(r, ctx, rows) {
    ctx = ctx || {}; var ai = autoInfo(r, rows || ctx.rows);
    if (!ai) return personLabel(r, ctx);
    var hasPerson = !!(r.actor || (r.actor_email && r.actor_email !== "helm:maintenance"));
    var p = hasPerson ? personLabel(r, ctx).text : "";
    var head = ai.probable ? "Helm (probably automatic)" : "Helm (automatic)", sub;
    if (ai.kind === "quote_sync") {
      var ev = ai.quoteId && ctx.events ? ctx.events[ai.quoteId] : null, q = ev ? (ev.label || ev.title || ev.code) : "";
      sub = "from quote" + (q ? " " + q : "") + (p ? " · after " + p + " saved it" : "");
    } else if (ai.kind === "empty_draft") sub = "empty draft tidied away" + (p ? " · while " + p + " was signed in" : "");
    else sub = ai.kind === "auto_archive" ? "the client link expired" : "tidied away automatically";
    return { text: head, sub: sub, auto: true, probable: ai.probable,
      title: ai.kind === "quote_sync" ? "Helm updated the CRM lead by itself to match the quote" + (ai.probable ? " (worked out from the time - older entry)" : "") : "Done by Helm, not typed by a person" };
  }

  /* ---- grouping + duplicates ------------------------------------------------------------------------------------ */
  function t(r) { var x = Date.parse(r && r.at); return isFinite(x) ? x : 0; }
  function stable(v) { if (v == null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    return "{" + Object.keys(v).filter(function (k) { return k !== "_via" && k !== "_via_quote"; }).sort().map(function (k) { return JSON.stringify(k) + ":" + stable(v[k]); }).join(",") + "}"; }
  function sig(r) { return [r.entity, r.entity_id, r.action, personKey(r), stable(r.changed || null)].join("|"); }
  // fold exact duplicates (same thing, same person, within 3 s): [{row, count, rows}]
  function dedupe(rows) {
    var out = [];
    (rows || []).forEach(function (r) {
      var s = sig(r), hit = null;
      for (var i = out.length - 1; i >= 0 && !hit; i--) { if (out[i].sig === s && Math.abs(t(out[i].row) - t(r)) <= DUP_MS) hit = out[i]; }
      if (hit) { hit.count++; hit.rows.push(r); } else out.push({ row: r, count: 1, rows: [r], sig: s });
    });
    return out;
  }
  // rows newest first -> items: {type:'row', entry} | {type:'group', entries, newest, oldest}
  function group(rows) {
    var items = [], cur = null;
    function close() { if (!cur) return; var e = dedupe(cur.rows);
      if (e.length === 1) items.push({ type: "row", entry: e[0] }); else items.push({ type: "group", entries: e, rows: cur.rows });
      cur = null; }
    (rows || []).forEach(function (r) {
      var key = r && r.quote_id ? personKey(r) + "|" + r.quote_id : null, tm = t(r);
      if (cur && key && cur.key === key && cur.last - tm <= GAP_MS && cur.first - tm <= SPAN_MS) { cur.rows.push(r); cur.last = tm; return; }
      close();
      if (!key) { items.push({ type: "row", entry: { row: r, count: 1, rows: [r] } }); return; }
      cur = { key: key, rows: [r], first: tm, last: tm };
    });
    close();
    return items;
  }
  // "Edited quote: city, state, guests 150, budget Rs 8,00,000 (6 changes)" as segments
  function summary(entries, ctx) {
    var seen = {}, order = [], creates = false, onlyQuote = true;
    entries.slice().reverse().forEach(function (e) {   // oldest first, so the LAST value of a field wins
      var r = e.row; if (r.entity === "quotes" && r.action === "insert") creates = true;
      if (r.entity !== "quotes" && r.entity !== "leads") onlyQuote = false;
      if (autoInfo(r, ctx.rows)) return;   // Helm's own follow-up (the lead) repeats the quote's change: counted, not listed twice
      describe(r, ctx).forEach(function (l) { if (!l.field) return;
        if (!(l.field in seen)) order.push(l.field); seen[l.field] = l.sum || seen[l.field] || null; });
    });
    var verb = creates ? "Created quote" : onlyQuote ? "Edited quote" : "Changes to this event";
    var segs = [{ t: verb + ": " }], shown = order.slice(0, MAX_BITS);
    shown.forEach(function (f, i) { if (i) segs.push({ t: ", " }); segs.push({ t: f });
      if (seen[f]) { segs.push({ t: " " }); segs.push.apply(segs, seen[f]); } });
    if (!shown.length) segs.push({ t: "several steps" });
    if (order.length > MAX_BITS) segs.push({ t: " +" + (order.length - MAX_BITS) + " more" });
    segs.push({ t: " (" + entries.length + " changes)" });
    return segs;
  }

  /* ---- event column ---------------------------------------------------------------------------------------------- */
  function codeFrom(rows, qid) {
    for (var i = 0; i < (rows || []).length; i++) { var r = rows[i]; if (!r || r.quote_id !== qid || r.entity !== "quotes" || !r.changed) continue;
      var c = r.changed.code; if (Array.isArray(c)) c = c[1] || c[0]; if (typeof c === "string" && c) return c; }
    return "";
  }
  // {text, code, href, title} | null. Never money: name + client only (a name with an amount in it is cut at the amount).
  function eventLabel(r, events, rows) {
    if (!r || !r.quote_id) return null;
    var ev = events ? events[r.quote_id] : null, href = "event.html?id=" + encodeURIComponent(r.quote_id);
    if (!ev) { var c0 = codeFrom(rows, r.quote_id); return { text: c0 || "Event", code: "", href: href, title: c0 ? "" : "This event is deleted or you can't open it" }; }
    var name = String(ev.label || ev.title || "").trim().replace(/\s*(?:₹|Rs\.?|INR|AED)\s?[\d,.]+.*$/i, "");
    var cl = String(ev.client || "").trim(), code = String(ev.code || "");
    var text = [name && name !== code ? name : "", cl].filter(Boolean).join(" · ");
    if (!text) return { text: code || "Event", code: "", href: href, title: "" };
    return { text: text, code: code, href: href, title: [ev.title, cl, code].filter(Boolean).join(" · ") };
  }
  // ONE batched read of the events on screen (BPStore.quotes.byIds: RLS decides; an unreadable / deleted event is just
  // missing and falls back to its code). -> { <id>: { code, title, label, client } }
  async function loadEvents(ids) {
    var b = B(), list = Array.from(new Set((ids || []).filter(function (x) { return /^[0-9a-f-]{36}$/i.test(String(x)); }))).slice(0, 200), by = {};
    if (!b || !list.length) return by;
    try {
      var qs = await b.quotes.byIds(list), N = root && root.HelmEventName;
      (qs || []).forEach(function (q) { if (!q || !q.id) return;
        var label = ""; try { label = N && N.displayName ? N.displayName(q) : (q.title || ""); } catch (e) { label = q.title || ""; }
        by[q.id] = { code: q.code, title: q.title, label: label, client: (q.client && q.client.name) || "" }; });
      return by;
    } catch (e) {
      try { return (b.audit && b.audit.eventLabels) ? await b.audit.eventLabels(list) : by; } catch (e2) { return by; }
    }
  }

  /* ---- times ----------------------------------------------------------------------------------------------------- */
  function fmtWith(iso, F) {
    var b = B(); try { if (b && b.fmtStudioDate) { var o = b.fmtStudioDate(iso, { fmt: F }); if (o) return o; } } catch (e) {}
    try { return new Date(iso).toLocaleString("en-IN", Object.assign({ timeZone: "Asia/Kolkata" }, F)); } catch (e) { return String(iso || ""); }
  }
  function fmtFull(iso) { return fmtWith(iso, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function fmtSecs(iso) { return fmtWith(iso, { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

  /* ---- DOM ------------------------------------------------------------------------------------------------------- */
  function el(doc, tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function segsInto(doc, parent, segs) {
    (segs || []).forEach(function (s) {
      if (!s.money && !s.cls) { parent.appendChild(doc.createTextNode(s.t)); return; }
      var sp = el(doc, "span", s.cls || "", s.t); if (s.money) sp.setAttribute("data-money", ""); parent.appendChild(sp);
    });
  }
  function actCls(a) { return /^(insert|update|delete)$/.test(String(a)) ? String(a) : "other"; }
  function whoTd(doc, r, ctx) {
    var w = who(r, ctx), td = el(doc, "td", "who" + (w.auto ? " ac-auto" : ""));
    td.appendChild(el(doc, "div", "", w.text)); if (w.title) td.setAttribute("title", w.title);
    if (w.sub) td.appendChild(el(doc, "div", "ac-sub", w.sub));
    return td;
  }
  function changeTd(doc, entry, ctx) {
    var td = el(doc, "td", "chg"), lines = describe(entry.row, ctx);
    lines.slice(0, MAX_LINES).forEach(function (l) { var d = el(doc, "div"); segsInto(doc, d, l.segs); td.appendChild(d); });
    if (lines.length > MAX_LINES) td.appendChild(el(doc, "div", "muted", "+" + (lines.length - MAX_LINES) + " more"));
    if (entry.count > 1) { var b = el(doc, "span", "ac-dup", "×" + entry.count); b.setAttribute("title", "Saved " + entry.count + " times in a row (same change)");
      b.setAttribute("aria-label", "repeated " + entry.count + " times"); (td.firstChild || td).appendChild(b); }
    return td;
  }
  function eventTd(doc, r, ctx) {
    var td = el(doc, "td", "ac-ev"), L = eventLabel(r, ctx.events, ctx.rows);
    if (!L) { td.appendChild(el(doc, "span", "muted", "—")); return td; }
    var a = el(doc, "a", "code"); a.setAttribute("href", L.href); if (L.title) a.setAttribute("title", L.title);
    a.appendChild(el(doc, "span", "ac-ev-name", L.text)); if (L.code && L.code !== L.text) a.appendChild(el(doc, "span", "ac-ev-code", L.code));
    td.appendChild(a); return td;
  }
  function whenTd(doc, r, ctx, secs) {
    var td = el(doc, "td", "when", secs ? fmtSecs(r.at) : (typeof ctx.fmt === "function" ? ctx.fmt(r.at) : fmtFull(r.at)));
    td.setAttribute("title", fmtFull(r.at)); return td;
  }
  function rowTr(doc, entry, ctx, secs) {
    var r = entry.row, tr = el(doc, "tr", secs ? "ac-step" : "");
    tr.appendChild(whenTd(doc, r, ctx, secs)); tr.appendChild(whoTd(doc, r, ctx));
    var td = el(doc, "td"), sp = el(doc, "span", "act " + actCls(r.action), actionLabel(r.action, ctx)); sp.setAttribute("title", String(r.action || ""));
    td.appendChild(sp); tr.appendChild(td);
    var ta = el(doc, "td"); ta.appendChild(el(doc, "span", "ent", typeof ctx.areaLabel === "function" ? ctx.areaLabel(r.entity) : titleWords(r.entity))); tr.appendChild(ta);
    tr.appendChild(changeTd(doc, entry, ctx));
    if (secs) tr.appendChild(el(doc, "td", "")); else tr.appendChild(eventTd(doc, r, ctx));
    return tr;
  }
  var gid = 0;
  function groupTrs(doc, item, ctx) {
    var es = item.entries, first = es[0].row, last = es[es.length - 1].row, id = "acg" + (++gid);
    var tr = el(doc, "tr", "ac-group");
    var w = el(doc, "td", "when", typeof ctx.fmt === "function" ? ctx.fmt(first.at) : fmtFull(first.at));
    w.setAttribute("title", fmtFull(last.at) + " – " + fmtSecs(first.at)); tr.appendChild(w);
    // the person (an automatic step names the person in its own line when expanded)
    var person = es.map(function (e) { return e.row; }).filter(function (r) { return !autoInfo(r, ctx.rows); })[0] || first;
    var wtd = el(doc, "td", "who"), pl = personLabel(person, ctx); wtd.appendChild(el(doc, "div", "", pl.text)); if (pl.title) wtd.setAttribute("title", pl.title);
    var autos = es.filter(function (e) { return !!autoInfo(e.row, ctx.rows); }).length;
    if (autos) wtd.appendChild(el(doc, "div", "ac-sub", "+ " + autos + " automatic " + (autos === 1 ? "update" : "updates") + " by Helm"));
    tr.appendChild(wtd);
    var ta = el(doc, "td"); ta.appendChild(el(doc, "span", "act update", es.some(function (e) { return e.row.entity === "quotes" && e.row.action === "insert"; }) ? "Created" : "Edited")); tr.appendChild(ta);
    var main = es.filter(function (e) { return e.row.entity === "quotes"; })[0] || es[0];
    var tA = el(doc, "td"); tA.appendChild(el(doc, "span", "ent", typeof ctx.areaLabel === "function" ? ctx.areaLabel(main.row.entity) : titleWords(main.row.entity))); tr.appendChild(tA);
    var chg = el(doc, "td", "chg ac-sum"), txt = el(doc, "div"); segsInto(doc, txt, summary(es, ctx)); chg.appendChild(txt);
    var btn = el(doc, "button", "ac-toggle", "Show " + es.length + " steps"); btn.setAttribute("type", "button"); btn.setAttribute("aria-expanded", "false");
    chg.appendChild(btn); tr.appendChild(chg); tr.appendChild(eventTd(doc, first, ctx));
    var steps = es.map(function (e, i) { var s = rowTr(doc, e, ctx, true); s.id = id + "-" + i; s.hidden = true; return s; });
    btn.setAttribute("aria-controls", steps.map(function (s) { return s.id; }).join(" "));
    btn.addEventListener("click", function () {
      var open = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", open ? "true" : "false"); btn.textContent = open ? "Hide steps" : "Show " + es.length + " steps";
      steps.forEach(function (s) { s.hidden = !open; }); tr.classList.toggle("ac-open", open);
    });
    return [tr].concat(steps);
  }
  // draw the whole page of rows into the table body (replaces its content)
  function render(tbody, rows, ctx) {
    ctx = Object.assign({}, ctx || {}, { rows: rows || [] }); var doc = tbody.ownerDocument || root.document;
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    group(rows).forEach(function (it) {
      if (it.type === "row") tbody.appendChild(rowTr(doc, it.entry, ctx, false));
      else groupTrs(doc, it, ctx).forEach(function (x) { tbody.appendChild(x); });
    });
  }

  var api = { render: render, group: group, dedupe: dedupe, summary: summary, describe: describe, who: who, autoInfo: autoInfo,
    eventLabel: eventLabel, loadEvents: loadEvents, money: money, isMoneyKey: isMoneyKey, isSensitiveKey: isSensitiveKey,
    fieldLabel: fieldLabel, valueSegs: valueSegs, segText: segText, actionLabel: actionLabel, fmtFull: fmtFull, fmtSecs: fmtSecs,
    GAP_MS: GAP_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AuditClarity = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

/* =========================================================================
   HELM - "Continue where you left off" for the quote flow, v3 (owner, Oct 2026).
   The step each person last worked on in a quote's flow is kept ON THE SERVER, per quote and per
   person (0206 quote_flow_progress via BPStore.flowProgress), so the button no longer disappears
   on another device, after a timing race, or because another quote was opened.
     - flow.html: track() saves the step once when the flow opens (where the page lands, or the
       first step not done) and again whenever the step changes (debounced, only on a change).
       resumeStep() answers where to land when the flow is opened without a #step.
     - dashboard: the most recent unfinished quote of MINE, large, with Continue + Dismiss, and
       "N more in progress" -> quotes.html?view=inprogress. It is a dashboard block (#hdResume,
       data-block="resume") when the new dashboard is on; otherwise a row above the page content.
     - quotes.html: renderList() draws the "In progress" tab (whole studio, "last worked by").
     - event.html: renderBanner() - "This quote is at step 4 of 8 (Venue). Continue where you left off".
   "Unfinished" is decided by the server: not sent, no saved quotation version (step 8), not shelved,
   not trial sample data. Dismiss hides a quote for me until I next work on it.
   r154c (0350, owner Nov 2026): Home lists EVERY open quote of mine (up to 5, newest first, "See all N"), each with
   client / step reached / last edited, Continue + Hide; and a quote stays resumable until it is Confirmed - after the
   quotation is saved (step 8), locked or sent, Continue lands on step 9 "Share with client & approval". The list comes
   from my_open_quotes (BPStore.flowProgress.open); a database without 0350 falls back to my_unfinished_quotes.
   Hide = dismiss for me (never changes or deletes the quote); it comes back when I work on the quote again.
   r161 (owner, Nov 2026): ONE "Continue where you left off" banner wherever a not-yet-Confirmed quote is opened (event
   workspace, quote flow, Discovery, Proposal, the Quotes Confirm dialog) - mountBanner(): open quotes only (never Confirmed /
   later, cancelled, archived, deleted, sample data - the server decides, my_open_quotes), editors only (a view-only role gets
   no banner; lists keep "Open"), "Not now" hides it for this browser tab session (sessionStorage, ids only). Copy: "Next:
   Quotation (step 8 of 8) · Discovery and Proposal skipped" instead of "step 8 of 8 (Quotation). 2 of 8 steps done".
   Lists are ordered by the quote's LAST ACTIVITY (its own last save or anyone's last flow step), newest first, ties by
   created time (0356 on the server; sortRows() here too, so an older database orders the same way).
   Fallback (local mode, or a database without 0206): a browser copy with ONE ENTRY PER QUOTE
   (helm_flow_resume_v3_<uid>); a quote's entry is only ever removed for that quote.
   Only quote ids, display names and step keys are kept in the browser (no client data).
   DOM via createElement + textContent; CSS through __helmAdoptCss (CSP-safe).
   window.HelmFlowResume / require().
   ========================================================================= */
(function (root) {
  "use strict";
  var STEPS = { client: 1, discovery: 2, reqs: 3, venue: 4, menu: 5, proposal: 6, layout: 7, quote: 8, pay: 10 };   // r22: step 9 on the quote page is "Share with client & approval" (not tracked), the advance is step 10
  var ORDER = ["client", "discovery", "reqs", "venue", "menu", "proposal", "layout", "quote"];
  var TOTAL = 8;
  var LABELS = { client: "Client", discovery: "Discovery", reqs: "Requirements", venue: "Venue", menu: "Menu", proposal: "Proposal", layout: "Layout", quote: "Quotation", approve: "Share with client & approval", pay: "Advance payment" };
  // r154c: where Continue may LAND (STEPS = the steps the flow saves; step 9 "approve" is a landing only, never saved)
  var LAND = { client: 1, discovery: 2, reqs: 3, venue: 4, menu: 5, proposal: 6, layout: 7, quote: 8, approve: 9, pay: 10 };
  // r154c (0350): an open quote past step 8 - what it is waiting for (building = still in steps 1 to 8)
  var PHASES = { building: "", quoted: "Quotation saved · not shared yet", locked: "Locked · not sent yet", sent: "Sent · waiting for the client" };
  var HOME_MAX = 3;                    // Home: at most 3, then "See all" (R164, was 5)
  var MAX_AGE = 60 * 864e5;            // browser copy: 60 days (owner decision E)
  var MAX_LOCAL = 30;                  // browser copy: at most 30 quotes
  var DASH_DAYS = 60;                  // dashboard card: hide quotes idle longer than this
  var DONE = { confirmed: 1, cancelled: 1, lost: 1, closed: 1, settlement: 1 };
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ---------------- browser copy: one entry per quote ---------------- */
  function store() { try { return root.localStorage || null; } catch (e) { return null; } }
  function key(uid) { return "helm_flow_resume_v3_" + String(uid || "anon"); }
  function legacyKey(uid) { return "helm_flow_resume_" + String(uid || "anon"); }
  function readMap(uid, now) {
    var ls = store(), out = {}; if (!ls) return out; now = now || Date.now();
    try {
      var o = JSON.parse(ls.getItem(key(uid)) || "null");
      if (o && typeof o === "object" && !Array.isArray(o)) Object.keys(o).forEach(function (id) {
        var e = o[id]; if (!UUID.test(id) || !e || typeof e !== "object" || !STEPS[e.step]) return;
        if (now - (+e.at || 0) > MAX_AGE) return;
        out[id] = { quoteId: id, name: String(e.name || "").slice(0, 80), step: e.step, at: +e.at || 0, dismissed: !!e.dismissed };
      });
      // v2 kept ONE slot { quoteId, name, step, at }: carry it over once (never dropped for another quote)
      var old = JSON.parse(ls.getItem(legacyKey(uid)) || "null");
      if (old && typeof old === "object" && UUID.test(String(old.quoteId || "")) && STEPS[old.step] && !out[old.quoteId] && now - (+old.at || 0) <= MAX_AGE)
        out[old.quoteId] = { quoteId: String(old.quoteId), name: String(old.name || "").slice(0, 80), step: old.step, at: +old.at || 0, dismissed: false };
    } catch (e) {}
    return out;
  }
  function writeMap(uid, map) {
    var ls = store(); if (!ls) return false;
    var list = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.at - a.at; }).slice(0, MAX_LOCAL), o = {};
    list.forEach(function (e) { o[e.quoteId] = { name: e.name, step: e.step, at: e.at, dismissed: e.dismissed ? 1 : 0 }; });
    try { ls.setItem(key(uid), JSON.stringify(o)); try { ls.removeItem(legacyKey(uid)); } catch (x) {} return true; } catch (e) { return false; }
  }
  function read(uid, quoteId, now) { var m = readMap(uid, now); return quoteId ? (m[String(quoteId)] || null) : null; }
  function readAll(uid, now) { var m = readMap(uid, now); return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.at - a.at; }); }
  // saves THIS quote's entry only; every other quote's entry is left exactly as it was
  function record(uid, q, now) {
    if (!q || !UUID.test(String(q.quoteId || "")) || !STEPS[q.step]) return null;
    var m = readMap(uid, now), id = String(q.quoteId);
    var o = { quoteId: id, name: String(q.name || (m[id] && m[id].name) || "").slice(0, 80), step: q.step, at: now || Date.now(), dismissed: false };
    m[id] = o; return writeMap(uid, m) ? o : null;
  }
  // removes ONE quote's entry (a quote id is required: nothing is ever cleared because another quote was opened)
  function clear(uid, quoteId) {
    if (!quoteId) return false; var m = readMap(uid), id = String(quoteId);
    if (!m[id]) return false; delete m[id]; return writeMap(uid, m);
  }
  function dismissLocal(uid, quoteId) { var m = readMap(uid), id = String(quoteId || ""); if (!m[id]) return false; m[id].dismissed = true; return writeMap(uid, m); }
  function lastStep(uid, quoteId) { var o = read(uid, quoteId); return o ? o.step : null; }

  /* ---------------- pure helpers (tested in node) ---------------- */
  function unfinished(q) {
    if (!q) return false;
    if (q.deletedAt || q.archivedAt || q.deleted_at || q.archived_at) return false;
    var st = String(q.status || "").toLowerCase(), stage = String(q.lifecycleStage || q.lifecycle_stage || "").toLowerCase();
    if (DONE[st] || DONE[stage]) return false;
    var ap = String(q.approvalStatus || q.approval_status || "none").toLowerCase();
    if (ap && ap !== "none") return false;                       // sent to the client = finished here
    if (q.approvalToken || q.approval_token) return false;
    return true;
  }
  function stepNo(step) { return LAND[step] || 0; }
  // r154c: open = not yet Confirmed (client side, for the Quotes rows): building, quotation saved, locked or sent
  function isOpen(q) {
    if (!q) return false;
    if (q.deletedAt || q.archivedAt || q.deleted_at || q.archived_at || q.autoDiscardedAt || q.auto_discarded_at) return false;
    if (q.isDemo === true || q.is_demo === true) return false;
    var st = String(q.status || "quote").toLowerCase(), stage = String(q.lifecycleStage || q.lifecycle_stage || "quote").toLowerCase();
    var ap = String(q.approvalStatus || q.approval_status || "none").toLowerCase();
    if (st !== "quote" && st !== "confirmed") return false;
    if (["lead", "discovery", "proposal", "quote"].indexOf(stage) < 0) return false;
    return ap === "none" || ap === "sent";
  }
  function phaseOf(q) {
    var ap = String((q && (q.approvalStatus || q.approval_status)) || "none").toLowerCase();
    if (ap === "sent") return "sent";
    if (String((q && q.status) || "quote").toLowerCase() === "confirmed") return "locked";
    return "building";
  }
  function firstNotDone(done) {
    var d = {}; (Array.isArray(done) ? done : []).forEach(function (k) { d[k] = 1; });
    for (var i = 0; i < ORDER.length; i++) if (!d[ORDER[i]]) return ORDER[i];
    return "quote";
  }
  function validStep(s) { return STEPS[s] ? s : null; }
  function landStep(s) { return LAND[s] ? s : null; }
  function ago(ts, now) {
    var t = typeof ts === "number" ? ts : Date.parse(ts || ""); if (!isFinite(t)) return "";
    var s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
    if (s < 60) return "just now";
    var m = Math.round(s / 60); if (m < 60) return m + " min ago";
    var h = Math.round(m / 60); if (h < 24) return h + " h ago";
    var d = Math.round(h / 24); if (d === 1) return "yesterday"; if (d < 7) return d + " days ago";
    try { return "on " + new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: (function () { try { var B = (typeof window !== "undefined" && window.BPStore) || null, z = B && B.studioTimezone ? B.studioTimezone() : ""; if (z) return z; } catch (e) {} return "Asia/Kolkata"; })() }); } catch (e) { return ""; }   // r37: studio zone
  }
  function nameOf(r) {
    var q = { title: r.title, code: r.code, eventType: r.event_type || r.eventType, eventDate: r.event_date || r.eventDate, client: r.client || {} };
    try { var H = root.HelmEventName; var nm = H && H.displayName ? H.displayName(q) : ""; if (nm) return String(nm); } catch (e) {}
    return String(r.name || r.title || r.code || "your quote");
  }
  /* server row (my_unfinished_quotes) -> view model. mine: resume at MY step; studio: where the team stopped. */
  function fromServer(r, mine) {
    r = r || {};
    var done = Array.isArray(r.steps_done) ? r.steps_done.filter(function (k) { return ORDER.indexOf(k) >= 0; }) : [];
    var phase = PHASES.hasOwnProperty(r.phase) ? r.phase : "building";
    var step = validStep(mine ? (r.my_step || r.last_step) : (r.last_step || r.my_step)) || firstNotDone(done);
    if (phase !== "building") step = "approve";                       // r154c: past step 8 - share / approval is what is left
    var at = mine ? (r.my_step_at || r.activity || r.updated_at) : (r.last_step_at || r.activity || r.updated_at);
    // r154c: "last edited" = the newer of my last step and the quote's own last save
    var act = r.activity || at || null; if (mine && act && at && Date.parse(act) > Date.parse(at)) at = act;
    // r161: the quote's last activity = the newest of its own last save and anyone's last flow step (0356 does the same)
    [r.updated_at, r.last_step_at, r.my_step_at].forEach(function (x) { if (x && (!act || ts(x) > ts(act))) act = x; });
    if (mine && act && (!at || ts(act) > ts(at))) at = act;
    return { quoteId: String(r.id || ""), name: nameOf(r), code: r.code || "", client: (r.client && r.client.name) || "", eventType: r.event_type || "",
      step: step, stepNo: stepNo(step), stepLabel: LABELS[step], done: done.length, total: Number(r.steps_total) || TOTAL,
      at: at || null, activity: act, lastUser: r.last_user_name || "", lastByMe: r.last_by_me === true,
      lastAt: r.last_step_at || null, hasLast: !!r.last_step, phase: phase, phaseLabel: PHASES[phase], hidden: r.hidden === true, myStep: validStep(r.my_step),
      doneKeys: done, created: r.created_at || null };
  }
  function fromLocal(e) { return { quoteId: e.quoteId, name: e.name || "your quote", code: "", client: "", step: e.step, stepNo: stepNo(e.step), stepLabel: LABELS[e.step],
    done: null, total: TOTAL, at: e.at, activity: e.at, lastUser: "", lastByMe: true, lastAt: e.at, hasLast: true, phase: "building", phaseLabel: "", hidden: false }; }
  function stepText(v) { return v.stepNo > TOTAL ? "step " + v.stepNo + " · " + v.stepLabel : "step " + v.stepNo + " of " + TOTAL + " · " + v.stepLabel; }
  function progressText(v) { return v.done == null ? "" : v.done + " of " + (v.total || TOTAL); }
  /* r161 banner copy. skippedOf: the flow steps BEFORE the one Continue lands on that are not done (past step 8: any of 1-8) */
  function skippedOf(v) {
    if (!v || !Array.isArray(v.doneKeys)) return [];
    var d = {}; v.doneKeys.forEach(function (k) { d[k] = 1; });
    var upto = ORDER.indexOf(v.step); if (upto < 0) upto = LAND[v.step] > TOTAL ? ORDER.length : 0;
    var out = []; for (var i = 0; i < upto; i++) if (!d[ORDER[i]]) out.push(LABELS[ORDER[i]]);
    return out;
  }
  function andList(a) { return a.length < 2 ? (a[0] || "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  /* r162: "Next" names the first step at or after where they left off that is not done yet (steps before it are the skipped ones),
     so a left-off step that is already done no longer reads "Next: Client (step 1 of 8) · 1 of 8 steps done". Fallback: the left-off step.
     Continue still lands on the left-off step (href). */
  function nextStepOf(v) {
    if (!v) return null;
    var at = ORDER.indexOf(v.step); if (at < 0 || !Array.isArray(v.doneKeys)) return v.step;
    var d = {}; v.doneKeys.forEach(function (k) { d[k] = 1; });
    for (var i = at; i < ORDER.length; i++) if (!d[ORDER[i]]) return ORDER[i];
    return v.step;
  }
  function nextText(v) { var s = nextStepOf(v) || v.step, n = stepNo(s); return "Next: " + LABELS[s] + (n > TOTAL ? " (step " + n + ")" : " (step " + n + " of " + TOTAL + ")"); }
  // { next: "Next: Quotation (step 8 of 8)", note: "Discovery and Proposal skipped" | "3 of 8 steps done" | "" }
  function bannerText(v) {
    var sk = skippedOf(v), note = "";
    if (sk.length) note = andList(sk) + " skipped";
    else if (v.done != null && v.stepNo <= TOTAL && v.done > 0) note = progressText(v) + " steps done";
    return { next: nextText(v), note: note };
  }
  /* r161: newest activity first, ties by created time (newest first), then the order the server gave */
  function ts(x) { var t = Date.parse(x || ""); return isFinite(t) ? t : -Infinity; }
  function sortRows(rows) {
    return (rows || []).map(function (v, i) { return { v: v, i: i }; }).sort(function (a, b) {
      return (ts(b.v.activity) - ts(a.v.activity)) || (ts(b.v.created) - ts(a.v.created)) || (a.i - b.i);
    }).map(function (x) { return x.v; });
  }
  /* r161: "Not now" on the banner = hidden for this browser tab session only (quote ids only, never client data) */
  var HIDE_KEY = "helm_fr_banner_hidden";
  function sstore() { try { return root.sessionStorage || null; } catch (e) { return null; } }
  function hiddenIds() {
    try { var ss = sstore(), a = JSON.parse((ss && ss.getItem(HIDE_KEY)) || "[]"); return Array.isArray(a) ? a.filter(function (x) { return UUID.test(String(x)); }) : []; }
    catch (e) { return []; }
  }
  function bannerHidden(id) { return hiddenIds().indexOf(String(id || "")) >= 0; }
  function hideBanner(id) {
    id = String(id || ""); if (!UUID.test(id)) return false;
    var a = hiddenIds().filter(function (x) { return x !== id; }); a.push(id);
    try { var ss = sstore(); if (!ss) return false; ss.setItem(HIDE_KEY, JSON.stringify(a.slice(-50))); return true; } catch (e) { return false; }
  }
  function label(v, now) { var a = ago(v.at, now); return (v.name || "your quote") + " · " + stepText(v) + (a ? " · edited " + a : ""); }
  function href(v) { return "flow.html?quote=" + encodeURIComponent(v.quoteId) + "#sec-" + (landStep(v.step) || "client"); }
  function lastBy(v, now) { if (!v.lastUser || v.lastByMe) return ""; var a = ago(v.lastAt, now); return "Last worked on by " + v.lastUser + (a ? ", " + a : ""); }

  /* ---------------- store access ---------------- */
  function S() { return root.BPStore || null; }
  function withTimeout(p, ms, dflt) { return new Promise(function (res) { var t = setTimeout(function () { res(dflt); }, ms); Promise.resolve(p).then(function (v) { clearTimeout(t); res(v); }, function () { clearTimeout(t); res(dflt); }); }); }
  // wait for the store script AND BPStore.init() before deciding who the user is (v2 read "anon" too early)
  function ready(maxMs) {
    var t0 = Date.now(); maxMs = maxMs || 20000;
    return new Promise(function (res) {
      (function poll() {
        var s = S();
        if (s && s.auth && s.quotes) {
          Promise.resolve(typeof s.init === "function" ? s.init() : null).then(function () { res(s); }, function () { res(s); });
          return;
        }
        if (Date.now() - t0 > maxMs) return res(null);
        setTimeout(poll, 100);
      })();
    });
  }
  function whoami(s) {
    try { if (s.auth.enabled && s.auth.enabled()) { var u = s.auth.user(); return u && u.id ? u : null; } } catch (e) { return null; }
    return { id: "anon" };
  }
  function serverOn(s) { try { return !!(s && s.flowProgress && s.flowProgress.available && s.flowProgress.available()); } catch (e) { return false; } }
  /* the list: server first; browser copy only when the server has no 0206 / local mode */
  function load(s, uid, opts) {
    opts = opts || {}; var mine = opts.scope !== "studio";
    // r154c: open quotes until Confirmed (0350) when the store has it; else the 0206 list (building only)
    var fp = serverOn(s) ? s.flowProgress : null, get = fp && typeof fp.open === "function" ? fp.open : fp && fp.list;
    var server = fp ? Promise.resolve(get.call(fp, opts)).catch(function () { return { failed: true }; }) : Promise.resolve(null);
    return server.then(function (d) {
      if (d && d.failed) return { rows: [], total: 0, canEdit: false, source: "error" };            // offline / error: show nothing, no toast
      if (d && Array.isArray(d.rows)) return { rows: sortRows(d.rows.map(function (r) { return fromServer(r, mine); })), total: Number(d.total) || 0,
        canEdit: d.can_edit !== false, readOnly: d.read_only === true, source: "server", open: d.open === true };
      if (!mine || opts.quote) return { rows: [], total: 0, canEdit: true, source: "none" };        // no studio-wide list without the server
      var all = readAll(uid).filter(function (e) { return !e.dismissed && (!opts.maxDays || Date.now() - e.at <= opts.maxDays * 864e5); });
      return Promise.all(all.slice(0, 6).map(function (e) {
        return Promise.resolve(s.quotes.get(e.quoteId)).then(function (q) {
          if (!unfinished(q)) { clear(uid, e.quoteId); return null; }                               // only THIS quote's entry
          var v = fromLocal(e); try { var nm = nameOf({ title: q.title, code: q.code, event_type: q.eventType, event_date: q.eventDate, client: q.client }); if (nm) v.name = nm; } catch (x) {}
          return v;
        }, function () { return null; });                                                           // not found / offline: keep the entry
      })).then(function (vs) { vs = vs.filter(Boolean); return { rows: vs, total: vs.length, canEdit: true, source: "local" }; });
    });
  }
  function dismiss(s, uid, quoteId) {
    dismissLocal(uid, quoteId);
    if (serverOn(s)) return Promise.resolve(s.flowProgress.dismiss(quoteId)).catch(function () { return null; });
    return Promise.resolve({ ok: true, local: true });
  }

  /* ---------------- flow.html: where to land + save the step ---------------- */
  // Promise<{ step, mine, who, at } | null> - my last step, else where a teammate stopped, else the browser copy
  function resumeStep(s, uid, quoteId, ms) {
    var local = function () { var st = lastStep(uid, quoteId); return st ? { step: st, mine: true, who: "", at: null } : null; };
    if (!serverOn(s) || !UUID.test(String(quoteId || ""))) return Promise.resolve(local());
    return withTimeout(Promise.resolve(s.flowProgress.list({ scope: "studio", quote: quoteId, limit: 1 })).then(function (d) {
      var r = d && Array.isArray(d.rows) ? d.rows[0] : null;
      if (!d) return local();
      if (!r) return null;
      if (validStep(r.my_step)) return { step: r.my_step, mine: true, who: "", at: r.my_step_at || null };
      if (validStep(r.last_step)) return { step: r.last_step, mine: false, who: r.last_user_name || "A teammate", at: r.last_step_at || null };
      return null;
    }, function () { return local(); }), ms || 2500, local());
  }
  /* track({ quoteId, uid, name: fn, canEdit, store, delay }) -> { land(step), step(step), flush(), last() }
     Saves at most once per change, after `delay` ms of quiet; land() saves the opening step at once. */
  function track(o) {
    o = o || {}; var delay = o.delay == null ? 1500 : o.delay, last = null, pending = null, timer = null, stopped = false;
    function send(step) {
      pending = null; if (stopped || step === last) return Promise.resolve(null); last = step;
      var s = o.store || S(), uid = o.uid || "anon", nm = ""; try { nm = typeof o.name === "function" ? o.name() : (o.name || ""); } catch (e) {}
      var p = serverOn(s) ? Promise.resolve(s.flowProgress.mark(o.quoteId, step)).catch(function () { return null; }) : Promise.resolve({ ok: false, local: true });
      return p.then(function (r) {
        if (r && r.read_only) { stopped = true; return r; }                                      // read-only studio: stop trying
        if (!r || r.local || r.missing) record(uid, { quoteId: o.quoteId, name: nm, step: step });   // no 0206 / local mode / offline: browser copy
        return r;
      });
    }
    function step(st) {
      if (!o.canEdit || stopped || !STEPS[st] || !UUID.test(String(o.quoteId || ""))) return false;
      if (st === last && !pending) return false;
      pending = st; clearTimeout(timer);
      timer = setTimeout(function () { var p = pending; if (p) send(p); }, delay);
      return true;
    }
    function land(st) { if (!o.canEdit || !STEPS[st] || !UUID.test(String(o.quoteId || ""))) return Promise.resolve(null); clearTimeout(timer); return send(st); }
    function flush() { clearTimeout(timer); var p = pending; return p ? send(p) : Promise.resolve(null); }
    return { land: land, step: step, flush: flush, last: function () { return last; }, pending: function () { return pending; } };
  }

  /* ---------------- DOM ---------------- */
  var CSS = ".fr-card{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between}" +
    ".fr-main{flex:1 1 280px;min-width:0}.fr-eyebrow{font-size:12px;letter-spacing:.02em;color:var(--hb-ink2,var(--ink-2,#5b6470));margin:0 0 2px}" +
    ".fr-title{font-weight:650;font-size:16px;line-height:1.35;margin:0;overflow-wrap:anywhere}.fr-sub{font-size:13px;color:var(--hb-ink2,var(--ink-2,#5b6470));margin:4px 0 0;overflow-wrap:anywhere}" +
    ".fr-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.fr-acts .btn,.fr-acts .hd-btn,.fr-row .btn{min-height:44px;white-space:normal;height:auto}" +
    ".fr-more{display:inline-block;margin-top:8px;font-size:13px;color:var(--hb-acc,var(--accent,#1f6f4a));text-decoration:underline;text-underline-offset:2px}" +
    ".fr-bar{display:block;width:100%;max-width:220px;height:6px;border-radius:3px;background:var(--hb-line,var(--line,#e3e6ea));overflow:hidden;margin-top:6px}" +
    ".fr-bar>i{display:block;height:100%;background:var(--hb-acc,var(--accent,#1f6f4a));border-radius:3px}" +
    ".fr-bar.fr-w0>i{width:0}.fr-bar.fr-w1>i{width:12.5%}.fr-bar.fr-w2>i{width:25%}.fr-bar.fr-w3>i{width:37.5%}.fr-bar.fr-w4>i{width:50%}.fr-bar.fr-w5>i{width:62.5%}.fr-bar.fr-w6>i{width:75%}.fr-bar.fr-w7>i{width:87.5%}.fr-bar.fr-w8>i{width:100%}" +
    ".fr-list{display:grid;gap:10px}.fr-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1.3fr) minmax(0,1.4fr) auto;gap:6px 14px;align-items:center;padding:12px 14px;border:1px solid var(--hb-line,var(--line,#e3e6ea));border-radius:10px;background:var(--hb-card,var(--card,#fff))}" +
    ".fr-row .fr-n{font-weight:600;overflow-wrap:anywhere}.fr-row .fr-m{font-size:13px;color:var(--hb-ink2,var(--ink-2,#5b6470));overflow-wrap:anywhere}" +
    "@media (max-width:760px){.fr-row{grid-template-columns:1fr}.fr-row .btn{width:100%}}" +
    ".fr-banner{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;padding:10px 14px;margin:0 0 12px;border:1px solid var(--hb-line,var(--line,#e3e6ea));border-left:3px solid var(--hb-acc,var(--accent,#1f6f4a));border-radius:10px;background:var(--hb-card,var(--card,#fff))}" +
    ".fr-banner p{margin:0;overflow-wrap:anywhere}.fr-banner .fr-sub{margin:2px 0 0}.fr-banner .fr-title{font-size:15px;font-weight:500}.fr-banner .fr-title strong{font-weight:650}" +
    ".fr-banner .fr-skip{color:var(--hb-ink2,var(--ink-2,#5b6470))}.fr-banner .fr-phase{margin-top:4px}" +
    "@media (max-width:560px){.fr-banner .fr-acts{width:100%}.fr-banner .fr-acts>*{flex:1 1 0}}" +
    ".fr-note{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:13px;padding:8px 12px;margin:0 0 10px;border-radius:8px;background:var(--hb-soft,var(--soft,#f3f6f4));color:var(--hb-ink,var(--ink,#1d232a))}" +
    ".fr-note button{background:none;border:0;padding:6px 4px;min-height:32px;font:inherit;color:var(--hb-acc,var(--accent,#1f6f4a));text-decoration:underline;cursor:pointer}" +
    ".fr-empty{color:var(--hb-ink2,var(--ink-2,#5b6470));padding:14px 4px}" +
    ".fr-home{display:grid;gap:8px;margin:0;padding:0;list-style:none}" +
    ".fr-hrow{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--hb-line,var(--line,#e3e6ea));border-radius:10px;background:var(--hb-card,var(--card,#fff))}" +
    ".fr-hrow .fr-main{flex:1 1 240px}.fr-hrow .fr-title{font-size:15px}.fr-hrow .fr-title a{color:inherit;text-decoration:none}.fr-hrow .fr-title a:hover{text-decoration:underline}" +
    ".fr-phase{display:inline-block;font-size:12px;line-height:1.3;padding:2px 8px;margin:4px 0 0;border-radius:999px;background:var(--hb-soft,var(--soft,#f3f6f4));color:var(--hb-ink,var(--ink,#1d232a))}" +
    ".fr-foot{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;justify-content:space-between;margin-top:8px;font-size:13px;color:var(--hb-ink2,var(--ink-2,#5b6470))}" +
    ".fr-foot .fr-more{margin-top:0}" +
    "@media (max-width:560px){.fr-hrow .fr-acts{width:100%}.fr-hrow .fr-acts>*{flex:1 1 0}}";
  var cssDone = false;
  function css(doc) { if (cssDone) return; cssDone = true; try { if (typeof root.__helmAdoptCss === "function") root.__helmAdoptCss(doc || root.document, CSS); } catch (e) {} }
  function el(doc, tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function bar(doc, v) {
    var b = el(doc, "span", "fr-bar fr-w" + Math.max(0, Math.min(8, Math.round(v.done || 0))));
    b.setAttribute("role", "img"); b.setAttribute("aria-label", progressText(v) + " steps done"); b.appendChild(el(doc, "i")); return b;
  }
  /* dashboard / quotes card: the most recent one large + "N more in progress". opts: { btn:{primary,ghost}, onDismiss, canEdit } */
  function renderCard(host, data, opts) {
    var doc = host.ownerDocument || root.document; opts = opts || {}; css(doc);
    while (host.firstChild) host.removeChild(host.firstChild);
    var rows = (data && data.rows) || []; if (!rows.length) return null;
    var v = rows[0], more = Math.max(0, (Number(data.total) || rows.length) - 1), now = Date.now();
    var box = el(doc, "div", "fr-card"); box.setAttribute("data-quote", v.quoteId);
    var main = el(doc, "div", "fr-main");
    if (!opts.noEyebrow) main.appendChild(el(doc, "p", "fr-eyebrow", "Continue where you left off"));
    main.appendChild(el(doc, "p", "fr-title", label(v, now)));
    var sub = []; if (v.client) sub.push(v.client); if (v.done != null) sub.push(progressText(v) + " steps done"); var lb = lastBy(v, now); if (lb) sub.push(lb);
    if (sub.length) main.appendChild(el(doc, "p", "fr-sub", sub.join(" · ")));
    if (v.done != null) main.appendChild(bar(doc, v));
    if (more > 0) { var m = el(doc, "a", "fr-more", more + " more in progress →"); m.href = "quotes.html?view=inprogress"; main.appendChild(m); }
    box.appendChild(main);
    var acts = el(doc, "div", "fr-acts"), B = opts.btn || { primary: "btn primary", ghost: "btn" };
    if (data.canEdit !== false || opts.canEdit === true) {
      var a = el(doc, "a", B.primary, "Continue"); a.href = href(v); a.setAttribute("aria-label", "Continue " + v.name + " at " + stepText(v)); acts.appendChild(a);
    } else {
      var o = el(doc, "a", B.ghost, "Open"); o.href = "event.html?id=" + encodeURIComponent(v.quoteId); acts.appendChild(o);
    }
    var x = el(doc, "button", B.ghost, "Dismiss"); x.type = "button"; x.setAttribute("aria-label", "Dismiss " + v.name + " until you work on it again");
    x.addEventListener("click", function () { if (opts.onDismiss) opts.onDismiss(v, box); });
    acts.appendChild(x); box.appendChild(acts);
    host.appendChild(box); return box;
  }
  /* r154c Home: EVERY open quote of mine (newest first, at most opts.max = 5), each with client, step reached,
     last edited, what it waits for, Continue (Open for a view-only role) + Hide; "See all N" when there are more.
     opts: { btn:{primary,ghost}, onHide(v,row), max }. Returns the number of rows drawn. */
  function renderHome(host, data, opts) {
    var doc = host.ownerDocument || root.document; opts = opts || {}; css(doc);
    while (host.firstChild) host.removeChild(host.firstChild);
    var all = (data && data.rows) || [], max = opts.max || HOME_MAX, rows = all.slice(0, max), now = Date.now();
    if (!rows.length) return 0;
    var B = opts.btn || { primary: "btn primary", ghost: "btn" }, edit = data.canEdit !== false;
    var ul = el(doc, "ul", "fr-home"); ul.setAttribute("aria-label", "Quotes you can continue");
    rows.forEach(function (v) {
      var li = el(doc, "li", "fr-hrow"); li.setAttribute("data-quote", v.quoteId);
      var main = el(doc, "div", "fr-main"), t = el(doc, "p", "fr-title"), a0 = el(doc, "a", null, v.name || "your quote");
      a0.href = "event.html?id=" + encodeURIComponent(v.quoteId); t.appendChild(a0); main.appendChild(t);
      var ag = ago(v.at, now), sub = [];
      if (v.client) sub.push(v.client);
      sub.push("Reached " + stepText(v));
      if (ag) sub.push("edited " + ag);
      var lb = lastBy(v, now); if (lb) sub.push(lb);
      main.appendChild(el(doc, "p", "fr-sub", sub.join(" · ")));
      if (v.phaseLabel) main.appendChild(el(doc, "span", "fr-phase", v.phaseLabel));
      li.appendChild(main);
      var acts = el(doc, "div", "fr-acts");
      if (edit) { var go = el(doc, "a", B.primary, "Continue"); go.href = href(v); go.setAttribute("aria-label", "Continue " + v.name + " at " + stepText(v)); acts.appendChild(go); }
      else { var op = el(doc, "a", B.ghost, "Open"); op.href = "event.html?id=" + encodeURIComponent(v.quoteId); op.setAttribute("aria-label", "Open " + v.name); acts.appendChild(op); }
      var x = el(doc, "button", B.ghost, "Hide"); x.type = "button";
      x.setAttribute("aria-label", "Hide " + v.name + " from this list until you work on it again (the quote is not deleted)");
      x.title = "Hide from this list until you work on it again. The quote itself is not changed or deleted.";
      x.addEventListener("click", function () { if (opts.onHide) opts.onHide(v, li); });
      acts.appendChild(x); li.appendChild(acts); ul.appendChild(li);
    });
    host.appendChild(ul);
    var total = Math.max(Number(data.total) || 0, all.length), foot = el(doc, "div", "fr-foot");
    foot.appendChild(el(doc, "span", null, total === 1 ? "1 quote in progress" : total + " quotes in progress"));
    var all1 = el(doc, "a", "fr-more", total > rows.length ? "See all " + total + " →" : "Open the In progress list →");
    all1.href = "quotes.html?view=inprogress"; foot.appendChild(all1); host.appendChild(foot);
    return rows.length;
  }
  /* Quotes > In progress: every unfinished quote of the studio */
  function renderList(host, data, opts) {
    var doc = host.ownerDocument || root.document; opts = opts || {}; css(doc);
    while (host.firstChild) host.removeChild(host.firstChild);
    var rows = (data && data.rows) || [], now = Date.now();
    if (!rows.length) { host.appendChild(el(doc, "p", "fr-empty", opts.empty || (data && data.open ? "No quotes in progress. Every quote shows here until it is confirmed." : "No quotes in progress. Quotes appear here until their quotation is saved in step 8."))); return 0; }
    var list = el(doc, "div", "fr-list"); list.setAttribute("role", "list");
    rows.forEach(function (v) {
      var r = el(doc, "div", "fr-row"); r.setAttribute("role", "listitem"); r.setAttribute("data-quote", v.quoteId);
      var c1 = el(doc, "div"); var n = el(doc, "a", "fr-n", v.name); n.href = "event.html?id=" + encodeURIComponent(v.quoteId); c1.appendChild(n);
      c1.appendChild(el(doc, "div", "fr-m", [v.code, v.client].filter(Boolean).join(" · ") || "No client yet")); r.appendChild(c1);
      var c2 = el(doc, "div"); c2.appendChild(el(doc, "div", "fr-m", progressText(v) + " steps done")); c2.appendChild(bar(doc, v)); r.appendChild(c2);
      if (v.phaseLabel) c2.appendChild(el(doc, "span", "fr-phase", v.phaseLabel));
      var c3 = el(doc, "div"); c3.appendChild(el(doc, "div", "fr-m", (v.phase && v.phase !== "building" ? "Next: " : "Stopped at: ") + v.stepLabel));
      var who = v.hasLast ? (v.lastByMe ? "You" : (v.lastUser || "A teammate")) : "Not opened in the flow yet", a = v.hasLast ? ago(v.lastAt, now) : ago(v.activity, now);
      c3.appendChild(el(doc, "div", "fr-m", (v.hasLast ? "Last worked by " + who : who) + (a ? " · " + a : "")));
      if (v.hidden) c3.appendChild(el(doc, "div", "fr-m", "Hidden from your Home list"));
      r.appendChild(c3);
      var go = el(doc, "a", opts.btnClass || "btn primary", data.canEdit === false ? "Open" : "Continue");
      go.href = data.canEdit === false ? "event.html?id=" + encodeURIComponent(v.quoteId) : href(v);
      go.setAttribute("aria-label", (data.canEdit === false ? "Open " : "Continue ") + v.name + " at " + v.stepLabel); r.appendChild(go);
      list.appendChild(r);
    });
    host.appendChild(list); return rows.length;
  }
  /* r161: the ONE "Continue where you left off" banner (event workspace, quote flow, Discovery, Proposal, Quotes Confirm dialog):
       Not confirmed yet
       Next: Quotation (step 8 of 8) · Discovery and Proposal skipped     [Continue where you left off] [Not now]
       Last worked on by Priya, 10 min ago
     opts: { canEdit, before, btnClass, onContinue(v) }. No banner without a row, for a view-only role, or once hidden this session. */
  function renderBanner(host, v, opts) {
    var doc = host.ownerDocument || root.document; opts = opts || {}; css(doc);
    var old = doc.getElementById("flowResumeBanner"); if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!v || opts.canEdit === false || bannerHidden(v.quoteId)) return null;
    var b = el(doc, "div", "fr-banner"); b.id = "flowResumeBanner"; b.setAttribute("role", "region"); b.setAttribute("aria-label", "Continue where you left off");
    b.setAttribute("data-quote", v.quoteId); b.setAttribute("data-step", v.step);
    var t = el(doc, "div", "fr-main"), bt = bannerText(v);
    t.appendChild(el(doc, "p", "fr-eyebrow", "Not confirmed yet"));
    var p = el(doc, "p", "fr-title"); p.appendChild(el(doc, "strong", null, bt.next)); if (bt.note) p.appendChild(el(doc, "span", "fr-skip", " · " + bt.note));
    t.appendChild(p);
    if (v.phaseLabel) t.appendChild(el(doc, "span", "fr-phase", v.phaseLabel));
    var lb = lastBy(v); if (lb) t.appendChild(el(doc, "p", "fr-sub", lb));
    b.appendChild(t);
    var acts = el(doc, "div", "fr-acts");
    var a = el(doc, "a", opts.btnClass || "btn primary", "Continue where you left off"); a.href = href(v);
    a.setAttribute("aria-label", "Continue where you left off: " + bt.next);
    if (typeof opts.onContinue === "function") a.addEventListener("click", function (e) { if (e && e.preventDefault) e.preventDefault(); opts.onContinue(v, b); });
    acts.appendChild(a);
    var x = el(doc, "button", "btn", "Not now"); x.type = "button";
    x.setAttribute("aria-label", "Hide this reminder for this session (the quote is not changed)");
    x.addEventListener("click", function () { hideBanner(v.quoteId); if (b.parentNode) b.parentNode.removeChild(b); });
    acts.appendChild(x); b.appendChild(acts);
    host.insertBefore(b, opts.before && opts.before.parentNode === host ? opts.before : host.firstChild); return b;
  }
  /* r161: mountBanner({ host, before, quote, quoteId, canEdit, current, onContinue, store }) -> Promise<banner | null>.
     Shown only for an OPEN quote (client precheck isOpen + the server row of my_open_quotes, 0206 list on an older database),
     for an editor (canEdit: true / false, or asked from the store: quotes edit + the server can_edit), when it is not hidden
     this session, and not when the page already shows the step Continue would land on (current). Never throws, never blocks. */
  var bannerSeq = 0;
  function mountBanner(o) {
    o = o || {}; var seq = ++bannerSeq, doc = (o.host && o.host.ownerDocument) || root.document;
    function drop() { try { var old = doc && doc.getElementById("flowResumeBanner"); if (old && old.parentNode) old.parentNode.removeChild(old); } catch (e) {} return null; }
    try {
      var q = o.quote || null, id = String(o.quoteId || (q && q.id) || ""), s = o.store || S();
      if (!o.host || !UUID.test(id) || (q && !isOpen(q)) || o.canEdit === false || bannerHidden(id) || !serverOn(s)) return Promise.resolve(drop());
      var fp = s.flowProgress, get = typeof fp.open === "function" ? fp.open : fp.list;
      var can = o.canEdit === true ? Promise.resolve(true)
        : Promise.resolve(s.auth && typeof s.auth.canEditArea === "function" ? s.auth.canEditArea("quotes") : true).then(function (x) { return x !== false; }, function () { return false; });
      return Promise.all([withTimeout(Promise.resolve(get.call(fp, { scope: "studio", quote: id, limit: 1 })), 8000, null), can]).then(function (a) {
        if (seq !== bannerSeq) return null;                                                     // a newer banner was asked for
        var d = a[0], r = d && Array.isArray(d.rows) ? d.rows[0] : null;
        if (!a[1] || !r || d.can_edit === false || String(r.id) !== id) return drop();
        var v = fromServer(r, true);
        if (o.current && landStep(o.current) === v.step) return drop();                       // already on that step
        return renderBanner(o.host, v, { canEdit: true, before: o.before, btnClass: o.btnClass, onContinue: o.onContinue });
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  /* flow.html: "You stopped at Venue · Go to top" */
  function renderNotice(host, info, onTop, before) {
    var doc = host.ownerDocument || root.document; css(doc);
    var old = doc.getElementById("flowResumeNote"); if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!info || !STEPS[info.step]) return null;
    var n = el(doc, "div", "fr-note"); n.id = "flowResumeNote"; n.setAttribute("role", "status");
    n.appendChild(el(doc, "span", null, (info.mine ? "You stopped at " : (info.who || "A teammate") + " stopped at ") + LABELS[info.step]));
    var b = el(doc, "button", null, "Go to top"); b.type = "button";
    b.addEventListener("click", function () { if (onTop) onTop(); if (n.parentNode) n.parentNode.removeChild(n); });
    n.appendChild(el(doc, "span", null, "·")); n.appendChild(b);
    host.insertBefore(n, before && before.parentNode === host ? before : host.firstChild); return n;
  }

  /* ---------------- page mount (dashboard.html / quotes.html: data-mount) ---------------- */
  var mountSeq = 0;
  function mount() {
    var doc = root.document; if (!doc) return;
    var seq = ++mountSeq;
    ready().then(function (s) {
      if (!s || seq !== mountSeq) return;
      var u = whoami(s); if (!u) return;                                                      // signed out: nothing
      var dash = /dashboard/.test(String((root.location && root.location.pathname) || "")) || !!doc.getElementById("hdResume");
      // r154c: Home lists up to 5 open quotes (+ "See all"); other pages keep the one compact card
      var homeList = dash || !!doc.getElementById("hdResume");
      return load(s, u.id, { scope: "mine", limit: homeList ? HOME_MAX : 1, maxDays: DASH_DAYS }).then(function (data) {
        if (seq !== mountSeq) return;
        var old = doc.getElementById("flowResume"); if (old && old.parentNode) old.parentNode.removeChild(old);
        var block = doc.getElementById("hdResume");
        function paint(host, isBlock) {
          var target = isBlock ? (host.querySelector(".hd-body") || host) : host;
          if (homeList) {
            var btn = isBlock ? { primary: "hd-btn hd-primary", ghost: "hd-btn hd-ghost" } : null;
            var onHide = function (v) {
              dismiss(s, u.id, v.quoteId).then(function () { mount(); });          // re-read: the next open quote moves up
              data = { rows: data.rows.filter(function (r) { return r.quoteId !== v.quoteId; }), total: Math.max(0, (data.total || 1) - 1), canEdit: data.canEdit, open: data.open };
              var left = renderHome(target, data, { btn: btn, onHide: onHide });
              if (!left) { if (isBlock) host.hidden = true; else if (host.parentNode) host.parentNode.removeChild(host); }
              try { var U = root.BPUI; if (U && U.toast) U.toast("Hidden from your list - the quote is not deleted. It comes back when you work on it again, and it stays under Quotes > In progress.", { type: "info" }); } catch (e) {}
            };
            var drawn = renderHome(target, data, { btn: btn, onHide: onHide });
            if (isBlock) host.hidden = !drawn;
            return drawn;
          }
          var shown = renderCard(target, data, { btn: isBlock ? { primary: "hd-btn hd-primary", ghost: "hd-btn hd-ghost" } : null, noEyebrow: isBlock,
            onDismiss: function (v) {
              dismiss(s, u.id, v.quoteId).then(function () { mount(); });
              data = { rows: data.rows.slice(1), total: Math.max(0, (data.total || 1) - 1), canEdit: data.canEdit };
              if (!data.rows.length) { if (isBlock) host.hidden = true; else if (host.parentNode) host.parentNode.removeChild(host); }
              else renderCard(target, data, { btn: isBlock ? { primary: "hd-btn hd-primary", ghost: "hd-btn hd-ghost" } : null, noEyebrow: isBlock });
            } });
          if (isBlock) host.hidden = !shown;
          return shown;
        }
        if (block) { paint(block, true); return; }
        if (!data.rows.length) return;
        // no dashboard block (old dashboard / Quotes page): a row above the page content. On the dashboard,
        // wait briefly for the new layout to build its block, so the card never lands under the whole dashboard.
        (function place(n) {
          var b2 = doc.getElementById("hdResume"); if (b2) { paint(b2, true); return; }
          if (dash && n < 30) { setTimeout(function () { if (seq === mountSeq) place(n + 1); }, 100); return; }
          var main = doc.getElementById("main") || doc.body; if (!main || doc.getElementById("flowResume")) return;
          var box = el(doc, "div", "flow-resume card"); box.id = "flowResume";
          box.style.margin = "0 0 14px"; box.style.padding = "12px 14px";                    // CSSOM (CSP-safe)
          paint(box, false); main.insertBefore(box, main.firstChild);
        })(0);
      });
    }).catch(function () { /* offline / not signed in: no card, no toast */ });
  }
  function autoMount() {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", mount); else mount();
    // Back / Forward restores the page from the bfcache: re-read (a quote may have been finished meanwhile)
    root.addEventListener("pageshow", function (e) { if (e && e.persisted) mount(); });
  }

  var api = { STEPS: STEPS, ORDER: ORDER, TOTAL: TOTAL, LABELS: LABELS, DASH_DAYS: DASH_DAYS, key: key, legacyKey: legacyKey, read: read, readAll: readAll,
    record: record, clear: clear, dismissLocal: dismissLocal, lastStep: lastStep, unfinished: unfinished, stepNo: stepNo, firstNotDone: firstNotDone,
    ago: ago, fromServer: fromServer, fromLocal: fromLocal, stepText: stepText, progressText: progressText, label: label, href: href, lastBy: lastBy,
    ready: ready, whoami: whoami, load: load, dismiss: dismiss, resumeStep: resumeStep, track: track,
    renderCard: renderCard, renderHome: renderHome, renderList: renderList, isOpen: isOpen, phaseOf: phaseOf, LAND: LAND, PHASES: PHASES, HOME_MAX: HOME_MAX, landStep: landStep, renderBanner: renderBanner, renderNotice: renderNotice, mount: mount,
    mountBanner: mountBanner, bannerText: bannerText, skippedOf: skippedOf, nextStepOf: nextStepOf, sortRows: sortRows, bannerHidden: bannerHidden, hideBanner: hideBanner, HIDE_KEY: HIDE_KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HelmFlowResume = api;
  if (root.document && root.document.currentScript && root.document.currentScript.hasAttribute("data-mount")) autoMount();
})(typeof window !== "undefined" ? window : globalThis);

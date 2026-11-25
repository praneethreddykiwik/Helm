/* approvals.js - R253 (owner, 25 Nov 2026: "the supervisor / QE should have an option on their page to approve that their crew tasks are done
 * and verified"): finished work waiting for a check, on one page, phone first (they stand on site).
 *
 *   who      admin, event manager, planner, quality engineer = every event of the studio; supervisor = the departments they supervise on
 *            their events (0399), never their own task. Everyone else: a plain "not for your role". The server decides (verify_task: the four
 *            roles; a supervisor from 0436 on). A refused Approve before 0436 says so, the task stays listed.
 *   Waiting  completed + verify_status pending, newest first: photos, notes, who and when, what waits for it, Approve / Send back (a reason is
 *            required), tick several = Approve together. The waiting crew is told when the earlier task is DONE, not when it is approved.
 *   Checked  the last 60 checks: approved / sent back, by whom, when, the reason.
 *   ?quote=  only that event (the link on Tasks & Crew). Data: BPStore.ops.approvals.list / verify / evidenceUrls. No other call.
 * DOM calls only (textContent). Redraws only what changed; one 30 s refresh (HelmTaskStatus.refresher). Pure parts: HelmApprovals._pure. */
(function (global) {
  "use strict";
  var doc = global.document, REFRESH = 30000, URL_MS = 240000;
  function ms(v) { var t = v ? new Date(v).getTime() : NaN; return isFinite(t) ? t : NaN; }
  function pl(n, one, many) { return n + " " + (n === 1 ? one : many); }
  /* ---- pure ---- */
  // "just now" / "12 min ago" / "3 h ago" / "2 days ago"
  function ago(iso, now) { var t = ms(iso); if (!isFinite(t)) return ""; var m = Math.max(0, Math.floor((now - t) / 60000)); if (m < 1) return "just now"; if (m < 60) return m + " min ago"; var hh = Math.floor(m / 60); return hh < 24 ? hh + " h ago" : pl(Math.floor(hh / 24), "day", "days") + " ago"; }
  // own = the crew rows that are me; a supervisor never checks their own task
  function may(sc, t) { return !!sc && !sc.old && (sc.all || (sc.role === "supervisor" && (sc.own || []).indexOf(t.crew_id) < 0)); }
  // before 0436 the database refuses a supervisor
  function refused(sc, e) { return !!sc && !sc.all && String((e && e.hint) || "") !== "r436_not_your_section" && (String((e && e.code) || "") === "42501" || /quality engineer or manager|not allowed|not authori/i.test(String((e && e.message) || ""))); }
  // what waits for a finished task: the ones not started yet can start (release = done, not approval), plus the started ones
  function nextWords(list) {
    var a = (list || []).filter(function (t) { return t && t.status !== "cancelled"; }).map(function (t) { return (t.title || "a task") + " (" + (t.assignee_name || "nobody yet") + (t.status === "completed" ? ", done" : t.status === "in_progress" ? ", started" : "") + ")"; });
    return a.length ? a.slice(0, 4).join(", ") + (a.length > 4 ? " and " + (a.length - 4) + " more" : "") : "";
  }
  function forEvent(rows, q) { return (rows || []).filter(function (t) { return !q || t.quote_id === q; }); }
  // newest first (a task with no time goes last)
  function newest(rows, key) { return (rows || []).slice().sort(function (a, b) { return (ms(b[key]) || 0) - (ms(a[key]) || 0) || String(a.title || "").localeCompare(String(b.title || "")); }); }
  var pure = { ago: ago, may: may, refused: refused, nextWords: nextWords, forEvent: forEvent, newest: newest };
  global.HelmApprovals = { _pure: pure };
  if (typeof module !== "undefined" && module.exports) module.exports = pure;
  if (!doc || !doc.getElementById || !doc.getElementById("apApp")) return;

  /* ---- page ---- */
  var S = { data: null, view: "wait", q: "", sel: {}, urls: {}, urlAt: 0, sigs: {}, people: {}, busy: 0, dbOld: false }, $ = function (id) { return doc.getElementById(id); };
  function B() { return global.BPStore; }
  function UI() { return global.BPUI; }
  function h(tag, a, kids) {
    var n = doc.createElement(tag);
    Object.keys(a || {}).forEach(function (k) { var v = a[k]; if (v == null || v === false) return;
      if (k === "text") n.textContent = String(v); else if (k === "cls") n.className = v; else if (k === "on") Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); }); else n.setAttribute(k, v === true ? "" : String(v)); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function say(t) { $("apSay").textContent = ""; setTimeout(function () { $("apSay").textContent = t; }, 40); }
  function toast(t, type) { try { UI().toast(t, { type: type || "ok", timeout: type === "err" ? 9000 : 4500 }); } catch (e) {} say(t); }
  function err(e, what) { try { return UI().friendlyError(e, { action: what }); } catch (x) { return "Couldn't " + what + " - try again."; } }
  function when(iso) { if (!iso) return ""; try { var o = B().fmtStudioDate(iso, { fmt: { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" } }); if (o) return o; } catch (e) {} try { return new Date(iso).toLocaleString(); } catch (e) { return ""; } }
  function dayOf(ymd) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || "")); if (!m) return ""; try { return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12))); } catch (e) { return ymd; } }
  function ev(t) { return S.data.events[t.quote_id] || {}; }
  function evName(e) { return e.title || e.code || "Event"; }
  function evOf(t) { return S.data.evidence.filter(function (x) { return x.task_id === t.id; }); }
  function waiting() { return newest(forEvent(S.data.pending, S.q), "completed_at"); }
  function can(t) { return may(S.data.scope, t); }
  function opsHref(t) { return "ops.html?quote=" + encodeURIComponent(t.quote_id) + "&task=" + encodeURIComponent(t.id); }

  /* ---- draw ---- */
  function renderHead() {
    var sc = S.data.scope, n = waiting().length, depts = []; Object.keys(sc.mine || {}).forEach(function (q) { sc.mine[q].forEach(function (d) { if (depts.indexOf(d) < 0) depts.push(d); }); });
    $("apLead").textContent = sc.all ? "Finished work waiting for a check, on every event. Approve it, or send it back with a reason - the person then does it again."
      : depts.length ? "Finished work in the departments you supervise: " + depts.sort().join(", ") + "." + (sc.old ? "" : " Approve it, or send it back with a reason.") : "Finished work in the departments you supervise.";
    $("apWaitN").textContent = String(n);
    var note = S.dbOld || sc.old ? "Needs a database update: supervisors cannot approve work yet. Nothing was changed - the tasks stay listed. An admin, event manager or quality engineer can approve them." : "";
    $("apNote").textContent = note; $("apNote").hidden = !note;
    Array.prototype.forEach.call(doc.querySelectorAll("[data-ap-view]"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-ap-view") === S.view)); });
    // the events that have something, the waiting ones first
    var sel = $("apEvent"), cnt = {}; S.data.pending.forEach(function (t) { cnt[t.quote_id] = (cnt[t.quote_id] || 0) + 1; });
    var ids = Object.keys(S.data.events).filter(function (id) { return !S.data.events[id].hidden; }); if (S.q && ids.indexOf(S.q) < 0) ids.push(S.q);
    ids.sort(function (a, b) { return (cnt[b] || 0) - (cnt[a] || 0) || String((S.data.events[b] || {}).eventDate || "").localeCompare(String((S.data.events[a] || {}).eventDate || "")); });
    var sig = JSON.stringify([ids, cnt, S.q]); if (S.sigs.ev === sig || doc.activeElement === sel) return; S.sigs.ev = sig; clear(sel);
    var all = h("option", { value: "", text: "All events" + (S.data.pending.length ? " (" + S.data.pending.length + ")" : "") }); sel.appendChild(all);
    ids.forEach(function (id) { var e = S.data.events[id] || {}; sel.appendChild(h("option", { value: id, text: evName(e) + (e.eventDate ? " · " + dayOf(e.eventDate) : "") + (cnt[id] ? " (" + cnt[id] + ")" : "") })); });
    sel.value = S.q;
  }
  function emptyLi(title, text, link) { return h("li", { cls: "ap-empty" }, [h("b", { text: title }), h("span", { text: text }), link ? h("a", { cls: "tc-btn", href: link[0], text: link[1] }) : null]); }
  function thumbs(t) {
    var ph = evOf(t).filter(function (x) { return x.kind === "proof_photo" && x.storage_path; }); if (!ph.length) return h("p", { cls: "ap-nophoto", text: "No photos were sent with this task." });
    var box = h("div", { cls: "ap-thumbs" });
    ph.forEach(function (p, i) { var u = S.urls[p.storage_path], lbl = "Photo " + (i + 1) + " of " + ph.length + ", " + (t.title || "task");
      box.appendChild(u ? h("button", { type: "button", cls: "ap-thumb", "data-key": "ph:" + p.id, "aria-label": "Open " + lbl, on: { click: function (e) { openPhoto(u, lbl, e.currentTarget); } } }, [h("img", { src: u, alt: lbl, loading: "lazy" })])
        : h("span", { cls: "ap-thumb is-none", text: S.urlAt ? "Photo not available" : "Photo…" })); });
    return box;
  }
  function voice(t) { var rows = evOf(t).filter(function (x) { return x.storage_path && x.kind !== "proof_photo" && x.kind !== "reject_voice" && S.urls[x.storage_path] && /^audio\//.test(x.mime || ""); }); return rows.map(function (r) { return h("audio", { controls: true, preload: "none", src: S.urls[r.storage_path] }); }); }
  function card(t) {
    var e = ev(t), ok = can(t), nm = t.assignee_name || "Nobody named", nx = nextWords(S.data.next[t.id]), id = "ap-" + t.id, busy = S.busyId === t.id || S.busy > 0;
    var notes = evOf(t).filter(function (x) { return x.body && x.kind !== "reject_reason"; });
    var top = [h("span", { cls: "grow" }, [h("h3", { cls: "ap-t", id: id, tabindex: "-1", text: t.title || "Task" }), h("span", { cls: "ap-sub", text: [t.category, evName(e) + (e.eventDate ? " · " + dayOf(e.eventDate) : ""), e.venue].filter(Boolean).join(" · ") })])];
    if (ok) { var cb = h("input", { type: "checkbox", "data-key": "sel:" + t.id, "aria-label": "Select " + (t.title || "task") }); cb.checked = !!S.sel[t.id];
      cb.addEventListener("change", function () { if (cb.checked) S.sel[t.id] = 1; else delete S.sel[t.id]; cb.closest(".ap-card").classList.toggle("is-sel", cb.checked); renderBulk(); });
      top.unshift(h("label", { cls: "ap-pick" }, [cb])); }
    var kids = [h("div", { cls: "ap-top" }, top),
      h("p", { cls: "ap-who" }, [h("b", { text: nm }), (t.assignee_kind === "outsourced" ? " (vendor)" : "") + " finished it " + [when(t.completed_at), ago(t.completed_at, Date.now())].filter(Boolean).join(" · ")])];
    if (t.verify_note && t.verified_at) kids.push(h("p", { cls: "tc-note warn", text: "Sent back before: " + t.verify_note + " - now done again." }));
    notes.forEach(function (x) { kids.push(h("p", { cls: "ap-quote", text: "“" + x.body + "” - " + (x.worker_name || nm) })); });
    kids.push(thumbs(t)); voice(t).forEach(function (a) { kids.push(a); });
    if (nx) kids.push(h("p", { cls: "ap-next" }, [h("b", { text: "Waiting for this: " }), nx]));
    if (ok) kids.push(h("div", { cls: "ap-acts" }, [
      h("button", { type: "button", cls: "tc-btn tc-primary ap-ok", "data-key": "ok:" + t.id, "aria-describedby": id, disabled: busy || null, text: "Approve", on: { click: function () { approve([t]); } } }),
      h("button", { type: "button", cls: "tc-btn ap-no", "data-key": "no:" + t.id, "aria-describedby": id, disabled: busy || null, text: "Send back", on: { click: function () { sendBack(t); } } }),
      h("a", { cls: "tc-btn ghost ap-open", href: opsHref(t), text: "Open task" })]));
    else kids.push(h("p", { cls: "ap-own", text: S.data.scope.old ? "An admin, event manager or quality engineer approves this." : "This is your own task - someone else checks it." }));
    return h("li", { cls: "tc-card ap-card" + (S.sel[t.id] ? " is-sel" : ""), "data-id": t.id }, kids);
  }
  function histLi(t) {
    var ok = t.verify_status === "passed", by = S.people[t.verified_by] || "Someone", e = ev(t);
    return h("li", { cls: "tc-card ap-hist" }, [h("span", { cls: "tc-st " + (ok ? "done" : "rejected"), text: ok ? "Approved" : "Sent back" }),
      h("span", { cls: "grow" }, [h("a", { cls: "ap-t", href: opsHref(t), text: t.title || "Task" }), h("span", { cls: "ap-sub", text: [t.assignee_name, t.category, evName(e)].filter(Boolean).join(" · ") }),
        h("span", { cls: "ap-sub", text: by + " · " + when(t.verified_at) }), !ok && t.verify_note ? h("span", { cls: "ap-quote", text: "“" + t.verify_note + "”" }) : null])]);
  }
  function rowSig(t) { return JSON.stringify([t, evOf(t).map(function (x) { return [x.id, !!S.urls[x.storage_path]]; }), S.urlAt, S.data.next[t.id], can(t), !!S.sel[t.id], S.busy, ago(t.completed_at, Date.now())]); }
  function focusKey() { var a = doc.activeElement; return a && $("apList").contains(a) ? a.getAttribute("data-key") : null; }
  function render() {
    renderHead(); tellBadge();
    var list = $("apList"), wait = waiting(), done = S.view === "done";
    Object.keys(S.sel).forEach(function (id) { if (!wait.some(function (t) { return t.id === id && can(t); })) delete S.sel[id]; });
    $("apListH").textContent = done ? "Checked lately" : wait.length ? pl(wait.length, "finished task waits", "finished tasks wait") + " for approval" : "Nothing is waiting";
    var pick = wait.filter(can); $("apAllWrap").hidden = done || pick.length < 2; $("apAll").checked = pick.length > 0 && pick.every(function (t) { return S.sel[t.id]; });
    var rows = done ? newest(forEvent(S.data.history, S.q), "verified_at") : wait, sc = S.data.scope;
    var sig = JSON.stringify([S.view, S.q, rows.map(done ? function (t) { return [t, S.people[t.verified_by]]; } : rowSig), Object.keys(sc.mine || {})]);
    if (S.sigs.list !== sig) {
      S.sigs.list = sig; var keep = focusKey(); clear(list);
      rows.forEach(function (t) { list.appendChild(done ? histLi(t) : card(t)); });
      if (!rows.length) {
        if (done) list.appendChild(emptyLi("No checks yet", S.q ? "Nothing has been approved or sent back on this event." : "Approved and sent-back work is listed here."));
        else if (!sc.all && !Object.keys(sc.mine).length) list.appendChild(emptyLi("You do not supervise a department yet", "An event manager sets it: Tasks & Crew, the Supervisor box beside a department. Its finished work is then listed here."));
        else list.appendChild(emptyLi("All checked", S.q ? "No finished work waits for approval on this event." : "No finished work waits for approval. New work shows here by itself when a crew member marks it done.", S.q ? ["ops.html?quote=" + encodeURIComponent(S.q), "Open Tasks & Crew"] : null));
      }
      if (keep) { var n = list.querySelector('[data-key="' + keep + '"]'); if (n) try { n.focus({ preventScroll: true }); } catch (e) {} }
    }
    renderBulk();
  }
  // R257: the sidebar badge = what this person can approve now (every event), told at once - it used to wait up to 3 minutes
  var told = null;
  function tellBadge() { var n = S.data.pending.filter(can).length; if (n === told) return; told = n; try { global.dispatchEvent(new CustomEvent("helm:approvals", { detail: { count: n } })); } catch (e) {} }
  function picked() { return S.view === "wait" ? waiting().filter(function (t) { return S.sel[t.id] && can(t); }) : []; }
  function renderBulk() {
    var n = picked().length; $("apBulk").hidden = !n; $("apBulkN").textContent = String(n); $("apBulkGo").textContent = "Approve " + n; $("apBulkGo").disabled = S.busy > 0;
    doc.body.classList.toggle("ap-has-bulk", n > 0);
    var pick = waiting().filter(can); $("apAll").checked = pick.length > 0 && pick.every(function (t) { return S.sel[t.id]; });
  }

  /* ---- actions ---- */
  // after a check the card is gone: the next card's title gets the focus (else the list heading)
  function dropCard(ids) {
    var at = waiting().map(function (t) { return t.id; }), i = at.indexOf(ids[0]); S.data.pending = S.data.pending.filter(function (t) { return ids.indexOf(t.id) < 0; }); ids.forEach(function (id) { delete S.sel[id]; });
    render(); var left = waiting(), nx = left[Math.min(Math.max(i, 0), left.length - 1)], el = nx ? $("ap-" + nx.id) : $("apListH"); if (el) try { el.focus({ preventScroll: !nx }); } catch (e) {}
  }
  // the check was refused because somebody else was faster: not an error for the person, the list is read again
  function gone(e) { return String((e && e.hint) || "") === "r311_qc_not_pending" || /not waiting for a quality check/i.test(String((e && e.message) || "")); }
  async function approve(ts) {
    if (S.busy || !ts.length) return;
    if (ts.length > 1) { var names = ts.slice(0, 6).map(function (t) { return t.title || "Task"; }).join(", ") + (ts.length > 6 ? " and " + (ts.length - 6) + " more" : "");
      if (!(await UI().confirm(names + ".", { title: "Approve " + ts.length + " finished tasks?", okLabel: "Approve " + ts.length }))) return; }
    S.busy = 1; render(); var ok = [], bad = "", late = 0;
    for (var i = 0; i < ts.length; i++) {
      try { await B().ops.verify(ts[i].id, true); ok.push(ts[i].id); }
      catch (e) { if (gone(e)) { late++; continue; } if (refused(S.data.scope, e)) { S.dbOld = true; bad = "Needs a database update - supervisors cannot approve work yet."; break; } bad = err(e, "approve the task"); }
    }
    S.busy = 0; S.sigs.list = "";
    if (ok.length) dropCard(ok); else render();
    toast(((ok.length ? (ok.length === 1 ? "Approved." : ok.length + " tasks approved.") : "") + (late ? " " + pl(late, "task was", "tasks were") + " already checked by someone else." : "") + (bad ? " " + bad : "")).trim(), bad ? "err" : "ok");
    if (S.dbOld) $("apNote").scrollIntoView({ block: "nearest" });
    load(true);
  }
  async function sendBack(t) {
    if (S.busy) return;
    var note = await UI().prompt("What needs to be fixed? " + (t.assignee_name || "The person") + " does the work again" + (S.data.next[t.id] ? ". Waiting for it: " + nextWords(S.data.next[t.id]) + "." : "."),
      { title: "Send back " + (t.title || "this task") + "?", label: "Reason (required)", multiline: true, required: true, requiredMessage: "Give a reason so the team knows what to fix.", okLabel: "Send back" });
    if (note === null) return; note = String(note).replace(/\s+/g, " ").trim().slice(0, 500); if (!note) return;
    S.busy = 1; render();
    try { await B().ops.verify(t.id, false, note); S.busy = 0; S.sigs.list = ""; dropCard([t.id]); toast("Sent back for rework."); }
    catch (e) { S.busy = 0; S.sigs.list = ""; if (refused(S.data.scope, e)) S.dbOld = true; render(); toast(gone(e) ? "Already checked by someone else." : S.dbOld ? "Needs a database update - supervisors cannot send work back yet." : err(e, "send the task back"), gone(e) ? "ok" : "err"); }
    load(true);
  }
  var photoFrom = null;
  function openPhoto(u, lbl, from) { photoFrom = from; $("apPhotoImg").src = u; $("apPhotoImg").alt = lbl; $("apPhotoOpen").href = u; var d = $("apPhoto"); if (d.showModal) d.showModal(); else d.setAttribute("open", ""); $("apPhotoX").focus(); }
  function photoGone() { $("apPhotoImg").removeAttribute("src"); if (photoFrom && photoFrom.isConnected) photoFrom.focus(); photoFrom = null; }

  /* ---- data ---- */
  async function signed() {
    var paths = waiting().slice(0, 40).reduce(function (a, t) { return a.concat(evOf(t).map(function (x) { return x.storage_path; })); }, []).filter(Boolean);
    var missing = paths.some(function (p) { return !S.urls[p]; }); if (!paths.length || (!missing && Date.now() - S.urlAt < URL_MS)) return;
    if (missing && S.urlAt && Date.now() - S.urlAt < REFRESH && paths.every(function (p) { return p in S.urls; })) return;
    try { var u = await B().ops.evidenceUrls(paths, 300); paths.forEach(function (p) { S.urls[p] = u[p] || null; }); } catch (e) { paths.forEach(function (p) { if (!(p in S.urls)) S.urls[p] = null; }); }
    S.urlAt = Date.now(); render();
  }
  async function load(quiet) {
    if (S.busy || doc.querySelector("dialog[open]")) return;
    var d; try { d = await B().ops.approvals.list(); } catch (e) { if (S.data) return false; throw e; }
    if (!d) { $("apBoot").hidden = true; $("apApp").hidden = true; noRole(); return; }
    var was = S.data ? S.data.pending.map(function (t) { return t.id; }) : null; S.data = d; render();
    if (was && quiet) { var more = d.pending.filter(function (t) { return was.indexOf(t.id) < 0; }).length; if (more) say(pl(more, "new finished task", "new finished tasks")); }
    signed();
  }
  function noRole() { var b = $("apErr"); clear(b); b.hidden = false; b.appendChild(h("div", { cls: "tc-card ap-pad" }, [h("h2", { cls: "tc-h2", text: "Approvals are not part of your role" }), h("p", { cls: "ap-sub", text: "An admin, event manager, planner or quality engineer approves finished work, and a supervisor for their own department." }), h("a", { cls: "tc-btn", href: "dashboard.html", text: "Go to the dashboard" })])); }
  async function start() {
    await B().init(); var A = B().auth;
    if (A.enabled && A.enabled() && A.required() && !A.user()) { global.location.replace("login.html?next=" + encodeURIComponent(global.HelmUrl ? HelmUrl.here() : "approvals.html")); return; }
    if (!(await A.requireView("staff"))) { $("apBoot").hidden = true; return; }
    try { B().bell.mount($("bell")); } catch (e) {}
    var q = null; try { q = new URLSearchParams(global.location.search).get("quote"); if (global.HelmUrl && HelmUrl.get) q = await HelmUrl.get("quote", q); } catch (e) {}
    S.q = q && /^[0-9a-f-]{36}$/i.test(q) ? q : "";
    try { await load(false); } catch (e) { $("apBoot").hidden = true; $("apErr").hidden = false; UI().loadError($("apErr"), e, function () { $("apErr").hidden = true; return start(); }, { what: "the finished work" }); return; }
    if (!S.data) return; $("apBoot").hidden = true; $("apApp").hidden = false;
    if (S.wired) return; S.wired = true;
    Array.prototype.forEach.call(doc.querySelectorAll("[data-ap-view]"), function (b) { b.addEventListener("click", function () { S.view = b.getAttribute("data-ap-view"); S.sel = {}; render(); }); });
    $("apEvent").addEventListener("change", function () { S.q = $("apEvent").value; S.sel = {}; render(); signed(); });
    $("apAll").addEventListener("change", function () { var on = $("apAll").checked; S.sel = {}; if (on) waiting().filter(can).forEach(function (t) { S.sel[t.id] = 1; }); render(); });
    $("apBulkGo").addEventListener("click", function () { approve(picked()); });
    $("apBulkX").addEventListener("click", function () { S.sel = {}; render(); $("apListH").focus(); });
    $("apPhotoX").addEventListener("click", function () { $("apPhoto").close(); });
    $("apPhoto").addEventListener("click", function (e) { if (e.target === $("apPhoto")) $("apPhoto").close(); });
    $("apPhoto").addEventListener("close", photoGone);
    B().chat && B().chat.directory && B().chat.directory().then(function (d) { Object.keys(d || {}).forEach(function (id) { S.people[id] = d[id].full_name || d[id].name || ""; }); if (S.data) render(); }).catch(function () {});
    global.HelmTaskStatus.refresher(function () { return load(true); }, REFRESH);
  }
  global.HelmApprovals._S = S; global.HelmApprovals.reload = load;
  function go() { if (UI() && UI().boot) UI().boot(start); else start(); }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go); else go();
})(typeof window !== "undefined" ? window : globalThis);

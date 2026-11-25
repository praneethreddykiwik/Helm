/* issue-assign.js - R252 (owner 24 Nov: "organise it properly like issues and stuff, also optional assign to a person"): the parts of
 * the event's issues that Tasks & Crew (ops.html), the Event-day monitor (monitor.html) and the Issues page show THE SAME WAY:
 *
 *   HelmIssueAssign.picker(o)    "Assign to (optional)": Nobody yet / Staff (working this event first) / Vendors (this event's
 *                                first) / Someone else (a typed name), + "Also give them this as a task" (off by default)
 *                                -> { el, value(): { name, kind, id, task, error }, focus() }
 *                                o: { quoteId, tasks?, locked? (true/false, else asked), owner?, ids (id prefix), noTask? }
 *   HelmIssueAssign.list(host, o) the organised list: open first, High - Medium - Low, newest first, who has it, how long open,
 *                                Assign / Change, Resolve; resolved ones folded. Skips the redraw when nothing changed and while
 *                                someone is choosing a person in it.
 *                                o: { items, quoteId, canEdit, reload(), toast(msg, type), tasks?, locked?, max?, allHref?,
 *                                empty?, filter?, onTask?(), resolve?/start?/reopen?/remove?(issue, btn), when?(iso), words? }
 *   HelmIssueAssign.giveTask(quoteId, title, pick)   one task (category "Issue", starts now) for that person or vendor
 *
 * The person is saved as a NAME in event_issues.owner (text - BPStore.issues.setOwner / add; the server checks Issues - Can change).
 * The task uses the normal assign calls (BPStore.ops.assignTasks / assignTasksVendor + setSchedule), needs "Add & assign" (Assign &
 * send tasks) and an unlocked plan (0397), and is never given without the tick and a press. Nothing is deleted here. A read this
 * person may not make only leaves that group out; the name can always be typed. DOM calls only (textContent), no HTML strings. */
(function (global) {
  "use strict";
  var doc = global.document;
  var SEV = { high: "High", medium: "Medium", low: "Low" }, RANK = { high: 0, medium: 1, low: 2 };
  var CAT = "Issue", NAME_MAX = 120, KEEP_MS = 300000;

  /* ---------------- pure ---------------- */
  function clean(v, max) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max || NAME_MAX); }
  function ms(v) { var t = v ? new Date(v).getTime() : NaN; return isFinite(t) ? t : 0; }
  function sevOf(i) { return SEV[i && i.severity] ? i.severity : "medium"; }
  function isOpen(i) { return !!i && i.status !== "resolved"; }
  function nobody(i) { return !clean(i && i.owner); }
  // open: High, Medium, Low - newest first in each; resolved: the last one sorted first
  function organise(items) {
    var all = (items || []).filter(Boolean);
    return { open: all.filter(isOpen).sort(function (a, b) { return RANK[sevOf(a)] - RANK[sevOf(b)] || ms(b.created_at) - ms(a.created_at); }),
      done: all.filter(function (i) { return !isOpen(i); }).sort(function (a, b) { return (ms(b.resolved_at) || ms(b.created_at)) - (ms(a.resolved_at) || ms(a.created_at)); }) };
  }
  function pass(i, key) { return key === "none" ? nobody(i) : key === "high" ? sevOf(i) === "high" : true; }
  function openFor(iso, now) {
    var t = ms(iso); if (!t) return ""; var m = Math.floor(((now || Date.now()) - t) / 60000);
    if (m < 1) return "just now"; if (m < 60) return "open " + m + " min"; var hr = Math.floor(m / 60);
    if (hr < 24) return "open " + hr + " h" + (m % 60 && hr < 6 ? " " + (m % 60) + " min" : ""); var d = Math.floor(hr / 24); return "open " + d + (d === 1 ? " day" : " days");
  }
  // people.options rows -> the groups of the picker. o: { options, staffIds: {id:1}, vendorIds: {id:1} (who is on this event) }
  function groups(o) {
    o = o || {}; var here = o.staffIds || {}, vHere = o.vendorIds || {}, g = [[], [], [], []], seen = {};
    (o.options || []).forEach(function (p) {
      if (!p || !p.id || !clean(p.name)) return; var kind = p.kind === "vendor" ? "vendor" : "staff", k = kind + ":" + p.id; if (seen[k]) return; seen[k] = 1;
      g[kind === "staff" ? (here[p.id] ? 0 : 1) : (vHere[p.id] ? 2 : 3)].push({ key: k, kind: kind, id: String(p.id), name: clean(p.name), role: clean(p.role, 60) });
    });
    var label = ["Staff - working this event", g[0].length ? "Other staff" : "Staff", "Vendors of this event", g[2].length ? "Other vendors" : "Vendors"];
    return g.map(function (list, i) { return { label: label[i], list: list.sort(function (a, b) { return a.name.localeCompare(b.name); }) }; }).filter(function (x) { return x.list.length; });
  }
  function byName(gs, name) {
    var n = clean(name).toLowerCase(), hit = null; if (!n) return null;
    (gs || []).forEach(function (g) { g.list.forEach(function (p) { if (!hit && p.name.toLowerCase() === n) hit = p; }); }); return hit;
  }
  // the people working this event (tasks), and its vendors (bookings + vendor tasks); cancelled ones don't count
  function onEvent(tasks, bookings) {
    var r = { staffIds: {}, vendorIds: {} };
    (tasks || []).forEach(function (t) { if (!t || t.status === "cancelled") return; if (t.crew_id) r.staffIds[t.crew_id] = 1; if (t.vendor_id) r.vendorIds[t.vendor_id] = 1; });
    (bookings || []).forEach(function (b) { if (b && b.vendor_id && b.status !== "cancelled") r.vendorIds[b.vendor_id] = 1; });
    return r;
  }
  function digits(v) { return String(v || "").replace(/[^0-9]/g, "").length; }
  function refused(e) { var c = String((e && (e.code || e.status)) || ""), m = String((e && e.message) || ""); return c === "42501" || c === "401" || c === "403" || c === "PGRST301" || /not authori|not allowed|permission denied|row-level security|JWT/i.test(m); }
  var PURE = { organise: organise, pass: pass, openFor: openFor, groups: groups, byName: byName, onEvent: onEvent, clean: clean, refused: refused };
  if (!doc || !doc.createElement) { global.HelmIssueAssign = { _pure: PURE, CAT: CAT }; return; }

  /* ---------------- helpers ---------------- */
  function B() { return global.BPStore || {}; }
  function h(tag, a, kids) {
    var n = doc.createElement(tag);
    Object.keys(a || {}).forEach(function (k) { var v = a[k]; if (v == null || v === false) return;
      if (k === "text") n.textContent = String(v); else if (k === "cls") n.className = v; else if (k === "on") Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else if (k === "hidden") n.hidden = true; else n.setAttribute(k, v === true ? "" : String(v)); });
    (kids || []).forEach(function (c) { if (c == null || c === false) return; n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function errText(e, what) { try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: what }); } catch (x) {} return "Could not " + what + "."; }
  function ask(f) { return Promise.resolve().then(f).then(function (v) { return !!v; }, function () { return false; }); }
  function quiet(f, dflt) { return Promise.resolve().then(f).then(function (r) { return r == null ? dflt : r; }, function () { return dflt; }); }
  function val(f) { return typeof f === "function" ? f() : f; }

  /* ---------------- who can be picked (read once per event, kept 5 minutes) ---------------- */
  var CACHE = {};
  function load(o, force) {
    var id = o.quoteId, c = CACHE[id]; if (!force && c && Date.now() - c.at < KEEP_MS) return c.p;
    var A = B().auth || {}, can = function (k) { return ask(function () { return A.canView ? A.canView(k) : true; }); };
    c = CACHE[id] = { at: Date.now() };
    c.p = Promise.all([can("staff"), can("vendors"), ask(function () { return A.canAssignTasks ? A.canAssignTasks() : A.canEditArea ? A.canEditArea("staff") : false; })]).then(function (p) {
      var staff = p[0], vend = p[1], tasks = val(o.tasks);
      return Promise.all([
        (staff || vend) && B().people && B().people.options ? quiet(function () { return B().people.options(); }, null) : null,
        Array.isArray(tasks) ? tasks : staff && B().ops && B().ops.listTasks ? quiet(function () { return B().ops.listTasks(id); }, []) : [],
        vend && B().bookings && B().bookings.list ? quiet(function () { return B().bookings.list(id); }, []) : []
      ]).then(function (r) {
        var opts = (r[0] || []).filter(function (x) { return x && (x.kind === "vendor" ? vend : staff); }), on = onEvent(r[1], r[2]);
        // people.options answers an empty list when it could not be read: say "nobody to pick", offer Try again, keep typing possible
        if ((staff || vend) && !opts.length) c.at = 0;
        return { groups: groups({ options: opts, staffIds: on.staffIds, vendorIds: on.vendorIds }), may: staff || vend, canTask: p[2] };
      });
    });
    c.p.catch(function () { c.at = 0; });
    return c.p;
  }
  // the plan lock (0397): what the page already knows, else asked; unknown = not locked (the server refuses a new task while locked)
  function lockedNow(o) {
    var v = val(o.locked); if (v === true || v === false) return Promise.resolve(v);
    var L = B().ops && B().ops.planLock; if (!L || !L.get) return Promise.resolve(false);
    return quiet(function () { return L.get(o.quoteId); }, null).then(function (r) { return !!(r && r.locked); });
  }

  /* ---------------- the picker ---------------- */
  var UID = 0;
  function picker(o) {
    o = o || {}; var id = (o.ids || "hia") + (++UID), owner = clean(o.owner), data = null, touched = false;
    var sel = h("select", { cls: "hia-sel", id: id + "S", "data-native-picker": true, "aria-describedby": id + "M" });   // native: the groups stay headed
    var name = h("input", { cls: "hia-inp", id: id + "N", maxlength: String(NAME_MAX), placeholder: "Their name", autocomplete: "off" });
    var nameBox = h("div", { cls: "hia-f", hidden: true }, [h("label", { cls: "hia-l", for: id + "N", text: "Their name" }), name]);
    var chk = h("input", { type: "checkbox", id: id + "T", "aria-describedby": id + "H" }), hint = h("p", { cls: "hia-hint", id: id + "H" });
    var taskBox = h("div", { cls: "hia-task", hidden: true }, [h("label", { cls: "hia-chk", for: id + "T" }, [chk, h("span", { text: "Also give them this as a task" })]), hint]);
    var msg = h("p", { cls: "hia-hint", id: id + "M", role: "status" });
    var el = h("div", { cls: "hia hia-pick" }, [h("div", { cls: "hia-f" }, [h("label", { cls: "hia-l", for: id + "S", text: "Assign to (optional)" }), h("div", { cls: "hia-selw" }, [sel])]), nameBox, taskBox, msg]);
    var locked = false;
    function person() { var k = sel.value, p = null; ((data && data.groups) || []).forEach(function (g) { g.list.forEach(function (x) { if (x.key === k) p = x; }); }); return p; }
    function paint() {
      var p = person(); nameBox.hidden = sel.value !== "other"; name.required = !nameBox.hidden;
      var may = !!(p && data && data.canTask && !o.noTask); taskBox.hidden = !may;
      if (!may || locked) chk.checked = false; chk.disabled = locked;
      if (may) hint.textContent = locked ? "The plan is locked for the event day, so no new tasks. Unlock it first (admin or event manager)."
        : p.kind === "vendor" ? "It starts now, under Issue. Vendors get no e-mail from Helm - send them the task link from Tasks & Crew."
        : "It starts now, under Issue." + (global.HelmTrialPreview ? "" : " They get it by e-mail in about a minute.");
    }
    function fill() {
      var keep = sel.value, hit = data ? byName(data.groups, owner) : null; clear(sel);
      sel.appendChild(h("option", { value: "", text: "Nobody yet" }));
      ((data && data.groups) || []).forEach(function (g) {
        var og = h("optgroup", { label: g.label }); g.list.forEach(function (p) { og.appendChild(h("option", { value: p.key, text: p.name + (p.role ? " - " + p.role : "") })); }); sel.appendChild(og);
      });
      sel.appendChild(h("option", { value: "other", text: "Someone else - type a name" }));
      sel.value = touched ? keep : hit ? hit.key : owner ? "other" : "";
      if (!touched && owner && !hit) name.value = owner; else if (!touched && hit) name.value = "";
      paint();
    }
    function go(force) {
      clear(msg); if (!data) msg.textContent = "Loading people…";
      load(o, force).then(function (d) {
        data = d; clear(msg); fill();
        if (d.may && !d.groups.length) { msg.appendChild(doc.createTextNode("Couldn’t load people to pick from. Type a name, or ")); msg.appendChild(h("button", { type: "button", cls: "hia-link", text: "Try again", on: { click: function () { go(true); } } })); }
        else if (!d.may) msg.textContent = "You can type a name.";
      }, function () { data = data || { groups: [], may: true, canTask: false }; clear(msg); msg.appendChild(doc.createTextNode("Couldn’t check - ")); msg.appendChild(h("button", { type: "button", cls: "hia-link", text: "Try again", on: { click: function () { go(true); } } })); });
    }
    sel.addEventListener("change", function () { touched = true; paint(); if (sel.value === "other") try { name.focus(); } catch (e) {} });
    name.addEventListener("input", function () { touched = true; });
    fill(); go(false);
    lockedNow(o).then(function (v) { locked = v; paint(); });
    return { el: el, focus: function () { try { (nameBox.hidden ? sel : name).focus(); } catch (e) {} },
      reset: function () { owner = ""; touched = false; chk.checked = false; name.value = ""; fill(); },
      value: function () {
        var p = person(); if (p) return { name: p.name, kind: p.kind, id: p.id, task: !!chk.checked && !taskBox.hidden && !chk.disabled };
        if (sel.value !== "other") return { name: null, kind: "", id: "", task: false };
        var n = clean(name.value); return n ? { name: n, kind: "other", id: "", task: false } : { name: null, kind: "other", id: "", task: false, error: "Type their name, or choose Nobody yet." };
      } };
  }

  /* ---------------- the task: one per press ---------------- */
  var BUSY = {};
  function giveTask(quoteId, title, pick) {
    var key = [quoteId, title, pick && pick.kind, pick && pick.id].join("|");
    if (BUSY[key]) return BUSY[key];
    var p = give(quoteId, clean(title, 500), pick).catch(function (e) { return { ok: false, msg: errText(e, "give the task to " + pick.name) }; });
    BUSY[key] = p; p.then(function () { delete BUSY[key]; });
    return p;
  }
  async function give(quoteId, title, pick) {
    var O = B().ops, vendor = pick.kind === "vendor", mine = function (t) { return t && String((vendor ? t.vendor_id : t.crew_id) || "") === String(pick.id) && t.title === title && t.category === CAT; };
    var c = null;
    if (!vendor) {
      c = ((await O.listCrew()) || []).filter(function (x) { return x && String(x.id) === String(pick.id); })[0];
      if (!c) return { ok: false, msg: pick.name + " is not on the active staff list." };
      if (digits(c.phone) < 8) return { ok: false, msg: pick.name + " has no phone number on their staff record (a task needs one)." };
    }
    var before = {}, had = null, others = [], all = (await O.listTasks(quoteId)) || [];
    all.forEach(function (t) {
      before[t.id] = 1; if (["cancelled", "rejected", "completed"].indexOf(t.status) >= 0) return;
      if (mine(t)) had = t; else if (t.title === title && t.category === CAT && t.assignee_name && others.indexOf(t.assignee_name) < 0) others.push(t.assignee_name);
    });
    if (had) return { ok: true, id: had.id, same: true, msg: pick.name + " already has it as a task." };
    var C = B().calendar, ev = null;
    if (C && C.wouldClash && B().quotes && B().quotes.get) {
      ev = await quiet(function () { return B().quotes.get(quoteId); }, null);
      var d = ev && (ev.eventDate || ev.event_date), cl = d ? await quiet(function () { return C.wouldClash(vendor ? { date: d, vendorId: pick.id, excludeQuote: quoteId } : { date: d, crewId: pick.id, excludeQuote: quoteId }); }, null) : null;
      var TC = !vendor && global.HelmTaskClash;   // R254-B: starts now - the same time first, then the day
      if (TC) { if (!(await TC.give([{ crew_id: pick.id, name: pick.name, start: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString(), title: title }], { quoteId: quoteId, tasks: all, dayOk: "Give the task", dayText: function (x) { return pick.name + " is " + x.detail + ". Give them the task anyway?"; } }, function () { return cl; }))) return { ok: false, stopped: true, msg: "No task was given." }; }
      else if (cl && cl.clash && global.BPUI && global.BPUI.confirm && !(await global.BPUI.confirm(pick.name + " is " + cl.detail + ". Give them the task anyway?", { title: "Scheduling clash", okLabel: "Give the task" }))) return { ok: false, stopped: true, msg: "No task was given." };
    }
    if (vendor) await O.assignTasksVendor(quoteId, CAT, [title], pick.id); else await O.assignTasks(quoteId, CAT, [title], c.id, c.name, c.phone);
    var note = "";
    try {
      var made = ((await O.listTasks(quoteId)) || []).filter(function (t) { return !before[t.id] && mine(t); })[0];
      if (made) await O.setSchedule(made.id, new Date(Math.floor(Date.now() / 60000) * 60000).toISOString(), made.planned_end || null, made.depends_on || null);
      else note = " Set its start time in Tasks & Crew.";
    } catch (e) { note = " Its start time could not be saved - set it in Tasks & Crew."; }
    return { ok: true, msg: pick.name + " has it as a task too." + (vendor ? " Send them the task link from Tasks & Crew." : c.email || c.profile_id ? " They get it by e-mail in about a minute." : " They have no e-mail on their staff record - send the task link from Tasks & Crew.") + note +
      (others.length ? " " + others.join(" and ") + " still " + (others.length === 1 ? "has" : "have") + " it as a task - cancel that in Tasks & Crew if it is no longer theirs." : "") };
  }
  // the words after saving: what happened to the issue + (only when ticked) to the task
  async function withTask(quoteId, title, pick, saved) {
    if (!pick.task) return { ok: true, msg: saved };
    var r = await giveTask(quoteId, title, pick);
    return { ok: r.ok, task: r, msg: saved + (r.ok ? " " + r.msg : r.stopped ? " " + r.msg : " The task was not given: " + r.msg) };
  }
  // assign / change / clear the person of a saved issue. Only a changed name is written.
  async function assign(issue, quoteId, pick) {
    var was = clean(issue.owner), is = clean(pick.name);
    if (was !== is) await B().issues.setOwner(issue.id, is || null);
    return withTask(quoteId, issue.title, pick, was === is ? (is ? is + " has this." : "Nobody has this yet.") : is ? "Assigned to " + is + "." : "Nobody has this now.");
  }

  /* ---------------- the list ---------------- */
  function tag(cls, text) { return h("span", { cls: "hia-tag " + cls, text: text }); }
  function btn(text, key, label, fn, cls) { return h("button", { type: "button", cls: "hia-btn" + (cls ? " " + cls : ""), "data-key": key, "aria-label": label, text: text, on: { click: fn } }); }
  function st(host) { return host._hia || (host._hia = { sig: "", openId: null, done: false, saving: false }); }
  function busy(host) { var s = host && host._hia; return !!(s && (s.openId || s.saving)); }
  function list(host, o) {
    var s = st(host), org = organise(o.items), now = Date.now();
    if (busy(host) && host.firstChild && (s.saving || (s.filter === (o.filter || "") && org.open.some(function (i) { return i.id === s.openId; })))) { s.last = o; return false; }   // someone is choosing: keep it
    var shown = org.open.filter(function (i) { return pass(i, o.filter); }), cut = o.max && shown.length > o.max ? shown.slice(0, o.max) : shown;
    var sig = JSON.stringify([!!o.canEdit, o.filter || "", o.max || 0, o.allHref || "", cut.map(function (i) { return [i.id, i.title, i.detail, i.severity, i.status, i.owner, i.kind, openFor(i.created_at, now)]; }), shown.length,
      org.done.map(function (i) { return [i.id, i.title, i.owner, i.resolved_at]; }), !!o.empty, !!o.err]);
    s.last = o; if (s.sig === sig && host.firstChild) return false;
    s.sig = sig; s.openId = null; s.filter = o.filter || "";
    var a = doc.activeElement, key = a && host.contains(a) ? a.getAttribute("data-key") : "";
    host.classList.add("hia", "hia-listhost"); clear(host);
    if (o.err) host.appendChild(h("p", { cls: "hia-hint", role: "status" }, ["Couldn’t check - ", btn("Try again", "ia:retry", "Try again: issues", function () { o.reload(); }, "hia-link")]));
    if (!org.open.length && o.empty) host.appendChild(typeof o.empty === "string" ? h("p", { cls: "hia-empty", text: o.empty }) : o.empty);
    else if (org.open.length && !shown.length) host.appendChild(h("p", { cls: "hia-empty", text: o.filter === "high" ? "Nothing marked High is open." : "Everything open has someone on it." }));
    if (cut.length) { var ul = h("ul", { cls: "hia-list" }); cut.forEach(function (i) { ul.appendChild(row(host, i, o, now)); }); host.appendChild(ul); }
    if (cut.length < shown.length && o.allHref) host.appendChild(h("a", { cls: "hia-more", href: o.allHref, text: "See all " + shown.length + " open" }));
    if (org.done.length) {
      var d = h("details", { cls: "hia-done" }, [h("summary", { "data-key": "ia:done", text: "Resolved (" + org.done.length + ")" })]);
      d.open = s.done; d.addEventListener("toggle", function () { s.done = d.open; });
      var ul2 = h("ul", { cls: "hia-list" }), top = o.max ? org.done.slice(0, o.max) : org.done;
      top.forEach(function (i) { ul2.appendChild(row(host, i, o, now)); }); d.appendChild(ul2);
      if (top.length < org.done.length && o.allHref) d.appendChild(h("a", { cls: "hia-more", href: o.allHref, text: "See all " + org.done.length + " resolved" }));
      host.appendChild(d);
    }
    if (key) { var f = host.querySelector('[data-key="' + key.replace(/["\\]/g, "") + '"]'); if (f) try { f.focus({ preventScroll: true }); } catch (e) {} }
    return true;
  }
  function row(host, i, o, now) {
    var open = isOpen(i), t = i.title || "issue", who = clean(i.owner), acts = h("div", { cls: "hia-acts" });
    var li = h("li", { cls: "hia-row is-" + sevOf(i) + (open ? "" : " is-done") });
    var sub = h("div", { cls: "hia-meta" }, [tag("sev-" + sevOf(i), SEV[sevOf(i)]), i.kind === "incident" ? tag("", "Incident") : null, i.status === "in_progress" ? tag("", "Being handled") : null,
      who ? h("span", { cls: "hia-who" }, [open ? "With " : "Was with ", h("b", { text: who })]) : open ? tag("none", "Nobody yet") : null,
      h("span", { text: open ? openFor(i.created_at, now) : i.resolved_at && o.when ? "resolved " + o.when(i.resolved_at) : "" }), o.when && i.created_at ? h("span", { cls: "hia-at", text: "logged " + o.when(i.created_at) }) : null]);
    if (o.canEdit) {
      if (open) {
        acts.appendChild(btn(who ? "Change" : "Assign", "ia:a:" + i.id, (who ? "Change who has: " : "Assign: ") + t, function () { form(host, li, i, o); }, who ? "" : "is-strong"));
        if (o.start && i.status === "open") acts.appendChild(btn("Start", "ia:s:" + i.id, "Start " + t, function (e) { o.start(i, e.currentTarget); }));
        if (o.resolve) acts.appendChild(btn("Mark resolved", "ia:r:" + i.id, "Mark resolved: " + t, function (e) { o.resolve(i, e.currentTarget); }));
      } else if (o.reopen) acts.appendChild(btn("Reopen", "ia:o:" + i.id, "Reopen " + t, function (e) { o.reopen(i, e.currentTarget); }));
      if (o.remove) acts.appendChild(btn("✕", "ia:x:" + i.id, "Delete " + t, function (e) { o.remove(i, e.currentTarget); }, "is-quiet"));
    }
    li.appendChild(h("div", { cls: "hia-line" }, [h("div", { cls: "hia-main" }, [h("b", { cls: "hia-t", text: t }), i.detail ? h("p", { cls: "hia-d", text: i.detail }) : null, sub]), acts.firstChild ? acts : null]));
    return li;
  }
  // "Assign" under its own row; one at a time
  function form(host, li, i, o) {
    var s = st(host); if (s.saving) return;
    var old = host.querySelector(".hia-form"); if (old) old.parentNode.removeChild(old);
    if (s.openId === i.id) { s.openId = null; return; }
    s.openId = i.id;
    var pk = picker({ quoteId: o.quoteId, tasks: o.tasks, locked: o.locked, owner: i.owner, ids: "hiaR" });
    var err = h("p", { cls: "hia-err", role: "alert", hidden: true });
    var go = h("button", { type: "submit", cls: "hia-btn is-main", "data-key": "ia:save", text: "Save" }), no = h("button", { type: "button", cls: "hia-btn", text: "Cancel" });
    var f = h("form", { cls: "hia-form", "aria-label": "Who handles: " + (i.title || "issue"), novalidate: true }, [pk.el, err, h("div", { cls: "hia-foot" }, [go, no])]);
    function close() { s.openId = null; if (f.parentNode) f.parentNode.removeChild(f); s.sig = ""; if (s.last) list(host, s.last); var b = host.querySelector('[data-key="ia:a:' + i.id + '"]'); if (b) try { b.focus(); } catch (e) {} }
    no.addEventListener("click", close);
    f.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!s.saving) close(); } });
    f.addEventListener("submit", async function (e) {
      e.preventDefault(); if (s.saving) return;
      var v = pk.value(); if (v.error) { err.textContent = v.error; err.hidden = false; pk.focus(); return; }
      s.saving = true; go.disabled = no.disabled = true; err.hidden = true;
      try {
        var r = await assign(i, o.quoteId, v); if (o.toast) o.toast(r.msg, r.ok ? "ok" : "err");
        s.saving = false; s.openId = null; try { if (r.task && r.task.ok && o.onTask) o.onTask(); await o.reload(); } catch (x) {} close();
      } catch (x) { s.saving = false; err.textContent = errText(x, "assign the issue"); err.hidden = false; go.disabled = no.disabled = false; }
    });
    li.appendChild(f); pk.focus();
  }

  global.HelmIssueAssign = { picker: picker, list: list, busy: busy, giveTask: giveTask, withTask: withTask, assign: assign, refused: refused, CAT: CAT, _pure: PURE };
})(typeof window !== "undefined" ? window : globalThis);

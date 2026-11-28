/* studio-links.js - R271 (0454): Settings > "Links going out". Every link the studio handed out (client page and approval, event
   booklet, proposal, invitation website, crew task links, crew home links, vendor request links, delivery links, team join links),
   newest first, with a search and filters by kind and by event. Per link: Turn off (a plain confirm says who loses access), Turn back
   on / New link where the database has a safe way, and "Open its page" (the link itself is copied on that page, never here: the
   list carries names only, never a token). Tick several -> Turn off.
   Reads and writes ONLY through BPStore.studioLinks (studio_links_list / studio_link_off / studio_links_off / studio_link_on /
   studio_link_new - studio admins only, checked in the database). Hidden for everyone else and on a database without 0454.
   DOM API only (createElement / textContent), no HTML strings, no inline styles. */
(function (global) {
  "use strict";

  var KIND = {
    approval: "Client page and approval", booklet: "Event booklet", proposal: "Proposal", site: "Invitation website",
    crew: "Crew task link", staff: "Crew home link", vendor: "Vendor request link", delivery: "Delivery link", team: "Team join link"
  };
  var ORDER = ["approval", "booklet", "proposal", "site", "crew", "staff", "vendor", "delivery", "team"];
  var STATUS = { live: "Live", expired: "Expired", off: "Turned off", cancelled: "Event cancelled", paused: "Paused", used: "Used" };

  function kindLabel(k) { return KIND[k] || "Link"; }
  function statusLabel(s) { return STATUS[s] || "Live"; }
  function who(r) { var w = String((r && r.who) || "").trim(); return w || (r && r.kind === "site" ? "Guests" : "Not named"); }
  function eventText(r) {
    if (!r || !r.quote_id) return r && r.kind === "team" ? "Your team" : r && r.kind === "staff" ? "All their events" : "";
    return [r.event_code, r.event_title].filter(function (x) { return x && String(x).trim(); }).join(" ") || "Event";
  }
  // the page a link belongs to (where it is copied or sent again)
  function pageHref(r) {
    var q = r && r.quote_id ? encodeURIComponent(r.quote_id) : "";
    switch (r && r.kind) {
      case "approval": case "booklet": case "delivery": return q ? "event.html?id=" + q : "";
      case "proposal": return q ? "proposal.html?quote=" + q : "";
      case "site": return q ? "invite-studio.html?quote=" + q : "";
      case "crew": return q ? "ops.html?quote=" + q : "";
      case "vendor": return q ? "vendors.html?tab=requests&quote=" + q + (r.request_id ? "&req=" + encodeURIComponent(r.request_id) : "") : "vendors.html?tab=requests";
      case "staff": return "staff.html";
      case "team": return "control.html#users";
    }
    return "";
  }
  // who loses access, in plain words
  function offText(r) {
    var w = who(r);
    switch (r && r.kind) {
      case "approval": return w + " can no longer open their client page: the quote, approval, payments and portal. You can turn it back on here.";
      case "booklet": return w + " can no longer open the event booklet. To share it again, send a new booklet from the event page.";
      case "proposal": return w + " can no longer open the proposal. You can turn it back on here.";
      case "site": return "Guests can no longer open the invitation website. You can turn it back on here.";
      case "crew": return w + " can no longer open their task link for this event. To give them a new link, send their tasks again.";
      case "staff": return w + " can no longer open their crew home link. Helm makes a new one the next time it sends them a message.";
      case "vendor": return w + " can no longer open this request link. You can turn it back on here.";
      case "delivery": return w + " can no longer update this delivery. You can turn it back on here.";
      case "team": return w + " can no longer use this invite to join your studio. Send a new invite from Users and invites.";
    }
    return "The person it was sent to can no longer open it.";
  }
  function newText(r) {
    if (r && r.kind === "site") return "The old invitation address stops working at once. Copy the new one on the invitation page and send it to your guests.";
    return "The old link stops working at once. " + who(r) + " gets the new one the next time Helm sends them a message.";
  }
  function day(iso) {
    if (!iso) return "";
    var d = new Date(iso); if (isNaN(d.getTime())) return "";
    try { return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function metaText(r) {
    var p = [];
    if (r.created_at) p.push("Sent " + day(r.created_at));
    if (r.expires_at) p.push((new Date(r.expires_at).getTime() <= Date.now() ? "Ended " : "Ends ") + day(r.expires_at));
    if (r.last_opened_at) p.push((r.kind === "team" ? "Joined " : "Last opened ") + day(r.last_opened_at));
    return p.join(" · ");
  }
  function norm(s) { return String(s || "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim(); }
  // the rows the filters keep (search over kind, status, event, who)
  function filter(rows, f) {
    f = f || {};
    var words = norm(f.q).split(" ").filter(Boolean);
    return (rows || []).filter(function (r) {
      if (!r) return false;
      if (f.kind && r.kind !== f.kind) return false;
      if (f.quote && r.quote_id !== f.quote) return false;
      if (f.status === "live" && r.status !== "live") return false;
      if (f.status === "off" && r.status !== "off") return false;
      if (!words.length) return true;
      var hay = norm([kindLabel(r.kind), statusLabel(r.status), eventText(r), r.who].join(" "));
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
  }
  function events(rows) {
    var seen = {}, out = [];
    (rows || []).forEach(function (r) { if (r && r.quote_id && !seen[r.quote_id]) { seen[r.quote_id] = 1; out.push({ id: r.quote_id, text: eventText(r) }); } });
    return out.sort(function (a, b) { return a.text.localeCompare(b.text); });
  }

  var api = { KIND: KIND, ORDER: ORDER, STATUS: STATUS, kindLabel: kindLabel, statusLabel: statusLabel, who: who, eventText: eventText,
    pageHref: pageHref, offText: offText, newText: newText, metaText: metaText, filter: filter, events: events };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ---------------------------------------------------------------- the card
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  var st = { rows: [], more: false, busy: false, f: { q: "", kind: "", quote: "", status: "" }, ticked: {} }, ui = {}, started = false, tries = 0;
  function B() { return global.BPStore; }
  function U() { return global.BPUI || {}; }
  function errText(e, what) {
    var m = e && (e.message || e.error_description || e.details);
    if (U().friendlyError) { try { var t = U().friendlyError(e, what); if (t) return t; } catch (x) {} }
    return m ? String(m) : "Could not " + what + ". Please try again.";
  }
  function say(t, bad) { ui.msg.textContent = t || ""; ui.msg.classList.toggle("sl-bad", !!bad); }
  function toast(t, type) { try { if (U().toast) U().toast(t, { type: type || "success" }); } catch (e) {} }
  async function ask(text, title, ok) {
    if (U().confirm) return !!(await U().confirm(text, { title: title, okLabel: ok }));
    return global.confirm ? global.confirm(text) : false;
  }
  function key(r) { return r.kind + ":" + r.id; }

  function build(card) {
    card.textContent = "";
    card.appendChild(el("h3", null, "Links going out"));
    card.appendChild(el("p", "mnote", "Every link your studio has sent to clients, crew, vendors and new team members. Turn off any link you no longer want to work. To copy a link, open its page."));
    var bar = el("div", "sl-filters");
    var fq = el("div", "fld sl-search"), lq = el("label", null, "Search"), iq = el("input");
    iq.id = "sl_q"; iq.type = "search"; iq.autocomplete = "off"; iq.placeholder = "Name, event or kind"; iq.maxLength = 80; lq.htmlFor = "sl_q";
    fq.appendChild(lq); fq.appendChild(iq);
    var fk = el("div", "fld"), lk = el("label", null, "Kind"), sk = el("select"); sk.id = "sl_kind"; lk.htmlFor = "sl_kind";
    sk.appendChild(new Option("All kinds", "")); ORDER.forEach(function (k) { sk.appendChild(new Option(KIND[k], k)); });
    fk.appendChild(lk); fk.appendChild(sk);
    var fe = el("div", "fld"), le = el("label", null, "Event"), se = el("select"); se.id = "sl_event"; le.htmlFor = "sl_event";
    se.appendChild(new Option("All events", "")); fe.appendChild(le); fe.appendChild(se);
    var fs = el("div", "fld"), ls = el("label", null, "Show"), ss = el("select"); ss.id = "sl_status"; ls.htmlFor = "sl_status";
    [["", "All links"], ["live", "Live only"], ["off", "Turned off only"]].forEach(function (o) { ss.appendChild(new Option(o[1], o[0])); });
    fs.appendChild(ls); fs.appendChild(ss);
    bar.appendChild(fq); bar.appendChild(fk); bar.appendChild(fe); bar.appendChild(fs);
    card.appendChild(bar);
    var bulk = el("div", "sl-bulk");
    var all = el("label", "sl-all"), ca = el("input"); ca.type = "checkbox"; ca.id = "sl_all"; all.appendChild(ca); all.appendChild(el("span", null, "Tick all shown"));
    var bo = el("button", "btn sl-bulk-off", "Turn off ticked"); bo.type = "button"; bo.id = "sl_bulk_off"; bo.disabled = true;
    bulk.appendChild(all); bulk.appendChild(bo); card.appendChild(bulk);
    var msg = el("p", "mnote sl-msg"); msg.id = "sl_msg"; msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite"); card.appendChild(msg);
    var list = el("ul", "sl-list"); list.id = "sl_list"; list.setAttribute("aria-label", "Links going out"); card.appendChild(list);
    var more = el("button", "btn sl-more", "Show older links"); more.type = "button"; more.id = "sl_more"; more.hidden = true; card.appendChild(more);
    ui = { card: card, q: iq, kind: sk, ev: se, status: ss, all: ca, bulkOff: bo, msg: msg, list: list, more: more };
    var redraw = function () { st.f = { q: iq.value, kind: sk.value, quote: se.value, status: ss.value }; draw(); };
    iq.addEventListener("input", redraw); sk.addEventListener("change", redraw); se.addEventListener("change", redraw); ss.addEventListener("change", redraw);
    ca.addEventListener("change", function () { shown().forEach(function (r) { if (r.can_off) { if (ca.checked) st.ticked[key(r)] = r; else delete st.ticked[key(r)]; } }); draw(); });
    bo.addEventListener("click", function () { bulkOff(); });
    more.addEventListener("click", function () { load(true); });
  }
  function shown() { return filter(st.rows, st.f); }
  function fillEvents() {
    var cur = ui.ev.value, list = events(st.rows);
    while (ui.ev.options.length > 1) ui.ev.remove(1);
    list.forEach(function (e) { ui.ev.appendChild(new Option(e.text, e.id)); });
    ui.ev.value = list.some(function (e) { return e.id === cur; }) ? cur : "";
  }
  function row(r) {
    var li = el("li", "sl-row sl-" + (r.status || "live")); li.dataset.kind = r.kind;
    var tick = el("label", "sl-tick"), cb = el("input"); cb.type = "checkbox";
    cb.setAttribute("aria-label", "Tick " + kindLabel(r.kind) + " for " + who(r));
    cb.checked = !!st.ticked[key(r)]; cb.disabled = !r.can_off;
    cb.addEventListener("change", function () { if (cb.checked) st.ticked[key(r)] = r; else delete st.ticked[key(r)]; paintBulk(); });
    tick.appendChild(cb); li.appendChild(tick);
    var main = el("div", "sl-main");
    var top = el("div", "sl-top"); top.appendChild(el("span", "sl-kind", kindLabel(r.kind))); top.appendChild(el("span", "sl-pill sl-pill-" + (r.status || "live"), statusLabel(r.status)));
    main.appendChild(top);
    main.appendChild(el("div", "sl-who", "For " + who(r)));
    var ev = eventText(r); if (ev) main.appendChild(el("div", "sl-event", ev));
    var meta = metaText(r); if (meta) main.appendChild(el("div", "sl-meta", meta));
    li.appendChild(main);
    var acts = el("div", "sl-acts");
    if (r.can_off) { var b = el("button", "btn sl-off", "Turn off"); b.type = "button"; b.addEventListener("click", function () { act("off", r, b); }); acts.appendChild(b); }
    if (r.can_on) { var o = el("button", "btn sl-on", "Turn back on"); o.type = "button"; o.addEventListener("click", function () { act("on", r, o); }); acts.appendChild(o); }
    if (r.can_new) { var n = el("button", "btn sl-new", "New link"); n.type = "button"; n.addEventListener("click", function () { act("new", r, n); }); acts.appendChild(n); }
    var href = pageHref(r);
    if (href) { var a = el("a", "btn sl-open", "Open its page"); a.href = href; a.setAttribute("aria-label", "Open the page of this " + kindLabel(r.kind).toLowerCase()); acts.appendChild(a); }
    li.appendChild(acts);
    return li;
  }
  function paintBulk() {
    var n = Object.keys(st.ticked).length;
    ui.bulkOff.disabled = n === 0 || st.busy; ui.bulkOff.textContent = n ? "Turn off ticked (" + n + ")" : "Turn off ticked";
    var can = shown().filter(function (r) { return r.can_off; });
    ui.all.checked = can.length > 0 && can.every(function (r) { return st.ticked[key(r)]; });
  }
  function draw() {
    var list = shown();
    ui.list.textContent = "";
    if (!st.rows.length) ui.list.appendChild(el("li", "sl-none", "No links have been sent yet."));
    else if (!list.length) ui.list.appendChild(el("li", "sl-none", "No links match. Clear the search or pick another kind or event."));
    list.forEach(function (r) { ui.list.appendChild(row(r)); });
    ui.more.hidden = !st.more;
    Object.keys(st.ticked).forEach(function (k) { if (!st.rows.some(function (r) { return key(r) === k && r.can_off; })) delete st.ticked[k]; });
    paintBulk();
  }
  async function load(older) {
    if (st.busy) return; st.busy = true;
    try {
      var last = older && st.rows.length ? st.rows[st.rows.length - 1].created_at : null;
      var res = await B().studioLinks.list({ limit: 200, before: last });
      if (!res) { if (!older) ui.card.hidden = true; return false; }
      var rows = Array.isArray(res.rows) ? res.rows : [];
      st.rows = older ? st.rows.concat(rows) : rows; st.more = !!res.more;
      fillEvents(); draw(); ui.card.hidden = false;
      return true;
    } catch (e) {
      if (U().isPermissionError && U().isPermissionError(e)) { ui.card.hidden = true; return false; }
      ui.card.hidden = false; say(errText(e, "load the links"), true); return false;
    } finally { st.busy = false; paintBulk(); }
  }
  async function act(what, r, btn) {
    var title = what === "off" ? "Turn off this link?" : what === "on" ? "Turn this link back on?" : "Make a new link?";
    var text = what === "off" ? offText(r) : what === "on" ? who(r) + " can open it again, as before." : newText(r);
    var ok = what === "off" ? "Turn off" : what === "on" ? "Turn back on" : "Make a new link";
    if (!(await ask(text, title, ok))) return;
    btn.disabled = true;
    try {
      var S = B().studioLinks, res = what === "off" ? await S.off(r.kind, r.id) : what === "on" ? await S.on(r.kind, r.id) : await S.renew(r.kind, r.id);
      if (!res) { say("Links going out is not ready on this database yet.", true); return; }
      toast(what === "off" ? "Link turned off." : what === "on" ? "Link turned back on." : "New link made. Copy it on its page.");
      say("");
      await load(false);
    } catch (e) { say(errText(e, what === "off" ? "turn the link off" : what === "on" ? "turn the link back on" : "make a new link"), true); }
    finally { btn.disabled = false; }
  }
  async function bulkOff() {
    var items = Object.keys(st.ticked).map(function (k) { return st.ticked[k]; });
    if (!items.length) return;
    if (!(await ask("The " + items.length + " ticked link" + (items.length === 1 ? "" : "s") + " stop working at once. The people they were sent to can no longer open them.",
      "Turn off " + items.length + " link" + (items.length === 1 ? "" : "s") + "?", "Turn off"))) return;
    ui.bulkOff.disabled = true;
    try {
      var res = await B().studioLinks.offMany(items.map(function (r) { return { kind: r.kind, id: r.id }; }));
      if (!res) { say("Links going out is not ready on this database yet.", true); return; }
      st.ticked = {};
      var bad = Array.isArray(res.failed) ? res.failed.length : 0;
      toast(bad ? (Number(res.turned_off) || 0) + " turned off, " + bad + " could not be turned off." : "Links turned off.", bad ? "warn" : "success");
      say(bad ? bad + " link" + (bad === 1 ? "" : "s") + " could not be turned off. Open its page to check." : "", !!bad);
      await load(false);
    } catch (e) { say(errText(e, "turn the links off"), true); }
    finally { paintBulk(); }
  }
  async function init() {
    if (started) return;
    var card = $("slCard"); if (!card) return;
    var S = B();
    if (!S || !S.studioLinks || !S.auth || !S.auth.user || !S.auth.user()) { if (++tries < 30) setTimeout(init, 1000); return; }
    started = true;
    var role = null; try { role = await S.auth.role(); } catch (e) { role = null; }
    if (role !== "admin") return;                       // studio admins only (the database checks again)
    build(card);
    await load(false);
  }
  api.init = init;
  global.HelmStudioLinks = api;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 700); });
  else setTimeout(init, 700);
})(typeof window !== "undefined" ? window : globalThis);

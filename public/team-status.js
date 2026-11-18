/* team-status.js - R199 (owner 17 Nov 2026): one clear ACCOUNT STATUS per person in Settings -> Users & invites.
   "Complete / Incomplete" only said whether the profile had a name + mobile number; the owner read "Complete" as
   "has signed up". This file turns the 0378 answer (team_account_status: sign-in facts of MY studio's people + the open
   invitations) into plain words, and draws the "View" details drawer. Pure helpers are unit-tested in
   test/r199-team-invites.test.mjs. The drawer is built with textContent only (no HTML strings).

     HelmTeamStatus.member(u, acct, now)  -> { key, tone, label, detail, title }
         key: active | never | setup | off | unknown     (acct = the 0378 row for u, or null on a database without 0378)
     HelmTeamStatus.invite(inv, now)      -> { key: invited | expired, tone, label, detail, title }
     HelmTeamStatus.signInHelp(state, acct, { self, isAdmin, canEdit, deactivated }) -> R202: Send sign-in link / New temporary password
     HelmTeamStatus.rowActions(state, acct, { invite, self, owner, deactivated, canEdit, isAdmin }) -> R211: the row's buttons, in order
     HelmTeamStatus.profileHint(u, priv)  -> "Profile: mobile number missing" | "" (complete)
     HelmTeamStatus.ago(iso, now) / until(iso, now) / when(iso, time)
     HelmTeamStatus.matches(state, filter) -> does this row pass the "Show" filter
     HelmTeamStatus.openDrawer({ title, sub, rows: [[label, value, { copy, mono }]], actions: [{ label, onClick, danger, primary }] }) */
(function (root) {
  "use strict";
  function ts(v) { if (v == null || v === "") return null; var t = typeof v === "number" ? v : Date.parse(v); return isFinite(t) ? t : null; }
  function when(v, time) {
    var t = ts(v); if (t == null) return "";
    try { var B = root.BPStore; if (B && typeof B.fmtStudioDate === "function") { var o = B.fmtStudioDate(new Date(t), time ? { style: "long", time: true } : { style: "long" }); if (o) return o; } } catch (e) {}
    try { return new Date(t).toLocaleString("en-IN", time ? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }
      : { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }); } catch (e) { return new Date(t).toISOString().slice(0, 10); }
  }
  function nowMs(now) { var n = ts(now); return n == null ? Date.now() : n; }
  // "just now" / "5 min ago" / "3 hours ago" / "yesterday" / "4 days ago" / "on 2 Sept 2026"
  function ago(v, now) {
    var t = ts(v); if (t == null) return "";
    var m = Math.floor(Math.max(0, nowMs(now) - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    var d = Math.floor(h / 24); if (d === 1) return "yesterday";
    if (d < 30) return d + " days ago";
    return "on " + when(v);
  }
  // "in 5 hours" / "in 3 days" / "" when it is in the past
  function until(v, now) {
    var t = ts(v); if (t == null) return "";
    var m = Math.floor((t - nowMs(now)) / 60000); if (m <= 0) return "";
    if (m < 60) return "in " + m + " min";
    var h = Math.floor(m / 60); if (h < 24) return "in " + h + (h === 1 ? " hour" : " hours");
    var d = Math.floor(h / 24); return "in " + d + (d === 1 ? " day" : " days");
  }
  function andList(a) { return a.length < 2 ? (a[0] || "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }

  /* one member's account status. u = the member_profile_list row, acct = the 0378 members[] row (or null). */
  function member(u, acct, now) {
    u = u || {}; var a = acct || null;
    var joined = (a && a.joined_at) || u.created_at || null;
    var joinedTxt = joined ? "Joined " + when(joined) : "";
    if ((a && a.deactivated) || u.deactivated === true) {
      return { key: "off", tone: "off", label: "Deactivated", detail: a && a.deactivated_at ? "Since " + when(a.deactivated_at) + " · can’t sign in, records kept" : "Can’t sign in, records kept",
        title: "Can’t sign in or see studio data. Everything they made is kept. Reactivate to let them back in." };
    }
    if (!a) return { key: "unknown", tone: "muted", label: "Member", detail: joinedTxt, title: "Sign-in times show after the database update 0378" };
    var last = ts(a.last_sign_in_at);
    if (last == null && a.needs_password) {
      return { key: "setup", tone: "warn", label: "Signed up – no password yet", detail: [joinedTxt, a.signin_link_at ? "sign-in link sent " + ago(a.signin_link_at, now) : ""].filter(Boolean).join(" · "),
        title: "Their login was made by the invitation e-mail and has no password yet. Use “Send sign-in link”, or they can use “Forgot password?” on the sign-in page." };
    }
    if (last == null) {
      // R202: plainer words for an "Add user" login ("Added – never signed in · temporary password not used yet" read as jargon)
      var link = a.signin_link_at ? "sign-in link sent " + ago(a.signin_link_at, now) : "";
      if (a.temp_password) {
        return { key: "never", tone: "warn", label: "Added by admin – hasn’t signed in yet",
          detail: ["Temporary password unused", link, joined ? "Added " + when(joined) : ""].filter(Boolean).join(" · "),
          title: "An admin made this login with “Add user” and a one-time temporary password (shown once). They haven’t signed in yet. Use “Send sign-in link” to e-mail them a link to set their own password." };
      }
      return { key: "never", tone: "warn", label: "Signed up – never signed in", detail: [joinedTxt, link].filter(Boolean).join(" · "),
        title: "Their account exists but they have never signed in." };
    }
    return { key: "active", tone: "ok", label: "Last signed in " + ago(a.last_sign_in_at, now),
      detail: joinedTxt + (a.temp_password ? (joinedTxt ? " · " : "") + "still on the temporary password" : ""),
      title: "Last sign-in: " + when(a.last_sign_in_at, true) };
  }

  /* R202 (0379): which sign-in help a member's row / View panel offers.
     o = { self, isAdmin, canEdit, deactivated }   ->  { row, link, temp, reactivateFirst, linkSentAt, why }
       row:  show "Send sign-in link" on the table row (never signed in / no password yet)
       link: offer it in the View panel (anyone not deactivated, not yourself)
       temp: "New temporary password" (admins; the database says can_new_temp: a never-used Add user login)
       reactivateFirst: a deactivated person - explain "Reactivate first, then send a sign-in link" */
  function signInHelp(state, acct, o) {
    o = o || {}; var a = acct || null, k = state && state.key;
    var none = { row: false, link: false, temp: false, reactivateFirst: false, linkSentAt: a && a.signin_link_at || null, why: "" };
    if (!a || o.self || !(o.isAdmin || o.canEdit)) return none;
    if (k === "off" || o.deactivated) { none.reactivateFirst = true; none.why = "Reactivate first, then send a sign-in link."; return none; }
    var never = k === "never" || k === "setup";
    return { row: never, link: true, temp: !!(o.isAdmin && a.can_new_temp === true), reactivateFirst: false, linkSentAt: a.signin_link_at || null,
      why: never ? "E-mails them a secure link to choose their own password (the same e-mail as “Forgot password?”). Once every 10 minutes."
                 : "E-mails them a secure link to set a new password (the same e-mail as “Forgot password?”). Once every 10 minutes." };
  }

  /* R211 (owner 18 Nov 2026): the buttons on ONE row of the members table, in order - every person who is not active yet
     gets ONE obvious next step first (primary). Pure: the page draws them, the database still decides every action.
     state = member() / invite() answer, acct = the 0378/0379 row (or null), o = { invite, self, owner, deactivated, canEdit, isAdmin }
     -> [{ key, primary? }] with key one of:
        resend / copy / cancel   an invitation: Resend invite, Copy link, Cancel invite (an expired link: no Copy link)
        link                     Send sign-in link (never signed in / no password yet; admins + Users edit, never yourself)
        react / work             Reactivate (the right next step shows straight after) / Open work - a deactivated person
        view / edit              View details (New temporary password lives there) / Edit profile
        remove                   Remove access = deactivate someone who never signed in (nothing is deleted)
        deactivate               Deactivate someone who has signed in
     Signed in normally -> no invite / sign-in actions at all. */
  function rowActions(state, acct, o) {
    o = o || {}; var k = state && state.key, out = [];
    var add = function (key, primary) { out.push(primary ? { key: key, primary: true } : { key: key }); };
    if (o.invite) {
      if (!o.canEdit) return out;
      add("resend", true); if (k !== "expired") add("copy"); add("cancel"); add("view");
      return out;
    }
    if (k === "off" || o.deactivated) {
      if (o.canEdit && !o.self && !o.owner) { add("react", true); add("work"); }
      add("view"); if (o.canEdit) add("edit");
      return out;
    }
    var help = signInHelp(state, acct, { self: o.self, isAdmin: o.isAdmin, canEdit: o.canEdit, deactivated: false });
    if (help.row) add("link", true);
    add("view"); if (o.canEdit) add("edit");
    if (o.canEdit && !o.self && !o.owner) add(help.row ? "remove" : "deactivate");   // view-only: no Deactivate / Remove access
    return out;
  }

  /* an open invitation (0378 invites[] row, or an invitations.list() row) */
  function invite(inv, now) {
    inv = inv || {};
    var exp = ts(inv.expires_at), expired = inv.expired === true || (exp != null && exp <= nowMs(now));
    var sent = inv.created_at ? "Sent " + when(inv.created_at) : "";
    if (expired) {
      return { key: "expired", tone: "off", label: "Invite expired – not signed up",
        detail: [sent, exp != null ? "link expired " + when(inv.expires_at) : ""].filter(Boolean).join(" · "),
        title: "The join link no longer works. Use “Resend invite” to send a new link (valid 7 days)." };
    }
    var u = until(inv.expires_at, now);
    return { key: "invited", tone: "warn", label: "Invited – not signed up yet",
      detail: [sent, exp != null ? "link expires " + when(inv.expires_at, true) + (u ? " (" + u + ")" : "") : ""].filter(Boolean).join(" · "),
      title: "They haven’t used the join link yet." + (inv.emailed_at ? " Invitation e-mail sent " + when(inv.emailed_at, true) + "." : "") };
  }

  /* profile completeness as a SEPARATE small hint. priv = the phone column was returned (admins / Users view). */
  function profileHint(u, priv) {
    u = u || {}; if (u.complete === true) return "";
    var miss = [];
    if (!String(u.full_name || "").trim()) miss.push("name");
    if (priv && !String(u.phone || "").trim()) miss.push("mobile number");
    if (miss.length) return "Profile: " + andList(miss) + " missing";
    return u.complete === false ? "Profile incomplete" : "";
  }

  /* the "Show" filter of the members table: "" everyone | invited | never | active | off | incomplete | complete */
  function matches(state, filter, u) {
    if (!filter) return true;
    var k = state && state.key;
    if (filter === "invited") return k === "invited" || k === "expired";
    if (filter === "never") return k === "never" || k === "setup";
    if (filter === "active") return k === "active" || k === "unknown";
    if (filter === "off") return k === "off";
    if (filter === "incomplete") return !!u && !u.__invite && u.complete === false;
    if (filter === "complete") return !!u && !u.__invite && u.complete === true;
    return true;
  }

  /* ---------------- the details drawer (one per page, re-used) ---------------- */
  var drawer = null, opener = null;
  function mk(tag, cls, text) { var e = root.document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function copyText(text, btn) {
    var done = function (ok) { if (!btn) return; var old = btn.textContent; btn.textContent = ok ? "Copied" : "Select + copy"; setTimeout(function () { btn.textContent = old; }, 1600); };
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) { root.navigator.clipboard.writeText(String(text)).then(function () { done(true); }, function () { done(false); }); return; }
    } catch (e) {}
    done(false);
  }
  function closeDrawer() {
    if (!drawer) return; drawer.hidden = true;
    if (opener && opener.isConnected) { try { opener.focus(); } catch (e) {} }
    opener = null;
  }
  function ensureDrawer() {
    if (drawer && drawer.isConnected) return drawer;
    var d = root.document;
    drawer = mk("div", "lmodal tsd-modal"); drawer.id = "tsdModal"; drawer.hidden = true;
    drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); drawer.setAttribute("aria-labelledby", "tsd_title");
    var sheet = mk("div", "sheet tsd-sheet");
    var head = mk("div", "tsd-head");
    var h = mk("h3", "tsd-title"); h.id = "tsd_title";
    var x = mk("button", "close tsd-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.setAttribute("data-close", "");
    x.addEventListener("click", closeDrawer);
    head.appendChild(h); head.appendChild(x);
    var sub = mk("p", "tsd-sub"); sub.id = "tsd_sub";
    var dl = mk("dl", "tsd-list"); dl.id = "tsd_list";
    var acts = mk("div", "tsd-acts"); acts.id = "tsd_acts";
    sheet.appendChild(head); sheet.appendChild(sub); sheet.appendChild(dl); sheet.appendChild(acts);
    drawer.appendChild(sheet);
    drawer.addEventListener("click", function (e) { if (e.target === drawer) closeDrawer(); });
    drawer.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); closeDrawer(); } });
    d.body.appendChild(drawer);
    return drawer;
  }
  function openDrawer(o) {
    o = o || {}; var dr = ensureDrawer(), d = root.document;
    opener = d.activeElement || null;
    d.getElementById("tsd_title").textContent = String(o.title || "Details");
    var sub = d.getElementById("tsd_sub"); sub.textContent = String(o.sub || ""); sub.hidden = !o.sub;
    var dl = d.getElementById("tsd_list"); while (dl.firstChild) dl.removeChild(dl.firstChild);
    (o.rows || []).forEach(function (r) {
      if (!r || r[1] == null || r[1] === "") return;
      var opt = r[2] || {}, row = mk("div", "tsd-row" + (opt.tone ? " tsd-" + opt.tone : ""));
      row.appendChild(mk("dt", null, r[0]));
      var dd = mk("dd", opt.mono ? "tsd-mono" : null); dd.appendChild(mk("span", "tsd-val", r[1]));
      if (opt.copy) { var b = mk("button", "btn sm tsd-copy", "Copy"); b.type = "button"; b.setAttribute("aria-label", "Copy " + r[0]);
        b.addEventListener("click", function () { copyText(r[1], b); }); dd.appendChild(b); }
      row.appendChild(dd); dl.appendChild(row);
    });
    var acts = d.getElementById("tsd_acts"); while (acts.firstChild) acts.removeChild(acts.firstChild);
    (o.actions || []).forEach(function (a) {
      if (!a || !a.label) return;
      var b = mk("button", "btn" + (a.primary ? " primary" : "") + (a.danger ? " tsd-danger" : ""), a.label); b.type = "button";
      if (a.title) b.title = a.title;
      if (a.disabled) { b.disabled = true; }
      b.addEventListener("click", function () { if (a.keepOpen !== true) closeDrawer(); try { a.onClick && a.onClick(b); } catch (e) {} });
      acts.appendChild(b);
    });
    var done = mk("button", "btn", "Close"); done.type = "button"; done.addEventListener("click", closeDrawer); acts.appendChild(done);
    dr.hidden = false;
    setTimeout(function () { try { (d.querySelector("#tsd_acts .btn") || d.getElementById("tsd_title")).focus(); } catch (e) {} }, 30);
    return dr;
  }

  var api = { member: member, invite: invite, signInHelp: signInHelp, rowActions: rowActions, profileHint: profileHint, matches: matches, ago: ago, until: until, when: when,
    openDrawer: openDrawer, closeDrawer: closeDrawer, copyText: copyText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HelmTeamStatus = api;
})(typeof window !== "undefined" ? window : globalThis);

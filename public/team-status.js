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
     HelmTeamStatus.roleSaved(asked, saved, loaded, label) -> R210: what the Users table says after a role change, from the
         role the DATABASE answers on a fresh read (never the one picked in the drop-down) -> { ok, tone, text }
     HelmTeamStatus.roleError(err) -> R210: the database's refusal of a role change in plain words, or "" (not one of them)
     HelmTeamStatus.openDrawer({ title, sub, rows: [[label, value, { copy, mono }]], actions: [{ label, onClick, danger, primary }] })
     HelmTeamStatus.rowMenus(tbody) -> R228: keyboard-friendly "..." menus of the members table (wired once) */
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

  /* R228: the "..." menu of each row in Settings -> Users & invites. The page draws, per row,
       <button class="ucMore" aria-haspopup="menu" aria-expanded aria-controls="ID"> + <div class="ucmenu" id="ID" role="menu" hidden>
       with role="menuitem" buttons. Wired ONCE on the table body (rows are redrawn): click / Enter / Space / Down opens on the
       first item, Up on the last; Up / Down / Home / End move; Esc and Tab close and return focus to "..."; a click outside,
       a scroll or a resize closes it. Choosing an item closes the menu FIRST (capture phase) and puts focus back on "...",
       so a confirm dialog the item opens returns focus to a visible control. The menu floats (position: fixed), so a
       scrolling table never clips it. */
  function rowMenus(box) {
    if (!box || box.__helmRowMenus) return; box.__helmRowMenus = true;
    var d = root.document, open = null;
    function items(m) { return Array.prototype.filter.call(m.querySelectorAll('[role="menuitem"]'), function (b) { return !b.disabled && !b.hidden; }); }
    function focus(n) { if (n) { try { n.focus({ preventScroll: true }); } catch (e) { try { n.focus(); } catch (e2) {} } } }
    function close(back) {
      if (!open) return; var o = open; open = null;
      o.menu.hidden = true; o.menu.style.left = o.menu.style.top = ""; o.btn.setAttribute("aria-expanded", "false");
      if (back && o.btn.isConnected) focus(o.btn);
    }
    function place(btn, m) {
      var r = btn.getBoundingClientRect(), de = d.documentElement, vw = de.clientWidth, vh = de.clientHeight;
      m.style.visibility = "hidden"; m.style.left = "0px"; m.style.top = "0px"; m.hidden = false;
      // a container query / transform ancestor becomes the fixed menu's containing block: measure where 0,0 really is
      var o = m.getBoundingClientRect();
      var w = m.offsetWidth, h = m.offsetHeight, left = r.right - w < 8 ? r.left : r.right - w, top = r.bottom + 4;   // under "...", right-aligned (left-aligned when that would leave the screen)
      left = Math.max(8, Math.min(left, vw - w - 8));
      if (top + h > vh - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
      m.style.left = Math.round(left - o.left) + "px"; m.style.top = Math.round(top - o.top) + "px"; m.style.visibility = "";
    }
    function show(btn, which) {
      close(false);
      var m = d.getElementById(btn.getAttribute("aria-controls") || ""); if (!m) return;
      open = { btn: btn, menu: m }; btn.setAttribute("aria-expanded", "true"); place(btn, m);
      var it = items(m); focus(which === "last" ? it[it.length - 1] : it[0]);
    }
    box.addEventListener("click", function (e) {
      var it = e.target.closest && e.target.closest('.ucmenu [role="menuitem"]');
      if (it && open && open.menu.contains(it)) close(true);
    }, true);
    box.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".ucMore"); if (!b || !box.contains(b)) return;
      e.preventDefault(); if (open && open.btn === b) close(true); else show(b, "first");
    });
    box.addEventListener("keydown", function (e) {
      var b = e.target.closest && e.target.closest(".ucMore");
      if (b && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); show(b, e.key === "ArrowUp" ? "last" : "first"); return; }
      if (!open || !open.menu.contains(e.target)) return;
      var it = items(open.menu), i = it.indexOf(e.target), n = it.length; if (!n) return;
      if (e.key === "ArrowDown") { e.preventDefault(); focus(it[(i + 1) % n]); }
      else if (e.key === "ArrowUp") { e.preventDefault(); focus(it[(i - 1 + n) % n]); }
      else if (e.key === "Home") { e.preventDefault(); focus(it[0]); }
      else if (e.key === "End") { e.preventDefault(); focus(it[n - 1]); }
      else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); close(true); }
    });
    d.addEventListener("click", function (e) { if (open && !open.menu.contains(e.target) && !open.btn.contains(e.target)) close(false); });
    d.addEventListener("scroll", function (e) { if (open && !open.menu.contains(e.target)) close(false); }, true);
    root.addEventListener("resize", function () { close(false); });
  }

  // R210 (owner 18 Nov 2026: "Even if I change this to Event manager, the person is getting Admin"): the Users table used
  // to write the picked role into its own copy and say "Role updated." without asking the database again. Now the page
  // re-reads the team after the change and this decides the words from the role the database actually holds.
  //   asked = the role picked, saved = the role on the fresh read (null / "" when it could not be read), loaded = the
  //   fresh read worked, label = role key -> words ("Event manager").
  function roleSaved(asked, saved, loaded, label) {
    var lb = typeof label === "function" ? label : function (r) { return String(r || ""); };
    if (!loaded || !saved) return { ok: false, tone: "warn", text: "The change was sent, but Helm couldn't read the team again to confirm it. Reload this page to see the role Helm has saved." };
    if (String(saved) === String(asked)) return { ok: true, tone: "ok", text: "Role saved: " + lb(saved) + "." };
    return { ok: false, tone: "err", text: "The role was NOT changed - Helm still has them as " + lb(saved) + ". Try again, or reload the page." };
  }

  // R210: the database's own refusals of a role change, in plain words ("" = not one of them -> the page's usual text).
  // They used to show as the generic "You don't have permission to change the role." for every 42501.
  function roleError(err) {
    var m = String((err && err.message) || "");
    if (/at least one admin/i.test(m)) return "Couldn't change the role. A studio must keep at least one Admin - make someone else Admin first.";
    if (/remove your own admin role/i.test(m)) return "Couldn't change the role. You can't remove your own Admin role - another admin (or the owner) has to do it.";
    if (/no such user/i.test(m)) return "Couldn't change the role. This person is no longer in your studio - reload the page.";
    if (/invalid role/i.test(m)) return "Couldn't change the role. That role isn't available - reload the page and pick it again.";
    return "";
  }

  var api = { roleSaved: roleSaved, roleError: roleError, member: member, invite: invite, signInHelp: signInHelp, rowActions: rowActions, profileHint: profileHint, matches: matches, ago: ago, until: until, when: when,
    openDrawer: openDrawer, closeDrawer: closeDrawer, copyText: copyText, rowMenus: rowMenus };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HelmTeamStatus = api;
})(typeof window !== "undefined" ? window : globalThis);

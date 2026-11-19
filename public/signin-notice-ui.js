/* signin-notice-ui.js - R205 (0383): Settings -> Notifications -> "Teammate sign-ins" (studio admins).
   Owner ask (18 Nov 2026): "When someone logs in, the admin should get a notification like 'a person with role X logged in'."
   The server sees every real sign-in by itself (a trigger on Supabase Auth's sign-in time) and puts a bell notice for the studio
   owner + admins: "Ravi Kumar (Planner) signed in · 10:42 AM · Chrome on Windows" (studio time zone; never the network address).
   This card only sets how often:
     Off | First sign-in each day (default) | Every sign-in      + Only roles (default: every office role, not Crew)
   Always: never for your own sign-in, never for Helm HQ staff, at most one notice per person per 10 minutes, and a first-ever
   sign-in says "signed in for the first time".
   API (window.HelmSigninNotice):
     settingsCard(host[, { store }]) -> Promise<boolean>   builds the card into host (hidden when the server has no 0383)
     explain(cfg) -> string                               the plain-words rule shown under the title
     pickRoles(list, all) -> string[]                     the ticked roles, cleaned (known roles only, no duplicates)
   CSP-safe: createElement / textContent only (no HTML strings); pure helpers exported for tests. */
(function (global) {
  "use strict";
  var MODES = [
    ["first_daily", "First sign-in each day", "One notice per person per day (your studio's day) - recommended."],
    ["every", "Every sign-in", "A notice each time someone signs in (at most one per person every 10 minutes)."],
    ["off", "Off", "No sign-in notices. Sign-ins are still listed in the Audit log."],
  ];
  var LABELS = { admin: "Admin", manager: "Event manager", planner: "Planner", sales: "Sales", coordinator: "Event coordinator",
    supervisor: "Supervisor", quality: "Quality engineer", operations: "Operations", designer: "Designer", crew: "Crew" };
  // R229 (0398): Event coordinator + Designer removed (the server's _r383_roles_all() no longer lists them)
  var ALL = ["admin", "manager", "planner", "sales", "supervisor", "quality", "operations", "crew"];
  function roleLabel(r) { return LABELS[r] || String(r || ""); }
  function pickRoles(list, all) {
    var known = Array.isArray(all) && all.length ? all : ALL, seen = {}, out = [];
    (Array.isArray(list) ? list : []).forEach(function (x) { var r = String(x == null ? "" : x).trim().toLowerCase(); if (known.indexOf(r) >= 0 && !seen[r]) { seen[r] = 1; out.push(r); } });
    return out.sort(function (a, b) { return known.indexOf(a) - known.indexOf(b); });
  }
  function explain(c) {
    c = c || {};
    var roles = pickRoles(c.roles, c.roles_all);
    if (c.mode === "off") return "Sign-in notices are off. Each sign-in is still written to the Audit log.";
    var who = !roles.length ? "nobody (no role ticked)"
      : roles.length === (Array.isArray(c.roles_all) ? c.roles_all.length : ALL.length) ? "anyone in the studio"
      : (c.roles_default !== false && roles.indexOf("crew") < 0 ? "anyone except Crew" : roles.map(roleLabel).join(", "));
    return "When " + who + " signs in, the studio owner and admins get a bell notice with their name, role, the time (studio clock) and the browser - "
      + (c.mode === "every" ? "every time (at most once per person every 10 minutes). " : "for their first sign-in each day. ")
      + "A first-ever sign-in says “signed in for the first time”. You never get a notice about your own sign-in, and Helm support staff never cause one.";
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function settingsCard(host, opts) {
    var S = (opts && opts.store) || global.BPStore, R = S && S.signinNotice;
    if (!host || !R || typeof R.settings !== "function") { if (host) host.hidden = true; return Promise.resolve(false); }
    return Promise.resolve().then(function () { return R.settings(); }).then(function (c) {
      if (!c || typeof c !== "object") { host.hidden = true; return false; }
      clear(host); host.hidden = false; host.classList.add("sin-card");
      host.appendChild(el("h3", null, "Teammate sign-ins"));
      var ex = el("p", "mnote", explain(c)); host.appendChild(ex);
      var can = c.can_edit === true, all = Array.isArray(c.roles_all) && c.roles_all.length ? c.roles_all : ALL;
      var fs = el("fieldset", "cmset sin-modes"); fs.appendChild(el("legend", null, "Tell admins when teammates sign in"));
      var radios = MODES.map(function (m) {
        var lb = el("label", "cmchk sin-mode"), r = el("input"); r.type = "radio"; r.name = "sin_mode"; r.id = "sin_mode_" + m[0]; r.value = m[0];
        r.checked = (c.mode || "first_daily") === m[0]; lb.htmlFor = r.id; lb.appendChild(r);
        var t = el("span", "sin-mtext"); t.appendChild(el("strong", null, m[1])); t.appendChild(el("span", "muted sin-hint", " - " + m[2])); lb.appendChild(t);
        fs.appendChild(lb); return r;
      });
      host.appendChild(fs);
      var rs = el("fieldset", "cmset sin-roles"); rs.appendChild(el("legend", null, "Only roles"));
      var on = pickRoles(c.roles, all), grid = el("div", "trm-grid sin-grid");
      var boxes = all.map(function (r) {
        var lb = el("label", "cmchk"), b = el("input"); b.type = "checkbox"; b.id = "sin_role_" + r; b.value = r; b.checked = on.indexOf(r) >= 0;
        lb.htmlFor = b.id; lb.appendChild(b); lb.appendChild(el("span", null, " " + roleLabel(r))); grid.appendChild(lb); return b;
      });
      rs.appendChild(grid);
      var reset = el("button", "btn sm sin-reset", "Use the default roles (all except Crew)"); reset.type = "button"; rs.appendChild(reset);
      host.appendChild(rs);
      host.appendChild(el("p", "mnote", "E-mail digest of sign-ins: off (not available yet). The notice shows the browser and system only - never the network address."));
      var foot = el("div", "trm-foot"), save = el("button", "btn primary", "Save sign-in notices"); save.type = "button"; save.id = "sin_save";
      var msg = el("p", "trm-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
      foot.appendChild(save); foot.appendChild(msg); host.appendChild(foot);
      var useDefault = c.roles_default !== false;
      function syncRolesDisabled() { var off = radios.some(function (r) { return r.checked && r.value === "off"; }); boxes.forEach(function (b) { b.disabled = !can || off; }); reset.disabled = !can || off; }
      radios.forEach(function (r) { r.disabled = !can; r.addEventListener("change", syncRolesDisabled); });
      boxes.forEach(function (b) { b.addEventListener("change", function () { useDefault = false; }); });
      reset.addEventListener("click", function () { useDefault = true; boxes.forEach(function (b) { b.checked = b.value !== "crew"; }); });
      save.disabled = !can; syncRolesDisabled();
      if (!can) host.appendChild(el("p", "muted hint", "Only studio admins can change this."));
      save.addEventListener("click", function () {
        var mode = (radios.filter(function (r) { return r.checked; })[0] || {}).value || "first_daily";
        var roles = pickRoles(boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; }), all);
        if (mode !== "off" && !roles.length) { msg.textContent = "Tick at least one role, or choose Off."; return; }
        save.disabled = true; msg.textContent = "Saving…";
        R.saveSettings({ mode: mode, roles: useDefault ? null : roles })
          .then(function (n) { msg.textContent = "Saved."; ex.textContent = explain(n || {}); if (n) useDefault = n.roles_default !== false; })
          .catch(function (e) { msg.textContent = (global.BPUI && global.BPUI.friendlyError) ? global.BPUI.friendlyError(e, { action: "save the sign-in notices" }) : "Couldn't save - try again."; })
          .then(function () { save.disabled = !can; });
      });
      return true;
    }, function () { host.hidden = true; return false; });
  }

  var api = { settingsCard: settingsCard, explain: explain, pickRoles: pickRoles, roleLabel: roleLabel, MODES: MODES, ALL: ALL };
  global.HelmSigninNotice = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

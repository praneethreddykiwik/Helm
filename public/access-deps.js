/* access-deps.js - R208: what each access area NEEDS to work, and a plain "What can this role do?" summary, for
 * Settings -> Users & invites -> Access control.
 *
 * Nothing here is stored or sent anywhere and nothing here grants anything: the database (role_access read by has_area /
 * _r385_can_assign) still decides. This file only explains the switches so an admin can see why something does not
 * work yet, and offers to switch the missing one on (the screen then saves it the normal way, admin_set_role_access).
 *
 * Every "needs" line below was checked against the code (R208 audit, see test/r208-access-deps.test.mjs):
 *   - every event page loads the event through the quotes table, whose read policy is "Quotes & workspace - Can see";
 *   - Assign & send tasks (0385 _r385_can_assign) needs "Staff - Can see" in the database itself;
 *   - Deliveries & arrivals lives on the event-day screen (command.html needs "Event-day command - Can see");
 *   - Close with money owed is only asked inside the close-event gate ("Close events - Can change");
 *   - Photo renders need "Quotes & workspace - Can change" too (0095 can_render);
 *   - Settlement's expense claims also need "Budget & finance - Can change" (settlement.html canClaims).
 * "uses" = helpful but not required (the area still works without it).
 * ASCII only.
 */
(function (root) {
  "use strict";
  var OPEN = "to open the event";
  function q(level, why, on) { return { area: "quotes", level: level || "view", why: why || OPEN, on: on || "view" }; }
  var DEPS = {
    tasks:      { needs: [{ area: "staff", level: "view", why: "to see the crew and the event's tasks" }, q()],
                  uses:  [{ area: "templates", level: "view", why: "ready-made task lists for each section (without it they type each task)" }] },
    deliveries: { needs: [{ area: "command", level: "view", why: "the tracker is on the event-day screen" }, q()] },
    close_owed: { needs: [{ area: "closure", level: "edit", why: "only someone who can close events can close one with money owed" }] },
    photo_render: { needs: [q(), q("edit", "photos are made from the event's layout", "edit")] },
    settlement: { needs: [q()], uses: [{ area: "finance", level: "edit", on: "edit", why: "to record expense claims" }] },
    command: { needs: [q()] }, issues: { needs: [q()] }, media: { needs: [q()] }, runsheet: { needs: [q()] },
    logistics: { needs: [q()] }, ready: { needs: [q()] }, plan: { needs: [q()] }, resources: { needs: [q()] },
    discovery: { needs: [q()] }, proposal: { needs: [q()] }, finance: { needs: [q()] }, closure: { needs: [q()] }
  };
  // logins that never give out work (the database refuses them for Assign & send tasks)
  var NO_TASKS = { client: 1, crew: 1, worker: 1 };

  function list(area, kind) { var d = DEPS[area]; return (d && d[kind]) || []; }
  function has(cell, level) { return !!(cell && (level === "edit" ? cell.view && cell.edit : cell.view)); }
  // is this row switched on at the level that triggers a need? permission rows = view + edit together
  function isOn(area, cell, on, permission) { return permission ? has(cell, "edit") : has(cell, on === "edit" ? "edit" : "view"); }

  // the needs (or uses) of one area for one role that are NOT met right now.
  //   cellOf(area) -> {view, edit} as the screen shows it; permission = the area is a one-switch row
  function unmet(area, cellOf, permission, kind) {
    var me = cellOf(area);
    return list(area, kind || "needs").filter(function (n) {
      return isOn(area, me, n.on, permission) && !has(cellOf(n.area), n.level);
    });
  }
  // one line for the row: [{area, level, why, ok}]
  function lineFor(area, cellOf) {
    return list(area, "needs").map(function (n) { return { area: n.area, level: n.level, why: n.why, on: n.on || "view", ok: has(cellOf(n.area), n.level), uses: false }; })
      .concat(list(area, "uses").map(function (n) { return { area: n.area, level: n.level, why: n.why, on: n.on || "view", ok: has(cellOf(n.area), n.level), uses: true }; }));
  }
  function levelText(level) { return level === "edit" ? "Can change" : "Can see"; }

  // does Assign & send tasks really work for this role (the database rule, as far as the screen can tell)?
  //   hasRow = the studio saved a 'tasks' row for this role (else it follows Staff - Can change)
  function canAssign(role, cellOf, hasRow) {
    if (role === "admin") return true;
    if (!hasRow) return has(cellOf("staff"), "edit");
    return !NO_TASKS[role] && has(cellOf("tasks"), "edit") && has(cellOf("staff"), "view");
  }

  // "What can this role do?" - plain lines, yes / no. assign = canAssign(...) for this role.
  function summary(role, cellOf, assign) {
    var c = function (a, lv) { return role === "admin" || has(cellOf(a), lv || "view"); };
    var money = c("finance") || c("settlement") || c("closure") || c("business");
    return [
      { key: "events",  text: "Open events and their quotes", yes: c("quotes") },
      { key: "quotes",  text: "Change quotes and prices", yes: c("quotes", "edit") },
      { key: "assign",  text: "Assign and nudge tasks on events (Tasks & crew)", yes: role === "admin" || !!assign },
      { key: "crew",    text: "See the crew list", yes: c("staff") },
      { key: "staffed", text: "Change staff records and wages, post open shifts", yes: c("staff", "edit") },
      { key: "dayoff",  text: "Approve days off", yes: c("staff", "edit") },
      { key: "day",     text: "Run the event day (event-day screen)", yes: c("command", "edit") },
      { key: "money",   text: "See money (budgets, payments, profit)", yes: money },
      { key: "close",   text: "Close events", yes: c("closure", "edit") },
      { key: "admin",   text: "Studio settings and team members", yes: c("controls") || c("users") }
    ];
  }

  var api = { DEPS: DEPS, unmet: unmet, lineFor: lineFor, levelText: levelText, canAssign: canAssign, summary: summary };
  root.HelmAccessDeps = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

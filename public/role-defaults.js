/* role-defaults.js - r85: plain-English layout + the studio DEFAULT access for Settings -> Roles & access.
 *
 * Nothing here is stored or sent anywhere. The database is still the only thing that decides access
 * (role_access rows read by has_area). This file only helps the Settings screen:
 *   - SECTIONS: groups the existing areas into plain-English sections with a one-line help text each.
 *   - defaultFor(role, area): what a NEW studio starts with. It mirrors the database template
 *     _a49_default_matrix() (migrations 0049 + 0239; "tasks" = the 0385 seed: Staff-edit roles + supervisor) and the Crew starter set (0143; R232 / 0400: Event coordinator + Designer removed).
 *     test/r85-roles-settings.test.mjs fails if this copy and the SQL template ever drift apart.
 *     Returns null for an area the template does not cover (the screen then shows no Default / Changed badge
 *     and "Reset to defaults" leaves it alone).
 */
(function (root) {
  "use strict";
  // area -> [roles that VIEW], [roles that EDIT]   (same table as _a49_default_matrix; edit implies view)
  var TEMPLATE = {
    leads:      [["manager", "planner", "sales"], ["manager", "planner", "sales"]],
    crm:        [["manager", "planner", "sales"], ["manager", "planner", "sales"]],
    nurture:    [["manager", "planner"], ["manager", "planner"]],
    discovery:  [["manager", "planner"], ["manager", "planner"]],
    proposal:   [["manager", "planner"], ["manager", "planner"]],
    quotes:     [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner"]],
    layouts:    [["manager", "planner", "supervisor", "operations", "quality"], ["planner"]],
    design:     [["manager", "planner"], ["manager", "planner"]],
    staff:      [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner", "operations"]],
    // r208 (0385): Assign & send tasks = the Staff "Can change" roles + supervisor (one switch: view + edit together)
    tasks:      [["manager", "planner", "supervisor", "operations"], ["manager", "planner", "supervisor", "operations"]],
    inventory:  [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner", "operations"]],
    vendors:    [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner", "operations"]],
    calendar:   [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner"]],
    templates:  [["manager", "planner", "operations", "quality"], ["manager", "planner"]],
    resources:  [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner", "operations"]],
    runsheet:   [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner"]],
    plan:       [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner"]],
    logistics:  [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner"]],
    ready:      [["manager", "planner", "supervisor", "quality"], ["manager", "planner"]],
    finance:    [["manager", "planner"], ["manager", "planner"]],
    settlement: [["manager", "planner"], ["manager", "planner"]],
    closure:    [["manager", "planner"], ["manager", "planner"]],
    command:    [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner", "supervisor", "quality"]],
    issues:     [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner", "supervisor", "operations", "quality"]],
    media:      [["manager", "planner", "supervisor", "operations", "quality"], ["manager", "planner", "supervisor"]],
    controls:   [["manager"], ["manager"]],
    codes:      [["manager", "planner"], ["manager", "planner"]],
    users:      [[], []],
    business:   [[], []]
  };
  // 0143: Crew starts with this set (the template itself gives it nothing)
  var STARTER = {
    crew:     { runsheet: 1, calendar: 1 }
  };

  function defaultFor(role, area) {
    if (role === "admin") return { view: true, edit: true };
    var t = TEMPLATE[area];
    if (!t) return null;
    var s = STARTER[role];
    if (s) { var lv = s[area] || 0; return { view: lv >= 1, edit: lv >= 2 }; }
    var v = t[0].indexOf(role) >= 0;
    return { view: v, edit: v && t[1].indexOf(role) >= 0 };
  }

  // Plain-English sections. Every area key from store-api AREAS appears in exactly one section
  // (the test checks this). label overrides the short name; help is the one-line explanation.
  var SECTIONS = [
    { key: "sales", title: "Sales & clients", blurb: "Finding clients and agreeing what they book.", rows: [
      { area: "leads",        help: "See and follow up new enquiries." },
      { area: "crm",          help: "Look up past clients and old enquiries." },
      { area: "nurture",      help: "Keep in touch with clients who have not booked yet." },
      { area: "discovery",    help: "Note what the client wants (date, guests, style)." },
      { area: "proposal",     help: "Prepare the look-and-feel proposal for the client." },
      { area: "quote_create", help: "Start brand-new quotes." },
      { area: "quotes",       help: "Open events and their quotes; change them if allowed." },
      { area: "pkg_review",   help: "Get told when a client picks a package; accept or decline it." },
      { area: "codes",        help: "Create coupons and discount codes." }
    ] },
    { key: "planning", title: "Event planning", blurb: "Getting each event ready.", rows: [
      { area: "calendar",     help: "See the studio calendar and book dates." },
      { area: "plan",         help: "Venue, menu and guest details for an event." },
      { area: "layouts",      help: "Floor plans in the layout builder." },
      { area: "design",       help: "The design studio." },
      { area: "photo_render", help: "Make photo-style pictures of a layout." },
      { area: "resources",    help: "Who and what each event needs." },
      { area: "runsheet",     help: "The minute-by-minute plan for the day." },
      { area: "logistics",    help: "Transport and set-up planning." },
      { area: "ready",        help: "The final readiness checklist." },
      { area: "templates",    help: "Reusable event templates." },
      { area: "venues",       help: "The studio's list of venues." }
    ] },
    { key: "team", title: "Team, stock & suppliers", blurb: "People, equipment and vendors.", rows: [
      { area: "staff",        help: "Crew list. Change = staff records and wages, open shifts, approving days off and new staff links." },
      { area: "tasks",        label: "Assign & send tasks (Tasks & crew)", help: "Give out work on events: assign, reassign, times, reminders, special, cancel, e-mail or WhatsApp the person. Not staff records, wages, open shifts or days off." },
      { area: "inventory",    help: "Equipment and stock." },
      { area: "vendors",      help: "Suppliers and what they are booked for." }
    ] },
    { key: "eventday", title: "On the event day", blurb: "Running the event live.", rows: [
      { area: "command",      help: "The live event-day screen." },
      { area: "deliveries",   help: "Delivery and arrival reminders (follows the event-day switch until set)." },
      { area: "issues",       help: "Report and fix problems on the day." },
      { area: "media",        help: "Photos and the event gallery." }
    ] },
    { key: "money", title: "Money & closing events", blurb: "Payments, settling up and closing events.", rows: [
      { area: "finance",      help: "Event budget, payments received and costs." },
      { area: "settlement",   help: "Settle accounts with the client and vendors after the event." },
      { area: "closure",      label: "Close events (closure & P&L)", help: "Close events and settle accounts. Change = can press Close event.", highlight: true },
      { area: "close_owed",   help: "Close an event that still has money owed (a written reason is required and logged)." },
      { area: "discount_approve", help: "Approve a change that lowers the price. Nobody can approve their own." },
      { area: "pkg_payments", help: "Get told when a client pays for a package." },
      { area: "business",     help: "The Business page: studio-wide profit and money owed to vendors." },
      { area: "insights",     help: "Reports and trends over time." },
      { area: "item_pricing", help: "Rate cards for items priced by size or quantity." }
    ] },
    { key: "admin", title: "Studio admin", blurb: "Running the studio account itself.", rows: [
      { area: "controls",     help: "Open Settings (studio details, pricing, notifications)." },
      { area: "users",        help: "Add or remove team members and change roles." }
    ] }
  ];

  // R245 (ROLE-03): giving money access to a Crew / view-only role asks "are you sure?" first. MONEY_AREAS = Budget &
  // finance, Settlement, Closure & P&L, Business overview (studio money and wages), Package payment alerts and the two
  // quote money permissions (approve discounts, close with money owed). VIEW_ROLES = the roles that only see their own
  // portal by default (Crew, legacy worker, Client). moneyGrantAsk(role, area, before, after) -> the question to ask, or
  // null when no question is needed (not a money area, not a view role, or access is not going UP).
  var MONEY_AREAS = ["finance", "settlement", "closure", "business", "pkg_payments", "discount_approve", "close_owed"];
  var VIEW_ROLES = ["crew", "worker", "client"];
  function moneyGrantAsk(role, area, before, after, roleLabel, areaLabel) {
    if (VIEW_ROLES.indexOf(role) < 0 || MONEY_AREAS.indexOf(area) < 0) return null;
    var b = before || {}, a = after || {};
    var up = (!!a.view && !b.view) || (!!a.edit && !b.edit);
    if (!up) return null;
    var who = roleLabel || role, what = areaLabel || area;
    return "Give " + who + " " + (a.edit ? "change access" : "access") + " to " + what + "? " + who +
      " normally only sees their own work. Money screens show prices, payments" + (area === "business" ? ", profit and wages" : " and totals") +
      " to everyone with this role. The change is recorded in the activity log.";
  }

  var api = { TEMPLATE: TEMPLATE, STARTER: STARTER, SECTIONS: SECTIONS, defaultFor: defaultFor,
    MONEY_AREAS: MONEY_AREAS, VIEW_ROLES: VIEW_ROLES, moneyGrantAsk: moneyGrantAsk };
  root.HelmRoleDefaults = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

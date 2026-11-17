// staff-email.mjs - R170 (0361): the e-mails a studio sends its own staff about their work. Pure (no I/O); shared by
// comms-dispatch (Deno) and the node tests. One claimed staff_email_outbox row (staff_email_claim) -> { subject, text }.
//   * task_assigned / task_list  "Your tasks for <event>" - every open task of that person on that event
//   * task_one                   one task
//   * task_reminder              "Due in 10 min: <task> at <time>" / "Due now: <task> ..." (R171 wording; the 0338 times)
//   * task_late                  "Not started yet: <task>" (after the start, the 0338 late reminders)
//   * office_alert               to the event manager: "<worker> has not started <task>", with the Live Status link
//   * task_update (R172, 0363)    "Update: your tasks for <event> changed" - the change lines collected for that person
//                                and event (staff_update_claim), their open tasks now, and their permanent link
//   * task_escalation (R186, 0369) to an office person on the escalation ladder of a SPECIAL task that is not started:
//                                "Escalated: <task> not started (<worker>)", the step (1 coordinator / 2 manager / 3 admin),
//                                minutes late, and the Event day monitor link (monitor.html?quote=<event id>)
// Links: APP_URL + the row's own path only (work.html?staff=<64 hex> = the person's permanent link (R172); R179 adds
// &event=<event id> for an e-mail about one event, so it opens that event inside the same link,
// work.html?token=<uuid> = the per-event link, ops.html?quote=<uuid> for the office);
// the host never comes from the database. Anything unexpected -> empty text and comms-dispatch marks the row skipped.
// R185: every staff e-mail also gets a designed HTML part on the shared Helm layout (_shared/email-layout.mjs: logo,
// card, button, footer with the compliance line). The plain-text part is EXACTLY the R170-R179 text (unchanged).
import * as L from "../_shared/email-layout.mjs";

export const STAFF_TX_REASON = "you are on the staff list of this studio and work was given to you";
export const OFFICE_TX_REASON = "you are the manager of this event";
export const ESCALATION_TX_REASON = "you are on your studio's escalation list for special tasks that have not started";
export const STAFF_KINDS = ["task_assigned", "task_list", "task_one", "task_reminder", "task_late", "office_alert", "task_escalation"];

const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const PATH = /^(?:(?:work\.html\?token=|ops\.html\?quote=|monitor\.html\?quote=)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|work\.html\?staff=[0-9a-f]{64}(?:&event=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAFF_PATH = /^work\.html\?staff=[0-9a-f]{64}$/;
// R179: e-mails about one event open that event INSIDE the person's permanent link (work.html?staff=..&event=<id>);
// the "your tasks changed" notice and the office alert keep their own links
const EVENT_KINDS = ["task_assigned", "task_list", "task_one", "task_reminder", "task_late"];
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function staffLink(row, origin) {
  const o = String(origin || "").replace(/\/+$/, "");
  let p = String((row && row.link_path) || "");
  const q = String((row && row.quote_id) || "").toLowerCase();
  if (STAFF_PATH.test(p) && UUID_RE.test(q) && EVENT_KINDS.includes(String(row && row.kind))) p += "&event=" + q;
  if (!ORIGIN.test(o) || !PATH.test(p)) return "";
  return o + "/" + p;
}

// R186: the ladder step of an escalation row -> { n: 1..3, who: "the coordinator and the manager are told" }
const ESC_WHO = ["the event coordinator is told", "the coordinator and the manager are told", "the coordinator, the manager and the admin / owner are told"];
function escStep(row) {
  const n = Math.min(3, Math.max(1, Math.round(Number(row && row.step) || 1)));
  return { n, who: ESC_WHO[n - 1] };
}

function first(name) { return clip(name, 80).split(" ")[0] || ""; }
function when(start, day) { const s = clip(start, 12), d = clip(day, 20); return s ? (d ? s + " on " + d : s) : (d ? "on " + d : ""); }
function soon(m) {
  const n = Math.round(Number(m));
  if (!Number.isFinite(n) || n <= 0) return "now";
  if (n < 60) return "in " + n + " min";
  const h = Math.floor(n / 60), r = n % 60;
  return "in " + h + (h === 1 ? " hour" : " hours") + (r ? " " + r + " min" : "");
}

// { subject, text } for one claimed staff e-mail; "" text = do not send
export function staffEmailMessage(row, origin) {
  const none = { subject: "", text: "" };
  if (!row || !STAFF_KINDS.includes(String(row.kind))) return none;
  const kind = String(row.kind);
  const studio = clip(row.studio, 80) || "your studio", event = clip(row.event, 120) || "the event";
  const date = clip(row.event_date, 20), venue = clip(row.venue, 100);
  const hi = "Hello" + (first(row.name) ? " " + first(row.name) : "") + ",\n\n";
  const link = staffLink(row, origin);
  const sign = "\n\nThank you,\n" + studio;
  const replyLine = "\n\nQuestions? Just reply to this e-mail - it goes to " + studio + ".";
  const eventLine = event + (date ? " on " + date : "") + (venue ? " at " + venue : "");

  if (kind === "task_assigned" || kind === "task_list") {
    const tasks = (Array.isArray(row.tasks) ? row.tasks : []).slice(0, 25)
      .map((t) => ({ title: clip(t && t.title, 160), cat: clip(t && t.category, 60), at: when(t && t.start, t && t.day) }))
      .filter((t) => t.title);
    if (!tasks.length) return none;
    const lines = tasks.map((t) => "  - " + t.title + (t.cat ? " (" + t.cat + ")" : "") + (t.at ? " - starts " + t.at : "")).join("\n");
    return {
      subject: (kind === "task_assigned" ? "New work for you: " : "Your tasks: ") + event + (date ? " (" + date + ")" : ""),
      text: hi + studio + (kind === "task_assigned" ? " has given you work for " : " sent you your tasks for ") + eventLine + ":\n\n" + lines +
        (link ? "\n\nOpen your task page to accept the work and mark each task as you go:\n" + link : "") + replyLine + sign,
    };
  }
  const task = clip(row.task, 160);
  if (!task) return none;
  const at = when(row.start, row.day);
  if (kind === "task_one") {
    return {
      subject: "Task for you: " + task + " - " + event,
      text: hi + studio + " sent you this task for " + eventLine + ":\n\n  - " + task + (at ? " - starts " + at : "") +
        (link ? "\n\nOpen your task page:\n" + link : "") + replyLine + sign,
    };
  }
  if (kind === "task_reminder") {
    if (!clip(row.start, 12)) return none;
    const s = soon(row.minutes);
    // R171 (owner: "this task is due in 10 minutes / 5 minutes / your task is due now")
    const due = s === "now" ? "Due now" : "Due " + s;
    // R173: a reminder 6+ hours ahead (e.g. the evening before a 2 AM start) names the day too
    const at2 = Number(row.minutes) >= 360 ? when(row.start, row.day) : clip(row.start, 12);
    return {
      subject: due + ": " + task + " at " + at2 + " - " + event,
      text: hi + "A reminder from " + studio + ": " + task + " for " + event + (s === "now" ? " is due now" : " is due " + s) + ", at " + at2 + ".\n\n" +
        (link ? "Mark it started on your task page:\n" + link : "Please get ready to start it.") + replyLine + sign,
    };
  }
  if (kind === "task_late") {
    return {
      subject: "Not started yet: " + task + " - " + event,
      text: hi + task + " for " + event + (at ? " was due to start at " + at : " was due to start") + " and is not marked as started yet.\n\n" +
        (link ? "If you have started, mark it on your task page:\n" + link + "\n\nIf something is stopping you, reply to this e-mail." :
                "If something is stopping you, reply to this e-mail.") + sign,
    };
  }
  if (kind === "task_escalation") {
    const worker = clip(row.worker, 80) || "The person on it";
    const late = Math.max(0, Math.round(Number(row.late_min) || 0));
    const step = escStep(row);
    return {
      subject: "Escalated: " + task + " not started (" + worker + ") - " + event,
      text: hi + worker + " has not started " + task + " for " + eventLine + (at ? ". It was due at " + at : "") +
        (late ? " (" + late + " min ago)" : "") + ".\n\nThis is a special task, so Helm tells the team step by step until it is started. " +
        "Step " + step.n + " of 3: " + step.who + ".\n\n" +
        (link ? "See the live status and act now:\n" + link : "Open the Event day monitor in Helm to act now.") +
        "\n\n" + "Helm, for " + studio,
    };
  }
  // office_alert (to the event manager)
  const worker = clip(row.worker, 80) || "A staff member";
  return {
    subject: "Task not started: " + task + " (" + worker + ") - " + event,
    text: hi + worker + " has not started " + task + " for " + eventLine + (at ? ". It was due at " + at : "") +
      ", and the reminders have gone out.\n\n" + (link ? "See the live status and reassign if needed:\n" + link : "Open the event in Helm to reassign if needed.") +
      "\n\n" + "Helm, for " + studio,
  };
}

// R172 (0363): one "your tasks changed" notice (staff_update_claim row) -> { subject, text }; "" text = do not send
export function staffUpdateMessage(row, origin) {
  const none = { subject: "", text: "" };
  if (!row || String(row.kind) !== "task_update") return none;
  const lines = (Array.isArray(row.changes) ? row.changes : []).map((x) => clip(x, 200)).filter(Boolean).slice(0, 30);
  if (!lines.length) return none;
  const studio = clip(row.studio, 80) || "your studio", event = clip(row.event, 120) || "the event";
  const date = clip(row.event_date, 20), venue = clip(row.venue, 100);
  const more = Math.max(0, Math.round(Number(row.more) || 0));
  const cancelled = row.cancelled === true;
  const hi = "Hello" + (first(row.name) ? " " + first(row.name) : "") + ",\n\n";
  const link = staffLink(row, origin);
  const eventLine = event + (date ? " on " + date : "") + (venue ? " at " + venue : "");
  const changed = lines.map((l) => "  - " + l).join("\n") + (more ? "\n  - and " + more + (more === 1 ? " more change" : " more changes") : "");
  const tasks = (Array.isArray(row.tasks) ? row.tasks : []).slice(0, 25)
    .map((t) => ({ title: clip(t && t.title, 160), at: when(t && t.start, t && t.day) })).filter((t) => t.title);
  const now = cancelled ? "" : tasks.length
    ? "\n\nYour tasks for this event now:\n" + tasks.map((t) => "  - " + t.title + (t.at ? " - starts " + t.at : "")).join("\n")
    : "\n\nYou have no open tasks for this event now.";
  return {
    subject: (cancelled ? "Cancelled: " : "Update: your tasks for ") + event + (date ? " on " + date : "") + (cancelled ? "" : " changed"),
    text: hi + studio + (cancelled ? " has cancelled " : " changed something on your work for ") + eventLine + ":\n\n" + changed + now +
      (link ? "\n\nSee all your tasks (this link stays the same):\n" + link : "") +
      "\n\nQuestions? Just reply to this e-mail - it goes to " + studio + "." + "\n\nThank you,\n" + studio,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// R185: designed HTML for the staff e-mails. Pure. Every dynamic value is HTML-escaped here (L.escHtml); links are the
// already-validated staffLink() URLs. Light design on the shared layout (which also carries its dark-mode rules).
// The owner can swap the logo by adding a new PNG and pointing L.LOGO_URL (_shared/email-layout.mjs) at it.
const e = (v) => L.escHtml(v);
const TONE = {
  soon: ["#fff4e0", "#8a5a00"], now: ["#fdecec", "#b42318"], late: ["#fdecec", "#b42318"],
  info: [L.C.brandSoft, L.C.brand], muted: ["#eef1ef", L.C.muted],
};
const eyebrow = (studio) =>
  `<tr><td style="padding:0 0 14px;"><span class="codebox" style="display:inline-block;background:${L.C.brandSoft};color:${L.C.brand};font-family:${L.FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:.04em;border-radius:999px;padding:5px 12px;">${e(studio)} via Helm</span></td></tr>`;
const chip = (text, tone = "info") => {
  const [bg, fg] = TONE[tone] || TONE.info;
  return `<span style="display:inline-block;background:${bg};color:${fg};font-family:${L.FONT};font-size:13px;line-height:18px;font-weight:700;border-radius:999px;padding:5px 12px;">${e(text)}</span>`;
};
// big clock + countdown chip (reminders)
const timeHero = (time, chipText, tone) =>
  `<tr><td style="padding:2px 0 22px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="ink" valign="middle" style="font-family:${L.FONT};font-size:40px;line-height:44px;font-weight:700;letter-spacing:-.02em;color:${L.C.ink};padding-right:14px;">${e(time)}</td>
<td valign="middle">${chip(chipText, tone)}</td></tr></table></td></tr>`;
// task rows: title + section on the left, start time on the right
const taskRows = (tasks) =>
  `<tr><td style="padding:0 0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rule" style="border:1px solid ${L.C.rule};border-radius:12px;">${tasks.map((t, i) => {
    const top = i ? `border-top:1px solid ${L.C.rule};` : "";
    return `<tr><td class="${i ? "rule" : ""}" style="padding:12px 16px;${top}font-family:${L.FONT};"><div class="ink" style="font-size:15px;line-height:21px;font-weight:600;color:${L.C.ink};">${e(t.title)}</div>${t.cat ? `<div class="muted" style="font-size:13px;line-height:18px;color:${L.C.muted};">${e(t.cat)}</div>` : ""}</td>` +
      `<td align="right" valign="top" class="${i ? "rule " : ""}${t.at ? "ink" : "muted"}" style="padding:12px 16px;${top}font-family:${L.FONT};font-size:14px;line-height:21px;font-weight:${t.at ? 600 : 400};color:${t.at ? L.C.ink : L.C.faint};">${t.at ? e(t.at) : "No time yet"}</td></tr>`;
  }).join("")}</table></td></tr>`;
// change lines: "X: start time changed from A to B" -> label + A (struck) -> B; other lines as they are
const CHANGE_RE = /^(.{1,170}?): (.{1,80}?) changed from (.{1,120}?) to (.{1,160})$/;
const changeRows = (lines, more) =>
  `<tr><td style="padding:0 0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rule" style="border:1px solid ${L.C.rule};border-radius:12px;">${lines.map((l, i) => {
    const top = i ? `border-top:1px solid ${L.C.rule};` : "";
    const m = CHANGE_RE.exec(l);
    const body = m
      ? `<div class="ink" style="font-size:15px;line-height:21px;font-weight:600;color:${L.C.ink};">${e(m[1])}</div><div class="muted" style="font-size:13px;line-height:19px;color:${L.C.muted};">${e(m[2])}: <span style="text-decoration:line-through;">${e(m[3])}</span> &rarr; <strong class="ink" style="color:${L.C.ink};">${e(m[4])}</strong></div>`
      : `<div class="ink" style="font-size:15px;line-height:21px;color:${L.C.ink};">${e(l)}</div>`;
    return `<tr><td class="${i ? "rule" : ""}" style="padding:12px 16px;${top}font-family:${L.FONT};">${body}</td></tr>`;
  }).join("")}${more ? `<tr><td class="rule muted" style="padding:10px 16px;border-top:1px solid ${L.C.rule};font-family:${L.FONT};font-size:13px;color:${L.C.muted};">and ${more} more ${more === 1 ? "change" : "changes"}</td></tr>` : ""}</table></td></tr>`;
const banner = (text) =>
  `<tr><td style="padding:0 0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#fdecec;border-radius:12px;padding:14px 16px;font-family:${L.FONT};font-size:15px;line-height:22px;font-weight:600;color:#b42318;">${e(text)}</td></tr></table></td></tr>`;
const facts = (rows) => L.facts(rows.filter(([, v]) => v).map(([k, v]) => [e(k), e(v)]));
const cta = (link, label) => link ? L.button(e(link), e(label)) + L.fallback(e(link)) : "";
const replyNote = (studio) => L.note(`Questions? Just reply to this e-mail &mdash; it goes to ${L.strong(e(studio))}.`);

function staffDoc(subject, pre, inner, reason, opts) {
  const o = opts || {};
  const site = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/.test(String(o.site || "")) ? o.site : L.SITE;
  return L.layout(subject, pre, inner, { site, reason, address: o.address, sub: "" });
}

// { html } for staffEmailMessage rows ("" when the text is empty - same rule)
export function staffEmailHtml(row, origin, opts = {}) {
  const msg = staffEmailMessage(row, origin);
  if (!msg.text) return "";
  const kind = String(row.kind);
  const studio = clip(row.studio, 80) || "your studio", event = clip(row.event, 120) || "the event";
  const date = clip(row.event_date, 20), venue = clip(row.venue, 100);
  const name = first(row.name);
  const hello = L.para("Hello" + (name ? " " + L.strong(e(name)) : "") + ",", "0 0 14px");
  const link = staffLink(row, origin);
  const site = { site: String(origin || "").replace(/\/+$/, ""), address: opts.address };
  const eventFacts = [["Event", event], ["Date", date], ["Venue", venue]];

  if (kind === "task_assigned" || kind === "task_list") {
    const tasks = (Array.isArray(row.tasks) ? row.tasks : []).slice(0, 25)
      .map((t) => ({ title: clip(t && t.title, 160), cat: clip(t && t.category, 60), at: when(t && t.start, t && t.day) }))
      .filter((t) => t.title);
    const n = tasks.length;
    const inner = eyebrow(studio) + L.h1(e(kind === "task_assigned" ? "New work for you" : "Your tasks")) + hello +
      L.para(L.strong(e(studio)) + (kind === "task_assigned" ? " has given you " : " sent you ") + e(n === 1 ? "1 task" : n + " tasks") + " for " + L.strong(e(event)) + ".") +
      facts(eventFacts) + taskRows(tasks) +
      cta(link, "Open my tasks") + L.para("Accept the work and mark each task as you go.", "0 0 20px") + replyNote(studio);
    return staffDoc(msg.subject, (n === 1 ? "1 task" : n + " tasks") + " for " + event + (date ? " on " + date : ""), inner, STAFF_TX_REASON, site);
  }
  const task = clip(row.task, 160);
  const at = when(row.start, row.day);
  if (kind === "task_one") {
    const inner = eyebrow(studio) + L.h1("A task for you") + hello +
      L.para(L.strong(e(studio)) + " sent you this task for " + L.strong(e(event)) + ".") +
      taskRows([{ title: task, cat: "", at }]) + facts(eventFacts) +
      cta(link, "Open my task") + replyNote(studio);
    return staffDoc(msg.subject, task + " - " + event, inner, STAFF_TX_REASON, site);
  }
  if (kind === "task_reminder") {
    const s = soon(row.minutes);
    const now = s === "now";
    const at2 = Number(row.minutes) >= 360 ? when(row.start, row.day) : clip(row.start, 12);
    const inner = eyebrow(studio) + L.h1(e(now ? "Your task is due now" : "Coming up: " + task)) + hello +
      timeHero(at2, now ? "Due now" : "Due " + s, now ? "now" : "soon") +
      facts([["Task", task], ["Event", event], ["Venue", venue]]) +
      (link ? cta(link, "Mark it started") : L.para("Please get ready to start it.")) + replyNote(studio);
    return staffDoc(msg.subject, (now ? "Due now: " : "Due " + s + ": ") + task + " at " + at2, inner, STAFF_TX_REASON, site);
  }
  if (kind === "task_late") {
    const inner = eyebrow(studio) + L.h1("Not started yet") + hello +
      timeHero(at || "Due", "Not started", "late") +
      L.para(L.strong(e(task)) + " for " + L.strong(e(event)) + " " + (at ? "was due to start at " + e(at) : "was due to start") + " and is not marked as started yet.") +
      (link ? cta(link, "Open my task page") + L.para("If something is stopping you, reply to this e-mail.") : L.para("If something is stopping you, reply to this e-mail.")) +
      L.note(`Sent by ${L.strong(e(studio))} with Helm.`);
    return staffDoc(msg.subject, task + " has not been started yet", inner, STAFF_TX_REASON, site);
  }
  if (kind === "task_escalation") {
    const worker = clip(row.worker, 80) || "The person on it";
    const late = Math.max(0, Math.round(Number(row.late_min) || 0));
    const step = escStep(row);
    const inner = eyebrow(studio) + L.h1("Special task not started") + hello +
      banner(worker + " has not started " + task + (late ? " - " + late + " min late" : "") + ".") +
      facts([["Task", task], ["Person", worker], ["Was due", at], ["Step", step.n + " of 3 - " + step.who], ["Event", event], ["Date", date], ["Venue", venue]]) +
      L.para("Helm keeps telling the team step by step until the task is started.") +
      (link ? cta(link, "Open the live monitor") : L.para("Open the Event day monitor in Helm to act now.")) +
      L.note(`Helm, for ${L.strong(e(studio))}.`);
    return staffDoc(msg.subject, worker + " has not started " + task, inner, ESCALATION_TX_REASON, site);
  }
  // office_alert
  const worker = clip(row.worker, 80) || "A staff member";
  const inner = eyebrow(studio) + L.h1("Task not started") + hello +
    banner(worker + " has not started " + task + ".") +
    facts([["Task", task], ["Person", worker], ["Was due", at], ["Event", event], ["Date", date], ["Venue", venue]]) +
    L.para("The reminders have gone out. Check the live status and reassign if needed.") +
    (link ? cta(link, "See live status") : L.para("Open the event in Helm to reassign if needed.")) +
    L.note(`Helm, for ${L.strong(e(studio))}.`);
  return staffDoc(msg.subject, worker + " has not started " + task, inner, OFFICE_TX_REASON, site);
}

// { html } for staffUpdateMessage rows ("" when the text is empty - same rule)
export function staffUpdateHtml(row, origin, opts = {}) {
  const msg = staffUpdateMessage(row, origin);
  if (!msg.text) return "";
  const lines = (Array.isArray(row.changes) ? row.changes : []).map((x) => clip(x, 200)).filter(Boolean).slice(0, 30);
  const studio = clip(row.studio, 80) || "your studio", event = clip(row.event, 120) || "the event";
  const date = clip(row.event_date, 20), venue = clip(row.venue, 100);
  const more = Math.max(0, Math.round(Number(row.more) || 0));
  const cancelled = row.cancelled === true;
  const name = first(row.name);
  const link = staffLink(row, origin);
  const tasks = (Array.isArray(row.tasks) ? row.tasks : []).slice(0, 25)
    .map((t) => ({ title: clip(t && t.title, 160), cat: "", at: when(t && t.start, t && t.day) })).filter((t) => t.title);
  const inner = eyebrow(studio) + L.h1(e(cancelled ? "Event cancelled" : "Your tasks changed")) +
    L.para("Hello" + (name ? " " + L.strong(e(name)) : "") + ",", "0 0 14px") +
    (cancelled ? banner(studio + " has cancelled " + event + (date ? " on " + date : "") + ".")
               : L.para(L.strong(e(studio)) + " changed something on your work for " + L.strong(e(event)) + ".")) +
    facts([["Event", event], ["Date", date], ["Venue", venue]]) +
    L.para(L.strong("What changed"), "0 0 10px") + changeRows(lines, more) +
    (cancelled ? "" : tasks.length ? L.para(L.strong("Your tasks for this event now"), "0 0 10px") + taskRows(tasks)
                                    : L.para("You have no open tasks for this event now.")) +
    cta(link, "See all my tasks") + (link ? L.para("This link stays the same for all your tasks.", "0 0 20px") : "") +
    replyNote(studio);
  return staffDoc(msg.subject, (cancelled ? "Cancelled: " : "Changed: ") + event + (date ? " on " + date : ""), inner, STAFF_TX_REASON,
    { site: String(origin || "").replace(/\/+$/, ""), address: opts.address });
}

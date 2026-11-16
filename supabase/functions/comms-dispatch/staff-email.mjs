// staff-email.mjs - R170 (0361): the e-mails a studio sends its own staff about their work. Pure (no I/O); shared by
// comms-dispatch (Deno) and the node tests. One claimed staff_email_outbox row (staff_email_claim) -> { subject, text }.
//   * task_assigned / task_list  "Your tasks for <event>" - every open task of that person on that event
//   * task_one                   one task
//   * task_reminder              "Due in 10 min: <task> at <time>" / "Due now: <task> ..." (R171 wording; the 0338 times)
//   * task_late                  "Not started yet: <task>" (after the start, the 0338 late reminders)
//   * office_alert               to the event manager: "<worker> has not started <task>", with the Live Status link
// Links: APP_URL + the row's own path only (work.html?token=<uuid> for the person, ops.html?quote=<uuid> for the office);
// the host never comes from the database. Anything unexpected -> empty text and comms-dispatch marks the row skipped.
export const STAFF_TX_REASON = "you are on the staff list of this studio and work was given to you";
export const OFFICE_TX_REASON = "you are the manager of this event";
export const STAFF_KINDS = ["task_assigned", "task_list", "task_one", "task_reminder", "task_late", "office_alert"];

const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const PATH = /^(work\.html\?token=|ops\.html\?quote=)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function staffLink(row, origin) {
  const o = String(origin || "").replace(/\/+$/, "");
  const p = String((row && row.link_path) || "");
  if (!ORIGIN.test(o) || !PATH.test(p)) return "";
  return o + "/" + p;
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
    return {
      subject: due + ": " + task + " at " + clip(row.start, 12) + " - " + event,
      text: hi + "A reminder from " + studio + ": " + task + " for " + event + (s === "now" ? " is due now" : " is due " + s) + ", at " + clip(row.start, 12) + ".\n\n" +
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
  // office_alert (to the event manager)
  const worker = clip(row.worker, 80) || "A staff member";
  return {
    subject: "Task not started: " + task + " (" + worker + ") - " + event,
    text: hi + worker + " has not started " + task + " for " + eventLine + (at ? ". It was due at " + at : "") +
      ", and the reminders have gone out.\n\n" + (link ? "See the live status and reassign if needed:\n" + link : "Open the event in Helm to reassign if needed.") +
      "\n\n" + "Helm, for " + studio,
  };
}

# WhatsApp task reminders (R130, migration 0338)

Plain-English guide. The same rule is shown in **Settings → Notifications → Task reminders on WhatsApp** and on the
Tasks & staff page under "Live status".

## Who sends them
Only the studio's **own** WhatsApp Business number (Integrations → Your WhatsApp number). Helm's number is never used.
If the studio has not connected a number, the page says so with a **Set up WhatsApp** button, and each task shows
"Not sent – WhatsApp not set up". Nothing is sent by SMS any more.

## The rule (owner's defaults, 9 Nov 2026)
| What | Default | Where to change |
|---|---|---|
| Reminders before the start time | **10 and 5 minutes before** | Settings (studio default) or the task's ⏱ Schedule popup (tick boxes 30, 15, 10, 5, 3, 1 min, at the start time, or custom minutes) |
| Late (task not started after its start time) | **every 15 minutes, up to 3 times** | Settings (5–120 minutes, 0–10 times) |
| Then | **the event manager is told**: a bell notice and a WhatsApp (staff alert template) | Settings (on / off) |
| Task waits on an unfinished task | **held**; one reminder goes as soon as the earlier task is done | Settings (on / off). Final rule is a question for the boss (updates/11-09-2026-questions.docx) |

Example: a 12:30 task with 10, 5 and 3 ticked gets WhatsApps at 12:20, 12:25 and 12:27. Marking it done at 12:26 stops
the 12:27 one. If it still hasn't started, late reminders go at 12:45, 13:00 and 13:15, then the event manager is told.

## Details
- Only tasks with a **start time**, a **person with a phone number**, and status Assigned or Accepted. In progress, done,
  cancelled and declined tasks get nothing.
- Each reminder goes **once**. If several times are already past (the task was scheduled late, or was held), only the
  latest goes; the older ones are marked "skipped".
- A **new start time** or a **new person** starts a fresh set; anything still queued for the old time or person is dropped.
- Times use the **studio's time zone** (India by default).
- Free-trial studios: nothing is sent (as for every WhatsApp).
- Anyone who replied STOP gets nothing.
- The **event manager** is the person chosen as manager on the event; their phone comes from their Staff record. No
  manager or no phone: the bell notice still appears.

## What the office sees
Each task on Live status shows its last WhatsApp: **Queued, Sent on WhatsApp, Delivered, Read, Failed, Not sent**.
Delivered / Read need Meta's webhook (wa-webhook). If a message is not delivered, copy the worker link and share it.

## Templates (created by "Set up message templates")
| Template | Goes to | Fields | Sent today |
|---|---|---|---|
| staff_task_assigned | Staff | name, task, event, date, time, venue, link | Yes |
| staff_task_reminder | Staff | name, task, event, time, minutes left, link | Yes |
| staff_task_overdue | Staff | name, task, event, time, link | Yes |
| office_staff_alert | Office | staff name, what happened, task, event, date, reason, link | Yes (task overdue) |
| staff_open_shift | Eligible staff | name, role, event, date, start, end, venue, link | Yes |
| crew_runsheet_reminder | Crew | name, time, event, item, link | Yes |
| staff_task_changed | Staff | name, task, event, what changed | Not yet |
| staff_shift_result | Staff | name, role, event, date, result, link | Not yet (needs Q1 / Q2) |
| staff_leave_result | Staff | name, date, result, reason | Not yet (needs Q4) |
| vendor_request, vendor_follow_up, vendor_delivery_reminder, vendor_invoice_update | Vendor | see wa-studio.mjs FIELDS | Not yet (needs Q3) |

## Owner steps
1. Run `supabase/APPLY-0338.sql` (staging, then production). It also creates the pg_cron job `helm-task-reminders`
   (every minute). Every VERIFY row must say true.
2. comms-dispatch must run **every minute** (it sends what the job queued). VERIFY row 07 shows its schedule; if it is
   `*/5 * * * *`, run the line printed there to change it.
3. Deploy `comms-dispatch` and `wa-connect` (new templates), then the site.
4. On the Integrations page press **Set up message templates** again so the new templates are created.

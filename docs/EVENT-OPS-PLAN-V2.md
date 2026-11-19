# Event operations v2: the day before and the event day, organised (R226, 18 Nov 2026)

Pages: **Tasks & Crew** (`ops.html`) and the **Event-day monitor** (`monitor.html`). Phase 1 (R222, PR #463) is live.
This round adds the **Day before** and **Wrap-up** steps, **Ready by** with a latest start for each job, and
**alerts** ("Event starts in 1 hour - ready? 8/10 done"). It also improves the monitor. Branch `feat/r226-event-ops`,
migration **0396**.

---

## Part 1 - In plain words

### 1. What real event companies do (the research, short)

Indian decor and wedding studios, tent houses and event production companies all work the same way:

| When | What they do | Sources |
|---|---|---|
| **2-4 weeks before** | Lock vendors and logistics. Check permits: police / loudspeaker permission, fire NOC for the venue or temporary structures, an electrical NOC, a structural certificate for the pandal or stage, and the liquor licence. | marrymeweddings.in/event-permissions.html, odishabytes.com (Cuttack procession permission), tribuneindia.com (Faridabad fire NOCs) |
| **7-14 days before** | Final guest count to the caterer. Many contracts lock the number 3-7 days before: it can go up, rarely down. | amworldgroup.com (catering guarantee), catering.tufts.edu, cater.indiana.edu |
| **1 week before** | Call every vendor: arrival time, set-up window, load-in, parking, who is in charge on site, teardown duties. Send the final timeline. A first crew call sheet goes out. | theknot.com (last-minute vendor questions), herecomestheguide.com (week-of checklist), rundownstudio.app (call sheet) |
| **The day before** | Final call sheet (who comes when). Load list packed against the stock list. Trucks loaded in reverse of the set-up order. Venue access confirmed. Power and generator confirmed. Forecast checked and rain plan ready. | rundownstudio.app, ticketfairy.com (load-in), venuelook.com and wedmegood.com (monsoon / rain plans) |
| **Event day: set-up** | Order: structure (tent, pandal, stage, flooring) and power first. Then lighting and sound rigging, then decor and florals, furniture and catering, signage last. Decor installation for an Indian wedding is often 6-8 hours. | maharaniweddings.com, ticketfairy.com, mdp-sops.readthedocs.io (onsite protocol) |
| **Ready by** | Everything finished well before guests arrive. Keep the spare time *before* the final walk-through, not after doors open. The walk-through checks routes, cables, floor protection and emergency access. | rundownstudio.app (event-day timeline), tempguru.co (set-up crew checklist) |
| **Show** | One person runs the minute-by-minute run-sheet (run-of-show). Problems go crew → supervisor → event manager → owner. Safety issues skip the chain. | bizzabo.com and swapcard.com (run of show), getlisto.io (escalation), ticketfairy.com (org chart) |
| **Teardown and after** | Strike in reverse (things at height first), with a fresh crew. Check stock in as it returns, with photos of any damage. Settle vendors. Then a short review. | ticketfairy.com and bizbash.com (load-out), rentopian.com and rwelephant.com (damage) |

**Planning backwards.** Professionals start from the fixed time (Ready by) and work back through the jobs that depend
on each other. The longest chain is the one that decides everything. A safety buffer goes on that chain: common rules
of thumb are 10-30 %, and Helm uses 15 % by default (pmworldjournal.com, pm-global.co.uk). No source describes learning
durations from past events. Helm does it anyway: it is simple, and the start / done times are already saved.

### 2. The timeline, and what Helm shows at each point

```
 T-14 ... T-2 days          T-1 (day before)        EVENT DAY                                              T+1
 ───────────────────────── ───────────────────── ──────────────────────────────────────────────────── ──────────────
 BEFORE THE EVENT           DAY BEFORE              ON THE DAY                                             WRAP-UP
 Get set up shortcuts       Day-before checklist    Venue opens 9:00 → set-up jobs → READY BY 5:30 →       Settlement →
 Ready for the day? checks  Ready by card           Guests 6:30 → show (run-sheet now / next) →            Teardown →
 Ready by card              (latest starts)         night strike                                           Closure
                                                    Ready by card, Late, check-ins, issues
```

Both pages pick the step from the **studio's clock**:
- **Before the event**: until the day before.
- **Day before**: from midnight the day before, until "On the day" starts.
- **On the day**: from 1 hour before the first thing on the day.
- **Wrap-up**: once the day is over, or the event is in Settlement / Closed.

The note under the buttons says why. You can still pick a step by hand, and "Use the studio's clock" switches back.

### 3. Tasks & Crew and the Monitor now look the same

You said the Event-day monitor and Tasks & Crew should be the same, and that the monitor had no before-the-event
option. Both pages now have the **same four buttons**:

**Before the event · Day before · On the day · Wrap-up**

Both pages also share the same **Day before** and **Ready by** cards. It is one piece of code (`event-plan.js`), so the
two pages can never disagree.

Before the event, the monitor no longer shows the red "Late" board. That board made the event look late days early.

### 4. The Day-before checklist

Eleven lines, each with a tick. Helm saves who ticked each line and when. Taking a tick back is saved too, and nothing
is ever deleted. Each line has an **Open →** link to the page where you do the work.

1. Every vendor called (arrival time, set-up window, who is in charge on site)
2. Final guest count sent to the caterer
3. Crew call times sent (who comes when)
4. Load list packed and checked against the stock list
5. Trucks / tempo booked, driver numbers saved
6. Venue access confirmed (gate, lift, parking, load-in time). Put it in **Venue opens**.
7. Power and generator confirmed
8. Permits in hand (police / loudspeaker permission - no loudspeakers 10 PM - 6 AM; fire NOC where needed)
9. Rain / weather plan checked
10. Run-sheet final and shared with the client, the venue and vendors
11. Client confirmed the final timings

### 5. Ready by and the latest start (backward scheduling)

Example: the guests come at 6:30 PM, and you set **Ready by 5:30 PM** and **Venue opens 9:00 AM**. For each set-up
job you enter **how long it takes** and **what it needs first**. Helm then works backwards:

```
Ready by 5:30 PM
  Sound check     45 min  (+15% = 52 min)   needs Lighting rig  →  latest start 4:38 PM
  Lighting rig    90 min  (+15% = 104 min)  needs Stage frame   →  latest start 2:54 PM
  Mandap flowers  150 min (+15% = 173 min)  needs Stage frame   →  latest start 2:37 PM
  Stage frame     240 min (+15% = 276 min)                      →  latest start 9:58 AM
```

- Each job shows **Start by 2:54 PM**. The label changes to *Start soon* (30 min before), *Start now - late*,
  *Started* or *Done*.
- A single line says where you stand: "On track: ready around 4:46 PM", or "Behind: at this pace ready around
  5:57 PM - 27 min after Ready by". Helm works this out from real start times and from Venue opens.
- Warnings appear on the job if the latest start is before the venue opens, or if the planned start is after the
  latest start.
- **Learning:** when you set a duration, Helm says "Last 3 times this took about 2 h 10 min". This is the middle
  value of real start-to-done times for tasks with the same name on your past events. Tap it to use it.
- If Ready by is empty, Helm uses 1 hour before Guests arrive.

### 6. Who is alerted, and when

All alerts go to the **bell inside Helm only**: no e-mail and no WhatsApp. Each alert goes once. A studio admin can
change the settings (**Alert settings** under the Ready by card).

| When | Message | Who |
|---|---|---|
| 1 hour before guests arrive (10-240 min, you choose) | "Event starts in 1 hour - ready? 8/10 done, 1 late (EVT-104)" | the event's manager + Managers + Supervisors (you choose the roles) |
| 30 min before a job's latest start (you choose) | "Lighting rig must start by 2:54 PM to be ready by 5:30 PM (Ravi)" | same people |
| the latest start has passed and the job has not started | "Not started: Lighting rig - latest start was 2:54 PM. Ready by 5:30 PM is at risk (Ravi)" (red) | same people |
| **Remind → Bell** on the monitor | "Reminder from the office: Lighting rig (start 2:00 PM)" | only that crew member, if they sign in to Helm |

If none of the chosen roles exist in the studio, the admins get the alerts. Only the people named on an alert can
see it in their bell.

### 7. The monitor, as you asked

- **Bigger tabs** (By staff, By work, By status, Leftover, Check-in, Activity). They are bigger still on the wall screen.
- **Nudge is now "Remind ▾"** with three choices:
  - **Bell in Helm**: to the person's own Helm login. It says so if they don't have one.
  - **E-mail**: the existing task e-mail.
  - **WhatsApp**: from the studio's number. Helm asks first, and says so if WhatsApp isn't set up.
- **Proof photo beside Done**: a small photo appears next to the Done mark when the crew added one. Tap it to open it.
- **Open** now shows the task **in a drawer on the same page**. The drawer shows who (with a Call link), the times, the
  latest start, what it needs first, the proof photo and its updates. It also has **Remind** and an **Edit in Tasks &
  Crew →** link for reassigning or changing the time.
- **Wrap-up** step: how many tasks are still open, then links to Mark event complete (Tasks & Crew) → Settlement →
  Teardown → Closure.

### 8. What is built now and what waits

**Built in this PR:**
1. The four steps on both pages.
2. The Day-before checklist.
3. Ready by / Venue opens, durations, "needs first", latest start, the "ready around" estimate and learned durations.
4. The 1-hour and latest-start bell alerts, with studio settings (0396).
5. The monitor changes: bigger tabs, Remind (Bell / E-mail / WhatsApp), the proof photo, the drawer and the Wrap-up card.

**Waiting for your go:**
- Alerts by **e-mail / WhatsApp** as well as the bell. They need new WhatsApp templates approved by Meta, and your
  decision on who gets them.
- **Escalation of a red alert** to the owner when nobody acts within N minutes (like the special-task ladder, 0369).
- A **walk-through / QC sign-off** step at Ready by ("Supervisor checked the hall - photo"), and a **client handover**.
- **Per-vendor deadlines**: a caterer guarantee date with a lock, and permit lead times with a document upload.
- **Rain-plan decision time** and forecast checks at T-3 and T-1.
- A **post-event review** (what went late, real versus planned durations) on Closure.
- The Command page (`command.html`) on the same four steps.

---

## Part 2 - Technical detail

### 2.1 Window rule (`task-status.js`)
`HelmTaskStatus.opsWindow(m, {eventDate, now, tz})` builds on the R222 `opsMode` answer `m`:
- `done` / `over` → `wrapup`
- `on` → `onday`
- `before` / `soon` → `daybefore` when the studio day is the event day or the day before; otherwise `before`
- `cancelled` / `nodate` → `before`

`WIN_PHASE` maps each window to the old `plan | live`, so every R222 box keeps working. Tasks & Crew keeps a hand pick
per event in `sessionStorage` (an old `plan` / `live` value maps to before / onday). The monitor keeps its pick in
`helm.mon.win.<quote>`.

### 2.2 Shared module (`event-plan.js` + `event-plan.css`)
- `schedule(tasks, {readyAt, venueAt, bufPct, remindMin, now})` is pure. For each job:
  - backward pass: `lf` = min `ls` of the jobs that depend on it, else Ready by; `ls = lf - ceil(dur × (100 + buf) / 100)` minutes
  - a loop in the dependencies falls back to Ready by
  - forward pass for the estimate: start at max(now, Venue opens, the finish of what it needs first); real `started_at` / `completed_at` win
- `renderReady` / `renderDayBefore` build the DOM only (textContent). Their forms are inline, and the pages do not
  redraw the cards while a form is open.
- Styles use only the `--tc-*` tokens (theme-safe; no hex colours in `event-plan.css`).

### 2.3 Database: migration 0396 (`supabase/APPLY-0396.sql`)
All changes are additive and idempotent. Nothing is dropped or deleted.

| Object | What |
|---|---|
| `event_tasks.duration_min` | int 1-1440, nullable (empty = not a timed job); "needs first" = the existing `depends_on` |
| `event_day_plans` | one row per event: `venue_access`, `ready_by` ("HH:MM"), `checks` jsonb `{key: {done, by, at}}`; quote FK on delete cascade; tenant + read-only-studio triggers; RLS on, no table grants |
| `event_ready_alert_settings` | one row per studio: enabled, `hour_before_min` 60, `notify_roles` {manager,supervisor}, `latest_alerts`, `remind_before_min` 30, `buffer_pct` 15 |
| `event_ready_alert_sends` | dedupe ledger (`slot_key` unique), so each alert goes once |
| `_r396_schedule(quote)` | the same sum as the page, using arrays (no temp table) |
| `event_day_plan_get(quote)` | Staff view, same studio. Returns times, checks, settings, schedule, learned medians, `can_edit` / `can_settings`. No money. |
| `event_day_plan_set` / `event_day_check_set` / `event_task_duration_set(task, min, needs, set_needs)` | "Assign & send tasks" (`_r385_can_assign`, 0385). The dependency must be in the same event, not the task itself, and not a loop. Only `duration_min` / `depends_on` change. |
| `event_ready_settings_get` / `_set` | Staff or Controls view to read; Controls edit to save (like task reminder settings, 0338) |
| `event_task_remind_bell(task)` | Assign & send. Only the crew member's own login. Once per 5 min per task. |
| `event_ready_alert_tick()` | service role / pg_cron `helm-event-ready-alerts` every 5 min. Covers events from yesterday to tomorrow that are not cancelled and not in settlement / closed. Writes bell rows `kind = task_escalated` with `detail.notify` = profile ids (so the 0369 rule shows them only to those people), `source = 0396`, `via` = ready_check / latest_soon / latest_late / office_reminder. |

Recipients are:
- the event manager (`quotes.manager_id`)
- profiles whose role is in `notify_roles`, excluding client / crew / worker and anyone switched off (`_r283_is_off`)
- if that list is empty, the studio admins

The owner pastes `supabase/APPLY-0396.sql` on **staging first, then production**. Its 12 check rows must all be
`true`. The checks only read: the job is never run from the paste.

### 2.4 Before 0396 is applied
`BPStore.ops.dayPlan.get()` answers `null` when the call is missing. Both cards then stay hidden, and Remind has no Bell
option. The four steps, the monitor drawer, Remind (E-mail / WhatsApp), the proof photo and the bigger tabs work
without 0396.

### 2.5 Tests
- `tests/db/r226-event-day-plan-0396.sql`: 32 checks on the local disposable PG (PGTZ=UTC), wired into
  `scripts/db-test/run-all.sh`.
- `test/r226-event-ops-v2.test.mjs`: 14 checks. These include the same 13:33 / 15:51 numbers as the database test,
  so the page and the server sum the same way.
- R222, R192, R184 and the tour tests were updated where this round replaced their wording (four buttons, Remind
  instead of Nudge, tours kept at 8 steps or fewer).

# Event operations redesign - plan (R222, 18 Nov 2026)

Pages: Tasks & Crew (`ops.html` + `ops-board.js`), the Event-day monitor (`monitor.html` + `monitor.js`),
Event-day command (`command.html`). Branch `feat/r222-event-ops`. Phase 1 is built in the PR; phases 2-4 wait for your go.

## 1. The idea in one paragraph

Every event has two jobs. **Before the event** is getting everything set up: who does what, crew, stock,
vendors, the run-sheet, the readiness checks. **On the day** starts when the event day starts: the run-sheet
timeline (what happens when), live task status, check-ins, nudges and problems. When the day is over, the event
moves on to **Settlement -> Teardown -> Closure**, the stages you already have. Tasks & Crew and the Monitor use
the same rule to pick the mode, so the two pages always agree.

## 2. The rule that picks the mode

Helm checks these in order, using your **studio's clock** (Settings time zone, never the phone's):

| # | If... | Mode | What the note under the switch says |
|---|---|---|---|
| 1 | the event is cancelled | Before | "This event is cancelled" |
| 2 | the stage is Settlement or Closed | On the day (wrap-up) | "The event is complete - next: Settlement" |
| 3 | the event has no date | Before | "No event date yet" |
| 4 | it is before the start of the day's work | Before | "On the day starts Sat 21 Nov, 7:00 AM" |
| 5 | it is between the start of the day's work and the end of the day (+6 h for night strike) | On the day | "Event day - started 7:00 AM" |
| 6 | the day is over but the stage has not moved on | On the day (wrap-up) | "The event day is over - mark it complete" |

**Start of the day's work** = 1 hour before the earliest of: the first run-sheet item, the first task on the
event day, or "Guests arrive". If none has a time, the event day starts at midnight (studio clock).
**End of the day** = the last run-sheet item or task end on the event day or the night after (up to 6 AM), plus
6 hours. If none has a time, the end of the event day.
The stage **Event Day** (set on the event page) also means On the day.

Set-up work the day before stays in "Before the event" (you said Before = setting everything up). If you
prefer the evening-before set-up to count as On the day, that is a one-line change.

**Manual switch:** the two buttons "Before the event" / "On the day" still work. A hand-picked mode is kept for
that event in this browser tab and the note says "Picked by hand"; "Use the studio's clock" puts it back. The
Monitor's "Open" link (`#live`) now really opens On the day (before, the next refresh flipped it back).

## 3. What each mode shows

### Before the event (setting up)

```
+--------------------------------------------------------------------------------+
| Tasks & Crew                                    [Search tasks or people]  Monitor|
| EVT-104  Planning     Wedding - Kumar & Rao                                     |
| Sat 21 Nov 2026 - Taj Krishna - 400 guests     Guests arrive 7:00 PM  Event in 3 days|
| [=========-----------] 9 of 21 done - 4 started - 3 waiting for a yes            |
+--------------------------------------------------------------------------------+
| [#Before the event#] [ On the day ]   Picked from the studio's clock: on the day starts Sat 7:00 AM |
+--------------------------------------------------------------------------------+
| Ready for the day?  4 / 6                                                       |
|  ! 2 tasks with no one yet   Fix ->     ! 1 task waiting for a yes  Fix ->       |
|  v Every task has a start time          v No one booked on a day off            |
+--------------------------------------------------------------------------------+
| Get set up:  [Crew] [Stock] [Vendors] [Run-sheet] [Floor layout] [Ready check]    |
+--------------------------------------------------------------+-----------------+
| Tasks 21   [Timeline|List|By person]          [+ Add & assign]| Crew on this event|
| [#All 21#] [Late 2] [No one yet 2] [Waiting 3] ...           |  Asha  Free that day|
|  9:00  Stage set-up   Asha   Accepted                        |  Ravi  Busy elsewhere|
|  ...                                                         |  Meena Day off    |
+--------------------------------------------------------------+-----------------+
```

### On the day (live)

```
+--------------------------------------------------------------------------------+
| EVT-104  Event day - live   ...   Guests arrive in 2h 10m                       |
+--------------------------------------------------------------------------------+
| [ Before the event ] [#On the day#]   Event day - started 7:00 AM               |
+--------------------------------------------------------------------------------+
| Run-sheet  - now 4:50 PM                                  Edit run-sheet ->     |
|   v 3:00 PM  Decor final check          Asha                                   |
|   > 5:00 PM  Bride entry rehearsal  NEXT in 10 min    Stage                      |
|     7:00 PM  Guests arrive                                                       |
|     8:30 PM  Varmala                                                             |
+--------------------------------------------------------------------------------+
| Late - not started 2  [Nudge] [Open] | Can't-work requests | Not checked in [Call]|
+--------------------------------------------------------------------------------+
| Issues  1 open   [+ Log an issue]   "Generator late" High - Ravi    All issues ->|
+--------------------------------------------------------------------------------+
| Wrap up: when the event is over  [Mark event complete -> Settlement]            |
+--------------------------------------------------------------+-----------------+
| Tasks (Timeline / List / By person)                          | Crew today 6 of 8 in|
+--------------------------------------------------------------+-----------------+
```

After "Mark event complete" the wrap-up box says "Event complete - next steps:
[Settlement] [Teardown] [Closure]".

### The Monitor (wall screen) - phase 3

```
+--------------------------------------------------------------------------------+
| [event switcher v]  Sat 21 Nov - Taj Krishna   ON THE DAY (same note)  [Wall screen]|
| 62% done ===========-------   Late 2 - Waiting 3 - Started 4 - Done 13          |
| NOW 4:50 PM  > Bride entry rehearsal (5:00)   then Guests arrive (7:00)           |
+--------------------------------------------------------------------------------+
| [By staff] [By work] [By status] [Leftover] [Check-in] [Activity] [Run-sheet] [Issues]|
| ...                                                       | Activity rail       |
+--------------------------------------------------------------------------------+
```

Before the event the Monitor shows a calm "Before the event - on the day starts Sat 7:00 AM" band and the
readiness count, instead of a live board that looks "late" days early.

## 4. Reused vs new

| Piece | Reused (already built) | New |
|---|---|---|
| Mode switch | buttons, per-event manual pick, studio clock (R192) | the rule above (`HelmTaskStatus.opsMode`), the note that says why, `#live` fixed, black selected button |
| Before: readiness | "Ready for the day?" checklist + Fix -> | "Get set up" shortcut row (links only) |
| Crew labels | day-off data (`crew_availability_range`, 0370), other bookings (`crew_day_status` "booked", 0265/0370) | words: **Free that day / Busy elsewhere · EVT-102 / Day off / Asked for the day off** in every spot, same rules as the readiness check (see 4a) |
| On the day: timeline | run-sheet items (`run_sheet_items`, Phase 11) | read-only "now / next" timeline on Tasks & Crew; editing stays on the Run-sheet page |
| Late / check-in / nudges | all of R186/R187/R192 | - |
| Issues | `event_issues` + Issues page (Phase 17), same permission (Issues area) | quick "Log an issue" panel + open issues list here |
| Event complete | stage machine 0198/0263, `setStageGuided` (gates, admin override with reason) | "Mark event complete -> Settlement" button + next-step links |
| Planner tools | builder, measure tool, venue size / capacity (0096/0197) | phase 2 (below) |

### 4a. The crew label rules (owner priority)

For each person on the event, Helm looks at **the days they have open work on this event** (each task's day on the
studio calendar - a 12:15 AM task belongs to the next day; tasks done, cancelled or turned down do not count; no open
task = the event day). Multi-day events: every one of those days counts.

1. **Day off** - an approved can't-work day on one of those days. **Asked for the day off** - one still waiting for
   an answer (0370). The other day is named: "Day off (Fri 20 Nov)".
2. **Busy elsewhere · EVT-102** - they have a task on another live event that same day (`crew_day_status`, the same
   check as the Assign warning; cancelled / lost / closed events and this event are left out). The event code is shown
   (the page and the check need the Staff area, so the role may see it); no client names.
3. **Free that day** (or **Free those days**) - neither.

The readiness line "No one is booked on a day they can't work" uses the same can't-work data and the same tasks, so the
card and the line always agree. The Add & assign list uses `crew_day_status` for the day being assigned too.

## 5. Database changes

**None for phase 1** (frontend only). Migration number **0396 stays reserved**, only for phase 4 if you want
"Venue opens" / "Ready by" times saved on the event (additive columns, nothing removed). Permissions are not
changed: Tasks & Crew still opens with the Staff area, giving out work still needs "Assign & send tasks" (0385),
issues need the Issues area, moving the stage needs Quotes - Can change (the server checks every move).

## 6. Phases

1. **Phase 1 - this PR.** Mode rule + manual switch done properly; run-sheet timeline on the day; crew labels;
   Issues quick-log; Mark event complete -> Settlement; "Get set up" shortcuts; tests + tour.
2. **Phase 2 - planner tools on the page (Before mode).** A "Layout" card: a small floor-plan snapshot from the
   latest saved layout version, hall size and usable area (venue-area.js), seats vs guests and the capacity
   decision (0197), stock placed on the layout (from the layout's items vs Inventory), and buttons straight into
   the builder (2D / 3D / Measure). Read-only; editing stays in the builder.
3. **Phase 3 - Monitor + Command on the same model.** The Monitor uses `opsMode` for its band and adds
   Run-sheet + Issues tabs; Command (`command.html`) gets the same mode band and links back. No new data.
4. **Phase 4 (optional, needs your OK).** Save "Venue opens" / "Ready by" on the event (migration 0396,
   additive) so the rule can start the day from them; issue -> task ("make this a task for Ravi").

## 7. Risks and how they are handled

| Risk | Handling |
|---|---|
| The page flips mode at a bad moment | Only on the 30 s refresh, never while a panel is open; a hand-picked mode never flips |
| An event with no times at all | Falls back to the event date (midnight to midnight, studio clock) - same as today |
| Night strike after midnight | The day ends 6 h after the last task / run-sheet item, so it stays On the day |
| Someone marks the event complete too early | The same server gates as the event page: not before the event date; only Quotes - Can change; admins can override with a reason (audited). A confirm step first. |
| Role cannot see run-sheet or issues | The boxes stay hidden (the server refuses the read; nothing breaks) |
| Other agents editing store-api / event / settlement pages | Phase 1 touches only ops.html, ops-board.js/.css, task-status.js, page-tours.js and tests |
| Extra load | Run-sheet read once and every 5 min; issues only on the day; same 30 s clock as before |

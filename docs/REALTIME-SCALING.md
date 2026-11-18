# Realtime scaling (R209)

How Helm uses Supabase Realtime, the limits that apply, and what to change before a public launch.

## Where Helm uses Realtime (all in `public/store-api.js`)

| Use | Channel | Opened |
|---|---|---|
| Online dots (R174b presence) | `presence:org:<studio>` (private, presence) | studio app pages; **one tab per person per browser** (R209) |
| Team chat + chat bell | `chat-rt` / `chat-rt-bell` (postgres_changes) | Chat page only (the bell polls everywhere else) |
| Leads board | `leads-rt` (postgres_changes) | Leads page |
| Version history (R193) | `qv-rt-<quote>-<rand>` (postgres_changes) | Builder / quote pages |
| Monitor, ops, tasks, approval watch | none: they poll (`event_tasks` / `quotes` are not in a publication) | - |

All postgres_changes channels go through `rtLive()`: they join only with a live access token, close after 60 s in a
hidden tab, reopen with a catch-up when the tab is visible, and the tab can never hold more than 8 channels
(`RT_MAX_CHANNELS`). Presence goes through `presenceTracker()` + `presenceLeader()` (below).

## Supabase limits (docs: supabase.com/docs/guides/realtime/limits, read 18 Nov 2026)

| Limit | Free | Pro | Pro, no spend cap | Team |
|---|---|---|---|---|
| Concurrent connections | 200 | 500 | 10,000 | 10,000 |
| Messages per second | 100 | 500 | 2,500 | 2,500 |
| Channel joins per second | 100 | 500 | 2,500 | 2,500 |
| Channels per connection | 100 | 100 | 100 | 100 |
| Presence messages per second (project) | 20 | 50 | 1,000 | 1,000 |
| **Presence calls per client per 30 s** | **5** | **5** | **5** | **5** |

The last row is behind the prod log error `ClientPresenceRateLimitReached`. It is the same on every plan, so a bigger
plan does not fix it. When a client goes over, the server shuts that client's channel.

## The R209 cause and fix

**Cause.** R174b called `track()` on every tab show and hide, on every return from idle, and again on every
`SUBSCRIBED`, including the library's quick rejoin after an error. Moving between tabs a few times in 30 s made 6 or
more calls, which is over 5, so the server shut the channel. The library then rejoined, and the forced re-track hit
the limit again straight away. Every open tab also tracked on its own.

**Fix.**
- `presenceTracker()` calls `track()` only when the payload really changes, and at most once per 30 s. Changes that
  arrive inside those 30 s are merged and only the latest is sent. If the state ends up back where the server
  already has it, nothing is sent. `untrack()` goes through the same rule. The 30 s gap also holds across rejoins.
- On `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED`, the channel is removed, which stops the library's own fixed-delay
  rejoin. It then joins again with exponential backoff and jitter: 2.5-5 s, 5-10 s, and so on, up to 2.5-5 min.
- `presenceLeader()` uses a Web Lock so only one tab per person per browser joins and tracks. The other tabs send
  their own online or away state to that tab over a BroadcastChannel, and get the live dots back from it. Nothing
  between tabs touches the server. A tab gives up the lock after 60 s hidden, so a visible tab takes over. A hidden
  tab never joins. Browsers without Web Locks fall back to one channel per visible tab, still limited to one call
  per 30 s.
- The tab leaves the channel on `pagehide` and on sign-out.

## Messages per user per minute, before and after

These numbers are estimates from the code paths, not measured.

**Assumptions.** One person has 3 Helm tabs open, switches tab or app about 10 times a minute while busy, and moves
to a new page about 2 times a minute.

| | Before (R174b) | After (R209) |
|---|---|---|
| Presence calls per tab | ~10/min in bursts, over the 5-per-30-s limit | hard cap 2/min, usually 0-0.5/min |
| Tabs tracking per person | 3 | 1 |
| Presence calls per person | ~30/min, plus re-tracks after each limit error | <= 2/min, plus 1 per page navigation (new connection) |
| Realtime connections per person | 3 (every tab, hidden ones too) | 1 for presence; others only on Chat, Leads or Builder pages |
| Fan-out in a studio of 10 people x 3 tabs | ~300 calls/min x 30 receivers, about 150 msg/s | ~40 calls/min x 10 receivers, about 7 msg/s |

The tests in `test/r209-presence-rate.test.mjs` replay 2 hours of random tab switching and reconnects against a fake
server that applies the 5-per-30-s rule. The result is 0 limit hits and never more than 1 call in any 30 s window.

## At public launch

- **The per-client limit is solved in code.** It does not depend on the plan.
- **Project presence messages per second is the next ceiling.** Each page navigation is a new connection, so it
  costs one join and one track. 1,000 active users each moving 2 pages a minute is about 33 tracks/s before
  fan-out. Pro allows 50/s, and Pro with the spend cap off allows 1,000/s. Before launch, either turn the spend cap
  off (or move to Team), or make presence lighter. Two ways to make it lighter: start presence only on the Chat and
  Staff pages, which are the pages that show dots, or rely on `presence_touch` and "last active" alone.
- **Concurrent connections.** Pro allows 500 by default. After R209, a person counts as about one connection, plus
  one more on the Chat, Leads and Builder pages. More than about 400 people online at once needs the spend cap off
  (10,000).
- **What to watch** in the Supabase Realtime logs and reports:
  - `ClientPresenceRateLimitReached` should stay at 0.
  - `PresenceRateLimitReached` is the project-wide presence limit.
  - `TooManyConnections`, `TooManyJoins` and `ChannelRateLimitReached` cover connections, joins and channels.

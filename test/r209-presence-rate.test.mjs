// r209-presence-rate.test.mjs - R209 (prod Supabase Realtime log 17 Nov 2026: "ClientPresenceRateLimitReached:
// :client_rate_limit_exceeded", 11 in 24 h with a handful of testers). Supabase allows each client 5 presence calls
// (track / untrack) per 30 s on every plan and then shuts that channel. R174b tracked on every tab show / hide, every
// return from idle and every (re)join. This drives presenceTracker() / presenceLeader() from store-api.js with a fake
// clock, a fake Realtime client (that enforces the 5-per-30-s rule like the server) and fake Web Locks.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const STORE = read('public/store-api.js');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.stack || e)); } };

const grab = (name) => { const m = new RegExp('function ' + name + '\\(d\\) \\{[\\s\\S]*?\\n  \\}').exec(STORE); assert.ok(m, name); return m[0]; };
const SRC_T = grab('presenceTracker'), SRC_L = grab('presenceLeader');

// ---- fake clock ----
function clock() {
  let now = 0, seq = 0; const timers = new Map();
  return {
    now: () => now,
    setTimeout: (f, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), f }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
    delays: () => [...timers.values()].map((x) => x.at - now),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let id = null, best = null;
        for (const [k, v] of timers) if (v.at <= end && (!best || v.at < best.at)) { id = k; best = v; }
        if (!best) break;
        timers.delete(id); now = best.at; best.f();
      }
      now = end;
    },
  };
}
// ---- fake Realtime: one "client" per channel; enforces 5 presence calls per 30 s like the server ----
function fakeRealtime(c, opts = {}) {
  const rt = { channels: [], removed: 0, calls: [], limitHits: 0, autoJoin: opts.autoJoin !== false };
  rt.make = () => {
    const ch = { cb: null, calls: [], closed: false, tracked: null,
      subscribe(cb) { ch.cb = cb; if (rt.autoJoin) Promise.resolve(); if (rt.autoJoin) ch.status('SUBSCRIBED'); return ch; },
      status(s) { if (!ch.closed && ch.cb) ch.cb(s); },
      call(kind, p) {
        const now = c.now(); ch.calls.push(now); rt.calls.push({ t: now, kind, p });
        if (ch.calls.filter((x) => now - x < 30000).length > 5) { rt.limitHits++; ch.status('CHANNEL_ERROR'); return Promise.resolve('error'); }
        ch.tracked = p || null; return Promise.resolve('ok');
      },
      track(p) { return ch.call('track', p); },
      untrack() { return ch.call('untrack'); },
      presenceState() { return {}; } };
    rt.channels.push(ch); return ch;
  };
  rt.remove = (ch) => { ch.closed = true; rt.removed++; };
  return rt;
}
function tracker(c, rt, extra = {}) {
  let ready = true, state = { u: 'u1', s: 'online' };
  const live = [];
  const make = vm.runInNewContext('(' + SRC_T.replace('function presenceTracker', 'function') + ')', {});
  const tr = make(Object.assign({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, random: () => 0.5,
    ready: () => ready, make: rt.make, remove: rt.remove, payload: () => state, onLive: (s) => live.push(s) }, extra));
  return { tr, set(s) { state = s; tr.want(); }, setReady(v) { ready = v; }, live };
}
const maxIn30 = (calls) => { let m = 0; calls.forEach((a) => { m = Math.max(m, calls.filter((b) => b.t >= a.t && b.t - a.t < 30000).length); }); return m; };

await t('tracker: one join, one track on SUBSCRIBED; the same state again is never re-sent', () => {
  const c = clock(), rt = fakeRealtime(c), h = tracker(c, rt);
  h.tr.start(); assert.equal(rt.channels.length, 1); assert.equal(rt.calls.length, 1);
  h.tr.start(); h.tr.want(); h.tr.want(); c.advance(120000); assert.equal(rt.calls.length, 1, 'no repeat track, no join twice');
  h.set({ u: 'u1', s: 'online' }); c.advance(60000); assert.equal(rt.calls.length, 1, 'same payload = no call');
  assert.equal(rt.channels.length, 1);
});

await t('tracker: 40 online/away flips in 20 s (tab switching) -> no extra call inside 30 s, then ONLY the latest', () => {
  const c = clock(), rt = fakeRealtime(c), h = tracker(c, rt);
  h.tr.start(); assert.equal(rt.calls.length, 1);
  for (let i = 0; i < 40; i++) { c.advance(500); h.set({ u: 'u1', s: i % 2 ? 'online' : 'away' }); }   // ends on "online"
  c.advance(60000); assert.equal(rt.calls.length, 1, 'ended where the server already is: nothing sent');
  for (let i = 0; i < 9; i++) { c.advance(500); h.set({ u: 'u1', s: i % 2 ? 'online' : 'away' }); }    // ends on "away"
  c.advance(60000); assert.equal(rt.calls.length, 2, 'one coalesced call'); assert.equal(rt.calls[1].p.s, 'away');
  assert.equal(rt.limitHits, 0);
});

await t('tracker: never more than one presence call per 30 s; untrack (hidden switch) goes through the same gap', () => {
  const c = clock(), rt = fakeRealtime(c), h = tracker(c, rt);
  h.tr.start(); c.advance(1000); h.set({ u: 'u1', s: 'away' }); c.advance(1000); h.set(null);
  c.advance(27000); assert.equal(rt.calls.length, 1, 'still inside the gap at 29 s');
  c.advance(1000); assert.equal(rt.calls.length, 2); assert.equal(rt.calls[1].t, 30000); assert.equal(rt.calls[1].kind, 'untrack', 'latest wins: untrack, not "away"');
  for (let i = 1; i < rt.calls.length; i++) assert.ok(rt.calls[i].t - rt.calls[i - 1].t >= 30000);
});

await t('tracker: CHANNEL_ERROR / TIMED_OUT / CLOSED -> channel removed, rejoin on exponential backoff with jitter, capped at 5 min', () => {
  const c = clock(), rt = fakeRealtime(c, { autoJoin: false });
  let rnd = 0; const h = tracker(c, rt, { random: () => rnd });
  h.tr.start(); assert.equal(rt.channels.length, 1);
  const seen = [];
  for (let i = 0; i < 9; i++) {
    const ch = rt.channels[rt.channels.length - 1]; ch.status(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'][i % 3]);
    assert.ok(ch.closed, 'removed (stops the library\'s own quick rejoin)'); assert.equal(c.pending(), 1);
    seen.push(c.delays()[0]); c.advance(seen[i]); assert.equal(rt.channels.length, i + 2);
  }
  assert.deepEqual(seen, [2500, 5000, 10000, 20000, 40000, 80000, 150000, 150000, 150000], 'random 0 -> half the step, cap 300 s / 2');
  rnd = 1; rt.channels[rt.channels.length - 1].status('CHANNEL_ERROR'); assert.equal(c.delays()[0], 300000, 'random 1 -> the full step');
  c.advance(300000); rt.channels[rt.channels.length - 1].status('SUBSCRIBED');
  rt.channels[rt.channels.length - 1].status('CHANNEL_ERROR'); assert.equal(c.delays()[0], 5000, 'a good join resets the backoff');
  assert.ok(h.live.includes(null), 'live dots cleared while the channel is down');
});

await t('tracker: the 30 s gap survives a rejoin (a reconnect never bursts)', () => {
  const c = clock(), rt = fakeRealtime(c); const h = tracker(c, rt);
  h.tr.start(); assert.equal(rt.calls.length, 1);
  c.advance(1000); rt.channels[0].status('CHANNEL_ERROR'); c.advance(5000);
  assert.equal(rt.channels.length, 2, 'rejoined'); assert.equal(rt.calls.length, 1, 'no track inside the gap');
  c.advance(24000); assert.equal(rt.calls.length, 2, 're-tracked once the gap is over'); assert.equal(rt.calls[1].t, 30000);
});

await t('tracker: no live token (R193) -> no channel, retried on the backoff; stop() removes the channel and cancels everything', () => {
  const c = clock(), rt = fakeRealtime(c), h = tracker(c, rt);
  h.setReady(false); h.tr.start(); assert.equal(rt.channels.length, 0); assert.equal(c.pending(), 1);
  c.advance(5000); assert.equal(rt.channels.length, 0);
  h.setReady(true); c.advance(10000); assert.equal(rt.channels.length, 1); assert.equal(rt.calls.length, 1);
  h.set({ u: 'u1', s: 'away' }); h.tr.stop(); assert.equal(rt.removed, 1); assert.equal(c.pending(), 0, 'no pending track / rejoin');
  c.advance(600000); assert.equal(rt.channels.length, 1); assert.equal(rt.calls.length, 1); assert.equal(h.tr.live(), false);
});

await t('tracker vs the server rule (5 per 30 s): 2 hours of chaotic tab switching, idling and reconnects -> 0 limit hits', () => {
  const c = clock(), rt = fakeRealtime(c), h = tracker(c, rt);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  h.tr.start(); let changes = 0;
  for (let s = 0; s < 7200; s += 2) {
    c.advance(2000);
    if (rnd() < 0.5) { changes++; h.set(rnd() < 0.5 ? { u: 'u1', s: 'online' } : rnd() < 0.9 ? { u: 'u1', s: 'away' } : null); }
    if (rnd() < 0.005) rt.channels[rt.channels.length - 1].status('CHANNEL_ERROR');
  }
  assert.equal(rt.limitHits, 0); assert.ok(maxIn30(rt.calls) <= 1, 'at most 1 call in any 30 s window: ' + maxIn30(rt.calls));
  assert.ok(rt.calls.length <= 7200 / 30 + 30, rt.calls.length + ' calls');
  assert.ok(changes > 1500, 'the old code would have made ~' + changes + ' track calls');
});

await t('before (R174b behaviour model): tracking every visibility change trips the server limit within one tab-switch burst', () => {
  const c = clock(), rt = fakeRealtime(c); const ch = rt.make(); ch.subscribe(() => {});
  ch.track({ s: 'online' }); for (let i = 0; i < 6; i++) { c.advance(2000); ch.track({ s: i % 2 ? 'online' : 'away' }); }
  assert.equal(rt.limitHits >= 1, true, '7 calls in 12 s > 5 per 30 s');
});

// ---- leader election ----
function fakeLocks() {
  let holder = null; const queue = [];
  const grant = () => { if (holder || !queue.length) return; const q = queue.shift(); holder = q; Promise.resolve(q.cb()).then(() => { holder = null; q.res(); grant(); }); };
  return { request(name, opts, cb) { return new Promise((res, rej) => { const q = { cb, res, rej };
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => { const i = queue.indexOf(q); if (i >= 0) { queue.splice(i, 1); rej(new Error('AbortError')); } });
      queue.push(q); grant(); }); }, holder: () => holder, queued: () => queue.length };
}
const tick = () => new Promise((r) => setImmediate(r));
function tab(c, locks, hiddenAtStart) {
  const make = vm.runInNewContext('(' + SRC_L.replace('function presenceLeader', 'function') + ')', { AbortController });
  const tb = { hidden: !!hiddenAtStart, leads: 0, follows: 0 };
  tb.l = make({ name: 'helm-presence:o:u', locks, hidden: () => tb.hidden, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    onLead: () => { tb.leads++; }, onFollow: () => { tb.follows++; } });
  tb.show = () => { tb.hidden = false; tb.l.visibility(); }; tb.hide = () => { tb.hidden = true; tb.l.visibility(); };
  return tb;
}

await t('leader: 3 tabs of one person -> exactly one tracks; it hands over after 60 s hidden; a hidden tab never leads', async () => {
  const c = clock(), locks = fakeLocks();
  const a = tab(c, locks), b = tab(c, locks), z = tab(c, locks, true);
  a.l.start(); b.l.start(); z.l.start(); await tick();
  assert.deepEqual([a.l.leading(), b.l.leading(), z.l.leading()], [true, false, false]);
  a.hide(); c.advance(30000); await tick(); assert.equal(a.l.leading(), true, 'a short hide keeps the lead (no churn)');
  a.show(); a.hide(); c.advance(59000); await tick(); assert.equal(a.l.leading(), true);
  c.advance(1000); await tick(); await tick();
  assert.deepEqual([a.l.leading(), b.l.leading(), z.l.leading()], [false, true, false], 'visible tab b took over; hidden z did not');
  b.hide(); c.advance(60000); await tick(); await tick();
  assert.deepEqual([a.l.leading(), b.l.leading(), z.l.leading()], [false, false, false], 'all hidden a minute: nobody tracks (offline)');
  z.show(); await tick(); await tick(); assert.equal(z.l.leading(), true);
  z.l.stop(); await tick(); await tick(); assert.equal(z.l.leading(), false); assert.equal(locks.holder(), null, 'lock freed on stop / pagehide');
  assert.equal(a.leads + b.leads + z.leads, 3);
});

await t('leader: no Web Locks (old browser) -> each visible tab leads alone (still throttled by the tracker)', async () => {
  const c = clock(); const a = tab(c, null);
  a.l.start(); assert.equal(a.l.leading(), true); a.hide(); c.advance(60000); assert.equal(a.l.leading(), false); a.show(); assert.equal(a.l.leading(), true);
  const h = tab(c, null, true); h.l.start(); assert.equal(h.l.leading(), false, 'a tab opened in the background does not join');
});

await t('store wiring: presence uses presenceTracker + presenceLeader; one channel; stops on sign-out and page close; channel cap', () => {
  const P = STORE.slice(STORE.indexOf('const presence = (() => {'), STORE.indexOf('  const BPStore = {'));
  assert.equal((STORE.match(/\.track\(/g) || []).length, 1, 'one track() call site in the whole store (inside presenceTracker)');
  assert.equal((STORE.match(/\.untrack\(\)/g) || []).length, 1);
  assert.match(P, /tracker = makeTracker\(orgId\);/);
  assert.match(P, /leader = presenceLeader\(\{/);
  assert.match(P, /const name = "helm-presence:" \+ orgId \+ ":" \+ uid\(\);/);
  assert.match(P, /bc = new BroadcastChannel\(name\); bc\.addEventListener\("message", onMsg\);/);
  assert.match(P, /ready: \(\) => rtSessionOk\(\) && rtOpen < RT_MAX_CHANNELS,/);
  assert.match(P, /global\.addEventListener\("pagehide", \(e\) => \{ if \(!\(e && e\.persisted\)\) stop\(\); \}\)/);
  assert.match(P, /autoStart, stop, status, paint, lastSeenLabel,/);
  assert.match(STORE, /function stopSignedInPollers\(\) \{[\s\S]{0,400}?try \{ presence\.stop\(\); \} catch \(e\) \{\}/);
  assert.match(STORE, /const RT_MAX_CHANNELS = 8;\n  let rtOpen = 0;/);
  assert.match(STORE, /if \(rtOpen >= RT_MAX_CHANNELS\) \{ rtNote\("cap", "HELM_RT_CAP"\); return; \}/);   // R233b: the cap still refuses, and now says so once
  assert.doesNotMatch(P, /track\(true\)/, 'no forced re-track on every join');
  // a message from another tab is checked before use (ids are uuids; states are online / away only)
  assert.match(P, /if \(\/\^\[0-9a-f-\]\{36\}\$\/i\.test\(u\)\) out\[u\] = m\.live\[u\] === "online" \? "online" : "away";/);
});

console.log(`\nr209-presence-rate: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

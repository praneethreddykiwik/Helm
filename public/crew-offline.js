/* crew-offline.js - R243 (P11 OPS-03): window.HelmCrewQueue, the crew task link's offline "send later" list.
   A crew member at a venue with no signal presses Accept / Start task / Mark done (work.html) or Check in / Check out
   (crew-self.js): instead of an error, the press is SAVED on this phone and SENT when the connection comes back
   ("Saved offline - will send when connected"). Standard pattern: an outbox in browser storage, drained in order on
   the "online" event, when the page becomes visible again, on a timer while items wait, and by a "Send now" button.

   Never applied twice:
     - each saved press carries its own request key (a uuid made once, kept with the press) and is sent at most once
       at a time (one drain runs at a time; the item leaves the list only after an answer);
     - the same press for the same task is saved once (pressing again offline does not add a second one);
     - before sending, the page compares with the task's current status and skips a press that is already done
       (an earlier send whose answer was lost);
     - the server's own rules refuse a repeat (worker_respond: "accept the task first" / "already closed" / the 0311
       "answer is final" refusal; crew_check "in" answers {already: true} and keeps the first time; a second "out"
       is refused "Check in first"), so even a resend after a lost answer changes nothing.
     The server-side request-key versions (<name>_once, as #478 / 0401 added for assign_tasks) are not added for the
     crew link calls in this change (no database change in R243); the key is kept with each item so they can be used
     later without changing what is stored.

   Storage: localStorage (survives closing the browser), key "bpwq:" + SHA-256 of the link token - the raw token is
   never a storage key and never stored (the page re-supplies it). Only what is needed to send: kind, task id,
   action, a short task title for the message, the time pressed, and - for a check-in the studio asked a location
   for - the phone's position (sent once, then deleted with the item; the server keeps only the distance).
   Storage blocked (private mode / settings): the list lives in memory for this tab and the note says so.
   Old items: a check-in / out saved on an earlier day is never sent (it would count for the wrong day) and the
   person is told; any item older than 3 days is dropped the same way.
   Every read / write is wrapped in try/catch; nothing here ever breaks the page. */
(function (global) {
  "use strict";
  var PREFIX = "bpwq:", MAX_AGE = 3 * 24 * 60 * 60 * 1000, MAX_ITEMS = 50;
  var key = null, mem = [], memOnly = false, senders = {}, listeners = [], draining = null, timer = null;
  var expiredNotes = [];

  function uuid() {
    try { if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID(); } catch (e) {}
    return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, function () { return Math.floor(Math.random() * 16).toString(16); });
  }
  function localDay(t) { var d = new Date(t); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function online() { try { return !(global.navigator && global.navigator.onLine === false); } catch (e) { return true; } }

  function read() {
    if (!key) return mem.slice();
    if (memOnly) return mem.slice();
    try {
      var raw = global.localStorage.getItem(key);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(function (x) { return x && typeof x === "object" && x.id && x.kind; }) : [];
    } catch (e) { memOnly = true; return mem.slice(); }
  }
  function write(list) {
    mem = list.slice();
    if (!key || memOnly) return;
    try {
      if (list.length) global.localStorage.setItem(key, JSON.stringify(list));
      else global.localStorage.removeItem(key);
    } catch (e) { memOnly = true; }
  }
  // drop what must never be sent: a check-in / out from another day, anything older than 3 days
  function prune(list) {
    var now = Date.now(), today = localDay(now), keep = [];
    list.forEach(function (x) {
      var old = !(x.at > 0) || now - x.at > MAX_AGE, otherDay = x.kind === "check" && localDay(x.at) !== today;
      if (old || otherDay) expiredNotes.push(x); else keep.push(x);
    });
    return keep;
  }
  function emit() { var s = state(); listeners.slice().forEach(function (fn) { try { fn(s); } catch (e) {} }); }
  function state() {
    return { items: read(), count: read().length, memoryOnly: memOnly, online: online(), sending: !!draining,
      expired: expiredNotes.slice() };
  }

  async function use(token) {
    if (!token) return false;
    var k = null;
    try {
      var buf = await global.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token)));
      k = PREFIX + Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    } catch (e) { k = null; }
    if (!k) { memOnly = true; k = PREFIX + "mem"; }
    if (key === k) return true;
    var pending = mem.slice();          // presses saved before the key was ready (very first second) are kept
    key = k;
    try { global.localStorage.getItem(key); } catch (e) { memOnly = true; }
    var list = prune(read());
    pending.forEach(function (p) { if (!list.some(function (x) { return x.id === p.id; })) list.push(p); });
    write(list);
    emit();
    schedule();
    return true;
  }

  // save one press. Same press for the same task (or the same check action) is kept once. Returns the item.
  function add(item) {
    var list = prune(read());
    var same = list.filter(function (x) {
      return x.kind === item.kind && x.action === item.action && String(x.task || "") === String(item.task || "");
    })[0];
    if (same) return same;
    if (list.length >= MAX_ITEMS) throw new Error("Too many actions are waiting to send - connect to the internet first.");
    var it = { id: uuid(), kind: String(item.kind), action: String(item.action), task: item.task == null ? null : String(item.task),
      title: item.title ? String(item.title).slice(0, 120) : "", at: Date.now() };
    if (item.loc && isFinite(item.loc.lat) && isFinite(item.loc.lng)) it.loc = { lat: +item.loc.lat, lng: +item.loc.lng, accuracy: isFinite(item.loc.accuracy) ? +item.loc.accuracy : null };
    list.push(it);
    write(list);
    emit();
    schedule();
    return it;
  }
  function remove(id) { write(read().filter(function (x) { return x.id !== id; })); }
  function items(kind) { return read().filter(function (x) { return !kind || x.kind === kind; }); }
  function forTask(taskId) { return read().filter(function (x) { return x.kind === "task" && String(x.task) === String(taskId); }); }
  function has(kind, action) { return read().some(function (x) { return x.kind === kind && (!action || x.action === action); }); }
  function clearExpired() { expiredNotes = []; emit(); }

  // send everything in the order pressed. A network failure stops the drain (the rest wait); any other answer
  // (done, or refused by the server) removes the item. Returns {sent, refused:[{item, error}], left}.
  async function drain() {
    if (draining) return draining;
    draining = (async function () {
      var out = { sent: 0, refused: [], left: 0 };
      try {
        var list = prune(read()); write(list);
        for (var i = 0; i < list.length; i++) {
          var it = list[i], fn = senders[it.kind];
          if (!fn) continue;
          if (!online()) break;
          try {
            await fn(it);
            remove(it.id); out.sent++;
          } catch (e) {
            var net = false;
            try { net = !!(global.BPUI && global.BPUI.isNetworkError && global.BPUI.isNetworkError(e)); } catch (x) {}
            if (net) break;                    // still no connection: keep this one and everything after it
            remove(it.id); out.refused.push({ item: it, error: e });
          }
        }
      } finally {
        out.left = read().length;
        draining = null;
        emit();
        schedule();
      }
      return out;
    })();
    return draining;
  }
  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!read().length) return;
    timer = setTimeout(function () { timer = null; if (online()) run(); else schedule(); }, 30000);
  }
  var after = [];
  async function run() {
    if (!read().length || !online()) return null;
    var r = await drain();
    after.slice().forEach(function (fn) { try { fn(r); } catch (e) {} });
    return r;
  }

  if (typeof global.addEventListener === "function") {
    global.addEventListener("online", function () { setTimeout(run, 800); });   // give the radio a moment
    global.addEventListener("offline", emit);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") run(); });
  }

  global.HelmCrewQueue = {
    use: use, add: add, items: items, forTask: forTask, has: has, remove: remove, state: state, online: online,
    sender: function (kind, fn) { senders[kind] = fn; },
    onChange: function (fn) { listeners.push(fn); },
    onDrained: function (fn) { after.push(fn); },
    run: run, clearExpired: clearExpired,
    // true when this failure should be saved for later instead of shown as an error
    shouldQueue: function (e) {
      if (!online()) return true;
      try { return !!(global.BPUI && global.BPUI.isNetworkError && global.BPUI.isNetworkError(e)); } catch (x) { return false; }
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

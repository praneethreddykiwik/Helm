/* pager.js - R258 the numbered pager under a list (Quotes: 10 rows a page, each page fetched from the server).
 *   HelmPager.items(page, pages)      which numbers to draw: [1,"gap",98,99,100,101,102,103,"gap",125]
 *   HelmPager.rangeText(state)        "11-20 of 76"
 *   HelmPager.mount(host, { label, onGo })  the control: Back, numbers, Next, "Page [ ] Go"; .paint(state)
 *   HelmPager.list({ ... })           the list behind it: one page at a time, pages visited kept for a short time,
 *                                     an answer that is no longer wanted is dropped
 * CSP: createElement / textContent only; the look is pager.css. */
(function (root) {
  "use strict";
  function int(v, d) { v = Math.floor(Number(v)); return isFinite(v) ? v : d; }
  function num(n) { return Number(n || 0).toLocaleString("en-IN"); }
  // state: { page, size, total, more }  more = there are further rows but nobody knows how many (old database)
  function pages(s) {
    var n = Math.max(1, Math.ceil((s.total || 0) / (s.size || 10)));
    return s.more ? Math.max(n, (s.page || 1) + 1) : n;
  }
  function items(page, last) {
    var out = [], i, from, to;
    if (last <= 9) { for (i = 1; i <= last; i++) out.push(i); return out; }
    from = Math.max(2, page - 3); to = Math.min(last - 1, page + 2);
    if (page <= 5) { from = 2; to = 7; }
    if (page >= last - 4) { from = last - 6; to = last - 1; }
    out.push(1);
    if (from > 2) out.push(from === 3 ? 2 : "gap");                // never "…" for one single page
    for (i = from; i <= to; i++) out.push(i);
    if (to < last - 1) out.push(to === last - 2 ? last - 1 : "gap");
    out.push(last);
    return out;
  }
  function rangeText(s) {
    if (!s.total) return "";
    var a = (s.page - 1) * s.size + 1, b = Math.min(s.page * s.size, s.total);
    return (a === b ? num(a) : num(a) + "-" + num(b)) + " of " + num(s.total) + (s.more ? "+" : "");
  }
  // "" = fine, else what to tell the person
  function checkPage(text, last, more) {
    var t = String(text == null ? "" : text).trim();
    if (/^\d{1,7}$/.test(t) && Number(t) >= 1 && (more || Number(t) <= last)) return "";
    return more ? "Type a page number, 1 or more." : "Type a page number from 1 to " + num(last) + ".";
  }

  var uid = 0;
  function mount(host, o) {
    var doc = host.ownerDocument || root.document, st = { page: 1, size: 10, total: 0, more: false, busy: false }, typing = false, id = "hpg" + (++uid);
    function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function btn(cls, text, label) { var b = el("button", cls, text); b.type = "button"; if (label) b.setAttribute("aria-label", label); return b; }
    var nav = el("nav", "hpg"); nav.setAttribute("aria-label", (o.label || "List") + " pages"); nav.hidden = true;
    var row = el("div", "hpg-row"), back = btn("hpg-b hpg-back", "‹ Back", "Back, previous page"), nums = el("span", "hpg-nums"),
      now = el("span", "hpg-now"), next = btn("hpg-b hpg-next", "Next ›", "Next page"), go = el("span", "hpg-go"),
      lab = el("label", "hpg-lab", "Page"), box = el("input", "hpg-in"), ok = btn("hpg-b hpg-ok", "Go", "Go to this page");
    now.setAttribute("aria-hidden", "true");
    box.type = "text"; box.id = id + "in"; box.setAttribute("inputmode", "numeric"); box.setAttribute("autocomplete", "off"); box.maxLength = 7;
    box.setAttribute("aria-describedby", id + "err"); lab.htmlFor = box.id; lab.setAttribute("for", box.id);
    go.appendChild(lab); go.appendChild(box); go.appendChild(ok);
    [back, nums, now, next, go].forEach(function (x) { row.appendChild(x); });
    var err = el("p", "hpg-err"); err.id = id + "err"; err.setAttribute("role", "alert"); err.hidden = true;
    var info = el("p", "hpg-info"); info.setAttribute("role", "status"); info.setAttribute("aria-live", "polite");
    nav.appendChild(row); nav.appendChild(err); nav.appendChild(info); host.appendChild(nav);

    function off(b, yes) { if (yes) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled"); }   // stays focusable
    function say(msg) { err.textContent = msg; err.hidden = !msg; if (msg) box.setAttribute("aria-invalid", "true"); else box.removeAttribute("aria-invalid"); }
    function ask(n) { if (n < 1 || (!st.more && n > pages(st)) || n === st.page) return; say(""); o.onGo(n); }
    back.addEventListener("click", function () { ask(st.page - 1); });
    next.addEventListener("click", function () { ask(st.page + 1); });
    nums.addEventListener("click", function (e) { var b = e.target && e.target.closest ? e.target.closest("button[data-p]") : null; if (b) ask(int(b.getAttribute("data-p"), 0)); });
    function submit() { var m = checkPage(box.value, pages(st), st.more); say(m); if (m) { try { box.focus(); box.select(); } catch (e) {} return; } typing = false; ask(int(box.value, 1)); }
    ok.addEventListener("click", submit);
    box.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); submit(); } });
    box.addEventListener("input", function () { typing = true; if (!err.hidden) say(""); });

    function paint(s) {
      var had = !!(doc.activeElement && nums.contains && nums.contains(doc.activeElement));
      st = { page: Math.max(1, int(s.page, 1)), size: Math.max(1, int(s.size, 10)), total: Math.max(0, int(s.total, 0)), more: !!s.more, busy: !!s.busy };
      var last = pages(st);
      nav.hidden = !(st.total > st.size || st.more || st.page > 1);               // only when there is more than one page
      if (st.busy) nav.setAttribute("aria-busy", "true"); else nav.removeAttribute("aria-busy");
      while (nums.firstChild) nums.removeChild(nums.firstChild);
      items(st.page, last).concat(st.more ? ["gap"] : []).forEach(function (p) {
        if (p === "gap") { var g = el("span", "hpg-gap", "…"); g.setAttribute("aria-hidden", "true"); nums.appendChild(g); return; }
        var b = btn("hpg-b hpg-n" + (p === st.page ? " on" : ""), num(p), "Page " + num(p)); b.setAttribute("data-p", String(p));
        if (p === st.page) b.setAttribute("aria-current", "page");
        nums.appendChild(b);
        if (had && p === st.page) { try { b.focus({ preventScroll: true }); } catch (e) {} }
      });
      now.textContent = num(st.page) + " / " + num(last) + (st.more ? "+" : "");
      off(back, st.page <= 1); off(next, !st.more && st.page >= last);
      if (!typing || doc.activeElement !== box) { typing = false; box.value = String(st.page); if (!st.busy) say(""); }   // never over what is being typed
      if (!st.busy) { var t = rangeText(st); if (info.textContent !== t) info.textContent = t; }
    }
    return { el: nav, paint: paint };
  }

  /* o: { ui, size, ttl, key() -> string (tab / search / filters), fetch(page, hard) -> Promise<{ rows, total, page, more }>,
   *      render(result), busy(on), moved(page) (after a page is on screen), failed(error) (a page click that failed) } */
  function list(o) {
    var size = o.size || 10, ttl = o.ttl == null ? 30000 : o.ttl, clock = o.clock || Date.now;
    // want / at = the list and page last asked for; key = the list on screen
    var st = { want: null, at: 1, failed: false, key: null, page: 1, gen: 0, epoch: 0, total: 0, more: false, cache: {}, early: null };
    function drop() { st.cache = {}; st.epoch++; st.early = null; }
    function paint(page, busy) { if (o.ui) o.ui.paint({ page: page, size: size, total: st.total, more: st.more, busy: !!busy }); }
    function ask(n, key, hard) {
      var epoch = st.epoch, e = st.early;
      st.early = null;
      return ((e && e.key === key && e.page === n && e.epoch === epoch) ? e.p : Promise.resolve().then(function () { return o.fetch(n, !!hard); })).then(function (r) {
        r = r || {}; var res = { rows: r.rows || [], total: Math.max(0, int(r.total, 0)), page: Math.max(1, int(r.page, n)), more: !!r.more, raw: r };
        if (epoch === st.epoch) st.cache[key + "|" + res.page] = { at: clock(), res: res };
        return res;
      });
    }
    function go(n, opt) {
      opt = opt || {}; n = Math.max(1, int(n, 1));
      var key = o.key(), gen = ++st.gen, hit = opt.hard ? null : st.cache[key + "|" + n], same = key === st.key;
      st.want = key; st.at = n; st.failed = false;
      function show(res) {
        if (gen !== st.gen) return null;                                           // somebody asked for another page meanwhile
        st.page = st.at = res.page; st.key = key; st.total = res.total; st.more = res.more;
        if (o.busy) o.busy(false);
        paint(res.page, false); o.render(res); if (o.moved) o.moved(res.page, { click: !!opt.click });
        return res;
      }
      if (hit && clock() - hit.at < ttl) return Promise.resolve(show(hit.res));
      if (o.busy) o.busy(true);
      if (same) paint(n, true);                                                   // the number pressed lights up at once
      return ask(n, key, opt.hard).then(show, function (e) {
        if (gen !== st.gen) return null;
        if (o.busy) o.busy(false);
        if (opt.click && same) { st.at = st.page; paint(st.page, false); if (o.failed) o.failed(e); return null; }   // the page on screen stays
        st.failed = true; st.key = null; st.total = 0; st.more = false; paint(1, false); throw e;
      });
    }
    return {
      go: go,
      // something changed (save, delete, restore, Refresh): forget every kept page, read the page on screen again
      reset: function () { var e = st.early, n = st.want === o.key() ? st.at : 1; drop(); if (e) { e.epoch = st.epoch; st.early = e; } return go(n, { hard: true }); },   // a page asked early is fresh
      // the tab / search / filter changed: page 1. The same list again = nothing to do (force: a press on the tab = page 1, read again)
      apply: function (force) { if (st.want === o.key() && !st.failed) { if (!force) return Promise.resolve(null); drop(); } return go(1); },
      // ask for the page before it can be drawn (used by the next reset() for the same list and page)
      prime: function () {
        var key = o.key(), n = st.want === key ? st.at : 1, e = { key: key, page: n, epoch: st.epoch, p: Promise.resolve().then(function () { return o.fetch(n, true); }) };
        e.p.catch(function () {}); st.early = e;
      },
      unprime: function () { st.early = null; },
      start: function (n) { st.want = o.key(); st.at = st.page = Math.max(1, int(n, 1)); },
      remove: function () { drop(); },
      drop: drop,
      page: function () { return st.at; },
      total: function () { return st.total; },
    };
  }

  var api = { items: items, rangeText: rangeText, pages: pages, checkPage: checkPage, mount: mount, list: list };
  root.HelmPager = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

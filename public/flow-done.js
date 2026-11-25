/* R261 (owner): the "Done" card at the end of the quote flow, and the "Event confirmed" tick.
 * Reads only: it saves nothing and moves no stage. The page gives the facts (flow.html doneState()), this file lists what is
 * still missing (a link to each) or shows the green tick. Amounts are in data-money spans, so "Hide amounts" covers them.
 *   HelmFlowDone.items(facts)      -> [{ key, label, ok, href, optional }]   (pure)
 *   HelmFlowDone.summary(facts)    -> { total, done, missing, optional, ready, confirmed }   (pure)
 *   HelmFlowDone.mount(host, { facts: () => {...}, actions: { go, plan, share } }) -> { paint }
 *   HelmFlowDone.celebrate({ ...facts, actions, returnFocus })   the full green card; Esc / x closes it */
(function (root) {
  "use strict";
  var doc = root.document, SVG = "http://www.w3.org/2000/svg";

  // what an event needs before it counts as done. plan === null: this person cannot see the payment plan, so it is not asked for
  function items(f) {
    f = f || {};
    var out = [
      { key: "client", label: "Client's name, phone and event type", ok: !!f.client, href: "#sec-client", focus: "c_name" },
      { key: "date", label: "Event date", ok: !!f.date, href: "#sec-client", focus: "c_date" },
      { key: "time", label: "Event time", ok: !!f.time, href: "#sec-client", focus: "c_time" },
      { key: "guests", label: "Number of guests", ok: Number(f.guests) > 0, href: "#sec-client", focus: "c_guests" },
      { key: "venue", label: "Venue", ok: !!f.venue, href: "#sec-venue", focus: "v_name" },
      { key: "menu", label: "Menu", ok: !!f.menu, href: "#sec-menu" },
      { key: "layout", label: "Floor layout", ok: !!f.layout, href: "#sec-layout" },
      { key: "quote", label: "Quotation saved", ok: !!f.quote, href: "#sec-quote" }
    ];
    if (f.plan != null) out.push({ key: "plan", label: "Payment plan saved", ok: !!f.plan, href: "#sec-payplan" });
    out.push({ key: "approve", label: "Client approved (or the advance is recorded)", ok: !!f.approved, href: "#sec-approve" });
    out.push({ key: "advance", label: "Advance recorded", ok: !!f.advance, href: "#sec-pay" });
    [["discovery", "Discovery", "#sec-discovery"], ["reqs", "Requirements", "#sec-reqs"], ["proposal", "Proposal", "#sec-proposal"]].forEach(function (x) {
      if (f[x[0]] != null) out.push({ key: x[0], label: x[1], ok: !!f[x[0]], href: x[2], optional: true });
    });
    return out;
  }
  function summary(f) {
    var all = items(f), must = all.filter(function (i) { return !i.optional; }), miss = must.filter(function (i) { return !i.ok; });
    return { total: must.length, done: must.length - miss.length, missing: miss, optional: all.filter(function (i) { return i.optional && !i.ok; }),
      ready: !miss.length && !f.cancelled, confirmed: !!f.advance && !f.cancelled };
  }

  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function money(text) { var s = el("b", "", text); s.setAttribute("data-money", ""); return s; }
  function btn(text, cls, fn) { var b = el("button", "btn" + (cls ? " " + cls : ""), text); b.type = "button"; b.addEventListener("click", fn); return b; }
  function calm() { try { return root.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }
  function jump(i) {
    var s = doc.querySelector(i.href); if (!s) return;
    s.scrollIntoView({ block: "start", behavior: calm() ? "auto" : "smooth" });
    var t = (i.focus && doc.getElementById(i.focus)) || s.querySelector("input:not([type=hidden]):not([readonly]),select,textarea,button");
    if (t) try { t.focus({ preventScroll: true }); } catch (e) {}
  }
  function missList(list) {
    var ul = el("ul", "fd-miss");
    list.forEach(function (i) {
      var li = el("li"), a = el("a", "", i.label); a.href = i.href;
      a.addEventListener("click", function (e) { e.preventDefault(); close(true); jump(i); });
      li.appendChild(a); ul.appendChild(li);
    });
    return ul;
  }
  function svg(tag, at) { var n = doc.createElementNS(SVG, tag); Object.keys(at).forEach(function (k) { n.setAttribute(k, at[k]); }); return n; }
  function tick() {
    var s = svg("svg", { viewBox: "0 0 120 120", "class": "fd-tick", "aria-hidden": "true", focusable: "false" });
    s.appendChild(svg("circle", { cx: 60, cy: 60, r: 52, "class": "fd-c" }));
    s.appendChild(svg("path", { d: "M36 62 L53 79 L86 44", "class": "fd-p", pathLength: 100 }));
    return s;
  }

  var open = null;
  function close(noFocus) {
    if (!open) return; var o = open; open = null;
    doc.removeEventListener("keydown", o.key, true); o.ov.remove(); doc.documentElement.classList.remove("fd-lock");
    if (noFocus || !o.back) return;
    var back = function () { if (!open && o.back.isConnected) try { o.back.focus(); } catch (e) {} };
    back(); root.requestAnimationFrame(function () { root.requestAnimationFrame(back); });   // the page is inert until the dialog helper sees it closed
  }
  function celebrate(f) {
    close(true); var s = summary(f), acts = f.actions || {};
    var ov = el("div", "fd-ov"), sh = el("div", "fd-sheet"); ov.appendChild(sh);
    sh.setAttribute("role", "dialog"); sh.setAttribute("aria-modal", "true"); sh.setAttribute("aria-labelledby", "fdTitle"); sh.setAttribute("aria-describedby", "fdWhen");
    var hero = el("div", "fd-hero"), x = btn("×", "fd-x", function () { close(); }); x.setAttribute("aria-label", "Close");
    var burst = el("div", "fd-burst"); burst.setAttribute("aria-hidden", "true"); for (var i = 0; i < 12; i++) burst.appendChild(el("i", "d" + i));
    var ring = el("div", "fd-ring"); ring.append(burst, tick());
    var h = el("h2", "", "Event confirmed"); h.id = "fdTitle"; h.tabIndex = -1;
    hero.append(x, ring, h);
    var name = el("p", "fd-name", f.title || "Your event"), when = el("p", "fd-when", f.when || "Date to be confirmed"); when.id = "fdWhen";
    var body = el("div", "fd-body"), dl = el("dl", "fd-facts");
    var row = function (k, parts) { var d = el("div"); d.appendChild(el("dt", "", k)); var dd = el("dd"); parts.forEach(function (p) { if (p) dd.append(p); }); d.appendChild(dd); dl.appendChild(d); };
    if (f.clientName) row("Client", [f.clientName]);
    if (f.guests > 0) row("Guests", [Number(f.guests).toLocaleString("en-IN")]);
    if (f.received) row("Advance received", [money(f.received), f.receipt ? el("small", "", "Receipt " + f.receipt) : null]);
    if (f.next) row("Next payment", [money(f.next.amount), el("small", "", [f.next.label, f.next.due].filter(Boolean).join(" · "))]);
    else if (f.paidFull) row("Next payment", ["Paid in full"]);
    body.append(name, when, dl);
    if (s.missing.length) { body.append(el("p", "fd-still", "Still to fill in (" + s.missing.length + "):"), missList(s.missing)); }
    var go = el("div", "fd-acts");
    var main = acts.go ? btn("Go to the event", "primary", function () { close(true); acts.go(); }) : null;
    if (main) go.appendChild(main);
    if (acts.plan) go.appendChild(btn("Plan the day", "", function () { close(true); acts.plan(); }));
    if (acts.share) go.appendChild(btn("Share booklet", "", function () { close(true); acts.share(); }));
    body.appendChild(go); sh.append(hero, body);
    var key = function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      var f2 = Array.prototype.filter.call(sh.querySelectorAll("a[href],button:not([disabled])"), function (n) { return n.offsetParent !== null; });
      if (!f2.length) return; var a = doc.activeElement, first = f2[0], last = f2[f2.length - 1];
      if (!sh.contains(a) || a === h) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    };
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    doc.addEventListener("keydown", key, true);
    open = { ov: ov, key: key, back: f.returnFocus || doc.activeElement };
    doc.body.appendChild(ov); doc.documentElement.classList.add("fd-lock");
    try { h.focus({ preventScroll: true }); } catch (e) {}
    return ov;
  }

  function mount(host, opts) {
    if (!host || !opts) return null;
    var h = el("h2", "", "Done"), sub = el("p", "sub"), bar = el("div", "fd-bar"), fill = el("i"), msg = el("div", "fd-msg"), go = btn("Done", "primary fd-go", press);
    bar.setAttribute("aria-hidden", "true"); bar.appendChild(fill); msg.setAttribute("role", "status"); msg.hidden = true;
    var row = el("div", "fd-row"); row.append(go); host.replaceChildren(h, sub, bar, row, msg);
    var shown = false;
    function paint() {
      var f = opts.facts(), s; host.hidden = !f || !!f.cancelled; if (host.hidden) return; s = summary(f);
      sub.textContent = s.ready ? "Everything needed is done. Press Done to see it." : s.done + " of " + s.total + " needed things are done. Press Done to see what is missing.";
      fill.style.width = Math.round(s.done / s.total * 100) + "%"; host.classList.toggle("is-ready", s.ready);
      if (shown) { if (s.ready) { msg.hidden = true; shown = false; } else list(s); }
    }
    var sig = "";
    function list(s) {
      var k = s.missing.concat(s.optional).map(function (i) { return i.key; }).join(",") + s.confirmed; if (k === sig && msg.firstChild && !msg.hidden) return; sig = k;
      msg.replaceChildren(); msg.hidden = false;
      msg.appendChild(el("p", "fd-still", (s.confirmed ? "The booking is confirmed. " : "") + (s.missing.length === 1 ? "One thing is still missing:" : s.missing.length + " things are still missing:")));
      msg.appendChild(missList(s.missing));
      if (s.optional.length) msg.appendChild(el("p", "fd-opt", "Optional, not filled: " + s.optional.map(function (i) { return i.label; }).join(", ") + "."));
    }
    function press() {
      var f = opts.facts(), s = summary(f); paint();
      if (s.ready) { msg.hidden = true; shown = false; celebrate(Object.assign({ returnFocus: go, actions: opts.actions }, f)); return; }
      shown = true; sig = ""; list(s); var a = msg.querySelector("a"); if (a) try { a.focus({ preventScroll: true }); } catch (e) {} msg.scrollIntoView({ block: "nearest" });
    }
    paint();
    return { paint: paint, press: press };
  }
  var api = { items: items, summary: summary, mount: mount, celebrate: celebrate, close: close };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HelmFlowDone = api;
})(typeof window !== "undefined" ? window : globalThis);

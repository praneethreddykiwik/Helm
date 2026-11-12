/* suggest.js - r24 (0271): the Suggestions box.
   Two ways in, ONE anonymous-safe RPC (submit_suggestion; answers ok or a plain-words reason, nothing read back):
   - inside the app: the profile menu's "Send a suggestion" loads this file and calls HelmSuggest.open() -> a small
     dialog; sent through BPStore.suggest (signed in, so Helm records who and which studio - the server decides);
   - the public page /suggest (visitors, optional e-mail): the form #sg-form on that page.
   Lands in Helm HQ -> Requests -> Suggestions; an e-mail is queued to the HQ address. Text only, no inline script.
   r26: on the public page, when config.js has a Turnstile site key, a security check shows above the button; its
   one-use pass (captcha.js -> captcha-verify) goes in the "captcha" field. Signed-in app suggestions need no check.
   R154e (0351): the in-app dialog is the Suggestion box - send, My suggestions (status + Helm reply) and From my
   studio (+1). Opened from the "?" help menu and the profile menu: HelmSuggest.open({ view: "send" | "mine" | "studio" }). */
(function () {
  "use strict";
  var KINDS = [["", "Choose\u2026"], ["idea", "Idea"], ["problem", "Problem"], ["other", "Other"]];

  function anonRpc(body) {
    var cfg = window.SUPABASE_CONFIG || {}, base = String(cfg.url || "").replace(/\/+$/, "");
    if (!base || !cfg.anonKey) return Promise.resolve({ ok: false, error: "config" });
    return fetch(base + "/rest/v1/rpc/submit_suggestion", { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey },
      body: JSON.stringify({ p: body }) })
      .then(function (r) { return r.json().then(function (j) { return r.ok ? { ok: true, data: j } : { ok: false, error: "" }; }, function () { return { ok: false, error: "" }; }); })
      .catch(function () { return { ok: false, error: "network" }; });
  }
  function appRpc(body) {
    var st = window.BPStore;
    if (!st || typeof st.suggest !== "function") return anonRpc(body);
    return Promise.resolve(st.suggest(body)).then(function (d) { return { ok: true, data: d }; },
      function (e) { return { ok: false, error: /fetch|network/i.test(String(e && e.message)) ? "network" : "" }; });
  }
  function failText(r) {
    var d = r.ok ? r.data : null;
    if (d && d.message) return String(d.message).slice(0, 200);
    return r.error === "network" ? "No connection. Check your internet and try again." : "Something went wrong. Please try again.";
  }
  function page() { try { return (location.pathname || "/").slice(0, 120); } catch (e) { return null; } }

  /* ---- the public page (/suggest) ---- */
  var form = document.getElementById("sg-form");
  if (form) {
    var $ = function (id) { return document.getElementById(id); };
    var cap = window.HelmCaptcha ? window.HelmCaptcha.guard($("sg-captcha"), "suggest") : null;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var msg = $("sg-message").value.trim(), email = $("sg-email").value.trim(), e = $("sg-err");
      var show = function (t, el) { e.textContent = t; e.hidden = !t; ["sg-message", "sg-email"].forEach(function (i) { $(i).removeAttribute("aria-invalid"); }); if (el) { el.setAttribute("aria-invalid", "true"); el.focus(); } };
      if (msg.length < 3) return show("Please write your suggestion.", $("sg-message"));
      if (email && !/^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(email)) return show("Please enter a valid e-mail, or leave it empty.", $("sg-email"));
      show("");
      var body = { message: msg, category: $("sg-kind").value || null, email: email || null, page: "/suggest" };
      if ($("sg-website").value) body.website = $("sg-website").value;
      var btn = $("sg-send"); btn.disabled = true; btn.textContent = "Sending\u2026";
      (cap ? cap.pass() : Promise.resolve({ ok: true, pass: null })).then(function (c) {
        if (!c.ok) return { ok: false, captcha: c.message };
        if (c.pass) body.captcha = c.pass;
        return anonRpc(body);
      }).then(function (r) {
        btn.disabled = false; btn.textContent = "Send suggestion";
        if (r.captcha) return show(r.captcha);
        if (r.ok && r.data && r.data.ok === true) { form.hidden = true; $("sg-done").hidden = false; return; }
        show(failText(r), r.data && r.data.field === "email" ? $("sg-email") : $("sg-message"));
      });
    });
    return;
  }

  /* ---- inside the app: the Suggestion box dialog (R154e, 0351) ----
     Three tabs: "Suggest an idea" (kind, text up to 2000, the page I was on, share with my studio),
     "My suggestions" (status New / Planned / Done / Not now + the Helm reply, share on / off) and
     "From my studio" (ideas people of the same studio shared, +1). Every text goes in with textContent
     (Trusted Types is enforced), never as HTML. The server records who and which studio. */
  var STATUS = { "new": ["New", "sgd-s-new"], reviewed: ["Seen", "sgd-s-new"], planned: ["Planned", "sgd-s-plan"],
    done: ["Done", "sgd-s-done"], not_now: ["Not now", "sgd-s-not"] };
  var KIND_LABEL = { idea: "Idea", problem: "Problem", other: "Other" };
  var MAX = 2000;
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  // resolves once the dialog styles are in (or after 1.5 s), so the dialog never flashes unstyled
  function ensureCss() {
    var l = document.getElementById("helm-suggest-css");
    if (l && l.getAttribute("data-ready")) return Promise.resolve();
    if (!l) { l = el("link", { id: "helm-suggest-css", rel: "stylesheet", href: "/suggest.css?v=2" }); document.head.appendChild(l); }
    return new Promise(function (res) {
      var done = function () { l.setAttribute("data-ready", "1"); res(); };
      l.addEventListener("load", done); l.addEventListener("error", done); setTimeout(done, 1500);
    });
  }
  // the shared Wave 16 validators (form-validate.js) - loaded once, the form works without them too
  function ensureValidate() {
    if (window.HelmValidate || document.getElementById("helm-fv-js")) return;
    var sc = el("script", { id: "helm-fv-js" }); sc.src = "/form-validate.js?v=3"; document.head.appendChild(sc);
  }
  function checkText(v) {
    var HV = window.HelmValidate, r;
    if (HV && HV.rules && HV.rules.text) r = HV.rules.text(v, { label: "your suggestion", required: true, max: MAX });
    else { var c = String(v || "").replace(/[<>]/g, "").trim(); r = !c ? { ok: false, error: "Please enter your suggestion." }
      : (c.length > MAX ? { ok: false, error: "Please keep your suggestion to " + MAX + " characters or fewer." } : { ok: true, value: c }); }
    if (r.ok && String(r.value || "").length < 3) return { ok: false, error: "Please write a few more words." };
    return r;
  }
  function store() { return window.BPStore && window.BPStore.suggestions ? window.BPStore.suggestions : null; }
  function when(v) {
    var d = v ? new Date(v) : null;
    return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  }
  function chip(text, cls) { return el("span", { class: "sgd-chip " + (cls || "") }, text); }

  var open = null;
  function close() {
    if (!open) return;
    try { open.dlg.close(); } catch (e) {}
    open.dlg.remove(); var f = open.back; open = null;
    try { if (f) f.focus(); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent("helm:suggest-closed")); } catch (e) {}
  }

  function openDialog(opts) {
    opts = opts || {};
    if (open) { show(opts.view || "send"); return; }
    var css = ensureCss(); ensureValidate();
    var back = document.activeElement;
    var dlg = el("dialog", { class: "sgd", "aria-labelledby": "sgd-h" });
    dlg.style.visibility = "hidden";
    css.then(function () { dlg.style.visibility = ""; var f = dlg.querySelector("#sgd-msg, .sgd-tab[aria-selected=true]"); try { if (f) f.focus(); } catch (e) {} });
    var box = el("div", { class: "sgd-f" });
    var head = el("div", { class: "sgd-hd" });
    head.appendChild(el("h2", { id: "sgd-h" }, "Suggestion box"));
    var x = el("button", { type: "button", class: "sgd-x", "aria-label": "Close" }, "✕"); x.addEventListener("click", close);
    head.appendChild(x); box.appendChild(head);
    var tabs = el("div", { class: "sgd-tabs", role: "tablist", "aria-label": "Suggestion box" });
    var T = {};
    [["send", "Suggest an idea"], ["mine", "My suggestions"], ["studio", "From my studio"]].forEach(function (t) {
      var b = el("button", { type: "button", role: "tab", id: "sgd-t-" + t[0], "aria-controls": "sgd-p", class: "sgd-tab" });
      b.appendChild(el("span", null, t[1]));
      if (t[0] === "mine") { var bd = el("span", { class: "sgd-badge", "aria-label": "new replies" }); bd.hidden = true; b.appendChild(bd); T.badge = bd; }
      b.addEventListener("click", function () { show(t[0]); });
      b.addEventListener("keydown", function (e) {
        var keys = ["send", "mine", "studio"], i = keys.indexOf(t[0]);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); var k = keys[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3]; show(k); T[k].focus(); }
      });
      T[t[0]] = b; tabs.appendChild(b);
    });
    box.appendChild(tabs);
    var panel = el("div", { id: "sgd-p", role: "tabpanel", class: "sgd-p" });
    box.appendChild(panel);
    dlg.appendChild(box); document.body.appendChild(dlg);
    open = { dlg: dlg, back: back, panel: panel, tabs: T, view: null, data: null, draft: null };
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    dlg.addEventListener("click", function (e) { if (e.target === dlg) close(); });
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    show(opts.view || "send");
    var st = store(); if (st && opts.view !== "mine") st.unread().then(badge, function () {});
  }
  function badge(n) {
    if (!open || !open.tabs.badge) return;
    n = Number(n) || 0; open.tabs.badge.hidden = n < 1; open.tabs.badge.textContent = n > 9 ? "9+" : String(n);
  }
  function show(view) {
    if (!open) return;
    if (open.view === "send") saveDraft();
    open.view = view;
    Object.keys(open.tabs).forEach(function (k) { if (k === "badge") return;
      var on = k === view; open.tabs[k].setAttribute("aria-selected", on ? "true" : "false"); open.tabs[k].tabIndex = on ? 0 : -1; });
    open.panel.setAttribute("aria-labelledby", "sgd-t-" + view);
    clear(open.panel);
    if (view === "send") return sendView();
    listView(view);
  }
  function saveDraft() {
    var p = open && open.panel; if (!p) return;
    var ta = p.querySelector("#sgd-msg"); if (!ta) return;
    var k = p.querySelector("input[name=sgd-kind]:checked");
    open.draft = { text: ta.value, kind: k ? k.value : "idea", share: !!(p.querySelector("#sgd-share") || {}).checked };
  }

  function sendView() {
    var p = open.panel, d = open.draft || { text: "", kind: "idea", share: false };
    var f = el("form", { class: "sgd-form", novalidate: "" });
    f.appendChild(el("p", { class: "sgd-sub" }, "An idea, something that is not working, or anything else. It goes straight to the Helm team, and you will see their reply under My suggestions."));
    var fs = el("fieldset", { class: "sgd-kinds" }); fs.appendChild(el("legend", null, "What is it?"));
    var seg = el("div", { class: "sgd-seg" });
    [["idea", "Idea"], ["problem", "Problem"], ["other", "Other"]].forEach(function (k) {
      var id = "sgd-k-" + k[0], lab = el("label", { for: id, class: "sgd-segb" });
      var r = el("input", { type: "radio", name: "sgd-kind", id: id, value: k[0] }); if (d.kind === k[0]) r.checked = true;
      lab.appendChild(r); lab.appendChild(el("span", null, k[1])); seg.appendChild(lab);
    });
    fs.appendChild(seg); f.appendChild(fs);
    var lm = el("label", { for: "sgd-msg" }, "Your suggestion"); lm.appendChild(el("span", { class: "req-star", "aria-hidden": "true" }, " *"));
    var ta = el("textarea", { id: "sgd-msg", rows: "5", maxlength: String(MAX), "aria-required": "true", "aria-describedby": "sgd-msg-err sgd-count" });
    ta.value = d.text || "";
    var err = el("p", { id: "sgd-msg-err", class: "fv-msg sgd-err", "aria-live": "polite" }); err.hidden = true;
    var count = el("p", { id: "sgd-count", class: "sgd-count" });
    function paintCount() { count.textContent = ta.value.length + " / " + MAX; }
    paintCount();
    var touched = false;
    function check(force) {
      if (force) touched = true;
      var r = checkText(ta.value);
      if (touched && !r.ok) { err.textContent = r.error; err.hidden = false; ta.setAttribute("aria-invalid", "true"); ta.classList.add("fv-error"); }
      else { err.hidden = true; ta.removeAttribute("aria-invalid"); ta.classList.remove("fv-error"); }
      return r;
    }
    ta.addEventListener("input", function () { paintCount(); if (touched) check(false); });
    ta.addEventListener("blur", function () { if (ta.value.trim()) check(true); });
    var pg = page();
    var pgRow = el("label", { class: "sgd-chk", for: "sgd-page" });
    var pgBox = el("input", { type: "checkbox", id: "sgd-page" }); pgBox.checked = !!pg;
    pgRow.appendChild(pgBox); var pgt = el("span", null, "Include the page I was on "); pgt.appendChild(el("code", { class: "sgd-code" }, pg || "/")); pgRow.appendChild(pgt);
    if (!pg) pgRow.hidden = true;
    var shRow = el("label", { class: "sgd-chk", for: "sgd-share" });
    var shBox = el("input", { type: "checkbox", id: "sgd-share" }); shBox.checked = !!d.share;
    shRow.appendChild(shBox); shRow.appendChild(el("span", null, "Let people in my studio see this and add a +1 (they never see who sent it)"));
    var fail = el("p", { class: "sgd-err", role: "alert" }); fail.hidden = true;
    var row = el("div", { class: "sgd-row" });
    var cancel = el("button", { type: "button", class: "sgd-btn sgd-ghost" }, "Cancel"); cancel.addEventListener("click", close);
    var send = el("button", { type: "submit", class: "sgd-btn" }, "Send");
    row.appendChild(cancel); row.appendChild(send);
    [lm, ta, err, count, pgRow, shRow, fail, row].forEach(function (n) { f.appendChild(n); });
    p.appendChild(f);
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var r = check(true);
      if (!r.ok) { ta.focus(); return; }
      var k = f.querySelector("input[name=sgd-kind]:checked");
      var body = { message: ta.value.replace(/[<>]/g, "").trim(), category: k ? k.value : "idea", page: pgBox.checked ? pg : null };
      fail.hidden = true; send.disabled = true; send.textContent = "Sending…";
      var st = store();
      var go = st ? Promise.resolve(st.submit(Object.assign({ share: shBox.checked }, body))).then(function (dd) { return { ok: true, data: dd }; },
        function (e) { return { ok: false, error: /fetch|network/i.test(String(e && e.message)) ? "network" : "" }; }) : appRpc(body);
      go.then(function (res) {
        send.disabled = false; send.textContent = "Send";
        if (res.ok && res.data && res.data.ok === true) {
          open.draft = null; open.data = null;
          clear(p);
          p.appendChild(el("h3", { class: "sgd-h3" }, "Thank you!"));
          p.appendChild(el("p", { class: "sgd-sub" }, "The Helm team has your suggestion. We read every one, and the reply shows up under My suggestions."));
          var r2 = el("div", { class: "sgd-row" });
          var mine = el("button", { type: "button", class: "sgd-btn sgd-ghost" }, "See my suggestions"); mine.addEventListener("click", function () { show("mine"); });
          var ok = el("button", { type: "button", class: "sgd-btn" }, "Close"); ok.addEventListener("click", close);
          r2.appendChild(mine); r2.appendChild(ok); p.appendChild(r2); ok.focus();
          return;
        }
        fail.textContent = failText(res); fail.hidden = false;
      });
    });
    ta.focus();
  }

  function listView(view) {
    var p = open.panel, st = store();
    var wait = el("p", { class: "sgd-sub", role: "status" }, "Loading…"); p.appendChild(wait);
    if (!st) { wait.textContent = "Please sign in again to see your suggestions."; return; }
    Promise.resolve(open.data || st.mine()).then(function (data) {
      if (!open || open.view !== view) return;
      clear(p);
      if (!data) { p.appendChild(el("p", { class: "sgd-sub" }, "Your suggestions list is coming soon. You can still send one from the first tab.")); return; }
      open.data = data;
      var rows = Array.isArray(data[view]) ? data[view] : [];
      if (view === "mine") badge(data.unread);
      if (!rows.length) {
        p.appendChild(el("p", { class: "sgd-empty" }, view === "mine" ? "You have not sent a suggestion yet."
          : "Nobody in your studio has shared an idea yet. Tick “Let people in my studio see this” when you send one."));
        var b = el("button", { type: "button", class: "sgd-btn" }, "Suggest an idea"); b.addEventListener("click", function () { show("send"); });
        var r0 = el("div", { class: "sgd-row sgd-row-l" }); r0.appendChild(b); p.appendChild(r0);
        return;
      }
      var ul = el("ul", { class: "sgd-list" });
      rows.forEach(function (x) { ul.appendChild(card(x, view, data.can_share)); });
      p.appendChild(ul);
      if (view === "mine" && Number(data.unread) > 0) {
        Promise.resolve(st.seen()).then(function () { if (open && open.data) { open.data.unread = 0; (open.data.mine || []).forEach(function (r) { r.unread = false; }); } badge(0);
          try { window.dispatchEvent(new CustomEvent("helm:suggest-seen")); } catch (e) {} }, function () {});
      }
    }, function () {
      if (!open || open.view !== view) return;
      clear(p); p.appendChild(el("p", { class: "sgd-err", role: "alert" }, "Could not load your suggestions. Check your connection and try again."));
    });
  }
  function card(x, view, canShare) {
    var li = el("li", { class: "sgd-card" + (x.unread ? " sgd-unread" : "") });
    var top = el("div", { class: "sgd-meta" });
    var s = STATUS[x.status] || [String(x.status || ""), ""];
    top.appendChild(chip(s[0], s[1]));
    if (KIND_LABEL[x.category]) top.appendChild(chip(KIND_LABEL[x.category], "sgd-k"));
    if (x.shared && view === "mine") top.appendChild(chip("Shared with studio", "sgd-k"));
    top.appendChild(el("span", { class: "sgd-date" }, when(x.created_at)));
    li.appendChild(top);
    li.appendChild(el("p", { class: "sgd-msg" }, x.message || ""));
    if (x.reply) {
      var rp = el("div", { class: "sgd-reply" });
      var rh = el("p", { class: "sgd-reply-h" }, "Reply from the Helm team" + (x.replied_at ? " · " + when(x.replied_at) : ""));
      if (x.unread) rh.appendChild(chip("New", "sgd-s-plan"));
      rp.appendChild(rh); rp.appendChild(el("p", { class: "sgd-msg" }, x.reply)); li.appendChild(rp);
    }
    var foot = el("div", { class: "sgd-foot" });
    var st = store();
    if (view === "studio") {
      var v = el("button", { type: "button", class: "sgd-vote", "aria-pressed": x.voted ? "true" : "false" });
      function paint() { v.textContent = "+1 · " + (Number(x.votes) || 0); v.setAttribute("aria-pressed", x.voted ? "true" : "false");
        v.setAttribute("aria-label", (x.voted ? "Remove your +1. " : "Add a +1. ") + (Number(x.votes) || 0) + " so far"); }
      paint();
      v.addEventListener("click", function () {
        if (v.disabled || !st) return; v.disabled = true;
        Promise.resolve(st.vote(x.id, !x.voted)).then(function (r) { if (r) { x.voted = !!r.voted; x.votes = r.votes; } paint(); v.disabled = false; },
          function () { v.disabled = false; v.textContent = "Try again"; });
      });
      foot.appendChild(v);
    } else {
      if (Number(x.votes) > 0) foot.appendChild(el("span", { class: "sgd-date" }, "+" + x.votes + " from your studio"));
      if (canShare && st) {
        var sh = el("button", { type: "button", class: "sgd-link" }, x.shared ? "Stop sharing with my studio" : "Share with my studio");
        sh.addEventListener("click", function () {
          if (sh.disabled) return; sh.disabled = true;
          Promise.resolve(st.share(x.id, !x.shared)).then(function (r) { if (r) x.shared = !!r.shared; if (open) open.data = null; show("mine"); },
            function () { sh.disabled = false; sh.textContent = "Could not change it - try again"; });
        });
        foot.appendChild(sh);
      }
    }
    if (foot.firstChild) li.appendChild(foot);
    return li;
  }
  window.HelmSuggest = { open: openDialog, close: close };
})();

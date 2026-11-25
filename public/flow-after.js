/* R262: the end of the quote page, after the booking is confirmed (owner: "record the payment there, then share the client page, the booklet and the
 * invitation site from the same quotation, then Done").
 *   step 11 #sec-after  - the client page link (the one already sent: nothing is created or re-sent) and the booklet (opens the page's own Share dialog)
 *   step 12 #sec-invite - the invitation site: theme, words, date, time, place, message, Save, Publish, Copy, Open, Send to client. It is the SAME row the
 *                         Invitation Studio edits (event_sites); every save reads that row first and changes only the fields shown here, so photos, music,
 *                         schedule and RSVP settings made in the Studio stay.
 *   HelmFlowAfter.prefill(ev, plan, h) / merge(site, form) / changed(a, b) / whenOff(ev, form, h)  (pure)
 *   HelmFlowAfter.mount({ share, invite, quote, id, canEdit, open, shareBooklet, onChange }) -> { refresh, facts, dirty, save, discard }
 * DOM via createElement + textContent only. */
(function (root) {
  "use strict";
  var doc = root.document;
  var TYPES = { wedding: "wedding", reception: "wedding", sangeet: "wedding", haldi: "wedding", mehendi: "wedding", mehndi: "wedding", engagement: "engagement", birthday: "birthday", corporate: "corporate", conference: "corporate" };
  var DEF = { wedding: ["are getting married", "eternal"], engagement: ["are engaged", "promise"], birthday: ["is turning 30!", "confetti"], corporate: ["Annual conference", "summit"], general: ["", "soiree"] };
  var KEYS = ["names", "headline", "date", "time", "venue", "address", "host", "hostPhone", "message"];
  var MAP_RE = /^https:\/\/[^\s"'<>\\]+$/i;
  function str(v) { return String(v == null ? "" : v).trim(); }
  function noDemo(v) { var t = str(v), o = t.replace(/^Demo\s*[·•]\s*/, "").trim(); return o || t; }
  function noTypeWords(v) {
    var t = noDemo(v), o = t, p;
    do { p = o; o = o.replace(/(?:'s|’s)?\s+(?:wedding|engagement|reception|sangeet|mehendi|mehndi|haldi|ceremony|celebrations?|nikah|shaadi|marriage|ring ceremony|roka|cocktail|party)\s*$/i, "").trim(); } while (o && o !== p);
    return o || t;
  }
  // a NEW invitation starts from what the quote knows (same rules as the Invitation Studio). h: { formatTime, autoTitle(title, code) }
  function prefill(ev, plan, h) {
    ev = ev || {}; plan = plan || {}; h = h || {}; var c = ev.client && typeof ev.client === "object" ? ev.client : {};
    var k = str(ev.eventType).toLowerCase(), type = TYPES[k] || TYPES[k.split(/[^a-z]+/)[0]] || "general", d = DEF[type];
    var date = str(ev.eventDate || c.eventDate).slice(0, 10), tm = ev.eventTime || c.eventTime || c.time || "";
    var title = ev.title && !(h.autoTitle && h.autoTitle(ev.title, ev.code)) ? ev.title : "";
    var names = c.names || c.coupleNames || (title ? (type === "wedding" || type === "engagement" ? noTypeWords(title) : title) : "") || (type === "corporate" ? c.company : "") || c.name;
    return { event_type: type, template: /^(sangeet|mehendi|mehndi|haldi)/.test(k) ? "mehndi" : d[1], names: noDemo(names), headline: d[0], date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
      time: tm ? ((h.formatTime && h.formatTime(tm)) || str(tm)) : "", venue: noDemo(plan.venue_name || c.venueName || c.venue), address: noDemo(plan.venue_address || c.address),
      host: noDemo(c.name), hostPhone: str(c.phone), message: "", mapUrl: typeof c.mapUrl === "string" && MAP_RE.test(c.mapUrl.trim()) ? c.mapUrl.trim() : "" };
  }
  // what the form shows for a saved site (private_data: the phone / address kept off the public page come back into the form)
  function fromSite(s) {
    var d = Object.assign({}, s && s.data || {}, s && s.private_data && typeof s.private_data === "object" ? s.private_data : {}), o = { template: s.template, event_type: s.event_type || "general" };
    KEYS.forEach(function (k) { o[k] = d[k] == null ? "" : String(d[k]); }); return o;
  }
  // the patch that is saved: everything the row already has, with only the fields of this form changed
  function merge(site, form, country) {
    var d = Object.assign({}, site && site.data || {}, site && site.private_data && typeof site.private_data === "object" ? site.private_data : {});
    KEYS.forEach(function (k) { d[k] = str(form[k]); });
    if (form.mapUrl && !d.mapUrl) d.mapUrl = form.mapUrl;
    if (country && !d.country) d.country = country;
    return { title: d.names || "Invitation", template: form.template, event_type: form.event_type, data: d };
  }
  function changed(a, b) { return !a || !b ? a !== b : ["template"].concat(KEYS).some(function (k) { return str(a[k]) !== str(b[k]); }); }
  // the event's own date / time when the invitation says something else ("" = the same)
  function whenOff(ev, form, h) {
    var c = ev && ev.client || {}, d = str(ev && ev.eventDate || c.eventDate).slice(0, 10), t = ev && ev.eventTime || "", key = function (x) { return (h && h.toHHMM && h.toHHMM(x)) || str(x).toLowerCase(); };
    var out = {}; if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d !== str(form.date)) out.date = d;
    if (t && key(t) !== key(form.time)) out.time = (h && h.formatTime && h.formatTime(t)) || String(t);
    return out.date || out.time ? out : null;
  }
  // "Reply by" set in the Studio can't be after the event (same check as the Studio)
  function problem(patch) {
    var d = patch.data || {};
    if (!d.names) return "Write the names first.";
    if (!d.date) return "Set the date of the invitation.";
    if (d.rsvpBy && d.date && d.rsvpBy > d.date) return "“Reply by” is after the event date. Change it in the full editor.";
    return "";
  }
  var api = { prefill: prefill, fromSite: fromSite, merge: merge, changed: changed, whenOff: whenOff, problem: problem, KEYS: KEYS };
  root.HelmFlowAfter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!doc) return;

  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function btn(text, cls, fn) { var b = el("button", "btn sm" + (cls ? " " + cls : ""), text); b.type = "button"; if (fn) b.addEventListener("click", function () { fn(b); }); return b; }
  function out(text, href) { var a = el("a", "btn sm", text); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; }
  function toast(t, k) { var U = root.BPUI; if (U && U.toast) U.toast(t, { type: k || "ok" }); }
  function head(n, title) { var h = el("h2"); h.appendChild(el("span", "step-n", String(n))); h.appendChild(doc.createTextNode(" " + title + " ")); var p = el("span", "pill fa-pill"); p.hidden = true; h.appendChild(p); return { h: h, pill: p }; }
  function linkRow(label, id, url) {
    var f = el("div", "fld fa-link"), l = el("label", "", label), i = el("input"); l.htmlFor = id; i.id = id; i.readOnly = true; i.value = url; i.addEventListener("focus", function () { i.select(); }); f.append(l, i); return f;
  }
  function copyBtn(url, id) {
    return btn("Copy link", "", function (b) {
      Promise.resolve().then(function () { return root.navigator.clipboard.writeText(url); }).then(function () { b.textContent = "Copied ✓"; })
        .catch(function () { var i = doc.getElementById(id); if (i) { i.focus(); i.select(); } toast("The link is selected, press Ctrl/Cmd + C.", "info"); });
    });
  }

  api.mount = function (o) {
    var B = root.BPStore, U = root.BPUI, HC = root.HelmCountry || {}, HX = root.HelmInviteX, HEN = root.HelmEventName;
    var h = { formatTime: HC.formatTime, toHHMM: HC.toHHMM, autoTitle: HEN && HEN.isAuto };
    var booklet = null, bookletKnown = false, state = null, paused = false, site = null, siteKnown = false, siteFail = false, form = null, saved = null, share = null, plan = null, studio = "", busy = false, seq = 0;
    var ev = function () { return o.quote() || {}; }, open = function () { return !!o.open(); };
    function country() { try { var t = B.quoteTax ? B.quoteTax(ev()) : null, c = (t && t.country) || ((B.studioTax && B.studioTax()) || {}).country; return /^(IN|AE|US)$/.test(c || "") ? c : "IN"; } catch (e) { return "IN"; } }
    var confirmed = function () { return open() && ["confirmed", "planning", "resources", "ready", "event_day", "settlement", "closed"].indexOf(ev().status) >= 0; };

    // ---- step 11
    var H11 = head(11, "Share with the client"), sub11 = el("p", "sub"), body11 = el("div", "fa-body"); o.share.replaceChildren(H11.h, sub11, body11);
    function portal() { var t = ev().approvalToken || ev().approval_token; return t && !paused ? B.links.url("portal", t, root.location.origin + "/portal.html?token=" + encodeURIComponent(t)) : ""; }
    function paintShare() {
      var on = open(); o.share.hidden = ev().status === "cancelled"; body11.hidden = !on;
      sub11.textContent = on ? "Give the client their page and the booklet." : "Opens when the client has approved or the advance is recorded.";
      H11.pill.hidden = !(on && booklet && !booklet.expired); H11.pill.textContent = "Booklet ready";
      if (!on) return;
      var q = ev(), c = q.client || {}, link = portal(), box = el("section", "fa-part"); box.appendChild(el("h3", "", "Client page"));
      if (link) {
        box.appendChild(el("p", "sub fa-hint", "The same private page the client approved on: their quotation, payments and booklet."));
        box.appendChild(linkRow("Client page link", "faPortal", link));
        var r = el("div", "fa-row"), txt = "Hi " + (c.name || "") + ", here is your event page: " + link, ph = ""; r.appendChild(copyBtn(link, "faPortal"));
        try { ph = B.waNumber(c.phone); } catch (e) { ph = ""; }
        if (ph) r.appendChild(out("WhatsApp (manual)", "https://wa.me/" + ph + "?text=" + encodeURIComponent(txt)));
        r.appendChild(out("Email (manual)", "mailto:" + encodeURIComponent(c.email || "").replace(/%40/g, "@") + "?subject=" + encodeURIComponent("Your event page") + "&body=" + encodeURIComponent(txt)));
        r.appendChild(out("Preview", link + "#preview")); box.appendChild(r);
      } else box.appendChild(el("p", "sub fa-hint", paused ? "The client's links are off because this event was cancelled before. Turn them back on from the event page (Re-share links)." : "No client page was sent for this quotation. The booklet below is enough."));
      var bk = el("section", "fa-part"); bk.appendChild(el("h3", "", "Event booklet"));
      var live = booklet && booklet.token && !booklet.expired;
      bk.appendChild(el("p", "sub fa-hint", !bookletKnown ? "Checking the booklet…" : live ? "The booklet link is live. Copy it, open it, or press Share booklet to e-mail it." : booklet && booklet.expired ? "The booklet link has expired. Make a new one." : "No booklet link yet. Press Share booklet to make one."));
      if (live) bk.appendChild(linkRow("Booklet link", "faBooklet", B.booklet.url(booklet.token)));
      var r2 = el("div", "fa-row"); if (live) { r2.appendChild(copyBtn(B.booklet.url(booklet.token), "faBooklet")); r2.appendChild(out("Open", B.booklet.url(booklet.token) + "#preview")); }
      if (o.canEdit()) r2.appendChild(btn(live ? "Share booklet" : "Make the booklet link", live ? "" : "primary", function () { o.shareBooklet(); }));
      bk.appendChild(r2); body11.replaceChildren(box, bk);
    }

    // ---- step 12
    var H12 = head(12, "Invitation site"), sub12 = el("p", "sub"), body12 = el("div", "fa-body"); o.invite.replaceChildren(H12.h, sub12, body12);
    ["input", "change"].forEach(function (t) { o.invite.addEventListener(t, function (e) { e.stopPropagation(); }); });   // not part of the quote's own unsaved changes
    var I = {}, when = el("p", "psch-soft"), whenT = el("span"), msg = el("p", "fa-msg"), linkBox = el("div"), sendBox = el("div", "fa-send"), frameWrap = el("div", "fa-frame"), built = false, frame = null;
    when.setAttribute("role", "status"); msg.setAttribute("role", "status"); when.hidden = true; frameWrap.hidden = true;
    function field(k, label, tag, at) {
      var f = el("div", "fld" + (at && at.full ? " full" : "")), l = el("label", "", label), n = el(tag || "input"); n.id = "fa_" + k; l.htmlFor = n.id; if (at && at.type) n.type = at.type; if (at && at.ph) n.placeholder = at.ph; if (at && at.max) n.maxLength = at.max;
      n.addEventListener("input", read); n.addEventListener("change", read); I[k] = n; f.append(l, n); return f;
    }
    function read() { if (!form) return; ["template"].concat(KEYS).forEach(function (k) { if (I[k]) form[k] = I[k].value; }); msg.textContent = ""; paintWhen(); paintActs(); preview(); if (share) share.refresh(); }
    var acts = el("div", "fa-row"), bSave, bPub, bPrev, aFull;
    function build() {
      if (built) return; built = true;
      var g = el("div", "grid"), t = field("template", "Theme", "select"); (HX && HX.THEMES || []).forEach(function (x) { var op = el("option", "", x.n + " (" + x.d + ")"); op.value = x.k; I.template.appendChild(op); });
      g.append(t, field("names", "Names", "input", { max: 120, ph: "e.g. Ayla & Sam" }), field("headline", "Headline", "input", { max: 120, ph: "e.g. are getting married" }), field("date", "Date", "input", { type: "date" }),
        field("time", "Time", "input", { max: 40, ph: "e.g. 4:00 PM" }), field("venue", "Venue", "input", { max: 160 }), field("address", "Address", "input", { max: 300, full: 1 }),
        field("host", "Hosted by (optional)", "input", { max: 120 }), field("hostPhone", "Contact for guests (optional)", "input", { max: 80 }), field("message", "Welcome message (optional)", "textarea", { max: 2000, full: 1 }));
      when.append(whenT, doc.createTextNode(" "), btn("Use the event's", "", function () { var w = whenOff(ev(), form, h); if (!w) return; if (w.date) I.date.value = w.date; if (w.time) I.time.value = w.time; read(); }));
      bSave = btn("Save draft", "", function () { save().catch(function () {}); }); bPub = btn("Publish", "primary", publish); bPrev = btn("Preview", "", togglePreview);
      bPrev.setAttribute("aria-expanded", "false"); aFull = el("a", "btn sm", "More: photos, music, RSVP"); aFull.href = "invite-studio.html?quote=" + encodeURIComponent(o.id) + "&from=flow";
      acts.append(bPrev, bSave, bPub, aFull); body12.replaceChildren(g, when, acts, msg, frameWrap, linkBox, sendBox);
    }
    function fillForm() { ["template"].concat(KEYS).forEach(function (k) { if (I[k]) I[k].value = form[k] == null ? "" : form[k]; }); try { if (U.dateHint) U.dateHint(I.date); } catch (e) {} }
    function isDirty() { return !!(form && changed(form, saved)); }
    function live() { return !!(site && site.status === "published" && site.slug); }
    function url() { return live() ? B.links.url("invite", site.slug, root.location.origin + "/i/" + site.slug) : ""; }
    function paintWhen() {
      var w = form && whenOff(ev(), form, h); when.hidden = !w || !o.canEdit(); if (!w) return;
      var day = w.date && HC.formatDate ? HC.formatDate(country(), w.date, { weekday: false }) : w.date; whenT.textContent = "The event is " + [w.date ? "on " + day : "", w.time ? "at " + w.time : ""].filter(Boolean).join(" ") + ".";
    }
    function paintActs() {
      if (!built) return; var can = o.canEdit(), d = isDirty();
      Object.keys(I).forEach(function (k) { I[k].disabled = !can; }); bSave.hidden = bPub.hidden = !can; aFull.hidden = !can;
      bSave.textContent = live() ? "Save changes" : "Save draft"; bPub.hidden = !can || live(); bPub.textContent = site && site.published_at ? "Turn link back on" : "Publish"; bSave.disabled = busy || (!d && !!site); bPub.disabled = busy;
      H12.pill.hidden = !site; H12.pill.textContent = live() ? (d ? "Published, changes not saved" : "Published") : "Draft";
    }
    function paintLink() {
      linkBox.replaceChildren(); if (!live()) { sendBox.hidden = true; return; } var u = url(); linkBox.appendChild(linkRow("Invitation link", "faInvite", u));
      var r = el("div", "fa-row"); r.append(copyBtn(u, "faInvite"), out("Open site", u)); linkBox.appendChild(r); sendBox.hidden = !o.canEdit();
      if (!share && o.canEdit() && root.HelmInviteShare) {
        var trial = B.subscription && B.subscription.trial ? Promise.resolve(B.subscription.trial()).then(function (t) { return !!(t && t.status === "trial"); }).catch(function () { return false; }) : Promise.resolve(false);
        sendBox.appendChild(el("h3", "", "Send it to the client"));
        share = root.HelmInviteShare.mount(sendBox, { getSite: function () { return site; }, getQuote: ev, getLink: url, country: country, isDirty: isDirty, trial: trial });
      } else if (share) share.refresh();
    }
    function paintInvite() {
      o.invite.hidden = ev().status === "cancelled"; var ok = confirmed();
      sub12.textContent = ok ? "The guests' website. It is the same invitation as on the event page, so a change here shows there too." : "Opens when the booking is confirmed.";
      body12.hidden = !ok; H12.pill.hidden = !ok || !site; if (!ok) return;
      if (siteFail) { body12.replaceChildren(el("p", "sub fa-hint", "The saved invitation couldn't be loaded, so nothing can be saved here."), btn("Try again", "", function () { loadSite(); })); built = false; I = {}; acts = el("div", "fa-row"); when.replaceChildren(); return; }
      if (!siteKnown) { body12.replaceChildren(el("p", "sub fa-hint", "Loading the invitation…")); return; }
      build(); fillForm(); paintWhen(); paintActs(); paintLink();
    }
    function preview() { if (!frame || frameWrap.hidden || !form) return; var p = merge(site, form, country()); try { frame.contentWindow.postMessage({ type: "helm-preview", site: { template: p.template, event_type: p.event_type, title: p.title, data: p.data, studio: studio } }, location.origin); } catch (e) {} }
    function togglePreview() {
      frameWrap.hidden = !frameWrap.hidden; bPrev.setAttribute("aria-expanded", frameWrap.hidden ? "false" : "true"); bPrev.textContent = frameWrap.hidden ? "Preview" : "Hide preview";
      if (!frame) { frame = el("iframe"); frame.title = "Invitation preview"; frame.addEventListener("load", preview); frame.src = "/invite.html?preview=1"; frameWrap.appendChild(frame); } else preview();
    }
    async function loadSite() {
      var my = ++seq, s = null; if (!confirmed() || !B.sites || !B.sites.forQuote) return;
      try { s = await B.sites.forQuote(o.id); } catch (e) { if (my !== seq) return; siteFail = true; paintInvite(); return; }
      if (my !== seq) return; siteFail = false; siteKnown = true; site = s;
      if (!form || !isDirty()) {
        if (s) form = fromSite(s); else { if (!plan) { try { plan = await B.plan.get(o.id) || {}; } catch (e) { plan = {}; } } form = prefill(ev(), plan, h); }
        saved = Object.assign({}, form);
      }
      paintInvite(); preview(); note();
    }
    // the row is read again first: what the Studio saved meanwhile (photos, RSVP...) is kept, only this form's fields change
    async function save() {
      if (busy) return false; var p = merge(site, form, country()), bad = problem(p); if (bad) { msg.textContent = bad; return false; }
      busy = true; paintActs();
      try {
        var row = await B.sites.forQuote(o.id); if (!row) { row = await B.sites.create(o.id, form.event_type, form.template); row = Array.isArray(row) ? row[0] : row; }
        p = merge(row, form, country()); await B.sites.save(row.id, p); site = Object.assign({}, row, p, { private_data: {} }); saved = Object.assign({}, form);
        msg.textContent = live() ? "Saved. Guests see the change now." : "Draft saved. Guests see nothing until you publish."; return true;
      } catch (e) { msg.textContent = U && U.friendlyError ? U.friendlyError(e, { action: "save the invitation" }) : "Couldn't save the invitation."; throw e; }
      finally { busy = false; paintActs(); paintLink(); note(); }
    }
    async function publish() {
      try { if (!(await save())) return; } catch (e) { return; }
      busy = true; paintActs();
      try { var r = await B.sites.publish(site.id); site = Object.assign({}, site, (Array.isArray(r) ? r[0] : r) || {}, { status: "published" }); msg.textContent = "Published. Copy the link or send it to the client."; }
      catch (e) { msg.textContent = U && U.friendlyError ? U.friendlyError(e, { action: "publish the invitation" }) : "Couldn't publish the invitation."; }
      busy = false; paintActs(); paintLink(); note();
    }
    function note() { try { if (o.onChange) o.onChange(); } catch (e) {} }
    async function loadShare() {
      if (!open()) return; try { await B.links.studio(); } catch (e) {}
      try { if (B.quotes.linkState) { state = await B.quotes.linkState(o.id); paused = !!(state && state.links_paused); } } catch (e) { paused = false; }
      try { booklet = B.booklet && B.booklet.current ? await B.booklet.current(o.id) : null; bookletKnown = true; } catch (e) { booklet = null; bookletKnown = true; }
      paintShare(); note();
    }
    function refresh() { paintShare(); paintInvite(); loadShare(); loadSite(); }
    Promise.resolve().then(function () { return B.org.current(); }).then(function (x) { studio = String((x && x.name) || "").slice(0, 80); }).catch(function () {});
    paintShare(); paintInvite(); root.addEventListener("helm:booklet-link", function () { loadShare(); });
    // back from the full editor, or a change made on another tab / device
    var last = Date.now(), again = function () { if (doc.visibilityState === "hidden" || Date.now() - last < 5000) return; last = Date.now(); loadShare(); loadSite(); };
    doc.addEventListener("visibilitychange", again); root.addEventListener("pageshow", function (e) { if (e.persisted) { last = 0; again(); } });
    return { refresh: refresh, dirty: isDirty, save: save, discard: function () { if (saved) form = Object.assign({}, saved); }, reloadBooklet: loadShare,
      facts: function () { return { booklet: bookletKnown ? !!(booklet && booklet.token && !booklet.expired) : null, invite: siteKnown ? live() : null }; } };
  };
})(typeof window !== "undefined" ? window : globalThis);

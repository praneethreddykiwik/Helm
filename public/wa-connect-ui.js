/* wa-connect-ui.js - R129 (0337): the Integrations page's "Your WhatsApp number" card. A studio admin connects the studio's
   OWN WhatsApp Business number; every client / crew WhatsApp message of the studio then goes out from it (never from
   Helm's number). Steps on the card:
     1  Connect WhatsApp: WhatsApp Business Account ID + Phone number ID + permanent token (+ the number as clients see it)
        -> save_org_whatsapp_account (the token goes into the secure key store; never shown again, never logged)
        -> Check connection runs straight away.
     2  Check connection: the wa-connect edge function asks Meta and records Connected (name + number + quality) or the reason.
     3  Set up message templates: Helm creates its templates in the studio's account; Meta approves each (minutes to hours).
     4  Disconnect: removes the token, frees the number (another studio may connect it).
   Only the studio admin sees the card (my_integration_accounts.is_admin). Members see the status line on the page.
   CSP-safe: DOM via createElement / textContent only, no inline styles or handlers. Pure helpers exported for tests. */
(function (global) {
  "use strict";
  var DIGITS = /^[0-9]{5,30}$/;
  // template name -> what it is for (same order as the server catalogue, _shared/wa-studio.mjs)
  var TPL = [
    ["proposal_sent", "Proposal shared with the client"], ["proposal_reminder", "Proposal reminder"],
    ["proposal_approved_pay", "Approved - pay now"], ["payment_received", "Payment received"],
    ["proposal_approval_otp", "Approval code (6 digits)"], ["helm_notice", "Payment reminders, follow-ups, updates"],
    ["helm_task_assigned", "Crew messages (older one-line form)"], ["helm_event_reminder", "Event reminders"],
    // R130 (U-31): one fixed template per staff / vendor / office message, each with its own fields
    ["staff_task_assigned", "Task assigned"], ["staff_task_reminder", "Task reminder"], ["staff_task_overdue", "Task overdue"],
    ["staff_task_changed", "Task changed or removed (ready, not sent yet)"], ["staff_open_shift", "Open shift available"],
    ["staff_shift_result", "Shift confirmed or not given (ready, not sent yet)"], ["staff_leave_result", "Leave approved or declined (ready, not sent yet)"],
    ["office_staff_alert", "Staff alert to the office"], ["vendor_request", "Vendor request (ready, not sent yet)"],
    ["vendor_follow_up", "Vendor follow-up (ready, not sent yet)"], ["vendor_delivery_reminder", "Vendor delivery reminder (ready, not sent yet)"],
    ["vendor_invoice_update", "Vendor invoice update (ready, not sent yet)"], ["crew_runsheet_reminder", "Run-sheet reminder"]];
  var TPL_STATE = { APPROVED: "Approved", PENDING: "Waiting for Meta", IN_APPEAL: "Waiting for Meta", PENDING_DELETION: "Being removed",
    REJECTED: "Rejected", DISABLED: "Turned off by Meta", PAUSED: "Paused by Meta", LIMIT_EXCEEDED: "Limit reached" };

  // ---- pure helpers ---------------------------------------------------------------------------------------------
  // the card's state from my_integration_accounts().whatsapp: none | pending | error | connected | paused
  function stateOf(w) {
    if (!w || typeof w !== "object") return "none";
    if (w.status === "disabled") return w.phone_number_id ? "paused" : "none";
    if (w.status === "connected") return "connected";
    if (w.status === "error") return "error";
    return "pending";
  }
  function validate(v) {
    if (!DIGITS.test(String(v.wabaId || "").trim())) return "WhatsApp Business Account ID is a long number (WhatsApp Manager -> Account tools, or the app's API Setup page).";
    if (!DIGITS.test(String(v.phoneId || "").trim())) return "Phone number ID is a long number shown under your number on the app's API Setup page - not the phone number itself.";
    if (String(v.token || "").trim().length < 20) return "Paste the permanent System User access token (the 24-hour token on the API Setup page will stop working).";
    var d = String(v.disp || "").trim();
    if (d && !/^\+[0-9][0-9 ()-]{6,24}$/.test(d)) return "Type the number as clients see it, starting with + and the country code (or leave it empty).";
    return "";
  }
  function templateRows(states) {
    var s = states && typeof states === "object" ? states : {};
    return TPL.map(function (t) { var st = s[t[0]] ? String(s[t[0]]) : ""; return { name: t[0], use: t[1], state: st, label: st ? (TPL_STATE[st] || st.toLowerCase()) : "Not created yet" }; });
  }
  function templateLine(states) {
    var rows = templateRows(states), ok = 0, missing = 0, bad = 0;
    rows.forEach(function (r) { if (r.state === "APPROVED") ok++; else if (!r.state) missing++; else if (/^(REJECTED|DISABLED|PAUSED)$/.test(r.state)) bad++; });
    if (ok === rows.length) return { ready: true, text: "All " + rows.length + " message templates are approved. WhatsApp is ready." };
    if (missing === rows.length) return { ready: false, text: "No message templates yet. Press Set up message templates - Meta must approve them before clients get messages." };
    return { ready: false, text: ok + " of " + rows.length + " templates approved" + (missing ? ", " + missing + " not created" : "") + (bad ? ", " + bad + " rejected" : "") + "." };
  }
  function friendly(e) {
    if (e && e.cancelled) return "Not saved - this change needs your two-step code.";
    if (e && e.stepUp) return String(e.message || "");
    var m = String((e && (e.message || e.code)) || "");
    if (/vault_unavailable/.test(m)) return "Secure key storage is not switched on for this workspace yet. Ask Helm support.";
    if (/not_allowed|42501|only the studio admin/i.test(m)) return "Only the studio admin can change this.";
    if (/phone_in_use/.test(m)) return "That WhatsApp number is already connected to another studio.";
    if (/invalid_/.test(m)) return "Some details look wrong - please check and try again.";
    if (/HTTP 404|Failed to fetch|NetworkError|Load failed/i.test(m)) return "Helm's WhatsApp service isn't reachable yet. Try again in a minute.";
    return m ? m.replace(/\.$/, "") + "." : "Something went wrong. Try again.";
  }

  // ---- DOM ------------------------------------------------------------------------------------------------------
  var doc = global.document;
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function btn(text, cls) { var b = el("button", "btn" + (cls ? " " + cls : ""), text); b.type = "button"; return b; }
  function field(id, label, type, hint, attrs) {
    var w = el("div", "wac-f"), l = el("label", null, label); l.htmlFor = id; w.appendChild(l);
    var i = el("input"); i.id = id; i.type = type; i.autocomplete = type === "password" ? "new-password" : "off"; i.spellcheck = false;
    Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
    w.appendChild(i);
    if (hint) { var h = el("small", "itg-hint", hint); h.id = id + "_h"; i.setAttribute("aria-describedby", h.id); w.appendChild(h); }
    return { wrap: w, input: i };
  }
  function say(m, text, state) { m.textContent = text || ""; if (state) m.setAttribute("data-state", state); else m.removeAttribute("data-state"); }
  function confirmIt(text, opts) {
    try { if (global.BPUI && typeof global.BPUI.confirm === "function") return Promise.resolve(global.BPUI.confirm(text, opts)); } catch (e) {}
    return Promise.resolve(global.confirm ? global.confirm(text) : false);
  }

  function mount(container, opts) {
    var S = (opts && opts.store) || global.BPStore, I = S && S.integrations;
    if (!container || !I || typeof I.mine !== "function") { if (container) container.hidden = true; return Promise.resolve(false); }
    var onChange = (opts && typeof opts.onChange === "function") ? opts.onChange : function () {};
    var last = null;
    // ONE result line for the whole card: it survives the re-render after each step
    var msg = el("p", "itg-result"); msg.id = "wacMsg"; msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");

    function detailsForm(w, startOpen) {
      var box = el("details", "wac-form"); if (startOpen) box.open = true;
      box.appendChild(el("summary", null, w ? "Update the number or token" : "Enter your WhatsApp details"));
      var grid = el("div", "wac-grid");
      var a = field("wacWaba", "WhatsApp Business Account ID", "text", null, { inputmode: "numeric", maxlength: "30" });
      var p = field("wacPhone", "Phone number ID", "text", "Not the phone number - the long ID shown under it on the API Setup page.", { inputmode: "numeric", maxlength: "30" });
      var t = field("wacToken", "Permanent access token", "password", "System User token with whatsapp_business_messaging and whatsapp_business_management. Helm keeps it in its secure key store; it is never shown again.", { maxlength: "1000" });
      if (w && w.waba_id) a.input.value = String(w.waba_id);
      if (w && w.phone_number_id) p.input.value = String(w.phone_number_id);
      [a, p, t].forEach(function (f) { grid.appendChild(f.wrap); });
      box.appendChild(grid);
      var row = el("div", "itg-row"), save = btn(w ? "Save and check" : "Connect WhatsApp", "btn-pri"); save.id = "wacSave";
      row.appendChild(save); box.appendChild(row);
      var m = msg;
      save.addEventListener("click", function () {
        var v = { wabaId: a.input.value.trim(), phoneId: p.input.value.trim(), token: t.input.value.trim() };
        var bad = validate(v); if (bad) { say(m, bad, "off"); return; }
        save.disabled = true; say(m, "Saving...", "wait");
        // the number shown to clients comes from Meta during the check (wa_account_verified)
        I.saveWhatsapp({ p_waba_id: v.wabaId, p_phone_number_id: v.phoneId, p_token: v.token, p_display_phone: null })
          .then(function () { t.input.value = ""; say(m, "Saved. Checking the connection with Meta...", "wait"); return check(m); })
          .catch(function (e) { say(m, friendly(e), "off"); })
          .then(function () { save.disabled = false; });
      });
      return box;
    }

    function check(m) {
      return I.waConnect("verify").then(function (r) {
        if (r && r.ok) say(m, "Connected" + (r.verified_name ? " as " + r.verified_name : "") + (r.display_phone ? " (" + r.display_phone + ")" : "") + "." + (r.webhook ? "" : " Delivery ticks and STOP replies need Helm's Meta app on your account - ask Helm support."), "on");
        else say(m, "Not connected: " + friendly({ message: (r && r.error) || "the check failed" }), "off");
        return render();
      }).catch(function (e) { say(m, friendly(e), "off"); return render(); });
    }

    function templatesBlock(w, m) {
      var box = el("div", "wac-tpl");
      box.appendChild(el("h4", null, "Message templates"));
      var line = templateLine(w.templates);
      box.appendChild(el("p", "itg-note", line.text));
      var tbl = el("table", "itg-tbl wac-tbl"), th = el("thead"), tr = el("tr");
      ["Template", "Used for", "State"].forEach(function (h) { var c = el("th", null, h); c.scope = "col"; tr.appendChild(c); });
      th.appendChild(tr); tbl.appendChild(th);
      var tb = el("tbody");
      templateRows(w.templates).forEach(function (r) {
        var row = el("tr"), c1 = el("td"), code = el("code", null, r.name); c1.appendChild(code); row.appendChild(c1);
        row.appendChild(el("td", null, r.use));
        var c3 = el("td"), chip = el("span", "wac-chip", r.label); chip.setAttribute("data-state", r.state === "APPROVED" ? "on" : r.state ? (/^(REJECTED|DISABLED|PAUSED)$/.test(r.state) ? "off" : "wait") : "none");
        c3.appendChild(chip); row.appendChild(c3); tb.appendChild(row);
      });
      tbl.appendChild(tb);
      var sc = el("div", "itg-scroll"); sc.appendChild(tbl); box.appendChild(sc);
      var row2 = el("div", "itg-row");
      var anyMissing = templateRows(w.templates).some(function (r) { return !r.state; });
      var setup = btn(anyMissing ? "Set up message templates" : "Refresh template states", anyMissing ? "btn-pri" : ""); setup.id = "wacTpl";
      row2.appendChild(setup); box.appendChild(row2);
      setup.addEventListener("click", function () {
        setup.disabled = true; say(m, anyMissing ? "Creating the templates in your WhatsApp account (this can take a minute)..." : "Asking Meta...", "wait");
        I.waConnect(anyMissing ? "templates" : "status").then(function (r) {
          var f = r && Array.isArray(r.failed) ? r.failed.length : 0;
          say(m, (r && r.ok ? (anyMissing ? (Number(r.created) || 0) + " template(s) sent to Meta for review." + (f ? " " + f + " could not be created - try again later." : "") + " Approval usually takes minutes to a few hours." : "Template states updated.") : friendly({ message: r && r.error })), r && r.ok && !f ? "on" : "off");
          return render();
        }).catch(function (e) { say(m, friendly(e), "off"); }).then(function () { setup.disabled = false; });
      });
      return box;
    }

    function render() {
      return Promise.resolve().then(function () { return I.mine(); }).catch(function () { return null; }).then(function (M) {
        clear(container);
        if (!M || M.is_admin !== true) { container.hidden = true; return false; }
        container.hidden = false;
        var w = M.whatsapp || null, st = stateOf(w);
        last = { state: st, w: w }; try { onChange(last); } catch (e) {}
        container.appendChild(el("h4", "wac-h", "Your WhatsApp number"));
        var lead = el("p", "itg-note");
        lead.textContent = "Connect your studio's own WhatsApp Business number. Proposals, approval codes, reminders and crew assignments then go out from your number, with your name - never from Helm's.";
        container.appendChild(lead);
        var m = msg;
        var stLine = el("p", "wac-status");
        if (st === "connected") stLine.textContent = "Connected" + (w.verified_name ? ": " + w.verified_name : "") + (w.display_phone ? " - " + w.display_phone : "") + (w.quality ? " - quality " + String(w.quality).toLowerCase() : "") + ".";
        else if (st === "pending") stLine.textContent = "Saved, not checked yet. Press Check connection.";
        else if (st === "error") stLine.textContent = "Needs attention: " + (w.last_error || "the last check failed") + ".";
        else if (st === "paused") stLine.textContent = "Paused - nothing is sent from this number.";
        else stLine.textContent = "Not connected yet.";
        stLine.setAttribute("data-state", st);
        container.appendChild(stLine);
        if (st !== "none") {
          var row = el("div", "itg-row");
          var chk = btn("Check connection", st === "connected" ? "" : "btn-pri"); chk.id = "wacCheck";
          chk.addEventListener("click", function () { chk.disabled = true; say(m, "Checking with Meta...", "wait"); check(m).then(function () { chk.disabled = false; }); });
          var dis = btn("Disconnect", "wac-danger"); dis.id = "wacDisconnect";
          dis.addEventListener("click", function () {
            confirmIt("Your studio stops sending WhatsApp messages. Helm removes the saved token and frees the number, so it can be connected again later (here or to another studio).",
              { title: "Disconnect WhatsApp?", okLabel: "Disconnect", danger: true }).then(function (ok) {
              if (!ok) return;
              dis.disabled = true; say(m, "Disconnecting...", "wait");
              return I.waDisconnect().then(function () { say(m, "Disconnected. Nothing is sent on WhatsApp from your studio now.", "on"); return render(); })
                .catch(function (e) { say(m, friendly(e), "off"); dis.disabled = false; });
            });
          });
          row.appendChild(chk); row.appendChild(dis); container.appendChild(row);
        }
        if (st === "connected") container.appendChild(templatesBlock(w, m));
        container.appendChild(detailsForm(st === "none" ? null : w, st === "none"));
        container.appendChild(m);
        return true;
      });
    }
    return render();
  }

  var api = { mount: mount, stateOf: stateOf, validate: validate, templateRows: templateRows, templateLine: templateLine, friendly: friendly, TEMPLATES: TPL };
  global.HelmWaConnect = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

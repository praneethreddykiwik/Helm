/* wa-connect-ui.js - R129 (0337): the Integrations page's "Your WhatsApp number" card. A studio admin connects the studio's
   OWN WhatsApp Business number; every client / crew WhatsApp message of the studio then goes out from it (never from
   Helm's number). Steps on the card:
     1  Connect WhatsApp: WhatsApp Business Account ID + Phone number ID + permanent token (+ the number as clients see it)
        -> save_org_whatsapp_account (the token goes into the secure key store; never shown again, never logged)
        -> Check connection runs straight away.
     2  Check connection: the wa-connect edge function asks Meta and records Connected (name + number + quality) or the reason.
     3  Set up message templates: Helm creates its templates in the studio's account; Meta approves each (minutes to hours).
     4  Disconnect: removes the token, frees the number (another studio may connect it).
   R154h (0353): the two IDs are not secret - "Save details" keeps them (save_org_whatsapp_account with no token) and
     Connect saves them first too, so they are pre-filled every time the page opens, whatever happens next. The token is
     secret: it goes only into save_org_whatsapp_account (secure key store), is never sent back (the page learns only
     token_saved yes / no) and never goes to localStorage / sessionStorage / the URL / a log. A token Meta then refuses
     stays in the key store marked "not connected" (status error) - never used to send; a token the SAVE refused is kept
     only in this page and the card says plainly it was NOT saved. Typed but unsaved boxes ask before leaving the page.
   R156 (0354): Set up message templates runs in the BACKGROUND: the button queues the missing templates and the card says
     "Setup is running in the background - you can leave this page; we'll notify you" with live progress (my_wa_template_setup
     every 20 s while it runs); one bell notice when Meta is done. Each row shows Meta's real reason in plain words, a
     rejected / failed one has Fix and resubmit; a category change (utility -> marketing) and the number's health (quality
     rating, messaging limit, payment / send problems) are warned about. The approval-code template on an unverified business
     says: verify your business in Meta Business Manager - approval codes go by e-mail meanwhile.
   Only the studio admin sees the card (my_integration_accounts.is_admin). Members see the status line on the page.
   CSP-safe: DOM via createElement / textContent only, no inline styles or handlers. Pure helpers exported for tests. */
(function (global) {
  "use strict";
  var DIGITS = /^[0-9]{5,30}$/;
  var POLL_MS = 20000;
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
  // R154h: the IDs alone (Save details); a token is optional here but, when typed, must look like one
  function validateIds(v) {
    if (!DIGITS.test(String(v.wabaId || "").trim())) return "WhatsApp Business Account ID is a long number (WhatsApp Manager -> Account tools, or the app's API Setup page).";
    if (!DIGITS.test(String(v.phoneId || "").trim())) return "Phone number ID is a long number shown under your number on the app's API Setup page - not the phone number itself.";
    var tk = String(v.token || "").trim();
    if (tk && tk.length < 20) return "Paste the permanent System User access token (the 24-hour token on the API Setup page will stop working).";
    return "";
  }
  // is a token in the secure key store? 0353 says so (token_saved); an older server: every pending / connected / error
  // (or paused) row was saved WITH a token
  function tokenSaved(w) {
    if (!w || typeof w !== "object") return false;
    if (typeof w.token_saved === "boolean") return w.token_saved;
    if (w.status === "disabled") return !!w.phone_number_id;
    return /^(pending|connected|error)$/.test(String(w.status || ""));
  }
  // the card's one status line
  function statusLine(w) {
    var st = stateOf(w);
    if (st === "connected") return "Connected as " + (w.display_phone || "your number") + (w.verified_name ? " (" + w.verified_name + ")" : "") + (w.quality ? " - quality " + String(w.quality).toLowerCase() : "") + ".";
    if (st === "paused") return "Paused - nothing is sent from this number.";
    if (st === "none") return w && w.waba_id ? "Not connected. Your WhatsApp Business Account ID is still saved below." : "Not connected yet.";
    if (!tokenSaved(w)) return "Saved - not connected yet (reason: the access token is not saved yet). Paste it below and press Connect WhatsApp.";
    if (st === "error") return "Saved - not connected yet (reason: " + String(w.last_error || "the last check failed").replace(/\.$/, "") + ").";
    return "Saved - not connected yet (reason: the connection has not been checked). Press Check connection.";
  }
  // what to do about a check that failed (wa-connect "code"); codes only, never a secret
  var CODE_HELP = {
    token: "Meta refused the access token (expired, removed, or the 24-hour test token). Make a permanent System User token and press Replace token.",
    permission: "The token is missing a permission. Generate it again with whatsapp_business_messaging and whatsapp_business_management ticked, then Replace token.",
    number: "Meta does not know that Phone number ID. Copy it again from WhatsApp -> API Setup: the long ID under the number, not the phone number.",
    waba: "Meta does not know that WhatsApp Business Account ID (or the token cannot see it). Copy it from WhatsApp Manager -> Account tools.",
    not_in_account: "That Phone number ID belongs to another WhatsApp Business Account. Use two IDs from the same account.",
    limit: "Meta is limiting requests right now. Try again in a few minutes.",
    timeout: "Meta did not answer in time. Nothing changed - try again.",
    details_missing: "Save the two IDs and the access token first.",
  };
  function codeHelp(code) { return CODE_HELP[String(code || "")] || ""; }
  // typed but not saved yet? (the token box counts as soon as anything is in it)
  function isDirty(saved, cur) {
    var sw = String((saved && saved.waba_id) || ""), sp = String((saved && saved.phone_number_id) || "");
    return String(cur.wabaId || "").trim() !== sw || String(cur.phoneId || "").trim() !== sp || String(cur.token || "").trim() !== "";
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
  // ---- R156: background setup, reasons, health ----------------------------------------------------------------------
  var BG_TEXT = "Setup is running in the background \u2014 you can leave this page; we'll notify you.";
  var OTP_VERIFY = "Verify your business in Meta Business Manager \u2014 approval codes go by e-mail meanwhile.";
  var REASON = {
    ratio: "Meta said the message has too many blanks for its length. Helm's wording is fixed - press Fix and resubmit.",
    edge_variable: "Meta said the message starts or ends with a blank. Press Fix and resubmit.",
    too_long: "Meta said the message is too long. Press Fix and resubmit.",
    format: "Meta did not accept the template format. Press Fix and resubmit.",
    auth_not_eligible: OTP_VERIFY,
    rate_limit: "Meta is limiting template changes for a while. Helm waits and tries again by itself.",
    token: "The access token stopped working. Paste a new permanent token, then press Check connection.",
    permission: "The token is missing the whatsapp_business_management permission. Make a new token with it.",
    other: "Meta refused it. Helm tries again by itself; if it stays like this press Fix and resubmit.",
  };
  // Meta's own rejection reasons (rejected_reason) in plain words
  var REJECTED = { INVALID_FORMAT: "the format is not allowed", ABUSIVE_CONTENT: "Meta thinks the content breaks its rules",
    INCORRECT_CATEGORY: "Meta thinks the category is wrong", TAG_CONTENT_MISMATCH: "the wording does not match the category",
    SCAM: "Meta flagged it as a possible scam", PROMOTIONAL: "Meta thinks it is promotional (marketing)", NONE: "" };
  function jobsByName(setup) {
    var m = {};
    (setup && Array.isArray(setup.jobs) ? setup.jobs : []).forEach(function (j) { if (j && j.name && (!j.language || j.language === "en")) m[j.name] = j; });
    return m;
  }
  // one row's plain reason (empty = nothing to say)
  function reasonOf(name, j) {
    if (!j) return "";
    var e = j.error && typeof j.error === "object" ? j.error : null;
    if (name === "proposal_approval_otp" && e && e.reason === "auth_not_eligible") return OTP_VERIFY;
    if (j.state === "rejected") {
      var rr = String(j.rejected_reason || "").toUpperCase(), w = Object.prototype.hasOwnProperty.call(REJECTED, rr) ? REJECTED[rr] : String(j.rejected_reason || "").toLowerCase().replace(/_/g, " ");
      return "Rejected by Meta" + (w ? ": " + w : "") + ". Press Fix and resubmit, or appeal in WhatsApp Manager.";
    }
    if (j.state === "failed" || (j.state === "queued" && e)) {
      var base = REASON[(e && e.reason) || "other"] || REASON.other;
      var meta = e && (e.title || e.message) ? " Meta: " + String(e.title || e.message).slice(0, 160) + (e.code ? " (code " + e.code + (e.subcode ? "/" + e.subcode : "") + ")" : "") : "";
      return (j.state === "queued" ? "Will try again by itself. " : "") + base + meta;
    }
    if (j.state === "paused" || j.state === "disabled") return "Meta " + (j.state === "paused" ? "paused" : "turned off") + " this template (low quality from replies). Press Fix and resubmit or check WhatsApp Manager.";
    return "";
  }
  var canResubmit = function (j) { return !!j && /^(rejected|failed|paused)$/.test(String(j.state || "")); };
  // utility -> marketing and the like (Meta moves templates by itself since April 2025)
  function categoryNote(name, j) {
    if (!j || !j.prev_category || !j.category || j.prev_category === j.category) return "";
    return "Meta moved " + name + " from " + String(j.prev_category).toLowerCase() + " to " + String(j.category).toLowerCase() +
      (j.category === "MARKETING" ? " - marketing messages cost more and need opt-in." : ".");
  }
  // live progress of the background setup
  function progressLine(setup) {
    var jobs = setup && Array.isArray(setup.jobs) ? setup.jobs.filter(function (j) { return j.in_round; }) : [];
    if (!jobs.length) return "";
    var c = { creating: 0, pending: 0, approved: 0, bad: 0 };
    jobs.forEach(function (j) {
      if (j.state === "queued" || j.state === "creating") c.creating++; else if (j.state === "pending") c.pending++;
      else if (j.state === "approved") c.approved++; else c.bad++;
    });
    return c.approved + " of " + jobs.length + " approved" + (c.pending ? ", " + c.pending + " waiting for Meta" : "") +
      (c.creating ? ", " + c.creating + " being sent to Meta" : "") + (c.bad ? ", " + c.bad + " need attention" : "") + ".";
  }
  // the number's health -> warning lines
  function healthLines(h) {
    if (!h || typeof h !== "object") return [];
    var out = [], w = Array.isArray(h.warnings) ? h.warnings : [];
    if (w.indexOf("quality_red") >= 0) out.push("Quality rating is RED: Meta may lower your daily limit or stop the number. Send fewer messages and only to people who agreed.");
    else if (w.indexOf("quality_yellow") >= 0) out.push("Quality rating is YELLOW: some people blocked or reported your messages.");
    if (w.indexOf("payment") >= 0) out.push("Meta has no working payment method for this WhatsApp account - add one in WhatsApp Manager -> Payment settings, or messages stop.");
    if (w.indexOf("limit_low") >= 0) out.push("Daily messaging limit is low (" + String(h.tier || "").replace("TIER_", "") + " people a day). Verify your business in Meta to raise it.");
    if (w.indexOf("blocked") >= 0) out.push("Meta is blocking sends from this number right now" + (Array.isArray(h.errors) && h.errors[0] ? ": " + String(h.errors[0]) : "") + ".");
    return out;
  }
  // the answer to Set up message templates (background, or an older server that created them in the request)
  function setupResultText(r) {
    if (!r || !r.ok) return "";
    if (r.background) return (Number(r.queued) ? Number(r.queued) + " template(s) queued. " : "") + BG_TEXT + " Meta usually approves within a few hours.";
    var f = Array.isArray(r.failed) ? r.failed : [];
    var txt = (Number(r.created) || 0) + " template(s) sent to Meta for review. Approval usually takes minutes to a few hours.";
    if (f.length) txt += " " + f.length + " not accepted by Meta: " + f.map(function (x) {
      if (typeof x === "string") return x;
      var why = x && x.name === "proposal_approval_otp" && x.reason === "auth_not_eligible" ? OTP_VERIFY : (REASON[(x && x.reason) || "other"] || REASON.other);
      return x.name + " (" + why.replace(/\.$/, "") + ")";
    }).join("; ") + ".";
    return txt;
  }

  function friendly(e) {
    if (e && e.cancelled) return "Not saved - this change needs your two-step code.";
    if (e && e.stepUp) return String(e.message || "");
    var m = String((e && (e.message || e.code)) || "");
    if (/vault_unavailable/.test(m)) return "Secure key storage is not switched on for this workspace yet. Ask Helm support.";
    if (/not_allowed|42501|only the studio admin/i.test(m)) return "Only the studio admin can change this.";
    if (/phone_in_use/.test(m)) return "That WhatsApp number is already connected to another studio.";
    if (/invalid_token/.test(m)) return "The access token looks too short - paste the whole permanent System User token.";
    if (/invalid_waba_id/.test(m)) return "WhatsApp Business Account ID is a long number - please check it.";
    if (/invalid_phone_number_id/.test(m)) return "Phone number ID is a long number (not the phone number) - please check it.";
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

  // one "unsaved changes" guard for the card: the shared BPUI tracker (beforeunload + in-app links ask first), or a
  // plain beforeunload when BPUI is not there. Nothing typed is stored anywhere - only "is it dirty?".
  var fallbackDirty = false, fallbackHooked = false;
  function makeGuard() {
    var U = global.BPUI;
    if (U && typeof U.trackDirty === "function") { try { return U.trackDirty(); } catch (e) {} }
    if (!fallbackHooked && global.addEventListener) {
      fallbackHooked = true;
      global.addEventListener("beforeunload", function (e) { if (fallbackDirty) { e.preventDefault(); e.returnValue = ""; return ""; } });
    }
    return { mark: function () { fallbackDirty = true; }, clean: function () { fallbackDirty = false; }, isDirty: function () { return fallbackDirty; }, dispose: function () { fallbackDirty = false; } };
  }

  function mount(container, opts) {
    var S = (opts && opts.store) || global.BPStore, I = S && S.integrations;
    if (!container || !I || typeof I.mine !== "function") { if (container) container.hidden = true; return Promise.resolve(false); }
    var onChange = (opts && typeof opts.onChange === "function") ? opts.onChange : function () {};
    var last = null, guard = null;
    // ONE result line for the whole card: it survives the re-render after each step
    var msg = el("p", "itg-result"); msg.id = "wacMsg"; msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");

    function twoStepNote() {
      var n = el("p", "itg-note"); n.id = "wac2fa"; n.hidden = true;
      n.appendChild(doc.createTextNode("Saving WhatsApp details needs two-step sign-in on your account. "));
      var b = btn("Set up two-step"); b.id = "wac2faBtn"; n.appendChild(b);
      b.addEventListener("click", function () {
        var A = global.HelmAuthUI;
        if (A && A.openTwoStepSetup) {
          Promise.resolve(A.openTwoStepSetup({ reason: "Saving WhatsApp details needs two-step sign-in. Set it up now (about 2 minutes), then save again.", doneLabel: "Back to WhatsApp" }))
            .then(function (on) { if (on === true) { n.hidden = true; say(msg, "Two-step is on. Press Save details or Connect WhatsApp again.", "on"); } }, function () {});
        } else if (A && A.openAccount) A.openAccount({ section: "settings", focus: "mfa" });
      });
      return n;
    }

    function detailsForm(w) {
      var hasTok = tokenSaved(w), st = stateOf(w);
      var box = el("details", "wac-form"); box.open = st !== "connected";
      box.appendChild(el("summary", null, st === "connected" ? "Update the number or token" : "Enter your WhatsApp details"));
      var grid = el("div", "wac-grid");
      var a = field("wacWaba", "WhatsApp Business Account ID", "text", null, { inputmode: "numeric", maxlength: "30" });
      var p = field("wacPhone", "Phone number ID", "text", "Not the phone number - the long ID shown under it on the API Setup page.", { inputmode: "numeric", maxlength: "30" });
      var t = field("wacToken", "Permanent access token", "password", "System User token with whatsapp_business_messaging and whatsapp_business_management. Helm keeps it in its secure key store; it is never shown again.", { maxlength: "1000" });
      // the two IDs are not secret: always pre-filled from the server (also after a Disconnect, when the WABA id stays)
      var saved = { waba_id: w && w.waba_id ? String(w.waba_id) : "", phone_number_id: w && w.phone_number_id ? String(w.phone_number_id) : "" };
      a.input.value = saved.waba_id; p.input.value = saved.phone_number_id;
      grid.appendChild(a.wrap); grid.appendChild(p.wrap);
      // the token: never sent back. Saved -> say so + Replace token; else the box
      var tokWrap = el("div", "wac-f"); tokWrap.id = "wacTokenSaved";
      if (hasTok) {
        tokWrap.appendChild(el("span", "wac-tok-l", "Permanent access token"));
        tokWrap.appendChild(el("p", "itg-note", "Token saved in Helm's secure key store. It is never shown again, not even in part."));
        var rep = btn("Replace token"); rep.id = "wacTokenReplace"; tokWrap.appendChild(rep);
        t.wrap.hidden = true;
        rep.addEventListener("click", function () { t.wrap.hidden = false; tokWrap.hidden = true; try { t.input.focus(); } catch (e) {} });
        grid.appendChild(tokWrap);
      }
      grid.appendChild(t.wrap);
      box.appendChild(grid);
      var note = twoStepNote(); box.appendChild(note);
      var row = el("div", "itg-row");
      var keep = btn("Save details"); keep.id = "wacKeep";
      var save = btn(st === "connected" ? "Save and check" : "Connect WhatsApp", "btn-pri"); save.id = "wacSave";
      row.appendChild(save); row.appendChild(keep); box.appendChild(row);
      var m = msg;

      if (guard) { try { guard.dispose(); } catch (e) {} }
      guard = makeGuard();
      var cur = function () { return { wabaId: a.input.value.trim(), phoneId: p.input.value.trim(), token: t.input.value.trim() }; };
      var sync = function () { if (isDirty(saved, cur())) guard.mark(); else guard.clean(); };
      [a, p, t].forEach(function (f) { f.input.addEventListener("input", sync); f.input.addEventListener("change", sync); });

      // the IDs first (kept whatever happens next), then the token when one was typed.
      // -> { tokenSaved: bool } or throws (with .idsSaved = true when only the token failed)
      function persist(v) {
        var ids = { p_waba_id: v.wabaId, p_phone_number_id: v.phoneId, p_token: null, p_display_phone: null };
        return I.saveWhatsapp(ids).then(function () {
          saved = { waba_id: v.wabaId, phone_number_id: v.phoneId }; sync();
          if (!v.token) return { tokenSaved: hasTok };
          return I.saveWhatsapp({ p_waba_id: v.wabaId, p_phone_number_id: v.phoneId, p_token: v.token, p_display_phone: null })
            .then(function () { t.input.value = ""; sync(); return { tokenSaved: true }; },
                  function (e) { e = e || {}; try { e.idsSaved = true; } catch (x) {} throw e; });
        }, function (e) {
          // a server without 0353 cannot keep the IDs alone: with a token, save all three in one go as before
          if (v.token && /invalid_token/.test(String((e && e.message) || ""))) {
            return I.saveWhatsapp({ p_waba_id: v.wabaId, p_phone_number_id: v.phoneId, p_token: v.token, p_display_phone: null })
              .then(function () { saved = { waba_id: v.wabaId, phone_number_id: v.phoneId }; t.input.value = ""; sync(); return { tokenSaved: true }; });
          }
          if (/invalid_token/.test(String((e && e.message) || ""))) { var x = new Error("Saving the IDs without the token needs the latest Helm update (APPLY-0353). Paste the token too and press Connect WhatsApp."); throw x; }
          throw e;
        });
      }
      function failed(e) {
        if (e && e.stepUp === "setup") note.hidden = false;
        if (e && e.idsSaved) say(m, "WhatsApp Business Account ID and Phone number ID saved. The access token was NOT saved: " + friendly(e) + " It is only in this page until you leave - fix it and press Connect WhatsApp again.", "off");
        else say(m, "Not saved: " + friendly(e), "off");
      }
      // changing what a WORKING connection uses pauses sending until the check passes - ask first
      function okToChange(v) {
        if (st !== "connected") return Promise.resolve(true);
        var idsChange = v.wabaId !== saved.waba_id || v.phoneId !== saved.phone_number_id;
        if (!idsChange && !v.token) return Promise.resolve(true);
        return confirmIt((idsChange ? "New IDs" : "A new token") + " must pass the connection check before WhatsApp messages go out again. Until then your studio sends no WhatsApp messages.",
          { title: "Change the connected WhatsApp?", okLabel: "Save" });
      }
      function busyAll(on) { save.disabled = on; keep.disabled = on; }

      keep.addEventListener("click", function () {
        var v = cur(), bad = validateIds(v); if (bad) { say(m, bad, "off"); return; }
        okToChange(v).then(function (ok) {
          if (!ok) return;
          busyAll(true); say(m, "Saving...", "wait");
          return persist(v).then(function (r) {
            say(m, r.tokenSaved ? "Saved. Press Check connection to connect it with Meta." : "Saved - not connected yet (reason: the access token is not saved yet). Paste it and press Connect WhatsApp.", "on");
            return render();
          }, failed);
        }).then(function () { busyAll(false); }, function () { busyAll(false); });
      });
      save.addEventListener("click", function () {
        var v = cur(), bad = validateIds(v);
        if (!bad && !v.token && !hasTok) bad = "Paste the permanent System User access token (the 24-hour token on the API Setup page will stop working).";
        if (bad) { say(m, bad, "off"); return; }
        okToChange(v).then(function (ok) {
          if (!ok) return;
          busyAll(true); say(m, "Saving...", "wait");
          return persist(v).then(function (r) {
            if (!r.tokenSaved) { say(m, "Saved - not connected yet (reason: the access token is not saved yet).", "off"); return render(); }
            say(m, "Saved. Checking the connection with Meta...", "wait"); return check(m);
          }, failed);
        }).then(function () { busyAll(false); }, function () { busyAll(false); });
      });
      return box;
    }

    function check(m) {
      return I.waConnect("verify").then(function (r) {
        if (r && r.ok) say(m, "Connected as " + (r.display_phone || "your number") + (r.verified_name ? " (" + r.verified_name + ")" : "") + "." + (r.webhook ? "" : " Delivery ticks and STOP replies need Helm's Meta app on your account - ask Helm support."), "on");
        else {
          var why = friendly({ message: (r && r.error) || "the check failed" }).replace(/\.$/, ""), help = codeHelp(r && r.code);
          say(m, "Saved - not connected yet (reason: " + why + ")." + (help ? " " + help : ""), "off");
        }
        return render();
      }).catch(function (e) {
        var help = /did not answer in time/i.test(String((e && e.message) || "")) ? codeHelp("timeout") : "";
        say(m, friendly(e) + (help ? " " + help : ""), "off"); return render();
      });
    }

    var pollGen = 0;
    function templatesBlock(w, m, setup) {
      var box = el("div", "wac-tpl");
      box.appendChild(el("h4", null, "Message templates"));
      var line = templateLine(w.templates);
      box.appendChild(el("p", "itg-note", line.text));
      var jobs = jobsByName(setup);
      if (setup && setup.running) {
        var bg = el("p", "itg-note wac-bg", BG_TEXT); bg.id = "wacBg"; bg.setAttribute("data-state", "wait"); box.appendChild(bg);
        var pl = progressLine(setup); if (pl) { var pr = el("p", "itg-note", pl); pr.id = "wacProgress"; pr.setAttribute("aria-live", "polite"); box.appendChild(pr); }
        if (setup.paused_until) box.appendChild(el("p", "itg-note", "Meta asked Helm to slow down - setup continues by itself after a short pause."));
      }
      healthLines(setup && setup.health).forEach(function (t) { var p = el("p", "itg-note wac-warn", t); p.setAttribute("data-state", "off"); box.appendChild(p); });
      var tbl = el("table", "itg-tbl wac-tbl"), th = el("thead"), tr = el("tr");
      ["Template", "Used for", "State"].forEach(function (h) { var c = el("th", null, h); c.scope = "col"; tr.appendChild(c); });
      th.appendChild(tr); tbl.appendChild(th);
      var tb = el("tbody");
      templateRows(w.templates).forEach(function (r) {
        var j = jobs[r.name];
        var row = el("tr"), c1 = el("td"), code = el("code", null, r.name); c1.appendChild(code); row.appendChild(c1);
        row.appendChild(el("td", null, r.use));
        var c3 = el("td"), label = r.label, st = r.state;
        if (j && (j.state === "queued" || j.state === "creating") && !r.state) label = "Being sent to Meta";
        if (j && j.state === "failed" && !r.state) { label = "Not accepted"; st = "REJECTED"; }
        var chip = el("span", "wac-chip", label); chip.setAttribute("data-state", st === "APPROVED" ? "on" : st ? (/^(REJECTED|DISABLED|PAUSED)$/.test(st) ? "off" : "wait") : (j && /^(queued|creating)$/.test(j.state) ? "wait" : "none"));
        c3.appendChild(chip);
        var why = reasonOf(r.name, j), cn = categoryNote(r.name, j);
        if (why) { var ws = el("small", "itg-hint wac-why", why); c3.appendChild(ws); }
        if (cn) { var cs = el("small", "itg-hint wac-why", cn); cs.setAttribute("data-state", "off"); c3.appendChild(cs); }
        if (canResubmit(j)) {
          var rb = btn("Fix and resubmit"); rb.id = "wacFix_" + r.name; c3.appendChild(rb);
          rb.addEventListener("click", function () {
            rb.disabled = true; say(m, "Sending the fixed wording to Meta in the background...", "wait");
            I.waResubmit(r.name).then(function (x) {
              say(m, x && x.ok ? r.name + ": resubmitted. " + BG_TEXT : friendly({ message: x && x.error }), x && x.ok ? "on" : "off");
              return render();
            }).catch(function (e) { say(m, friendly(e), "off"); rb.disabled = false; });
          });
        }
        row.appendChild(c3); tb.appendChild(row);
      });
      tbl.appendChild(tb);
      var sc = el("div", "itg-scroll"); sc.appendChild(tbl); box.appendChild(sc);
      var row2 = el("div", "itg-row");
      var anyMissing = templateRows(w.templates).some(function (r) { var j = jobs[r.name]; return !r.state && !(j && /^(queued|creating)$/.test(j.state)); });
      var setupBtn = btn(anyMissing ? "Set up message templates" : "Refresh template states", anyMissing ? "btn-pri" : ""); setupBtn.id = "wacTpl";
      row2.appendChild(setupBtn); box.appendChild(row2);
      setupBtn.addEventListener("click", function () {
        setupBtn.disabled = true; say(m, anyMissing ? "Starting the setup..." : "Asking Meta...", "wait");
        I.waConnect(anyMissing ? "templates" : "status").then(function (r) {
          var txt = r && r.ok ? (anyMissing ? setupResultText(r) : "Template states updated.") : friendly({ message: r && r.error });
          var bad = r && Array.isArray(r.failed) && r.failed.length;
          say(m, txt, r && r.ok && !bad ? "on" : "off");
          return render();
        }).catch(function (e) { say(m, friendly(e), "off"); }).then(function () { setupBtn.disabled = false; });
      });
      // live progress while the background setup runs (stops when it is done or the card is re-drawn)
      if (setup && setup.running && typeof I.waSetup === "function" && global.setTimeout) {
        var gen = ++pollGen;
        global.setTimeout(function () {
          if (gen !== pollGen || !container.firstChild || container.hidden) return;
          render();
        }, POLL_MS);
      }
      return box;
    }

    var setup = null;
    function render() {
      pollGen++;
      return Promise.resolve().then(function () { return I.mine(); }).catch(function () { return null; }).then(function (M) {
        if (!M || M.is_admin !== true || !M.whatsapp || M.whatsapp.status !== "connected" || typeof I.waSetup !== "function") return [M, null];
        return Promise.resolve(I.waSetup()).catch(function () { return null; }).then(function (s2) { return [M, s2]; });
      }).then(function (pair) {
        var M = pair && pair[0]; setup = pair && pair[1];
        clear(container);
        if (guard) { try { guard.dispose(); } catch (e) {} guard = null; }
        if (!M || M.is_admin !== true) { container.hidden = true; return false; }
        container.hidden = false;
        var w = M.whatsapp || null, st = stateOf(w);
        last = { state: st, w: w }; try { onChange(last); } catch (e) {}
        container.appendChild(el("h4", "wac-h", "Your WhatsApp number"));
        var lead = el("p", "itg-note");
        lead.textContent = "Connect your studio's own WhatsApp Business number. Proposals, approval codes, reminders and crew assignments then go out from your number, with your name - never from Helm's.";
        container.appendChild(lead);
        var m = msg;
        var stLine = el("p", "wac-status"); stLine.id = "wacStatus";
        stLine.textContent = statusLine(w);
        stLine.setAttribute("data-state", st === "pending" && !tokenSaved(w) ? "pending" : st);
        container.appendChild(stLine);
        if (st !== "none") {
          var row = el("div", "itg-row");
          if (tokenSaved(w)) {
            var chk = btn("Check connection", st === "connected" ? "" : "btn-pri"); chk.id = "wacCheck";
            chk.addEventListener("click", function () { chk.disabled = true; say(m, "Checking with Meta...", "wait"); check(m).then(function () { chk.disabled = false; }); });
            row.appendChild(chk);
          }
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
          row.appendChild(dis); container.appendChild(row);
        }
        if (st === "connected") container.appendChild(templatesBlock(w, m, setup));
        container.appendChild(detailsForm(w));
        container.appendChild(m);
        return true;
      });
    }
    return render();
  }

  var api = { mount: mount, stateOf: stateOf, validate: validate, validateIds: validateIds, tokenSaved: tokenSaved, statusLine: statusLine, codeHelp: codeHelp, isDirty: isDirty, templateRows: templateRows, templateLine: templateLine, friendly: friendly, TEMPLATES: TPL,
    reasonOf: reasonOf, categoryNote: categoryNote, progressLine: progressLine, healthLines: healthLines, setupResultText: setupResultText,
    canResubmit: canResubmit, jobsByName: jobsByName, BG_TEXT: BG_TEXT, OTP_VERIFY: OTP_VERIFY };
  global.HelmWaConnect = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

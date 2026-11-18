/* reset-password.js — the "choose a new password" page (audit Phase 3-4 follow-up).
   Two ways in:
     1. the link from a "Forgot password?" email - /auth/confirm (?via=confirm, verified there, works in any
        browser) or the older PKCE ?code= link (same browser only) → "Set a new password" (New + Confirm, no
        current password) → every OTHER session is signed out → into the app. R204: a page opened from a reset
        link never shows the current-password form; a link that gave no reset session says why + "Send a new link";
        a different account signed in here is signed out first and the page says so (reset-link-core.js decides);
     2. Account → "Change password" (?mode=change, already signed in) → confirm the
        current password (+ CAPTCHA when on) → set a new one → other devices are
        signed out, this one stays signed in.
   Accounts with two-step verification enter their 6-digit code before the password
   can change (Supabase requires an aal2 session for that). External file — no
   inline script, so the hash-based CSP needs no change for this page's logic. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  // PKCE flow: the reset email link lands here as ?code=… (never tokens in the
  // fragment). store-api init exchanges it using the code verifier saved in the
  // browser that REQUESTED the reset; read the query BEFORE init cleans it up.
  // R204: read the link BEFORE store-api init cleans the address bar (reset-link-core.js decides the screen)
  var R = window.HelmResetLink;
  var LINK = R.parseLink(location.search || "", "");   // the #fragment is read by store-api only (error code / token type, then stripped)
  var recovering = false, cap = null;
  // the account /auth/confirm signed out of this browser for this link (one-shot, this tab only)
  var PREV = null;
  try { PREV = JSON.parse(sessionStorage.getItem("bp_reset_prev") || "null"); sessionStorage.removeItem("bp_reset_prev"); } catch (e) { PREV = null; }

  function show(id) { ["#vCurrent", "#vMfa", "#vSet", "#vDone", "#vLink"].forEach(function (s) { $(s).hidden = s !== id; }); }
  function err(t) { var e = $("#err"); e.textContent = t; e.hidden = !t; }
  function ok(t) { var e = $("#ok"); e.textContent = t; e.hidden = !t; }
  function sub(t) { $("#sub").textContent = t; }
  function note(t) { var e = $("#note"); e.textContent = t || ""; e.hidden = !t; }
  // a link that cannot be used: say why, one clear button to get a new one (never the change-password form)
  function deadLink(title, text) {
    $("#title").textContent = title; sub(text); show("#vLink");
    $("#toLogin").setAttribute("href", "login"); $("#toLogin").textContent = "← Back to sign in";
    setTimeout(function () { try { $("#newLink").focus(); } catch (e) {} }, 50);
  }
  function friendly(e, action) {
    if (e && (/^(mfa_invalid|bad_current_password|captcha_|rate_limited)/.test(e.code || "") ||
        /^(Too short|Add |Use at least|Include at least|Enter the 6-digit|Choose a password)/.test(e.message || ""))) return e.message;
    if (/captcha/i.test((e && e.message) || "")) return "The security check failed or expired — please try again.";
    return (window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: action }) : ((e && e.message) || "Something went wrong.");
  }
  function guard(btn, fn) { return (window.BPUI && BPUI.guard) ? BPUI.guard(btn, fn) : fn(); }

  async function needsCode() {
    try { var lv = await BPStore.auth.mfa.level(); return !!(lv && lv.nextLevel === "aal2" && lv.currentLevel !== "aal2"); }
    catch (e) { return false; }
  }
  async function toNewPassword() {
    if (await needsCode()) { show("#vMfa"); sub("Your account uses two-step verification. Enter your code to continue."); setTimeout(function () { $("#mfa_code").focus(); }, 50); return; }
    show("#vSet"); sub(recovering ? "Choose a new password for your Helm account." : "Enter your current password again, then choose your new one.");
    $("#setCurWrap").hidden = !!recovering;
    setTimeout(function () { (recovering ? $("#new_pw") : $("#set_cur_pw")).focus(); }, 50);
  }

  async function start() {
    await BPStore.init();
    if (!BPStore.auth.enabled()) { $("#title").textContent = "Password reset unavailable"; sub("Accounts aren't enabled in this environment."); return; }
    var A = BPStore.auth;
    if (A.linkFragmentToken && A.linkFragmentToken()) LINK.hashToken = true;
    var u = A.pendingUser();
    var realRecovery = u ? await A.isRecoverySession() : false;
    var prior = (A.linkPriorUser && A.linkPriorUser()) || null;
    if (PREV && PREV.email) prior = PREV;
    var d = R.decide({ link: LINK, linkError: A.linkError ? A.linkError() : "", user: u, recovery: realRecovery, prior: prior,
      pendingStep: A.pendingStep(), hasPassword: A.hasPassword ? A.hasPassword() : true });
    if (d.view !== "set" && PREV && PREV.email) note("You were signed out of " + PREV.email + " in this browser.");

    if (d.view === "set") {
      // only a session whose signed token / verified link says "reset" gets here (?code= alone is no proof)
      recovering = true;
      A.recovery.mark(u.id);   // until the new password is set, app pages in this browser come back here
      $("#acct_email").value = u.email || ""; $("#cur_email").value = u.email || "";   // R29b: password managers match the account
      $("#title").textContent = "Set a new password";
      if (d.switchedFrom) note("You were signed out of " + d.switchedFrom + " so you can reset the password for " + (u.email || "this account") + ".");
      await toNewPassword();
      return;
    }
    if (d.view === "expired") return deadLink("This link has expired", "Reset links work once and expire after an hour. Send yourself a new link and use the newest e-mail.");
    if (d.view === "wrong_browser") return deadLink("This link can't be used here",
      "It has already been used or has expired, or it was opened in a different browser from the one you asked for it in. Send yourself a new link and open it on this device.");
    if (d.view === "old_link") return deadLink("This link can't be used", "This reset link is in an old format Helm no longer accepts. Send yourself a new link.");
    if (d.view === "login_change") { location.replace("login?next=dashboard"); return; }
    if (d.view === "need_link") {
      return deadLink("Open the link from your email", "To reset your password, use the link we emailed you. No email? Send yourself a new link.");
    }
    if (d.view === "login") { location.replace("login"); return; }
    // ---- signed in, no reset link: the ordinary Account -> "Change password" (current password first)
    $("#acct_email").value = u.email || ""; $("#cur_email").value = u.email || "";
    if (d.staleRecovery) {
      // a stale / spoofed reset marker: fall back to the normal signed-in change flow
      A.recovery.clear();
      try { await A.resolveGate(); } catch (x) {}
      if (A.pendingStep()) { location.replace("login"); return; }
    }
    $("#title").textContent = "Change your password";
    $("#toLogin").setAttribute("href", "dashboard"); $("#toLogin").textContent = "← Back to Helm";
    if (d.view === "google_only") {
      // Google-only account: there is no Helm password to confirm or change
      sub("You sign in to Helm with Google, so there's no Helm password to change. Manage your password in your Google account.");
      return;
    }
    sub("Signed in as " + (u.email || "") + ". First confirm your current password.");
    show("#vCurrent");
    if (window.HelmAuthUI) cap = HelmAuthUI.mountCaptcha($("#captcha"), { action: "reauth" });
    setTimeout(function () { $("#cur_pw").focus(); }, 50);
  }

  $("#vCurrent").addEventListener("submit", function (e) {
    e.preventDefault();
    guard($("#cur_go"), async function () {
      err(""); ok("");
      if (!$("#cur_pw").value) { err("Enter your current password."); return; }
      if (cap && !cap.token()) { err("Please complete the security check."); return; }
      try {
        await BPStore.auth.reverifyPassword($("#cur_pw").value, { captchaToken: cap ? cap.token() : undefined });
        $("#cur_pw").value = "";
        await toNewPassword();
      } catch (x) { err(friendly(x, "check your password")); }
      finally { if (cap) cap.reset(); }
    });
  });

  $("#vMfa").addEventListener("submit", function (e) {
    e.preventDefault();
    guard($("#mfa_go"), async function () {
      err("");
      try { await BPStore.auth.mfa.challenge($("#mfa_code").value); await toNewPassword(); }
      catch (x) { err(friendly(x, "verify the code")); $("#mfa_code").select(); }
    });
  });

  if (BPStore.auth.passwordRule && BPStore.auth.passwordRule.attachChecklist) BPStore.auth.passwordRule.attachChecklist($("#new_pw"), $("#newRules"), { confirm: $("#new_pw2") });
  $("#vSet").addEventListener("submit", function (e) {
    e.preventDefault();
    guard($("#set_go"), async function () {
      err(""); ok("");
      var a = $("#new_pw").value, b = $("#new_pw2").value;
      var bad = BPStore.auth.passwordRule.problem(a);
      if (bad) { err(bad); $("#new_pw").focus(); return; }
      if (a !== b) { err("Passwords don't match. Try again."); $("#new_pw2").focus(); return; }
      // ordinary change: Supabase requires the current password (sent once, field cleared);
      // a reset-link (recovery) session needs none
      var opts = recovering ? undefined : { currentPassword: $("#set_cur_pw").value };
      if (opts && !opts.currentPassword) { err("Enter your current password."); $("#set_cur_pw").focus(); return; }
      try {
        await BPStore.auth.updatePassword(a, opts);   // also signs out every OTHER session
        $("#new_pw").value = ""; $("#new_pw2").value = "";
        if (recovering) {
          // R204: reset via email - every OTHER session was signed out (updatePassword); this one is
          // now an ordinary sign-in, so straight into the app (the sign-in page routes to the right home)
          BPStore.auth.recovery.clear();
          show("#vDone"); $("#title").textContent = "Password changed"; sub(""); note("");
          ok("Your new password is saved and your other devices were signed out. Opening Helm…");
          $("#doneLink").setAttribute("href", "login");
          location.replace("login");
          return;
        }
        show("#vDone"); $("#title").textContent = "Password changed";
        sub(""); ok("Your password was changed and your other devices were signed out.");
      } catch (x) { err(friendly(x, "save your new password")); if (x && x.field === "pw") { $("#new_pw").focus(); $("#new_pw").select(); } }   // r29: e.g. a too-common password - fields stay filled
      finally { $("#set_cur_pw").value = ""; if (opts) opts.currentPassword = null; }
    });
  });

  if (window.BPUI && BPUI.boot) BPUI.boot(start); else start();
})();

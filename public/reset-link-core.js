/* reset-link-core.js — R204: pure helpers for /reset-password. No DOM, no network.
   Reads what the reset link put in the address bar and decides which screen to show:
     "set"           a genuine reset-link (recovery) session  -> New + Confirm password, NO current password
     "expired"       the link was used / expired / refused     -> clear message + "Send a new link"
     "wrong_browser" a ?code= link that could not be turned into a reset session here
     "old_link"      a link carrying sign-in tokens in the #fragment (old e-mail format, never used)
     "need_link"     nobody signed in and no link              -> "use the link we e-mailed you"
     "login" / "login_change"  a sign-in step is pending / Change password while signed out
     "google_only"   signed in with Google only (no Helm password)
     "change"        Account -> "Change password": the current password is asked first
   The rule that fixes R204: a page opened FROM A RESET LINK never falls through to "change"
   (which asks for the current password the person has forgotten). If the link did not give this
   browser a reset session, the page says so and offers a new link instead.
   Shared by reset-password.js (browser) and test/r204-reset-link.test.mjs (node). */
(function (root) {
  "use strict";
  var CODE_RE = /^[a-z0-9_]{1,64}$/i;
  // short error codes that mean "this link can no longer be used"
  var DEAD_RE = /otp_expired|access_denied|link_failed|expired|invalid|flow_state|bad_code_verifier|already/i;

  function params(s) { try { return new URLSearchParams(String(s || "").replace(/^[?#]/, "")); } catch (e) { return new URLSearchParams(""); } }
  function shortCode(v) { v = String(v || ""); return CODE_RE.test(v) ? v.toLowerCase() : (v ? "link_error" : ""); }

  // → { code, viaConfirm, modeChange, error, hashToken, hashType }
  //   code       ?code=… (PKCE link straight from Supabase)
  //   viaConfirm ?via=confirm (verified on /auth/confirm, the Helm e-mail template)
  //   error      short error code from ?error_code / ?error / #error_code / #error ("" = none).
  //              An error_description alone also counts (its text is never shown or kept).
  //   hashToken  the #fragment carries access_token= (implicit-flow link; Helm never accepts it)
  function parseLink(search, hash) {
    var q = params(search), h = params(hash);
    var err = shortCode(q.get("error_code") || q.get("error") || h.get("error_code") || h.get("error") || "");
    if (!err && (q.get("error_description") || h.get("error_description"))) err = "link_error";
    return {
      code: !!q.get("code"),
      viaConfirm: q.get("via") === "confirm",
      modeChange: q.get("mode") === "change",
      error: err,
      hashToken: !!h.get("access_token"),
      hashType: h.get("access_token") ? shortCode(h.get("type") || "") : "",
    };
  }

  function sameAccount(a, b) {
    if (!a || !b) return true;
    if (a.id && b.id) return a.id === b.id;
    return String(a.email || "").toLowerCase() === String(b.email || "").toLowerCase();
  }

  // ctx = { link: parseLink(), linkError: store-api linkError() (""), user: {id,email}|null,
  //         recovery: the session is a genuine reset session, prior: {id?,email} signed in before the link | null,
  //         pendingStep: store-api pendingStep() (null), hasPassword: account has a Helm password }
  // → { view, switchedFrom: e-mail of the account that was signed out for this link | "" }
  function decide(ctx) {
    var c = ctx || {}, link = c.link || parseLink("", ""), user = c.user || null;
    var le = String(c.linkError || "");
    var res = function (view, extra) { var r = { view: view, switchedFrom: "" }; if (extra) for (var k in extra) r[k] = extra[k]; return r; };
    // 1. a genuine reset session always wins: New + Confirm, never the current password
    if (user && c.recovery) {
      var p = c.prior;
      return res("set", { switchedFrom: (p && p.email && !sameAccount(p, user)) ? String(p.email) : "" });
    }
    // 2. the link itself says it failed (expired / used / refused)
    if (link.error || (le && le !== "pkce_exchange_failed" && DEAD_RE.test(le))) return res("expired");
    // 3. sign-in tokens in the fragment: never accepted (login CSRF) - ask for a fresh link
    if (link.hashToken) return res("old_link");
    // 4. opened from a reset link but no reset session came of it: NEVER the change-password form
    if (link.code) return res("wrong_browser");
    if (link.viaConfirm) return res("expired");
    // 5. no link
    if (!user) return res(link.modeChange ? "login_change" : "need_link");
    if (c.pendingStep && c.pendingStep !== "recovery") return res("login");
    if (c.hasPassword === false) return res("google_only");
    return res("change", { staleRecovery: c.pendingStep === "recovery" });
  }

  var api = { parseLink: parseLink, decide: decide, sameAccount: sameAccount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmResetLink = api;
})(typeof window !== "undefined" ? window : this);

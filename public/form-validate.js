/* =========================================================================
   HelmValidate — shared inline form validation (owner rules, Oct 2026).

   • Errors appear UNDER the field on blur — never while someone is first typing.
     Once a field has been left (or a submit was tried) it re-checks live, so the
     message disappears as soon as it is fixed.
   • States: default · focus · error (red border + icon + text) · success (green check).
   • Values are trimmed, inner spaces collapsed and any HTML stripped; e-mails are
     lower-cased. Names: letters, spaces, hyphens and apostrophes, max 50.
   • Required fields show " *"; optional ones "(optional)" (call markLabel).
   • Messages are polite and specific. Phones use HelmPhone (phone-input.js).

   HelmValidate.bind(input, {rule:"name"|"email"|"phone"|"text", label, required,
     mobile, max, msgEl, onChange}) → {check(force), reset(), clean()}
   HelmValidate.checkAll([binding…]) → first failing binding (focused) or null.
   R238: HelmValidate.emailSuggest(v) → "Did you mean" address or null (pure); HelmValidate.suggestEmail(input)
     shows it under the box (one tap to use it or keep what was typed).
   Pure rule functions (HelmValidate.rules.*) work in Node for unit tests.
   DOM via createElement + textContent only. CSS lives in theme.css (.fv-*).
   ========================================================================= */
(function (global) {
  "use strict";

  // r21 CodeQL: strip tags until nothing changes ("<scr<script>ipt>" can't re-form a tag), then drop stray < >
  function stripHtml(v) {
    var s = String(v == null ? "" : v), prev;
    do { prev = s; s = s.replace(/<[^>]*>/g, ""); } while (s !== prev);
    return s.replace(/[<>]/g, "");
  }
  function clean(v) { return stripHtml(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(); }

  // audit C (r218): + the joiners some Indian keyboards type inside a word (U+200C / U+200D) and initials with a full stop
  // ("K. Srinivas", "Ravi K.") - both were refused before
  var NAME_RE = /^[\p{L}\p{M}](?:[\p{L}\p{M}\u200C\u200D '’.-]*[\p{L}\p{M}.\u200C\u200D])?$/u;
  var EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:[a-z]{2,}|xn--[a-z0-9-]{2,59})$/;   // R238: + punycode endings (.xn--p1ai)

  /* ---- R238 (ACC-01 / SEC-05): "Did you mean ...@gmail.com?" ----------------------------------------------
     The standard inline suggestion: a faithful port of mailcheck.js 1.1.2 (Kicksend, MIT licence,
     https://github.com/mailcheck/mailcheck - the algorithm most sign-up forms use, also behind
     @zootools/email-spell-checker): sift4 string distance (max offset 5), thresholds domain 2 / second-level 2 /
     top-level 2, and mailcheck's DEFAULT domain / second-level / top-level lists exactly. The only additions are
     Indian providers + endings (marked "Helm:") so a correct Indian address is never "corrected".
     It only SUGGESTS: nothing is blocked or changed without a tap. Only "x@gmail" (no ending) is a hard error
     (missingTld, in rules.email) - as every major form does. */
  var MC_DOMAINS = ["msn.com", "bellsouth.net", "telus.net", "comcast.net", "optusnet.com.au", "earthlink.net", "qq.com", "sky.com",
    "icloud.com", "mac.com", "sympatico.ca", "googlemail.com", "att.net", "xtra.co.nz", "web.de", "cox.net", "gmail.com", "ymail.com",
    "aim.com", "rogers.com", "verizon.net", "rocketmail.com", "google.com", "optonline.net", "sbcglobal.net", "aol.com", "me.com",
    "btinternet.com", "charter.net", "shaw.ca",
    // Helm: providers our studios and their staff use
    "rediffmail.com", "yahoo.com", "yahoo.co.in", "hotmail.com", "outlook.com", "live.com", "outlook.in", "zohomail.in", "zoho.com", "protonmail.com"];
  var MC_SLDS = ["yahoo", "hotmail", "mail", "live", "outlook", "gmx",
    "rediffmail"];   // Helm
  var MC_TLDS = ["com", "com.au", "com.tw", "ca", "co.nz", "co.uk", "de", "fr", "it", "ru", "net", "org", "edu", "gov", "jp", "nl", "kr", "se",
    "eu", "ie", "co.il", "us", "at", "be", "dk", "hk", "es", "gr", "ch", "no", "cz", "in", "net", "net.au", "info", "biz", "mil", "co.jp",
    "sg", "hu", "uk",
    "co.in", "org.in", "net.in", "ac.in", "edu.in", "gov.in", "res.in", "ae", "events"];   // Helm: India / UAE endings + .events
  var MC_THRESH = { domain: 2, sld: 2, tld: 2 };
  // mailcheck's sift4Distance (maxOffset 5)
  function sift4(s1, s2, maxOffset) {
    if (maxOffset === undefined) maxOffset = 5;
    if (!s1 || !s1.length) return s2 ? s2.length : 0;
    if (!s2 || !s2.length) return s1.length;
    var l1 = s1.length, l2 = s2.length, c1 = 0, c2 = 0, lcss = 0, localCs = 0, trans = 0, offsetArr = [];
    while ((c1 < l1) && (c2 < l2)) {
      if (s1.charAt(c1) === s2.charAt(c2)) {
        localCs++;
        var isTrans = false, i = 0;
        while (i < offsetArr.length) {
          var ofs = offsetArr[i];
          if (c1 <= ofs.c1 || c2 <= ofs.c2) {
            isTrans = Math.abs(c2 - c1) >= Math.abs(ofs.c2 - ofs.c1);
            if (isTrans) trans++;
            else if (!ofs.trans) { ofs.trans = true; trans++; }
            break;
          } else if (c1 > ofs.c2 && c2 > ofs.c1) offsetArr.splice(i, 1);
          else i++;
        }
        offsetArr.push({ c1: c1, c2: c2, trans: isTrans });
      } else {
        lcss += localCs; localCs = 0;
        if (c1 !== c2) c1 = c2 = Math.min(c1, c2);
        for (var j = 0; j < maxOffset && (c1 + j < l1 || c2 + j < l2); j++) {
          if ((c1 + j < l1) && (s1.charAt(c1 + j) === s2.charAt(c2))) { c1 += j - 1; c2--; break; }
          if ((c2 + j < l2) && (s1.charAt(c1) === s2.charAt(c2 + j))) { c1--; c2 += j - 1; break; }
        }
      }
      c1++; c2++;
      if ((c1 >= l1) || (c2 >= l2)) { lcss += localCs; localCs = 0; c1 = c2 = Math.min(c1, c2); }
    }
    lcss += localCs;
    return Math.round(Math.max(l1, l2) - lcss + trans);
  }
  // mailcheck's findClosestDomain
  function closest(domain, list, threshold) {
    var min = Infinity, best = null;
    if (!domain || !list) return false;
    for (var i = 0; i < list.length; i++) {
      if (domain === list[i]) return domain;
      var d = sift4(domain, list[i]);
      if (d < min) { min = d; best = list[i]; }
    }
    return min <= threshold && best !== null ? best : false;
  }
  // mailcheck's splitEmail
  function splitEmail(email) {
    email = String(email == null ? "" : email).replace(/^\s*/, "").replace(/\s*$/, "");
    var parts = email.split("@");
    if (parts.length < 2) return false;
    for (var i = 0; i < parts.length; i++) if (parts[i] === "") return false;
    var domain = parts.pop(), dp = domain.split("."), sld = "", tld = "";
    if (dp.length === 0) return false;
    if (dp.length === 1) tld = dp[0];
    else { sld = dp[0]; for (var k = 1; k < dp.length; k++) tld += dp[k] + "."; tld = tld.substring(0, tld.length - 1); }
    return { topLevelDomain: tld, secondLevelDomain: sld, domain: domain, address: parts.join("@") };
  }
  // "x@gmail" / "x@gmail." / "x@b.c" - a domain with no ending (or a 1-letter one): the one hard error
  function missingTld(v) {
    var s = String(v == null ? "" : v).trim().toLowerCase(), at = s.lastIndexOf("@");
    if (at < 1 || at === s.length - 1 || s.indexOf("@") !== at) return false;
    var d = s.slice(at + 1).replace(/\.+$/, "");
    if (!/^[a-z0-9.-]+$/.test(d)) return false;
    var dot = d.lastIndexOf(".");
    return dot < 0 || d.length - dot - 1 < 2;
  }
  // mailcheck's suggest() -> the full suggested address, or null
  function emailSuggest(v) {
    var email = String(v == null ? "" : v).toLowerCase();
    var p = splitEmail(email); if (!p) return null;
    if (MC_SLDS.indexOf(p.secondLevelDomain) !== -1 && MC_TLDS.indexOf(p.topLevelDomain) !== -1) return null;
    var cd = closest(p.domain, MC_DOMAINS, MC_THRESH.domain);
    if (cd) return cd === p.domain ? null : p.address + "@" + cd;
    var csld = closest(p.secondLevelDomain, MC_SLDS, MC_THRESH.sld);
    var ctld = closest(p.topLevelDomain, MC_TLDS, MC_THRESH.tld);
    if (p.domain) {
      var dom = p.domain, changed = false;
      if (csld && csld !== p.secondLevelDomain) { dom = dom.replace(p.secondLevelDomain, csld); changed = true; }
      if (ctld && ctld !== p.topLevelDomain && p.secondLevelDomain !== "") { dom = dom.replace(new RegExp(p.topLevelDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), ctld); changed = true; }
      if (changed) return p.address + "@" + dom;
    }
    return null;
  }

  function lc(label) { return String(label || "this field").replace(/^./, function (c) { return c.toLowerCase(); }); }

  var rules = {
    // → {ok, value, error}
    name: function (v, o) {
      o = o || {}; var s = clean(v).replace(/’/g, "'");
      if (!s) return o.required ? { ok: false, error: "Please enter " + (o.article === false ? "" : "your ") + lc(o.label || "name") + "." } : { ok: true, value: "" };
      var max = o.max || 50;
      if ([...s].length > max) return { ok: false, error: "Please keep " + lc(o.label || "the name") + " to " + max + " characters or fewer." };
      if (!NAME_RE.test(s)) return { ok: false, error: "Names can use letters, spaces, hyphens (-), apostrophes (') and full stops (.) only." };
      if (/[-'.]{2,}|\s[-'.]|[-']\s/.test(s)) return { ok: false, error: "That doesn't look like a name — check the hyphens and apostrophes." };
      return { ok: true, value: s };
    },
    email: function (v, o) {
      o = o || {}; var s = clean(v).toLowerCase();
      if (!s) return o.required ? { ok: false, error: "Please enter your e-mail address." } : { ok: true, value: "" };
      // R238 (ACC-02): "x@gmail" - say what is missing instead of the generic line
      if (missingTld(s)) return { ok: false, error: "This e-mail address is missing its ending, like .com or .in" + (s.indexOf(".", s.indexOf("@")) < 0 ? " (for example " + s + ".com)." : "."), code: "no_tld" };
      if (s.length > 254 || !EMAIL_RE.test(s) || s.split("@")[0].length > 64 || /\.\./.test(s))
        return { ok: false, error: "Please enter an e-mail address like name@example.com." };
      return { ok: true, value: s };
    },
    text: function (v, o) {
      o = o || {}; var s = clean(v);
      if (!s) return o.required ? { ok: false, error: "Please enter " + lc(o.label) + "." } : { ok: true, value: "" };
      var max = o.max || 80;
      if ([...s].length > max) return { ok: false, error: "Please keep " + lc(o.label) + " to " + max + " characters or fewer." };
      return { ok: true, value: s };
    },
    phone: function (v, o) {
      o = o || {};
      var HP = global.HelmPhone;
      if (!HP) { var d = String(v || "").replace(/\D/g, ""); return !d ? (o.required ? { ok: false, error: "Please enter a phone number." } : { ok: true, value: "" }) : (d.length >= 7 && d.length <= 15 ? { ok: true, value: "+" + d } : { ok: false, error: "Phone numbers have 7–15 digits including the country code." }); }
      var r = (o.phone && o.phone.validate) ? o.phone.validate({ mobile: !!o.mobile, required: !!o.required })
        : HP.validate(v, { mobile: !!o.mobile, required: !!o.required, country: o.country });
      if (!r.ok && r.empty && o.required) return { ok: false, error: o.requiredMsg || ("Please enter " + (o.label ? "your " + lc(o.label) : "a phone number") + ".") };
      return r.ok ? { ok: true, value: r.e164 || "", shown: phoneShown(HP, r.e164) } : { ok: false, error: r.error };
    },
  };

  // R243 (P11 OPS-05): read the saved number back with its country ("Saved as +91 98765 43210 · India") so a wrong
  // country code is seen before WhatsApp / SMS go nowhere. Display only - the saved value stays E.164.
  function phoneShown(HP, e164) {
    if (!e164 || !HP || !HP.display) return "";
    try {
      var p = HP.parse ? HP.parse(e164) : null, c = p && HP.country ? HP.country(p.iso) : null;
      return "Saved as " + HP.display(e164) + (c && c.name ? " · " + c.name : "");
    } catch (e) { return ""; }
  }
  rules.phoneShown = function (e164) { return phoneShown(global.HelmPhone, e164); };

  var api = { rules: rules, clean: clean, stripHtml: stripHtml, emailSuggest: emailSuggest, missingTld: missingTld, _sift4: sift4 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") { global.HelmValidate = api; return; }

  var doc = document, n = 0;
  function el(tag, cls, text) { var x = doc.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
  function labelOf(input) {
    if (input.id) { var l = doc.querySelector('label[for="' + (global.CSS && CSS.escape ? CSS.escape(input.id) : input.id) + '"]'); if (l) return l; }
    return input.closest ? input.closest("label") : null;
  }
  // " *" for required, " (optional)" otherwise — idempotent
  function markLabel(input, required) {
    var lab = labelOf(input); if (!lab) return;
    var old = lab.querySelector(".req-star, .fv-opt"); if (old) old.remove();
    if (lab.textContent.indexOf("*") >= 0 && required) return;
    var s = required ? el("span", "req-star", " *") : el("span", "fv-opt", " (optional)");
    if (required) s.setAttribute("aria-hidden", "true");
    lab.appendChild(s);
    if (required) input.setAttribute("aria-required", "true");
  }

  function bind(input, opts) {
    var o = opts || {};
    if (!input) return null;
    if (input._fv) return input._fv;
    var rule = rules[o.rule] || rules.text;
    var box = o.box || (input.helmPhone ? input.helmPhone.wrap : input);
    var touched = false;
    var msg = o.msgEl;
    if (!msg) {
      msg = el("p", "fv-msg"); msg.id = (input.id || "fv" + (++n)) + "_fv";
      var after = box; after.parentNode.insertBefore(msg, after.nextSibling);
    }
    msg.classList.add("fv-msg"); if (!msg.id) msg.id = "fv" + (++n) + "_m";
    msg.setAttribute("aria-live", "polite");
    var desc = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (desc.indexOf(msg.id) < 0) { desc.push(msg.id); input.setAttribute("aria-describedby", desc.join(" ")); }
    if (typeof o.required === "boolean") markLabel(input, o.required);

    function req() { return typeof o.required === "function" ? !!o.required() : !!o.required; }
    function setState(state, text) {
      box.classList.toggle("fv-error", state === "error");
      box.classList.toggle("fv-ok", state === "ok");
      if (state === "error") input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
      while (msg.firstChild) msg.removeChild(msg.firstChild);
      if (state === "error" && text) { var ic = el("span", "fv-ic", "!"); ic.setAttribute("aria-hidden", "true"); msg.appendChild(ic); msg.appendChild(doc.createTextNode(text)); }
      // R243 (OPS-05): a valid phone shows how it was read (country + format), in the calm "ok" colour
      if (state === "ok" && text) msg.appendChild(doc.createTextNode(text));
      msg.classList.toggle("fv-readback", state === "ok" && !!text);
      msg.hidden = !(state === "error" || (state === "ok" && !!text));
    }
    // r20: a number box holding text the browser can't read as a number (badInput: "5e", "-7e") has value "" -
    // flag it instead of letting it pass as an empty (optional) field
    function bad() { return !!(input.validity && input.validity.badInput); }
    function run() {
      if (bad()) return { ok: false, error: "Enter a valid number." };
      return rule(input.value, { label: o.label, required: req(), mobile: o.mobile, max: o.max, phone: input.helmPhone, requiredMsg: o.requiredMsg, article: o.article });
    }
    function check(force) {
      if (force) touched = true;
      var r = run();
      if (!touched) { setState("none"); return r; }
      if (!r.ok) setState("error", r.error);
      else setState(r.value ? "ok" : "none", r.shown || "");
      return r;
    }
    // normalise what's in the box (trim / lower-case / strip HTML) — never for phones (HelmPhone formats itself)
    function tidy() {
      if (o.rule === "phone" || input.helmPhone) return;
      var r = run(); if (r.ok && r.value !== undefined && input.value !== r.value) input.value = r.value;
    }
    input.addEventListener("blur", function () {
      // the country list lives inside the phone wrapper: don't flag the field while it's in use
      setTimeout(function () {
        if (input.helmPhone && input.helmPhone.wrap.contains(doc.activeElement)) return;
        if (!touched && !String(input.value || "").trim() && !o.validateEmptyOnBlur && !bad()) return;   // tabbing past an empty field isn't an error yet
        touched = true; tidy(); check(); if (o.onChange) o.onChange();
      }, 0);
    });
    input.addEventListener("input", function () { if (touched) check(); if (o.onChange) o.onChange(); });
    input.addEventListener("change", function () { if (touched) check(); });
    var b = { input: input, box: box, msg: msg, check: check, reset: function () { touched = false; setState("none"); },
      value: function () { var r = run(); return r.ok ? r.value : null; },
      setError: function (t) { touched = true; setState(t ? "error" : "none", t); }, focus: function () { try { input.focus(); } catch (e) {} } };
    input._fv = b;
    setState("none");
    return b;
  }
  function checkAll(list) {
    var first = null;
    (list || []).forEach(function (b) { if (!b) return; var r = b.check(true); if (!r.ok && !first) first = b; });
    if (first) first.focus();
    return first;
  }
  /* R238: the "Did you mean ...?" line under an e-mail box. One tap on "Use ..." fixes the box; "Keep mine" hides it
     for that address. Shown when the box is left (never while typing). hold() is for the form's submit: the FIRST
     submit with a suggestion still showing stops once and points at it; the next submit goes ahead with what was
     typed - a valid unusual address is never blocked.
     suggestEmail(input, {after: element}) -> {update(), hold(), hide(), current()} */
  function suggestEmail(input, o) {
    o = o || {};
    if (!input) return null;
    if (input._fvs) return input._fvs;
    var box = el("p", "fv-suggest"); box.hidden = true; box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite");
    box.id = (input.id || "fv" + (++n)) + "_sg";
    var after = o.after || (input._fv && input._fv.msg) || input;
    if (after.parentNode) after.parentNode.insertBefore(box, after.nextSibling);
    var cur = null, held = null, kept = {};
    function hide() { box.hidden = true; cur = null; while (box.firstChild) box.removeChild(box.firstChild); }
    function show(sg, again) {
      while (box.firstChild) box.removeChild(box.firstChild);
      cur = sg;
      box.appendChild(doc.createTextNode("Did you mean "));
      box.appendChild(el("b", null, sg));
      box.appendChild(doc.createTextNode("?" + (again ? " Press the button again to keep what you typed." : "") + " "));
      var use = el("button", "fv-sg-use", "Use this"); use.type = "button";
      use.setAttribute("aria-label", "Use " + sg);
      var keep = el("button", "fv-sg-keep", "Keep mine"); keep.type = "button";
      use.addEventListener("click", function () {
        input.value = sg; hide();
        ["input", "change"].forEach(function (t) { try { input.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
        try { input.focus(); } catch (e) {}
      });
      keep.addEventListener("click", function () { kept[String(input.value).trim().toLowerCase()] = 1; hide(); try { input.focus(); } catch (e) {} });
      box.appendChild(use); box.appendChild(doc.createTextNode(" ")); box.appendChild(keep);
      box.hidden = false;
    }
    function update(again) {
      var v = String(input.value || "").trim().toLowerCase();
      var sg = v && !kept[v] && !input.readOnly && !input.disabled ? emailSuggest(v) : null;
      if (sg) show(sg, again); else hide();
      return sg;
    }
    input.addEventListener("blur", function () { setTimeout(function () { update(); }, 0); });
    input.addEventListener("input", function () { if (cur && emailSuggest(input.value) !== cur) hide(); });
    var api2 = { update: update, hide: hide, current: function () { return cur; },
      hold: function () {
        var v = String(input.value || "").trim().toLowerCase();
        if (held === v) return false;                       // second press: go ahead with what was typed
        if (!update(true)) return false;
        held = v;
        var b = box.querySelector(".fv-sg-use"); if (b) { try { b.focus(); } catch (e) {} }
        return true;
      } };
    input._fvs = api2;
    return api2;
  }
  api.bind = bind; api.checkAll = checkAll; api.markLabel = markLabel; api.suggestEmail = suggestEmail;
  global.HelmValidate = api;
})(typeof window !== "undefined" ? window : globalThis);

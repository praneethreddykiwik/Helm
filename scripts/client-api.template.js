/* =========================================================================
   client-api.js - R216: the small data script for the pages a CLIENT opens from a link
   (approve, invite + /i/<slug>, portal, proposal-view, booklet). GENERATED FILE - do not edit by hand:
   edit scripts/client-api.template.js (this wrapper) or public/store-api.js (the copied parts), then run
       node scripts/gen-client-api.mjs            (rewrite public/client-api.js)
       node scripts/gen-client-api.mjs --check    (CI: exit 1 when it is out of date)

   Why: these pages loaded the whole staff data library (store-api.js, 568 KB unpacked) plus supabase-js just to make
   a handful of token calls. This file carries ONLY those calls, copied word for word from store-api.js by the
   generator (same RPC names, same arguments, same anon key + token), plus the same shared page helpers
   (HelmUrl, BPUI, tax / date / phone helpers). It talks to Supabase with plain fetch() exactly the way supabase-js did
   for a signed-out visitor. Every check stays on the server.

   A browser that holds a Helm sign-in (a studio member previewing a client link, the free-trial preview frames) or
   the free-trial flag gets the full store-api.js exactly as before ("full mode"): its calls then go through
   supabase-js with that member's session, so nothing changes for studio members either.
   ========================================================================= */
var STORE_API_V = "@@STORE_API_V@@";   // the store-api.js ?v= of the staff pages (filled in by the generator)
var __HELM_CLIENT_FULL__ = (function () {
  try {
    // a sign-in / auth-link return (?code=, #access_token=...) is store-api.js's job
    if (/[?&]code=/.test(location.search || "") || /(^#|&)(access_token|refresh_token|provider_token|error|error_code|error_description)=/.test(location.hash || "")) return true;
    if (localStorage.getItem("helm.trial") === "1") return true;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && /^sb-[a-z0-9-]+-auth-token$/i.test(k) && localStorage.getItem(k)) return true;   // a supabase-js session is stored
    }
  } catch (e) {}   // storage blocked: no session can exist in this browser
  return false;
})();
window.__HELM_CLIENT_FULL__ = __HELM_CLIENT_FULL__;
if (__HELM_CLIENT_FULL__) (function () {
  try {
    var s = document.createElement("script"); s.id = "helmStoreApi"; s.async = false;
    s.src = "/store-api.js?v=" + STORE_API_V;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();
/*@@top d.classList.add("helm-trial-early")@@*/
/*@@top var HelmUrl = (function (global)@@*/
/*@@top window.HelmUrl = HelmUrl;@@*/
/*@@top __helmLightLock@@*/
if (!__HELM_CLIENT_FULL__) {
/*@@top function wireHome()@@*/
}

(function (global) {
  const FULL = global.__HELM_CLIENT_FULL__ === true;
  /*@@decl CFG@@*/
  /*@@decl API@@*/
  /*@@stmt preconnectSupabase@@*/
  let mode = "local";           // resolved backend: 'supabase' | 'server' | 'local'
  let supa = null;              // the fetch-based Supabase client below (set by init)
  let ready = null;             // init() promise
  /*@@decl supaConfigured@@*/
  /*@@decl revealPage@@*/

  /* ---- fetch: the same wrapper store-api.js gives supabase-js (30 s timeout, no HTTP cache for data, quiet while leaving) ---- */
  /*@@decl FETCH_TIMEOUT_MS@@*/
  /*@@decl NO_FETCH_TIMEOUT@@*/
  /*@@decl AUTH_MAIL_TIMEOUT_MS@@*/
  /*@@decl AUTH_MAIL_POST@@*/
  /*@@decl fetchTimeoutFor@@*/
  /*@@decl timedFetch@@*/
  /*@@decl pageLeaving@@*/
  /*@@stmt global.addEventListener("pagehide"@@*/
  /*@@decl isLeavingAbort@@*/
  function clientFetch(input, init) {
    if (/\/rest\/v1\//.test(input) && !(init && init.cache)) init = Object.assign({}, init || {}, { cache: "no-store" });
    return timedFetch(input, init).catch((err) => {
      if (isLeavingAbort(err)) return new Promise(() => {});   // never settles: no rejection while the page unloads
      throw err;
    });
  }

  /* ---- a fetch-based stand-in for the parts of supabase-js these pages use: rpc(), storage signed URLs, the (empty)
     session. Same URL, same headers (anon key as apikey + bearer, as supabase-js sends for a signed-out visitor), same
     JSON body, and the same { data, error } answers (postgrest-js / storage-js rules) ---- */
  const CLIENT_INFO = "supabase-js/2.119.0; runtime=web";   // what the pages' supabase-js sent before
  function errOf(e) {
    return { message: ((e && e.name) || "FetchError") + ": " + (e && e.message), details: (e && e.stack) || "", hint: "", code: "" };
  }
  function makeClient(extraHeaders) {
    const base = String(CFG.url || "").replace(/\/+$/, "");
    const headers = () => Object.assign({ "X-Client-Info": CLIENT_INFO, apikey: CFG.anonKey, Authorization: "Bearer " + CFG.anonKey }, extraHeaders || {});
    async function rpcCall(fn, args) {
      let res;
      try {
        res = await clientFetch(base + "/rest/v1/rpc/" + fn, { method: "POST",
          headers: Object.assign(headers(), { "Content-Profile": "public", "Content-Type": "application/json" }),
          body: JSON.stringify(args === undefined ? {} : args, (k, v) => (typeof v === "bigint" ? v.toString() : v)) });
      } catch (e) { return { data: null, error: errOf(e), status: 0 }; }
      const text = await res.text();
      if (res.ok) {
        if (text === "") return { data: null, error: null, status: res.status };
        try { return { data: JSON.parse(text), error: null, status: res.status }; } catch (e) { return { data: null, error: { message: text }, status: res.status }; }
      }
      let error = null, data = null;
      try { error = JSON.parse(text); if (Array.isArray(error) && res.status === 404) { data = []; error = null; } }
      catch (e) { error = (res.status === 404 && text === "") ? null : { message: text }; }
      return { data, error, status: res.status };
    }
    return {
      rpc: (fn, args) => (/^public_link_(viewed|opened)$/.test(fn) ? linkGate.then((ok) => (ok ? rpcCall(fn, args) : { data: null, error: null })) : rpcCall(fn, args)),
      auth: { getSession: async () => ({ data: { session: null }, error: null }) },
      storage: { from: (bucket) => ({
        async createSignedUrls(paths, expiresIn) {
          try {
            const res = await clientFetch(base + "/storage/v1/object/sign/" + bucket, { method: "POST",
              headers: Object.assign(headers(), { "Content-Type": "application/json" }), body: JSON.stringify({ expiresIn, paths }) });
            const j = await res.json().catch(() => null);
            if (!res.ok || !Array.isArray(j)) return { data: null, error: (j && typeof j === "object" && !Array.isArray(j)) ? j : { message: "HTTP " + res.status } };
            return { data: j.map((e) => Object.assign({}, e, { signedUrl: e && e.signedURL ? encodeURI(base + "/storage/v1" + e.signedURL) : null })), error: null };
          } catch (e) { return { data: null, error: errOf(e) }; }
        } }) },
    };
  }
  // A view of a branded link (/<studio>/quote/<token> ...) is counted only once the studio part has been confirmed -
  // the page now asks "is this the studio's link?" and "the link's data" at the same time, so the view waits for the
  // first answer (exactly the order the server saw before).
  let linkGate = Promise.resolve(true);
  const gate = (p) => { linkGate = Promise.resolve(p).then((ok) => !!ok, () => false); return p; };

  // one session-less client per invitation slug (0048: the signing request carries x-helm-site-slug)
  const guestMediaClients = new Map();
  function guestMediaClient(slug) {
    slug = String(slug || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(slug)) return null;
    if (guestMediaClients.has(slug)) return guestMediaClients.get(slug);
    if (!supaConfigured()) return null;
    const c = makeClient({ "x-helm-site-slug": slug });
    guestMediaClients.set(slug, c);
    return c;
  }
  // no signed-in session can exist in this mode (a stored one switches to full mode), so an auth error never
  // has a session to refresh or a sign-in page to go to - the same "nothing to do" store-api.js reaches on these pages
  function onAuthFailure() { return Promise.resolve(false); }

  /* ---- copied from store-api.js ---- */
  /*@@decl looksLikeAuthError@@*/
  /*@@decl isMissingFn@@*/
  /*@@decl rpcOnce@@*/
  // public token calls are never "sensitive studio settings" (R35 two-step), so the step-up retry has nothing to do here
  const rpc = (fn, args) => rpcOnce(fn, args);
  /*@@decl rpcMissing@@*/
  /*@@decl SETTINGS_NAME@@*/
  /*@@decl settingsName@@*/
  global.HelmSettingsName = settingsName;
  /*@@decl lvPreview@@*/
  /*@@decl linkOpened@@*/
  /*@@decl lvApprove@@*/
  /*@@decl BOOKLET_IMG_MIME@@*/
  /*@@decl BOOKLET_IMG_KINDS@@*/
  /*@@decl bookletDataUrl@@*/
  /*@@decl UUID_RE_PKG@@*/
  /*@@decl fnUrl@@*/
  /*@@decl callFn@@*/
  /*@@decl LIVE@@*/
  /*@@decl QV_UUID@@*/
  /*@@decl readLs@@*/
  /*@@decl PROP_LS@@*/
  /*@@decl LINK_PROD_HOSTS@@*/
  /*@@decl LINK_RE@@*/
  /*@@decl deeplinkTarget@@*/
  /*@@decl deeplinkFocus@@*/
  /*@@stmt setTimeout(deeplinkFocus, 0)@@*/

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      if (supaConfigured()) { supa = makeClient(); mode = "supabase"; }
      else { try { const r = await fetch(API + "/health"); if (!r.ok) throw new Error("HTTP " + r.status); mode = "server"; } catch (e) { mode = "local"; } }
      revealPage();
      return mode;
    })();
    return ready;
  }

  const links = {
    /*@@members links: base, parse, verify, require@@*/
  };
  const approval = {
    /*@@members approval: getByToken, paidStatus, requestOtp, verifyConsent, checkShown, onlinePayAvailable, createPayment, requestChannelOtp, verifyChannel, quoteReady, trialTestMode, trialMode, trialSimPage, trialPaymentSim, trialSimulatePayment, trialSimList, trialTestApproveCode@@*/
  };
  const quoteValidity = {
    /*@@members quoteValidity: publicState, requestNew@@*/
  };
  const proposal = {
    /*@@members proposal: getByToken@@*/
  };
  const sites = {
    /*@@members sites: mediaUrls, public, publicInfo, rsvp, reveal@@*/
  };
  /*@@decl portal@@*/
  const paySchedule = {
    /*@@members paySchedule: publicGet@@*/
  };
  const pricing = {
    /*@@members pricing: _canon, quoteTotal@@*/
  };
  const BPStore = {
    init, mode: () => mode, links, approval, quoteValidity, proposal, sites, portal, paySchedule, pricing,
    auth: { user: () => null },   // nobody is signed in on this script (a signed-in browser runs store-api.js)
    booklet: {
      /*@@members BPStore.booklet: get, payTerms, studioOk, publicImage, snapshotUrl@@*/
    },
    pkgflow: {
      /*@@members BPStore.pkgflow: packages, choose, otpRequest@@*/
    },
  };
  // the studio-name check of a branded link opens the gate for its view count (see linkGate)
  const verifyLink = links.verify, bookletStudio = BPStore.booklet.studioOk;
  links.verify = (L) => gate(verifyLink(L));
  BPStore.booklet.studioOk = (token, studio) => gate(bookletStudio(token, studio));

  /* full mode: store-api.js is loading (see the top of this file). Until it has, the page only reads links.parse();
     every call then goes to the full BPStore (the member's session, supabase-js), exactly as before. */
  if (FULL) {
    let fullP = null;
    const fullNow = () => (global.BPStore && global.BPStore !== BPStore ? global.BPStore : null);
    const full = () => fullP || (fullP = new Promise((resolve) => {
      const done = () => resolve(fullNow());
      const s = document.getElementById("helmStoreApi");
      if (!s || fullNow()) return done();
      s.addEventListener("load", done); s.addEventListener("error", done); setTimeout(done, 20000);
    }));
    const SYNC = { "links.base": 1, "links.parse": 1, "approval.onlinePayAvailable": 1, "booklet.snapshotUrl": 1, "pricing._canon": 1, "pricing.quoteTotal": 1 };
    const pick = (o, path) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
    const delegate = (obj, path) => Object.keys(obj).forEach((k) => {
      const p = path ? path + "." + k : k, v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof RegExp)) return delegate(v, p);
      if (typeof v !== "function" || SYNC[p]) return;
      obj[k] = function () {
        const a = arguments, self = this;
        return full().then((F) => { const t = F && (path ? pick(F, path) : F); return t && typeof t[k] === "function" ? t[k].apply(t, a) : v.apply(self, a); });
      };
    });
    delegate(BPStore, "");
    BPStore.mode = () => { const F = fullNow(); return F ? F.mode() : mode; };
    BPStore.auth.user = () => { const F = fullNow(); return F && F.auth && F.auth.user ? F.auth.user() : null; };
  }
  global.BPStore = BPStore;
})(window);

/*@@top global.BPUI) return;@@*/
if (!__HELM_CLIENT_FULL__) {
/*@@top var BPStore = global.BPStore; if (!BPStore) return;@@*/
}
/*@@top function __helmAdoptCss(doc, css)@@*/

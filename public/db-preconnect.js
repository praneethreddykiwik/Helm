/* db-preconnect.js - R224: warm the connection (DNS + TCP + TLS) to the CONFIGURED Supabase origin as soon as config.js
   has run, on the client link pages whose data script (client-api.js) is now `defer`red. Same rule as client-api.js /
   store-api.js preconnectSupabase(): only an https://<ref>.supabase.co origin, only once, never a hardcoded host - so a
   staging page never warms prod. Tiny, blocking, placed right after config.js (and config.staging.js). */
(function () {
  try {
    var CFG = window.SUPABASE_CONFIG || {};
    if (!document.head || !CFG.url || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(CFG.url)) return;
    var origin = CFG.url.replace(/\/$/, "");
    if (document.querySelector('link[rel="preconnect"][href="' + origin + '"]')) return;
    var l = document.createElement("link");
    l.setAttribute("rel", "preconnect"); l.setAttribute("href", origin); l.setAttribute("crossorigin", "anonymous");
    document.head.appendChild(l);
  } catch (e) {}
})();

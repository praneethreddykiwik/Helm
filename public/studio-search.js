/* =========================================================================
   HELM — universal studio search (0061)
   -------------------------------------------------------------------------
   • Top-bar trigger (mounted into #helm-topbar-search when the page has one,
     otherwise a small slot just left of the account chip) + a Cmd/Ctrl+K
     command palette (also "/" when you are not typing in a field).
   • Results come from studio_search() via BPStore.search(): grouped by kind,
     only the caller's own studio, only the areas their role may view. Before
     0061 is applied the store answers {} and the palette shows "no matches".
   • Quick actions ("New lead", "Go to calendar"…) are filtered by the same
     access checks the pages use (BPStore.auth.canView / canEditArea / can).
   • Recent searches: this browser only, per signed-in user, try/catch storage.
   • a11y: role=combobox input + role=listbox with grouped role=option rows,
     aria-activedescendant; ↑/↓ move, Enter opens, Tab / Shift+Tab jump
     between groups, Esc closes and gives focus back.
   • CSP: no inline style attributes, no HTML string sinks — DOM nodes + textContent
     only; runtime CSS via window.__helmAdoptCss.
   ========================================================================= */
(function (global) {
  "use strict";

  const MIN = 2, MAX = 80, DEBOUNCE = 200, RECENT_MAX = 6;
  const NOT_HERE = { hq: 1, login: 1, "reset-password": 1, "profile-setup": 1, index: 1, approve: 1, portal: 1,
    "proposal-view": 1, invite: 1, work: 1, "sim-pay": 1, about: 1, services: 1, privacy: 1, terms: 1, "refund-policy": 1 };

  // kind → label + icon (order = display order)
  const TYPES = [
    { key: "events",    label: "Events & quotes", icon: "📋" },
    { key: "leads",     label: "Leads",           icon: "🎯" },
    { key: "staff",     label: "Staff",           icon: "👷" },
    { key: "team",      label: "Team members",    icon: "👥" },
    { key: "vendors",   label: "Vendors",         icon: "🤝" },
    { key: "inventory", label: "Inventory",       icon: "📦" },
    { key: "payments",  label: "Payments",        icon: "🧾" },
  ];
  // quick actions: `need` = [kind, area] checked through BPStore.auth
  const ACTIONS = [
    { id: "new-lead",   label: "New lead",           icon: "➕", href: "leads.html?hs_act=new",     need: [["edit", "leads"]],  kw: "add create enquiry" },
    { id: "new-quote",  label: "New quote",          icon: "✨", href: "quotes.html?hs_act=new",    need: [["cap", "create"], ["edit", "quotes"]], kw: "create event estimate booking" },
    { id: "new-staff",  label: "Add staff",          icon: "➕", href: "staff.html?hs_act=new",     need: [["edit", "staff"]],  kw: "crew create" },
    { id: "invite-user", label: "Invite user",       icon: "✉", href: "control.html?cs=Invite%20by%20email%20link#users", need: [["role", "admin"]], kw: "invite teammate team member join link user login" },
    { id: "add-user",   label: "Add user (team login)", icon: "👥", href: "control.html?cs=Add%20user#users", need: [["role", "admin"]], kw: "add user team member staff login account create" },
    { id: "new-item",   label: "Add stock item",     icon: "➕", href: "inventory.html?hs_act=new", need: [["edit", "inventory"]], kw: "inventory create" },
    { id: "new-vendor", label: "Add vendor",         icon: "➕", href: "vendors.html?hs_act=new",   need: [["edit", "vendors"]], kw: "partner supplier create" },
    { id: "go-dash",    label: "Go to dashboard",    icon: "🏠", href: "dashboard.html",            need: [],                   kw: "home" },
    { id: "go-cal",     label: "Go to calendar",     icon: "📅", href: "calendar.html",             need: [["view", "calendar"]], kw: "schedule dates" },
    { id: "go-quotes",  label: "Go to quotes",       icon: "📋", href: "quotes.html",               need: [["view", "quotes"]], kw: "events" },
    { id: "go-leads",   label: "Go to leads",        icon: "🎯", href: "leads.html",                need: [["view", "leads"]],  kw: "pipeline" },
    { id: "go-staff",   label: "Go to staff",        icon: "👷", href: "staff.html",                need: [["view", "staff"]],  kw: "crew" },
    { id: "go-inv",     label: "Go to inventory",    icon: "📦", href: "inventory.html",            need: [["view", "inventory"]], kw: "stock" },
    { id: "go-vendors", label: "Go to vendors",      icon: "🤝", href: "vendors.html",              need: [["view", "vendors"]], kw: "partners" },
    { id: "go-chat",    label: "Open team chat",     icon: "💬", href: "chat.html",                 need: [],                   kw: "messages" },
    { id: "go-control", label: "Open Settings", icon: "⚙", href: "control.html",              need: [["ctl"]], kw: "settings access control center" },
  ];

  const doc = global.document;
  // search-catalog.js (pages, Settings sections + settings, account items) and the smart matcher
  // settings-search-core.js load next to this file on first open (loader constants: bumped with the files)
  const CATALOG_V = "12", SSC_V = "2";
  const SELF = (() => { try { return doc && doc.currentScript && doc.currentScript.src || ""; } catch (e) { return ""; } })();
  const isMac = (() => { try { return /Mac|iPhone|iPad/.test(global.navigator.platform || global.navigator.userAgent || ""); } catch (e) { return false; } })();

  /* ---- pure helpers (exported for tests) ------------------------------- */
  function cleanQuery(q) { return String(q == null ? "" : q).replace(/\s+/g, " ").trim().slice(0, MAX); }
  // only the app's own pages: "<page>.html" plus a simple query / hash
  const LINK_RE = /^[a-z][a-z0-9-]*\.html(?:[?#][A-Za-z0-9_\-=&.#%]*)?$/;
  // r59 (audit BS-05): a list page has no per-record URL, so the result's name is handed to the page's own search
  // box. It travels in this tab's sessionStorage under a short random key (?hs_k=...), never in the URL (browser
  // history / server logs / referrer would otherwise keep client names).
  const HS_KEY = "helm_ss_hs";
  function hsStore() { try { const v = JSON.parse(global.sessionStorage.getItem(HS_KEY) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } }
  function hsPut(term) {
    const k = Math.random().toString(36).slice(2, 10) || "k";
    try { const m = hsStore(); m[k] = String(term || "").slice(0, MAX); const keys = Object.keys(m); while (keys.length > 30) delete m[keys.shift()];
      global.sessionStorage.setItem(HS_KEY, JSON.stringify(m)); } catch (e) { return null; }
    return k;
  }
  function hsTake(k) {
    if (!/^[a-z0-9]{1,12}$/.test(String(k || ""))) return null;
    try { const m = hsStore(); const v = m[k]; delete m[k]; global.sessionStorage.setItem(HS_KEY, JSON.stringify(m)); return typeof v === "string" ? v : null; } catch (e) { return null; }
  }
  function safeLink(link, title) {
    const l = String(link || "");
    if (!LINK_RE.test(l)) return null;
    if (!/[?&]hs=$/.test(l)) return l;
    const k = hsPut(title);
    return k ? l.replace(/hs=$/, "hs_k=" + k) : l.replace(/[?&]hs=$/, "");
  }
  function normalize(data) {
    const out = [];
    if (!data || typeof data !== "object" || Array.isArray(data)) return out;
    /* LA-28: a raw stage key inside a server subtitle ("won · Wedding") reads as its label ("Won · Wedding") */
    const STAGE_KEY = /^(new|qualified|discovery|quoted|won|lost|lead|proposal|quote|confirmed|planning|resources|ready|event_day|settlement|closed|cancelled|draft)$/;
    const prettySub = (sub) => sub.split(" · ").map((p) => {
      const k = p.trim(); if (!STAGE_KEY.test(k)) return p;
      try { const B = (typeof window !== "undefined" && window.BPStore) || null; if (B && B.stageLabel) return B.stageLabel(k); } catch (e) {}
      return k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ");
    }).join(" · ");
    TYPES.forEach((t) => {
      const rows = Array.isArray(data[t.key]) ? data[t.key] : [];
      const items = [];
      rows.forEach((r) => {
        if (!r || r.id == null || r.title == null) return;
        const href = safeLink(r.link, r.title);
        if (!href) return;
        items.push({ id: String(r.id), title: String(r.title), subtitle: r.subtitle == null ? "" : prettySub(String(r.subtitle)), href });
      });
      if (items.length) out.push({ type: t.key, label: t.label, icon: t.icon, items });
    });
    // 0062: leads and events also open their client's one-page timeline (client.html?id=)
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const clients = [];
    out.forEach((g) => {
      if (g.type !== "leads" && g.type !== "events") return;
      g.items.forEach((it) => {
        if (clients.length < 3 && UUID.test(it.id)) clients.push({ id: "c:" + it.id, title: it.title, subtitle: "Client page", href: "client.html?id=" + it.id });
      });
    });
    if (clients.length) out.push({ type: "clients", label: "Client pages", icon: "🧑", items: clients });
    return out;
  }
  // split text into [{t, hit}] runs for highlighting (case-insensitive, every occurrence)
  function highlight(text, q) {
    const s = String(text == null ? "" : text), needle = cleanQuery(q).toLowerCase();
    if (needle.length < 1) return [{ t: s, hit: false }];
    const low = s.toLowerCase(), parts = [];
    let i = 0;
    while (i <= s.length) {
      const j = low.indexOf(needle, i);
      if (j < 0) { if (i < s.length) parts.push({ t: s.slice(i), hit: false }); break; }
      if (j > i) parts.push({ t: s.slice(i, j), hit: false });
      parts.push({ t: s.slice(j, j + needle.length), hit: true });
      i = j + needle.length;
    }
    return parts.length ? parts : [{ t: s, hit: false }];
  }
  function matchAction(a, q) {
    const n = cleanQuery(q).toLowerCase();
    if (!n) return true;
    return (a.label + " " + a.kw).toLowerCase().split(" ").some((w) => w.startsWith(n)) || a.label.toLowerCase().includes(n);
  }

  /* ---- storage (recent searches; never required) ----------------------- */
  function recentKey() {
    let u = "";
    try { const st = global.BPStore; const usr = st && st.auth && st.auth.user && st.auth.user(); u = (usr && usr.id) || ""; } catch (e) {}
    return "helm_ss_recent_" + u;
  }
  function recentGet() {
    try { const v = JSON.parse(global.localStorage.getItem(recentKey()) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : []; }
    catch (e) { return []; }
  }
  function recentAdd(q) {
    const c = cleanQuery(q); if (c.length < MIN) return;
    try {
      const list = [c].concat(recentGet().filter((x) => x.toLowerCase() !== c.toLowerCase())).slice(0, RECENT_MAX);
      global.localStorage.setItem(recentKey(), JSON.stringify(list));
    } catch (e) {}
  }
  function recentClear() { try { global.localStorage.removeItem(recentKey()); } catch (e) {} }

  /* ---- styles ------------------------------------------------------------- */
  const CSS = [
    "html.hss-lock{overflow:hidden}",
    ".hss-slot{display:inline-flex;align-items:center;margin-right:8px}",
    ".hss-trig{display:inline-flex;align-items:center;gap:8px;height:32px;min-width:200px;padding:0 8px 0 10px;border:1px solid var(--line,#e8e3db);border-radius:9px;background:var(--panel,#fff);color:var(--ink-3,#6b6577);font:500 13px var(--font,system-ui);cursor:pointer;transition:border-color .12s,box-shadow .12s}",
    ".hss-trig:hover{border-color:var(--accent,#047857)}",
    ".hss-trig:focus-visible{outline:2px solid var(--accent,#047857);outline-offset:2px}",
    ".hss-trig .hss-tl{flex:1;text-align:left}",
    ".hss-kbd{display:inline-flex;align-items:center;gap:2px;font:600 11px var(--mono,ui-monospace,monospace);color:var(--ink-3,#6b6577);border:1px solid var(--line,#e8e3db);border-bottom-width:2px;border-radius:5px;padding:1px 5px;background:var(--panel-2,#faf8f5);white-space:nowrap}",
    ".hss-ico{width:16px;height:16px;flex:0 0 auto;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    // r223 palette look (Spotlight / Linear style, Helm tokens): one clean search row, black selected row, line icons,
    // keycap hints, light backdrop. Tokens fall back to theme.css names off the app shell.
    ".hss-ov,.hss-ghost{position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:flex-start;padding:12vh 16px 16px;background:rgba(16,20,18,.26);-webkit-backdrop-filter:blur(1.5px);backdrop-filter:blur(1.5px)}",
    ".hss-ov{animation:hssFade .16s ease-out}",
    ".hss-ghost{pointer-events:none;animation:hssFadeOut .16s ease-in forwards}",
    ".hss-dlg{--hss-ink:var(--hb-ink,var(--ink,#1b1930));--hss-ink2:var(--hb-ink2,var(--ink-2,#4b475f));--hss-mute:var(--hb-ink3,var(--ink-3,#6b6577));--hss-line:var(--hb-line,var(--line,#e8e3db));--hss-bg:var(--hb-bg,var(--panel,#fff));--hss-bg2:var(--hb-bg2,var(--panel-2,#faf8f5));--hss-acc:var(--hb-acc,var(--accent,#047857));--hss-acc-text:var(--hb-acc-text,var(--accent,#047857));--hss-sel:#111;--hss-sel-ink:#fff;"
      + "width:min(680px,100%);max-height:min(580px,calc(88vh - 32px));display:flex;flex-direction:column;background:var(--hss-bg);color:var(--hss-ink);border:1px solid var(--hss-line);border-radius:16px;box-shadow:0 28px 80px -12px rgba(10,14,12,.32),0 4px 14px rgba(10,14,12,.08);overflow:hidden;font-family:var(--font,system-ui);transform-origin:50% 0;animation:hssPop .2s cubic-bezier(.16,1,.3,1)}",
    ".hss-ghost .hss-dlg{animation:hssPopOut .16s ease-in forwards}",
    ".hss-in-row{display:flex;align-items:center;gap:12px;padding:0 12px 0 18px;border-bottom:1px solid var(--hss-line);box-shadow:inset 0 -2px 0 transparent;transition:box-shadow .15s}",
    // the field is the dialog's only focus target: its focus indicator is the accent rule under the row
    ".hss-in-row:focus-within{box-shadow:inset 0 -2px 0 var(--hss-acc)}",
    ".hss-in-row>.hss-ico{width:20px;height:20px;color:var(--hss-mute)}",
    ".hss-in-row:focus-within>.hss-ico{color:var(--hss-ink)}",
    // theme.css / the shell give every input a border, radius, 44px min-height and a focus halo: none of that here (no box in a box)
    ".hss-dlg input.hss-in,.hss-dlg input.hss-in:focus,.hss-dlg input.hss-in:focus-visible{flex:1;min-width:0;height:58px;min-height:0;margin:0;padding:0;border:0!important;border-radius:0!important;outline:none!important;box-shadow:none!important;background:transparent!important;color:var(--hss-ink);font:400 17px/1.3 var(--font,system-ui);letter-spacing:-.005em;-webkit-appearance:none;appearance:none}",
    ".hss-in::placeholder{color:var(--hss-mute);opacity:1}",
    ".hss-in::-webkit-search-cancel-button{display:none}",
    ".hss-key{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;box-sizing:border-box;border:1px solid var(--hss-line);border-radius:6px;background:var(--hss-bg);box-shadow:inset 0 -1px 0 var(--hss-line);color:var(--hss-ink2);font:600 11px/1 var(--font,system-ui);letter-spacing:.01em;white-space:nowrap}",
    "button.hss-x{flex:0 0 auto;height:26px;min-height:0;padding:0 8px;cursor:pointer;color:var(--hss-mute)}",
    "button.hss-x:hover{color:var(--hss-ink);border-color:var(--hss-mute)}",
    "button.hss-x:focus-visible{outline:2px solid var(--hss-acc);outline-offset:2px}",
    ".hss-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--hss-line);border-top-color:var(--hss-acc);animation:hssSpin .7s linear infinite;flex:0 0 auto}",
    ".hss-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 0 10px;scroll-padding:8px 0 28px}",
    ".hss-body[data-more]{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 32px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 32px),transparent)}",
    ".hss-grp{padding:2px 0 4px}",
    ".hss-grp+.hss-grp{margin-top:2px}",
    ".hss-gh{display:flex;align-items:center;gap:8px;padding:12px 18px 6px;font:600 11px/1.2 var(--font,system-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--hss-mute)}",
    ".hss-gh button{margin-left:auto;min-height:0;height:auto;border:0;background:none;padding:2px 4px;color:var(--hss-mute);font:500 12px var(--font,system-ui);text-transform:none;letter-spacing:0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}",
    ".hss-gh button:hover{color:var(--hss-ink)}",
    ".hss-opt{position:relative;display:flex;align-items:center;gap:12px;margin:1px 8px;padding:6px 10px 6px 8px;border-radius:10px;cursor:pointer;min-height:46px;box-sizing:border-box;color:var(--hss-ink);transition:background-color .08s ease}",
    ".hss-opt[aria-selected=true]{background:var(--hss-sel);color:var(--hss-sel-ink)}",
    ".hss-oi{flex:0 0 auto;width:32px;height:32px;display:grid;place-items:center;border-radius:9px;background:var(--hss-bg2);border:1px solid var(--hss-line);color:var(--hss-ink2);box-sizing:border-box}",
    ".hss-oi .hss-kico{width:16px;height:16px;stroke-width:1.75}",
    ".hss-opt[aria-selected=true] .hss-oi{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.16);color:var(--hss-sel-ink)}",
    ".hss-ot{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
    ".hss-t{font-size:14px;line-height:1.35;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".hss-s{font-size:12.5px;line-height:1.35;color:var(--hss-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".hss-opt[aria-selected=true] .hss-s{color:color-mix(in srgb,var(--hss-sel-ink) 74%,transparent)}",
    ".hss-t mark,.hss-s mark{background:transparent;color:var(--hss-acc-text);font-weight:700}",
    ".hss-opt[aria-selected=true] mark{color:inherit;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}",
    ".hss-go{flex:0 0 auto;visibility:hidden}",
    ".hss-opt[aria-selected=true] .hss-go{visibility:visible;background:transparent;border-color:rgba(255,255,255,.3);box-shadow:none;color:var(--hss-sel-ink)}",
    ".hss-msg{padding:32px 24px;text-align:center;color:var(--hss-ink2);font-size:14px;line-height:1.5}",
    ".hss-msg b{display:block;color:var(--hss-ink);margin-bottom:4px;font-size:15px;font-weight:600}",
    ".hss-msg button{margin-top:14px;min-height:0;font:600 13px var(--font,system-ui);padding:8px 16px;border-radius:9px;border:1px solid var(--hss-sel);background:var(--hss-sel);color:var(--hss-sel-ink);cursor:pointer}",
    ".hss-msg button:focus-visible{outline:2px solid var(--hss-acc);outline-offset:2px}",
    ".hss-foot{display:flex;align-items:center;gap:16px;padding:9px 16px;border-top:1px solid var(--hss-line);background:var(--hss-bg2);font-size:12px;color:var(--hss-mute)}",
    ".hss-foot span{display:inline-flex;align-items:center;gap:4px}",
    ".hss-foot .hss-key{margin-right:2px}",
    ".hss-foot .hss-st{margin-left:auto}",
    ".hss-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
    "html[data-theme=dark] .hss-ov,html[data-theme=dark] .hss-ghost{background:rgba(0,0,0,.5)}",
    "html[data-theme=dark] .hss-dlg{--hss-sel:#f2f2f2;--hss-sel-ink:#111}",
    "html[data-theme=dark] .hss-opt[aria-selected=true] .hss-oi{background:rgba(0,0,0,.08);border-color:rgba(0,0,0,.12)}",
    "html[data-theme=dark] .hss-opt[aria-selected=true] .hss-go{border-color:rgba(0,0,0,.3)}",
    "html[data-theme=dark] .hss-t mark,html[data-theme=dark] .hss-s mark{color:#6ee7b7}",
    "@keyframes hssFade{from{opacity:0}to{opacity:1}}",
    "@keyframes hssFadeOut{from{opacity:1}to{opacity:0}}",
    "@keyframes hssPop{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}",
    "@keyframes hssPopOut{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-4px) scale(.985)}}",
    "@keyframes hssSpin{to{transform:rotate(360deg)}}",
    "@media (prefers-reduced-motion:reduce){.hss-ov,.hss-dlg{animation:none}.hss-ghost{display:none}.hss-opt,.hss-in-row{transition:none}.hss-spin{animation-duration:2s}}",
    "@media (max-width:900px){.hss-trig{min-width:0}.hss-trig .hss-tl,.hss-trig .hss-kbd{display:none}.hss-trig{width:36px;height:36px;justify-content:center;padding:0}}",
    // phones: a full-width, full-height sheet (keyboard-safe), safe-area aware, bigger touch rows, no keyboard hints
    "@media (max-width:640px){.hss-ov,.hss-ghost{padding:0;align-items:stretch;-webkit-backdrop-filter:none;backdrop-filter:none}.hss-dlg{width:100%;max-height:none;height:100%;height:100dvh;border-radius:0;border:0;box-shadow:none;animation-name:hssSheet}.hss-in-row{padding:env(safe-area-inset-top,0px) 10px 0 16px}.hss-dlg input.hss-in{height:56px;font-size:16px}.hss-opt{min-height:52px;margin:1px 6px}.hss-gh{padding:14px 16px 6px}.hss-foot{padding-bottom:calc(9px + env(safe-area-inset-bottom,0px))}.hss-foot .hss-k{display:none}}",
    "@keyframes hssSheet{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}",
  ].join("\n");
  let cssDone = false;
  function css() {
    if (cssDone) return; cssDone = true;
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS);
  }

  /* ---- tiny DOM helper (textContent only) -------------------------------- */
  function el(tag, attrs, text) {
    const n = doc.createElement(tag);
    if (attrs) for (const k in attrs) { if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? "" : String(attrs[k])); }
    if (text != null) n.textContent = String(text);
    return n;
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  /* r223: one line-icon per kind (24px grid, stroke = currentColor) instead of emoji. Each entry is a list of
     shapes: a string is a <path d>, ["c", cx, cy, r] a circle, ["r", x, y, w, h, rx] a rect. Built with
     createElementNS + setAttribute only (no markup strings - CSP / Trusted Types safe). */
  const ICO = {
    calendar: [["r", 3, 5, 18, 16, 2], "M16 3v4M8 3v4M3 10h18"],
    quote: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6M9 17h4"],
    lead: [["c", 12, 12, 9], ["c", 12, 12, 5], ["c", 12, 12, 1]],
    user: [["c", 12, 8, 4], "M4 21c0-4 3.6-7 8-7s8 3 8 7"],
    users: [["c", 9, 8, 3.5], "M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6", "M16 4.6a3.5 3.5 0 0 1 0 6.8", "M18 14.2c2.1.6 3.5 2.6 3.5 5.8"],
    userPlus: [["c", 9, 8, 4], "M2 21c0-4 3.1-7 7-7s7 3 7 7", "M19 8v6M16 11h6"],
    client: [["c", 12, 12, 9], ["c", 12, 10, 3], "M6.6 18.4c1.3-1.9 3.2-2.9 5.4-2.9s4.1 1 5.4 2.9"],
    store: ["M3 9l1.6-5h14.8L21 9", "M3 9h18a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0", "M5 12v8h14v-8", "M10 20v-5h4v5"],
    box: ["M21 8l-9-5-9 5 9 5z", "M3 8v8l9 5 9-5V8", "M12 13v8"],
    receipt: ["M6 3h12v18l-3-2-3 2-3-2-3 2z", "M9 8h6M9 12h6"],
    page: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"],
    sliders: ["M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1", ["c", 15, 6, 2], ["c", 9, 12, 2], ["c", 17, 18, 2]],
    toggle: [["r", 2, 7, 20, 10, 5], ["c", 16, 12, 2.5]],
    clock: [["c", 12, 12, 9], "M12 7v5l3 2"],
    plus: ["M12 5v14M5 12h14"],
    arrow: ["M5 12h14", "M13 6l6 6-6 6"],
    home: ["M3 11l9-7 9 7", "M5 10v10h14V10", "M10 20v-6h4v6"],
    chat: ["M4 5h16v11H9l-5 4z"],
    mail: [["r", 3, 5, 18, 14, 2], "M3 7l9 6 9-6"],
    plan: [["r", 3, 3, 18, 18, 2], "M3 10h8v11", "M14 3v7h7"],
    briefcase: [["r", 3, 7, 18, 13, 2], "M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2", "M3 13h18"],
    chart: ["M3 20h18", "M7 16v-5M12 16V6M17 16v-8"],
    shield: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"],
    drop: ["M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"],
    help: [["c", 12, 12, 9], "M9.5 9.2a2.6 2.6 0 0 1 5 .8c0 1.8-2.5 2.2-2.5 3.8", "M12 17.4v.1"],
    layout: [["r", 3, 3, 18, 18, 2], "M3 9h18", "M9 21V9"],
  };
  // which icon each row kind shows (display only - the data and the search are unchanged)
  const ICO_RESULT = { events: "calendar", leads: "lead", staff: "user", team: "users", vendors: "store", inventory: "box", payments: "receipt", clients: "client" };
  const ICO_RECORD = { event: "calendar", quote: "quote", lead: "lead", builder: "plan", vendor: "store", staff: "user", client: "client", record: "page" };
  const ICO_LOCAL = { page: "page", section: "sliders", setting: "toggle", account: "client" };
  const ICO_ACTION = { "new-lead": "plus", "new-quote": "plus", "new-staff": "plus", "invite-user": "mail", "add-user": "userPlus", "new-item": "plus",
    "new-vendor": "plus", "go-dash": "home", "go-cal": "calendar", "go-quotes": "quote", "go-leads": "lead", "go-staff": "user", "go-inv": "box",
    "go-vendors": "store", "go-chat": "chat", "go-control": "sliders", "go-business": "briefcase", "go-reports": "chart", "go-audit": "shield",
    "go-insights-b": "chart", "go-setup": "sliders", "go-templates": "layout", "hsb-theme": "drop", "hsb-tour": "help" };
  function kindIcon(name) {
    const s = doc.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "hss-ico hss-kico"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    (ICO[name] || ICO.arrow).forEach((sh) => {
      let n;
      if (typeof sh === "string") { n = doc.createElementNS(SVGNS, "path"); n.setAttribute("d", sh); }
      else if (sh[0] === "c") { n = doc.createElementNS(SVGNS, "circle"); n.setAttribute("cx", String(sh[1])); n.setAttribute("cy", String(sh[2])); n.setAttribute("r", String(sh[3])); }
      else { n = doc.createElementNS(SVGNS, "rect"); n.setAttribute("x", String(sh[1])); n.setAttribute("y", String(sh[2])); n.setAttribute("width", String(sh[3])); n.setAttribute("height", String(sh[4])); n.setAttribute("rx", String(sh[5])); }
      s.appendChild(n);
    });
    return s;
  }
  function searchIcon() {
    const s = doc.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "hss-ico"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    const c = doc.createElementNS(SVGNS, "circle"); c.setAttribute("cx", "11"); c.setAttribute("cy", "11"); c.setAttribute("r", "7");
    const l = doc.createElementNS(SVGNS, "path"); l.setAttribute("d", "M20 20l-3.5-3.5");
    s.appendChild(c); s.appendChild(l); return s;
  }
  function hl(node, text, q) {
    highlight(text, q).forEach((p) => { node.appendChild(p.hit ? el("mark", null, p.t) : doc.createTextNode(p.t)); });
    return node;
  }

  /* ---- access (quick actions) ----------------------------------------------- */
  async function allowedActions() {
    const st = global.BPStore, a = st && st.auth;
    if (!a) return ACTIONS.filter((x) => !x.need.length);
    const out = [];
    for (const x of ACTIONS) {
      let ok = true;
      for (const [kind, what] of x.need) {
        try {
          if (kind === "view") ok = await a.canView(what);
          else if (kind === "edit") ok = await a.canEditArea(what);
          else if (kind === "cap") ok = await a.can(what);
          else if (kind === "role") ok = String((await a.role()) || "") === what;
          else if (kind === "ctl") ok = String((await a.role()) || "") === "admin" || await a.canView("controls");
        } catch (e) { ok = false; }
        if (!ok) break;
      }
      if (ok) out.push(x);
    }
    return out;
  }

  /* ---- palette ------------------------------------------------------------- */
  function loadScript(rel, test) {
    return new Promise((resolve) => {
      try {
        if (test()) return resolve(true);
        const s = doc.createElement("script");
        let src = rel; try { if (SELF) src = new URL(rel, SELF).href; } catch (e) {}
        s.src = src; s.onload = () => resolve(test()); s.onerror = () => resolve(false);
        doc.head.appendChild(s);
      } catch (e) { resolve(false); }
    });
  }
  let localP = null;
  // pages / sections / settings / account items this person may open (same gates as the sidebar)
  function localEntries() {
    if (localP) return localP;
    localP = Promise.all([
      loadScript("search-catalog.js?v=" + CATALOG_V, () => !!global.HelmSearchCatalog),
      loadScript("settings-search-core.js?v=" + SSC_V, () => !!global.HelmSettingsSearch),
    ]).then(() => {
      const cat = global.HelmSearchCatalog, st = global.BPStore;
      if (!cat || !st || !st.auth) return [];
      return cat.entriesFor(st.auth, global.HELM_FEATURES || {});
    }).then((l) => (Array.isArray(l) ? l : []), () => []).then((l) => { if (!l.length) localP = null; return l; });
    return localP;
  }
  const LOCAL_ICON = { page: "📄", section: "⚙", setting: "🔧", account: "👤" };
  const LOCAL_SUB = { page: "Page", section: "Settings", account: "Your account" };
  // QA B5: a studio on its free trial never sees the pages / actions the trial does not include (studio set-up and
  // import, checklist templates, the activity log, Reports & exports) - html.helm-trial is set by trial-lock.js
  const TRIAL_OUT = /(^|\/)(onboarding|templates|audit|reports)(\.html)?([?#\/]|$)/;
  function trialOn() { try { return !!doc && doc.documentElement.classList.contains("helm-trial"); } catch (e) { return false; } }
  function trialAction(a) { return !(trialOn() && a && typeof a.href === "string" && TRIAL_OUT.test(a.href)); }
  function localHits(q, list) {
    const cat = global.HelmSearchCatalog;
    if (!cat || !list || !list.length || cleanQuery(q).length < MIN) return [];
    // QA B5: filtered again at search time (the list is cached; the trial answer may arrive after it was built)
    if (typeof cat.forTrial === "function") list = cat.forTrial(list, trialOn());
    return cat.rank(q, list, global.HelmSettingsSearch, 8).map((e) => ({
      kind: e.kind === "account" ? "account" : "nav", label: e.text, icon: LOCAL_ICON[e.kind] || "📄", ico: ICO_LOCAL[e.kind] || "page",
      sub: e.kind === "setting" ? "Setting · " + e.context : LOCAL_SUB[e.kind] || "", href: e.href || "", open: e.open || null,
    }));
  }

  const S = { open: false, local: [], ov: null, input: null, list: null, status: null, spin: null, opts: [], active: -1,
    q: "", groups: [], err: false, loading: false, ctrl: null, timer: null, seq: 0, actions: null, returnFocus: null };

  function build() {
    css();
    const ov = el("div", { class: "hss-ov", "data-hss": "overlay" });
    const dlg = el("div", { class: "hss-dlg", role: "dialog", "aria-modal": "true", "aria-label": "Search your studio" });
    const row = el("div", { class: "hss-in-row" });
    row.appendChild(searchIcon());
    const input = el("input", { class: "hss-in", id: "hssInput", type: "search", role: "combobox", "aria-expanded": "true", "aria-controls": "hssList",
      "aria-autocomplete": "list", "aria-haspopup": "listbox", autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false",
      maxlength: String(MAX), placeholder: "Search pages, settings, leads, events, staff…", "aria-label": "Search your studio", enterkeyhint: "go" });
    const spin = el("span", { class: "hss-spin", "aria-hidden": "true" }); spin.hidden = true;
    const x = el("button", { type: "button", class: "hss-x hss-key", "aria-label": "Close search" }, "Esc");
    row.appendChild(input); row.appendChild(spin); row.appendChild(x);
    const body = el("div", { class: "hss-body" });
    const list = el("div", { id: "hssList", role: "listbox", "aria-label": "Search results" });
    body.appendChild(list);
    const foot = el("div", { class: "hss-foot" });
    [[["↑", "↓"], "move"], [["↵"], "open"], [["Tab"], "next group"]].forEach(([ks, t]) => {
      const sp = el("span", { class: "hss-k" }); ks.forEach((k) => sp.appendChild(el("kbd", { class: "hss-key" }, k))); sp.appendChild(doc.createTextNode(t)); foot.appendChild(sp);
    });
    const status = el("span", { class: "hss-st", role: "status", "aria-live": "polite" });
    foot.appendChild(status);
    dlg.appendChild(row); dlg.appendChild(body); dlg.appendChild(foot); ov.appendChild(dlg);

    ov.addEventListener("mousedown", (e) => { if (e.target === ov) { e.preventDefault(); close(); } });
    x.addEventListener("click", close);
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKey);
    dlg.addEventListener("keydown", (e) => { if (e.key === "Tab" && e.target !== input) { e.preventDefault(); input.focus(); } });
    body.addEventListener("scroll", moreHint, { passive: true });
    Object.assign(S, { ov, input, list, status, spin, body });
  }

  async function open(initial) {
    if (S.open) { S.input.focus(); S.input.select(); return; }
    if (!S.ov) build();
    S.returnFocus = doc.activeElement;
    S.open = true; S.err = false; S.groups = [];
    doc.body.appendChild(S.ov);
    try { doc.documentElement.classList.add("hss-lock"); } catch (e) {}
    S.input.value = initial != null ? cleanQuery(initial) : "";
    S.q = cleanQuery(S.input.value);
    S.input.focus();
    if (!S.actions) { try { S.actions = await allowedActions(); } catch (e) { S.actions = []; } }
    localEntries().then((l) => { S.local = l; if (S.open && S.q.length >= MIN) render(); });
    if (S.q.length >= MIN) run(S.q); else render();
  }
  function close() {
    if (!S.open) return;
    S.open = false;
    if (S.ctrl) { try { S.ctrl.abort(); } catch (e) {} S.ctrl = null; }
    clearTimeout(S.timer);
    if (S.ov && S.ov.parentNode) { fadeOut(S.ov); S.ov.parentNode.removeChild(S.ov); }
    try { doc.documentElement.classList.remove("hss-lock"); } catch (e) {}
    const r = S.returnFocus; S.returnFocus = null;
    if (r && typeof r.focus === "function" && doc.contains(r)) { try { r.focus(); } catch (e) {} }
  }

  // r223: soft fade at the list's bottom edge while more rows are below (no row looks "cut off")
  function moreHint() {
    const b = S.body; if (!b) return;
    const more = (b.scrollHeight - b.scrollTop - b.clientHeight) > 4;
    if (more) b.setAttribute("data-more", ""); else b.removeAttribute("data-more");
  }
  // r223: close animation. The real dialog leaves the DOM at once (focus, ids and tests stay exactly as before);
  // an inert, id-less copy plays the fade-out and removes itself. Skipped for prefers-reduced-motion.
  function fadeOut(ov) {
    try {
      if (typeof ov.cloneNode !== "function" || typeof global.matchMedia !== "function" || global.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const g = ov.cloneNode(true);
      g.setAttribute("class", "hss-ghost"); g.setAttribute("aria-hidden", "true"); g.removeAttribute("data-hss");
      try { g.inert = true; } catch (e) {}
      g.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      g.querySelectorAll("[role]").forEach((n) => n.removeAttribute("role"));
      const gi = g.querySelector(".hss-in"); if (gi && S.input) gi.value = S.input.value;
      doc.body.appendChild(g);
      const gb = g.querySelector(".hss-body"); if (gb && S.body) gb.scrollTop = S.body.scrollTop;
      const done = () => { if (g.parentNode) g.parentNode.removeChild(g); };
      g.addEventListener("animationend", (e) => { if (e.target === g) done(); });
      setTimeout(done, 260);
    } catch (e) {}
  }

  function onInput() {
    const q = cleanQuery(S.input.value);
    S.q = q; S.err = false;
    clearTimeout(S.timer);
    if (S.ctrl) { try { S.ctrl.abort(); } catch (e) {} S.ctrl = null; }
    if (q.length < MIN) { S.groups = []; setLoading(false); render(); return; }
    setLoading(true);
    render();                                 // actions filter instantly; results follow
    S.timer = setTimeout(() => run(q), DEBOUNCE);
  }
  function setLoading(on) { S.loading = on; if (S.spin) S.spin.hidden = !on; }

  async function run(q) {
    const st = global.BPStore;
    const my = ++S.seq;
    let ctrl = null;
    try { ctrl = new AbortController(); } catch (e) {}
    S.ctrl = ctrl;
    setLoading(true);
    try {
      const data = st && typeof st.search === "function" ? await st.search(q, { signal: ctrl ? ctrl.signal : undefined }) : {};
      if (my !== S.seq || !S.open) return;    // a newer request superseded this one
      S.groups = normalize(data); S.err = false;
    } catch (e) {
      if (my !== S.seq || !S.open) return;
      if (e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")))) return;
      S.groups = []; S.err = true;
    }
    setLoading(false);
    render();
  }

  // flattened model of what's on screen: [{group, rows:[{kind, label, sub, icon, href, q?}]}]
  // empty-state hook: recently opened records from nav-trail.js (HelmTrail.recent()); own pages only
  function recentRecords() {
    let list = [];
    try { const t = global.HelmTrail; list = t && typeof t.recent === "function" ? t.recent() : []; } catch (e) { list = []; }
    if (!Array.isArray(list)) return [];
    const t = global.HelmTrail || {};
    return list.slice(0, 5).map((r) => {
      const href = r && typeof r.href === "string" ? r.href : "";
      if (!href || !/^[a-z0-9-]+\.html(?:[?#][^\s\\]*)?$/i.test(href)) return null;
      const kind = String(r.kind || "record");
      return { title: String(r.title || "").slice(0, 120), href, icon: (t.ICONS && t.ICONS[kind]) || "📄", ico: ICO_RECORD[kind] || "page",
        sub: ((t.KIND_LABEL && t.KIND_LABEL[kind]) || "Record") + (r.at && t.timeAgo ? " · " + t.timeAgo(r.at) : "") };
    }).filter((r) => r && r.title);
  }
  function sections() {
    const out = [];
    const q = S.q;
    if (q.length < MIN) {
      const recs = recentRecords();
      if (recs.length) out.push({ key: "records", label: "Recently opened",
        rows: recs.map((r) => ({ kind: "record", label: r.title, sub: r.sub, icon: r.icon, ico: r.ico, href: r.href })) });
      const rec = recentGet();
      if (rec.length) out.push({ key: "recent", label: "Recent searches", clear: true,
        rows: rec.map((r) => ({ kind: "recent", label: r, sub: "", icon: "🕘", ico: "clock", q: r })) });
    } else {
      const loc = localHits(q, S.local);
      if (loc.length) out.push({ key: "goto", label: "Pages & settings", rows: loc });
      S.groups.forEach((g) => out.push({ key: g.type, label: g.label,
        rows: g.items.map((it) => ({ kind: "result", label: it.title, sub: it.subtitle, icon: g.icon, ico: ICO_RESULT[g.type] || "page", href: it.href })) }));
    }
    const acts = (S.actions || []).filter((a) => trialAction(a) && matchAction(a, q)).slice(0, q.length ? 4 : 8);
    if (acts.length) out.push({ key: "actions", label: q.length ? "Actions" : "Quick actions",
      rows: acts.map((a) => ({ kind: "action", label: a.label, sub: "", icon: a.icon, ico: ICO_ACTION[a.id] || (/^(new|add)\b/i.test(a.label) ? "plus" : "arrow"), href: a.href })) });
    return out;
  }

  function render() {
    if (!S.list) return;
    const list = S.list; list.textContent = "";
    S.opts = []; S.active = -1;
    const secs = sections();
    const q = S.q;
    let n = 0;
    secs.forEach((sec, gi) => {
      const grp = el("div", { class: "hss-grp", role: "group", "aria-labelledby": "hssG" + gi, "data-g": String(gi) });
      const gh = el("div", { class: "hss-gh", id: "hssG" + gi, role: "presentation" }, sec.label);
      if (sec.clear) {
        const b = el("button", { type: "button", tabindex: "-1" }, "Clear");
        b.addEventListener("mousedown", (e) => { e.preventDefault(); recentClear(); render(); });
        gh.appendChild(b);
      }
      grp.appendChild(gh);
      sec.rows.forEach((r) => {
        const id = "hssO" + (n++);
        const o = el("div", { class: "hss-opt", role: "option", id, "aria-selected": "false", "data-g": String(gi) });
        const oi = el("span", { class: "hss-oi", "aria-hidden": "true" }); oi.appendChild(kindIcon(r.ico)); o.appendChild(oi);
        const t = el("span", { class: "hss-ot" });
        t.appendChild(r.kind === "result" || r.kind === "nav" || r.kind === "account" ? hl(el("span", { class: "hss-t" }), r.label, q) : el("span", { class: "hss-t" }, r.label));
        if (r.sub) t.appendChild(hl(el("span", { class: "hss-s" }), r.sub, q));
        o.appendChild(t);
        o.appendChild(el("kbd", { class: "hss-go hss-key", "aria-hidden": "true" }, "↵"));
        o.addEventListener("mousemove", () => { const i = S.opts.findIndex((x) => x.node === o); if (i !== S.active) setActive(i, false); });
        o.addEventListener("mousedown", (e) => e.preventDefault());
        o.addEventListener("click", (e) => { const i = S.opts.findIndex((x) => x.node === o); choose(i, e.metaKey || e.ctrlKey); });
        grp.appendChild(o);
        S.opts.push({ node: o, row: r, g: gi });
      });
      list.appendChild(grp);
    });

    let msg = "";
    if (S.err) {
      const m = el("div", { class: "hss-msg", role: "presentation" });
      m.appendChild(el("b", null, "Search isn't available right now"));
      m.appendChild(doc.createTextNode("Check your connection and try again."));
      const b = el("button", { type: "button" }, "Try again");
      b.addEventListener("click", () => { S.err = false; run(S.q); S.input.focus(); });
      m.appendChild(b); list.insertBefore(m, list.firstChild);
      msg = "Search failed.";
    } else if (q.length >= MIN && !S.loading && !S.groups.length && !S.opts.length) {
      const m = el("div", { class: "hss-msg", role: "presentation" });
      m.appendChild(el("b", null, "No matches for “" + q + "”"));
      m.appendChild(doc.createTextNode("Try a name, event code or receipt number. Only areas you have access to are searched."));
      list.insertBefore(m, list.firstChild);
      msg = "No results.";
    } else if (q.length >= MIN && S.loading) {
      msg = "Searching…";
    } else if (q.length >= MIN) {
      // QA B5: the number of rows actually listed (pages & settings + records + actions), not only the record groups
      const c = S.opts.length;
      msg = c + (c === 1 ? " result" : " results");
    } else if (!S.opts.length) {
      const m = el("div", { class: "hss-msg", role: "presentation" });
      m.appendChild(el("b", null, "Search your studio"));
      m.appendChild(doc.createTextNode("Type at least 2 letters to find leads, events, staff, vendors and more."));
      list.appendChild(m);
    }
    S.status.textContent = msg;
    if (S.opts.length) setActive(0, false); else S.input.removeAttribute("aria-activedescendant");
    if (S.body) { S.body.scrollTop = 0; moreHint(); }
  }

  function setActive(i, scroll) {
    if (!S.opts.length) return;
    if (S.active >= 0 && S.opts[S.active]) S.opts[S.active].node.setAttribute("aria-selected", "false");
    S.active = (i + S.opts.length) % S.opts.length;
    const o = S.opts[S.active].node;
    o.setAttribute("aria-selected", "true");
    S.input.setAttribute("aria-activedescendant", o.id);
    if (scroll !== false && typeof o.scrollIntoView === "function") { try { o.scrollIntoView({ block: "nearest" }); } catch (e) {} }
  }
  function jumpGroup(dir) {
    if (!S.opts.length) return;
    const cur = S.active >= 0 ? S.opts[S.active].g : -1;
    const gs = []; S.opts.forEach((o) => { if (gs.indexOf(o.g) < 0) gs.push(o.g); });
    let gi = gs.indexOf(cur) + dir;
    if (gi >= gs.length) gi = 0; if (gi < 0) gi = gs.length - 1;
    setActive(S.opts.findIndex((o) => o.g === gs[gi]));
  }
  function choose(i, newTab) {
    const o = S.opts[i]; if (!o) return;
    const r = o.row;
    if (r.kind === "recent") { S.input.value = r.q; onInput(); S.input.focus(); return; }
    if (r.kind === "result" || r.kind === "nav" || r.kind === "account") recentAdd(S.q);
    if (r.kind === "account") {
      close();
      try {
        if (global.HelmSearchCatalog && global.HelmSearchCatalog.openAccountItem) global.HelmSearchCatalog.openAccountItem(r.open || {}, global);
        else if (global.HelmAuthUI && global.HelmAuthUI.openAccount) global.HelmAuthUI.openAccount(r.open || {});
      } catch (e) {}
      return;
    }
    if (!r.href) return;
    if (newTab) { try { global.open(r.href, "_blank", "noopener"); } catch (e) {} return; }
    close();
    global.location.href = global.HelmUrl ? global.HelmUrl.upgrade(r.href) : r.href;
  }
  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(S.active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(S.active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (S.active >= 0) choose(S.active, e.metaKey || e.ctrlKey); }
    else if (e.key === "Tab") { e.preventDefault(); jumpGroup(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setActive(S.opts.length - 1); }
  }

  /* ---- top-bar trigger -------------------------------------------------------- */
  let trig = null;
  function makeTrigger() {
    const b = el("button", { type: "button", class: "hss-trig", id: "hssTrigger", "aria-haspopup": "dialog",
      "aria-keyshortcuts": isMac ? "Meta+K" : "Control+K", title: "Search (" + (isMac ? "⌘K" : "Ctrl+K") + ")", "aria-label": "Search your studio" });
    b.appendChild(searchIcon());
    b.appendChild(el("span", { class: "hss-tl", "aria-hidden": "true" }, "Search…"));
    b.appendChild(el("kbd", { class: "hss-kbd", "aria-hidden": "true" }, isMac ? "⌘K" : "Ctrl K"));
    b.addEventListener("click", () => open());
    return b;
  }
  function placeTrigger() {
    if (!doc.body) return;
    css();
    if (!trig) trig = makeTrigger();
    const mount = doc.getElementById("helm-topbar-search");
    if (mount) { if (trig.parentNode !== mount) { const old = doc.querySelector(".hss-slot"); mount.appendChild(trig); if (old && !old.firstChild) old.remove(); } return; }
    if (trig.isConnected) return;
    // fallback: own slot just left of the account chip (the element holding #logoutBtn)
    const lo = doc.getElementById("logoutBtn");
    const acct = lo && lo.parentNode && lo.parentNode !== doc.body ? lo.parentNode : null;
    if (acct && acct.parentNode) {
      const slot = el("span", { class: "hss-slot" }); slot.appendChild(trig);
      acct.parentNode.insertBefore(slot, acct);
    }
  }

  /* ---- landing helpers: ?hs=<text> fills the page's own search box; ?hs_act=new opens "new" -- */
  function landing() {
    let p; try { p = new URLSearchParams(global.location.search); } catch (e) { return; }
    const hk = p.get("hs_k");
    const hs = hk != null ? hsTake(hk) : p.get("hs"), act = p.get("hs_act");
    if (hs == null && act == null && hk == null) return;
    try { p.delete("hs"); p.delete("hs_k"); p.delete("hs_act"); const qs = p.toString();
      global.history.replaceState(global.history.state, "", global.location.pathname + (qs ? "?" + qs : "") + global.location.hash); } catch (e) {}
    let tries = 0;
    (function go() {
      if (hs != null) {
        const box = doc.getElementById("search");
        if (box && box.tagName === "INPUT") { box.value = cleanQuery(hs); box.dispatchEvent(new global.Event("input", { bubbles: true })); }
        else if (tries++ < 20) { setTimeout(go, 250); return; }
      }
      if (act === "new") {
        const nb = doc.getElementById("newBtn");
        if (nb && !nb.hidden) nb.click();
        else if (tries++ < 24) setTimeout(go, 250);
      }
    })();
  }

  /* ---- boot -------------------------------------------------------------------- */
  function pageKey() {
    try { return (global.location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "") || "index"; } catch (e) { return "index"; }
  }
  let booted = false, booting = null;
  // one boot at a time (auto-retry and a manual call must never both wire the shortcut)
  function boot() {
    if (booting) return booting;
    booting = doBoot().then((ok) => { if (!ok && !booted) booting = null; return ok; }, () => { booting = null; return false; });
    return booting;
  }
  async function doBoot() {
    if (booted || !doc || NOT_HERE[pageKey()]) return false;
    const st = global.BPStore;
    if (!st || !st.auth || typeof st.mode !== "function" || st.mode() !== "supabase" || !st.auth.user || !st.auth.user()) return false;
    let role = null; try { role = await st.auth.role(); } catch (e) {}
    if (!role || role === "client") { if (role) booted = true; return false; }
    booted = true;
    placeTrigger();
    try {
      let pending = false;
      new MutationObserver(() => { if (pending) return; pending = true; setTimeout(() => { pending = false; placeTrigger(); }, 80); })
        .observe(doc.body, { childList: true, subtree: true });
    } catch (e) {}
    doc.addEventListener("keydown", (e) => {
      const k = (e.key || "").toLowerCase();
      if (k === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) { e.preventDefault(); if (S.open) close(); else open(); return; }
      if (k === "/" && !S.open && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target, tag = t && t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
        e.preventDefault(); open();
      }
    });
    landing();
    return true;
  }
  function auto() {
    if (!doc) return;
    let tries = 0;
    (function go() { boot().then((ok) => { if (!ok && !booted && tries++ < 30) setTimeout(go, 400); }).catch(() => {}); })();
  }
  if (doc) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", auto); else auto(); }

  const api = { open, close, localEntries, localHits, boot, placeTrigger, normalize, highlight, cleanQuery, safeLink, matchAction, sections, recentRecords, recentGet, recentAdd, recentClear,
    TYPES, ACTIONS, MIN, MAX, DEBOUNCE, _css: CSS, _state: S };
  global.HelmStudioSearch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

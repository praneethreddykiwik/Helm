/* photo-render-ui.js - the builder's "✦ Render" dialog (migration 0095).
   Captures four reference pictures in the browser - (a) a clean 3D snapshot from the chosen
   camera (no labels), (b) the 2D plan without labels, (c) the 2D plan with names + measurements,
   (d) a colour-coded semantic map (one flat colour per object category, no text; drawSemantic) -
   builds the layout-exact prompt (HelmPhotoPrompt) and sends everything to the edge function
   render-photo (BPStore.photoRender.render). The image-service key lives ONLY on the server.
   Every user-facing string here is plain language (test/render-dialog-polish.test.mjs).
   Results: gallery with download, "Use in client booklet", regenerate, and past renders per event. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MAX_W = 1536;
  var state = { busy: false, ac: null, cancelled: false, last: null, cfg: null, fresh: null };

  function toast(m, o) { try { if (window.BPUI && BPUI.toast) BPUI.toast(m, o || {}); } catch (e) {} }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function ctx() { return typeof window.__helmPhotoCtx === 'function' ? window.__helmPhotoCtx() : null; }
  // the quote's freshest event meta (re-read on open / render: the builder tab may predate the flow's save)
  function withFresh(c, f) {
    if (!c) return c;
    f = f || state.fresh;
    if (f) { c.eventType = f.eventType || ''; c.eventDate = f.eventDate || c.eventDate; c.client = f.client || c.client; if (c.guests == null && f.guests != null) c.guests = f.guests; }
    var cl = c.client || {};
    if (!c.venueSettingSet && (cl.setting === 'outdoor' || cl.setting === 'indoor')) c.setting = cl.setting;
    return c;
  }
  async function refreshMeta(c) {
    if (!c || typeof c.refreshMeta !== 'function') return c;
    try { var f = await c.refreshMeta(); if (f) state.fresh = f; } catch (e) {}
    return withFresh(c);
  }
  // render context: what the photo will use (event type from the quote, else detected from the layout) + override
  function typeOverride() { var s = $('phTypeSel'); return s && s.value ? s.value : ''; }
  function renderContext(c) {
    var P = window.HelmPhotoPrompt, form = $('photoForm');
    if (!P || !P.contextLine || !form || !c) return null;
    var row = $('phCtxRow');
    if (!row) {
      row = el('div', 'ph-ctx'); row.id = 'phCtxRow';
      var line = el('p', 'ph-note'); line.id = 'phCtx'; line.setAttribute('aria-live', 'polite');
      var lab = el('label', 'pfield', 'Change event type ');
      var sel = el('select'); sel.id = 'phTypeSel';
      var o0 = el('option', null, 'As on the quote'); o0.value = ''; sel.appendChild(o0);
      Object.keys(P.PROFILES).forEach(function (k) { var o = el('option', null, P.PROFILES[k].label); o.value = k; sel.appendChild(o); });
      sel.addEventListener('change', function () { var cc = withFresh(ctx()); renderContext(cc); fitThemes(effective(cc)); });
      lab.appendChild(sel); row.appendChild(line); row.appendChild(lab);
      form.insertBefore(row, form.firstChild);
    }
    var info = P.contextLine({ items: c.items, world: c.world, eventType: c.eventType, setting: c.setting, eventDate: c.eventDate, override: typeOverride() });
    $('phCtx').textContent = info.text;
    return info;
  }
  // the ctx with the event type the render will actually use
  function effective(c) {
    var P = window.HelmPhotoPrompt; if (!c || !P || !P.contextLine) return c;
    var info = P.contextLine({ items: c.items, world: c.world, eventType: c.eventType, setting: c.setting, eventDate: c.eventDate, override: typeOverride() });
    var e = Object.assign({}, c); e.eventType = info.eventType; e.profile = info.profile; return e;
  }
  function api() { return window.BPStore && BPStore.photoRender ? BPStore.photoRender : null; }

  // which pictures go with which camera / plan shape
  function outputSize(camera, world) {
    if (camera === 'top' && world && world.h > world.w * 1.1) return '1024x1536';
    return '1536x1024';
  }
  function aspectFor(camera, world) { var o = outputSize(camera, world).split('x'); return (+o[0]) / (+o[1]); }
  // camera presets are computed from the layout itself (HelmPhotoPrompt.cameraView); "current" = the live 3D view
  function cameraOpts(camera, c, focus) {
    var o = { labels: 'none' }, P = window.HelmPhotoPrompt;
    if (camera === 'current') {
      // R49: during the walkaround the current stop is re-framed for the render's own 16:9 picture (no stop card in it)
      try { var wt = window.HelmWalkthrough && window.HelmWalkthrough._ui && window.HelmWalkthrough._ui.viewFor ? window.HelmWalkthrough._ui.viewFor(16 / 9) : null; if (wt) { o.view = wt; return o; } } catch (e) {}
      try { var h = window.__helm3D; if (h && h.isActive && h.isActive() && h.getView) { var g = h.getView(); if (g) { o.view = { pos: g.pos, target: g.target, fov: g.fov }; return o; } } } catch (e) {}
      camera = 'auto';   // 3D view not open: fall back to the best angle
    }
    if (camera === 'hero') camera = 'auto';
    if (!P || !P.cameraView || !c) { if (camera === 'top') o.topDown = true; return o; }
    var kind = camera === 'auto' && focus ? 'focus' : camera;
    var v = P.cameraView(kind, c.items, c.world, { aspect: aspectFor(camera, c.world), fov: camera === 'eye' ? 65 : 45, focus: focus });
    if (camera === 'top') o.topDown = true;
    else if (v && v.ok) o.view = { pos: v.pos, target: v.target, fov: v.fov };
    return o;
  }
  async function encode(blob) {
    if (!blob) throw new Error('A reference picture could not be drawn');
    var enc = await BPStore.booklet.encodeImage(blob, MAX_W, 0.85);
    if (!enc || !enc.data) throw new Error('A reference picture could not be prepared');
    return { mime: enc.mime, data: enc.data };
  }

  // reference image 4: flat colour per category on white, drawn from HelmPhotoPrompt.semanticMap (no text)
  function drawSemantic(items, world, maxW) {
    var P = window.HelmPhotoPrompt; if (!P || !P.semanticMap) return Promise.resolve(null);
    var m = P.semanticMap(items, world), S = Math.min(maxW / m.world.w, maxW / m.world.h);
    var cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(m.world.w * S)); cv.height = Math.max(1, Math.round(m.world.h * S));
    var g = cv.getContext('2d'); if (!g) return Promise.resolve(null);
    g.fillStyle = m.background; g.fillRect(0, 0, cv.width, cv.height);
    m.shapes.forEach(function (sh) {
      g.save(); g.translate((sh.x + sh.w / 2) * S, (sh.y + sh.h / 2) * S); g.rotate((sh.rot || 0) * Math.PI / 180);
      g.fillStyle = sh.color; g.fillRect(-sh.w * S / 2, -sh.h * S / 2, Math.max(1, sh.w * S), Math.max(1, sh.h * S));
      g.strokeStyle = '#FFFFFF'; g.lineWidth = 1; g.strokeRect(-sh.w * S / 2, -sh.h * S / 2, sh.w * S, sh.h * S);   // keeps touching objects countable
      g.restore();
    });
    return new Promise(function (res) { cv.toBlob(function (b) { res(b || null); }, 'image/png'); });
  }

  /* R160: what the stage / LED screens show. specs = HelmScreen.photoSpecs (plain data); the logos are loaded first
     (R154 wait, <= 6 s) so the 3D capture and the artwork show the picture, not the brand letter. */
  function screenSpecs(items) {
    var S = window.HelmScreen; if (!S || !S.photoSpecs) return [];
    try { return S.photoSpecs(items, 4); } catch (e) { return []; }
  }
  async function logosReady(c, specs) {
    var S = window.HelmScreen, refs = specs.filter(function (s) { return s.logoRef; }).map(function (s) { return s.logoRef; });
    if (!refs.length || !S) return;
    try { if (c && typeof c.logosReady === 'function') await c.logosReady(); else if (S.whenLogos) await S.whenLogos(refs, 6000); } catch (e) {}
  }
  function logoOk(ref) { var S = window.HelmScreen; return !!(ref && S && S.logoState && S.logoState(ref) === 'ok'); }
  // the data render-photo gets (never the logo's storage path): logo = true only when its picture really loaded
  function screenPayload(specs) {
    return specs.map(function (s) {
      return { kind: s.kind, type: s.type, count: s.count, layout: s.layout, theme: s.theme, bg: s.bg, ink: s.ink, sub: s.sub, accent: s.accent, accent2: s.accent2,
        customBg: !!s.customBg, title: s.title, brand: s.brand, tagline: s.tagline, subtitle: s.subtitle, dateLine: s.dateLine, logo: !!s.logo && logoOk(s.logoRef), mirrored: !!s.mirrored };
    });
  }
  // a flat picture of one screen face, drawn exactly like the 3D texture (HelmScreen.draw); portrait for side screens
  function drawScreenArt(spec) {
    var S = window.HelmScreen; if (!S || !S.draw || typeof document === 'undefined') return Promise.resolve(null);
    var side = spec.kind === 'side', W = side ? 720 : 1536, H = side ? 1280 : (spec.layout === 'wide' ? 640 : 864);
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var g = cv.getContext('2d'); if (!g) return Promise.resolve(null);
    var logo = spec.logoRef && S.logoImage ? S.logoImage(spec.logoRef) : null;
    try { S.draw(g, W, H, spec.content, { side: side, logo: logo }); } catch (e) { return Promise.resolve(null); }
    return new Promise(function (res) { try { cv.toBlob(function (b) { res(b || null); }, 'image/jpeg', 0.9); } catch (e) { res(null); } });   // a tainted canvas -> null (left out)
  }
  async function screenImages(specs) {
    var out = [], S = window.HelmScreen;
    for (var i = 0; i < specs.length && out.length < 2; i++) {
      var b = await drawScreenArt(specs[i]); if (!b) continue;
      try { var e = await encode(b); out.push({ mime: e.mime, data: e.data, role: 'screen', screen: i }); } catch (er) {}
    }
    var lg = specs.filter(function (s) { return s.logo && logoOk(s.logoRef); })[0];
    var u = lg && S && S.logoSnapshot ? S.logoSnapshot(lg.logoRef) : '';
    var m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(u || '');
    if (m && m[1].length < 2700000) out.push({ mime: 'image/png', data: m[1], role: 'logo' });
    return out;
  }
  // a render-photo older than R160 accepts only the 4 base pictures: it refuses before anything is charged
  function oldServerRefusal(e) { return !!e && e.status === 400 && /reference pictures/i.test(String(e.code || e.message || '')); }

  function setStep(text, pct) {
    $('phStep').textContent = text;
    var f = $('phBarFill'); f.className = 'w' + pct;
  }
  function showBusy(on) {
    state.busy = on;
    $('phProgress').hidden = !on;
    $('phGo').disabled = on;
    $('photoForm').querySelectorAll('select,input').forEach(function (n) { n.disabled = on; });
    if (!on) syncForm();
  }
  var OFF_MSG = 'Photo renders aren’t switched on for your studio yet.';
  var NO_PERM_MSG = 'You don’t have permission to make photo renders — ask your studio admin.';
  /* error code -> plain message (never shows server / technical wording) */
  var PLAIN = {
    render_not_configured: OFF_MSG, render_disabled: OFF_MSG, not_allowed: NO_PERM_MSG,
    render_quota: 'Your studio has used all of this month’s photo renders.',
    render_rate_limited: 'Too many photos requested in the last hour — please try again a little later.',
    render_blocked: 'That photo couldn’t be made from this plan — try a different style or decor theme.',
    render_busy: 'Photo renders are very busy right now — please try again in a minute.',
    not_found: 'This event couldn’t be found — save it and try again.',
    render_failed: 'The photo couldn’t be made this time — please try again.',
    render_timeout: 'The photo took too long — please try again.',
    /* R154a: the image service refused Helm itself (key / billing / model) - retrying will not help */
    render_provider_auth: 'Photo renders are paused — the image service connection needs renewing. Please let Helm support know (ref: provider_auth).',
    render_provider_billing: 'Photo renders are paused — the image service account needs topping up. Please let Helm support know (ref: provider_billing).',
    render_provider_model: 'Photo renders are paused — the image model isn’t available right now. Please let Helm support know (ref: provider_model).',
  };
  /* R154a: a short reference so support can tell failures apart (a code, never server wording or a key) */
  function refOf(e) {
    var c = String((e && e.code) || '').replace(/[^a-z0-9_]/gi, '').slice(0, 40);
    if (c) return c.replace(/^render_/, '');
    var s = e && e.status; return s ? 'http_' + (parseInt(s, 10) || 0) : 'unknown';
  }
  function plainError(e) {
    var c = e && e.code;
    if (c && PLAIN[c]) return PLAIN[c];
    return 'The photo couldn’t be made this time — please try again. (ref: ' + refOf(e) + ')';
  }
  function canManage() { return !!(state.cfg && state.cfg.can_manage); }
  // fetch to an undeployed edge function: CORS preflight 404 -> TypeError "Failed to fetch"
  function isNetErr(e) { return !!e && (e.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(e.message || ''))); }
  function showOff(msg, admin) {
    $('photoOff').hidden = false;
    $('photoOffMsg').textContent = msg;
    $('photoSetup').hidden = !admin;
  }

  /* R160: a past render is loaded from the database by its id (photo_render_image) each time it is shown - never a
     cached link - with one automatic retry; it is shown through a blob: link (Download works for large photos too).
     Until then a placeholder sits where the picture goes (no broken-image icon); a failure offers "Reload", and a
     photo that no longer exists says so. */
  var IMG_RETRY_MS = 700;
  /* R163: a slow database never leaves "Loading the photo…" up for ever - each fetch and the picture decode give up after
     a while and offer Reload (the same "couldn't be loaded" path as an error). */
  var IMG_FETCH_MS = 30000, IMG_DECODE_MS = 20000;
  function inTime(p, ms) {
    return new Promise(function (ok, no) {
      var t = setTimeout(function () { no(Object.assign(new Error('timeout'), { code: 'timeout' })); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); ok(v); }, function (e) { clearTimeout(t); no(e); });
    });
  }
  function dataUrlToBlob(u) {
    var m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(u || ''));
    if (!m) return null;
    try { var bin = atob(m[2]), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return new Blob([b], { type: m[1] }); } catch (e) { return null; }
  }
  async function fetchImage(id, A, wait) {
    A = A || api(); wait = wait == null ? IMG_RETRY_MS : wait;
    var last = null;
    for (var t = 0; t < 2; t++) {
      try { var u = await inTime(A.image(id), IMG_FETCH_MS); if (u) return u; last = new Error('empty'); }
      catch (e) { last = e; if (e && e.code === 'P0002') break; }   // that photo no longer exists: retrying will not help
      if (t === 0) await new Promise(function (ok) { setTimeout(ok, wait); });
    }
    var err = new Error('That photo could not be loaded'); err.code = last && last.code === 'P0002' ? 'missing' : 'failed'; throw err;
  }
  function card(r, src, opts) {
    var c = el('div', 'ph-card');
    // R163: lazy loading only for a picture shown at once. A hidden lazy <img> is never fetched by Chrome, Safari or
    // Firefox, so its onload never fired and a past render sat on "Loading the photo…" for ever.
    var img = el('img'); img.alt = 'Photo render of the event plan'; if (src) img.loading = 'lazy';
    var ph = null;
    if (src) { img.src = src; c.appendChild(img); }
    else { img.hidden = true; c.appendChild(img); ph = el('div', 'ph-ph', 'Photo not shown yet'); ph.setAttribute('role', 'img'); ph.setAttribute('aria-label', 'Photo not shown yet'); c.appendChild(ph); }
    var when = r.created_at ? new Date(r.created_at) : new Date();
    c.appendChild(el('div', 'ph-meta', [r.style, r.camera, r.quality].filter(Boolean).join(' · ') + ' · ' + when.toLocaleString()));
    var acts = el('div', 'ph-acts');
    var dl = el('a', 'tbtn', 'Download'); dl.download = 'event-photo-' + String(r.id || '').slice(0, 8) + '.jpg';
    var use = el('button', 'tbtn', 'Use in client booklet'); use.type = 'button';
    var loaded = src || '', pending = null, show = null;
    function failed(e) {
      var gone = e && e.code === 'missing';
      if (ph) { ph.textContent = gone ? 'This photo is no longer available.' : 'This photo couldn’t be loaded.'; ph.setAttribute('aria-label', ph.textContent); ph.hidden = false; }
      img.hidden = true; img.removeAttribute('src'); loaded = '';
      if (gone) { if (show) show.remove(); dl.hidden = true; use.hidden = true; }
      else if (show) { show.textContent = 'Reload'; show.disabled = false; }
      toast(gone ? 'That photo is no longer available.' : 'That photo couldn’t be loaded — please try again.', { type: 'err' });
    }
    function ensureSrc() {
      if (loaded) return Promise.resolve(loaded);
      if (pending) return pending;
      if (ph) ph.textContent = 'Loading the photo…';
      pending = fetchImage(r.id).then(function (u) {
        var b = dataUrlToBlob(u), href = b && window.URL && URL.createObjectURL ? URL.createObjectURL(b) : u;
        return inTime(new Promise(function (ok, no) {
          img.removeAttribute('loading');   // eager: the picture is still hidden until it has loaded
          img.onload = function () { img.hidden = false; if (ph) ph.hidden = true; ok(href); };
          img.onerror = function () { no(Object.assign(new Error('decode'), { code: 'failed' })); };
          img.src = href;
        }), IMG_DECODE_MS).catch(function (e) { throw Object.assign(new Error('decode'), { code: e && e.code === 'P0002' ? 'missing' : 'failed' }); });
      }).then(function (href) { loaded = href; dl.href = href; return href; })
        .finally(function () { pending = null; });
      return pending;
    }
    if (src) dl.href = src;
    else {
      show = el('button', 'tbtn', 'Show'); show.type = 'button';
      show.addEventListener('click', function () { show.disabled = true; ensureSrc().then(function () { show.remove(); show = null; }, failed); });
      acts.appendChild(show);
      dl.addEventListener('click', function (ev) { if (loaded) return; ev.preventDefault(); ensureSrc().then(function () { dl.click(); }, failed); });
    }
    use.addEventListener('click', async function () {
      use.disabled = true;
      try { await api().useInBooklet(r.id); toast('Added to the client booklet as its own photo (shown in the 3D section)', { type: 'ok' }); }
      catch (e) {
        var m = e && e.code === '22023' && /1\.5 MB/.test(String(e.message || '')) ? 'This photo is too large for the booklet — download it and add it by hand.'
          : e && e.code === 'P0002' ? 'That photo is no longer available.' : 'The photo couldn’t be added to the booklet — please try again.';
        toast(m, { type: 'err' });
      }
      finally { use.disabled = false; }
    });
    acts.appendChild(dl); acts.appendChild(use);
    if (opts && opts.readOnly) use.hidden = true;
    c.appendChild(acts);
    return c;
  }

  // R160: every open re-lists the renders from the database (fresh rows, no URLs kept between opens)
  var histSeq = 0;
  async function loadHistory() {
    var c = ctx(), list = $('phHistList'), seq = ++histSeq;
    list.replaceChildren();
    if (!c || !c.quoteId || !api()) return;
    try {
      var rows = await api().list(c.quoteId);
      if (seq !== histSeq) return;   // a newer open / render already redrew the list
      if (!rows.length) { list.appendChild(el('p', 'ph-meta', 'No photo renders for this event yet.')); return; }
      rows.forEach(function (r) { list.appendChild(card(r, null, { readOnly: c.readOnly })); });
    } catch (e) { if (seq === histSeq) list.appendChild(el('p', 'ph-meta', 'Past renders could not be loaded.')); }
  }

  async function refreshSettings() {
    var q = $('phQuota'); q.textContent = '';
    state.cfg = null;
    try { state.cfg = api() ? await api().settings() : null; } catch (e) { state.cfg = null; }
    var s = state.cfg;
    if (!s) return;
    if (s.enabled === false) showOff(OFF_MSG, !!s.can_manage);
    else if (s.can_render === false) showOff(NO_PERM_MSG, false);
    q.textContent = 'This month: ' + (s.used_this_month || 0) + ' of ' + (s.monthly_quota != null ? s.monthly_quota : '—') + ' photos used.';
  }

  async function run(params) {
    var c = ctx(), A = api();
    if (!c || !A) return;
    c = effective(await refreshMeta(c));
    var cl = c.client || {};
    if (!c.quoteId || !c.supported) { toast('Open a saved event to make photo renders.', { type: 'err' }); return; }
    if (c.frozen) { toast('This event is closed, so new photos can’t be made.', { type: 'err' }); return; }
    if (!c.items.length) { toast('Add some items to the floor first.', { type: 'err' }); return; }
    state.cancelled = false; state.last = params;
    $('phResults').hidden = true; $('photoOff').hidden = true;
    showBusy(true);
    try {
      var evening = false; try { evening = !!(window.__helm3D && __helm3D.isEvening && __helm3D.isEvening()); } catch (e) {}
      var specs = screenSpecs(c.items);
      if (specs.length) { setStep('Loading the screen logo…', 5); await logosReady(c, specs); if (state.cancelled) return; }
      var P = window.HelmPhotoPrompt.build({ screens: specs, items: c.items, world: c.world, eventType: c.eventType, guests: c.guests, setting: c.setting,
        evening: evening, style: params.style, images: 4, camera: params.camera, weather: params.weather, quality: params.quality, eventDate: c.eventDate, themeKey: params.themeKey, theme: params.theme, focus: params.focus, country: c.country,
        eventName: c.title, venueName: cl.venueName || cl.venue || '', city: cl.city || '', menuPackage: c.menuPackage || '' });
      setStep('Capturing the 3D view…', 10);
      if (!window.__capture3D) throw new Error('The 3D view is not loaded');
      var b3 = await window.__capture3D(MAX_W, cameraOpts(params.camera, c, params.focus));
      if (state.cancelled) return;
      setStep('Capturing the floor plan…', 25);
      var b2 = await c.planBlob({ clean: true, maxW: MAX_W, labels: 'none' });
      var b2m = await c.planBlob({ clean: true, maxW: MAX_W, labels: 'names', measure: true });
      if (state.cancelled) return;
      var bsem = await drawSemantic(c.items, c.world, MAX_W);
      var images = [await encode(b3), await encode(b2), await encode(b2m), await encode(bsem)];
      var extra = specs.length ? await screenImages(specs) : [];   // R160: screen artwork + logo (same single render, no extra cost per photo)
      setStep('Creating the photo… this takes about a minute' + (params.n > 1 ? ' (' + params.n + ' photos)' : ''), 40);
      state.ac = new AbortController();
      var slow = setTimeout(function () { if (state.busy) setStep('Still working — high quality photos can take up to 3 minutes…', 60); }, 45000);
      var res;
      try {
        var payload = { quote_id: c.quoteId, prompt: P.prompt, n: params.n, quality: params.quality === 'high' ? 'high' : 'standard',
          size: outputSize(params.camera, c.world), style: P.style, camera: P.camera + (P.focus ? ':' + P.focus : ''), theme: P.theme || 'none',
          images: images.concat(extra), screens: screenPayload(specs) };
        try { res = await A.render(payload, state.ac.signal); }
        catch (e1) {
          if (!extra.length || !oldServerRefusal(e1)) throw e1;
          payload.images = images; res = await A.render(payload, state.ac.signal);   // R160 fallback: an older render-photo (not yet redeployed)
        }
      } finally { clearTimeout(slow); }
      setStep('Done', 100);
      var g = $('phGallery'); g.replaceChildren();
      (res.renders || []).forEach(function (r) {
        g.appendChild(card({ id: r.id, style: P.style, camera: P.camera, quality: params.quality }, 'data:' + r.mime + ';base64,' + r.data, { readOnly: c.readOnly }));
      });
      $('phResults').hidden = false;
      if (res.quota != null) $('phQuota').textContent = 'This month: ' + res.used + ' of ' + res.quota + ' photos used.';
      loadHistory();
    } catch (e) {
      if (state.cancelled || (e && e.name === 'AbortError')) { toast('Render cancelled'); return; }
      var code = e && e.code;
      if (code === 'render_not_configured' || code === 'render_disabled' || isNetErr(e)) showOff(OFF_MSG, canManage());
      else if (code === 'not_allowed') showOff(NO_PERM_MSG, false);
      else {
        // R154a: log the reason code for support (codes only - the server never sends a key or provider text)
        try { console.warn('[photo-render] failed', { code: (e && e.code) || '', reason: (e && e.reason) || '', status: (e && e.status) || 0, job: (e && e.jobId) || '' }); } catch (_) {}
        toast(plainError(e), { type: 'err' });
      }
    } finally {
      state.ac = null; showBusy(false);
    }
  }

  function readForm() {
    var sel = $('phThemeSel').value, other = sel === 'other';
    var themeKey = other ? null : (window.HelmPhotoPrompt && HelmPhotoPrompt.THEMES[sel] ? sel : 'none');
    var wx = $('phWeather') ? $('phWeather').value : 'clear';
    return { weather: wx === 'partly' || wx === 'overcast' ? wx : 'clear', style: $('phStyle').value, camera: $('phCamera').value, focus: $('phFocus').value || '', quality: $('phQuality').value === 'high' ? 'high' : 'standard',
      n: Math.max(1, Math.min(4, parseInt($('phCount').value, 10) || 1)), themeKey: themeKey,
      theme: other ? String($('phTheme').value || '').trim().slice(0, 160) : '' };
  }
  function syncForm() {
    $('phCamHint').hidden = $('phCamera').value !== 'current';
    var other = $('phThemeSel').value === 'other';
    $('phThemeWrap').hidden = !other;
    // a highlight is an aerial close-up: only with the automatic camera
    var f = $('phFocus'); f.disabled = state.busy || $('phCamera').value !== 'auto'; if (f.disabled && !state.busy) f.value = '';
  }

  // decor themes that don't fit this event type (e.g. pastel florals for a political rally) are hidden;
  // 'None' then means the event type's own look
  function fitThemes(c) {
    var sel = $('phThemeSel'), P = window.HelmPhotoPrompt;
    if (!sel || !sel.options || !c || !P || !P.themesFor) return;
    var ok = P.themesFor(c.eventType, c.items);
    Array.prototype.forEach.call(sel.options, function (o) {
      var fits = o.value === 'none' || o.value === 'other' || ok.indexOf(o.value) >= 0;
      o.hidden = !fits; o.disabled = !fits;
    });
    if (ok.indexOf(sel.value) < 0 && sel.value !== 'other') sel.value = 'none';
  }
  // r20: free trial (html.helm-trial / HelmTrialLock) - the Render button shows the realistic 3D look, but AI photos are a
  // paid-plan feature (the server refuses photo_render_begin in the trial, 0173): the dialog never opens there
  var TRIAL_MSG = 'This is the realistic 3D look of your plan. AI photos of the plan come with a paid plan.';
  function inTrial() {
    try { if (window.HelmTrialLock && HelmTrialLock.isTrial && HelmTrialLock.isTrial()) return true; return document.documentElement.classList.contains('helm-trial'); } catch (e) { return false; }
  }
  function open() {
    if (inTrial()) { toast(TRIAL_MSG, { type: 'info', timeout: 5000 }); return; }
    var m = $('photoModal'); if (!m) return;
    var c = withFresh(ctx());
    var sel0 = $('phTypeSel'); if (sel0) sel0.value = '';
    renderContext(c);
    c = effective(c);
    var evening = false; try { evening = !!(window.__helm3D && __helm3D.isEvening && __helm3D.isEvening()); } catch (e) {}
    if (c && window.HelmPhotoPrompt) $('phStyle').value = HelmPhotoPrompt.defaultStyle(c.setting, evening, c.items);
    fitThemes(c);
    $('photoOff').hidden = true; $('phResults').hidden = true;
    syncForm();
    m.hidden = false;
    $('phGo').focus();
    var settingsReady = refreshSettings();
    if (!c || !c.quoteId || !c.supported) showOff('Open a saved event (signed in to your studio) to make photo renders.', false);
    else if (!api() || !api().available()) showOff(OFF_MSG, false);
    else if (api().probe) {
      // cheap pre-check: renders may not be switched on yet (admins see "contact Helm support")
      Promise.all([api().probe(), settingsReady]).then(function (r) { if (r[0] === false) showOff(OFF_MSG, canManage()); }).catch(function () {});
    }
    loadHistory();
    var base = ctx();
    if (base && base.refreshMeta) refreshMeta(base).then(function (fc) { if ($('photoModal').hidden || state.busy) return; renderContext(fc); fitThemes(effective(fc)); });
  }
  function close() {
    if (state.busy) cancel();
    $('photoModal').hidden = true;
  }
  function cancel() {
    state.cancelled = true;
    try { if (state.ac) state.ac.abort(); } catch (e) {}
    showBusy(false);
  }

  function wire() {
    var m = $('photoModal'); if (!m) return;
    $('photoForm').addEventListener('submit', function (ev) { ev.preventDefault(); if (!state.busy) run(readForm()); });
    $('phCancel').addEventListener('click', cancel);
    $('phCamera').addEventListener('change', syncForm);
    $('phThemeSel').addEventListener('change', syncForm);
    $('phAgain').addEventListener('click', function () { if (!state.busy) run(state.last || readForm()); });
    $('photoX').addEventListener('click', close);
    m.addEventListener('click', function (ev) { if (ev.target === m) close(); });
    m.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
    var b = document.querySelector('#viewSeg [data-v="render"]');
    // the 3D render view still opens behind the dialog (used by the "My current 3D view" camera)
    if (b) b.addEventListener('click', function () { setTimeout(open, 0); });
    // r20: in the free trial the tooltip says what Render does there (the paid-plan tooltip comes back after an upgrade)
    function syncTitle() {
      if (!b) return;
      if (!b.dataset.paidTitle) b.dataset.paidTitle = b.title || '';
      b.title = inTrial() ? 'Realistic 3D look of this plan (AI photos come with a paid plan)' : b.dataset.paidTitle;
    }
    syncTitle();
    try { window.addEventListener('helm:trial', syncTitle); } catch (e) {}
    try { new MutationObserver(syncTitle).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
  }
  window.HelmPhotoRenderUI = { card: card, loadHistory: loadHistory, fetchImage: fetchImage, screenSpecs: screenSpecs, screenPayload: screenPayload, screenImages: screenImages, oldServerRefusal: oldServerRefusal, renderContext: renderContext, effective: effective, withFresh: withFresh, fitThemes: fitThemes, drawSemantic: drawSemantic, open: open, close: close, outputSize: outputSize, cameraOpts: cameraOpts, plainError: plainError, readForm: readForm };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();

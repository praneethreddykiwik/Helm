/* dancers-3d.js — R137: the "Dancers" item in 3D as stylised dancers in costume (was: purple cylinders).
 *
 * Built only from three.js primitives (spheres, cylinders, cones, boxes): head + hair, neck, torso, hips,
 * upper / lower arms and legs, hands, feet, and a costume (lehenga skirt / kurta / classical fan skirt /
 * western dress or trousers). Each figure takes one of a few dance poses; costume colours and skin tones vary.
 * Cheap: the base shapes are made ONCE and shared; each dancer's parts are merged into one mesh per material
 * (skin, costume, trim, hair) when BufferGeometryUtils is there, so a dancer is ~4 draw calls and < 500 triangles.
 * Item properties (all optional - old layouts look like a Bollywood troupe in the item's colour):
 *   danceStyle  '' Bollywood | 'classical' (Bharatanatyam / Kathak) | 'western' (contemporary / hip-hop)
 *   count       how many dancers (the price spec); 1-8 figures are drawn, else from the zone size as before
 * item.color = the lead costume colour. No DOM, no network. Browser: window.HelmDancers; Node: module.exports.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HelmDancers = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var STYLES = [['', 'Bollywood'], ['classical', 'Classical (Bharatanatyam / Kathak)'], ['western', 'Western / contemporary']];
  var SKIN = ['#8d5524', '#c68642', '#e0ac69', '#a5694f', '#f1c27d', '#6b4226'];
  var PALETTE = {
    '': ['#e11d48', '#f59e0b', '#10b981', '#0d9488', '#db2777', '#0ea5e9'],
    classical: ['#b91c1c', '#047857', '#7e22ce', '#c2410c'],
    western: ['#111827', '#2563eb', '#f43f5e', '#f8fafc', '#16a34a']
  };
  var TRIM = { '': '#facc15', classical: '#d4af37', western: '#e5e7eb' };
  var HAIR = '#1b1410';
  // poses: angle of each limb segment in the body's frontal plane, measured from straight down (0 = down,
  // PI/2 = out to the side, PI = straight up); [left, right]. f* = how far the segment reaches forward (+z).
  var PI = Math.PI;
  var POSES = [
    { name: 'arms up',      ua: [2.5, 2.5], fa: [2.9, 2.9], th: [0.08, 0.08], sh: [0.04, 0.04], fua: 0.2, lean: 0 },
    { name: 'hip and wave', ua: [0.9, 2.6], fa: [-0.6, 3.0], th: [0.05, 0.22], sh: [0.05, -0.1], fua: 0.1, lean: 0.06 },
    { name: 'aramandi',     ua: [PI / 2, PI / 2], fa: [PI / 2 + 0.9, PI / 2 + 0.9], th: [0.55, 0.55], sh: [0.05, 0.05], fua: 0, lean: 0, squat: 0.45 },
    { name: 'step',         ua: [1.2, 0.5], fa: [1.9, 0.9], th: [0.05, -0.35], sh: [0.0, -0.1], fth: [0, 0.35], fua: 0.35, lean: -0.05 },
    { name: 'twirl',        ua: [PI / 2 + 0.25, PI / 2 + 0.25], fa: [PI / 2 + 0.35, PI / 2 + 0.35], th: [0.12, 0.12], sh: [0.06, 0.06], fua: 0, lean: 0 }
  ];
  var CLASSICAL_POSES = [2, 2, 1, 4];
  var own = Object.prototype.hasOwnProperty;
  function styleOf(it) { var s = it && it.properties && it.properties.danceStyle; return (typeof s === 'string' && own.call(PALETTE, s)) ? s : ''; }
  function countOf(it) {
    var p = (it && it.properties) || {}, n = Math.round(+p.count);
    if (isFinite(n) && n >= 1) return Math.min(8, n);
    var w = +it.width || 12, d = +it.height || 8;
    return Math.max(3, Math.min(8, Math.round(w * d / 16)));
  }
  function seeded(seed) { var s = seed >>> 0 || 1; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function hash(str) { var h = 2166136261; str = String(str || ''); for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // shared base shapes + materials (made once per THREE namespace)
  var KIT = null;
  function kit(THREE) {
    if (KIT && KIT.THREE === THREE) return KIT;
    var C = THREE.CylinderGeometry, S = THREE.SphereGeometry;
    KIT = {
      THREE: THREE,
      limb: new C(1, 1, 1, 6, 1, true),          // unit, scaled per segment
      body: new C(1, 1, 1, 8, 1, true),            // open: the ends are hidden by neck / hips / skirt
      skirt: new C(1, 1, 1, 10, 1, true),
      head: new S(1, 7, 5),
      hair: new S(1, 7, 3, 0, PI * 2, 0, PI * 0.55),
      ball: new S(1, 4, 2),
      foot: new THREE.BoxGeometry(1, 1, 1),
      mats: new Map()
    };
    return KIT;
  }
  function material(K, color, rough) {
    var key = color + '|' + rough, m = K.mats.get(key);
    if (!m) { m = new K.THREE.MeshStandardMaterial({ color: new K.THREE.Color(color), roughness: rough, metalness: 0 }); K.mats.set(key, m); }
    return m;
  }

  // one dancer's parts, grouped by material key: { skin: [[geo, matrix], ...], costume: [...], trim: [...], hair: [...] }
  function figureParts(THREE, K, o) {
    var parts = { skin: [], costume: [], trim: [], hair: [] }, V = THREE.Vector3, Y = new V(0, 1, 0);
    var mtx = function (pos, quat, scl) { return new THREE.Matrix4().compose(pos, quat || new THREE.Quaternion(), scl); };
    var put = function (bucket, geo, m) { parts[bucket].push([geo, m]); };
    var limb = function (bucket, A, B, r, geo) {
      var dir = new V(B.x - A.x, B.y - A.y, B.z - A.z), L = dir.length() || 0.01; dir.multiplyScalar(1 / L);
      var q = new THREE.Quaternion().setFromUnitVectors(Y, dir);
      put(bucket, geo || K.limb, mtx(new V((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2), q, new V(r, L, r)));
    };
    var P = o.pose, sq = P.squat || 0, lean = P.lean || 0;
    // body heights (ft): ~5.3 ft dancer; a squat (aramandi) lowers the hips
    var hipY = 3.05 - sq, chestTop = 4.45 - sq, headY = 4.92 - sq;
    var seg = function (from, ang, fwd, len, side) {
      var d = new V(Math.sin(ang) * side, -Math.cos(ang), fwd || 0).normalize();
      return new V(from.x + d.x * len, from.y + d.y * len, from.z + d.z * len);
    };
    // legs: hip -> knee -> ankle (the shin is solved so the foot reaches the floor)
    [-1, 1].forEach(function (side, i) {
      var hip = new V(side * 0.2, hipY, 0), thLen = 1.45, shLen = 1.45;
      var knee = seg(hip, P.th[i], (P.fth && P.fth[i]) || 0, thLen, side);
      var ankle = seg(knee, P.sh[i], 0, shLen, side);
      if (ankle.y > 0.18) { ankle.y = 0.18; }                       // stand on the floor
      if (sq) { var kneeOut = new V(knee.x + side * 0.15, knee.y, knee.z + 0.2); knee = kneeOut; ankle = new V(side * 0.55, 0.18, 0.05); }
      var legBucket = o.legs;   // costume (trousers / churidar) or skin
      limb(legBucket, hip, knee, 0.17);
      limb(legBucket, knee, ankle, 0.13);
      put(o.footBucket, K.foot, mtx(new V(ankle.x, 0.1, ankle.z + 0.12), null, new V(0.26, 0.2, 0.62)));
    });
    // hips + torso + neck + head + hair
    put(o.hipsBucket, K.body, mtx(new V(0, hipY + 0.15, 0), null, new V(0.36, 0.5, 0.26)));
    var tq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, lean));
    put('costume', K.body, mtx(new V(-Math.sin(lean) * 0.6, hipY + 0.75, 0), tq, new V(0.38, 1.05, 0.25)));
    if (o.trimBand) put('trim', K.body, mtx(new V(-Math.sin(lean) * 0.35, hipY + 0.42, 0), tq, new V(0.39, 0.12, 0.26)));
    put('skin', K.limb, mtx(new V(-Math.sin(lean) * 1.3, chestTop + 0.12, 0), null, new V(0.1, 0.3, 0.1)));
    var head = new V(-Math.sin(lean) * 1.45, headY, 0);
    put('skin', K.head, mtx(head, null, new V(0.31, 0.37, 0.33)));
    put('hair', K.hair, mtx(new V(head.x, head.y + 0.04, head.z - 0.03), null, new V(0.34, 0.38, 0.36)));
    if (o.bun) put('hair', K.ball, mtx(new V(head.x, head.y + 0.05, head.z - 0.36), null, new V(0.16, 0.16, 0.16)));
    // arms: shoulder -> elbow -> hand
    [-1, 1].forEach(function (side, i) {
      var sh = new V(-Math.sin(lean) * 1.1 + side * 0.44, chestTop - 0.05, 0);
      var el = seg(sh, P.ua[i], P.fua || 0, 0.95, side);
      var ha = seg(el, P.fa[i], 0.15, 0.85, side);
      limb(o.sleeves ? 'costume' : 'skin', sh, el, 0.1);
      limb('skin', el, ha, 0.08);
      put('skin', K.ball, mtx(ha, null, new V(0.1, 0.12, 0.1)));
      if (o.bangles) put('trim', K.limb, mtx(new V((el.x + ha.x * 3) / 4, (el.y + ha.y * 3) / 4, (el.z + ha.z * 3) / 4), new THREE.Quaternion().setFromUnitVectors(Y, new V(ha.x - el.x, ha.y - el.y, ha.z - el.z).normalize()), new V(0.095, 0.08, 0.095)));
    });
    // costume pieces below the waist
    if (o.dress === 'lehenga') {          // flared ankle-length skirt + a trim hem
      put('costume', K.skirt, mtx(new V(0, (hipY + 0.45) / 2, 0), null, new V(1, hipY - 0.05, 1)));
      parts.costume[parts.costume.length - 1].taper = [0.34, 1.05 + o.flare];
      put('trim', K.skirt, mtx(new V(0, 0.32, 0), null, new V(1, 0.14, 1)));
      parts.trim[parts.trim.length - 1].taper = [1.04 + o.flare, 1.08 + o.flare];
    } else if (o.dress === 'kurta') {      // knee-length tunic over the trousers
      put('costume', K.skirt, mtx(new V(0, hipY - 0.35, 0), null, new V(1, 1.2, 1)));
      parts.costume[parts.costume.length - 1].taper = [0.37, 0.5];
    } else if (o.dress === 'fan') {        // classical pleated fan between the knees + a gold hem
      put('costume', K.skirt, mtx(new V(0, hipY - 0.55, 0.05), null, new V(1, 1.1, 1)));
      parts.costume[parts.costume.length - 1].taper = [0.33, 0.62 + o.flare * 0.5];
      put('trim', K.skirt, mtx(new V(0, hipY - 1.1, 0.05), null, new V(1, 0.1, 1)));
      parts.trim[parts.trim.length - 1].taper = [0.62 + o.flare * 0.5, 0.64 + o.flare * 0.5];
    } else if (o.dress === 'short') {      // western: short flared dress
      put('costume', K.skirt, mtx(new V(0, hipY - 0.3, 0), null, new V(1, 0.9, 1)));
      parts.costume[parts.costume.length - 1].taper = [0.34, 0.6 + o.flare * 0.5];
    }
    return parts;
  }
  // a tapered copy of the unit skirt cylinder (top radius, bottom radius) - cones are cheaper than a lathe
  function taperGeo(THREE, cache, top, bottom) {
    var key = top.toFixed(2) + '|' + bottom.toFixed(2), g = cache.get(key);
    if (!g) { g = new THREE.CylinderGeometry(top, bottom, 1, 10, 1, true); cache.set(key, g); }
    return g;
  }
  // a dancer's looks, chosen from its index + the item's seed (stable between rebuilds)
  function figureOptions(style, i, rand, lead) {
    var pal = PALETTE[style], costume = i === 0 ? lead : pal[(i - 1 + Math.floor(rand() * pal.length)) % pal.length];
    var o = { costume: costume, trim: TRIM[style], skin: SKIN[Math.floor(rand() * SKIN.length) % SKIN.length], flare: rand() * 0.25 };
    if (style === 'classical') {
      o.dress = 'fan'; o.legs = 'costume'; o.footBucket = 'skin'; o.hipsBucket = 'trim'; o.trimBand = true; o.bun = true; o.bangles = true; o.sleeves = true;
      o.pose = POSES[CLASSICAL_POSES[i % CLASSICAL_POSES.length]];
    } else if (style === 'western') {
      var dress = i % 2 === 0;
      o.dress = dress ? 'short' : 'none'; o.legs = dress ? 'skin' : 'trim'; o.footBucket = 'hair'; o.hipsBucket = dress ? 'costume' : 'trim'; o.bun = false;
      o.trim = dress ? '#e5e7eb' : '#1f2937'; o.sleeves = !dress;
      o.pose = POSES[[3, 0, 4, 1][i % 4]];
    } else {
      var lehenga = i % 3 !== 1;
      o.dress = lehenga ? 'lehenga' : 'kurta'; o.legs = lehenga ? 'skin' : 'trim'; o.footBucket = 'skin'; o.hipsBucket = 'costume';
      o.trimBand = true; o.bun = lehenga; o.bangles = lehenga; o.sleeves = !lehenga; if (!lehenga) o.trim = '#f8fafc';
      o.pose = POSES[[0, 1, 4, 3, 0][i % 5]];
    }
    return o;
  }

  /* build(THREE, group, item): adds the dancers (and a faint floor mark) to group. Returns true when it drew. */
  function build(THREE, g, it) {
    if (!THREE || !g || !it || typeof THREE.CylinderGeometry !== 'function') return false;
    var K = kit(THREE), style = styleOf(it), n = countOf(it), w = Math.max(2, +it.width || 12), d = Math.max(2, +it.height || 8);
    var rand = seeded(hash(it.id || 'dancers')), lead = /^#[0-9a-fA-F]{6}$/.test(String(it.color || '')) ? it.color : PALETTE[style][0];
    var BGU = THREE.BufferGeometryUtils && typeof THREE.BufferGeometryUtils.mergeGeometries === 'function' ? THREE.BufferGeometryUtils : null;
    if (!K.taper) K.taper = new Map();
    // a faint performance mark on the floor (the old look was a solid purple slab)
    var mark = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, d), new THREE.MeshStandardMaterial({ color: new THREE.Color(lead), transparent: true, opacity: 0.12, roughness: 0.9 }));
    mark.position.y = 0.015; g.add(mark);
    var cols = Math.min(n, Math.max(1, Math.round(Math.sqrt(n * w / d)))), rows = Math.ceil(n / cols), tris = 0;
    for (var i = 0; i < n; i++) {
      var r = Math.floor(i / cols), c = i % cols, inRow = Math.min(cols, n - r * cols);
      var x = -w / 2 + w * (c + 0.5) / inRow + (rand() - 0.5) * 0.4, z = (rows > 1 ? -d / 2 + d * (r + 0.5) / rows : 0) + (r % 2 ? 0.3 : 0);
      var o = figureOptions(style, i, rand, lead), parts = figureParts(THREE, K, o);
      var mats = { skin: material(K, o.skin, 0.65), costume: material(K, o.costume, 0.55), trim: material(K, o.trim, 0.4), hair: material(K, HAIR, 0.8) };
      var fig = new THREE.Group(); fig.position.set(x, 0, z); fig.rotation.y = (rand() - 0.5) * 0.7;
      var s = 0.96 + rand() * 0.1; fig.scale.set(s, s, s);
      Object.keys(parts).forEach(function (key) {
        var list = parts[key]; if (!list.length) return;
        var geos = list.map(function (pm) { var base = pm.taper ? taperGeo(THREE, K.taper, pm.taper[0], pm.taper[1]) : pm[0]; var q = base.clone(); q.applyMatrix4(pm[1]); return q; });
        geos.forEach(function (q) { tris += triCount(q); });
        var merged = null;
        if (BGU && geos.length > 1) { try { merged = BGU.mergeGeometries(geos, false); } catch (e) { merged = null; } }
        if (merged) { geos.forEach(function (q) { q.dispose(); }); var mm = new THREE.Mesh(merged, mats[key]); mm.castShadow = true; fig.add(mm); }
        else geos.forEach(function (q) { var m1 = new THREE.Mesh(q, mats[key]); m1.castShadow = true; fig.add(m1); });
      });
      g.add(fig);
    }
    g.userData = g.userData || {}; g.userData.dancerTriangles = tris; g.userData.dancerCount = n;
    return true;
  }
  function triCount(geo) { var ix = geo.index, p = geo.attributes && geo.attributes.position; return ix ? ix.count / 3 : (p ? p.count / 3 : 0); }
  return Object.freeze({ STYLES: STYLES, POSES: POSES, SKIN: SKIN, PALETTE: PALETTE, styleOf: styleOf, countOf: countOf, build: build });
});

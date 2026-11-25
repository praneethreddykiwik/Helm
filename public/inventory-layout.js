/* =========================================================================
   HelmLayoutStock (R248, 0430) - the products of the 2D / 3D floor plan on the
   Inventory page: for each upcoming event, per stock item
     In layout   how many the latest floor plan needs (linked layout products)
     Reserved    what the event already holds (reserved or out)
     Free that day  what is still free on its stock days (Helm counts by DAY)
     Given out   of those, what is with a person now
     Missing     the rest - rent from a vendor / buy / leave unsourced
   plus "Same day as <event>" when another event on the same stock days holds or
   needs the same item, and the links (layout product -> stock item).
   Numbers come from the server (layout_stock_needs / layout_stock_overview).
   Reserving uses the existing reserve_inventory_with_sourcing, after a confirm.
   Pure helpers are unit-tested (Node: require()); the DOM part builds nodes only
   (createElement / textContent, no HTML strings, no inline styles - CSP).
   ========================================================================= */
(function (root) {
  "use strict";

  var CATS = { structure: "Structure", seating: "Seating", av: "AV & Stage", security: "Security", logistics: "Logistics", safety: "Safety", decor: "Decor" };
  var CAT_ORDER = ["seating", "structure", "av", "decor", "logistics", "security", "safety"];
  var HIDE_KEY = "helm.r248.notStock";
  var RANGES = [7, 14, 30, 60, 90];

  function n(x) { var v = Number(x); return isFinite(v) ? v : 0; }
  function fmt(x) { return Math.round(n(x)).toLocaleString("en-IN"); }
  function catName(k) { k = String(k || "").toLowerCase(); return CATS[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Other"); }
  // R252: the catalogue name of every floor-plan type (builder.js ASSETS, a test keeps both the same). The server's label is the
  // most used label typed ON the plan ("LED Screen L", "Section A"), so it is only used for a type the catalogue does not know.
  var LABELS = {
    stage: "Main Stage", dancefloor: "Dance Floor", podium: "Podium", press: "Press Riser", dj: "DJ Booth", chairrow: "Chair Row",
    seatblock: "Seating Block", table: "Round Table", barricade: "Barricade", fence: "Fence Line", booth: "Expo Booth", desk: "Reg Desk",
    truck: "Food Truck", exit: "Exit Zone", canopy: "Canopy", arch: "Arch / Backdrop", tent: "Tent", longtable: "Banquet Table",
    headtable: "Head Table", cocktail: "Cocktail Table", lounge: "Lounge Set", photobooth: "Photo Booth", checkpoint: "Checkpoint", bar: "Bar",
    buffet: "Buffet Line", gifttable: "Gift Table", caketable: "Cake Table", restroom: "Restrooms", ledscreen: "LED Screen", truss: "Truss Tower",
    speaker: "Speaker Stack", coatcheck: "Coat Check", firstaid: "First Aid", planter: "Greenery", redcarpet: "Carpet / Aisle",
    parking: "Parking Zone", sofa: "Sofa", loveseat: "Loveseat", armchair: "Armchair", ottoman: "Ottoman", bench: "Bench",
    coffeetable: "Coffee Table", floral: "Floral Centerpiece", floralarch: "Floral Arch", mandap: "Decor Mandap", pillar: "Decor Pillar",
    drape: "Pipe & Drape", chandelier: "Chandelier", fountain: "Fountain", uplight: "Uplight", heater: "Patio Heater", easel: "Signage Easel",
    chiavari: "Chair (single)", barstool: "Bar Stool", piano: "Grand Piano", bleacher: "Bleachers", linearray: "Line Array", subwoofer: "Subwoofer",
    monitor: "Stage Monitor", foh: "FOH Console", movinghead: "Moving Light", videowall: "LED Video Wall", generator: "Generator",
    distro: "Power Distro", cableramp: "Cable Ramp", greenroom: "Green Room", viprisers: "VIP Riser", stagebarrier: "Stage Barrier",
    lighting: "Lighting Truss", led: "LED Wall", chocolatefountain: "Chocolate Fountain", chariot: "Wedding Chariot", smoke: "Smoke Machine",
    dancers: "Dancers", walkway: "Walkway / Ramp", brandwall: "Branding Wall", entrancegate: "Entrance Gate", phoolchadar: "Phoolon ki Chadar",
    jhoola: "Swing / Jhoola", haldi: "Haldi Setup", mehendi: "Mehendi Lounge", selfieframe: "Selfie Frame", welcomeboard: "Welcome Board",
    fairylights: "Fairy Light Canopy", couplesofa: "Couple Sofa", livecounter: "Live Food Counter", kidszone: "Kids Zone",
    aircooler: "Air Cooler / Fan", floralentrance: "Entrance Floral Arch", stagebackdrop: "Stage Floral Backdrop", flowerwall: "Flower Wall",
    toran: "Garland Toran", floralpillar: "Floral Pillar", aislefloral: "Aisle Floral Stand", centrepiece: "Tall Centrepiece",
    balloonarch: "Balloon Arch", balloonbunch: "Balloon Bouquet", lectern: "Lectern", dais: "Dais with Chairs", flagstand: "Flag Stand",
    hoarding: "Banner / Hoarding Frame", patower: "PA Tower", lightingtree: "Lighting Tree (T-Bar)", diyastand: "Brass Deepam Stand",
    trophytable: "Trophy Display", havankund: "Havan Kund", rangoli: "Rangoli / Kolam", lanterns: "Lantern Cluster",
    hangingfloral: "Hanging Floral Ceiling", neonsign: "Neon Sign Wall", backdrop: "Backdrop (generic)", floralstand: "Floral Stand (generic)",
    decorbox: "Decor Item (generic)", signage: "Signage / Standee", recttable: "Rectangular Table", stageroof: "Stage Roof Truss",
    varmala: "Varmala Platform", micstand: "Mic Stand", teleprompter: "Teleprompter / Confidence Monitor", projector: "Projector Screen",
    tvstand: "TV Screen on Stand", interpreter: "Interpreter Booth", pyro: "Cold Pyro / CO2 Jet", towerlight: "Mobile Light Tower",
    gaddi: "Floor Seating (Gaddi)", urli: "Flower Urli", umbrellas: "Decor Umbrellas", doli: "Doli / Palki", kalash: "Kalash / Purna Kumbh",
    altar: "Pooja Altar / Idol Platform", shoerack: "Shoe Rack", dessert: "Dessert / Candy Table", coffee: "Coffee / Tea Station",
    stall: "Food / Merch Stall", counter: "Display Counter", plinth: "Display Plinth", kiosk: "Check-in Kiosk", ticketbooth: "Ticket Booth",
    stanchion: "Stanchions (rope & post)", watchtower: "Watch Tower / CCTV", extinguisher: "Fire Point", ambulance: "Ambulance Bay",
    lawnfloor: "Outdoor Lawn Flooring", stagelight: "Stage Light (PAR / beam / spot / flood)", pathlights: "Pathway / Rope Lights",
    sidescreen: "LED Side Screen", stagedeck: "Stage Extension", stagestairs: "Stage Stairs", installation: "Outdoor Decor Installation",
    jyothi: "Jyothi Prajwalana"
  };
  var FLOOR_SEATS = { sofa: 3, loveseat: 2, armchair: 1, ottoman: 1, bench: 2, lounge: 4 };   // builder.js: seats the planner counts for lounge furniture
  var ROWS = { seatblock: 1, chairrow: 1 };                                                  // the product IS its chairs: count per seat
  var TABLES = { table: 1, longtable: 1, headtable: 1, cocktail: 1, recttable: 1 };          // a table plus the seats around it
  var SINGLES = { chiavari: 1, barstool: 1 };                                                // one object = one seat
  var PLACES = { exit: 1, parking: 1 };                                                      // marks a place on the plan, nothing to bring
  // the looks of a single chair (builder.js VARIANT_STYLES): shown as a split, the stock link is per type
  var STYLES = { chiavari: { "": "Gold chiavari", ghost: "Ghost (clear acrylic)", crossback: "Wooden cross-back", folding: "Folding chair", banquet: "Banquet chair with cover + sash", plastic: "Plastic (outdoor)" },
    armchair: { "": "Armchair", vip: "VIP wingback chair", throne: "Maharaja / throne chair" } };
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function typeLabel(t, label) {
    var k = String(t || "").toLowerCase();
    if (has(LABELS, k)) return LABELS[k];
    if (label && String(label).trim()) return String(label).trim();
    var s = String(t || ""); return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Layout product";
  }
  // seats of one type line: the server's (rows x cols, seats, single chairs), else the planner's count for lounge furniture
  function seatsShown(t) { var k = String((t && t.layout_type) || ""); return n(t && t.seats) > 0 ? n(t.seats) : (has(FLOOR_SEATS, k) ? FLOOR_SEATS[k] * n(t && t.objects) : 0); }
  // "Round Table x 10 (80 seats)", "Chair (single) x 120"
  function countText(t) {
    var seats = seatsShown(t), single = has(SINGLES, String((t && t.layout_type) || "")) && seats === n(t.objects);
    return typeLabel(t && t.layout_type, t && t.label) + " x " + fmt(t && t.objects) + (seats > 0 && !single ? " (" + fmt(seats) + " seat" + (seats === 1 ? "" : "s") + ")" : "");
  }
  // per object or per seat, for a new link
  function linkMode(type, seats) { return has(ROWS, String(type || "")) && n(seats) > 0 ? "seats" : "objects"; }
  // what has to be brought for a product that is not linked: rows of chairs are chairs, everything else is the object itself
  function thingOf(t) {
    var nm = typeLabel(t.layout_type, t.label);
    return has(ROWS, t.layout_type) ? { label: "Chairs for " + nm, qty: n(t.seats), mode: "seats" } : { label: nm, qty: n(t.objects), mode: "objects" };
  }
  // tables whose seats have no stock item yet: the chairs are in the plan but nobody counts them
  function seatGaps(block) {
    return ((block && block.types) || []).filter(function (t) {
      return t && has(TABLES, t.layout_type) && n(t.seats) > 0 && !((t.links || []).some(function (l) { return l && l.count_mode === "seats"; }));
    }).map(function (t) { return { layout_type: t.layout_type, name: typeLabel(t.layout_type, t.label), objects: n(t.objects), seats: n(t.seats), label: "Chairs for " + typeLabel(t.layout_type, t.label) }; });
  }
  // the other half: the chairs around a table are linked but the table itself is not - the server calls that table "linked"
  function tableGaps(block) {
    return ((block && block.types) || []).filter(function (t) { var l = (t && t.links) || []; return t && has(TABLES, t.layout_type) && l.length > 0 && !l.some(function (x) { return x && x.count_mode !== "seats"; }); });
  }
  // the words of a name that say what it is ("Round table 5ft" -> round, table); spelling and everyday names are folded
  var SAME = { microphone: "mic", mike: "mic", centrepiece: "centerpiece", centre: "center", couch: "sofa", settee: "sofa", colour: "color", genset: "generator", television: "tv",
    chivari: "chiavari", chavari: "chiavari", mandapam: "mandap", jyoti: "jyothi", prajwalan: "prajwalana", kalasham: "kalash", diya: "deepam", registration: "reg", barricading: "barricade" };
  function words(s) {
    return String(s || "").toLowerCase().replace(/·|demo|sample|\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").split(" ")
      .filter(function (w) { return w && !/^\d/.test(w) && ["ft", "m", "x", "the", "a", "of", "for", "and", "with", "set", "generic", "pcs", "single"].indexOf(w) < 0; })
      .map(function (w) { w = w.length > 3 ? w.replace(/(ches|shes|sses|xes)$/, function (e) { return e.slice(0, -2); }).replace(/([^s])s$/, "$1") : w; return has(SAME, w) ? SAME[w] : w; });
  }
  function subset(a, b) { return a.length > 0 && a.every(function (w) { return b.indexOf(w) >= 0; }); }
  // the thing itself is the last word that is not just a look or a size: "Sofa 3 seater white" = sofa, "Bar stool" = stool (not a bar),
  // "Chair cover" = cover (not a chair)
  var LOOKS = {}; "white black gold golden silver red blue green ivory pink brown cream large small big medium mini tall short seater wooden wood metal steel plastic acrylic outdoor indoor premium standard heavy duty new old type piece unit".split(" ").forEach(function (w) { LOOKS[w] = 1; });
  function head(w) { var l = (w || []).slice(); while (l.length > 1 && LOOKS[l[l.length - 1]]) l.pop(); return l[l.length - 1] || ""; }
  // the names a floor-plan type goes by: "Dessert / Candy Table" = dessert table, candy table; plus the safe everyday ones
  var ALSO = { dj: ["DJ console", "DJ table"], foh: ["Mixing console", "Sound console", "Sound mixer", "Audio mixer"], speaker: ["PA speaker", "Speaker"], subwoofer: ["Sub woofer"], monitor: ["Monitor speaker", "Floor monitor"],
    linearray: ["Linear array"], led: ["LED wall"], videowall: ["LED wall"], movinghead: ["Moving head"], stanchion: ["Rope barrier", "Queue barrier"], heater: ["Gas heater", "Outdoor heater"], smoke: ["Fog machine"],
    generator: ["DG set generator"], redcarpet: ["Red carpet"], tvstand: ["TV stand"], extinguisher: ["Fire extinguisher"], restroom: ["Portable toilet"], towerlight: ["Light tower"], truss: ["Truss"], diyastand: ["Deepam stand"], desk: ["Registration table"] };
  function namesOf(type, label) {
    var out = [], raw = String(typeLabel(type, label) || "").replace(/\(.*?\)/g, " "), alts = raw.split("/").map(function (x) { return x.trim(); }).filter(Boolean);
    out.push(words(raw));
    if (alts.length > 1) { var last = words(alts[alts.length - 1]); alts.forEach(function (x) { var w = words(x); if (!w.length) return;
      if (w.length === 1 && last.length > 1 && x !== alts[alts.length - 1]) w = w.concat(last.slice(-1)); out.push(w); }); }
    (has(ALSO, type) ? ALSO[type] : []).forEach(function (x) { out.push(words(x)); });
    return out.filter(function (w, i) { return w.length && out.findIndex(function (z) { return z.join(" ") === w.join(" "); }) === i; });
  }
  // how well a stock item fits a name: 4 = the same words, 3 = the name plus more words, 2 = a shorter name for it; 0 = not the same thing
  function fitScore(words0, itemWords) {
    if (!words0.length || !itemWords.length) return 0;
    if (subset(words0, itemWords) && subset(itemWords, words0)) return 4;
    if (head(words0) !== head(itemWords)) return 0;
    if (subset(words0, itemWords)) return 3;
    return itemWords.length > 1 && subset(itemWords, words0) ? 2 : 0;
  }
  // the catalogue product a name belongs to word for word: "Chocolate fountain" is that product, never the plain Fountain
  var EXACT = null;
  function ownType(w) {
    if (!EXACT) { EXACT = {}; Object.keys(LABELS).forEach(function (t) { namesOf(t).forEach(function (x) { var k = x.slice().sort().join(" "); if (!has(EXACT, k)) EXACT[k] = t; }); }); }
    var k = w.slice().sort().join(" "); return has(EXACT, k) ? EXACT[k] : "";
  }
  // every stock item that fits a product by name, the best fits only
  function fits(names, items, not, type) {
    var best = [], bestScore = 0;
    (items || []).forEach(function (i) {
      if (!i || i.active === false || (not && not[i.id])) return;
      var w = words(i.name), sc = names.reduce(function (a, nm) { return Math.max(a, fitScore(nm, w)); }, 0);
      if (!sc || (sc < 4 && type && ownType(w) && ownType(w) !== type)) return;
      if (sc > bestScore) { best = [i]; bestScore = sc; } else if (sc === bestScore) best.push(i);
    });
    return best;
  }
  // { hit: the one stock item that fits (null = none, or several fit equally well: the person picks), list: what could fit }. Never links by itself.
  function findFits(t, items, links, part) {
    var type = String((t && t.layout_type) || ""), not = {}, all = links || [];
    if (has(PLACES, type)) return { hit: null, list: [], seats: false };
    all.forEach(function (l) { if (l && l.layout_type === type) not[l.item_id] = 1; });
    var byId = {}; (items || []).forEach(function (i) { if (i && i.active !== false) byId[i.id] = i; });
    var seatPart = part === "seats" || has(ROWS, type), list = [];
    if (seatPart) {
      // the chair the studio already counts per seat for another product, else the only chair in stock
      var used = {}; all.forEach(function (l) { if (l && l.count_mode === "seats" && byId[l.item_id] && !not[l.item_id]) used[l.item_id] = 1; });
      var ids = Object.keys(used);
      list = ids.length === 1 ? [byId[ids[0]]] : Object.keys(byId).map(function (k) { return byId[k]; }).filter(function (i) { return !not[i.id] && head(words(i.name)) === (type === "cocktail" ? "stool" : "chair"); });
    } else if (type === "chiavari") {
      list = fits([["chiavari", "chair"]], items, not); if (list.length !== 1) { var ch = fits([["chair"]], items, not); if (!list.length) list = ch; }
    } else {
      list = fits(namesOf(type, t && t.label), items, not, type);
      // the short name of the type ("Stage" for Main Stage) only when the item is called exactly that
      var short = words(type)[0];
      if (!list.length && short && short.length > 3 && !has(TABLES, type) && !has(ROWS, type)) list = fits([[short]], items, not, type).filter(function (i) { return words(i.name).join(" ") === short; });
    }
    return { hit: list.length === 1 ? list[0] : null, list: list, seats: seatPart };
  }
  function suggestLink(t, items, links, part) {
    var f = findFits(t, items, links, part), hit = f.hit;
    return hit ? { item_id: hit.id, name: hit.name, total: hit.total_qty, mode: f.seats ? "seats" : "objects", per: 1 } : null;
  }
  // what one tap can do for each suggestion, in the order shown: two products that use the same item share what is free.
  // rows [{ item_id, want }], freeOf(id) -> number | null (not known yet), pending { id: already needed by linked products } -> [{ free, take, short }]
  function planTake(rows, freeOf, pending) {
    var left = {};
    return (rows || []).map(function (r) {
      var f = freeOf ? freeOf(r.item_id) : null; if (f == null || !isFinite(Number(f))) return { free: null, take: 0, short: 0 };
      if (!has(left, r.item_id)) left[r.item_id] = Math.max(Math.floor(n(f)) - n(pending && pending[r.item_id]), 0);
      var free = left[r.item_id], want = Math.max(Math.ceil(n(r.want)), 0), take = Math.min(free, want); left[r.item_id] = free - take;
      return { free: free, take: take, short: want - take };
    });
  }
  // "Gold chiavari 100, Folding chair 20" - the looks of the single chairs on the saved plan ("" when there is only the default one)
  function styleSplit(items, type) {
    var st = STYLES[type]; if (!st) return "";
    var c = {}; (items || []).forEach(function (i) { if (!i || String(i.type || "").toLowerCase() !== type) return; var k = String((i.properties && i.properties.style) || ""); if (!has(st, k)) k = ""; c[k] = (c[k] || 0) + 1; });
    var ks = Object.keys(c); if (!ks.length || (ks.length === 1 && ks[0] === "")) return "";
    return ks.sort(function (a, b) { return c[b] - c[a] || st[a].localeCompare(st[b]); }).map(function (k) { return st[k] + " " + fmt(c[k]); }).join(", ");
  }
  // out with a person now, of one event's item (the same rule as the "Out now" tile)
  function outQty(checkouts, itemId, quoteId) {
    return (checkouts || []).reduce(function (a, c) {
      if (!c || c.item_id !== itemId || (quoteId && c.quote_id !== quoteId) || (c.status !== "out" && c.status !== "partial")) return a;
      return a + Math.max(n(c.qty_out) - n(c.qty_in) - Math.max(n(c.written_off) - n(c.qty_damaged), 0), 0);
    }, 0);
  }
  // how much of a missing number the vendors on the event bring: agreed (booked / confirmed / delivered) and only asked
  function coverOf(missing, list) {
    var agreed = 0, asked = 0;
    (list || []).forEach(function (s) { if (s.cover === false) return; if (s.status === "enquiry") asked += n(s.qty); else agreed += n(s.qty); });
    var m = n(missing); return { agreed: Math.min(agreed, m), asked: Math.min(asked, Math.max(m - agreed, 0)), left: Math.max(m - agreed - asked, 0) };
  }
  // YYYY-MM-DD + k days (calendar days, no time zone shift)
  function addDays(ymd, k) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "")); if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + (Math.trunc(n(k)))));
    return d.toISOString().slice(0, 10);
  }
  // one item line -> the numbers the page shows
  function rowNums(it) {
    it = it || {};
    var needed = Math.max(n(it.needed), 0), held = Math.max(n(it.held), 0), free = Math.max(n(it.free), 0);
    var toReserve = it.to_reserve != null ? Math.max(n(it.to_reserve), 0) : Math.max(needed - held, 0);
    var toBorrow = it.to_borrow != null ? Math.max(n(it.to_borrow), 0) : Math.max(needed - held - free, 0);
    var shared = it.to_borrow_shared != null ? Math.max(n(it.to_borrow_shared), 0) : toBorrow;
    return { needed: needed, held: held, free: free, toReserve: toReserve, toBorrow: toBorrow, toBorrowShared: shared,
      short: toBorrow > 0, sharedShort: shared > toBorrow, covered: needed > 0 && toReserve === 0 };
  }
  // R261 (owner: "there are only 9 round tables, what is 81?"): how the number in the plan is made, when it is not simply one item per object
  //   { text: "9 tables x 9 each = 81", per, objects, odd: [{ type, label, per }] }  odd = the stock item is the product itself, yet counted more than once for one
  function plural(w, k) { w = String(w || "").toLowerCase(); return k === 1 ? w : /(s|x|ch|sh)$/.test(w) ? w + "es" : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : w + "s"; }
  function sumOf(it, types) {
    var bits = [], odd = [], plain = true;
    (types || []).forEach(function (t) {
      ((t && t.links) || []).forEach(function (l) {
        if (!l || !it || l.item_id !== it.item_id) return;
        var seats = l.count_mode === "seats", per = n(l.per_object) || 1, cnt = seats ? n(t.seats) : n(t.objects), lab = typeLabel(t.layout_type, t.label), w = head(words(lab)) || lab;
        if (per !== 1) plain = false;
        bits.push({ text: fmt(cnt) + " " + (seats ? plural("seat", cnt) : plural(has(TABLES, t.layout_type) ? "table" : w, cnt)) + (per !== 1 ? " \u00d7 " + fmt(per) + " each" : ""), needed: l.needed != null ? n(l.needed) : Math.ceil(cnt * per) });
        if (seats && per > 1 && ownThing(it.name) === "seats") odd.push({ type: t.layout_type, label: lab, per: per, word: "seat", seats: true });   // R262: "70 per seat" - a chair counts once per seat
        if (!seats && per > 1 && namesOf(t.layout_type, t.label).some(function (nw) { return fitScore(nw, words(it.name)) >= 2; })) odd.push({ type: t.layout_type, label: lab, per: per, word: has(TABLES, t.layout_type) ? "table" : w });
      });
    });
    if (plain) return { text: "", odd: odd };
    return { text: bits.map(function (b) { return b.text; }).join(" + ") + " = " + fmt(bits.reduce(function (a, b) { return a + b.needed; }, 0)), odd: odd };
  }
  // R262 (owner: "chairs should be independent and the tables independent, no options asked"): a chair or stool is one per seat, a table one per table
  function ownThing(name) { var w = head(words(name)); return w === "chair" || w === "stool" ? "seats" : w === "table" ? "objects" : ""; }
  // R266 (owner: "count these chairs as 1 only: 9 tables and 70 chairs"): the saved links that say anything else for a chair / a table, and what they become
  function wrongLinks(links) {
    var all = links || [];
    return all.filter(function (l) {
      if (!l || !has(TABLES, l.layout_type) && !has(ROWS, l.layout_type) && !has(SINGLES, l.layout_type)) return false;
      var own = ownThing(l.item_name), per = Number(l.per_object) || 1, mode = l.count_mode === "seats" ? "seats" : "objects"; if (!own) return false;
      if (own === "objects" && !has(TABLES, l.layout_type)) return false;
      if (own === "seats" && has(SINGLES, l.layout_type)) return per !== 1;   // a single chair on the plan is one object
      if (own !== mode) return !(own === "seats" && all.some(function (x) { return x && x !== l && x.layout_type === l.layout_type && x.count_mode === "seats"; }));
      return per !== 1;
    }).map(function (l) { return { id: l.link_id, type: l.layout_type, item_id: l.item_id, name: l.item_name, mode: has(SINGLES, l.layout_type) ? (l.count_mode === "seats" ? "seats" : "objects") : ownThing(l.item_name) }; });
  }
  // the stock items for one line, the likely ones first, each with what is free and what one press takes
  function choices(list, all, want, free) {
    var first = {}; (list || []).forEach(function (i) { first[i.id] = 1; });
    return (list || []).concat((all || []).filter(function (i) { return i && i.active !== false && !first[i.id]; }).sort(function (a, b) { return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" }); })).map(function (i) {
      var f = free ? free(i.id) : null, take = f == null ? null : Math.min(f, want); return { id: i.id, name: i.name, unit: i.unit || "", fit: !!first[i.id], free: f, take: take, short: take == null ? null : Math.max(want - take, 0) };
    });
  }
  // what the Missing column says about what vendors were asked for: never less than what was really asked
  function missText(r, cov, list) {
    if (!r.short) return { text: r.covered ? "Covered" : "-", cls: "" };
    var all = 0; (list || []).forEach(function (s) { if (s.cover !== false) all += n(s.qty); });
    var extra = Math.max(Math.round((all - r.toBorrow) * 100) / 100, 0);
    if (cov.left > 0) return { text: fmt(cov.left) + " missing", cls: "red", sub: all > 0 ? fmt(all) + " asked or agreed" : "" };
    if (!extra) return { text: cov.asked > 0 ? fmt(r.toBorrow) + " asked" : fmt(r.toBorrow) + " from vendor", cls: cov.asked > 0 ? "amber" : "green" };
    return { text: fmt(all) + (cov.asked > 0 ? " asked" : " from vendor"), cls: cov.asked > 0 ? "amber" : "green", sub: fmt(r.toBorrow) + " missing \u00b7 " + fmt(all) + (cov.asked > 0 ? " asked" : " agreed") + " (" + fmt(extra) + " more than needed)" };
  }
  // the item lines of one event block, grouped by the floor-plan category of their first layout product
  function groupItems(block) {
    var typeCat = {}, typeLbl = {}, typeObj = {};
    ((block && block.types) || []).forEach(function (t) { typeCat[t.layout_type] = t.category; typeLbl[t.layout_type] = typeLabel(t.layout_type, t.label); typeObj[t.layout_type] = t; });
    var groups = {};
    ((block && block.items) || []).forEach(function (it) {
      var types = (Array.isArray(it.types) ? it.types.slice() : []).sort();
      var key = String((types.length && typeCat[types[0]]) || "").toLowerCase() || "other";
      (groups[key] = groups[key] || []).push(Object.assign({}, it, { from: types.map(function (t) { return typeLbl[t] || typeLabel(t); }), fromText: types.map(function (t) { return typeObj[t] ? countText(typeObj[t]) : typeLabel(t); }) }));
    });
    return Object.keys(groups).sort(function (a, b) {
      var ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b); ia = ia < 0 ? 99 : ia; ib = ib < 0 ? 99 : ib;
      return ia - ib || a.localeCompare(b);
    }).map(function (k) {
      return { key: k, name: catName(k === "other" ? "" : k), items: groups[k].sort(function (a, b) { return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" }); }) };
    });
  }
  // what "Reserve from layout" will do: per item, how many to reserve, how many come from stock now, how many are short
  // only = { itemId, freeOnly }: one line of the table, and never more than is free (nothing is recorded as short)
  function reservePlan(block, only) {
    var lines = ((block && block.items) || []).filter(function (it) { return it && it.active !== false && (!only || !only.itemId || it.item_id === only.itemId); }).map(function (it) {
      var r = rowNums(it), fromStock = Math.min(r.toReserve, Math.floor(r.free));
      if (only && only.freeOnly) r.toReserve = Math.max(fromStock, 0);
      return { item_id: it.item_id, name: it.name || "Item", unit: it.unit || "", qty: Math.ceil(r.toReserve), fromStock: Math.max(fromStock, 0), short: Math.max(Math.ceil(r.toReserve) - Math.max(fromStock, 0), 0) };
    }).filter(function (l) { return l.qty > 0 && l.item_id; });
    return { lines: lines, qty: lines.reduce(function (a, l) { return a + l.qty; }, 0),
      fromStock: lines.reduce(function (a, l) { return a + l.fromStock; }, 0), short: lines.reduce(function (a, l) { return a + l.short; }, 0) };
  }
  // "Same day as Rao Rally" / "... and Gala" / "... + 2 more"
  function sameDayText(list) {
    var names = []; (list || []).forEach(function (s) { var t = String((s && s.event) || "").trim() || "another event"; if (names.indexOf(t) < 0) names.push(t); });
    if (!names.length) return "";
    if (names.length === 1) return "Same day as " + names[0];
    if (names.length === 2) return "Same day as " + names[0] + " and " + names[1];
    return "Same day as " + names[0] + " + " + (names.length - 1) + " more";
  }
  // the layout products of the upcoming events that are not linked to stock yet (one line per type)
  function unlinkedAll(overview, hidden) {
    var hid = hidden || {}, map = {};
    ((overview && overview.events) || []).forEach(function (ev) {
      (ev.unlinked || []).forEach(function (u) {
        if (!u || !u.layout_type || hid[u.layout_type]) return;
        var m = map[u.layout_type] || (map[u.layout_type] = { layout_type: u.layout_type, label: typeLabel(u.layout_type, u.label), category: u.category || "", objects: 0, seats: 0, events: 0 });
        m.objects += n(u.objects); m.seats += n(u.seats); m.events += 1;
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      var ia = CAT_ORDER.indexOf(String(a.category).toLowerCase()), ib = CAT_ORDER.indexOf(String(b.category).toLowerCase()); ia = ia < 0 ? 99 : ia; ib = ib < 0 ? 99 : ib;
      return ia - ib || a.label.localeCompare(b.label);
    });
  }
  // the top strip: Items, Units owned, Out now, Upcoming events short (null = not known yet)
  function strip(items, checkouts, overview) {
    var act = (items || []).filter(function (i) { return i && i.active !== false; });
    var out = (checkouts || []).reduce(function (a, c) {
      if (!c || (c.status !== "out" && c.status !== "partial")) return a;
      return a + Math.max(n(c.qty_out) - n(c.qty_in) - Math.max(n(c.written_off) - n(c.qty_damaged), 0), 0);
    }, 0);
    return { items: act.length, units: act.reduce(function (a, i) { return a + Math.max(n(i.total_qty), 0); }, 0), outNow: out,
      eventsShort: overview && overview.summary ? n(overview.summary.events_short) : null };
  }
  function shortOnly(events) { return (events || []).filter(function (e) { return n(e.short_items) > 0 || n(e.shared_items) > 0; }); }

  var api = { LABELS: LABELS, FLOOR_SEATS: FLOOR_SEATS, STYLES: STYLES, seatsShown: seatsShown, countText: countText, sumOf: sumOf, missText: missText, linkMode: linkMode, thingOf: thingOf, seatGaps: seatGaps, tableGaps: tableGaps,
    words: words, head: head, namesOf: namesOf, findFits: findFits, planTake: planTake, suggestLink: suggestLink, styleSplit: styleSplit, outQty: outQty, coverOf: coverOf, CATS: CATS, RANGES: RANGES, catName: catName, typeLabel: typeLabel, addDays: addDays, rowNums: rowNums, groupItems: groupItems,
    reservePlan: reservePlan, sameDayText: sameDayText, ownThing: ownThing, wrongLinks: wrongLinks, choices: choices, unlinkedAll: unlinkedAll, strip: strip, shortOnly: shortOnly, fmt: fmt };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  /* ------------------------------------------------------------------ DOM (browser only) */
  var doc = root.document;
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function $(id) { return doc.getElementById(id); }
  function toast(msg, type) { try { root.BPUI.toast(msg, { type: type || "info" }); } catch (e) {} }
  function friendly(e, action) { try { return root.BPUI.friendlyError(e, { action: action }); } catch (x) { return (e && e.message) || "Something went wrong."; } }
  function optName(s) { try { if (root.BPStore && typeof root.BPStore.sampleName === "function") return root.BPStore.sampleName(s); } catch (e) {} return String(s == null ? "" : s); }
  function readHidden() { try { var v = JSON.parse(root.localStorage.getItem(HIDE_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; } }
  function writeHidden(o) { try { root.localStorage.setItem(HIDE_KEY, JSON.stringify(o || {})); } catch (e) {} }
  function today() { try { var t = root.BPStore.todayLocal(); if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t; } catch (e) {} return new Date().toISOString().slice(0, 10); }

  var S = { last: null, fixed: {}, qbusy: false, o: null, quoteId: null, canEdit: false, overview: null, links: [], days: 30, shortOnly: false, hidden: readHidden(), available: null, busy: false,
    vend: null, canVendor: false, vendors: [], shorts: [], evs: {}, floor: null };   // R252: who may ask a vendor, the vendors, open shortages, per event its bookings / needs / check-outs, the open event's saved plan

  function fmtDate(d) { try { return S.o && S.o.fmtDate ? S.o.fmtDate(d) : String(d || ""); } catch (e) { return String(d || ""); } }
  function dateText(b) {
    if (!b || !b.from) return b && b.event_date ? fmtDate(b.event_date) : "No date yet";
    return b.to && b.to !== b.from ? fmtDate(b.from) + " - " + fmtDate(b.to) : fmtDate(b.from);
  }
  var STATUS = { confirmed: "Confirmed", quote: "Quote", draft: "Draft", sent: "Sent", approved: "Approved" };

  /* ---- R252: per line what is missing, and the ways to get it ---- */
  function ev(quoteId) { return S.evs[quoteId] || (S.evs[quoteId] = {}); }
  // the vendors already asked for this thing on this event ([] = none known)
  function asked(quoteId, thing) {
    var V = root.HelmStockVendor, e = ev(quoteId);
    if (!V || !V.sourcing) return [];
    var names = {}; S.vendors.forEach(function (v) { names[v.id] = v.name; });
    var sh = S.shorts.filter(function (x) { return x.quote_id === quoteId; });
    if (e.bookings) return V.sourcing(thing, { bookings: e.bookings, needs: e.needs || [], shortages: sh, vendors: S.vendors, requests: e.requests || [] });
    // the overview: only the stock shortfalls are known without one read per event
    return sh.filter(function (x) { return x.source === "vendor" && x.vendor_id && thing.itemId && x.item_id === thing.itemId; })
      .map(function (x) { return { vendorName: names[x.vendor_id] || "Vendor", qty: n(x.qty), status: "enquiry", statusText: "noted", cover: false }; });   // its booking is not read here (it may be cancelled): shown, never counted
  }
  function askedLine(list) {
    if (!list.length) return null;
    return h("span", { cls: "ls-from", text: "From vendors: " + list.map(function (s) { return optName(s.vendorName) + " " + fmt(s.qty) + " (" + s.statusText + ")"; }).join(", ") });
  }
  function vendorBtn(block, thing, primary) {
    if (!S.canVendor || !(thing.qty > 0)) return null;
    var b = h("button", { type: "button", cls: "btn sm ls-act" + (primary ? " primary" : ""), text: "Get " + fmt(thing.left != null ? thing.left : thing.qty) + " from a vendor", "aria-label": "Get " + fmt(thing.left != null ? thing.left : thing.qty) + " " + optName(thing.label) + " from a vendor" });
    b.addEventListener("click", function () { openVendor(block, thing, b); });
    return b;
  }
  function vendorDone() { S.evs = {}; Promise.resolve(S.o && S.o.reload && S.o.reload()).then(refresh); }
  function openVendor(block, thing, b) {
    root.HelmStockVendor.open({ quoteId: block.quote_id, label: thing.label, qty: thing.qty, itemId: thing.itemId || null, layoutType: thing.layoutType || null, returnFocus: b, onDone: vendorDone,
      need: { needed: thing.needed || thing.qty, held: thing.held || 0, free: thing.free }, many: S.missing && S.missing.length > 1 ? function () { openMany(block, b); } : null });
  }
  // R262 (owner: "assign multiple products to a single vendor, not one by one"): one request with everything that is missing; take off what is not for this vendor
  function openMany(block, b) {
    root.HelmStockVendor.askMany({ quoteId: block.quote_id, lines: S.missing || [], returnFocus: b, onDone: vendorDone });
  }
  function manyBtn(block) {
    if (!S.canVendor || !root.HelmStockVendor || !root.HelmStockVendor.askMany || !S.missing || S.missing.length < 2) return null;
    var b = h("button", { type: "button", cls: "btn sm ls-act", text: "Ask one vendor for several (" + fmt(S.missing.length) + ")" });
    b.addEventListener("click", function () { openMany(block, b); }); return b;
  }
  function linkBtn(u, sug) {
    var b = h("button", { type: "button", cls: "btn sm ls-act", text: "Link to " + optName(sug.name), title: optName(sug.name) });
    b.addEventListener("click", function () {
      if (b.disabled) return;
      var each = sug.mode === "seats" ? "1 per seat" : "1 per object";
      Promise.resolve(root.BPUI && root.BPUI.confirm ? root.BPUI.confirm("Count " + optName(sug.name) + " for every " + u.label + " in every floor plan (" + each + ")? You can remove the link any time. Nothing is reserved.", { title: "Link to stock?", okLabel: "Link" }) : true)
        .then(function (ok) {
          if (!ok) return; b.disabled = true;
          return root.BPStore.inventory.layout.setLink(u.layout_type, sug.item_id, sug.per, sug.mode).then(function () { toast("Linked " + u.label + " to " + optName(sug.name) + ".", "ok"); return refresh(); });
        }).catch(function (e) { b.disabled = false; toast(friendly(e, "link the product"), "err"); });
    });
    return b;
  }
  function pickBtn(u, row, text) {
    var b = h("button", { type: "button", cls: "btn sm ls-act", text: text, "aria-label": text + ": " + u.label, "aria-expanded": "false" });
    b.addEventListener("click", function () {
      var old = row.querySelector(".ls-ctl");
      if (old) { old.remove(); b.setAttribute("aria-expanded", "false"); return; }
      var c = linkControls(u); row.appendChild(c); b.setAttribute("aria-expanded", "true");
      var f = c.querySelector("select"); if (f) f.focus();
    });
    return b;
  }
  function outText(block, it, r) {
    if (r.held <= 0) return "-";                        // what is out is part of what is held
    var e = ev(block.quote_id);
    if (!e.checkouts) return "?";                         // not read (the event's own stock page shows it)
    var q = outQty(e.checkouts, it.item_id, block.quote_id); return q ? fmt(q) : "-";
  }
  // R261: change how many of the stock item one object takes (the same link, the same save)
  function perDialog(block, it, l, t, from) {
    var lab = typeLabel(t.layout_type, t.label), w = (has(TABLES, t.layout_type) ? "table" : head(words(lab)) || lab).toLowerCase();
    var per = h("input", { id: "ls_per1", type: "number", min: "0.01", step: "0.01", inputmode: "decimal", value: String(n(l.per_object) || 1) });
    var mode = n(t.seats) > 0 ? h("select", { id: "ls_per2", cls: "sel" }, [h("option", { value: "objects", text: "for ONE " + w }), h("option", { value: "seats", text: "for ONE seat" })]) : null;
    if (mode) mode.value = l.count_mode === "seats" ? "seats" : "objects";
    var out = h("p", { cls: "ls-sub", role: "status" }), show = function () { var p = Number(per.value), seats = mode && mode.value === "seats", cnt = seats ? n(t.seats) : n(t.objects);
      out.textContent = p > 0 ? "This event: " + fmt(cnt) + " " + (seats ? plural("seat", cnt) : plural(w, cnt)) + " \u00d7 " + fmt(p) + " = " + fmt(Math.ceil(cnt * p)) + " " + optName(it.name) + "." : ""; };
    per.addEventListener("input", show); if (mode) mode.addEventListener("change", show); show();
    modal("How many " + optName(it.name) + "?", h("div", {}, [h("p", { cls: "sub", text: "It counts for every floor plan with " + lab + ". Reservations and what vendors were asked stay as they are." + (n(t.seats) > 0 ? " Chairs are counted on their own line - do not add them here." : "") }),
      h("div", { cls: "fgrid" }, [h("div", { cls: "fld" }, [h("label", { "for": "ls_per1", text: "How many of this item for ONE " + w }), per]), mode ? h("div", { cls: "fld" }, [h("label", { "for": "ls_per2", text: "Counted" }), mode]) : null]), out]), "Save", function () {
      var p = Number(per.value); if (!(p > 0) || p > 10000 || Math.round(p * 100) / 100 !== p) { per.focus(); throw userErr("A number above 0, with at most 2 decimals."); }
      return root.BPStore.inventory.layout.setLink(t.layout_type, it.item_id, p, mode ? mode.value : l.count_mode).then(function () { toast("Saved.", "ok"); return refresh(); });
    });
  }
  function linkOf(block, it, type) { var hit = null; ((block && block.types) || []).forEach(function (t) { if (type && t.layout_type !== type) return; (t.links || []).forEach(function (l) { if (!hit && l && l.item_id === it.item_id) hit = { t: t, l: l }; }); }); return hit; }
  function changeBtn(block, it) {
    var b = h("button", { type: "button", cls: "ls-linkbtn", text: "Change", "aria-label": "Change how many " + optName(it.name) + " one product takes" });
    b.addEventListener("click", function () { var x = linkOf(block, it); if (x) perDialog(block, it, x.l, x.t, b); });
    return b;
  }
  function oddNote(block, it, o) {
    var row = h("span", { cls: "ls-odd", role: "note" }, ["Is it really " + fmt(o.per) + " per " + o.word.toLowerCase() + "? " + (o.seats ? "A chair counts once for one seat. " : "")]);
    // R261 (owner: "make chairs and table separate"): a table counts as a table, the chairs around it are their own line
    var lx = linkOf(block, it, o.type); if (!o.seats && lx && lx.t && n(lx.t.seats) > 0) row.appendChild(doc.createTextNode("Chairs are counted on their own line, so a table counts as 1. "));
    if (!S.canEdit) return row;
    var b = h("button", { type: "button", cls: "btn sm ls-act", text: "Use 1 per " + o.word.toLowerCase(), "aria-label": "Use 1 " + optName(it.name) + " per " + o.word.toLowerCase() });
    b.addEventListener("click", function () {
      if (b.disabled) return; var x = linkOf(block, it, o.type), now = x ? Math.ceil(n(o.seats ? x.t.seats : x.t.objects)) : 0;
      Promise.resolve(root.BPUI && root.BPUI.confirm ? root.BPUI.confirm("One " + optName(it.name) + " for every " + (o.seats ? "seat of " : "") + o.label + " in every floor plan. This event then needs " + fmt(now) + ". What is reserved or asked stays as it is.", { title: "Use 1 per " + o.word.toLowerCase() + "?", okLabel: "Use 1" }) : true).then(function (ok) {
        if (!ok) return; b.disabled = true;
        return root.BPStore.inventory.layout.setLink(o.type, it.item_id, 1, o.seats ? "seats" : "objects").then(function () { toast(optName(it.name) + ": 1 per " + o.word.toLowerCase() + " now.", "ok"); return refresh(); });
      }).catch(function (e) { b.disabled = false; toast(friendly(e, "change the link"), "err"); });
    });
    row.appendChild(b); return row;
  }
  // one event's numbers as a table (grouped by floor-plan category); mobile = one block per item (CSS)
  function needsTable(block) {
    var groups = groupItems(block);
    if (!groups.length) return null;
    var tb = h("tbody"), anyAct = false;
    groups.forEach(function (g) {
      tb.appendChild(h("tr", { cls: "ls-cat" }, [h("td", { colspan: "7", text: g.name })]));
      g.items.forEach(function (it) {
        var r = rowNums(it), sd = sameDayText(it.same_day), list = asked(block.quote_id, { itemId: it.item_id, label: it.name }), cov = coverOf(r.toBorrow, list);
        var split = S.floor && (it.types || []).map(function (t) { return styleSplit(S.floor.items, t); }).filter(Boolean).join(", ");
        var sum = sumOf(it, block.types), mt = missText(r, cov, list);
        var nameCell = h("td", { cls: "ls-name", "data-label": "Item" }, [
          h("span", { cls: "ls-iname", text: optName(it.name) }),
          it.fromText && it.fromText.length ? h("span", { cls: "ls-from", text: "From " + it.fromText.join(", ") }) : null,
          sum.text ? h("span", { cls: "ls-from ls-sum" }, [sum.text + " ", S.canEdit && !sum.odd.length ? changeBtn(block, it) : null]) : null,
          sum.odd.length ? oddNote(block, it, sum.odd[0]) : null,
          split ? h("span", { cls: "ls-from", text: "Looks on the plan: " + split }) : null,
          askedLine(list),
          (sd || r.sharedShort) ? h("span", { cls: "ls-chips" }, [
            sd ? h("span", { cls: "ls-chip same", text: sd, title: "Helm counts stock by day: these events use the same units on the same days." }) : null,
            r.sharedShort ? h("span", { cls: "ls-chip amber", text: "Short " + fmt(r.toBorrowShared) + " if all go ahead" }) : null]) : null,
          it.active === false ? h("span", { cls: "ls-chip", text: "Item switched off" }) : null]);
        var miss = h("td", { cls: "num", "data-label": "Missing" }, [!r.short ? h("span", { cls: "ls-ok", text: mt.text })
          : h("span", { cls: "ls-chip " + mt.cls, text: mt.text }), mt.sub ? h("span", { cls: "ls-from", text: mt.sub }) : null]);
        var acts = h("td", { cls: "ls-actcell" + (S.canEdit || S.canVendor ? "" : " none") });
        var fp = reservePlan(block, { itemId: it.item_id, freeOnly: true });
        if (S.canEdit && fp.qty > 0) {
          var rb = h("button", { type: "button", cls: "btn sm ls-act", text: "Reserve " + fmt(fp.qty), "aria-label": "Reserve " + fmt(fp.qty) + " " + optName(it.name) });
          rb.addEventListener("click", function () { reserveFlow(block, rb, { itemId: it.item_id, freeOnly: true }); });
          acts.appendChild(rb);
        }
        if (r.short && cov.left > 0 && it.active !== false) { var vb = vendorBtn(block, { itemId: it.item_id, label: it.name, qty: Math.ceil(r.toBorrow), left: Math.ceil(cov.left), needed: Math.ceil(r.needed), held: r.held, free: r.free }, true); if (vb) acts.appendChild(vb); }
        if (acts.firstChild) anyAct = true; else acts.classList.add("none");
        tb.appendChild(h("tr", { cls: r.short && cov.left > 0 ? "ls-short" : "" }, [
          nameCell,
          h("td", { cls: "num", "data-label": "In layout", text: fmt(r.needed) + (it.unit ? " " + it.unit : "") }),
          h("td", { cls: "num", "data-label": "Reserved", text: r.held ? fmt(r.held) : "-" }),
          h("td", { cls: "num", "data-label": "Given out", text: outText(block, it, r) }),
          h("td", { cls: "num", "data-label": "Free that day", text: fmt(r.free) }),
          miss, acts]));
      });
    });
    return h("div", { cls: "table-scroll ls-scroll" }, [h("table", { cls: "ls-tbl" + (anyAct ? "" : " noact") }, [
      h("thead", {}, [h("tr", {}, [h("th", { scope: "col", text: "Item" }), h("th", { scope: "col", cls: "num", text: "In layout" }),
        h("th", { scope: "col", cls: "num", text: "Reserved", title: "Held for this event, with what is given out" }), h("th", { scope: "col", cls: "num", text: "Given out" }),
        h("th", { scope: "col", cls: "num", text: "Free that day" }), h("th", { scope: "col", cls: "num", text: "Missing" }),
        h("th", { scope: "col", cls: "ls-actcell" }, [h("span", { cls: "sr-only", text: "Actions" })])])]),
      tb])]);
  }
  /* ---- R255: one tap = link the product to the stock item that fits AND reserve it for this event (owner: "make it intelligent") ---- */
  function freeOf(itemId) { try { var v = S.o && S.o.freeFor ? S.o.freeFor(itemId) : null; return v == null || !isFinite(Number(v)) ? null : Math.max(Math.floor(Number(v)), 0); } catch (e) { return null; } }
  function dayWord(block) { return !block || !block.from ? "free" : block.to && block.to !== block.from ? "free on those days" : "free that day"; }
  function uKey(u, part) { return u.layout_type + "|" + (part || ""); }
  // link first (the same link again is the same row), then ask the server what is still to reserve: a second tap, or another tab, finds 0
  function linkAndReserve(block, q) {
    var B = root.BPStore.inventory, had = (S.links || []).some(function (l) { return l && l.layout_type === q.type && l.item_id === q.item_id; }), done = { label: q.label, item: q.name, reserved: 0, short: q.want, link: null, res: null, newLink: !had };
    return B.layout.setLink(q.type, q.item_id, 1, q.mode).then(function (l) {
      if (!l) throw userErr("This needs the latest database update.");
      done.link = l.link_id || null;
      return B.layout.needs(block.quote_id);
    }).then(function (nd) {
      var it = ((nd && nd.items) || []).filter(function (x) { return x.item_id === q.item_id; })[0], r = rowNums(it || {});
      var take = it ? Math.min(q.want, q.most != null ? q.most : q.want, Math.ceil(r.toReserve), Math.floor(r.free)) : 0;
      if (!(take > 0)) return done;
      return B.reserve(q.item_id, block.quote_id, take, "From the floor plan: " + q.label).then(function (row) { done.reserved = take; done.short = Math.max(q.want - take, 0); done.res = row && row.id ? row.id : null; return done; },
        function (e) { done.err = friendly(e, "reserve"); return done; });   // the server said no (someone was faster): the link stays, nothing is reserved
    });
  }
  function doneText(d) {
    var what = d.reserved ? fmt(d.reserved) + " reserved" + (d.short ? ", " + fmt(d.short) + " still missing" : "") : d.err ? "nothing reserved: " + String(d.err).replace(/\.$/, "") : "nothing more to reserve";
    return d.label + " is linked to " + optName(d.item) + " - " + what + ".";
  }
  function afterReserve(block, list, failed) {
    S.last = { quoteId: block.quote_id, lines: list.map(doneText), res: list.filter(function (d) { return d.res; }).map(function (d) { return { id: d.res }; }), links: list.filter(function (d) { return d.newLink && d.link; }).map(function (d) { return d.link; }),
      note: list.some(function (d) { return d.newLink; }) ? "Helm remembers the link for your other events." : "" };
    failed = (failed || []).concat(list.filter(function (d) { return d.err; }).map(function (d) { return d.label + ": " + d.err; }));
    if (failed.length) toast("Not done: " + failed.join("; "), "err");
    var ok = list.filter(function (d) { return d.reserved; }).length; if (ok) toast(ok === 1 && list.length === 1 ? doneText(list[0]) : "Reserved " + ok + " of " + list.length + " items.", "ok");
    return Promise.resolve(S.o && S.o.reload && S.o.reload()).then(refresh);
  }
  function reserveBtn(block, q) {
    var b = h("button", { type: "button", cls: "btn sm ls-act primary", text: q.take < q.want ? "Reserve " + fmt(q.take) : "Reserve " + fmt(q.take) + " - " + fmt(q.free) + " " + dayWord(block), "aria-label": "Reserve " + fmt(q.take) + " " + optName(q.name) + " for " + q.label + ", " + fmt(q.free) + " " + dayWord(block) });
    b.addEventListener("click", function () {
      if (S.qbusy) return; S.qbusy = true; b.disabled = true; b.textContent = "Reserving...";
      linkAndReserve(block, q).then(function (d) { return afterReserve(block, [d]); }).catch(function (e) { toast((e && e.userText) || friendly(e, "reserve from stock"), "err"); return refresh(); })
        .then(idle, idle);
    });
    return b;
  }
  // R258 (owner: "assigning there would be good instead of multiple steps"): reserve and give it out in one go - the same two saves, one after the other
  function giveBtn(block, q) {
    if (!S.o || !S.o.give || !S.o.peopleSelect) return null;
    var b = h("button", { type: "button", cls: "btn sm ls-act", text: "Reserve and give to...", "aria-label": "Reserve " + fmt(q.take) + " " + optName(q.name) + " and give them to a person" });
    b.addEventListener("click", function () {
      if (S.qbusy) return; var sel = S.o.peopleSelect(); sel.setAttribute("aria-label", "Give to");
      modal("Reserve and give out", h("div", {}, [h("p", { cls: "sub", text: fmt(q.take) + " " + optName(q.name) + " for " + q.label + " are reserved and given to this person." }), sel]), "Reserve and give out", function () {
        var to = S.o.pickOf(sel); if (!to) return Promise.reject(userErr("Choose who gets it."));
        if (S.qbusy) return Promise.reject(userErr("Wait a moment - something is being saved.")); S.qbusy = true;
        return linkAndReserve(block, q).then(function (d) {
          if (!d.reserved) return afterReserve(block, [d]);
          return S.o.give(q.item_id, d.reserved, to).then(function (r) {
            return afterReserve(block, [d]).then(function () { toast(r.ok ? fmt(d.reserved) + " " + optName(q.name) + " given out to " + to.name + "." : fmt(d.reserved) + " reserved, but not given out: " + (r.err || "not enough is free in the store right now") + " Press Give out in its row to try again.", r.ok ? "ok" : "err"); }); });
        }).then(function (x) { idle(); return x; }, function (e) { idle(); throw e; });
      });
      setTimeout(function () { try { sel.focus(); } catch (e) {} }, 40);
    });
    return b;
  }
  // R257: free again = an Undo drawn while the save was still finishing becomes pressable (it was drawn enabled and did nothing for a moment)
  function idle() { S.qbusy = false; Array.prototype.forEach.call(doc.querySelectorAll(".ls-undo[data-wait]"), function (u) { u.removeAttribute("data-wait"); u.disabled = false; u.textContent = "Undo"; }); }
  // R257: "Reserve all" - the products that share a stock item or a product type one after the other, up to 3 such lanes side by side (the server
  // still checks every single reservation); a lost answer stops nothing
  function lanesOf(qs) {
    var lanes = [];
    qs.forEach(function (q) {
      var hit = lanes.filter(function (l) { return l.some(function (x) { return x.item_id === q.item_id || x.type === q.type; }); }), one = [];
      hit.forEach(function (l) { one = one.concat(l); lanes.splice(lanes.indexOf(l), 1); }); one.push(q); lanes.push(one);
    });
    return lanes;
  }
  function runLanes(lanes, n, work) {
    var i = 0;
    function next() { if (i >= lanes.length) return Promise.resolve(); var l = lanes[i++]; return l.reduce(function (p, q) { return p.then(function () { return work(q); }); }, Promise.resolve()).then(next); }
    var w = []; for (var k = 0; k < Math.min(n, lanes.length); k++) w.push(next());
    return Promise.all(w);
  }
  // while it runs: leaving the page asks first, and what was done is remembered in this tab (shown when the person comes back)
  var RUN_KEY = "helm.ls.run";
  function runMark(v) { try { if (v) sessionStorage.setItem(RUN_KEY, JSON.stringify(v)); else sessionStorage.removeItem(RUN_KEY); } catch (e) {} }
  function runRead() { try { var v = JSON.parse(sessionStorage.getItem(RUN_KEY) || "null"); return v && v.quoteId ? v : null; } catch (e) { return null; } }
  function leaveAsk(e) { e.preventDefault(); e.returnValue = ""; }
  function resumeNote() {
    var v = S.qbusy ? null : runRead(); if (!v || v.quoteId !== S.quoteId || !(v.done < v.total)) return null;
    var box = h("div", { cls: "ls-done", role: "status" }, [h("div", { cls: "ls-done-t" }, [h("b", { text: "Reserve all was stopped: " + fmt(v.done) + " of " + fmt(v.total) + " products were done." }),
      h("span", { cls: "ls-sub", text: "What was done stays. Press Reserve all suggested (or Reserve on a product) below for the rest - nothing is reserved twice." })])]);
    var x = h("button", { type: "button", cls: "btn sm ls-act", text: "OK", "aria-label": "Close this message" }); x.addEventListener("click", function () { runMark(null); box.remove(); }); box.appendChild(x);
    return box;
  }
  function reserveAllBtn(block, qs) {
    var b = h("button", { type: "button", cls: "btn primary sm ls-act", text: "Reserve all suggested (" + fmt(qs.length) + ")" });
    b.addEventListener("click", function () {
      if (S.qbusy) return;
      var ul = h("ul", { cls: "ls-plan" }, qs.map(function (q) { return h("li", {}, [h("b", { text: q.label }), ": reserve " + fmt(q.take) + (q.take < q.want ? " of " + fmt(q.want) : "") + " " + optName(q.name) + " (" + fmt(q.free) + " " + dayWord(block) + ")" + (q.take < q.want ? " - " + fmt(q.want - q.take) + " still missing" : "")]); }));
      var prog = h("p", { cls: "ls-prog", role: "status", hidden: true });
      modal("Reserve all suggested", h("div", {}, [prog, h("p", { cls: "sub", text: (block.title || "This event") + " · " + dateText(block) }), ul,
        h("p", { cls: "ls-sub", text: "Each product is linked to the stock item named here, so Helm knows it for your other events too. Nothing is taken out of the store yet." })]), "Reserve all (" + fmt(qs.length) + ")", function () {
        if (S.qbusy) return false; S.qbusy = true;
        var list = [], failed = [], done = 0, was = b.textContent;
        function tell() { var t = "Reserving " + fmt(done) + " of " + fmt(qs.length) + "..."; prog.hidden = false; prog.textContent = t + " Please stay on this page."; b.textContent = t; b.disabled = true; runMark({ quoteId: block.quote_id, done: done, total: qs.length }); }
        tell(); if (root.addEventListener) root.addEventListener("beforeunload", leaveAsk);
        function over() { if (root.removeEventListener) root.removeEventListener("beforeunload", leaveAsk); runMark(null); b.textContent = was; b.disabled = false; idle(); }
        return runLanes(lanesOf(qs), 3, function (q) { return linkAndReserve(block, q).then(function (d) { list.push(d); }, function (e) { failed.push(q.label + ": " + ((e && e.userText) || friendly(e, "reserve"))); }).then(function () { done++; tell(); }); })
          .then(function () { list.sort(function (x, y) { return qs.findIndex(function (q) { return q.label === x.label; }) - qs.findIndex(function (q) { return q.label === y.label; }); }); prog.textContent = "Saved. Reading the stock again..."; return afterReserve(block, list, failed); })
          .then(over, function (e) { over(); throw e; });
      });
    });
    return b;
  }
  // "Done: ..." with Undo: the reservations made just now are released (status only) and the links made just now are taken off; what was
  // given out meanwhile stays as it is
  function lastNote() {
    var L = S.last; if (!L || L.quoteId !== S.quoteId || !L.lines.length) return null;
    var box = h("div", { cls: "ls-done", role: "status" }, [h("div", { cls: "ls-done-t" }, [h("ul", {}, L.lines.map(function (t) { return h("li", { text: t }); })), L.note ? h("span", { cls: "ls-sub", text: L.note }) : null])]);
    if (S.canEdit && (L.res.length || L.links.length)) {
      // R257: the save is still finishing (the stock is being read again): Undo waits for it
      var u = h("button", { type: "button", cls: "btn sm ls-act ls-undo", text: S.qbusy ? "Saving..." : "Undo" }); if (S.qbusy) { u.disabled = true; u.setAttribute("data-wait", "1"); }
      u.addEventListener("click", function () {
        if (u.disabled || S.qbusy) return; u.disabled = true; S.qbusy = true; var B = root.BPStore.inventory;
        Promise.all([B.reservations(L.quoteId), B.checkouts.list(L.quoteId)]).then(function (r) {
          var out = {}; (r[1] || []).forEach(function (c) { if (c && (c.status === "out" || c.status === "partial")) out[c.item_id] = 1; });
          var ids = {}; L.res.forEach(function (x) { ids[x.id] = 1; });
          var mine = (r[0] || []).filter(function (x) { return ids[x.id] && x.status === "reserved"; }), kept = mine.filter(function (x) { return out[x.item_id]; }).length;
          return mine.filter(function (x) { return !out[x.item_id]; }).reduce(function (p, x) { return p.then(function () { return B.setResStatus(x.id, "cancelled"); }); }, Promise.resolve())
            .then(function () { return L.links.reduce(function (p, id) { return p.then(function () { return B.layout.removeLink(id); }); }, Promise.resolve()); }).then(function () { S.last = null; toast(kept ? "Undone, except what was already given out." : "Undone: nothing is reserved for it and the link is off.", "ok"); });
        }).catch(function (e) { toast(friendly(e, "undo"), "err"); }).then(function () { idle(); return Promise.resolve(S.o && S.o.reload && S.o.reload()).then(refresh); });
      });
      box.appendChild(u);
    }
    var x = h("button", { type: "button", cls: "btn sm ls-act", text: "OK", "aria-label": "Close this message" }); x.addEventListener("click", function () { S.last = null; box.remove(); }); box.appendChild(x);
    return box;
  }
  // a product of the plan with no stock item: its numbers, a suggestion, the ways to get it (q = what one tap can do, on the event's own page)
  function freeRow(block, u, thing, sub, part, q) {
    var list = asked(block.quote_id, { label: thing.label }), left = coverOf(thing.qty, list).left;
    var row = h("li", { cls: "ls-prow" + (q && q.state === "ok" ? " has-fit" : "") }), acts = h("div", { cls: "ls-pacts" });
    row.appendChild(h("div", { cls: "ls-pname" }, [h("b", { text: u.label + " x " + fmt(u.count) }), sub ? h("span", { cls: "ls-sub", text: sub }) : null, q && q.text ? h("span", { cls: "ls-fit is-" + q.state, text: q.text }) : null, askedLine(list)]));
    var pickU = { layout_type: u.layout_type, label: u.label, category: u.category, seats: u.seats, mode: part === "seats" ? "seats" : linkMode(u.layout_type, u.seats) };
    var vb = null;
    if (q) {
      var short = q.state === "ok" ? Math.max(left - q.take, 0) : left;
      if (q.state === "ok" && S.canEdit) { acts.appendChild(reserveBtn(block, q)); var gb = giveBtn(block, q); if (gb) acts.appendChild(gb); }
      vb = short > 0 ? vendorBtn(block, { label: thing.label, qty: Math.max(thing.qty - (q.state === "ok" ? q.take : 0), 0), left: short, needed: thing.qty, free: q.free, layoutType: u.layout_type }, q.state === "none" || q.state === "full") : null;
      if (vb) acts.appendChild(vb);
      if (S.canEdit && q.state === "full" && q.sug) acts.appendChild(linkBtn(u, q.sug));
      if (S.canEdit && q.state === "many") { row.appendChild(pickList(block, pickU, thing, q, left)); }   // the items that fit are on the page, each with what is free
      else if (S.canEdit) acts.appendChild(pickListBtn(block, pickU, thing, q, left, row, q.state === "none" ? "Use a stock item" : "Other item"));
    } else {
      if (S.canEdit) {
        var items = (S.o && S.o.items && S.o.items()) || [], sug = suggestLink(u.raw, items, S.links, part);
        if (sug) acts.appendChild(linkBtn(u, sug));
        acts.appendChild(pickBtn(pickU, row, sug ? "Other item" : "Link to stock"));
      }
      vb = left > 0 ? vendorBtn(block, { label: thing.label, qty: thing.qty, left: left, needed: thing.qty, layoutType: u.layout_type }, false) : null;
      if (vb) acts.appendChild(vb);
    }
    if (acts.firstChild) row.appendChild(acts);
    return row;
  }
  // R262 (owner: "the chairs available are this many, take them from resources and the rest from vendors - we have the names"): every stock item by name with
  // what is free that day and one button that takes it. No count is asked: a chair is one per seat, a table one per table, anything else one per object.
  function pickList(block, u, thing, q, want) {
    var items = (S.o && S.o.items && S.o.items()) || [], rows = choices(q.list || [], items, want, freeOf), seats = u.mode === "seats", shown = 0, all = !(q.list || []).length, box = h("div", { cls: "ls-pick" });
    var ul = h("ul", { cls: "ls-picks", "aria-label": "Stock items for " + u.label }), find = h("input", { type: "search", cls: "ls-find", placeholder: "Find a stock item", "aria-label": "Find a stock item for " + u.label });
    function draw() {
      clear(ul); shown = 0; var f = String(find.value || "").trim().toLowerCase();
      rows.forEach(function (c) {
        if (f ? String(c.name || "").toLowerCase().indexOf(f) < 0 : !(c.fit || all)) return; if (++shown > 40) return;
        var li = h("li", {}, [h("span", { cls: "ls-pickn" }, [h("b", { text: optName(c.name) }), h("span", { cls: "ls-sub", text: c.free == null ? "Checking what is free..." : fmt(c.free) + " " + dayWord(block) })])]);
        if (c.take > 0) {
          var b = h("button", { type: "button", cls: "btn sm ls-act primary" }), q0 = h("input", { type: "number", min: "1", max: String(c.take), step: "1", inputmode: "numeric", cls: "ls-qty", value: String(c.take), "aria-label": "How many " + optName(c.name) + " for " + u.label });
          var many = function () { var v = Number(q0.value); return v === Math.trunc(v) && v >= 1 && v <= c.take ? v : 0; };
          var say = function () { var v = many(), left = Math.max(want - v, 0); b.disabled = !v; b.textContent = !v ? "Use" : left > 0 ? "Use " + fmt(v) + ", " + fmt(left) + " from a vendor" : "Use " + fmt(v); b.setAttribute("aria-label", (v ? "Use " + fmt(v) + " " : "Use ") + optName(c.name) + " for " + u.label); };
          q0.addEventListener("input", say); say();
          b.addEventListener("click", function () {
            var v = many(); if (S.qbusy || !v) return; S.qbusy = true; q0.disabled = true; b.disabled = true; b.textContent = "Reserving...";
            linkAndReserve(block, { type: u.layout_type, label: u.label, item_id: c.id, name: c.name, mode: seats ? "seats" : "objects", want: want, most: v, take: v, free: c.free })
              .then(function (d) { return afterReserve(block, [d]).then(function () { idle(); if (d.reserved && d.short > 0 && S.canVendor) openVendor(block, { itemId: c.id, label: c.name, qty: d.short, needed: thing.qty, held: d.reserved, free: c.free == null ? null : Math.max(c.free - d.reserved, 0) }, null); }); })
              .catch(function (e) { toast((e && e.userText) || friendly(e, "reserve from stock"), "err"); return refresh(); }).then(idle, idle);
          });
          li.appendChild(h("span", { cls: "ls-usew" }, [q0, b]));
        } else if (c.free === 0) li.appendChild(h("span", { cls: "ls-sub", text: "None free" }));
        ul.appendChild(li);
      });
      if (!shown) ul.appendChild(h("li", { cls: "ls-sub", text: f ? "No stock item with this name." : "No stock items yet." }));
    }
    find.addEventListener("input", draw); draw(); box.appendChild(ul);
    var foot = h("div", { cls: "ls-pickf" }); if (items.length > 5 || all) foot.appendChild(find);
    if (!all) { var more = h("button", { type: "button", cls: "ls-linkbtn", text: "Show all stock items" }); more.addEventListener("click", function () { all = true; more.remove(); draw(); }); foot.appendChild(more); }
    var mk = h("button", { type: "button", cls: "ls-linkbtn", text: "+ New stock item" }); mk.addEventListener("click", function () { createFlow(u, 1, seats ? "seats" : "objects"); }); foot.appendChild(mk);
    box.appendChild(foot); return box;
  }
  function pickListBtn(block, u, thing, q, want, row, text) {
    var b = h("button", { type: "button", cls: "btn sm ls-act", text: text, "aria-label": text + ": " + u.label, "aria-expanded": "false" });
    b.addEventListener("click", function () {
      var old = row.querySelector(".ls-pick"); if (old) { old.remove(); b.setAttribute("aria-expanded", "false"); return; }
      var c = pickList(block, u, thing, q, want); row.appendChild(c); b.setAttribute("aria-expanded", "true"); var f = c.querySelector("input,button"); if (f) f.focus();
    });
    return b;
  }
  // what one tap can do for each unlinked line of the open event
  function quickPlan(block, lines) {
    var items = (S.o && S.o.items && S.o.items()) || [], pending = {};
    ((block && block.items) || []).forEach(function (it) { pending[it.item_id] = rowNums(it).toReserve; });
    var rows = lines.map(function (l) {
      var f = findFits(l.u.raw, items, S.links, l.part), list = asked(block.quote_id, { label: l.thing.label }), want = coverOf(l.thing.qty, list).left;
      return { f: f, want: want, item_id: f.hit ? f.hit.id : null, l: l };
    });
    var takes = planTake(rows.filter(function (r) { return r.item_id && r.want > 0; }), freeOf, pending), k = 0;
    return rows.map(function (r) {
      var l = r.l, hit = r.f.hit, day = dayWord(block);
      if (!(r.want > 0)) return { state: "asked", text: "" };
      if (hit) {
        var t = takes[k++], base = { type: l.u.layout_type, label: l.u.label, item_id: hit.id, name: hit.name, mode: r.f.seats ? "seats" : "objects", want: r.want, take: t.take, free: t.free, sug: { item_id: hit.id, name: hit.name, mode: r.f.seats ? "seats" : "objects", per: 1 } };
        base.list = r.f.list;
        if (t.free == null) return Object.assign(base, { state: "wait", text: "Matches your stock item " + optName(hit.name) + ". Checking what is free..." });
        if (t.take <= 0) return Object.assign(base, { state: "full", text: "Matches your stock item " + optName(hit.name) + ", but none is " + day + "." });
        return Object.assign(base, { state: "ok", text: t.short > 0 ? "Only " + fmt(t.take) + " of " + fmt(r.want) + " " + optName(hit.name) + " " + day + " - reserve " + fmt(t.take) + ", get " + fmt(t.short) + " from a vendor." : "Matches your stock item " + optName(hit.name) + "." });
      }
      if (r.f.list.length && r.f.list.every(function (i) { return freeOf(i.id) === 0; })) return { state: "none", list: r.f.list, text: "Needed " + fmt(r.want) + ". None of our " + fmt(r.f.list.length) + " that fit is " + day + "." };
      if (r.f.list.length) return { state: "many", list: r.f.list, text: "Needed " + fmt(r.want) + ". Pick which of ours to use:" };
      return { state: "none", list: [], text: "Needed " + fmt(r.want) + ". We don't have this in stock." };
    });
  }
  // everything of the open event that must come from outside: what stays short after our stock
  function missingOf(block, lines, plan) {
    var out = [];
    ((block && block.items) || []).forEach(function (it) { var r = rowNums(it), c = coverOf(r.toBorrow, asked(block.quote_id, { itemId: it.item_id, label: it.name })).left; if (c > 0 && it.active !== false) out.push({ label: it.name, qty: Math.ceil(c), needed: Math.ceil(r.needed), itemId: it.item_id }); });
    (lines || []).forEach(function (l, i) { var q = plan && plan[i], left = coverOf(l.thing.qty, asked(block.quote_id, { label: l.thing.label })).left, s = q && q.state === "ok" ? Math.max(left - q.take, 0) : q && (q.state === "many" || q.state === "wait") ? 0 : left;
      if (s > 0) out.push({ label: l.thing.label, qty: Math.ceil(s), needed: Math.ceil(l.thing.qty), layoutType: l.u.layout_type }); });
    return out;
  }
  function unlinkedPart(block, inPanel) {
    var un = ((block && block.unlinked) || []), lines = [], quiet = [];
    un.concat(inPanel ? tableGaps(block) : []).forEach(function (x) {
      if (S.hidden[x.layout_type] || has(PLACES, x.layout_type)) { quiet.push(countText(x)); return; }
      var t = thingOf(x), seats = seatsShown(x), sp = S.floor ? styleSplit(S.floor.items, x.layout_type) : "";
      lines.push({ u: { raw: x, layout_type: x.layout_type, label: typeLabel(x.layout_type, x.label), category: x.category, seats: x.seats, count: n(x.objects) }, thing: t,
        sub: [catName(x.category), seats > 0 && !has(SINGLES, x.layout_type) ? fmt(seats) + " seats" : "", sp].filter(Boolean).join(" · "), part: null });
    });
    seatGaps(block).forEach(function (g) {
      if (S.hidden[g.layout_type]) return;
      lines.push({ u: { raw: { layout_type: g.layout_type, label: g.name }, layout_type: g.layout_type, label: g.label, category: "seating", seats: g.seats, count: g.seats }, thing: { label: g.label, qty: g.seats },
        sub: "The seats around " + fmt(g.objects) + " x " + g.name, part: "seats" });
    });
    // R255: the event's own page says what one tap does, the ready ones first; the overview (many events) only links, as before
    var plan = inPanel && S.o && S.o.freeFor ? quickPlan(block, lines) : null, RANK = { ok: 0, wait: 1, many: 2, full: 3, none: 4, asked: 5 };
    var order = lines.map(function (l, i) { return { l: l, q: plan ? plan[i] : null, i: i }; });
    if (inPanel) S.missing = missingOf(block, lines, plan);
    if (plan) order.sort(function (a, b) { return RANK[a.q.state] - RANK[b.q.state] || a.i - b.i; });
    var rows = order.map(function (o) { return freeRow(block, o.l.u, o.l.thing, o.l.sub, o.l.part, o.q); });
    var out = [];
    if (rows.length) {
      var ul = h("ul", { cls: "ls-plist" }, rows), head0 = "Not linked to stock yet (" + rows.length + ")";
      if (inPanel) {
        var ready = order.filter(function (o) { return o.q && o.q.state === "ok"; }).map(function (o) { return o.q; });
        out.push(h("div", { cls: "ls-uh" }, [h("div", {}, [h("h4", { cls: "ls-h4", text: head0 }),
          plan ? h("p", { cls: "ls-sub ls-uhelp", text: "Helm shows what is free that day. Press Use to take it; what is still missing comes from a vendor. Helm remembers the item for your other events." }) : null]),
          S.canEdit && ready.length > 1 ? reserveAllBtn(block, ready) : null, plan ? manyBtn(block) : null]), ul);
      } else out.push(h("details", { cls: "ls-det" }, [h("summary", {}, [h("b", { text: head0 }), h("span", { cls: "ls-sub", text: un.filter(function (x) { return !S.hidden[x.layout_type] && !has(PLACES, x.layout_type); }).map(countText)
        .concat(seatGaps(block).filter(function (g) { return !S.hidden[g.layout_type]; }).map(function (g) { return g.label + " x " + fmt(g.seats); })).join(", ") })]), ul]));
    }
    if (quiet.length) out.push(h("p", { cls: "ls-sub ls-quiet", text: "Not stock: " + quiet.join(", ") }));
    return out;
  }
  function blockBody(block, inPanel) {
    var kids = [], tbl = needsTable(block);
    if (tbl) kids.push(tbl);
    else if (n(block.objects) === 0) kids.push(h("p", { cls: "ls-empty", text: "The floor plan of this event is empty." }));
    else if (!(inPanel && S.o && S.o.freeFor)) kids.push(h("p", { cls: "ls-empty", text: "None of the products in this floor plan is linked to a stock item yet." }));   // the event's own page says it per product below
    unlinkedPart(block, inPanel).forEach(function (k) { kids.push(k); });
    if (ev(block.quote_id).err) {
      var tr = h("button", { type: "button", cls: "ls-linkbtn", text: "Try again" });
      tr.addEventListener("click", function () { S.evs = {}; loadExtras(); });
      kids.push(h("p", { cls: "ls-sub ls-quiet", role: "status" }, ["Couldn't check the vendors and what is given out. ", tr]));
    }
    var plan = reservePlan(block), acts = h("div", { cls: "ls-acts" });
    if (S.canEdit && plan.qty > 0) {
      var b = h("button", { type: "button", cls: "btn primary sm ls-act", text: "Reserve from layout" });
      b.addEventListener("click", function () { reserveFlow(block, b); });
      acts.appendChild(b);
    }
    if (!inPanel) acts.appendChild(h("a", { cls: "btn sm ls-act", href: "inventory.html?quote=" + encodeURIComponent(block.quote_id), text: "Open event stock" }));
    if (acts.firstChild) kids.push(acts);
    return kids;
  }
  function eventCard(b) {
    var chips = h("div", { cls: "ls-chips" });
    if (n(b.short_items) > 0) chips.appendChild(h("span", { cls: "ls-chip red", text: "Short " + fmt(b.short_items) + " item" + (n(b.short_items) === 1 ? "" : "s") }));
    var sdAll = []; (b.items || []).forEach(function (it) { (it.same_day || []).forEach(function (s) { sdAll.push(s); }); });
    var sd = sameDayText(sdAll); if (sd) chips.appendChild(h("span", { cls: "ls-chip same", text: sd }));
    if (!n(b.short_items) && (b.items || []).length && reservePlan(b).qty === 0) chips.appendChild(h("span", { cls: "ls-chip green", text: "All reserved" }));
    var st = STATUS[String(b.status || "").toLowerCase()] || "";
    return h("article", { cls: "ls-ev" + (n(b.short_items) > 0 ? " is-short" : "") }, [
      h("header", { cls: "ls-ev-h" }, [
        h("div", {}, [h("h3", { text: b.title || b.code || "Event" }), h("p", { cls: "ls-sub", text: dateText(b) + (st ? " · " + st : "") + (n(b.objects) ? " · " + fmt(b.objects) + " objects in the floor plan" : "") })]),
        chips])].concat(blockBody(b, false)));
  }

  // loading: an event card in the final shape (title line, chips, a few table rows) - no lone spinner
  function skeletonCard() {
    var tb = h("tbody");
    for (var k = 0; k < 3; k++) tb.appendChild(h("tr", { cls: "sk-row" }, [h("td", {}, [h("span", { cls: "sk w60" })]), h("td", {}, [h("span", { cls: "sk w40 skr" })]),
      h("td", {}, [h("span", { cls: "sk w40 skr" })]), h("td", {}, [h("span", { cls: "sk w40 skr" })]), h("td", {}, [h("span", { cls: "sk w40 skr" })])]));
    return h("div", { cls: "ls-skcard", "aria-busy": "true", "aria-label": "Loading" }, [h("article", { cls: "ls-ev", "aria-hidden": "true" }, [
      h("header", { cls: "ls-ev-h" }, [h("div", {}, [h("span", { cls: "sk w60" })]), h("span", { cls: "sk w20" })]),
      h("table", { cls: "ls-tbl" }, [tb])])]);
  }

  /* ---- the From layouts tab ---- */
  function renderTab() {
    var host = $("lsEvents"); if (!host) return;
    clear(host);
    var ov = S.overview;
    if (!ov) { host.appendChild(skeletonCard()); return; }
    var list = S.shortOnly ? shortOnly(ov.events) : (ov.events || []);
    var badge = $("lsTabBadge");
    if (badge) { var k = n(ov.summary && ov.summary.events_short); badge.hidden = !k; badge.textContent = k ? String(k) : ""; }
    var sum = $("lsSum");
    if (sum) sum.textContent = fmt(ov.summary.events) + " event" + (n(ov.summary.events) === 1 ? "" : "s") + " with a floor plan · " + fmt(ov.summary.events_short) + " short"
      + (n(ov.summary.events_shared) ? " · " + fmt(ov.summary.events_shared) + " sharing stock on the same day" : "") + (ov.more ? " · showing the first 60" : "");
    if (!list.length) {
      host.appendChild(h("p", { cls: "empty", text: S.shortOnly ? "Nothing is short in this period." : "No events with a floor plan in the next " + S.days + " days. Floor plans are drawn in the 2D / 3D layout of an event." }));
    } else list.forEach(function (b) { host.appendChild(eventCard(b)); });
    renderLinks();
  }

  function itemOptions(sel, withCreate) {
    var items = ((S.o && S.o.items && S.o.items()) || []).filter(function (i) { return i && i.active !== false; })
      .sort(function (a, b) { return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" }); });
    sel.appendChild(h("option", { value: "", text: items.length ? "Pick a stock item" : "No stock items yet" }));
    items.forEach(function (i) { sel.appendChild(h("option", { value: i.id, text: optName(i.name) + (i.total_qty != null ? " (" + fmt(i.total_qty) + ")" : "") })); });
    if (withCreate) sel.appendChild(h("option", { value: "__new", text: "+ Create stock item..." }));
  }
  function linkControls(u) {
    var sel = h("select", { cls: "sel ls-isel", "aria-label": "Stock item for " + u.label }); itemOptions(sel, true);
    var per = h("input", { type: "number", min: "0.01", step: "0.01", value: "1", cls: "ls-per", "aria-label": "How many per object", inputmode: "decimal" });
    // "per seat" only where the server counts seats (a sofa has none there: per seat would always need 0)
    var mode = h("select", { cls: "sel", "aria-label": "Count per object or per seat" }, [h("option", { value: "objects", text: "per object" }), n(u.seats) > 0 ? h("option", { value: "seats", text: "per seat" }) : null]);
    mode.value = n(u.seats) > 0 ? (u.mode || linkMode(u.layout_type, u.seats)) : "objects";
    var go = h("button", { type: "button", cls: "btn sm primary", text: "Link" });
    go.addEventListener("click", function () {
      if (go.disabled) return;
      var p = Number(per.value);
      if (!(p > 0) || p > 10000 || Math.round(p * 100) / 100 !== p) { toast("How many per object: a number above 0 with at most 2 decimals.", "err"); per.focus(); return; }
      if (sel.value === "__new") { createFlow(u, p, mode.value); return; }
      if (!sel.value) { toast("Pick the stock item first.", "info"); sel.focus(); return; }
      go.disabled = true;
      root.BPStore.inventory.layout.setLink(u.layout_type, sel.value, p, mode.value)
        .then(function () { toast("Linked " + u.label + ".", "ok"); return refresh(); })
        .catch(function (e) { toast(friendly(e, "link the product"), "err"); })
        .then(function () { go.disabled = false; });
    });
    var one = (has(TABLES, u.layout_type) ? "table" : head(words(u.label)) || u.label).toLowerCase(), lbl = h("span", { cls: "ls-perl", text: "How many of this item for ONE " + (mode.value === "seats" ? "seat" : one) });   // R261
    mode.addEventListener("change", function () { lbl.textContent = "How many of this item for ONE " + (mode.value === "seats" ? "seat" : one); per.setAttribute("aria-label", lbl.textContent); });
    per.setAttribute("aria-label", lbl.textContent);
    var perw = h("label", { cls: "ls-perw" }, [lbl, per]);
    sel.addEventListener("change", function () {   // R262: a chair is one per seat, a table one per table - nothing to fill in
      var it = ((S.o && S.o.items && S.o.items()) || []).filter(function (i) { return i.id === sel.value; })[0], own = it && n(u.seats) > 0 ? ownThing(it.name) : it && ownThing(it.name) === "objects" ? "objects" : "";
      perw.hidden = mode.hidden = !!own; if (own) { per.value = "1"; mode.value = own; }
    });
    return h("div", { cls: "ls-ctl" }, [sel, perw, mode, go]);
  }
  function renderLinks() {
    var host = $("lsLinkBody"); if (!host) return;
    clear(host);
    var un = unlinkedAll(S.overview, S.hidden), nHidden = Object.keys(S.hidden).length;
    if (!un.length) host.appendChild(h("p", { cls: "ls-empty", text: "Every product in the upcoming floor plans is linked to stock." }));
    un.forEach(function (u) {
      var bits = fmt(u.objects) + " in " + u.events + " event" + (u.events === 1 ? "" : "s") + (u.seats ? " · " + fmt(u.seats) + " seats" : "");
      var row = h("div", { cls: "ls-lrow" }, [h("div", { cls: "ls-lname" }, [h("b", { text: u.label }), h("span", { cls: "ls-sub", text: catName(u.category) + " · " + bits })])]);
      if (S.canEdit) {
        var sug = suggestLink(u, (S.o && S.o.items && S.o.items()) || [], S.links);
        if (sug) row.appendChild(linkBtn(u, sug));
        row.appendChild(linkControls(u));
        var hide = h("button", { type: "button", cls: "ls-linkbtn", text: "Not stock", title: "Hide this product here (for example a zone like Exit or Parking). Only on this browser." });
        hide.addEventListener("click", function () { S.hidden[u.layout_type] = 1; writeHidden(S.hidden); renderTab(); });
        row.appendChild(hide);
      }
      host.appendChild(row);
    });
    if (nHidden) {
      var show = h("button", { type: "button", cls: "ls-linkbtn", text: "Show " + nHidden + " hidden (not stock)" });
      show.addEventListener("click", function () { S.hidden = {}; writeHidden(S.hidden); renderTab(); });
      host.appendChild(h("p", { cls: "ls-sub" }, [show]));
    }
    // the links already made, per layout product
    var lk = $("lsLinked"); if (!lk) return;
    clear(lk);
    var byType = {};
    (S.links || []).forEach(function (l) { (byType[l.layout_type] = byType[l.layout_type] || []).push(l); });
    var labels = {}, seatsOf = {}; ((S.overview && S.overview.events) || []).forEach(function (e) { (e.types || []).forEach(function (t) { labels[t.layout_type] = typeLabel(t.layout_type, t.label); seatsOf[t.layout_type] = Math.max(n(seatsOf[t.layout_type]), n(t.seats)); }); });
    var types = Object.keys(byType).sort(function (a, b) { return (labels[a] || a).localeCompare(labels[b] || b); });
    if (!types.length) { lk.appendChild(h("p", { cls: "ls-empty", text: "No links yet." })); return; }
    types.forEach(function (t) {
      var lab = labels[t] || typeLabel(t);
      var ul = h("ul", { cls: "ls-llist" });
      byType[t].forEach(function (l) {
        var li = h("li", {}, [h("span", { text: optName(l.item_name) + " x " + String(Number(l.per_object) || 1) + (l.count_mode === "seats" ? " per seat" : " per object") + (l.item_active === false ? " (item switched off)" : "") })]);
        if (S.canEdit) {
          var rm = h("button", { type: "button", cls: "rm", text: "Remove", "aria-label": "Remove link " + lab + " to " + (l.item_name || "item") });
          rm.addEventListener("click", function () {
            Promise.resolve(root.BPUI && root.BPUI.confirm ? root.BPUI.confirm("Stop counting " + (l.item_name || "this item") + " for " + lab + "? Reservations already made stay as they are.", { title: "Remove link?", okLabel: "Remove" }) : true)
              .then(function (ok) { if (!ok) return; return root.BPStore.inventory.layout.removeLink(l.link_id).then(function () { toast("Link removed.", "ok"); return refresh(); }); })
              .catch(function (e) { toast(friendly(e, "remove the link"), "err"); });
          });
          li.appendChild(rm);
        }
        ul.appendChild(li);
      });
      var grp = h("div", { cls: "ls-lgrp" }, [h("b", { text: lab }), ul]);
      if (S.canEdit) {
        var more = h("button", { type: "button", cls: "ls-linkbtn", text: "+ Add another stock item" });
        more.addEventListener("click", function () { more.replaceWith(linkControls({ layout_type: t, label: lab, seats: seatsOf[t] || (has(ROWS, t) || has(TABLES, t) || has(SINGLES, t) ? 1 : 0),
            mode: has(TABLES, t) && byType[t].some(function (l) { return l.count_mode !== "seats"; }) ? "seats" : null })); });
        grp.appendChild(more);
      }
      lk.appendChild(grp);
    });
  }

  /* ---- dialogs ---- */
  function modal(title, body, okText, onOk) {
    var prev = doc.activeElement;
    var err = h("div", { cls: "err", role: "alert", hidden: true });
    var ok = h("button", { type: "button", cls: "btn primary", text: okText });
    var cancel = h("button", { type: "button", cls: "btn", text: "Cancel" });
    var x = h("button", { type: "button", cls: "close", "aria-label": "Close", "data-close": true, text: "x" });
    var tid = "lsdlg" + Math.random().toString(36).slice(2, 8);
    var wrap = h("div", { cls: "lmodal", role: "dialog", "aria-modal": "true", "aria-labelledby": tid }, [
      h("div", { cls: "sheet ls-sheet" }, [h("h3", {}, [h("span", { id: tid, text: title }), x]), body, err,
        h("div", { cls: "foot" }, [h("span", { cls: "spacer" }), cancel, ok])])]);
    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); if (prev && prev.focus) { try { prev.focus(); } catch (e) {} } }
    x.addEventListener("click", close); cancel.addEventListener("click", close);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    ok.addEventListener("click", function () {
      if (ok.disabled) return; ok.disabled = true; err.hidden = true;
      Promise.resolve().then(onOk).then(function (r) { if (r !== false) close(); })
        .catch(function (e) { err.textContent = (e && e.userText) || friendly(e, "save"); err.hidden = false; })
        .then(function () { ok.disabled = false; });
    });
    doc.body.appendChild(wrap);
    setTimeout(function () { try { (wrap.querySelector("input,select") || ok).focus(); } catch (e) {} }, 30);
    return { close: close, err: err };
  }
  function userErr(msg) { var e = new Error(msg); e.userText = msg; return e; }

  function createFlow(u, per, mode) {
    var name = h("input", { id: "ls_cname", maxlength: "120", value: u.label });
    var cat = h("input", { id: "ls_ccat", maxlength: "60", value: catName(u.category) });
    var qty = h("input", { id: "ls_cqty", type: "number", min: "0", step: "1", inputmode: "numeric", value: "" });
    var unit = h("input", { id: "ls_cunit", maxlength: "20", value: "pcs" });
    var body = h("div", {}, [
      h("p", { cls: "sub", text: "A new stock item, linked to " + u.label + " (" + String(per) + (mode === "seats" ? " per seat" : " per object") + "). Nothing is reserved yet." }),
      h("div", { cls: "fgrid" }, [
        h("div", { cls: "fld" }, [h("label", { "for": "ls_cname", text: "Name *" }), name]),
        h("div", { cls: "fld" }, [h("label", { "for": "ls_ccat", text: "Category" }), cat]),
        h("div", { cls: "fld" }, [h("label", { "for": "ls_cqty", text: "How many you own *" }), qty]),
        h("div", { cls: "fld" }, [h("label", { "for": "ls_cunit", text: "Unit" }), unit])])]);
    modal("Create stock item", body, "Create and link", function () {
      var nm = String(name.value || "").trim();
      if (!nm) throw userErr("Give the item a name.");
      var q = qty.value === "" ? NaN : Number(qty.value);
      if (!(q >= 0) || q !== Math.trunc(q) || q > 100000000) throw userErr("How many you own: a whole number, 0 or more.");
      return root.BPStore.inventory.addItem({ name: nm.slice(0, 120), category: String(cat.value || "").trim() || null, total_qty: q, unit: String(unit.value || "").trim() || null })
        .then(function (row) {
          if (!row || !row.id) throw userErr("The item was not saved.");
          return root.BPStore.inventory.layout.setLink(u.layout_type, row.id, per, mode);
        })
        .then(function () { toast("Created " + nm + " and linked it to " + u.label + ".", "ok"); return Promise.resolve(S.o && S.o.reload && S.o.reload()).then(refresh); });
    });
  }

  function reserveFlow(block, btn, only) {
    var plan = reservePlan(block, only);
    if (!plan.lines.length) { toast("Everything in the floor plan is already reserved.", "info"); return; }
    var ul = h("ul", { cls: "ls-plan" });
    plan.lines.forEach(function (l) {
      l.want = l.qty; l.box = h("input", { type: "number", min: "0", max: String(l.qty), step: "1", inputmode: "numeric", cls: "ls-qty", value: String(l.qty), "aria-label": "How many " + optName(l.name) });
      ul.appendChild(h("li", { cls: "ls-rline" }, [h("span", {}, [h("b", { text: optName(l.name) }), h("span", { cls: "ls-sub", text: "Needed " + fmt(l.qty) + (l.unit ? " " + l.unit : "") + " - " + (l.short ? fmt(l.fromStock) + " free, " + fmt(l.short) + " short" : "all free") })]), l.box]));
    });
    var kids = [h("p", { cls: "sub", text: (block.title || "This event") + " · " + dateText(block) }), ul];
    var src = null, vend = null, note = null;
    if (plan.short > 0) {
      src = h("select", { id: "ls_src", cls: "sel" }, [h("option", { value: "none", text: "Leave unsourced (decide later)" }),
        h("option", { value: "buy", text: "Buy / outsource" }), h("option", { value: "vendor", text: "Rent from a vendor" })]);
      vend = h("select", { id: "ls_vend", cls: "sel", hidden: true }, [h("option", { value: "", text: "Loading vendors..." })]);
      note = h("input", { id: "ls_snote", maxlength: "200", placeholder: "Optional note" });
      src.addEventListener("change", function () { vend.hidden = src.value !== "vendor"; });
      var S2 = root.BPStore;
      (S2.vendors && S2.vendors.listAll ? S2.vendors.listAll(false) : Promise.resolve([])).catch(function () { return []; }).then(function (list) {
        clear(vend); vend.appendChild(h("option", { value: "", text: (list || []).length ? "Pick a vendor" : "No vendors yet - add one under Partners" }));
        (list || []).forEach(function (v) { vend.appendChild(h("option", { value: v.id, text: optName(v.name) + (v.category ? " · " + v.category : "") })); });
      });
      kids.push(h("p", { cls: "ls-warn", text: fmt(plan.short) + " are not free on these days. They are recorded as a shortfall on the event:" }),
        h("div", { cls: "ls-src" }, [h("label", { "for": "ls_src", cls: "sr-only", text: "Source for the shortfall" }), src,
          h("label", { "for": "ls_vend", cls: "sr-only", text: "Vendor" }), vend, h("label", { "for": "ls_snote", cls: "sr-only", text: "Note" }), note]));
    }
    kids.push(h("p", { cls: "ls-sub", text: "Reservations already made stay as they are. Nothing is taken out of the store yet." }));
    modal(only ? "Reserve" : "Reserve from layout", h("div", {}, kids), plan.short ? "Reserve and record what is short" : "Reserve", function () {
      var source = src ? src.value : "none", vendorId = vend && source === "vendor" ? vend.value : null;
      if (source === "vendor" && !vendorId) throw userErr("Pick the vendor to rent from.");
      var vendorName = vend && vendorId ? (vend.options[vend.selectedIndex] || {}).text : null;
      var done = { reserved: 0, short: 0, failed: [] };
      plan.lines.forEach(function (l) { var v = Number(l.box.value); if (l.box.value === "" || v !== Math.trunc(v) || v < 0 || v > l.want) { l.box.focus(); throw userErr("How many " + optName(l.name) + ": a whole number, 0 to " + fmt(l.want) + "."); } l.qty = v; });
      if (!plan.lines.some(function (l) { return l.qty > 0; })) throw userErr("Enter how many to reserve.");
      return plan.lines.filter(function (l) { return l.qty > 0; }).reduce(function (p, l) {
        return p.then(function () {
          return root.BPStore.inventory.reserveWithSourcing(l.item_id, block.quote_id, l.qty, "From the floor plan",
            { source: source, vendorId: vendorId, vendorName: vendorName, sourceNote: note && note.value ? note.value.trim() : null })
            .then(function (r) { done.reserved += n(r && r.reserved); done.short += n(r && r.short); })
            .catch(function (e) { done.failed.push(optName(l.name) + ": " + friendly(e, "reserve")); });
        });
      }, Promise.resolve()).then(function () {
        var msg = "Reserved " + fmt(done.reserved) + (done.short ? ", " + fmt(done.short) + " short recorded" : "") + ".";
        if (done.failed.length) { toast(msg + " Not done: " + done.failed.join("; "), "err"); } else toast(msg, "ok");
        return Promise.resolve(S.o && S.o.reload && S.o.reload()).then(refresh);
      });
    });
  }

  /* ---- the per-event panel (?quote=) ---- */
  function renderPanel(block) {
    var host = $("layoutNeeds"); if (!host) return;
    clear(host);
    if (!block) { host.hidden = true; return; }
    host.hidden = false;
    host.appendChild(h("h3", { cls: "ls-h", text: "From the floor plan" }));
    host.appendChild(h("p", { cls: "sub", text: block.version_no ? "What the latest 2D / 3D floor plan needs, against what is free on this event's stock days." : "No floor plan saved for this event yet." }));
    if (block.version_no && S.floor && S.floor.version_no && n(S.floor.version_no) !== n(block.version_no))
      host.appendChild(h("p", { cls: "ls-warn", role: "note", text: "These numbers are from V" + block.version_no + ", the last one saved. The event-day screens show V" + S.floor.version_no + "." }));
    var rn = resumeNote(); if (rn) host.appendChild(rn);
    var ln = lastNote(); if (ln) host.appendChild(ln);
    if (block.version_no) blockBody(block, true).forEach(function (k) { host.appendChild(k); });
    host.appendChild(h("p", { cls: "ls-sub ls-quiet" }, [h("a", { cls: "ls-linkbtn", href: "inventory.html?tab=layout", text: "All upcoming events and linked items" })]));
  }

  /* ---- the top strip ---- */
  function renderStrip() {
    var host = $("invSummary"); if (!host || S.quoteId) { if (host) host.hidden = true; return; }
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v == null ? "-" : fmt(v); };
    // the stock numbers only once the stock list is in (until then the skeleton stays - no 0 flashing)
    if (!S.o.ready || S.o.ready()) {
      var s = strip(S.o.items ? S.o.items() : [], S.o.checkouts ? S.o.checkouts() : [], S.overview);
      if (S.o.outNow) s.outNow = S.o.outNow();
      set("isItems", s.items); set("isUnits", s.units); set("isOut", s.outNow);
    }
    // events short: once the floor-plan read answered ("-" on a database without 0430; the tile keeps its place)
    if (S.available !== null) {
      var ev = S.available ? (S.overview && S.overview.summary ? n(S.overview.summary.events_short) : null) : null;
      set("isShort", ev);
      var tile = $("isShortTile");
      if (tile) { tile.classList.toggle("is-short", n(ev) > 0); tile.disabled = !S.available; if (!S.available) tile.title = "Needs the latest database update"; }
    }
  }

  /* R252: who may ask a vendor, the vendors of these events, what is given out, the open event's saved plan. After the numbers are
     on screen, each behind the permission its own page uses; a refused read hides its part, a failed one says so (per event). */
  function can(what, area) { try { var A = root.BPStore.auth; return Promise.resolve(A[what](area)).then(Boolean, function () { return false; }); } catch (e) { return Promise.resolve(false); } }
  var extraRun = 0;
  function loadExtras() {
    var run = ++extraRun, B = root.BPStore, V = root.HelmStockVendor, pane = $("pane-layout"), tab = !!(pane && !pane.hidden);
    if (!S.available || (!S.quoteId && !tab)) return Promise.resolve();
    return Promise.all([V && V.canUse ? V.canUse().catch(function () { return false; }) : false, can("canView", "vendors")]).then(function (p) {
      S.canVendor = !!p[0]; S.vend = p[1];
      var one = S.quoteId ? [S.quoteId] : [], jobs = [];
      if (p[1]) jobs.push(Promise.resolve(B.vendors.listAll(true)).then(function (v) { S.vendors = v || []; }),
        Promise.resolve(B.inventory.shortages(S.quoteId || null)).then(function (x) { S.shorts = x || []; }));
      one.forEach(function (q) {
        var e = ev(q);
        if (p[1]) jobs.push(Promise.all([B.bookings.list(q), B.resources.listNeeds(q), B.vendorRequests && B.vendorRequests.list ? Promise.resolve(B.vendorRequests.list(q, null)).catch(function () { return []; }) : []]).then(function (r) { e.bookings = r[0] || []; e.needs = r[1] || []; e.requests = r[2] || []; }, function () { e.err = true; }));
      });
      // what is given out: this event, and on the overview only the events that already hold stock and start by tomorrow
      var soon = addDays(today(), 1);
      var outs = S.quoteId ? one.slice() : [];
      ((S.overview && S.overview.events) || []).forEach(function (b) {
        if (outs.indexOf(b.quote_id) < 0 && outs.length < 9 && b.from && b.from <= soon && (b.items || []).some(function (i) { return n(i.held) > 0; })) outs.push(b.quote_id); });
      outs.forEach(function (q) { var e = ev(q); jobs.push(Promise.resolve(B.inventory.checkouts.list(q)).then(function (c) { e.checkouts = c || []; }, function () { e.err = true; })); });
      if (S.quoteId && B.ops && B.ops.planLock && B.ops.planLock.floor) jobs.push(Promise.resolve(B.ops.planLock.floor(S.quoteId)).then(function (f) { S.floor = f && Array.isArray(f.items) ? f : null; }).catch(function () { S.floor = null; }));
      return Promise.all(jobs.map(function (j) { return j.catch(function () {}); }));
    }).then(function () {
      if (run !== extraRun) return;
      if (S.overview && !S.ovErr) renderTab();
      if (S.quoteId) renderPanel(S.block || null);
    });
  }
  function fixLinks(list) {
    var done = [];
    return list.reduce(function (p, w) { return p.then(function () { S.fixed[w.id] = 1; return root.BPStore.inventory.layout.setLink(w.type, w.item_id, 1, w.mode); }).then(function () { done.push(optName(w.name)); }, function () {}); }, Promise.resolve())
      .then(function () { if (done.length) toast(done.filter(function (x, i) { return done.indexOf(x) === i; }).join(", ") + (done.length === 1 ? " now counts" : " now count") + " as 1 each.", "ok"); });
  }
  function refresh() {
    var L = root.BPStore && root.BPStore.inventory && root.BPStore.inventory.layout;
    if (!L) { S.available = false; hideFeature(); return Promise.resolve(); }
    var from = today(), to = addDays(from, S.days);
    var jobs = [L.overview(from, to), L.links()];
    if (S.quoteId) jobs.push(L.needs(S.quoteId));
    return Promise.all(jobs.map(function (p) { return Promise.resolve(p).catch(function (e) { return { __err: e }; }); })).then(function (r) {
      var ov = r[0], lk = r[1], nd = r[2];
      if (ov === null) { S.available = false; hideFeature(); renderStrip(); return; }   // local mode / database without 0430
      S.available = true; showFeature();
      if (ov && ov.__err) { S.overview = { events: [], summary: { events: 0, events_short: 0 } }; var hst = $("lsEvents"); if (hst) { clear(hst); hst.appendChild(h("p", { cls: "err", text: friendly(ov.__err, "load the floor-plan products") })); } }
      else S.overview = ov;
      S.ovErr = !!(ov && ov.__err);
      S.links = Array.isArray(lk) ? lk : [];
      var wrong = S.canEdit ? wrongLinks(S.links).filter(function (w) { return !S.fixed[w.id]; }) : [];
      if (wrong.length) return fixLinks(wrong).then(refresh);   // R266: once per link and page; a refused save leaves it as it is (the row then offers the button)
      if (!(ov && ov.__err)) renderTab();
      S.block = nd && !nd.__err ? nd : null;
      if (S.quoteId) renderPanel(S.block);
      renderStrip();
      return loadExtras();
    });
  }
  function hideFeature() { ["tabLayout", "layoutNeeds"].forEach(function (id) { var el = $(id); if (el) el.hidden = true; }); }
  function showFeature() { var t = $("tabLayout"); if (t) t.hidden = !!S.quoteId; }   // R262: one event's page says it once, in "From the floor plan" above

  function mount(o) {
    S.o = o || {}; S.quoteId = S.o.quoteId || null; S.canEdit = !!S.o.canEdit;
    var rs = $("lsRange");
    if (rs && !rs.dataset.bound) {
      rs.dataset.bound = "1";
      RANGES.forEach(function (d) { rs.appendChild(h("option", { value: String(d), text: "Next " + d + " days" })); });
      rs.value = String(S.days);
      rs.addEventListener("change", function () { S.days = Number(rs.value) || 30; refresh(); });
      var so = $("lsShortOnly"); if (so) so.addEventListener("change", function () { S.shortOnly = !!so.checked; renderTab(); });
      var ev = $("lsEvents");
      if (ev) ev.addEventListener("click", function (e) { var t = e.target && e.target.closest && e.target.closest("[data-ls-goto]"); if (t) { var l = $("lsLinks"); if (l && l.scrollIntoView) l.scrollIntoView({ behavior: "smooth", block: "start" }); } });
      var tl = $("tabLayout"); if (tl) tl.addEventListener("click", function () { loadExtras(); });
      var st = $("isShortTile");
      if (st) st.addEventListener("click", function () { if (S.o.openTab) S.o.openTab("layout"); loadExtras(); });
    }
    return refresh();
  }
  // the page reloaded its stock (items / check-outs): only the strip changes
  function stockChanged() {
    if (!S.o) return; renderStrip();
    // R255: what is free is known now - the open event's suggestions show it (not while someone is picking an item in the panel)
    var host = $("layoutNeeds"); if (S.quoteId && S.block && host && !host.querySelector(".ls-ctl") && !host.contains(doc.activeElement)) renderPanel(S.block);
  }

  api.mount = mount; api.refresh = refresh; api.stockChanged = stockChanged;
  root.HelmLayoutStock = api;
})(typeof window !== "undefined" ? window : this);

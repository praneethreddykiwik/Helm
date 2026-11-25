/* GENERATED from builder.js + builder.css by scripts/gen-floor-view.mjs - do not edit by hand.
 * The planner's 2D drawing, word for word, for the read-only layout viewer (floor-view.js) and the Floor plan card (event-floor.js).
 *   HelmFloorDraw.prepare(floor)        -> { items, world: { w, h }, margins, unit } cleaned exactly as the planner opens a layout
 *   HelmFloorDraw.svg(plan, opts)       -> the <svg> the planner's canvas shows (viewBox in plan pixels, PX per foot)
 *   HelmFloorDraw.PX / PALETTE / CAT    -> 12 px per foot, the planner's colours
 * floor = event_floor_get's answer (0397) or a saved version's data. Needs builder-tools.js + stage-screen.js. Nothing is saved. */
(function (global) {
if (!global.document) return;
var window = global;
const FONT = "\"IBM Plex Sans\",system-ui,-apple-system,Segoe UI,Roboto,sans-serif", SCREEN_FONT = "\"Plus Jakarta Sans\",system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif";
const PALETTE = Object.freeze({"--canvas":"#f4f7fd","--grid":"#c3d1ea","--grid-strong":"#9fb4d8","--ink":"#1b1930","--ink-3":"#6b6577","--panel":"#ffffff","--panel-2":"#faf8f5","--accent":"#047857"});
const C_LIGHT = Object.freeze({"structure":"#2f6fed","seating":"#0d9488","av":"#7c5cff","security":"#e5484d","logistics":"#e8912d","safety":"#18a558","decor":"#d6549a"}), C_KNOWN = ["#0d9488","#18a558","#2dd4bf","#2f6fed","#34d399","#5b8cff","#7c5cff","#a78bfa","#d6549a","#e5484d","#e8912d","#f06ec0","#f2ad4a","#ff6b70"];
const RO = true;                                   // the viewer never shows an edit hint or a margin handle
const WORLD = { w: 0, h: 0 };
let store = { items: [], grid: { show: true, unit: 'ft', snap: true }, margins: { left: 0, right: 0, top: 0, bottom: 0 }, view: { zoom: 1 } }, svg = null, seq = 0;
const isSelected = () => false, nid = () => 'fv_' + (++seq).toString(36), catColor = (k) => C_LIGHT[k];
/* ======== from builder.js (word for word) ======== */
const PX_PER_FT = 12;
const DEFAULT_WORLD = { w: 200, h: 140 };
const FT_PER_M = 3.280839895;
const CATS = {
  structure:{ name:'Structure', varName:'--c-structure' },
  seating:  { name:'Seating',   varName:'--c-seating'   },
  av:       { name:'AV & Stage',varName:'--c-av'        },
  security: { name:'Security',  varName:'--c-security'  },
  logistics:{ name:'Logistics', varName:'--c-logistics' },
  safety:   { name:'Safety',    varName:'--c-safety'    },
  decor:    { name:'Decor',     varName:'--c-decor'     },
};
const ASSETS = {
  stage:      { label:'Main Stage',    category:'structure', w:40, h:16 },
  dancefloor: { label:'Dance Floor',   category:'structure', w:24, h:24 },
  podium:     { label:'Podium',        category:'av',        w:3,  h:3  },
  press:      { label:'Press Riser',   category:'av',        w:24, h:12 },
  dj:         { label:'DJ Booth',      category:'av',        w:8,  h:5  },
  chairrow:   { label:'Chair Row',     category:'seating',   w:24, h:2,  props:{rows:1, cols:12} },
  seatblock:  { label:'Seating Block', category:'seating',   w:30, h:24, props:{rows:10, cols:14} },
  table:      { label:'Round Table',   category:'seating',   w:6,  h:6,  props:{seats:8} },
  barricade:  { label:'Barricade',     category:'security',  w:30, h:2  },
  fence:      { label:'Fence Line',    category:'security',  w:40, h:1  },
  booth:      { label:'Expo Booth',    category:'logistics', w:10, h:10 },
  desk:       { label:'Reg Desk',      category:'logistics', w:8,  h:2.5},
  truck:      { label:'Food Truck',    category:'logistics', w:22, h:8  },
  exit:       { label:'Exit Zone',     category:'safety',    w:12, h:6  },
  /* ---- expanded catalog ---- */
  canopy:     { label:'Canopy',        category:'structure', w:22, h:22 },
  arch:       { label:'Arch / Backdrop',category:'structure',w:12, h:1.5},
  tent:       { label:'Tent',          category:'structure', w:30, h:24 },
  longtable:  { label:'Banquet Table', category:'seating',   w:16, h:4,  props:{seats:12} },
  headtable:  { label:'Head Table',    category:'seating',   w:18, h:3,  props:{seats:8} },
  cocktail:   { label:'Cocktail Table',category:'seating',   w:3.5,h:3.5,props:{seats:3} },
  lounge:     { label:'Lounge Set',    category:'seating',   w:12, h:9  },
  photobooth: { label:'Photo Booth',   category:'av',        w:8,  h:8  },
  checkpoint: { label:'Checkpoint',    category:'security',  w:6,  h:3  },
  bar:        { label:'Bar',           category:'logistics', w:14, h:4  },
  buffet:     { label:'Buffet Line',   category:'logistics', w:18, h:3  },
  gifttable:  { label:'Gift Table',    category:'logistics', w:6,  h:2.5},
  caketable:  { label:'Cake Table',    category:'logistics', w:4,  h:4  },
  restroom:   { label:'Restrooms',     category:'logistics', w:12, h:8  },
  /* ---- upscale pack ---- */
  ledscreen:  { label:'LED Screen',    category:'av',        w:20, h:2  },
  truss:      { label:'Truss Tower',   category:'structure', w:4,  h:4  },
  speaker:    { label:'Speaker Stack', category:'av',        w:3,  h:3  },
  coatcheck:  { label:'Coat Check',    category:'logistics', w:10, h:4  },
  firstaid:   { label:'First Aid',     category:'safety',    w:8,  h:8  },
  planter:    { label:'Greenery',      category:'structure', w:4,  h:4  },
  redcarpet:  { label:'Carpet / Aisle',category:'structure', w:6,  h:30 },
  parking:    { label:'Parking Zone',  category:'logistics', w:40, h:24 },
  /* ---- furniture + decor pack ---- */
  sofa:       { label:'Sofa',          category:'seating',   w:7,  h:3  },
  loveseat:   { label:'Loveseat',      category:'seating',   w:5,  h:3  },
  armchair:   { label:'Armchair',      category:'seating',   w:3,  h:3  },
  ottoman:    { label:'Ottoman',       category:'seating',   w:2.5,h:2.5},
  bench:      { label:'Bench',         category:'seating',   w:5,  h:1.5},
  coffeetable:{ label:'Coffee Table',  category:'seating',   w:4,  h:2.5},
  floral:     { label:'Floral Centerpiece', category:'decor',w:2.5,h:2.5},
  floralarch: { label:'Floral Arch',   category:'decor',     w:10, h:2  },
  mandap:     { label:'Decor Mandap',  category:'decor',     w:16, h:16 },
  pillar:     { label:'Decor Pillar',  category:'decor',     w:2,  h:2  },
  drape:      { label:'Pipe & Drape',  category:'decor',     w:16, h:1  },
  chandelier: { label:'Chandelier',    category:'decor',     w:4,  h:4  },
  fountain:   { label:'Fountain',      category:'decor',     w:6,  h:6  },
  uplight:    { label:'Uplight',       category:'av',        w:1,  h:1  },
  heater:     { label:'Patio Heater',  category:'logistics', w:2.5,h:2.5},
  easel:      { label:'Signage Easel', category:'logistics', w:2.5,h:2  },
  /* ---- realistic render pack (from the render reference) ---- */
  chiavari:   { label:'Chair (single)',category:'seating',   w:1.6,h:1.6},
  barstool:   { label:'Bar Stool',     category:'seating',   w:1.6,h:1.6},
  piano:      { label:'Grand Piano',   category:'av',        w:8,  h:6  },
  bleacher:   { label:'Bleachers',     category:'seating',   w:24, h:8  },
  /* ---- concert & live-production pack ---- */
  linearray:  { label:'Line Array',    category:'av',        w:2,  h:6  },
  subwoofer:  { label:'Subwoofer',     category:'av',        w:3,  h:3  },
  monitor:    { label:'Stage Monitor', category:'av',        w:2,  h:1.5},
  foh:        { label:'FOH Console',   category:'av',        w:8,  h:8  },
  movinghead: { label:'Moving Light',  category:'av',        w:1.5,h:1.5},
  videowall:  { label:'LED Video Wall',category:'av',        w:24, h:14 },
  generator:  { label:'Generator',     category:'logistics', w:10, h:4  },
  distro:     { label:'Power Distro',  category:'logistics', w:3,  h:2  },
  cableramp:  { label:'Cable Ramp',    category:'logistics', w:6,  h:1  },
  greenroom:  { label:'Green Room',    category:'logistics', w:16, h:12 },
  viprisers:  { label:'VIP Riser',     category:'structure', w:16, h:10 },
  stagebarrier:{label:'Stage Barrier', category:'security',  w:30, h:1.5},
  /* ---- event-production pack (V3): keys match the rate-card / Adjust-popup types ----
     real-world footprints in ft: LED wall 16×9 ft screen (1.5 ft deep), 24 ft lighting truss span,
     125 kVA silent genset ≈ 10×4 ft container, 6 ft ramp, 20 ft branding wall, 3-tier fountain 4×4. */
  lighting:   { label:'Lighting Truss',     category:'av',        w:24, h:1.5 },
  led:        { label:'LED Wall',           category:'av',        w:16, h:1.5 },
  chocolatefountain:{ label:'Chocolate Fountain', category:'logistics', w:4, h:4 },
  chariot:    { label:'Wedding Chariot',    category:'decor',     w:12, h:6  },
  smoke:      { label:'Smoke Machine',      category:'av',        w:2,  h:2  },
  dancers:    { label:'Dancers',            category:'av',        w:12, h:8  },
  walkway:    { label:'Walkway / Ramp',     category:'structure', w:6,  h:24 },
  brandwall:  { label:'Branding Wall',      category:'decor',     w:20, h:1.5},
  /* ---- Indian wedding + corporate pack (2026-10): real-world footprints in ft ---- */
  entrancegate:{ label:'Entrance Gate',     category:'structure', w:16, h:4  },
  phoolchadar:{ label:'Phoolon ki Chadar',  category:'decor',     w:8,  h:8  },
  jhoola:     { label:'Swing / Jhoola',     category:'decor',     w:8,  h:4  },
  haldi:      { label:'Haldi Setup',        category:'decor',     w:14, h:10 },
  mehendi:    { label:'Mehendi Lounge',     category:'decor',     w:16, h:12 },
  selfieframe:{ label:'Selfie Frame',       category:'decor',     w:6,  h:2  },
  welcomeboard:{label:'Welcome Board',      category:'decor',     w:3,  h:2.5},
  fairylights:{ label:'Fairy Light Canopy', category:'decor',     w:24, h:24 },
  couplesofa: { label:'Couple Sofa',        category:'seating',   w:7,  h:3.5},
  livecounter:{ label:'Live Food Counter',  category:'logistics', w:8,  h:4  },
  kidszone:   { label:'Kids Zone',          category:'logistics', w:20, h:16 },
  aircooler:  { label:'Air Cooler / Fan',   category:'logistics', w:2.5,h:2.5},
  /* ---- event-aware décor + production pack (2026-10b): real-world footprints in ft.
     Florals (weddings / receptions / religious), balloons (birthdays / kids), stage & political
     infrastructure (rallies / public meetings / conferences), award-night and religious pieces.
     Tags + allowed event types live in PRODUCT_META below (window.HelmCatalog). ---- */
  floralentrance:{ label:'Entrance Floral Arch', category:'decor', w:14, h:4  },
  stagebackdrop:{ label:'Stage Floral Backdrop', category:'decor',  w:24, h:2  },
  flowerwall: { label:'Flower Wall',        category:'decor',     w:8,  h:1.5},
  toran:      { label:'Garland Toran',      category:'decor',     w:12, h:1  },
  floralpillar:{ label:'Floral Pillar',     category:'decor',     w:2.5,h:2.5},
  aislefloral:{ label:'Aisle Floral Stand', category:'decor',     w:1.5,h:1.5},
  centrepiece:{ label:'Tall Centrepiece',   category:'decor',     w:2,  h:2  },
  balloonarch:{ label:'Balloon Arch',       category:'decor',     w:10, h:2  },
  balloonbunch:{ label:'Balloon Bouquet',   category:'decor',     w:2,  h:2  },
  lectern:    { label:'Lectern',            category:'av',        w:2.5,h:2  },
  dais:       { label:'Dais with Chairs',   category:'structure', w:24, h:8,  props:{chairs:8} },
  flagstand:  { label:'Flag Stand',         category:'decor',     w:2,  h:2  },
  hoarding:   { label:'Banner / Hoarding Frame', category:'structure', w:20, h:2 },
  patower:    { label:'PA Tower',           category:'av',        w:4,  h:4  },
  lightingtree:{ label:'Lighting Tree (T-Bar)', category:'av',    w:3,  h:3  },
  diyastand:  { label:'Brass Deepam Stand', category:'decor',     w:2,  h:2  },
  trophytable:{ label:'Trophy Display',     category:'logistics', w:6,  h:2.5},
  /* ---- religious + ambience pack (2026-10c): real-world footprints in ft (see docs/research/event-inventory-2026-10.md) ---- */
  havankund:  { label:'Havan Kund',         category:'decor',     w:4,  h:4  },
  rangoli:    { label:'Rangoli / Kolam',    category:'decor',     w:6,  h:6  },
  lanterns:   { label:'Lantern Cluster',    category:'decor',     w:2,  h:2  },
  hangingfloral:{ label:'Hanging Floral Ceiling', category:'decor', w:12, h:12 },
  neonsign:   { label:'Neon Sign Wall',     category:'decor',     w:6,  h:1  },
  /* ---- complete-catalogue pack (2026-10d): generic basics + the remaining pieces for every event type.
     Real-world footprints in ft (docs/research/event-inventory-2026-10.md §9). ---- */
  backdrop:   { label:'Backdrop (generic)', category:'decor', w:10, h:1 },
  floralstand:{ label:'Floral Stand (generic)', category:'decor', w:2, h:2 },
  decorbox:   { label:'Decor Item (generic)', category:'decor', w:3, h:3 },
  signage:    { label:'Signage / Standee', category:'logistics', w:2.5, h:1.5 },
  recttable:  { label:'Rectangular Table', category:'seating', w:6, h:2.5, props:{seats:3} },
  stageroof:  { label:'Stage Roof Truss', category:'structure', w:40, h:24 },
  varmala:    { label:'Varmala Platform', category:'structure', w:10, h:10 },
  micstand:   { label:'Mic Stand', category:'av', w:1, h:1 },
  teleprompter:{ label:'Teleprompter / Confidence Monitor', category:'av', w:3, h:1.5 },
  projector:  { label:'Projector Screen', category:'av', w:12, h:2 },
  tvstand:    { label:'TV Screen on Stand', category:'av', w:4, h:2 },
  interpreter:{ label:'Interpreter Booth', category:'av', w:6, h:6 },
  pyro:       { label:'Cold Pyro / CO2 Jet', category:'av', w:1.5, h:1.5 },
  towerlight: { label:'Mobile Light Tower', category:'logistics', w:5, h:5 },
  gaddi:      { label:'Floor Seating (Gaddi)', category:'seating', w:8, h:8 },
  urli:       { label:'Flower Urli', category:'decor', w:3, h:3 },
  umbrellas:  { label:'Decor Umbrellas', category:'decor', w:8, h:8 },
  doli:       { label:'Doli / Palki', category:'decor', w:6, h:3 },
  kalash:     { label:'Kalash / Purna Kumbh', category:'decor', w:1.5, h:1.5 },
  altar:      { label:'Pooja Altar / Idol Platform', category:'decor', w:6, h:4 },
  shoerack:   { label:'Shoe Rack', category:'logistics', w:6, h:1.5 },
  dessert:    { label:'Dessert / Candy Table', category:'logistics', w:8, h:2.5 },
  coffee:     { label:'Coffee / Tea Station', category:'logistics', w:6, h:2.5 },
  stall:      { label:'Food / Merch Stall', category:'logistics', w:10, h:10 },
  counter:    { label:'Display Counter', category:'logistics', w:4, h:2 },
  plinth:     { label:'Display Plinth', category:'decor', w:1.5, h:1.5 },
  kiosk:      { label:'Check-in Kiosk', category:'logistics', w:2, h:2 },
  ticketbooth:{ label:'Ticket Booth', category:'logistics', w:8, h:6 },
  stanchion:  { label:'Stanchions (rope & post)', category:'security', w:10, h:1 },
  watchtower: { label:'Watch Tower / CCTV', category:'security', w:6, h:6 },
  extinguisher:{ label:'Fire Point', category:'safety', w:1.5, h:1 },
  ambulance:  { label:'Ambulance Bay', category:'safety', w:22, h:9 },
  /* ---- R135 visual-asset-catalogue pack (2026-11): only the pieces that are NOT already an item or a look
     of one (docs/builder/R135-CATALOGUE-MAP.md maps all 61 catalogue assets). Real-world footprints in ft. ---- */
  lawnfloor:  { label:'Outdoor Lawn Flooring', category:'structure', w:30, h:20 },
  stagelight: { label:'Stage Light (PAR / beam / spot / flood)', category:'av', w:1.5, h:1.5 },
  pathlights: { label:'Pathway / Rope Lights', category:'decor', w:20, h:1 },
  sidescreen: { label:'LED Side Screen', category:'av', w:6, h:1.5 },
  stagedeck:  { label:'Stage Extension', category:'structure', w:8, h:4 },
  stagestairs:{ label:'Stage Stairs', category:'structure', w:6, h:3.3, props:{stairPos:'centre', stairSteps:3} },
  installation:{ label:'Outdoor Decor Installation', category:'decor', w:8, h:8 },
  /* R154: Jyothi Prajwalana - the ceremonial lamp-lighting stand lit before an event starts (inaugurations,
     conferences, weddings). A ~1.5 ft round base and a ~5.5 ft brass / iron pole with tiered lamp trays. */
  jyothi:     { label:'Jyothi Prajwalana', category:'decor', w:1.5, h:1.5 },
};
const HEXRE=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const MAX_ITEMS=3000, MAX_BLOCK_SEATS=5000, MAX_IMPORT_BYTES=5*1024*1024, MAX_CAPACITY=100000;
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const round1 = v => Math.round(v*10)/10;
const COMFORT_PITCH=2.2, PACKED_PITCH=1.7;                 // ft between chairs: comfortable / packed
const CONG_COLORS=['', '#e8912d', '#e5484d'];              // 0 ok · 1 tight(amber) · 2 packed(red)
const SVGNS='http://www.w3.org/2000/svg';
function seatPitchFt(it){ const c=Math.max(1,it.properties.cols||1), r=Math.max(1,it.properties.rows||1); return r<=1 ? it.width/c : Math.min(it.width/c, it.height/r); }
function congestionOf(it){ if(it.type!=='seatblock'&&it.type!=='chairrow') return 0; const p=seatPitchFt(it); return p<PACKED_PITCH?2:p<COMFORT_PITCH?1:0; }
function cellFt(){ return store.grid.unit==='m' ? FT_PER_M : 1; }
function el(tag, attrs={}, kids=[]){
  const n=document.createElementNS(SVGNS,tag);
  for(const k in attrs) n.setAttribute(k, attrs[k]);
  kids.forEach(c=>n.appendChild(c));
  return n;
}
function drawOrder2D(items, world){ const T=window.HelmBuilderTools; return (T && T.drawOrder) ? T.drawOrder(items, world||WORLD) : items.slice(); }
function screenContent(it){ return window.HelmScreen ? HelmScreen.contentOf(it, store.items) : null; }
function screenPlaceholderOn(){ return !RO && !document.querySelector('meta[name="helm-capture"]'); }
function fitChars(txt, wPx, fs){ const n=Math.max(3, Math.floor(wPx/(fs*0.58))); return txt.length>n ? txt.slice(0,n-1)+'…' : txt; }
function screenText2D(parent, txt, y, wPx, fs, fill, cls){
  const t=el('text',{class:cls||'scr-txt', x:0, y, 'text-anchor':'middle', 'font-size':fs, fill, 'pointer-events':'none'});
  t.textContent=fitChars(String(txt||''), wPx, fs); parent.appendChild(t); return t;
}
function screenPlaceholder2D(body, x, y, wPx, hPx){
  if(!screenPlaceholderOn() || !window.HelmScreen) return;
  const fs=clamp(hPx*0.62, 3.5, 8);
  const t=screenText2D(body, HelmScreen.PLACEHOLDER, y+hPx/2+fs*0.35, wPx*0.9, fs, 'currentColor', 'scr-ph');
  t.setAttribute('fill-opacity','.55'); t.setAttribute('font-style','italic');
}
function screenLogo2D(parent, sc, x, y, size){
  if(!sc || !sc.logo || !HelmScreen.logoImage) return false;
  HelmScreen.logoImage(sc.logo); const url=HelmScreen.logoUrl(sc.logo); if(!url) return false;
  const im=el('image',{class:'scr-logo', x:x-size/2, y:y-size/2, width:size, height:size, preserveAspectRatio:'xMidYMid meet', 'pointer-events':'none'});
  im.setAttribute('crossorigin','anonymous');   // R154: same CORS mode as the cached picture (one fetch, reused)
  im.setAttribute('data-logo', sc.logo);        // R154: which logo this is, so an exported picture can bake its pixels
  im.setAttribute('href', url); parent.appendChild(im); return true;
}
function screenPic2D(parent, sc, x, y, w, h){
  if(!sc || !sc.pic || !HelmScreen.logoImage) return false;
  HelmScreen.logoImage(sc.pic); const url=HelmScreen.logoUrl(sc.pic); if(!url) return false;
  const im=el('image',{class:'scr-logo scr-pic', x, y, width:w, height:h, preserveAspectRatio:'xMidYMid slice', 'pointer-events':'none'});
  im.setAttribute('crossorigin','anonymous'); im.setAttribute('data-logo', sc.pic);
  im.setAttribute('href', url); parent.appendChild(im); return true;
}
function screenBand2D(body, it, sc, w, h, c){   // the stage's rear screen band, themed, with its line of text
  const T=HelmScreen.paletteOf ? HelmScreen.paletteOf(sc) : HelmScreen.themeOf(sc.theme), bh=Math.min(h*0.18,16);
  const line=HelmScreen.shortLine(sc), lay=sc.layout||'';
  if(sc.pic){   // R200 picture mode: the picture on the centre screen (or across the band), side panels in the theme colour
    body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:bh,fill:c,'fill-opacity':.35}));
    const segs=lay ? HelmScreen.stageSegments(lay, it.width) : [{x:0,w:1,side:false}];
    segs.forEach(sg=>{ const sw=w*sg.w, sx=w*sg.x, sh=bh*(lay?(sg.side?0.86:0.8):1), sy=-h/2+(bh-sh)/2;
      body.appendChild(el('rect',{class:'scr-seg', x:sx-sw/2, y:sy, width:sw, height:sh, rx:.6, fill:sg.side?T.bg:'#05070a', stroke:T.accent,'stroke-width':.7}));
      if(!sg.side) screenPic2D(body, sc, sx-sw/2, sy, sw, sh); });
    return;
  }
  if(!lay){   // R135 look (no screen layout chosen): one themed band across the stage back
    body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:bh,fill:T.bg,stroke:T.accent,'stroke-width':.8}));
    const lg=screenLogo2D(body, sc, -w*0.42, -h/2+bh/2, bh*0.8);
    if(line) screenText2D(body, line, -h/2+bh/2+bh*0.22, w*(lg?0.74:0.92), clamp(bh*0.6,3.5,10), T.ink);
    else if(!lg) screenPlaceholder2D(body, -w/2, -h/2, w, bh);
    return;
  }
  // R137 screen layout: the backdrop band in the stage colour, the screens on it (single / triple / wide wall)
  body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:bh,fill:c,'fill-opacity':.35}));
  HelmScreen.stageSegments(lay, it.width).forEach(sg=>{
    const sw=w*sg.w, sx=w*sg.x, sh=bh*(sg.side?0.86:0.8), sy=-h/2+(bh-sh)/2;
    body.appendChild(el('rect',{class:'scr-seg', x:sx-sw/2, y:sy, width:sw, height:sh, rx:.6, fill:T.bg, stroke:T.accent,'stroke-width':.7}));
    if(sg.side){ screenLogo2D(body, sc, sx, sy+sh/2, Math.min(sw,sh)*0.8); return; }
    const lg=screenLogo2D(body, sc, sx-sw*0.4, sy+sh/2, sh*0.8);
    if(line) screenText2D(body, line, sy+sh/2+sh*0.22, sw*(lg?0.66:0.92), clamp(sh*0.6,3.5,10), T.ink).setAttribute('x', String(sx+(lg?sw*0.08:0)));
    else if(!lg) screenPlaceholder2D(body, sx-sw/2, sy, sw, sh);
  });
}
function screenFace2D(body, it, sc, w, h, c){   // a standalone screen item: themed face + its line of text
  const T=HelmScreen.paletteOf ? HelmScreen.paletteOf(sc) : HelmScreen.themeOf(sc.theme);
  if(sc.pic){ body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:h,rx:1,fill:sc.poster?'#ffffff':'#05070a',stroke:c,'stroke-width':1.2}));   // R200 picture mode (R255: white under a poster)
    screenPic2D(body, sc, -w/2+0.6, -h/2+0.6, Math.max(1,w-1.2), Math.max(1,h-1.2)); return; }
  body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:h,rx:1,fill:T.bg,stroke:c,'stroke-width':1.2}));
  const line=HelmScreen.shortLine(sc), lg=screenLogo2D(body, sc, -w*0.38, 0, Math.min(h*0.8, w*0.2));
  if(line){ const fs=clamp(h*0.3,3.5,9); screenText2D(body, line, -h*0.22+fs*0.35, w*(lg?0.66:0.92), fs, T.ink); }
}
const STAGE_STEPS=[['','Centre (default)'],['left','Left'],['right','Right'],['both','Both sides'],['none','None']];
function stageStepOffsets(mode, w, sw){
  if(mode==='none') return [];
  const L=-w/2+sw/2, R=w/2-sw/2;
  if(mode==='left') return [L]; if(mode==='right') return [R]; if(mode==='both') return [L,R];
  return [0];
}
function stairStepCount(it){ const n=Math.round(+((it.properties||{}).stairSteps)); return isFinite(n) ? clamp(n,2,6) : 3; }

function renderItem(it){
  const w=it.width*PX_PER_FT, h=it.height*PX_PER_FT;
  const cx=(it.x+it.width/2)*PX_PER_FT, cy=(it.y+it.height/2)*PX_PER_FT;
  const g = el('g',{ class:'obj', transform:`translate(${cx} ${cy}) rotate(${it.rotation})`, 'data-id':it.id,
    tabindex:'0', role:'button', 'aria-pressed':String(isSelected(it.id)),
    'aria-label':(it.label||'Object')+' — '+((ASSETS[it.type]&&ASSETS[it.type].label)||it.type||'object') });
  const c = it.color;
  const fillSoft = `color-mix(in srgb, ${c} 16%, var(--canvas))`;

  // invisible hitbox (a hair larger) for easy grabbing + hover ring
  g.appendChild(el('rect',{class:'hitbox', x:-w/2, y:-h/2, width:w, height:h, rx:2,
    fill:'transparent', stroke:'transparent','stroke-width':2}));

  const body = el('g',{class:'body'});
  const white = !!(window.HelmScreen && HelmScreen.whiteFace && HelmScreen.whiteFace(it));   // R255: a poster without a picture is plain white

  const drawBox = (opts={})=> body.appendChild(el('rect',{
    x:-w/2,y:-h/2,width:w,height:h, rx:opts.rx??3,
    fill:opts.fill??fillSoft, stroke:c,'stroke-width':opts.sw??1.5,
    'stroke-dasharray':opts.dash??''}));

  switch(it.type){
    case 'stage': case 'dancefloor': {
      drawBox({fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`, rx:3});
      if(it.type==='dancefloor'){ // parquet / LED checker
        const n=Math.max(2,Math.min(8,Math.round(Math.max(w,h)/(4*PX_PER_FT)))), tw=w/n, th=h/n;
        for(let i=0;i<n;i++) for(let j=0;j<n;j++) if((i+j)%2) body.appendChild(el('rect',{x:-w/2+i*tw,y:-h/2+j*th,width:tw,height:th,fill:c,'fill-opacity':.22}));
      } else {    // stage: backdrop band (rear), skirting edge (front) + built-in steps (R135: centre / left / right / both / none)
        const sc=screenContent(it);
        if(sc && sc.layout==='none') body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h*0.12,10),fill:c,'fill-opacity':.35}));   // R137: no screen
        else if(window.HelmScreen && HelmScreen.hasContent(sc)) screenBand2D(body, it, sc, w, h, c);   // R135: themed screen + its text
        else { body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h*0.12,10),fill:c,'fill-opacity':.55}));
          if(!(it.properties||{}).nobackdrop) screenPlaceholder2D(body, -w/2, -h/2, w, Math.min(h*0.12,10)); }
        body.appendChild(el('line',{x1:-w/2+3,y1:h/2-2.5,x2:w/2-3,y2:h/2-2.5,stroke:c,'stroke-width':1,'stroke-dasharray':'2 2'}));
        const sw=Math.min(8*PX_PER_FT,w*0.25);
        stageStepOffsets(it.properties&&it.properties.builtinSteps, w, sw).forEach(ox=>{
          for(let i=1;i<=3;i++) body.appendChild(el('line',{x1:ox-sw/2,y1:h/2+i*3.4,x2:ox+sw/2,y2:h/2+i*3.4,stroke:c,'stroke-width':1,'stroke-opacity':.75})); });
      }
      break; }
    case 'press': case 'desk': case 'truck': case 'booth': case 'exit': {
      drawBox({});
      if(it.type==='exit'){
        body.appendChild(el('path',{d:`M ${-w/6} 0 L ${w/6} 0 M ${w/6-5} -4 L ${w/6} 0 L ${w/6-5} 4`,
          stroke:c,'stroke-width':2,fill:'none','stroke-linecap':'round','stroke-linejoin':'round'}));
      }
      break; }
    case 'podium': {
      drawBox({rx:2,fill:c});
      break; }
    case 'barricade': case 'fence': {
      drawBox({fill:'transparent',dash: it.type==='fence'?'2 3':'', sw:2});
      // hatch
      const step=8;
      for(let x=-w/2; x<w/2; x+=step)
        body.appendChild(el('line',{x1:x,y1:-h/2,x2:Math.min(x+step,w/2),y2:h/2,stroke:c,'stroke-width':1,'stroke-opacity':.7}));
      break; }
    case 'dj': { drawBox({fill:c,rx:2}); break; }
    case 'chairrow': case 'seatblock': {
      const cong=congestionOf(it), dotC=CONG_COLORS[cong]||c;   // amber/red when tight/packed
      drawBox({fill:'transparent',dash:'4 3',sw:1, ...(cong?{}:{})});
      const rows=Math.max(1, it.properties.rows|0), cols=Math.max(1, it.properties.cols|0);
      // cap drawn dots for very dense blocks (subsample but keep full coverage) — perf
      const CAP=450; let dr=rows, dc=cols;
      if(rows*cols>CAP){ const s=Math.sqrt(CAP/(rows*cols)); dr=Math.max(1,Math.round(rows*s)); dc=Math.max(1,Math.round(cols*s)); }
      const r = Math.min(w/dc, h/dr)*0.30;
      for(let ri=0;ri<dr;ri++)for(let ci=0;ci<dc;ci++){
        const px=-w/2 + (ci+0.5)/dc*w;
        const py=-h/2 + (ri+0.5)/dr*h;
        body.appendChild(el('circle',{cx:px,cy:py,r:clamp(r,1,4.2),fill:dotC,'fill-opacity':.85}));
      }
      break; }
    case 'longtable': case 'headtable': {
      drawBox({fill:fillSoft});
      const seats=Math.max(0, it.properties.seats|0);
      const oneSide = it.type==='headtable';
      const perSide = oneSide ? seats : Math.ceil(seats/2);
      const place=(n,yy)=>{ for(let i=0;i<n;i++){ const px=-w/2+(i+0.5)/n*w;
        body.appendChild(el('circle',{cx:px,cy:yy,r:clamp(Math.min(w/seats,6)*0.5,1.5,3.4),fill:c,'fill-opacity':.85})); } };
      place(perSide, -h/2-3.2);
      if(!oneSide) place(seats-perSide, h/2+3.2);
      break; }
    case 'canopy': {
      drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:2, dash:'6 4', sw:1.5});
      // draped roof diagonals + corner posts
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:w/2,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.4}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:-w/2,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.4}));
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sxx,syy])=>
        body.appendChild(el('circle',{cx:sxx*(w/2-3),cy:syy*(h/2-3),r:2.4,fill:c})));
      break; }
    case 'tent': {
      drawBox({fill:`color-mix(in srgb, ${c} 14%, var(--canvas))`});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      body.appendChild(el('line',{x1:-w/2,y1:h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      body.appendChild(el('line',{x1:w/2,y1:h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      break; }
    case 'arch': {
      body.appendChild(el('path',{d:`M ${-w/2} ${h/2} Q 0 ${-h/2-6} ${w/2} ${h/2}`,fill:'none',stroke:c,'stroke-width':2.5}));
      break; }
    case 'bar': case 'buffet': {
      drawBox({fill:`color-mix(in srgb, ${c} 20%, var(--canvas))`});
      body.appendChild(el('line',{x1:-w/2,y1:-h/6,x2:w/2,y2:-h/6,stroke:c,'stroke-width':1,'stroke-opacity':.6}));
      break; }
    case 'lounge': {
      drawBox({fill:fillSoft,rx:4});
      // sofa hint
      body.appendChild(el('rect',{x:-w/2+3,y:-h/2+3,width:w-6,height:h*0.32,rx:3,fill:c,'fill-opacity':.55}));
      break; }
    case 'checkpoint': { drawBox({fill:c,rx:2}); break; }
    case 'table': case 'cocktail': {
      const rad=Math.min(w,h)/2;
      if(it.properties && it.properties.shape==='square')
        body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:h,rx:2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      else
        body.appendChild(el('circle',{cx:0,cy:0,r:rad,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:rad*0.78,fill:'none',stroke:c,'stroke-width':.6,'stroke-opacity':.45}));   // cloth / plate ring
      if(it.type==='table') body.appendChild(el('circle',{cx:0,cy:0,r:Math.max(2,rad*0.18),fill:c,'fill-opacity':.45}));   // centrepiece
      const seats=Math.max(0, it.properties.seats|0);
      for(let s=0;s<seats;s++){
        const ang=s/seats*Math.PI*2 - Math.PI/2;
        body.appendChild(el('circle',{cx:Math.cos(ang)*(rad+3.5),cy:Math.sin(ang)*(rad+3.5),r:2.6,fill:c,'fill-opacity':.85}));
      }
      break; }
    case 'ledscreen': { drawBox({fill:c,rx:1}); break; }
    case 'redcarpet': { drawBox({fill:`color-mix(in srgb, ${c} 30%, var(--canvas))`,rx:1});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2+2,x2:-w/2,y2:h/2-2,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2+2,x2:w/2,y2:h/2-2,stroke:c,'stroke-width':1.5})); break; }
    case 'planter': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/6,fill:c,'fill-opacity':.6})); break; }
    case 'truss': { drawBox({fill:'transparent',sw:1.5});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:w/2,y2:h/2,stroke:c,'stroke-width':1}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:-w/2,y2:h/2,stroke:c,'stroke-width':1})); break; }
    case 'parking': { drawBox({fill:'transparent',dash:'5 4',sw:1.5});
      for(let x=-w/2+8;x<w/2;x+=10) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.5,'stroke-opacity':.5})); break; }
    case 'firstaid': { drawBox({fill:fillSoft});
      body.appendChild(el('path',{d:`M 0 ${-h/4} V ${h/4} M ${-w/4} 0 H ${w/4}`,stroke:c,'stroke-width':2.5,'stroke-linecap':'round'})); break; }
    case 'sofa': case 'loveseat': case 'armchair': case 'bench': {
      drawBox({fill:fillSoft,rx:4});
      body.appendChild(el('rect',{x:-w/2+2,y:-h/2+2,width:w-4,height:h*0.34,rx:3,fill:c,'fill-opacity':.5})); break; }   // backrest hint
    case 'coffeetable': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`,rx:3}); break; }
    case 'ottoman': case 'floral': case 'pillar': case 'heater': case 'uplight': {
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      if(it.type==='floral' || it.type==='pillar'){ const R=Math.min(w,h)/2;
        for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.45,cy:Math.sin(a)*R*0.45,r:R*0.28,fill:c,'fill-opacity':.45})); }
        body.appendChild(el('circle',{cx:0,cy:0,r:R*0.22,fill:c,'fill-opacity':.85})); }
      break; }
    case 'fountain': {
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/4,fill:'none',stroke:c,'stroke-width':1,'stroke-opacity':.6})); break; }
    case 'floralarch': {
      body.appendChild(el('path',{d:`M ${-w/2+3} ${h/2} Q 0 ${-h/2-6} ${w/2-3} ${h/2}`,fill:'none',stroke:c,'stroke-width':1.5,'stroke-opacity':.6}));
      for(let i=0;i<=10;i++){ const t=i/10, x=(1-t)*(1-t)*(-w/2+3)+t*t*(w/2-3), y=(1-t)*(1-t)*(h/2)+2*t*(1-t)*(-h/2-6)+t*t*(h/2);
        if(t<=0.6 || i%2===0) body.appendChild(el('circle',{cx:x,cy:y,r:t<=0.6?2.6:1.8,fill:c,'fill-opacity':i%3?0.6:0.9})); }
      [-1,1].forEach(sx=>body.appendChild(el('rect',{x:sx*(w/2-3)-3,y:h/2-3,width:6,height:6,rx:1.5,fill:fillSoft,stroke:c,'stroke-width':1}))); break; }
    case 'mandap': {
      drawBox({fill:`color-mix(in srgb, ${c} 16%, var(--canvas))`, rx:2, dash:'6 4', sw:1.5});
      body.appendChild(el('rect',{x:-w*0.41,y:-h*0.41,width:w*0.82,height:h*0.82,rx:2,fill:c,'fill-opacity':.12,stroke:c,'stroke-width':.75,'stroke-opacity':.5}));
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sxx,syy])=>{ const px=sxx*(w/2-1.2*PX_PER_FT), py=syy*(h/2-1.2*PX_PER_FT);
        body.appendChild(el('circle',{cx:px,cy:py,r:Math.max(3,0.75*PX_PER_FT),fill:c,'fill-opacity':.8}));
        body.appendChild(el('circle',{cx:px,cy:py,r:Math.max(5,1.3*PX_PER_FT),fill:'none',stroke:c,'stroke-width':.75,'stroke-opacity':.6})); });
      body.appendChild(el('ellipse',{cx:0,cy:0,rx:w*0.36,ry:h*0.36,fill:'none',stroke:c,'stroke-width':.75,'stroke-dasharray':'3 3','stroke-opacity':.55}));   // canopy dome
      body.appendChild(el('rect',{x:-0.7*PX_PER_FT,y:-0.7*PX_PER_FT,width:1.4*PX_PER_FT,height:1.4*PX_PER_FT,fill:c,'fill-opacity':.55,rx:1})); break; }
    case 'drape': { drawBox({fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`});
      for(let x=-w/2+3;x<w/2;x+=4) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.5})); break; }
    case 'chandelier': { const R=Math.min(w,h)/2;
      [1,0.68,0.38].forEach(k=>body.appendChild(el('circle',{cx:0,cy:0,r:R*k,fill:'none',stroke:c,'stroke-width':k===1?1.5:.8,'stroke-opacity':k===1?1:.6})));
      for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R,cy:Math.sin(a)*R,r:1.6,fill:c})); }
      body.appendChild(el('circle',{cx:0,cy:0,r:2.5,fill:c})); break; }
    case 'easel': { drawBox({fill:white?'#ffffff':fillSoft}); break; }
    case 'chiavari': { drawBox({fill:fillSoft,rx:2});
      body.appendChild(el('line',{x1:-w/2+2,y1:-h/2+2,x2:w/2-2,y2:-h/2+2,stroke:c,'stroke-width':2})); break; }
    case 'barstool': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/5,fill:c,'fill-opacity':.5})); break; }
    case 'piano': {
      body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/4} ${-h/2} Q ${w/2} ${-h/2} ${w/2} 0 Q ${w/2} ${h/2} ${w/6} ${h/2} L ${-w/2} ${h/2} Z`,
        fill:`color-mix(in srgb, ${c} 32%, var(--canvas))`,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('rect',{x:-w/2,y:h/2-3,width:w*0.5,height:3,fill:c,'fill-opacity':.55})); break; }
    case 'bleacher': { drawBox({fill:'transparent',sw:1.5});
      for(let i=1;i<4;i++) body.appendChild(el('line',{x1:-w/2,y1:-h/2+i*(h/4),x2:w/2,y2:-h/2+i*(h/4),stroke:c,'stroke-width':1.5,'stroke-opacity':.7})); break; }
    /* ---- V3 event-production pack ---- */
    case 'lighting': { drawBox({fill:'transparent',sw:1.2});      // truss span with par cans hanging under it
      { const nz=Math.max(2,Math.floor(w/8)), s=w/nz; body.appendChild(el('path',{d:Array.from({length:nz},(_,i)=>{ const x=-w/2+i*s; return `M ${x} ${-h/2} L ${x+s/2} ${h/2} L ${x+s} ${-h/2}`; }).join(' '),fill:'none',stroke:c,'stroke-width':1,'stroke-opacity':.7})); }   // V3 fix: Array.from's map gets no 3rd arg
      for(let x=-w/2+6;x<w/2-2;x+=Math.max(8,w/6)) body.appendChild(el('circle',{cx:x,cy:0,r:Math.min(3,h/2+1),fill:c})); break; }
    case 'led': case 'brandwall': { drawBox({fill:it.type==='led'?`color-mix(in srgb, ${c} 45%, var(--canvas))`:white?'#ffffff':fillSoft, rx:1});
      if(it.type==='led') for(let x=-w/2+w/8;x<w/2;x+=w/8) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.6,'stroke-opacity':.6}));
      else if(!white) body.appendChild(el('line',{x1:-w/2+3,y1:0,x2:w/2-3,y2:0,stroke:c,'stroke-width':1,'stroke-dasharray':'4 3'})); break; }
    case 'chocolatefountain': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      [0.34,0.18].forEach(k=>body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)*k,fill:'none',stroke:c,'stroke-width':1}))); break; }
    case 'chariot': { drawBox({fill:fillSoft, rx:Math.min(w,h)*0.4});
      [-1,1].forEach(sxx=>[-1,1].forEach(syy=>body.appendChild(el('circle',{cx:sxx*(w/2-w*0.18),cy:syy*h/2,r:Math.min(h*0.22,8),fill:'none',stroke:c,'stroke-width':1.5})))); break; }
    case 'smoke': { body.appendChild(el('rect',{x:-w/2,y:-h/4,width:w*0.7,height:h/2,rx:2,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M ${w*0.2} 0 q ${w*0.15} ${-h*0.3} ${w*0.3} 0`,fill:'none',stroke:c,'stroke-width':1.2,'stroke-opacity':.7})); break; }
    case 'dancers': { drawBox({fill:'transparent',dash:'5 3',sw:1.2});   // R137: small dancer figures (head, body, arms up / out, skirt)
      const nD=Math.max(3,Math.min(5,Math.round(+((it.properties||{}).count)||5))), r0=Math.min(3.2,h*0.1,w/(nD*3.2));
      for(let i=0;i<nD;i++){ const x=-w/2+w*(i+0.5)/nD, y=(i%2?-1:1)*h*0.1, up=i%2===0;
        body.appendChild(el('circle',{cx:x,cy:y-r0*2.2,r:r0*0.62,fill:c}));
        body.appendChild(el('path',{d:`M ${x} ${y-r0*1.5} L ${x} ${y+r0*0.4} M ${x-r0*1.5} ${y-r0*(up?2.6:1.2)} L ${x} ${y-r0*1.1} L ${x+r0*1.5} ${y-r0*(up?2.6:0.6)}`,
          fill:'none',stroke:c,'stroke-width':Math.max(0.8,r0*0.35),'stroke-linecap':'round','stroke-linejoin':'round'}));
        body.appendChild(el('path',{d:`M ${x-r0*0.45} ${y-r0*0.1} L ${x+r0*0.45} ${y-r0*0.1} L ${x+r0*1.2} ${y+r0*1.5} L ${x-r0*1.2} ${y+r0*1.5} Z`,fill:c,'fill-opacity':.75})); }
      break; }
    case 'generator': { drawBox({fill:fillSoft, rx:1});
      body.appendChild(el('path',{d:`M ${w*0.08} ${-h*0.32} L ${-w*0.06} ${h*0.04} L ${w*0.04} ${h*0.04} L ${-w*0.08} ${h*0.32}`,fill:'none',stroke:c,'stroke-width':1.5})); break; }
    case 'walkway': { drawBox({fill:`color-mix(in srgb, ${c} 24%, var(--canvas))`, rx:1});
      body.appendChild(el('line',{x1:0,y1:-h/2+2,x2:0,y2:h/2-2,stroke:c,'stroke-width':1,'stroke-dasharray':'6 4'})); break; }
    /* ---- Indian wedding + corporate pack (2026-10) ---- */
    case 'entrancegate': { const pw=Math.max(1.6,Math.min(2.6,it.width*0.14))*PX_PER_FT;
      body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:h,rx:2,fill:'none',stroke:c,'stroke-width':1,'stroke-dasharray':'4 3','stroke-opacity':.6}));
      [-1,1].forEach(sx=>body.appendChild(el('rect',{x:sx>0?w/2-pw:-w/2,y:-h/2,width:pw,height:h,rx:2,fill:fillSoft,stroke:c,'stroke-width':1.5})));
      for(let x=-w/2+pw+4;x<w/2-pw-2;x+=6) body.appendChild(el('circle',{cx:x,cy:0,r:1.7,fill:c,'fill-opacity':.75}));
      break; }
    case 'phoolchadar': { drawBox({fill:fillSoft,rx:2});
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sx,sy])=>body.appendChild(el('circle',{cx:sx*(w/2-3),cy:sy*(h/2-3),r:2.4,fill:c})));
      for(let x=-w/2+8;x<w/2-4;x+=8) for(let y=-h/2+8;y<h/2-4;y+=8) body.appendChild(el('circle',{cx:x,cy:y,r:2,fill:c,'fill-opacity':.45}));
      break; }
    case 'jhoola': { drawBox({fill:'transparent',dash:'4 3',sw:1});
      body.appendChild(el('line',{x1:-w/2+4,y1:0,x2:w/2-4,y2:0,stroke:c,'stroke-width':2}));
      body.appendChild(el('rect',{x:-w*0.31,y:-h*0.22,width:w*0.62,height:h*0.44,rx:3,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      [-1,1].forEach(sx=>body.appendChild(el('circle',{cx:sx*(w/2-4),cy:0,r:2.6,fill:c}))); break; }
    case 'haldi': case 'mehendi': { drawBox({fill:`color-mix(in srgb, ${c} 20%, var(--canvas))`,rx:3});
      body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h*0.1,8),fill:c,'fill-opacity':.6}));   // backdrop / rear edge
      if(it.type==='haldi'){ body.appendChild(el('rect',{x:-w*0.2,y:-h/2+h*0.14,width:w*0.4,height:h*0.24,rx:3,fill:c,'fill-opacity':.45}));
        [-1,1].forEach(sx=>body.appendChild(el('circle',{cx:sx*w*0.32,cy:h/2-h*0.16,r:Math.min(w,h)*0.07,fill:'none',stroke:c,'stroke-width':1.2}))); }
      else { const n=Math.max(1,Math.round(it.width/8));
        for(let i=0;i<n;i++){ const x=-w/2+(i+0.5)*w/n; body.appendChild(el('circle',{cx:x,cy:h*0.12,r:Math.min(w/n,h)*0.32,fill:'none',stroke:c,'stroke-width':1,'stroke-dasharray':'3 2'}));
          body.appendChild(el('rect',{x:x-w/n*0.35,y:-h/4-6,width:w/n*0.7,height:8,rx:3,fill:c,'fill-opacity':.5})); } }
      break; }
    case 'selfieframe': case 'welcomeboard': { drawBox({fill:fillSoft,rx:1});
      body.appendChild(el('rect',{x:-w/2+2,y:-h/2+2,width:w-4,height:h-4,fill:'none',stroke:c,'stroke-width':.8,'stroke-opacity':.6}));
      [[-1,-1],[1,1]].forEach(([sx,sy])=>body.appendChild(el('circle',{cx:sx*(w/2-2),cy:sy*(h/2-2),r:2.6,fill:c,'fill-opacity':.8}))); break; }
    case 'fairylights': { drawBox({fill:'transparent',dash:'2 4',sw:1});
      for(let i=0;i<16;i++){ const a=i/16*Math.PI*2, k=Math.min(Math.abs(1/Math.cos(a)),Math.abs(1/Math.sin(a)));
        body.appendChild(el('line',{x1:0,y1:0,x2:Math.cos(a)*k*w/2,y2:Math.sin(a)*k*h/2,stroke:c,'stroke-width':.7,'stroke-opacity':.55,'stroke-dasharray':'1 3'})); }
      body.appendChild(el('circle',{cx:0,cy:0,r:3,fill:c})); break; }
    case 'couplesofa': { drawBox({fill:fillSoft,rx:Math.min(w,h)*0.3});
      body.appendChild(el('path',{d:`M ${-w/2+2} ${-h/2+h*0.4} Q 0 ${-h/2-4} ${w/2-2} ${-h/2+h*0.4}`,fill:'none',stroke:c,'stroke-width':2.2}));
      body.appendChild(el('line',{x1:0,y1:-h/2+h*0.3,x2:0,y2:h/2-2,stroke:c,'stroke-width':.6,'stroke-opacity':.5})); break; }
    case 'livecounter': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2+3,x2:w/2,y2:-h/2+3,stroke:c,'stroke-width':2}));
      body.appendChild(el('circle',{cx:-w*0.2,cy:h*0.1,r:Math.min(w,h)*0.18,fill:'none',stroke:c,'stroke-width':1.2})); break; }
    case 'kidszone': { drawBox({fill:`color-mix(in srgb, ${c} 14%, var(--canvas))`,rx:6,dash:'6 3'});
      body.appendChild(el('rect',{x:-w/2+6,y:-h/2+6,width:w*0.45,height:h*0.45,rx:3,fill:c,'fill-opacity':.3,stroke:c,'stroke-width':1}));
      body.appendChild(el('circle',{cx:-w/4,cy:h/4,r:Math.min(w,h)*0.12,fill:'none',stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M ${w/2-3*PX_PER_FT} ${-h*0.3} L ${w/2-3*PX_PER_FT} ${h*0.3}`,stroke:c,'stroke-width':4,'stroke-opacity':.45,'stroke-linecap':'round'})); break; }
    case 'aircooler': { drawBox({fill:fillSoft,rx:3});
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)*0.32,fill:'none',stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M 0 0 L ${Math.min(w,h)*0.28} ${-Math.min(w,h)*0.1} M 0 0 L ${-Math.min(w,h)*0.05} ${Math.min(w,h)*0.28} M 0 0 L ${-Math.min(w,h)*0.24} ${-Math.min(w,h)*0.16}`,stroke:c,'stroke-width':1.2,'stroke-linecap':'round'})); break; }
    /* ---- event-aware décor + production pack (2026-10b) ---- */
    case 'floralentrance': case 'stagebackdrop': case 'flowerwall': case 'toran': {   // florals along a frame / wall line
      drawBox({fill:it.type==='toran'?'transparent':fillSoft, rx:1, sw:it.type==='toran'?0.8:1.5, dash:it.type==='toran'?'3 2':''});
      const step=it.type==='flowerwall'?5:7, R=Math.max(1.4,Math.min(3,h*0.32));
      for(let x=-w/2+step/2;x<w/2;x+=step) body.appendChild(el('circle',{cx:x,cy:it.type==='toran'?h*0.15:0,r:R,fill:c,'fill-opacity':(Math.round(x)%3)?0.55:0.9}));
      if(it.type==='floralentrance') [-1,1].forEach(sx=>body.appendChild(el('rect',{x:sx>0?w/2-2.4*PX_PER_FT:-w/2,y:-h/2,width:2.4*PX_PER_FT,height:h,rx:2,fill:c,'fill-opacity':.35,stroke:c,'stroke-width':1})));
      break; }
    case 'floralpillar': case 'aislefloral': case 'centrepiece': case 'balloonbunch': case 'diyastand': {
      const R=Math.min(w,h)/2, n=it.type==='balloonbunch'?5:it.type==='diyastand'?5:7;
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      for(let i=0;i<n;i++){ const a=i/n*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.5,cy:Math.sin(a)*R*0.5,r:R*(it.type==='diyastand'?0.14:0.3),fill:c,'fill-opacity':.6})); }
      body.appendChild(el('circle',{cx:0,cy:0,r:R*0.2,fill:c})); break; }
    case 'balloonarch': {
      for(let i=0;i<=14;i++){ const t=i/14, x=-w/2+3+(w-6)*t, y=h/2-(h+8)*Math.sin(t*Math.PI)*0.6;
        body.appendChild(el('circle',{cx:x,cy:y,r:Math.max(2,Math.min(4,h*0.3)),fill:c,'fill-opacity':i%2?0.5:0.85})); }
      break; }
    case 'lectern': { drawBox({fill:`color-mix(in srgb, ${c} 26%, var(--canvas))`, rx:2});
      body.appendChild(el('line',{x1:-w/2+2,y1:h/2-3,x2:w/2-2,y2:h/2-3,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:-h*0.15,r:1.6,fill:c})); break; }
    case 'dais': { drawBox({fill:`color-mix(in srgb, ${c} 16%, var(--canvas))`, rx:1});
      body.appendChild(el('rect',{x:-w*0.4,y:-h*0.05,width:w*0.8,height:h*0.22,rx:1,fill:c,'fill-opacity':.35}));   // table
      { const n=Math.max(1,Math.min(16,(it.properties&&it.properties.chairs)|0||8));
        for(let i=0;i<n;i++) body.appendChild(el('rect',{x:-w*0.4+(i+0.5)*(w*0.8/n)-2.5,y:-h*0.32,width:5,height:5,rx:1,fill:c,'fill-opacity':.85})); }
      break; }
    case 'flagstand': { const R=Math.min(w,h)/2, fs0=screenContent(it);
      body.appendChild(el('circle',{cx:0,cy:0,r:R*0.6,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M 0 0 L ${R} ${-R*0.5} L ${R} ${R*0.2} Z`,fill:white?'#ffffff':c,'fill-opacity':white?1:.7,stroke:c,'stroke-width':white?.8:0}));
      if(fs0 && fs0.pic) screenPic2D(body, fs0, 0, -R*0.6, R, R*0.66);
      break; }
    case 'hoarding': { drawBox({fill:white?'#ffffff':fillSoft, rx:0, sw:2}); break; }
    case 'patower': { drawBox({fill:'transparent',sw:1.2});
      body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/2} ${h/2} M ${w/2} ${-h/2} L ${-w/2} ${h/2}`,stroke:c,'stroke-width':.8,'stroke-opacity':.6}));
      body.appendChild(el('rect',{x:-w*0.3,y:-h*0.3,width:w*0.6,height:h*0.6,rx:1,fill:c,'fill-opacity':.7})); break; }
    case 'lightingtree': { const R=Math.min(w,h)/2;
      [0,120,240].forEach(d=>{ const a=(d-90)*Math.PI/180; body.appendChild(el('line',{x1:0,y1:0,x2:Math.cos(a)*R,y2:Math.sin(a)*R,stroke:c,'stroke-width':1.2})); });
      body.appendChild(el('line',{x1:-R,y1:0,x2:R,y2:0,stroke:c,'stroke-width':2}));
      [-0.75,-0.25,0.25,0.75].forEach(k=>body.appendChild(el('circle',{cx:k*R,cy:0,r:Math.max(1.4,R*0.16),fill:c})));
      break; }
    case 'trophytable': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:1});
      for(let i=0;i<5;i++){ const x=-w/2+(i+0.5)*w/5; body.appendChild(el('path',{d:`M ${x-2} ${-2} h 4 l -1 3 h -2 Z`,fill:c,'fill-opacity':.8})); }
      break; }
    case 'havankund': { const R=Math.min(w,h)/2;
      body.appendChild(el('rect',{x:-R,y:-R,width:2*R,height:2*R,fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('rect',{x:-R*0.55,y:-R*0.55,width:R*1.1,height:R*1.1,fill:'#ff9a3c','fill-opacity':.75}));
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx,sy])=>body.appendChild(el('circle',{cx:sx*R*0.8,cy:sy*R*0.8,r:Math.max(1,R*0.1),fill:c}))); break; }
    case 'rangoli': { const R=Math.min(w,h)/2;
      for(let k=0;k<3;k++) body.appendChild(el('circle',{cx:0,cy:0,r:R*(1-k*0.3),fill:'none',stroke:c,'stroke-width':1.2,'stroke-opacity':1-k*0.2}));
      for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; body.appendChild(el('ellipse',{cx:Math.cos(a)*R*0.55,cy:Math.sin(a)*R*0.55,rx:R*0.22,ry:R*0.1,transform:`rotate(${i*45} ${Math.cos(a)*R*0.55} ${Math.sin(a)*R*0.55})`,fill:c,'fill-opacity':.55})); }
      break; }
    case 'lanterns': { const R=Math.min(w,h)/2;
      [[-0.4,-0.3,0.45],[0.35,-0.25,0.35],[0,0.35,0.5]].forEach(([x,y,r])=>{ body.appendChild(el('rect',{x:x*R*2-r*R,y:y*R*2-r*R,width:2*r*R,height:2*r*R,rx:1,fill:'#ffd98a','fill-opacity':.6,stroke:c,'stroke-width':1})); }); break; }
    case 'hangingfloral': { drawBox({fill:'transparent',sw:1,dash:'4 3'});
      for(let i=0;i<7;i++) for(let j=0;j<7;j++){ if((i+j)%2) continue; body.appendChild(el('circle',{cx:-w/2+(i+0.5)*w/7,cy:-h/2+(j+0.5)*h/7,r:Math.max(1.5,Math.min(w,h)/20),fill:c,'fill-opacity':.6})); }
      break; }
    case 'neonsign': { drawBox({fill:`color-mix(in srgb, ${c} 14%, var(--canvas))`, rx:1});
      body.appendChild(el('path',{d:`M ${-w*0.35} 0 q ${w*0.12} ${-h*0.6} ${w*0.24} 0 t ${w*0.24} 0 t ${w*0.22} 0`,fill:'none',stroke:'#ff4fd8','stroke-width':2})); break; }
    /* ---- complete-catalogue pack (2026-10d) ---- */
    case 'backdrop': case 'projector': case 'teleprompter': { drawBox({fill:white?'#ffffff':`color-mix(in srgb, ${c} 20%, var(--canvas))`, rx:1});
      if(it.type!=='backdrop') body.appendChild(el('rect',{x:-w*0.42,y:-h*0.25,width:w*0.84,height:h*0.5,fill:'#9fb6ff','fill-opacity':.6}));
      else if(!white) for(let i=1;i<4;i++) body.appendChild(el('line',{x1:-w/2+i*w/4,y1:-h/2,x2:-w/2+i*w/4,y2:h/2,stroke:c,'stroke-width':.6,'stroke-opacity':.5}));
      break; }
    case 'floralstand': case 'urli': case 'kalash': case 'plinth': case 'micstand': case 'pyro': case 'extinguisher': { const R=Math.min(w,h)/2;
      const ring=it.type==='urli'||it.type==='kalash';
      body.appendChild(el(it.type==='plinth'||it.type==='extinguisher'?'rect':'circle', it.type==='plinth'||it.type==='extinguisher'
        ? {x:-w/2,y:-h/2,width:w,height:h,rx:1,fill:it.type==='extinguisher'?'#dc2626':fillSoft,'fill-opacity':it.type==='extinguisher'?.7:1,stroke:c,'stroke-width':1.2}
        : {cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      if(ring) body.appendChild(el('circle',{cx:0,cy:0,r:R*0.55,fill:c,'fill-opacity':.45}));
      else if(it.type==='floralstand') for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.5,cy:Math.sin(a)*R*0.5,r:R*0.28,fill:c,'fill-opacity':.55})); }
      else if(it.type==='pyro') for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; body.appendChild(el('line',{x1:0,y1:0,x2:Math.cos(a)*R,y2:Math.sin(a)*R,stroke:'#f59e0b','stroke-width':1})); }
      else if(it.type==='micstand') body.appendChild(el('circle',{cx:0,cy:0,r:R*0.3,fill:c}));
      break; }
    case 'decorbox': case 'signage': case 'counter': case 'kiosk': case 'shoerack': case 'tvstand': { drawBox({fill:white?'#ffffff':fillSoft, rx:it.type==='decorbox'?3:1});
      if(it.type==='decorbox') body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/2} ${h/2} M ${w/2} ${-h/2} L ${-w/2} ${h/2}`,stroke:c,'stroke-width':.7,'stroke-opacity':.5}));
      else if(it.type==='shoerack') for(let i=1;i<6;i++) body.appendChild(el('line',{x1:-w/2+i*w/6,y1:-h/2,x2:-w/2+i*w/6,y2:h/2,stroke:c,'stroke-width':.6}));
      else if(!white) body.appendChild(el('rect',{x:-w*0.35,y:-h*0.3,width:w*0.7,height:h*0.25,fill:c,'fill-opacity':.5}));
      break; }
    case 'recttable': {
      drawBox({fill:fillSoft, rx:1});
      const n=Math.max(0,Math.min(12,it.properties.seats|0));
      for(let i=0;i<n;i++) body.appendChild(el('circle',{cx:-w/2+(i+0.5)/n*w,cy:h/2+3.2,r:clamp(Math.min(w/Math.max(1,n),6)*0.5,1.5,3.4),fill:c,'fill-opacity':.85}));
      break; }
    case 'stageroof': case 'interpreter': case 'ticketbooth': case 'watchtower': case 'towerlight': case 'stall': {
      drawBox({fill:it.type==='stageroof'?'transparent':fillSoft, rx:1, dash:it.type==='stageroof'?'6 4':''});
      const k=Math.min(w,h)*0.12;
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx,sy])=>body.appendChild(el('rect',{x:sx*(w/2-k)-k/2,y:sy*(h/2-k)-k/2,width:k,height:k,fill:c,'fill-opacity':.8})));
      if(it.type==='stageroof'||it.type==='watchtower') body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/2} ${h/2} M ${w/2} ${-h/2} L ${-w/2} ${h/2}`,stroke:c,'stroke-width':.7,'stroke-opacity':.45}));
      break; }
    case 'varmala': case 'umbrellas': case 'gaddi': { const R=Math.min(w,h)/2;
      if(it.type==='gaddi'){ drawBox({fill:fillSoft, rx:2});
        [[-1,0],[1,0],[0,-1],[0,1]].forEach(([sx,sy])=>body.appendChild(el('rect',{x:sx? sx*(w/2-w*0.08)-w*0.05 : -w*0.4, y:sy? sy*(h/2-h*0.08)-h*0.05 : -h*0.4, width:sx? w*0.1 : w*0.8, height:sy? h*0.1 : h*0.8, rx:2, fill:c,'fill-opacity':.45}))); break; }
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.3}));
      if(it.type==='umbrellas') for(let i=0;i<5;i++){ const a=i/5*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.55,cy:Math.sin(a)*R*0.55,r:R*0.3,fill:c,'fill-opacity':.35,stroke:c,'stroke-width':.8})); }
      else body.appendChild(el('circle',{cx:0,cy:0,r:R*0.75,fill:'none',stroke:c,'stroke-width':1,'stroke-dasharray':'3 2'}));
      break; }
    case 'doli': case 'altar': case 'dessert': case 'coffee': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:1});
      if(it.type==='doli') body.appendChild(el('line',{x1:-w/2-4,y1:0,x2:w/2+4,y2:0,stroke:c,'stroke-width':1.6}));
      else for(let i=0;i<3;i++) body.appendChild(el('circle',{cx:-w/3+i*w/3,cy:0,r:Math.max(1.5,Math.min(w/8,h*0.3)),fill:c,'fill-opacity':.5}));
      break; }
    case 'stanchion': { drawBox({fill:'transparent', sw:0.01});
      const n=Math.max(2,Math.round(w/(5*PX_PER_FT))+1);
      body.appendChild(el('line',{x1:-w/2,y1:0,x2:w/2,y2:0,stroke:'#b91c1c','stroke-width':1.6}));
      for(let i=0;i<n;i++) body.appendChild(el('circle',{cx:-w/2+i*w/(n-1),cy:0,r:Math.max(1.6,h*0.3),fill:c}));
      break; }
    case 'ambulance': { drawBox({fill:'transparent', dash:'6 4'});
      body.appendChild(el('rect',{x:-w*0.38,y:-h*0.3,width:w*0.76,height:h*0.6,rx:2,fill:'#ffffff','fill-opacity':.85,stroke:c,'stroke-width':1}));
      body.appendChild(el('path',{d:`M ${-h*0.12} 0 h ${h*0.24} M 0 ${-h*0.12} v ${h*0.24}`,stroke:'#dc2626','stroke-width':2}));
      break; }
    // R135 visual-asset-catalogue pack
    case 'lawnfloor': { drawBox({fill:'color-mix(in srgb, #4d8b3a 30%, var(--canvas))', rx:1, dash:'6 3'});
      for(let x=-w/2+6;x<w/2-3;x+=12) for(let y=-h/2+6;y<h/2-3;y+=12) body.appendChild(el('path',{d:`M ${x-2} ${y+2} l 2 -4 l 2 4`,stroke:'#3f7f45','stroke-width':.8,fill:'none','stroke-opacity':.7}));
      break; }
    case 'stagelight': { const R=Math.min(w,h)/2, st=(it.properties||{}).style||'';
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('circle',{cx:0,cy:0,r:R*(st==='beam'?0.25:st==='flood'?0.7:0.45),fill:c,'fill-opacity':.7}));
      if(st==='flood') body.appendChild(el('rect',{x:-R*0.8,y:-R*0.5,width:R*1.6,height:R,fill:'none',stroke:c,'stroke-width':.8}));
      break; }
    case 'pathlights': { const st=(it.properties||{}).style||'';
      if(st==='rope'){ body.appendChild(el('line',{x1:-w/2,y1:0,x2:w/2,y2:0,stroke:c,'stroke-width':Math.max(1.5,h*0.35),'stroke-linecap':'round','stroke-opacity':.85})); }
      else { drawBox({fill:'transparent', dash:'2 3', sw:.6});
        const n=Math.max(2,Math.round(it.width/4)); for(let i=0;i<n;i++) body.appendChild(el('circle',{cx:-w/2+(i+0.5)*w/n,cy:0,r:Math.max(1.6,Math.min(h*0.35,3)),fill:c,'fill-opacity':.85})); }
      break; }
    case 'sidescreen': { drawBox({fill:c,rx:1}); break; }
    case 'stagedeck': { drawBox({fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`, rx:2});
      body.appendChild(el('line',{x1:-w/2+3,y1:h/2-2.5,x2:w/2-3,y2:h/2-2.5,stroke:c,'stroke-width':1,'stroke-dasharray':'2 2'})); break; }
    case 'stagestairs': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:1});
      const n=stairStepCount(it); for(let i=1;i<n;i++) body.appendChild(el('line',{x1:-w/2,y1:-h/2+i*h/n,x2:w/2,y2:-h/2+i*h/n,stroke:c,'stroke-width':1}));
      body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h/n,3),fill:c,'fill-opacity':.45}));   // top tread (stage side)
      break; }
    case 'installation': { const R=Math.min(w,h)/2, st=(it.properties||{}).style||'';
      if(st==='letters'){ drawBox({fill:fillSoft, rx:1}); const n=4; for(let i=0;i<n;i++) body.appendChild(el('rect',{x:-w/2+w*(i+0.15)/n,y:-h*0.2,width:w*0.7/n,height:h*0.4,rx:1,fill:c,'fill-opacity':.6})); }
      else if(st==='lighttunnel'){ drawBox({fill:'transparent', dash:'3 3'}); for(let y=-h/2+4;y<h/2;y+=8) body.appendChild(el('line',{x1:-w/2,y1:y,x2:w/2,y2:y,stroke:c,'stroke-width':1.2,'stroke-opacity':.8})); }
      else { body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.2,'stroke-dasharray':'3 2'}));
        for(let k=0;k<8;k++){ const a=k/8*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.6,cy:Math.sin(a)*R*0.6,r:Math.max(1.2,R*0.08),fill:c})); } }
      break; }
    case 'jyothi': { const R=Math.min(w,h)/2, candle=((it.properties||{}).style||'')==='candle';   // R154: round base, tray ring of lamps, flame at the top
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('circle',{cx:0,cy:0,r:R*0.62,fill:'none',stroke:c,'stroke-width':.8,'stroke-dasharray':candle?'1.5 1.5':''}));
      for(let k=0;k<6;k++){ const a=k/6*Math.PI*2-Math.PI/2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.62,cy:Math.sin(a)*R*0.62,r:Math.max(0.9,R*0.13),fill:'#ffb547',stroke:c,'stroke-width':.4})); }
      body.appendChild(el('path',{d:`M 0 ${-R*0.38} C ${R*0.2} ${-R*0.12} ${R*0.18} ${R*0.12} 0 ${R*0.2} C ${-R*0.18} ${R*0.12} ${-R*0.2} ${-R*0.12} 0 ${-R*0.38} Z`,fill:'#ff9a3c',stroke:c,'stroke-width':.4}));
      break; }
    default: drawBox({});
  }
  // R135: standalone screens show their theme + text (or a builder-only placeholder) on the screen face
  let scrText=false;
  if(it.type!=='stage' && window.HelmScreen && HelmScreen.isScreenType(it.type)){
    const sc=screenContent(it);
    if(HelmScreen.hasContent(sc)){ screenFace2D(body, it, sc, w, h, c); scrText=!sc.pic && HelmScreen.hasText(sc); }
    else if(!white){ screenPlaceholder2D(body, -w/2, -h/2, w, h*0.5); scrText=screenPlaceholderOn(); }
  } else if(it.type!=='stage' && it.type!=='flagstand' && window.HelmScreen && HelmScreen.isPosterType && HelmScreen.isPosterType(it.type)){   // R255: posters show their picture
    const pc=screenContent(it); if(pc && pc.pic) screenFace2D(body, it, pc, w, h, c);
  }
  g.appendChild(body);

  // label (counter-rotated so it stays upright)
  const fs = clamp(Math.min(w,h)*0.16, 7, 11);
  const t = el('text',{class:'lbl', x:0, y: (it.type==='table'||it.type==='cocktail')?3:(scrText && !(it.rotation%360) ? h*0.25+fs*0.35 : fs*0.35),
    'text-anchor':'middle','font-size':fs, transform:`rotate(${-it.rotation})`});
  t.textContent = it.label;
  g.appendChild(t);

  return g;
}
function renderItem(it){
  const w=it.width*PX_PER_FT, h=it.height*PX_PER_FT;
  const cx=(it.x+it.width/2)*PX_PER_FT, cy=(it.y+it.height/2)*PX_PER_FT;
  const g = el('g',{ class:'obj', transform:`translate(${cx} ${cy}) rotate(${it.rotation})`, 'data-id':it.id,
    tabindex:'0', role:'button', 'aria-pressed':String(isSelected(it.id)),
    'aria-label':(it.label||'Object')+' — '+((ASSETS[it.type]&&ASSETS[it.type].label)||it.type||'object') });
  const c = it.color;
  const fillSoft = `color-mix(in srgb, ${c} 16%, var(--canvas))`;

  // invisible hitbox (a hair larger) for easy grabbing + hover ring
  g.appendChild(el('rect',{class:'hitbox', x:-w/2, y:-h/2, width:w, height:h, rx:2,
    fill:'transparent', stroke:'transparent','stroke-width':2}));

  const body = el('g',{class:'body'});
  const white = !!(window.HelmScreen && HelmScreen.whiteFace && HelmScreen.whiteFace(it));   // R255: a poster without a picture is plain white

  const drawBox = (opts={})=> body.appendChild(el('rect',{
    x:-w/2,y:-h/2,width:w,height:h, rx:opts.rx??3,
    fill:opts.fill??fillSoft, stroke:c,'stroke-width':opts.sw??1.5,
    'stroke-dasharray':opts.dash??''}));

  switch(it.type){
    case 'stage': case 'dancefloor': {
      drawBox({fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`, rx:3});
      if(it.type==='dancefloor'){ // parquet / LED checker
        const n=Math.max(2,Math.min(8,Math.round(Math.max(w,h)/(4*PX_PER_FT)))), tw=w/n, th=h/n;
        for(let i=0;i<n;i++) for(let j=0;j<n;j++) if((i+j)%2) body.appendChild(el('rect',{x:-w/2+i*tw,y:-h/2+j*th,width:tw,height:th,fill:c,'fill-opacity':.22}));
      } else {    // stage: backdrop band (rear), skirting edge (front) + built-in steps (R135: centre / left / right / both / none)
        const sc=screenContent(it);
        if(sc && sc.layout==='none') body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h*0.12,10),fill:c,'fill-opacity':.35}));   // R137: no screen
        else if(window.HelmScreen && HelmScreen.hasContent(sc)) screenBand2D(body, it, sc, w, h, c);   // R135: themed screen + its text
        else { body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h*0.12,10),fill:c,'fill-opacity':.55}));
          if(!(it.properties||{}).nobackdrop) screenPlaceholder2D(body, -w/2, -h/2, w, Math.min(h*0.12,10)); }
        body.appendChild(el('line',{x1:-w/2+3,y1:h/2-2.5,x2:w/2-3,y2:h/2-2.5,stroke:c,'stroke-width':1,'stroke-dasharray':'2 2'}));
        const sw=Math.min(8*PX_PER_FT,w*0.25);
        stageStepOffsets(it.properties&&it.properties.builtinSteps, w, sw).forEach(ox=>{
          for(let i=1;i<=3;i++) body.appendChild(el('line',{x1:ox-sw/2,y1:h/2+i*3.4,x2:ox+sw/2,y2:h/2+i*3.4,stroke:c,'stroke-width':1,'stroke-opacity':.75})); });
      }
      break; }
    case 'press': case 'desk': case 'truck': case 'booth': case 'exit': {
      drawBox({});
      if(it.type==='exit'){
        body.appendChild(el('path',{d:`M ${-w/6} 0 L ${w/6} 0 M ${w/6-5} -4 L ${w/6} 0 L ${w/6-5} 4`,
          stroke:c,'stroke-width':2,fill:'none','stroke-linecap':'round','stroke-linejoin':'round'}));
      }
      break; }
    case 'podium': {
      drawBox({rx:2,fill:c});
      break; }
    case 'barricade': case 'fence': {
      drawBox({fill:'transparent',dash: it.type==='fence'?'2 3':'', sw:2});
      // hatch
      const step=8;
      for(let x=-w/2; x<w/2; x+=step)
        body.appendChild(el('line',{x1:x,y1:-h/2,x2:Math.min(x+step,w/2),y2:h/2,stroke:c,'stroke-width':1,'stroke-opacity':.7}));
      break; }
    case 'dj': { drawBox({fill:c,rx:2}); break; }
    case 'chairrow': case 'seatblock': {
      const cong=congestionOf(it), dotC=CONG_COLORS[cong]||c;   // amber/red when tight/packed
      drawBox({fill:'transparent',dash:'4 3',sw:1, ...(cong?{}:{})});
      const rows=Math.max(1, it.properties.rows|0), cols=Math.max(1, it.properties.cols|0);
      // cap drawn dots for very dense blocks (subsample but keep full coverage) — perf
      const CAP=450; let dr=rows, dc=cols;
      if(rows*cols>CAP){ const s=Math.sqrt(CAP/(rows*cols)); dr=Math.max(1,Math.round(rows*s)); dc=Math.max(1,Math.round(cols*s)); }
      const r = Math.min(w/dc, h/dr)*0.30;
      for(let ri=0;ri<dr;ri++)for(let ci=0;ci<dc;ci++){
        const px=-w/2 + (ci+0.5)/dc*w;
        const py=-h/2 + (ri+0.5)/dr*h;
        body.appendChild(el('circle',{cx:px,cy:py,r:clamp(r,1,4.2),fill:dotC,'fill-opacity':.85}));
      }
      break; }
    case 'longtable': case 'headtable': {
      drawBox({fill:fillSoft});
      const seats=Math.max(0, it.properties.seats|0);
      const oneSide = it.type==='headtable';
      const perSide = oneSide ? seats : Math.ceil(seats/2);
      const place=(n,yy)=>{ for(let i=0;i<n;i++){ const px=-w/2+(i+0.5)/n*w;
        body.appendChild(el('circle',{cx:px,cy:yy,r:clamp(Math.min(w/seats,6)*0.5,1.5,3.4),fill:c,'fill-opacity':.85})); } };
      place(perSide, -h/2-3.2);
      if(!oneSide) place(seats-perSide, h/2+3.2);
      break; }
    case 'canopy': {
      drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:2, dash:'6 4', sw:1.5});
      // draped roof diagonals + corner posts
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:w/2,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.4}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:-w/2,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.4}));
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sxx,syy])=>
        body.appendChild(el('circle',{cx:sxx*(w/2-3),cy:syy*(h/2-3),r:2.4,fill:c})));
      break; }
    case 'tent': {
      drawBox({fill:`color-mix(in srgb, ${c} 14%, var(--canvas))`});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      body.appendChild(el('line',{x1:-w/2,y1:h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      body.appendChild(el('line',{x1:w/2,y1:h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      break; }
    case 'arch': {
      body.appendChild(el('path',{d:`M ${-w/2} ${h/2} Q 0 ${-h/2-6} ${w/2} ${h/2}`,fill:'none',stroke:c,'stroke-width':2.5}));
      break; }
    case 'bar': case 'buffet': {
      drawBox({fill:`color-mix(in srgb, ${c} 20%, var(--canvas))`});
      body.appendChild(el('line',{x1:-w/2,y1:-h/6,x2:w/2,y2:-h/6,stroke:c,'stroke-width':1,'stroke-opacity':.6}));
      break; }
    case 'lounge': {
      drawBox({fill:fillSoft,rx:4});
      // sofa hint
      body.appendChild(el('rect',{x:-w/2+3,y:-h/2+3,width:w-6,height:h*0.32,rx:3,fill:c,'fill-opacity':.55}));
      break; }
    case 'checkpoint': { drawBox({fill:c,rx:2}); break; }
    case 'table': case 'cocktail': {
      const rad=Math.min(w,h)/2;
      if(it.properties && it.properties.shape==='square')
        body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:h,rx:2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      else
        body.appendChild(el('circle',{cx:0,cy:0,r:rad,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:rad*0.78,fill:'none',stroke:c,'stroke-width':.6,'stroke-opacity':.45}));   // cloth / plate ring
      if(it.type==='table') body.appendChild(el('circle',{cx:0,cy:0,r:Math.max(2,rad*0.18),fill:c,'fill-opacity':.45}));   // centrepiece
      const seats=Math.max(0, it.properties.seats|0);
      for(let s=0;s<seats;s++){
        const ang=s/seats*Math.PI*2 - Math.PI/2;
        body.appendChild(el('circle',{cx:Math.cos(ang)*(rad+3.5),cy:Math.sin(ang)*(rad+3.5),r:2.6,fill:c,'fill-opacity':.85}));
      }
      break; }
    case 'ledscreen': { drawBox({fill:c,rx:1}); break; }
    case 'redcarpet': { drawBox({fill:`color-mix(in srgb, ${c} 30%, var(--canvas))`,rx:1});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2+2,x2:-w/2,y2:h/2-2,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2+2,x2:w/2,y2:h/2-2,stroke:c,'stroke-width':1.5})); break; }
    case 'planter': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/6,fill:c,'fill-opacity':.6})); break; }
    case 'truss': { drawBox({fill:'transparent',sw:1.5});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:w/2,y2:h/2,stroke:c,'stroke-width':1}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:-w/2,y2:h/2,stroke:c,'stroke-width':1})); break; }
    case 'parking': { drawBox({fill:'transparent',dash:'5 4',sw:1.5});
      for(let x=-w/2+8;x<w/2;x+=10) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.5,'stroke-opacity':.5})); break; }
    case 'firstaid': { drawBox({fill:fillSoft});
      body.appendChild(el('path',{d:`M 0 ${-h/4} V ${h/4} M ${-w/4} 0 H ${w/4}`,stroke:c,'stroke-width':2.5,'stroke-linecap':'round'})); break; }
    case 'sofa': case 'loveseat': case 'armchair': case 'bench': {
      drawBox({fill:fillSoft,rx:4});
      body.appendChild(el('rect',{x:-w/2+2,y:-h/2+2,width:w-4,height:h*0.34,rx:3,fill:c,'fill-opacity':.5})); break; }   // backrest hint
    case 'coffeetable': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`,rx:3}); break; }
    case 'ottoman': case 'floral': case 'pillar': case 'heater': case 'uplight': {
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      if(it.type==='floral' || it.type==='pillar'){ const R=Math.min(w,h)/2;
        for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.45,cy:Math.sin(a)*R*0.45,r:R*0.28,fill:c,'fill-opacity':.45})); }
        body.appendChild(el('circle',{cx:0,cy:0,r:R*0.22,fill:c,'fill-opacity':.85})); }
      break; }
    case 'fountain': {
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/4,fill:'none',stroke:c,'stroke-width':1,'stroke-opacity':.6})); break; }
    case 'floralarch': {
      body.appendChild(el('path',{d:`M ${-w/2+3} ${h/2} Q 0 ${-h/2-6} ${w/2-3} ${h/2}`,fill:'none',stroke:c,'stroke-width':1.5,'stroke-opacity':.6}));
      for(let i=0;i<=10;i++){ const t=i/10, x=(1-t)*(1-t)*(-w/2+3)+t*t*(w/2-3), y=(1-t)*(1-t)*(h/2)+2*t*(1-t)*(-h/2-6)+t*t*(h/2);
        if(t<=0.6 || i%2===0) body.appendChild(el('circle',{cx:x,cy:y,r:t<=0.6?2.6:1.8,fill:c,'fill-opacity':i%3?0.6:0.9})); }
      [-1,1].forEach(sx=>body.appendChild(el('rect',{x:sx*(w/2-3)-3,y:h/2-3,width:6,height:6,rx:1.5,fill:fillSoft,stroke:c,'stroke-width':1}))); break; }
    case 'mandap': {
      drawBox({fill:`color-mix(in srgb, ${c} 16%, var(--canvas))`, rx:2, dash:'6 4', sw:1.5});
      body.appendChild(el('rect',{x:-w*0.41,y:-h*0.41,width:w*0.82,height:h*0.82,rx:2,fill:c,'fill-opacity':.12,stroke:c,'stroke-width':.75,'stroke-opacity':.5}));
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sxx,syy])=>{ const px=sxx*(w/2-1.2*PX_PER_FT), py=syy*(h/2-1.2*PX_PER_FT);
        body.appendChild(el('circle',{cx:px,cy:py,r:Math.max(3,0.75*PX_PER_FT),fill:c,'fill-opacity':.8}));
        body.appendChild(el('circle',{cx:px,cy:py,r:Math.max(5,1.3*PX_PER_FT),fill:'none',stroke:c,'stroke-width':.75,'stroke-opacity':.6})); });
      body.appendChild(el('ellipse',{cx:0,cy:0,rx:w*0.36,ry:h*0.36,fill:'none',stroke:c,'stroke-width':.75,'stroke-dasharray':'3 3','stroke-opacity':.55}));   // canopy dome
      body.appendChild(el('rect',{x:-0.7*PX_PER_FT,y:-0.7*PX_PER_FT,width:1.4*PX_PER_FT,height:1.4*PX_PER_FT,fill:c,'fill-opacity':.55,rx:1})); break; }
    case 'drape': { drawBox({fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`});
      for(let x=-w/2+3;x<w/2;x+=4) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.5})); break; }
    case 'chandelier': { const R=Math.min(w,h)/2;
      [1,0.68,0.38].forEach(k=>body.appendChild(el('circle',{cx:0,cy:0,r:R*k,fill:'none',stroke:c,'stroke-width':k===1?1.5:.8,'stroke-opacity':k===1?1:.6})));
      for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R,cy:Math.sin(a)*R,r:1.6,fill:c})); }
      body.appendChild(el('circle',{cx:0,cy:0,r:2.5,fill:c})); break; }
    case 'easel': { drawBox({fill:white?'#ffffff':fillSoft}); break; }
    case 'chiavari': { drawBox({fill:fillSoft,rx:2});
      body.appendChild(el('line',{x1:-w/2+2,y1:-h/2+2,x2:w/2-2,y2:-h/2+2,stroke:c,'stroke-width':2})); break; }
    case 'barstool': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/5,fill:c,'fill-opacity':.5})); break; }
    case 'piano': {
      body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/4} ${-h/2} Q ${w/2} ${-h/2} ${w/2} 0 Q ${w/2} ${h/2} ${w/6} ${h/2} L ${-w/2} ${h/2} Z`,
        fill:`color-mix(in srgb, ${c} 32%, var(--canvas))`,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('rect',{x:-w/2,y:h/2-3,width:w*0.5,height:3,fill:c,'fill-opacity':.55})); break; }
    case 'bleacher': { drawBox({fill:'transparent',sw:1.5});
      for(let i=1;i<4;i++) body.appendChild(el('line',{x1:-w/2,y1:-h/2+i*(h/4),x2:w/2,y2:-h/2+i*(h/4),stroke:c,'stroke-width':1.5,'stroke-opacity':.7})); break; }
    /* ---- V3 event-production pack ---- */
    case 'lighting': { drawBox({fill:'transparent',sw:1.2});      // truss span with par cans hanging under it
      { const nz=Math.max(2,Math.floor(w/8)), s=w/nz; body.appendChild(el('path',{d:Array.from({length:nz},(_,i)=>{ const x=-w/2+i*s; return `M ${x} ${-h/2} L ${x+s/2} ${h/2} L ${x+s} ${-h/2}`; }).join(' '),fill:'none',stroke:c,'stroke-width':1,'stroke-opacity':.7})); }   // V3 fix: Array.from's map gets no 3rd arg
      for(let x=-w/2+6;x<w/2-2;x+=Math.max(8,w/6)) body.appendChild(el('circle',{cx:x,cy:0,r:Math.min(3,h/2+1),fill:c})); break; }
    case 'led': case 'brandwall': { drawBox({fill:it.type==='led'?`color-mix(in srgb, ${c} 45%, var(--canvas))`:white?'#ffffff':fillSoft, rx:1});
      if(it.type==='led') for(let x=-w/2+w/8;x<w/2;x+=w/8) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.6,'stroke-opacity':.6}));
      else if(!white) body.appendChild(el('line',{x1:-w/2+3,y1:0,x2:w/2-3,y2:0,stroke:c,'stroke-width':1,'stroke-dasharray':'4 3'})); break; }
    case 'chocolatefountain': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      [0.34,0.18].forEach(k=>body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)*k,fill:'none',stroke:c,'stroke-width':1}))); break; }
    case 'chariot': { drawBox({fill:fillSoft, rx:Math.min(w,h)*0.4});
      [-1,1].forEach(sxx=>[-1,1].forEach(syy=>body.appendChild(el('circle',{cx:sxx*(w/2-w*0.18),cy:syy*h/2,r:Math.min(h*0.22,8),fill:'none',stroke:c,'stroke-width':1.5})))); break; }
    case 'smoke': { body.appendChild(el('rect',{x:-w/2,y:-h/4,width:w*0.7,height:h/2,rx:2,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M ${w*0.2} 0 q ${w*0.15} ${-h*0.3} ${w*0.3} 0`,fill:'none',stroke:c,'stroke-width':1.2,'stroke-opacity':.7})); break; }
    case 'dancers': { drawBox({fill:'transparent',dash:'5 3',sw:1.2});   // R137: small dancer figures (head, body, arms up / out, skirt)
      const nD=Math.max(3,Math.min(5,Math.round(+((it.properties||{}).count)||5))), r0=Math.min(3.2,h*0.1,w/(nD*3.2));
      for(let i=0;i<nD;i++){ const x=-w/2+w*(i+0.5)/nD, y=(i%2?-1:1)*h*0.1, up=i%2===0;
        body.appendChild(el('circle',{cx:x,cy:y-r0*2.2,r:r0*0.62,fill:c}));
        body.appendChild(el('path',{d:`M ${x} ${y-r0*1.5} L ${x} ${y+r0*0.4} M ${x-r0*1.5} ${y-r0*(up?2.6:1.2)} L ${x} ${y-r0*1.1} L ${x+r0*1.5} ${y-r0*(up?2.6:0.6)}`,
          fill:'none',stroke:c,'stroke-width':Math.max(0.8,r0*0.35),'stroke-linecap':'round','stroke-linejoin':'round'}));
        body.appendChild(el('path',{d:`M ${x-r0*0.45} ${y-r0*0.1} L ${x+r0*0.45} ${y-r0*0.1} L ${x+r0*1.2} ${y+r0*1.5} L ${x-r0*1.2} ${y+r0*1.5} Z`,fill:c,'fill-opacity':.75})); }
      break; }
    case 'generator': { drawBox({fill:fillSoft, rx:1});
      body.appendChild(el('path',{d:`M ${w*0.08} ${-h*0.32} L ${-w*0.06} ${h*0.04} L ${w*0.04} ${h*0.04} L ${-w*0.08} ${h*0.32}`,fill:'none',stroke:c,'stroke-width':1.5})); break; }
    case 'walkway': { drawBox({fill:`color-mix(in srgb, ${c} 24%, var(--canvas))`, rx:1});
      body.appendChild(el('line',{x1:0,y1:-h/2+2,x2:0,y2:h/2-2,stroke:c,'stroke-width':1,'stroke-dasharray':'6 4'})); break; }
    /* ---- Indian wedding + corporate pack (2026-10) ---- */
    case 'entrancegate': { const pw=Math.max(1.6,Math.min(2.6,it.width*0.14))*PX_PER_FT;
      body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:h,rx:2,fill:'none',stroke:c,'stroke-width':1,'stroke-dasharray':'4 3','stroke-opacity':.6}));
      [-1,1].forEach(sx=>body.appendChild(el('rect',{x:sx>0?w/2-pw:-w/2,y:-h/2,width:pw,height:h,rx:2,fill:fillSoft,stroke:c,'stroke-width':1.5})));
      for(let x=-w/2+pw+4;x<w/2-pw-2;x+=6) body.appendChild(el('circle',{cx:x,cy:0,r:1.7,fill:c,'fill-opacity':.75}));
      break; }
    case 'phoolchadar': { drawBox({fill:fillSoft,rx:2});
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sx,sy])=>body.appendChild(el('circle',{cx:sx*(w/2-3),cy:sy*(h/2-3),r:2.4,fill:c})));
      for(let x=-w/2+8;x<w/2-4;x+=8) for(let y=-h/2+8;y<h/2-4;y+=8) body.appendChild(el('circle',{cx:x,cy:y,r:2,fill:c,'fill-opacity':.45}));
      break; }
    case 'jhoola': { drawBox({fill:'transparent',dash:'4 3',sw:1});
      body.appendChild(el('line',{x1:-w/2+4,y1:0,x2:w/2-4,y2:0,stroke:c,'stroke-width':2}));
      body.appendChild(el('rect',{x:-w*0.31,y:-h*0.22,width:w*0.62,height:h*0.44,rx:3,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      [-1,1].forEach(sx=>body.appendChild(el('circle',{cx:sx*(w/2-4),cy:0,r:2.6,fill:c}))); break; }
    case 'haldi': case 'mehendi': { drawBox({fill:`color-mix(in srgb, ${c} 20%, var(--canvas))`,rx:3});
      body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h*0.1,8),fill:c,'fill-opacity':.6}));   // backdrop / rear edge
      if(it.type==='haldi'){ body.appendChild(el('rect',{x:-w*0.2,y:-h/2+h*0.14,width:w*0.4,height:h*0.24,rx:3,fill:c,'fill-opacity':.45}));
        [-1,1].forEach(sx=>body.appendChild(el('circle',{cx:sx*w*0.32,cy:h/2-h*0.16,r:Math.min(w,h)*0.07,fill:'none',stroke:c,'stroke-width':1.2}))); }
      else { const n=Math.max(1,Math.round(it.width/8));
        for(let i=0;i<n;i++){ const x=-w/2+(i+0.5)*w/n; body.appendChild(el('circle',{cx:x,cy:h*0.12,r:Math.min(w/n,h)*0.32,fill:'none',stroke:c,'stroke-width':1,'stroke-dasharray':'3 2'}));
          body.appendChild(el('rect',{x:x-w/n*0.35,y:-h/4-6,width:w/n*0.7,height:8,rx:3,fill:c,'fill-opacity':.5})); } }
      break; }
    case 'selfieframe': case 'welcomeboard': { drawBox({fill:fillSoft,rx:1});
      body.appendChild(el('rect',{x:-w/2+2,y:-h/2+2,width:w-4,height:h-4,fill:'none',stroke:c,'stroke-width':.8,'stroke-opacity':.6}));
      [[-1,-1],[1,1]].forEach(([sx,sy])=>body.appendChild(el('circle',{cx:sx*(w/2-2),cy:sy*(h/2-2),r:2.6,fill:c,'fill-opacity':.8}))); break; }
    case 'fairylights': { drawBox({fill:'transparent',dash:'2 4',sw:1});
      for(let i=0;i<16;i++){ const a=i/16*Math.PI*2, k=Math.min(Math.abs(1/Math.cos(a)),Math.abs(1/Math.sin(a)));
        body.appendChild(el('line',{x1:0,y1:0,x2:Math.cos(a)*k*w/2,y2:Math.sin(a)*k*h/2,stroke:c,'stroke-width':.7,'stroke-opacity':.55,'stroke-dasharray':'1 3'})); }
      body.appendChild(el('circle',{cx:0,cy:0,r:3,fill:c})); break; }
    case 'couplesofa': { drawBox({fill:fillSoft,rx:Math.min(w,h)*0.3});
      body.appendChild(el('path',{d:`M ${-w/2+2} ${-h/2+h*0.4} Q 0 ${-h/2-4} ${w/2-2} ${-h/2+h*0.4}`,fill:'none',stroke:c,'stroke-width':2.2}));
      body.appendChild(el('line',{x1:0,y1:-h/2+h*0.3,x2:0,y2:h/2-2,stroke:c,'stroke-width':.6,'stroke-opacity':.5})); break; }
    case 'livecounter': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2+3,x2:w/2,y2:-h/2+3,stroke:c,'stroke-width':2}));
      body.appendChild(el('circle',{cx:-w*0.2,cy:h*0.1,r:Math.min(w,h)*0.18,fill:'none',stroke:c,'stroke-width':1.2})); break; }
    case 'kidszone': { drawBox({fill:`color-mix(in srgb, ${c} 14%, var(--canvas))`,rx:6,dash:'6 3'});
      body.appendChild(el('rect',{x:-w/2+6,y:-h/2+6,width:w*0.45,height:h*0.45,rx:3,fill:c,'fill-opacity':.3,stroke:c,'stroke-width':1}));
      body.appendChild(el('circle',{cx:-w/4,cy:h/4,r:Math.min(w,h)*0.12,fill:'none',stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M ${w/2-3*PX_PER_FT} ${-h*0.3} L ${w/2-3*PX_PER_FT} ${h*0.3}`,stroke:c,'stroke-width':4,'stroke-opacity':.45,'stroke-linecap':'round'})); break; }
    case 'aircooler': { drawBox({fill:fillSoft,rx:3});
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)*0.32,fill:'none',stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M 0 0 L ${Math.min(w,h)*0.28} ${-Math.min(w,h)*0.1} M 0 0 L ${-Math.min(w,h)*0.05} ${Math.min(w,h)*0.28} M 0 0 L ${-Math.min(w,h)*0.24} ${-Math.min(w,h)*0.16}`,stroke:c,'stroke-width':1.2,'stroke-linecap':'round'})); break; }
    /* ---- event-aware décor + production pack (2026-10b) ---- */
    case 'floralentrance': case 'stagebackdrop': case 'flowerwall': case 'toran': {   // florals along a frame / wall line
      drawBox({fill:it.type==='toran'?'transparent':fillSoft, rx:1, sw:it.type==='toran'?0.8:1.5, dash:it.type==='toran'?'3 2':''});
      const step=it.type==='flowerwall'?5:7, R=Math.max(1.4,Math.min(3,h*0.32));
      for(let x=-w/2+step/2;x<w/2;x+=step) body.appendChild(el('circle',{cx:x,cy:it.type==='toran'?h*0.15:0,r:R,fill:c,'fill-opacity':(Math.round(x)%3)?0.55:0.9}));
      if(it.type==='floralentrance') [-1,1].forEach(sx=>body.appendChild(el('rect',{x:sx>0?w/2-2.4*PX_PER_FT:-w/2,y:-h/2,width:2.4*PX_PER_FT,height:h,rx:2,fill:c,'fill-opacity':.35,stroke:c,'stroke-width':1})));
      break; }
    case 'floralpillar': case 'aislefloral': case 'centrepiece': case 'balloonbunch': case 'diyastand': {
      const R=Math.min(w,h)/2, n=it.type==='balloonbunch'?5:it.type==='diyastand'?5:7;
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      for(let i=0;i<n;i++){ const a=i/n*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.5,cy:Math.sin(a)*R*0.5,r:R*(it.type==='diyastand'?0.14:0.3),fill:c,'fill-opacity':.6})); }
      body.appendChild(el('circle',{cx:0,cy:0,r:R*0.2,fill:c})); break; }
    case 'balloonarch': {
      for(let i=0;i<=14;i++){ const t=i/14, x=-w/2+3+(w-6)*t, y=h/2-(h+8)*Math.sin(t*Math.PI)*0.6;
        body.appendChild(el('circle',{cx:x,cy:y,r:Math.max(2,Math.min(4,h*0.3)),fill:c,'fill-opacity':i%2?0.5:0.85})); }
      break; }
    case 'lectern': { drawBox({fill:`color-mix(in srgb, ${c} 26%, var(--canvas))`, rx:2});
      body.appendChild(el('line',{x1:-w/2+2,y1:h/2-3,x2:w/2-2,y2:h/2-3,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:-h*0.15,r:1.6,fill:c})); break; }
    case 'dais': { drawBox({fill:`color-mix(in srgb, ${c} 16%, var(--canvas))`, rx:1});
      body.appendChild(el('rect',{x:-w*0.4,y:-h*0.05,width:w*0.8,height:h*0.22,rx:1,fill:c,'fill-opacity':.35}));   // table
      { const n=Math.max(1,Math.min(16,(it.properties&&it.properties.chairs)|0||8));
        for(let i=0;i<n;i++) body.appendChild(el('rect',{x:-w*0.4+(i+0.5)*(w*0.8/n)-2.5,y:-h*0.32,width:5,height:5,rx:1,fill:c,'fill-opacity':.85})); }
      break; }
    case 'flagstand': { const R=Math.min(w,h)/2, fs0=screenContent(it);
      body.appendChild(el('circle',{cx:0,cy:0,r:R*0.6,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M 0 0 L ${R} ${-R*0.5} L ${R} ${R*0.2} Z`,fill:white?'#ffffff':c,'fill-opacity':white?1:.7,stroke:c,'stroke-width':white?.8:0}));
      if(fs0 && fs0.pic) screenPic2D(body, fs0, 0, -R*0.6, R, R*0.66);
      break; }
    case 'hoarding': { drawBox({fill:white?'#ffffff':fillSoft, rx:0, sw:2}); break; }
    case 'patower': { drawBox({fill:'transparent',sw:1.2});
      body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/2} ${h/2} M ${w/2} ${-h/2} L ${-w/2} ${h/2}`,stroke:c,'stroke-width':.8,'stroke-opacity':.6}));
      body.appendChild(el('rect',{x:-w*0.3,y:-h*0.3,width:w*0.6,height:h*0.6,rx:1,fill:c,'fill-opacity':.7})); break; }
    case 'lightingtree': { const R=Math.min(w,h)/2;
      [0,120,240].forEach(d=>{ const a=(d-90)*Math.PI/180; body.appendChild(el('line',{x1:0,y1:0,x2:Math.cos(a)*R,y2:Math.sin(a)*R,stroke:c,'stroke-width':1.2})); });
      body.appendChild(el('line',{x1:-R,y1:0,x2:R,y2:0,stroke:c,'stroke-width':2}));
      [-0.75,-0.25,0.25,0.75].forEach(k=>body.appendChild(el('circle',{cx:k*R,cy:0,r:Math.max(1.4,R*0.16),fill:c})));
      break; }
    case 'trophytable': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:1});
      for(let i=0;i<5;i++){ const x=-w/2+(i+0.5)*w/5; body.appendChild(el('path',{d:`M ${x-2} ${-2} h 4 l -1 3 h -2 Z`,fill:c,'fill-opacity':.8})); }
      break; }
    case 'havankund': { const R=Math.min(w,h)/2;
      body.appendChild(el('rect',{x:-R,y:-R,width:2*R,height:2*R,fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('rect',{x:-R*0.55,y:-R*0.55,width:R*1.1,height:R*1.1,fill:'#ff9a3c','fill-opacity':.75}));
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx,sy])=>body.appendChild(el('circle',{cx:sx*R*0.8,cy:sy*R*0.8,r:Math.max(1,R*0.1),fill:c}))); break; }
    case 'rangoli': { const R=Math.min(w,h)/2;
      for(let k=0;k<3;k++) body.appendChild(el('circle',{cx:0,cy:0,r:R*(1-k*0.3),fill:'none',stroke:c,'stroke-width':1.2,'stroke-opacity':1-k*0.2}));
      for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; body.appendChild(el('ellipse',{cx:Math.cos(a)*R*0.55,cy:Math.sin(a)*R*0.55,rx:R*0.22,ry:R*0.1,transform:`rotate(${i*45} ${Math.cos(a)*R*0.55} ${Math.sin(a)*R*0.55})`,fill:c,'fill-opacity':.55})); }
      break; }
    case 'lanterns': { const R=Math.min(w,h)/2;
      [[-0.4,-0.3,0.45],[0.35,-0.25,0.35],[0,0.35,0.5]].forEach(([x,y,r])=>{ body.appendChild(el('rect',{x:x*R*2-r*R,y:y*R*2-r*R,width:2*r*R,height:2*r*R,rx:1,fill:'#ffd98a','fill-opacity':.6,stroke:c,'stroke-width':1})); }); break; }
    case 'hangingfloral': { drawBox({fill:'transparent',sw:1,dash:'4 3'});
      for(let i=0;i<7;i++) for(let j=0;j<7;j++){ if((i+j)%2) continue; body.appendChild(el('circle',{cx:-w/2+(i+0.5)*w/7,cy:-h/2+(j+0.5)*h/7,r:Math.max(1.5,Math.min(w,h)/20),fill:c,'fill-opacity':.6})); }
      break; }
    case 'neonsign': { drawBox({fill:`color-mix(in srgb, ${c} 14%, var(--canvas))`, rx:1});
      body.appendChild(el('path',{d:`M ${-w*0.35} 0 q ${w*0.12} ${-h*0.6} ${w*0.24} 0 t ${w*0.24} 0 t ${w*0.22} 0`,fill:'none',stroke:'#ff4fd8','stroke-width':2})); break; }
    /* ---- complete-catalogue pack (2026-10d) ---- */
    case 'backdrop': case 'projector': case 'teleprompter': { drawBox({fill:white?'#ffffff':`color-mix(in srgb, ${c} 20%, var(--canvas))`, rx:1});
      if(it.type!=='backdrop') body.appendChild(el('rect',{x:-w*0.42,y:-h*0.25,width:w*0.84,height:h*0.5,fill:'#9fb6ff','fill-opacity':.6}));
      else if(!white) for(let i=1;i<4;i++) body.appendChild(el('line',{x1:-w/2+i*w/4,y1:-h/2,x2:-w/2+i*w/4,y2:h/2,stroke:c,'stroke-width':.6,'stroke-opacity':.5}));
      break; }
    case 'floralstand': case 'urli': case 'kalash': case 'plinth': case 'micstand': case 'pyro': case 'extinguisher': { const R=Math.min(w,h)/2;
      const ring=it.type==='urli'||it.type==='kalash';
      body.appendChild(el(it.type==='plinth'||it.type==='extinguisher'?'rect':'circle', it.type==='plinth'||it.type==='extinguisher'
        ? {x:-w/2,y:-h/2,width:w,height:h,rx:1,fill:it.type==='extinguisher'?'#dc2626':fillSoft,'fill-opacity':it.type==='extinguisher'?.7:1,stroke:c,'stroke-width':1.2}
        : {cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      if(ring) body.appendChild(el('circle',{cx:0,cy:0,r:R*0.55,fill:c,'fill-opacity':.45}));
      else if(it.type==='floralstand') for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.5,cy:Math.sin(a)*R*0.5,r:R*0.28,fill:c,'fill-opacity':.55})); }
      else if(it.type==='pyro') for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; body.appendChild(el('line',{x1:0,y1:0,x2:Math.cos(a)*R,y2:Math.sin(a)*R,stroke:'#f59e0b','stroke-width':1})); }
      else if(it.type==='micstand') body.appendChild(el('circle',{cx:0,cy:0,r:R*0.3,fill:c}));
      break; }
    case 'decorbox': case 'signage': case 'counter': case 'kiosk': case 'shoerack': case 'tvstand': { drawBox({fill:white?'#ffffff':fillSoft, rx:it.type==='decorbox'?3:1});
      if(it.type==='decorbox') body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/2} ${h/2} M ${w/2} ${-h/2} L ${-w/2} ${h/2}`,stroke:c,'stroke-width':.7,'stroke-opacity':.5}));
      else if(it.type==='shoerack') for(let i=1;i<6;i++) body.appendChild(el('line',{x1:-w/2+i*w/6,y1:-h/2,x2:-w/2+i*w/6,y2:h/2,stroke:c,'stroke-width':.6}));
      else if(!white) body.appendChild(el('rect',{x:-w*0.35,y:-h*0.3,width:w*0.7,height:h*0.25,fill:c,'fill-opacity':.5}));
      break; }
    case 'recttable': {
      drawBox({fill:fillSoft, rx:1});
      const n=Math.max(0,Math.min(12,it.properties.seats|0));
      for(let i=0;i<n;i++) body.appendChild(el('circle',{cx:-w/2+(i+0.5)/n*w,cy:h/2+3.2,r:clamp(Math.min(w/Math.max(1,n),6)*0.5,1.5,3.4),fill:c,'fill-opacity':.85}));
      break; }
    case 'stageroof': case 'interpreter': case 'ticketbooth': case 'watchtower': case 'towerlight': case 'stall': {
      drawBox({fill:it.type==='stageroof'?'transparent':fillSoft, rx:1, dash:it.type==='stageroof'?'6 4':''});
      const k=Math.min(w,h)*0.12;
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx,sy])=>body.appendChild(el('rect',{x:sx*(w/2-k)-k/2,y:sy*(h/2-k)-k/2,width:k,height:k,fill:c,'fill-opacity':.8})));
      if(it.type==='stageroof'||it.type==='watchtower') body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/2} ${h/2} M ${w/2} ${-h/2} L ${-w/2} ${h/2}`,stroke:c,'stroke-width':.7,'stroke-opacity':.45}));
      break; }
    case 'varmala': case 'umbrellas': case 'gaddi': { const R=Math.min(w,h)/2;
      if(it.type==='gaddi'){ drawBox({fill:fillSoft, rx:2});
        [[-1,0],[1,0],[0,-1],[0,1]].forEach(([sx,sy])=>body.appendChild(el('rect',{x:sx? sx*(w/2-w*0.08)-w*0.05 : -w*0.4, y:sy? sy*(h/2-h*0.08)-h*0.05 : -h*0.4, width:sx? w*0.1 : w*0.8, height:sy? h*0.1 : h*0.8, rx:2, fill:c,'fill-opacity':.45}))); break; }
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.3}));
      if(it.type==='umbrellas') for(let i=0;i<5;i++){ const a=i/5*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.55,cy:Math.sin(a)*R*0.55,r:R*0.3,fill:c,'fill-opacity':.35,stroke:c,'stroke-width':.8})); }
      else body.appendChild(el('circle',{cx:0,cy:0,r:R*0.75,fill:'none',stroke:c,'stroke-width':1,'stroke-dasharray':'3 2'}));
      break; }
    case 'doli': case 'altar': case 'dessert': case 'coffee': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:1});
      if(it.type==='doli') body.appendChild(el('line',{x1:-w/2-4,y1:0,x2:w/2+4,y2:0,stroke:c,'stroke-width':1.6}));
      else for(let i=0;i<3;i++) body.appendChild(el('circle',{cx:-w/3+i*w/3,cy:0,r:Math.max(1.5,Math.min(w/8,h*0.3)),fill:c,'fill-opacity':.5}));
      break; }
    case 'stanchion': { drawBox({fill:'transparent', sw:0.01});
      const n=Math.max(2,Math.round(w/(5*PX_PER_FT))+1);
      body.appendChild(el('line',{x1:-w/2,y1:0,x2:w/2,y2:0,stroke:'#b91c1c','stroke-width':1.6}));
      for(let i=0;i<n;i++) body.appendChild(el('circle',{cx:-w/2+i*w/(n-1),cy:0,r:Math.max(1.6,h*0.3),fill:c}));
      break; }
    case 'ambulance': { drawBox({fill:'transparent', dash:'6 4'});
      body.appendChild(el('rect',{x:-w*0.38,y:-h*0.3,width:w*0.76,height:h*0.6,rx:2,fill:'#ffffff','fill-opacity':.85,stroke:c,'stroke-width':1}));
      body.appendChild(el('path',{d:`M ${-h*0.12} 0 h ${h*0.24} M 0 ${-h*0.12} v ${h*0.24}`,stroke:'#dc2626','stroke-width':2}));
      break; }
    // R135 visual-asset-catalogue pack
    case 'lawnfloor': { drawBox({fill:'color-mix(in srgb, #4d8b3a 30%, var(--canvas))', rx:1, dash:'6 3'});
      for(let x=-w/2+6;x<w/2-3;x+=12) for(let y=-h/2+6;y<h/2-3;y+=12) body.appendChild(el('path',{d:`M ${x-2} ${y+2} l 2 -4 l 2 4`,stroke:'#3f7f45','stroke-width':.8,fill:'none','stroke-opacity':.7}));
      break; }
    case 'stagelight': { const R=Math.min(w,h)/2, st=(it.properties||{}).style||'';
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('circle',{cx:0,cy:0,r:R*(st==='beam'?0.25:st==='flood'?0.7:0.45),fill:c,'fill-opacity':.7}));
      if(st==='flood') body.appendChild(el('rect',{x:-R*0.8,y:-R*0.5,width:R*1.6,height:R,fill:'none',stroke:c,'stroke-width':.8}));
      break; }
    case 'pathlights': { const st=(it.properties||{}).style||'';
      if(st==='rope'){ body.appendChild(el('line',{x1:-w/2,y1:0,x2:w/2,y2:0,stroke:c,'stroke-width':Math.max(1.5,h*0.35),'stroke-linecap':'round','stroke-opacity':.85})); }
      else { drawBox({fill:'transparent', dash:'2 3', sw:.6});
        const n=Math.max(2,Math.round(it.width/4)); for(let i=0;i<n;i++) body.appendChild(el('circle',{cx:-w/2+(i+0.5)*w/n,cy:0,r:Math.max(1.6,Math.min(h*0.35,3)),fill:c,'fill-opacity':.85})); }
      break; }
    case 'sidescreen': { drawBox({fill:c,rx:1}); break; }
    case 'stagedeck': { drawBox({fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`, rx:2});
      body.appendChild(el('line',{x1:-w/2+3,y1:h/2-2.5,x2:w/2-3,y2:h/2-2.5,stroke:c,'stroke-width':1,'stroke-dasharray':'2 2'})); break; }
    case 'stagestairs': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:1});
      const n=stairStepCount(it); for(let i=1;i<n;i++) body.appendChild(el('line',{x1:-w/2,y1:-h/2+i*h/n,x2:w/2,y2:-h/2+i*h/n,stroke:c,'stroke-width':1}));
      body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h/n,3),fill:c,'fill-opacity':.45}));   // top tread (stage side)
      break; }
    case 'installation': { const R=Math.min(w,h)/2, st=(it.properties||{}).style||'';
      if(st==='letters'){ drawBox({fill:fillSoft, rx:1}); const n=4; for(let i=0;i<n;i++) body.appendChild(el('rect',{x:-w/2+w*(i+0.15)/n,y:-h*0.2,width:w*0.7/n,height:h*0.4,rx:1,fill:c,'fill-opacity':.6})); }
      else if(st==='lighttunnel'){ drawBox({fill:'transparent', dash:'3 3'}); for(let y=-h/2+4;y<h/2;y+=8) body.appendChild(el('line',{x1:-w/2,y1:y,x2:w/2,y2:y,stroke:c,'stroke-width':1.2,'stroke-opacity':.8})); }
      else { body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.2,'stroke-dasharray':'3 2'}));
        for(let k=0;k<8;k++){ const a=k/8*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.6,cy:Math.sin(a)*R*0.6,r:Math.max(1.2,R*0.08),fill:c})); } }
      break; }
    case 'jyothi': { const R=Math.min(w,h)/2, candle=((it.properties||{}).style||'')==='candle';   // R154: round base, tray ring of lamps, flame at the top
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('circle',{cx:0,cy:0,r:R*0.62,fill:'none',stroke:c,'stroke-width':.8,'stroke-dasharray':candle?'1.5 1.5':''}));
      for(let k=0;k<6;k++){ const a=k/6*Math.PI*2-Math.PI/2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.62,cy:Math.sin(a)*R*0.62,r:Math.max(0.9,R*0.13),fill:'#ffb547',stroke:c,'stroke-width':.4})); }
      body.appendChild(el('path',{d:`M 0 ${-R*0.38} C ${R*0.2} ${-R*0.12} ${R*0.18} ${R*0.12} 0 ${R*0.2} C ${-R*0.18} ${R*0.12} ${-R*0.2} ${-R*0.12} 0 ${-R*0.38} Z`,fill:'#ff9a3c',stroke:c,'stroke-width':.4}));
      break; }
    default: drawBox({});
  }
  // R135: standalone screens show their theme + text (or a builder-only placeholder) on the screen face
  let scrText=false;
  if(it.type!=='stage' && window.HelmScreen && HelmScreen.isScreenType(it.type)){
    const sc=screenContent(it);
    if(HelmScreen.hasContent(sc)){ screenFace2D(body, it, sc, w, h, c); scrText=!sc.pic && HelmScreen.hasText(sc); }
    else if(!white){ screenPlaceholder2D(body, -w/2, -h/2, w, h*0.5); scrText=screenPlaceholderOn(); }
  } else if(it.type!=='stage' && it.type!=='flagstand' && window.HelmScreen && HelmScreen.isPosterType && HelmScreen.isPosterType(it.type)){   // R255: posters show their picture
    const pc=screenContent(it); if(pc && pc.pic) screenFace2D(body, it, pc, w, h, c);
  }
  g.appendChild(body);

  // label (counter-rotated so it stays upright)
  const fs = clamp(Math.min(w,h)*0.16, 7, 11);
  const t = el('text',{class:'lbl', x:0, y: (it.type==='table'||it.type==='cocktail')?3:(scrText && !(it.rotation%360) ? h*0.25+fs*0.35 : fs*0.35),
    'text-anchor':'middle','font-size':fs, transform:`rotate(${-it.rotation})`});
  t.textContent = it.label;
  g.appendChild(t);

  return g;
}
function clampItem(it){
  const a = ASSETS[it.type] || {};
  const num=(v,d)=>{ v=+v; return isFinite(v)?v:d; };   // coerce; fall back so a missing field can't produce NaN
  it.width  = clamp(num(it.width,  a.w||6), 0.5, WORLD.w);
  it.height = clamp(num(it.height, a.h||6), 0.5, WORLD.h);
  it.x = clamp(num(it.x,0), 0, WORLD.w-it.width);
  it.y = clamp(num(it.y,0), 0, WORLD.h-it.height);
  it.rotation = num(it.rotation,0);
  return it;
}
function sanitizeItem(it){
  if(!it.properties || typeof it.properties!=='object') it.properties={};
  ['rows','cols','seats','pitch'].forEach(k=>{ if(it.properties[k]!=null){ const v=+it.properties[k]; it.properties[k]=isFinite(v)?clamp(v,0,1000):0; } });
  // a block is rows x cols seats: cap the product so one hostile/typo'd item can't mean 1,000,000 chairs
  { const r=it.properties.rows, c=it.properties.cols;
    if(r>0 && c>0 && r*c>MAX_BLOCK_SEATS) it.properties.cols = Math.max(1, Math.floor(MAX_BLOCK_SEATS/r)); }
  if(it.properties.model!=null && typeof it.properties.model!=='string') delete it.properties.model;
  // R135: screen text (length-capped plain text, whitelisted theme) + stage steps / stairs options
  if(typeof window!=='undefined' && window.HelmScreen) window.HelmScreen.sanitize(it.properties);
  { const P=it.properties;
    if(P.builtinSteps!=null && !STAGE_STEPS.some(([v])=>v && v===P.builtinSteps)) delete P.builtinSteps;
    if(P.stairPos!=null && ['left','centre','right'].indexOf(P.stairPos)<0) delete P.stairPos;
    if(P.stairSteps!=null){ const n=Math.round(+P.stairSteps); if(isFinite(n)) P.stairSteps=clamp(n,2,6); else delete P.stairSteps; }
    if(P.danceStyle!=null && ['classical','western'].indexOf(P.danceStyle)<0) delete P.danceStyle; }   // R137
  if(typeof it.type!=='string' || it.type in Object.prototype) it.type='unknown';
  if(!it.category || !Object.prototype.hasOwnProperty.call(CATS, it.category)) it.category='structure';
  if(typeof it.label!=='string') it.label = it.label==null ? '' : String(it.label);
  if(typeof it.color!=='string') it.color = catColor(it.category);
  it.id = it.id ? String(it.id) : nid();
  return it;
}
function dedupeIds(items){
  const seen=new Set();
  items.forEach(it=>{ while(seen.has(it.id)) it.id=nid(); seen.add(it.id); });
  return items;
}
function sanitizeMargins(m){
  m = m || {}; const w=WORLD.w, h=WORLD.h;
  const n=(v)=> (isFinite(+v)&&+v>=0) ? +v : 0;
  let left=n(m.left), right=n(m.right), top=n(m.top), bottom=n(m.bottom);
  if(left+right  > w-1){ left=Math.min(left,w-1); right=Math.min(right, Math.max(0,w-1-left)); }
  if(top+bottom > h-1){ top=Math.min(top,h-1);  bottom=Math.min(bottom, Math.max(0,h-1-top)); }
  return { left:round1(left), right:round1(right), top:round1(top), bottom:round1(bottom) };
}
function drawGrid(){
  // --- grid ---
  const W=WORLD.w*PX_PER_FT, H=WORLD.h*PX_PER_FT;
  svg.appendChild(el('rect',{x:0,y:0,width:W,height:H,fill:'var(--canvas)'}));
  if(store.grid.show){
    const g = el('g');
    const step = cellFt();
    const minor = step*PX_PER_FT;
    // draw minor every cell, major every 10 units
    for(let f=0, n=0; f<=WORLD.w+0.001; f+=step, n++){
      const x=f*PX_PER_FT;
      g.appendChild(el('line',{x1:x,y1:0,x2:x,y2:H,
        stroke: n%10===0?'var(--grid-strong)':'var(--grid)', 'stroke-width': n%10===0?1:0.5}));
    }
    for(let f=0, n=0; f<=WORLD.h+0.001; f+=step, n++){
      const y=f*PX_PER_FT;
      g.appendChild(el('line',{x1:0,y1:y,x2:W,y2:y,
        stroke: n%10===0?'var(--grid-strong)':'var(--grid)', 'stroke-width': n%10===0?1:0.5}));
    }
    svg.appendChild(g);
  }
  // floor border
  svg.appendChild(el('rect',{x:0.5,y:0.5,width:W-1,height:H-1,fill:'none',
    stroke:'var(--grid-strong)','stroke-width':1.5}));

}
/* ======== end of builder.js ======== */
// the same steps as the planner's applyLayout(): hall size first, then clean every item, then the margins
function prepare(floor) {
  const f = floor || {}, v = f.venue || {}, hall = f.hall || {};
  const rf = (f.scale && f.scale.worldFt) || v.room || f.world || { w: hall.len, h: hall.wid };
  WORLD.w = DEFAULT_WORLD.w; WORLD.h = DEFAULT_WORLD.h;
  if (rf && +rf.w && +rf.h && isFinite(rf.w) && isFinite(rf.h)) { WORLD.w = clamp(Math.round(+rf.w), 20, 1000); WORLD.h = clamp(Math.round(+rf.h), 20, 1000); }
  const items = JSON.parse(JSON.stringify((Array.isArray(f.items) ? f.items : []).slice(0, MAX_ITEMS))).filter((it) => it && typeof it === 'object' && !Array.isArray(it));
  items.forEach((it) => {
    const full = Object.prototype.hasOwnProperty.call(it, 'colorCustom');
    sanitizeItem(it);
    const c = it.color.trim().toLowerCase();
    // a saved version says if the colour was chosen by hand; event_floor_get (0397) does not, so a category colour means "not chosen"
    if (!HEXRE.test(it.color.trim()) || (full ? !it.colorCustom : C_KNOWN.indexOf(c) >= 0)) it.color = catColor(it.category);
    clampItem(it);
  });
  dedupeIds(items);
  return { items, world: { w: WORLD.w, h: WORLD.h }, margins: sanitizeMargins(f.margins), unit: ((f.grid && f.grid.unit) || f.unit) === 'm' ? 'm' : 'ft' };
}
function svgOf(plan, o) {
  o = o || {};
  WORLD.w = plan.world.w; WORLD.h = plan.world.h;
  store = { items: plan.items, grid: { show: o.grid !== false, unit: plan.unit, snap: true }, margins: plan.margins, view: { zoom: o.zoom || 1 } };
  const W = WORLD.w * PX_PER_FT, H = WORLD.h * PX_PER_FT;
  svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'fv-plan', preserveAspectRatio: 'xMidYMid meet' });
  drawGrid();
  drawOrder2D(store.items).forEach(it=> svg.appendChild(renderItem(it)));
  const out = svg; svg = null;
  // self-contained colours + label type, so no page rule (svg text, a theme) can change the plan
  Object.keys(PALETTE).forEach((k) => out.style.setProperty(k, PALETTE[k])); out.style.setProperty('--c-logistics', C_LIGHT.logistics);
  out.querySelectorAll('text').forEach((t) => { const st = t.style; st.fontSize = (+t.getAttribute('font-size') || 7) + 'px'; st.letterSpacing = 'normal'; st.pointerEvents = 'none'; st.fontFamily = SCREEN_FONT;
    if (t.getAttribute('class') === 'lbl') { st.fontFamily = FONT; st.fontWeight = '600'; st.fill = 'var(--ink)'; st.paintOrder = 'stroke'; st.stroke = 'var(--canvas)'; st.strokeWidth = '3px'; st.strokeLinejoin = 'round'; } });
  // a picture, not a list of buttons: the planner's keyboard stops are for editing
  out.querySelectorAll('.obj').forEach((n) => { n.removeAttribute('tabindex'); n.removeAttribute('role'); n.removeAttribute('aria-pressed'); n.setAttribute('aria-hidden', 'true'); n.removeAttribute('aria-label'); });
  return out;
}
global.HelmFloorDraw = Object.freeze({ prepare, svg: svgOf, PX: PX_PER_FT, PALETTE, CAT: C_LIGHT, FT_PER_M, labelOf: (t) => (Object.prototype.hasOwnProperty.call(ASSETS, t) && ASSETS[t].label) || '' });
})(typeof window !== 'undefined' ? window : globalThis);

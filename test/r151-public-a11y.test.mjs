// R151: public pages accessibility fixes from the 2026-11-11 live axe-core + Lighthouse audit.
//  1. landing label-in-name (WCAG 2.5.3): flip cards are named by their own visible words (no aria-label),
//     reel frames' aria-label starts with the words shown on the frame
//  2. landing contrast: mock-up labels + Excel error cells >= 4.5:1 (computed here from the CSS)
//  3. footer column titles are <h2> (were <h4> right after an <h2>: heading-order), same look
//  4. /login + /signup brand pane is an <aside aria-label="About Helm"> landmark
//  5. /about headings wrap at 200% text (overflow-wrap:anywhere)
//  6. 24px tap targets: text links/buttons on the auth cards + consent checkboxes
//  7. OG image renamed to a versioned file (the generic .png rule caches it immutable for a year)
//  8. csp-report drops ONLY Google Sign-In inline-style reports (Firefox noise), nothing else
//  +  modules row keeps its HTML tab stop on wide screens; legal tables that scroll sideways get a tab stop
import { readFileSync, existsSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const r = (p) => readFileSync(p, "utf8");
let n = 0;
const t = async (name, fn) => { await fn(); n++; };

/* --- WCAG relative luminance / contrast --- */
const hex = (h) => { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lum = (c) => { const a = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg, alpha, bg) => fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));

const HOME_JS = r("public/home.js");
const HOME_CSS = r("public/home.css");

await t("1a flip cards: no aria-label, inner faces exposed, decorative bits aria-hidden", () => {
  const m = /var flipsBox = \$\('#flips'\)[\s\S]*?flipsBox\.appendChild\(c\); cards\.push\(c\);/.exec(HOME_JS);
  assert.ok(m, "flip builder found");
  const b = m[0];
  assert.doesNotMatch(b, /c\.setAttribute\('aria-label'/, "card is named from its visible content");
  assert.match(b, /var inner = el\('div', 'flip-in'\);\n/, "faces are not hidden from assistive tech");
  assert.doesNotMatch(b, /inner\.setAttribute\('aria-hidden'/);
  assert.match(b, /tag\.setAttribute\('aria-hidden', 'true'\)/, "area + number tag is decoration");
  assert.match(b, /hint\.setAttribute\('aria-hidden', 'true'\)/, "'See the Helm way' hint is decoration");
  assert.match(b, /tagN\.setAttribute\('aria-hidden', 'true'\)/, "back face repeats the tool name - hidden");
  assert.match(b, /ok\.setAttribute\('aria-hidden', 'true'\)/, "'Built into Helm' badge is decoration");
  assert.match(b, /c\.setAttribute\('role', 'button'\); c\.setAttribute\('aria-pressed', 'false'\)/, "still a toggle button");
});

await t("1b reel frames: aria-label starts with the visible tag + caption, and they are separated in the DOM", () => {
  const m = /btn\.setAttribute\('aria-label', (.+?)\);\n/.exec(HOME_JS.slice(HOME_JS.indexOf("function frame(it, i)")));
  assert.ok(m, "frame label expression");
  const label = (it) => new Function("it", "return " + m[1])(it);
  assert.equal(label({ type: "Wedding", caption: "Sunset mandap on the lawn", alt: "x" }), "Wedding: Sunset mandap on the lawn, open image");
  assert.equal(label({ type: "", caption: "Ring ceremony stage", alt: "x" }), "Ring ceremony stage, open image");
  assert.equal(label({ type: "Mehendi", caption: "", alt: "Marigold garden" }), "Mehendi: Marigold garden, open image");
  assert.match(HOME_JS, /if \(it\.type && it\.caption\) btn\.appendChild\(document\.createTextNode\(' '\)\);/, "space between tag and caption");
});

await t("2 landing mock-up text >= 4.5:1 (settled state)", () => {
  const notes = /\.note small,\.wa small,\.xl small\{[^}]*color:rgba\(0,0,0,([.\d]+)\)\}/.exec(HOME_CSS);
  assert.ok(notes, "note label colour");
  const alpha = Number(notes[1]);
  const bgs = ["#fde68a", "#fff", "#d9f1ff", "#fecaca", "#d1fae5", "#e7f7ec"];   // .note y/w/b/p/g, .wa
  for (const bg of bgs) assert.ok(ratio(over([0, 0, 0], alpha, hex(bg)), hex(bg)) >= 4.5, `label on ${bg}`);
  assert.match(HOME_CSS, /\.lcard\.dim\{opacity:\.7\}\.lcard\.dim span\{color:#343b33\}/);
  const pcol = hex(/\.pcol\{background:(#[0-9a-f]{6})/.exec(HOME_CSS)[1]);
  const fg = over(hex("#343b33"), 0.7, pcol), bg = over(hex("#ffffff"), 0.7, pcol);
  assert.ok(ratio(fg, bg) >= 4.5, "dimmed lead card text " + ratio(fg, bg).toFixed(2));
  const red = /\.xgrid i\.e\{color:(#[0-9a-f]{6})/.exec(HOME_CSS)[1];
  const flash = /@keyframes errb\{[\s\S]*?46%,92%\{background:(#[0-9a-f]{6})\}/.exec(HOME_CSS)[1];
  assert.ok(ratio(hex(red), hex(flash)) >= 4.5 && ratio(hex(red), hex("#fff")) >= 4.5, "Excel error cell " + ratio(hex(red), hex(flash)).toFixed(2));
});

await t("3 footer column titles are <h2>, styled exactly like the old <h4>", () => {
  const pages = readdirSync("public").filter((f) => f.endsWith(".html") && /<footer class="foot">[\s\S]*?>Product</.test(r("public/" + f)));
  assert.equal(pages.length, 16, "landing + 15 legal pages");
  for (const f of pages) {
    const foot = /<footer class="foot">[\s\S]*?<\/footer>/.exec(r("public/" + f))[0];
    assert.doesNotMatch(foot, /<h4/, f + ": no h4 after the page's h2s");
    assert.match(foot, /<h2>Product<\/h2>[\s\S]*<h2>Legal<\/h2>/, f);
  }
  const rule = "{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin:6px 0 14px}";
  for (const css of ["public/home.css", "public/legal.css"]) {
    assert.ok(r(css).includes(".foot h2" + rule), css);
    assert.doesNotMatch(r(css), /\.foot h4/, css);
  }
});

await t("4 /login + /signup brand pane is a named landmark", () => {
  const L = r("public/login.html");
  assert.match(L, /\n  <aside class="brandpane" aria-label="About Helm">\n[\s\S]*?\n  <\/aside>\n\n  <main class="formpane" id="main">/);
  assert.doesNotMatch(L, /<section class="brandpane"/);
});

await t("5 /about headings wrap at 200% text", () => {
  const F = r("public/marketing-features.css");
  assert.match(F, /\.mf-hero h1\{[^}]*overflow-wrap:anywhere\}/);
  assert.match(F, /\.mf-ctabox h2\{[^}]*overflow-wrap:anywhere\}/);
});

await t("6 tap targets >= 24px without moving anything", () => {
  const V = r("public/public-v2.css");
  assert.match(V, /\.card \.linkbtn, \.card \.foot a \{ padding-block:5px; margin-block:-5px; \}/, "hit area grows, layout box does not");
  assert.match(V, /\.agree input\[type="checkbox"\] \{ width:24px; height:24px; min-width:24px; margin-top:-1px; margin-bottom:-2px; \}/);
  assert.match(V, /\.rfs-consent input\[type="checkbox"\] \{ width:24px; height:24px; min-width:24px; margin-top:-2px; margin-bottom:-3px; \}/);
  assert.match(r("public/contact-sales.css"), /\.cs-consent input\{width:24px;height:24px;min-height:0;margin:1px 0 -2px;/);
  assert.match(HOME_JS, /consent\.style\.width = '24px'; consent\.style\.height = '24px'; consent\.style\.marginTop = '0'; consent\.style\.marginBottom = '0'; consent\.style\.flex = '0 0 auto';/);
  for (const p of ["public/login.html", "public/reset-password.html"]) assert.match(r(p), /\/public-v2\.css\?v=9"/, p + " loads the new public-v2.css");
});

await t("7 OG image is versioned, every reference updated, bytes kept", () => {
  assert.ok(existsSync("public/og/helm-og-v2.png") && !existsSync("public/og/helm-og.png"));
  const png = readFileSync("public/og/helm-og-v2.png");
  assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 630);
  const files = [...readdirSync("public").filter((f) => f.endsWith(".html")).map((f) => "public/" + f), "scripts/gen-try.mjs"];
  let refs = 0;
  for (const f of files) {
    const s = r(f);
    assert.doesNotMatch(s, /\/og\/helm-og\.png/, f + ": stale unversioned OG url");
    if (/og\/helm-og-v2\.png/.test(s)) { refs++; if (f.endsWith(".html")) { assert.match(s, /property="og:image" content="https:\/\/www\.helm\.events\/og\/helm-og-v2\.png"/, f); assert.match(s, /name="twitter:image" content="https:\/\/www\.helm\.events\/og\/helm-og-v2\.png"/, f); } }
  }
  assert.ok(refs >= 20, "landing, legal and marketing pages + the try-page generator");
});

await t("8 csp-report: drops only Google Sign-In inline-style reports", async () => {
  const L = await import("../supabase/functions/csp-report/logic.mjs");
  const gsiLegacy = { "csp-report": { "document-uri": "https://www.helm.events/login", "violated-directive": "style-src-elem", "effective-directive": "style-src-elem", "blocked-uri": "inline", "source-file": "https://accounts.google.com/gsi/client", "line-number": 435, "disposition": "enforce" } };
  assert.deepEqual(L.summarize(JSON.stringify(gsiLegacy)), [], "Firefox GSI style-src-elem report dropped");
  assert.deepEqual(L.summarize({ "csp-report": { ...gsiLegacy["csp-report"], "violated-directive": "style-src-attr", "effective-directive": "style-src-attr" } }), [], "style-src-attr too");
  assert.deepEqual(L.summarize({ "csp-report": { "violated-directive": "style-src-elem", "blocked-uri": "https://accounts.google.com/gsi/style", "document-uri": "https://www.helm.events/signup" } }), [], "GSI as blocked-uri");
  // everything else is still logged
  const keep = (b) => L.summarize({ "csp-report": b }).length === 1;
  assert.ok(keep({ ...gsiLegacy["csp-report"], "violated-directive": "script-src-elem", "effective-directive": "script-src-elem" }), "a GSI SCRIPT violation is kept");
  assert.ok(keep({ ...gsiLegacy["csp-report"], "source-file": "https://www.helm.events/login" }), "our own inline style is kept");
  assert.ok(keep({ ...gsiLegacy["csp-report"], "source-file": "https://accounts.google.com.evil.example/gsi/client" }), "look-alike host is kept");
  assert.ok(keep({ ...gsiLegacy["csp-report"], "source-file": "https://accounts.google.com/o/oauth2/x" }), "other Google paths are kept");
  assert.ok(keep({ ...gsiLegacy["csp-report"], "effective-directive": "style-src", "violated-directive": "style-src" }), "plain style-src is kept");
  const arr = [
    { type: "csp-violation", body: { effectiveDirective: "style-src-elem", blockedURL: "inline", sourceFile: "https://accounts.google.com/gsi/client", documentURL: "https://www.helm.events/login" } },
    { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://evil.example/x.png", documentURL: "https://www.helm.events/login" } },
  ];
  const s = L.summarize(JSON.stringify(arr));
  assert.equal(s.length, 1); assert.equal(s[0].directive, "img-src");
  assert.match(r("supabase/functions/csp-report/index.ts"), /for \(const s of summarize\(raw\)\) console\.log\(logLine\(s\)\);/, "index.ts untouched: dropped reports never reach the log");
});

await t("+ keyboard can scroll sideways rows: modules row keeps its HTML tab stop, wide legal tables get one", () => {
  assert.match(r("public/index.html"), /<div class="mods snap" id="modRow" role="region" tabindex="0" aria-label="Helm modules">/);
  assert.match(HOME_JS, /if \(el\.dataset\.snapTab == null\) el\.dataset\.snapTab = el\.hasAttribute\('tabindex'\) \? '1' : '';/);
  assert.match(HOME_JS, /if \(!el\.dataset\.snapTab\) el\.removeAttribute\('tabindex'\);/);
  const LJ = r("public/legal.js");
  assert.match(LJ, /if \(w\.scrollWidth > w\.clientWidth \+ 1\) \{\n\s+w\.setAttribute\('tabindex', '0'\); w\.setAttribute\('role', 'region'\);/);
  assert.match(LJ, /w\.setAttribute\('aria-label', 'Table: ' \+/, "region name differs from the section's own name (landmark-unique)");
});

console.log(`r151-public-a11y: ${n} checks ok`);

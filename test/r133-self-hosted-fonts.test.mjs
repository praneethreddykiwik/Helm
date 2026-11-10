// R133: every web font is served from our own domain - no page, stylesheet or CSP
// may reach fonts.googleapis.com / fonts.gstatic.com (visitor IPs never go to Google).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const G = /fonts\.(googleapis|gstatic)\.com/;
const files = walk("public").filter((f) => /\.(html|css|js|mjs)$/.test(f));
for (const f of files) assert.ok(!G.test(readFileSync(f, "utf8")), f + " must not load Google Fonts");
for (const f of ["vercel.json", "public/_headers", "server.js"]) assert.ok(!G.test(readFileSync(f, "utf8")), f + " CSP must not allow Google Fonts");
let links = 0;
for (const f of files.filter((x) => x.endsWith(".html") || x.endsWith(".css"))) {
  for (const m of readFileSync(f, "utf8").matchAll(/\/fonts\/g\/([a-z0-9-]+\.css)/g)) {
    links++;
    const css = readFileSync("public/fonts/g/" + m[1], "utf8");
    assert.ok(!/https?:\/\//.test(css.replace(/^\/\*.*?\*\//, "")), m[1] + " has no external url");
    for (const u of css.matchAll(/url\(\/fonts\/g\/([^)]+)\)/g)) {
      const p = "public/fonts/g/" + u[1];
      assert.ok(existsSync(p), m[1] + " -> missing " + u[1]);
      assert.equal(readFileSync(p).subarray(0, 4).toString("latin1"), "wOF2", u[1] + " is woff2");
    }
  }
}
assert.ok(links >= 81, "pages link the self-hosted stylesheets (" + links + ")");
assert.ok(existsSync("public/fonts/g/LICENSES.txt"), "font licences shipped");
console.log("r133-self-hosted-fonts: ok (" + links + " stylesheet links)");

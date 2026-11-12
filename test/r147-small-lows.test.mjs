// R147: small reliability + housekeeping fixes
//  1. HQ billing CSV starts with a UTF-8 BOM (Hindi studio names open right in Excel)
//  2. the public enquiry / delivery / vendor-request pages load telemetry.js (global error handler + Sentry), before config.js
//  3. scripts/loadtest.mjs refuses production (always) and unknown hosts (unless --i-know-this-is-not-prod); never follows redirects
//  4. builder / event time / flow legacy pricing saves pass the R79 lost-update lock
//  5. docs/project/API.md lists every edge function in supabase/config.toml
//  6. sbom.json is current (scripts/gen-sbom.mjs --check)
//  7. the iCloud duplicate test-harness shims are gone
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const r = (p) => readFileSync(new URL(p, root), "utf8");
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };

await t("1 HQ billing CSV: BOM first, then the CSV", async () => {
  const hq = r("public/hq.js");
  assert.match(hq, /new Blob\(\["\\uFEFF" \+ csv\], \{ type: "text\/csv;charset=utf-8" \}\)/);
  // run writeCsv for real: the Blob gets the BOM + a Hindi studio name unchanged
  const src = hq.slice(hq.indexOf("  function csvCell(v)"), hq.indexOf("  function recordPayment()"));
  let blobParts = null;
  const ctx = { lastBilling: { from: "2026-11-01", to: "2026-11-30", payments: [{ paid_on: "2026-11-02", studio: "शर्मा इवेंट्स", invoice_no: "HELM-1", amount: 999 }] },
    Blob: function (parts) { blobParts = parts; }, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    el: () => ({ click() {}, remove() {} }), document: { body: { appendChild() {} } }, setTimeout() {} };
  vm.runInNewContext(src + "\nwriteCsv();", ctx);
  assert.equal(blobParts.length, 1);
  assert.equal(blobParts[0].charCodeAt(0), 0xfeff, "first character is the BOM");
  assert.match(blobParts[0], /"शर्मा इवेंट्स"/);
  assert.equal(blobParts[0].indexOf("﻿", 1), -1, "only one BOM");
});

await t("2 public enquiry / delivery / vendor-request pages load telemetry.js like approve / work", async () => {
  for (const p of ["enquiry", "delivery", "vendor-request", "approve", "work"]) {
    const h = r("public/" + p + ".html");
    assert.match(h, /<script src="\/telemetry\.js\?v=11"><\/script>\n<script src="\/config\.js\?v=\d+"><\/script>/, p + ": telemetry.js right before config.js");
    assert.equal((h.match(/telemetry\.js/g) || []).length, 1, p + ": loaded once");
    assert.ok(h.indexOf("trusted-types.js") < h.indexOf("telemetry.js"), p + ": after the Trusted Types policy");
  }
  // the token in these links is a ?t= query - telemetry never sends a query string / t= value
  const w = { addEventListener() {}, HELM_TELEMETRY: {} };
  vm.runInNewContext(r("public/telemetry.js"), { window: w, document: { createElement: () => ({}), head: { appendChild() {} } }, location: { pathname: "/delivery" }, console });
  assert.equal(w.HelmTelemetry.stripUrl("https://www.helm.events/vendor-request?t=abc123def"), "https://www.helm.events/vendor-request");
  assert.doesNotMatch(w.HelmTelemetry.redact("open /delivery?t=0123456789abcdef failed"), /0123456789abcdef/);
});

await t("3 loadtest: production always refused, unknown hosts need the flag, no redirects followed", async () => {
  const L = await import(new URL("scripts/loadtest.mjs", root));
  const ok = (u, o) => assert.equal(L.targetProblem(u, o), "", u);
  const no = (u, o, re) => assert.match(L.targetProblem(u, o), re, u);
  ok("http://127.0.0.1:4173/"); ok("http://localhost:4173/api/health"); ok("http://[::1]:4173/");
  ok("https://helm-git-fix-abc.vercel.app/"); ok("https://helm-v01.vercel.app/login");
  for (const u of ["https://www.helm.events/", "https://helm.events", "https://WWW.HELM.EVENTS./", "https://api.helm.events/x",
    "https://helm-alpha-nine.vercel.app/", "https://nqltzgiwznphugcfhmbm.supabase.co/rest/v1/", "http://localhost@www.helm.events/"]) {
    no(u, {}, /PRODUCTION/); no(u, { override: true }, /PRODUCTION/);
  }
  no("https://example.com/", {}, /i-know-this-is-not-prod/); ok("https://example.com/", { override: true });
  no("ftp://127.0.0.1/", { override: true }, /http\(s\)/); no("not a url", {}, /not a valid URL/);
  assert.ok(L.PROD_HOSTS.includes("www.helm.events") && L.PROD_HOSTS.includes("helm.events"));
  assert.ok(L.PROD_SUPABASE_HOSTS.some((h) => r("public/config.js").includes("https://" + h)), "prod Supabase host read from config.js");
  // the CLI exits 2 BEFORE any request (no network in this test)
  for (const a of [["--url", "https://www.helm.events/", "--i-know-this-is-not-prod"], ["--url", "https://example.com/"]]) {
    const res = spawnSync(process.execPath, [new URL("scripts/loadtest.mjs", root).pathname, ...a], { encoding: "utf8", timeout: 20000 });
    assert.equal(res.status, 2, a.join(" ") + "\n" + res.stderr); assert.match(res.stderr, /Refusing to run/); assert.doesNotMatch(res.stdout, /loadtest →/);
  }
  assert.match(r("scripts/loadtest.mjs"), /redirect: 'manual'/);
});

await t("4 lost-update lock (R79) on the builder client saves, the event time save and the flow legacy pricing save", async () => {
  const b = r("public/builder.js");
  // the page-load client copy is never written back whole any more
  assert.doesNotMatch(b, /updateMeta\(currentQuoteId, \{ client: currentClient \}\)/);
  const helper = b.slice(b.indexOf("async function saveClientFields(apply){"), b.indexOf("// 0085: the venue picked"));
  assert.match(helper, /const fresh=await BPStore\.quotes\.get\(currentQuoteId\); if\(fresh\)\{ if\(fresh\.client\) base=fresh\.client; lock=fresh\.updatedAt\|\|null; \}/);
  assert.match(helper, /updateMeta\(currentQuoteId, \{ client: next \}, lock\)/);
  assert.match(helper, /e\.code==='CONFLICT'/); assert.match(helper, /This quote was changed elsewhere/);
  assert.equal((b.match(/saveClientFields\(/g) || []).length, 4, "helper + persistSizing + venue link + persistGuests");
  // behaviour: applies ONLY the builder's own field onto the latest client; retries once on CONFLICT; never clobbers the name
  const calls = [];
  let stamp = "s1", server = { name: "Asha (edited in the flow)", phone: "+91 98", guests: 100 };
  const ctx = { currentQuoteId: "q1", currentClient: { name: "Asha", guests: 100 }, BPUI: { alert: async () => { ctx.alerted = true; } },
    BPStore: { quotes: {
      get: async () => ({ client: { ...server }, updatedAt: stamp }),
      updateMeta: async (id, patch, lock) => { calls.push(lock); if (ctx.conflicts-- > 0) { stamp = "s" + calls.length + "b"; const e = new Error("changed"); e.code = "CONFLICT"; throw e; }
        server = patch.client; stamp = "s" + (calls.length + 1); return { updated_at: stamp }; } } } };
  vm.createContext(ctx);
  vm.runInContext(helper + "\nthis.saveClientFields = saveClientFields;", ctx);
  ctx.conflicts = 0;
  await ctx.saveClientFields((c) => Object.assign(c, { guests: 250 }));
  assert.deepEqual(JSON.parse(JSON.stringify(server)), { name: "Asha (edited in the flow)", phone: "+91 98", guests: 250 });
  assert.deepEqual([...calls], ["s1"]);
  ctx.conflicts = 1; calls.length = 0;
  await ctx.saveClientFields((c) => Object.assign(c, { venueId: "v1" }));
  assert.equal(calls.length, 2, "retried once on the fresh record"); assert.notEqual(calls[0], calls[1]);
  assert.equal(server.venueId, "v1"); assert.equal(server.name, "Asha (edited in the flow)"); assert.ok(!ctx.alerted);
  ctx.conflicts = 5; calls.length = 0;
  await assert.rejects(ctx.saveClientFields((c) => c), (e) => e.code === "CONFLICT");
  assert.equal(calls.length, 2); assert.ok(ctx.alerted, "told after the retry also conflicted");
  // venue link still writes the venue fields (venues.test.mjs) - only those keys
  assert.match(b, /const keys = v \? \['venueId','venueName','setting','venueLen','venueWid'\] : \['venueId','venueName'\];/);
  // event.html time save + flow.html legacy pricing save
  const ev = r("public/event.html");
  assert.match(ev, /updateMeta\(id,\{eventTime:nt\}, lock\)/);
  assert.match(ev, /\{eventTime:nt\}, lock\); ev\.eventTime=nt; if\(row&&row\.updated_at\) ev\.updatedAt=row\.updated_at;/);
  const fl = r("public/flow.html");
  assert.match(fl, /row=await BPStore\.quotes\.updateMeta\(id,\{ pricing \}, ev\.updatedAt\);/);
  assert.doesNotMatch(fl, /updateMeta\(id,\{ pricing \}\)/);
});

await t("5 API.md lists every edge function in supabase/config.toml, no store-api line numbers", async () => {
  const fns = [...r("supabase/config.toml").matchAll(/^\[functions\.([a-z0-9-]+)\]/gm)].map((m) => m[1]);
  assert.equal(fns.length, 26);   // R156: + wa-template-worker
  const api = r("docs/project/API.md");
  const sec4 = api.slice(api.indexOf("## 4."), api.indexOf("## 5."));
  for (const f of fns) assert.match(sec4, new RegExp("\\| `" + f + "` \\|"), "API.md section 4 misses " + f);
  assert.doesNotMatch(api, /store-api\.js:\d+/);
  assert.doesNotMatch(api, /There are 21/);
});

await t("6 sbom.json current: npm runtime + build tools + vendored browser libs + Deno edge imports", async () => {
  const res = spawnSync(process.execPath, [new URL("scripts/gen-sbom.mjs", root).pathname, "--check"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const s = JSON.parse(r("sbom.json"));
  assert.equal(s.bomFormat, "CycloneDX"); assert.equal(s.specVersion, "1.6");
  const refs = s.components.map((c) => c["bom-ref"]);
  for (const want of ["npm-runtime:@supabase/supabase-js@2.119.0", "build-tool:terser@5.51.2", "build-tool:clean-css@5.3.3",
    "vendored-browser:supabase-js-2.119.0.min.js", "vendored-browser:sentry-10.78.0.bundle.min.js", "vendored-browser:three-0.186.1",
    "deno-edge:npm:@supabase/supabase-js@2.119.0", "deno-edge:jsr:@std/assert@1.0.19"]) assert.ok(refs.includes(want), want);
  assert.ok(!refs.some((x) => /playwright|axe-core/.test(x)), "dev-only packages left out");
  assert.equal(s.components.find((c) => c["bom-ref"] === "deno-edge:jsr:@std/assert@1.0.19").scope, "excluded", "test-only");
});

await t("7 the duplicate iCloud shim copies are gone; the real shim stays", async () => {
  assert.ok(!existsSync(new URL("supabase/test-harness/00-supabase-shim 3.sql", root)));
  assert.ok(!existsSync(new URL("supabase/test-harness/00-supabase-shim 4.sql", root)));
  assert.ok(existsSync(new URL("supabase/test-harness/00-supabase-shim.sql", root)));
});

console.log("r147 small lows: OK (" + n + " groups)");

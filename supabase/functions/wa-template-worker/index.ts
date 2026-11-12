// wa-template-worker - R156 (0354): creates a studio's WhatsApp message templates in the BACKGROUND and follows Meta's
// review until every template is final. Called by pg_cron every 3 minutes (mode "tick") and once a night (mode
// "nightly", 02:30 IST) through pg_net with the Vault secret (public._r354_kick). Deploy WITHOUT the JWT check
// (config.toml verify_jwt = false): it authenticates in code with the shared secret HELM_WA_TEMPLATE_SECRET in the
// x-helm-cron-secret header; unset secret = every call 401.
//
// Per studio with work (wa_template_due_orgs):
//   1  reads the studio's templates ONCE (GET /<WABA>/message_templates?fields=name,status,language,category,
//      rejected_reason,quality_score,id) and records them (wa_template_sync: state, category change, quality, reason)
//   2  claims its due queue rows (wa_template_claim: skip locked, never more than Meta's 100 creates per hour per account)
//      and for each one: already in the account (same name + language) -> just record it (never a duplicate);
//      resubmit of a rejected one -> POST /<template id> with Helm's fixed wording (an edit, the name stays);
//      else Meta's Template Library version when one fits (proposal_approval_otp, proposal_approved_pay, payment_received)
//      and Helm's own wording when the library call fails or nothing fits
//   3  Meta rate limit -> that studio pauses (60 minutes); temporary problem -> retry with a growing wait (up to 8 tries);
//      wording refused -> failed with Meta's code + short message (Fix and resubmit on the page)
//   4  one bell notice when the round is over (wa_template_finish), a notice per category change
//   5  the number's health about twice a day (quality rating, messaging limit, send health / payment) - read-only calls
// The token is read with the service role (org_whatsapp_check_creds), sent only to graph.facebook.com, never logged,
// never returned. Every Meta call has a 10 s deadline; the run stops starting new studios after 100 s.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { errTag, sentryOnce } from "../_shared/cors.ts";
import { BodyTooLarge, readJsonCapped } from "../_shared/limits.ts";
import { fetchWithTimeout, isTimeout } from "../_shared/http.ts";
import { logger } from "../_shared/log.ts";
import {
  graphVersion, healthOf, LIBRARY, libraryCreateBody, libraryFit, libraryQuery, safeMetaError, STUDIO_LANG, TEMPLATE_FIELDS,
  templateCatalogue, templateDetails, templateError, templateStates,
} from "../_shared/wa-studio.mjs";

const env = (k: string) => Deno.env.get(k);
const GRAPH = "https://graph.facebook.com";
const DIGITS = /^[0-9]{5,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = new TextEncoder();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function secretMatches(given: string, expected: string): Promise<boolean> {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// deno-lint-ignore no-explicit-any
type G = { status: number; body: any };
async function graph(token: string, path: string, init: RequestInit = {}): Promise<G> {
  const u = new URL(`${GRAPH}/${graphVersion(env)}/${path}`);
  if (u.hostname !== "graph.facebook.com" || u.protocol !== "https:") throw new Error("host not allowed");
  try {
    const r = await fetchWithTimeout(u.toString(), { ...init, redirect: "error",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", ...(init.headers || {}) } });
    const raw = await r.text();
    // deno-lint-ignore no-explicit-any
    let body: any = null;
    try { body = JSON.parse(raw); } catch (_) { body = null; }
    return { status: r.status, body };
  } catch (e) {
    if (isTimeout(e)) return { status: 0, body: { error: { message: "timeout" } } };
    return { status: 0, body: { error: { message: "network" } } };
  }
}
const ok = (r: G) => r.status >= 200 && r.status < 300;

// deno-lint-ignore no-explicit-any
async function rpc(admin: any, name: string, args: Record<string, unknown>, log: ReturnType<typeof logger>) {
  const { data, error } = await admin.rpc(name, args);
  if (error) { log.error("rpc failed", errTag(error), { rpc: name }); return { data: null, failed: true }; }
  return { data, failed: false };
}

type Job = { id: string; name: string; language: string; action: string; variant: string; meta_id: string | null; attempts: number };
// deno-lint-ignore no-explicit-any
type Detail = { name: string; language: string; status: string; category: string | null; id: string | null; [k: string]: any };
export type OrgResult = { org: string; created: number; existed: number; failed: number; retried: number; paused: boolean; finished: string | null; health: boolean; skipped?: string };

// one studio, start to end
// deno-lint-ignore no-explicit-any
export async function processOrg(admin: any, org: string, opts: { nightly: boolean; appUrl?: string; log: ReturnType<typeof logger> }): Promise<OrgResult> {
  const { log } = opts;
  const res: OrgResult = { org, created: 0, existed: 0, failed: 0, retried: 0, paused: false, finished: null, health: false };
  const c = await rpc(admin, "org_whatsapp_check_creds", { p_org: org }, log);
  const token = String(c.data?.token || ""), phoneId = String(c.data?.phone_number_id || ""), waba = String(c.data?.waba_id || "");
  if (!c.data || String(c.data.status) !== "connected" || token.length < 20 || !DIGITS.test(phoneId) || !DIGITS.test(waba)) { res.skipped = "not_connected"; return res; }

  // 1) the studio's templates, once
  const list = await graph(token, `${encodeURIComponent(waba)}/message_templates?fields=${TEMPLATE_FIELDS}&limit=250`);
  if (!ok(list)) {
    const te = templateError(list.status, list.body);
    log.error("template list", list.status, { reason: te.reason });
    res.skipped = "list_" + te.reason;
    return res;
  }
  const details = templateDetails(list.body?.data) as Detail[];
  const sync = await rpc(admin, "wa_template_sync", { p_org: org, p_list: details, p_any_pending: details.some((d) => d.status === "PENDING") }, log);
  for (const rc of Array.isArray(sync.data?.recategorised) ? sync.data.recategorised : []) {
    await rpc(admin, "wa_template_category_notice", { p_org: org, p_name: rc.name, p_from: rc.from, p_to: rc.to }, log);
  }
  await rpc(admin, "wa_templates_mark", { p_org: org, p_templates: templateStates(list.body?.data) }, log);
  const have = new Map(details.map((d) => [d.name + "|" + d.language, d]));

  // 2) the due queue rows
  const cl = await rpc(admin, "wa_template_claim", { p_org: org, p_limit: 25 }, log);
  const jobs: Job[] = Array.isArray(cl.data) ? cl.data : [];
  const cat = new Map(templateCatalogue(opts.appUrl).map((t) => [t.name, t]));
  const record = (id: string, result: Record<string, unknown>) => rpc(admin, "wa_template_record", { p_id: id, p_result: result }, log);
  for (const j of jobs) {
    if (!UUID.test(String(j.id || ""))) continue;
    // a Meta rate limit earlier in this run: everything left waits too (no further call)
    if (res.paused) { await record(j.id, { outcome: "paused", retry_minutes: 60, error: { reason: "rate_limit" } }); continue; }
    const t = cat.get(j.name);
    const lang = j.language || STUDIO_LANG;
    if (!t || lang !== STUDIO_LANG) { await record(j.id, { outcome: "failed", error: { reason: "other", message: "not a Helm template" } }); res.failed++; continue; }
    const ex = have.get(j.name + "|" + lang);
    const isResubmit = j.action === "resubmit" && /^[0-9]{1,30}$/.test(String(j.meta_id || ""));
    if (ex && !isResubmit) {
      await record(j.id, { outcome: "exists", meta_id: ex.id, meta_status: ex.status, category: ex.category, rejected_reason: ex.rejected_reason });
      res.existed++; continue;
    }
    let r: G | null = null, used: Record<string, unknown> = { variant: "own" };
    if (isResubmit) {
      // edit the rejected template in place with Helm's fixed wording (the name cannot be reused for weeks after a delete)
      r = await graph(token, `${encodeURIComponent(String(j.meta_id))}`, { method: "POST", body: JSON.stringify({ components: t.components }) });
    } else {
      if (LIBRARY[j.name] && env("HELM_WA_LIBRARY") !== "off") {
        const lib = await libraryTry(token, waba, j.name, opts.appUrl, log);
        if (lib && ok(lib.r)) { r = lib.r; used = { variant: "library", library_name: lib.fit.library_name, param_map: { fields: lib.fit.fields, url_button: lib.fit.url_button } }; }
        else if (lib && templateError(lib.r.status, lib.r.body, t.category).next === "pause") r = lib.r;   // rate limit: stop, do not fall back now
      }
      if (!r) r = await graph(token, `${encodeURIComponent(waba)}/message_templates`, { method: "POST", body: JSON.stringify(t) });
    }
    if (ok(r)) {
      await record(j.id, { outcome: "created", counted: true, meta_id: String(r.body?.id || "") || (isResubmit ? j.meta_id : null),
        meta_status: String(r.body?.status || "PENDING"), category: r.body?.category || t.category, ...used });
      res.created++; continue;
    }
    const te = templateError(r.status, r.body, t.category);
    const error = safeMetaError(r.status, r.body, te.reason);
    log.error("template create", r.status, { template: j.name, reason: te.reason, code: error.code || 0, subcode: error.subcode || 0 });
    if (te.next === "exists") { await record(j.id, { outcome: "exists", counted: true, meta_status: "PENDING" }); res.existed++; }
    else if (te.next === "pause") { await record(j.id, { outcome: "paused", counted: true, retry_minutes: 60, error }); res.paused = true; }
    else if (te.next === "failed") { await record(j.id, { outcome: "failed", counted: true, error }); res.failed++; }
    else { await record(j.id, { outcome: "retry", counted: r.status !== 0, error }); res.retried++; }
  }

  // 4) is the round over?
  const fin = await rpc(admin, "wa_template_finish", { p_org: org }, log);
  res.finished = fin.data?.result ? String(fin.data.result) : null;

  // 5) the number's health (about twice a day, or every night)
  let dueHealth = opts.nightly;
  if (!dueHealth) {
    try {
      const { data } = await admin.from("wa_template_setup").select("health_checked_at").eq("org_id", org).maybeSingle();
      const at = data?.health_checked_at ? Date.parse(String(data.health_checked_at)) : 0;
      dueHealth = !at || Date.now() - at > 12 * 3600_000;
    } catch (_) { dueHealth = false; }
  }
  if (dueHealth) {
    const p = await graph(token, `${encodeURIComponent(phoneId)}?fields=quality_rating,status,name_status,throughput`);
    if (ok(p)) {
      // these two are newer fields: a refusal just leaves them out
      const tier = await graph(token, `${encodeURIComponent(phoneId)}?fields=messaging_limit_tier`);
      const hs = await graph(token, `${encodeURIComponent(phoneId)}?fields=health_status`);
      const h = healthOf(p.body, ok(tier) ? tier.body : null, ok(hs) ? hs.body : null);
      await rpc(admin, "wa_health_record", { p_org: org, p_health: h }, log);
      res.health = true;
    }
  }
  return res;
}

// Meta Template Library: find a fitting entry and create from it. null = nothing fits / library not reachable
async function libraryTry(token: string, waba: string, name: string, appUrl: string | undefined, log: ReturnType<typeof logger>) {
  const q = libraryQuery(name);
  if (!q) return null;
  const l = await graph(token, q);
  if (!ok(l)) { log.info("library not available", { template: name, status: l.status }); return null; }
  // deno-lint-ignore no-explicit-any
  const fit = (Array.isArray(l.body?.data) ? l.body.data : []).map((e: any) => libraryFit(name, e, appUrl)).find(Boolean);
  if (!fit) return null;
  const body = libraryCreateBody(name, fit, appUrl);
  if (!body) return null;
  const r = await graph(token, `${encodeURIComponent(waba)}/message_templates`, { method: "POST", body: JSON.stringify(body) });
  if (!ok(r)) log.info("library create refused, using Helm wording", { template: name, status: r.status });
  return { r, fit };
}

Deno.serve(async (req) => {
  const log = logger("wa-template-worker", req);
  const report = sentryOnce(req);   // one Sentry event per run at most (function name + tag only)
  try {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const okSecret = await secretMatches(req.headers.get("x-helm-cron-secret") || "", env("HELM_WA_TEMPLATE_SECRET") || "");
    if (!okSecret) return json({ error: "unauthorized" }, 401);
    const body: Record<string, unknown> = await readJsonCapped(req).catch((e) => { if (e instanceof BodyTooLarge) throw e; return {}; });
    const nightly = body?.mode === "nightly";
    const url = env("SUPABASE_URL") || "", svc = env("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !svc) return json({ error: "not configured" }, 500);
    const admin = createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } });
    const due = await rpc(admin, "wa_template_due_orgs", { p_nightly: nightly, p_limit: nightly ? 200 : 50 }, log);
    if (due.failed) return json({ error: "apply APPLY-0354.sql first" }, 503);
    const orgs: string[] = (Array.isArray(due.data) ? due.data : []).map(String).filter((x: string) => UUID.test(x));
    const started = Date.now(), out: OrgResult[] = [];
    for (const org of orgs) {
      if (Date.now() - started > 100_000) break;
      try { out.push(await processOrg(admin, org, { nightly, appUrl: env("APP_URL"), log })); }
      catch (e) { log.error("studio run failed", errTag(e)); report.fail("studio_failed"); }
    }
    const sum = out.reduce((a, r) => ({ created: a.created + r.created, existed: a.existed + r.existed, failed: a.failed + r.failed, retried: a.retried + r.retried, paused: a.paused + (r.paused ? 1 : 0) }),
      { created: 0, existed: 0, failed: 0, retried: 0, paused: 0 });
    log.info("run", { mode: nightly ? "nightly" : "tick", studios: out.length, ...sum });
    return json({ status: "ok", mode: nightly ? "nightly" : "tick", studios: out.length, ...sum, results: out.map((r) => ({ ...r, org: undefined })) });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    log.error("worker error", errTag(e));
    report.error(e);
    return json({ error: "internal error" }, 500);
  }
});

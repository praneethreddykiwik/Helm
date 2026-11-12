// wa-connect - R129 (0337): the Integrations page's WhatsApp buttons for a studio's OWN WhatsApp Business number.
// Signed-in studio ADMIN only (wa_connect_org, asked AS the caller). Deploy WITH the JWT check (config.toml verify_jwt = true).
//
// Request: { action: "verify" | "templates" | "status" }
//   verify     Check connection: asks Meta for the saved phone number ID with the saved token, checks the number belongs to
//              the WhatsApp Business Account ID, then records "connected" (number + name shown to clients + quality) or
//              "error" with a short reason. Also subscribes Helm's app to the account's webhooks when the token allows it
//              (delivery ticks + STOP replies), and refreshes the template states.
//   templates  Set up message templates. R156 (0354): reads the studio's templates once, puts the ones that are not in
//              the account yet (same name + language) in the background queue (wa_template_enqueue) and answers at once
//              ({ background: true, queued }); the wa-template-worker edge function creates them, follows Meta's review and
//              sends one bell notice. A database without 0354: the old way (created inside this request), now with
//              Meta's real reason per template (failed: [{ name, reason, code, subcode, message }]).
//   status     Refresh the template states (+ the review facts in the queue rows).
//   resubmit   R156: Fix and resubmit one rejected / failed template ({ name }) - wa_template_resubmit as the caller.
// Answer: { ok, status, display_phone?, verified_name?, quality?, error?, code?, templates: { name: STATE }, summary, webhook? }
// R154h: code = a short reason the page explains (details_missing | token | permission | number | waba | not_in_account | limit |
//        not_checked | timeout | other). Codes and Meta error numbers only - never the token or any part of it.
// The token is read with the service role (org_whatsapp_check_creds), sent only to graph.facebook.com, never returned,
// never logged. Costs Meta quota, so it is rate-limited per admin and per studio.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { bearer, errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { graphError, graphVersion, safeMetaError, STUDIO_LANG, TEMPLATE_FIELDS, templateDetails, templateError, templateStates, templatesToCreate, templateSummary, verifyResult } from "../_shared/wa-studio.mjs";
import { fetchWithTimeout, isTimeout } from "../_shared/http.ts";   // R142: every Meta call has a deadline
import { logger } from "../_shared/log.ts";
const L = logger("wa-connect");

const env = (k: string) => Deno.env.get(k);
const GRAPH = "https://graph.facebook.com";
const DIGITS = /^[0-9]{5,30}$/;

// deno-lint-ignore no-explicit-any
async function graph(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const u = new URL(`${GRAPH}/${graphVersion(env)}/${path}`);
  if (u.hostname !== "graph.facebook.com" || u.protocol !== "https:") throw new Error("host not allowed");
  const r = await fetchWithTimeout(u.toString(), { ...init, redirect: "error",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", ...(init.headers || {}) } });
  const raw = await r.text();
  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try { body = JSON.parse(raw); } catch (_) { body = null; }
  return { status: r.status, body };
}

// deno-lint-ignore no-explicit-any
async function readStates(admin: any, org: string, token: string, waba: string): Promise<Record<string, string> | null> {
  const r = await graph(token, `${encodeURIComponent(waba)}/message_templates?fields=${TEMPLATE_FIELDS}&limit=250`);
  if (r.status < 200 || r.status >= 300) { L.error("template list", r.status, { kind: graphError(r.status, r.body).kind }); return null; }
  const states = templateStates(r.body?.data) as Record<string, string>;
  const { error } = await admin.rpc("wa_templates_mark", { p_org: org, p_templates: states });
  if (error) L.error("templates mark failed", errTag(error));
  // R156: the review facts (category, rejection reason, quality) into the queue rows; a database without 0354 skips it
  const details = templateDetails(r.body?.data);
  const { error: sErr } = await admin.rpc("wa_template_sync", { p_org: org, p_list: details, p_any_pending: details.some((d: { status: string }) => d.status === "PENDING") });
  if (sErr && !/PGRST202|42883/.test(String(sErr.code || ""))) L.error("template sync failed", errTag(sErr));
  return states;
}
const missingFn = (e: unknown) => /PGRST202|42883/.test(String((e as { code?: string })?.code || ""));
// deno-lint-ignore no-explicit-any
async function setupOf(asCaller: any): Promise<unknown> {
  try { const { data, error } = await asCaller.rpc("my_wa_template_setup", {}); return error ? null : data; } catch (_) { return null; }
}

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  const log = logger("wa-connect", req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ipWait = await checkLimits([["waconn:ip:" + clientIp(req), 30, 60_000]]);
    if (ipWait) return tooMany(json, ipWait);
    const body: Record<string, unknown> = await readJsonCapped(req);
    const url = env("SUPABASE_URL")!, anonKey = env("SUPABASE_ANON_KEY") || "", svc = env("SUPABASE_SERVICE_ROLE_KEY") || "";
    const jwt = bearer(req);
    if (!jwt || !anonKey || jwt === anonKey) return json({ error: "sign in as the studio admin" }, 401);
    const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: "Bearer " + jwt } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user } } = await asCaller.auth.getUser(jwt);
    if (!user) return json({ error: "sign in as the studio admin" }, 401);
    const action = String(body.action || "");
    if (!["verify", "templates", "status", "resubmit"].includes(action)) return json({ error: "unknown action" }, 400);

    const { data: orgId, error: oErr } = await asCaller.rpc("wa_connect_org", {});
    if (oErr || !orgId) {
      if (String(oErr?.code || "") === "PGRST202" || String(oErr?.code || "") === "42883") return json({ error: "apply APPLY-0337.sql first" }, 503);
      return json({ error: "only the studio admin can connect WhatsApp" }, 403);
    }
    const org = String(orgId);
    const wait = await checkLimits([["waconn:user:" + user.id, 20, 600_000], ["waconn:org:" + org + ":" + action, action === "templates" ? 6 : 30, 3_600_000]]);
    if (wait) return tooMany(json, wait);
    if (!svc) return json({ error: "could not check the studio" }, 500);
    const admin = createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: c, error: cErr } = await admin.rpc("org_whatsapp_check_creds", { p_org: org });
    if (cErr) { log.error("creds failed", errTag(cErr)); return json({ error: "could not read the saved number - try again" }, 500); }
    const token = String(c?.token || ""), phoneId = String(c?.phone_number_id || ""), waba = String(c?.waba_id || "");
    if (!c || token.length < 20 || !DIGITS.test(phoneId) || !DIGITS.test(waba)) return json({ ok: false, status: "none", code: "details_missing", error: "save the WhatsApp Business Account ID, Phone number ID and access token first" }, 409);

    if (action === "verify") {
      const p = await graph(token, `${encodeURIComponent(phoneId)}?fields=id,display_phone_number,verified_name,quality_rating`);
      let v: { ok: boolean; display?: string; name?: string; quality?: string; error?: string; code?: string };
      if (p.status < 200 || p.status >= 300) { const ge = graphError(p.status, p.body); v = { ok: false, error: ge.text, code: ge.kind }; }
      else {
        const l = await graph(token, `${encodeURIComponent(waba)}/phone_numbers?fields=id&limit=100`);
        if (l.status >= 200 && l.status < 300) v = verifyResult(phoneId, p.body, l.body?.data);
        else {
          const ge = graphError(l.status, l.body);
          // the phone number answered, so a "not known" here is the WhatsApp Business Account ID
          v = { ok: false, error: ge.text.replace("phone number ID or account ID", "WhatsApp Business Account ID").replace(" - check both numbers", ""),
                code: ge.kind === "number" ? "waba" : ge.kind };
        }
      }
      const { error: mErr } = await admin.rpc("wa_account_verified", { p_org: org, p_ok: v.ok, p_display_phone: v.display || null,
        p_verified_name: v.name || null, p_quality: v.quality || null, p_error: v.ok ? null : (v.error || "connection check failed") });
      if (mErr) { log.error("verified mark failed", errTag(mErr)); return json({ error: "could not save the result - try again" }, 500); }
      if (!v.ok) return json({ ok: false, status: "error", error: v.error, code: v.code || "other" });
      // delivery ticks + STOP replies reach Helm only for numbers in an account subscribed to Helm's app (best effort)
      let webhook = false;
      try { const s = await graph(token, `${encodeURIComponent(waba)}/subscribed_apps`, { method: "POST" }); webhook = s.status >= 200 && s.status < 300 && s.body?.success === true; }
      catch (e) { log.error("subscribe", errTag(e)); }
      const states = await readStates(admin, org, token, waba);
      return json({ ok: true, status: "connected", display_phone: v.display, verified_name: v.name, quality: v.quality || null, webhook,
        templates: states || {}, summary: templateSummary(states || {}) });
    }

    // templates / status need a number that passed the check
    if (String(c.status) !== "connected") return json({ ok: false, status: String(c.status || "pending"), code: "not_checked", error: "press Check connection first" }, 409);
    if (action === "resubmit") {
      // R156: Fix and resubmit - as the caller (admin of the studio, checked in the database); the worker does the Meta call
      const name = String(body.name || "");
      if (!/^[a-z0-9_]{1,64}$/.test(name)) return json({ error: "unknown template" }, 400);
      const { data: rs, error: rErr } = await asCaller.rpc("wa_template_resubmit", { p_name: name, p_language: STUDIO_LANG });
      if (rErr) {
        if (missingFn(rErr)) return json({ error: "apply APPLY-0354.sql first" }, 503);
        const m = String(rErr.message || "");
        if (/not_resubmittable/.test(m)) return json({ ok: false, code: "not_resubmittable", error: "that template is not rejected - nothing to resubmit" }, 409);
        if (/not_found/.test(m)) return json({ ok: false, code: "not_found", error: "press Set up message templates first" }, 409);
        return json({ error: "only the studio admin can do this" }, 403);
      }
      return json({ ok: true, status: "connected", background: true, resubmitted: rs?.name || name, setup: await setupOf(asCaller) });
    }
    let created = 0;
    const failed: { name: string; reason: string; code?: number; subcode?: number; title?: string; message?: string }[] = [];
    if (action === "templates") {
      const before = await readStates(admin, org, token, waba);
      if (!before) return json({ ok: false, status: "connected", error: "could not read your message templates from Meta - check the token permissions" }, 502);
      const todo = templatesToCreate(before, env("APP_URL"));
      // R156: the background queue (idempotent: a name already queued / in the account is never queued twice)
      const { data: q, error: qErr } = await admin.rpc("wa_template_enqueue", { p_org: org, p_items: todo.map((t: { name: string; language: string }) => ({ name: t.name, language: t.language })), p_user: user.id });
      if (!qErr && q && q.ok === true) {
        return json({ ok: true, status: "connected", background: true, queued: Number(q.queued) || 0, templates: before, summary: templateSummary(before), setup: await setupOf(asCaller) });
      }
      if (qErr && !missingFn(qErr)) { log.error("enqueue failed", errTag(qErr)); return json({ error: "could not start the setup - try again" }, 500); }
      // a database without 0354: create here as before, keeping Meta's real reason per template
      for (const t of todo) {
        const r = await graph(token, `${encodeURIComponent(waba)}/message_templates`, { method: "POST", body: JSON.stringify(t) });
        if (r.status >= 200 && r.status < 300) { created++; continue; }
        const te = templateError(r.status, r.body, t.category);
        if (te.next === "exists") continue;
        const e = safeMetaError(r.status, r.body, te.reason);
        failed.push({ name: t.name, ...e });
        log.error("template create", r.status, { template: t.name, reason: te.reason, code: e.code || 0, subcode: e.subcode || 0 });
        if (te.next === "pause") break;   // Meta rate limit: stop for now
      }
    }
    const states = await readStates(admin, org, token, waba);
    if (!states) return json({ ok: false, status: "connected", error: "could not read your message templates from Meta - check the token permissions" }, 502);
    return json({ ok: true, status: "connected", created, failed, templates: states, summary: templateSummary(states), setup: await setupOf(asCaller) });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    // R142: Meta passed its 10 s deadline - a provider failure ("try again"), never a saved "error" state
    if (isTimeout(e)) { log.error("meta timed out", errTag(e)); return json({ error: "WhatsApp (Meta) did not answer in time - try again", code: "timeout" }, 502); }
    return serverError(e);
  }
});

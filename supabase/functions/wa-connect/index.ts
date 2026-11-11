// wa-connect - R129 (0337): the Integrations page's WhatsApp buttons for a studio's OWN WhatsApp Business number.
// Signed-in studio ADMIN only (wa_connect_org, asked AS the caller). Deploy WITH the JWT check (config.toml verify_jwt = true).
//
// Request: { action: "verify" | "templates" | "status" }
//   verify     Check connection: asks Meta for the saved phone number ID with the saved token, checks the number belongs to
//              the WhatsApp Business Account ID, then records "connected" (number + name shown to clients + quality) or
//              "error" with a short reason. Also subscribes Helm's app to the account's webhooks when the token allows it
//              (delivery ticks + STOP replies), and refreshes the template states.
//   templates  Set up message templates: creates Helm's templates (_shared/wa-studio.mjs) that are not in the studio's
//              account yet, then refreshes the states. Meta reviews each one (minutes to a few hours).
//   status     Refresh the template states only.
// Answer: { ok, status, display_phone?, verified_name?, quality?, error?, templates: { name: STATE }, summary, webhook? }
// The token is read with the service role (org_whatsapp_check_creds), sent only to graph.facebook.com, never returned,
// never logged. Costs Meta quota, so it is rate-limited per admin and per studio.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { bearer, errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { graphError, graphVersion, templateStates, templatesToCreate, templateSummary, verifyResult } from "../_shared/wa-studio.mjs";

const env = (k: string) => Deno.env.get(k);
const GRAPH = "https://graph.facebook.com";
const DIGITS = /^[0-9]{5,30}$/;

// deno-lint-ignore no-explicit-any
async function graph(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const u = new URL(`${GRAPH}/${graphVersion(env)}/${path}`);
  if (u.hostname !== "graph.facebook.com" || u.protocol !== "https:") throw new Error("host not allowed");
  const r = await fetch(u.toString(), { ...init, redirect: "error",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", ...(init.headers || {}) } });
  const raw = await r.text();
  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try { body = JSON.parse(raw); } catch (_) { body = null; }
  return { status: r.status, body };
}

// deno-lint-ignore no-explicit-any
async function readStates(admin: any, org: string, token: string, waba: string): Promise<Record<string, string> | null> {
  const r = await graph(token, `${encodeURIComponent(waba)}/message_templates?fields=name,status,language&limit=200`);
  if (r.status < 200 || r.status >= 300) { console.error("wa-connect: template list", r.status, graphError(r.status, r.body).kind); return null; }
  const states = templateStates(r.body?.data) as Record<string, string>;
  const { error } = await admin.rpc("wa_templates_mark", { p_org: org, p_templates: states });
  if (error) console.error("wa-connect: templates mark failed", errTag(error));
  return states;
}

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
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
    if (!["verify", "templates", "status"].includes(action)) return json({ error: "unknown action" }, 400);

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
    if (cErr) { console.error("wa-connect: creds failed", errTag(cErr)); return json({ error: "could not read the saved number - try again" }, 500); }
    const token = String(c?.token || ""), phoneId = String(c?.phone_number_id || ""), waba = String(c?.waba_id || "");
    if (!c || token.length < 20 || !DIGITS.test(phoneId) || !DIGITS.test(waba)) return json({ ok: false, status: "none", error: "save your WhatsApp details first" }, 409);

    if (action === "verify") {
      const p = await graph(token, `${encodeURIComponent(phoneId)}?fields=id,display_phone_number,verified_name,quality_rating`);
      let v: { ok: boolean; display?: string; name?: string; quality?: string; error?: string };
      if (p.status < 200 || p.status >= 300) v = { ok: false, error: graphError(p.status, p.body).text };
      else {
        const l = await graph(token, `${encodeURIComponent(waba)}/phone_numbers?fields=id&limit=100`);
        v = l.status >= 200 && l.status < 300 ? verifyResult(phoneId, p.body, l.body?.data)
          : { ok: false, error: graphError(l.status, l.body).text.replace("phone number ID or account ID", "WhatsApp Business Account ID") };
      }
      const { error: mErr } = await admin.rpc("wa_account_verified", { p_org: org, p_ok: v.ok, p_display_phone: v.display || null,
        p_verified_name: v.name || null, p_quality: v.quality || null, p_error: v.ok ? null : (v.error || "connection check failed") });
      if (mErr) { console.error("wa-connect: verified mark failed", errTag(mErr)); return json({ error: "could not save the result - try again" }, 500); }
      if (!v.ok) return json({ ok: false, status: "error", error: v.error });
      // delivery ticks + STOP replies reach Helm only for numbers in an account subscribed to Helm's app (best effort)
      let webhook = false;
      try { const s = await graph(token, `${encodeURIComponent(waba)}/subscribed_apps`, { method: "POST" }); webhook = s.status >= 200 && s.status < 300 && s.body?.success === true; }
      catch (e) { console.error("wa-connect: subscribe", errTag(e)); }
      const states = await readStates(admin, org, token, waba);
      return json({ ok: true, status: "connected", display_phone: v.display, verified_name: v.name, quality: v.quality || null, webhook,
        templates: states || {}, summary: templateSummary(states || {}) });
    }

    // templates / status need a number that passed the check
    if (String(c.status) !== "connected") return json({ ok: false, status: String(c.status || "pending"), error: "press Check connection first" }, 409);
    let created = 0;
    const failed: string[] = [];
    if (action === "templates") {
      const before = await readStates(admin, org, token, waba);
      if (!before) return json({ ok: false, status: "connected", error: "could not read your message templates from Meta - check the token permissions" }, 502);
      for (const t of templatesToCreate(before, env("APP_URL"))) {
        const r = await graph(token, `${encodeURIComponent(waba)}/message_templates`, { method: "POST", body: JSON.stringify(t) });
        if (r.status >= 200 && r.status < 300) created++;
        else if (graphError(r.status, r.body).kind !== "exists") { failed.push(t.name); console.error("wa-connect: template create", t.name, r.status, graphError(r.status, r.body).kind); }
      }
    }
    const states = await readStates(admin, org, token, waba);
    if (!states) return json({ ok: false, status: "connected", error: "could not read your message templates from Meta - check the token permissions" }, 502);
    return json({ ok: true, status: "connected", created, failed, templates: states, summary: templateSummary(states) });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    return serverError(e);
  }
});

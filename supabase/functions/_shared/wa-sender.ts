// _shared/wa-sender.ts - R129 (0337): WHO sends a studio's WhatsApp messages.
// A studio's messages go out from the studio's OWN connected WhatsApp Business number (org_whatsapp_creds, service role:
// status 'connected' only). A studio without one sends no WhatsApp ("not connected"); Helm's own number (the
// WHATSAPP_TOKEN / WHATSAPP_PHONE_ID secrets) is used only for Helm's own messages (helmSender, send-phone-code).
// When Meta says a studio's token stopped working, the account is marked "error" (the Integrations page then says
// "Needs attention"), so the studio reconnects instead of messages failing quietly. Tokens are never logged.
import { errTag } from "./cors.ts";
import { graphError, graphVersion } from "./wa-studio.mjs";
import { fetchWithTimeout } from "./http.ts";   // R142: Meta call has a deadline (timeout = "could not reach WhatsApp")
import { logger } from "./log.ts";
const log = logger("wa-sender");

export type WaSender = { source: "studio" | "helm"; orgId: string | null; phoneId: string; token: string; wabaId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^[0-9]{5,30}$/;
const env = (k: string) => Deno.env.get(k);

// the studio's connected number, or null (not connected / paused / error / database without 0117)
// deno-lint-ignore no-explicit-any
export async function studioSender(admin: any, orgId: string | null | undefined): Promise<WaSender | null> {
  const org = String(orgId || "");
  if (!UUID.test(org)) return null;
  try {
    const { data, error } = await admin.rpc("org_whatsapp_creds", { p_org: org });
    if (error || !data || typeof data !== "object") return null;
    const token = String(data.token || ""), phoneId = String(data.phone_number_id || "");
    if (token.length < 20 || !DIGITS.test(phoneId)) return null;
    return { source: "studio", orgId: org, phoneId, token, wabaId: String(data.waba_id || "") };
  } catch (e) { log.error("lookup failed", errTag(e)); return null; }
}

// a studio sender per org, looked up once per run (background senders)
// deno-lint-ignore no-explicit-any
export function senderCache(admin: any) {
  const m = new Map<string, Promise<WaSender | null>>();
  return (orgId: string | null | undefined) => {
    const k = String(orgId || "");
    if (!m.has(k)) m.set(k, studioSender(admin, k));
    return m.get(k)!;
  };
}

// Helm's own number (Helm's own messages only), or null when its secrets are not set
export function helmSender(): WaSender | null {
  const token = env("WHATSAPP_TOKEN") || "", phoneId = env("WHATSAPP_PHONE_ID") || "";
  if (!token || !DIGITS.test(phoneId)) return null;
  return { source: "helm", orgId: null, phoneId, token, wabaId: "" };
}

// the studio of a quote (service role), or null
// deno-lint-ignore no-explicit-any
export async function orgOfQuote(admin: any, quoteId: string): Promise<string | null> {
  if (!UUID.test(String(quoteId || ""))) return null;
  try {
    const { data } = await admin.from("quotes").select("org_id").eq("id", quoteId).maybeSingle();
    return data && UUID.test(String(data.org_id || "")) ? String(data.org_id) : null;
  } catch (_) { return null; }
}
// the studio of an approval link (service role), or null
// deno-lint-ignore no-explicit-any
export async function orgOfApprovalToken(admin: any, token: string): Promise<string | null> {
  if (!UUID.test(String(token || ""))) return null;
  try {
    const { data } = await admin.from("quotes").select("org_id").eq("approval_token", token).is("deleted_at", null).limit(1).maybeSingle();
    return data && UUID.test(String(data.org_id || "")) ? String(data.org_id) : null;
  } catch (_) { return null; }
}
// the studio of a background row (comms_outbox / assign_notify_outbox / pkg_outbox), or null
// deno-lint-ignore no-explicit-any
export async function orgOfRow(admin: any, table: "comms_outbox" | "assign_notify_outbox" | "pkg_outbox", id: string): Promise<string | null> {
  if (!UUID.test(String(id || ""))) return null;
  try {
    const { data } = await admin.from(table).select("org_id").eq("id", id).maybeSingle();
    return data && UUID.test(String(data.org_id || "")) ? String(data.org_id) : null;
  } catch (_) { return null; }
}

export type WaResult = { ok: boolean; status: number; wamid: string | null; kind: string; text: string };
// POST one message from this sender. Only graph.facebook.com, never a redirect. A studio token Meta refuses -> "error".
// deno-lint-ignore no-explicit-any
export async function waPost(admin: any, sender: WaSender, payload: Record<string, unknown>): Promise<WaResult> {
  const url = `https://graph.facebook.com/${graphVersion(env)}/${encodeURIComponent(sender.phoneId)}/messages`;
  let r: Response, raw: string;
  try {
    r = await fetchWithTimeout(url, {
      method: "POST", redirect: "error",
      headers: { "Authorization": "Bearer " + sender.token, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    raw = await r.text();   // R142: inside the deadline - a stalled answer is the same "could not reach" failure
  } catch (e) {
    log.error("network", errTag(e));
    return { ok: false, status: 0, wamid: null, kind: "other", text: "could not reach WhatsApp" };
  }
  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try { body = JSON.parse(raw); } catch (_) { body = null; }
  if (r.ok) return { ok: true, status: r.status, wamid: body?.messages?.[0]?.id ?? null, kind: "", text: "" };
  const g = graphError(r.status, body);
  log.error("meta refused", r.status, { kind: g.kind, source: sender.source });
  if (sender.source === "studio" && sender.orgId && (g.kind === "token" || g.kind === "permission")) {
    try {
      await admin.rpc("mark_org_integration", { p_org: sender.orgId, p_kind: "whatsapp", p_status: "error", p_error: g.text });
    } catch (e) { log.error("mark failed", errTag(e)); }
  }
  return { ok: false, status: r.status, wamid: null, kind: g.kind, text: g.text };
}

export const NOT_CONNECTED_MSG = "Your studio's WhatsApp number isn't connected yet. Connect it on the Integrations page, or send the link by e-mail.";

// Wave 15 — ONE canonical synthetic lifecycle, threaded through the real app.
// A single quote row IS the event in Helm (every downstream table FKs to quotes.id),
// so the canonical id we thread is quoteId. service_role is used ONLY for node-side
// bootstrap + assertions and is NEVER passed to the browser.
import { STAGING_URL, STAGING_ANON, SERVICE_ROLE, emailFor, PASSWORD } from './env.mjs';
import { signIn } from './fixtures.mjs';

const anonH = (tok) => ({ apikey: STAGING_ANON, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' });
const svcH = () => ({ apikey: SERVICE_ROLE, Authorization: 'Bearer ' + SERVICE_ROLE, 'Content-Type': 'application/json' });
const jj = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

export function newRunId() {
  return 'W15-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// RPC as an authenticated role. A PostgREST error (any non-2xx: a denied role, a gate such as the close gate,
// a missing function or a bad argument) THROWS with the server's code/message - it is never handed back as a
// "result", so a refused step can not silently pass. Callers that probe an expected denial catch it themselves.
export async function rpcAs(role, fn, args) {
  const tok = await signIn(role);
  if (!tok) throw new Error(`rpcAs(${role}, ${fn}): sign-in returned no access token`);
  const r = await fetch(STAGING_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: anonH(tok), body: JSON.stringify(args),
  });
  const body = await jj(r);
  if (!r.ok) {
    const b = body && typeof body === 'object' ? body : { message: String(body) };
    const e = new Error(`rpcAs(${role}, ${fn}) failed: HTTP ${r.status} ${b.code || ''} ${b.message || ''}`.trim()
      + (b.details ? ' | ' + b.details : '') + (b.hint ? ' | hint: ' + b.hint : ''));
    e.status = r.status; e.code = b.code; e.body = b;
    throw e;
  }
  return body;
}

// PATCH a table row as an authenticated role, exactly like store-api.js updateMeta does (column-level UPDATE grant,
// RLS applies). Throws on a PostgREST error AND on a 0-row result (fail closed, as updateMeta does: a refused write
// must never look like a save). Returns the updated row.
export async function patchAs(role, path, patch) {
  const tok = await signIn(role);
  if (!tok) throw new Error(`patchAs(${role}, ${path}): sign-in returned no access token`);
  const r = await fetch(STAGING_URL + '/rest/v1/' + path, {
    method: 'PATCH', headers: { ...anonH(tok), Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  const body = await jj(r);
  if (!r.ok) throw new Error(`patchAs(${role}, ${path}) failed: HTTP ${r.status} ${JSON.stringify(body)}`);
  if (!Array.isArray(body) || body.length === 0) throw new Error(`patchAs(${role}, ${path}): 0 rows updated (refused by RLS/grants)`);
  return body[0];
}

// Read server truth with service_role (assertions only).
export async function svcGet(path) {
  return jj(await fetch(STAGING_URL + '/rest/v1/' + path, { headers: svcH() }));
}

// Create the ONE canonical lead → quote for the run, as the correct CRM role (sales can create leads/quotes).
// Returns { runId, leadId, quoteId, phone }. The lead is converted server-side via convert_lead_to_quote.
export async function bootstrapCanonicalLead(runId) {
  const tok = await signIn('sales');
  // valid 10-digit Indian mobile (+91, lead digit 9) - the approve page phone widget and the
  // server's phone-on-file check both expect a real-shaped number.
  const phone = '+91' + (9000000000 + Math.floor(Math.random() * 999999999));
  // leads RLS requires org_id = current_org_id() (and owner); fetch the caller's profile.
  const prof = (await jj(await fetch(STAGING_URL + '/rest/v1/profiles?select=id,org_id', { headers: anonH(tok) })))[0];
  const lead = (await jj(await fetch(STAGING_URL + '/rest/v1/leads', {
    method: 'POST', headers: { ...anonH(tok), Prefer: 'return=representation' },
    body: JSON.stringify({ name: runId + ' Client', phone, source: 'e2e', event_type: 'wedding', status: 'new', org_id: prof?.org_id, owner: prof?.id }),
  })))[0];
  if (!lead || !lead.id) throw new Error('lead bootstrap failed: ' + JSON.stringify(lead));
  const conv = await rpcAs('sales', 'convert_lead_to_quote', { p_lead_id: lead.id });
  // convert_lead_to_quote returns the new quote id (uuid) or a row; normalize.
  const quoteId = typeof conv === 'string' ? conv : (conv && (conv.id || conv.quote_id || conv[0]?.id));
  return { runId, leadId: lead.id, quoteId, phone };
}

// Assert every major record belongs to the same org + same canonical quote (continuity audit).
export async function continuityChain(quoteId) {
  const [quote] = await svcGet(`quotes?id=eq.${quoteId}&select=id,org_id,status,lifecycle_stage`);
  const org = quote?.org_id;
  const counts = {};
  for (const tbl of ['event_discovery', 'quotation_versions', 'event_plan', 'event_tasks', 'quote_payments', 'event_closure']) {
    const rows = await svcGet(`${tbl}?quote_id=eq.${quoteId}&select=quote_id,org_id`);
    counts[tbl] = Array.isArray(rows) ? rows.length : 0;
    // any row that exists must share the canonical org
    if (Array.isArray(rows)) for (const r of rows) if (r.org_id && org && r.org_id !== org) counts[tbl] = -1; // -1 flags cross-org leak
  }
  return { org, quote, counts };
}

export const CREDS = { PASSWORD, emailFor };

// R242 (0410, PART-C JOB-03 / INT-02 for the other mailers): never send a message twice because its "mark as sent" failed.
// The same rule comms-dispatch uses since R236 (0402), shared by welcome-mailer (+ its send.ts used by comms-dispatch),
// invite-mailer, security-alert-mailer, pkg-client-notify and billing-reminder:
//   * a "sent" mark is retried (every *_mark / the billing update only changes a row that is not marked yet, so a repeat is
//     harmless); a "retry" / "skipped" mark is tried once, as before;
//   * if the "sent" mark still fails, the row is noted in ops_send_ledger (lane + row id + provider id - never an address
//     or text) and the next run - when the lease hands the row out again - marks it sent WITHOUT sending it again.
// A database without 0410 refuses the new lane names (the note answers false): the mailer then behaves as before 0410.
// <NAME>_MARK_RETRY_MS / COMMS_MARK_RETRY_MS (tests): the waits before each try, e.g. "0,0,0".
const UUIDISH = /^[0-9a-f-]{36}$/i;
export const LEDGER_LANES = ["welcome", "invite", "security", "pkg", "billing"] as const;
export type LedgerLane = typeof LEDGER_LANES[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function markWaits(v: string | undefined): number[] {
  const s = String(v ?? "").trim();
  return /^[0-9]{1,4}(,[0-9]{1,4}){0,4}$/.test(s) ? s.split(",").map(Number) : [0, 400, 1500];
}
// deno-lint-ignore no-explicit-any
export async function markWithRetry(call: () => PromiseLike<{ error: any }>, sent: boolean, waits: number[]): Promise<any> {
  // deno-lint-ignore no-explicit-any
  let err: any = null;
  for (const w of sent ? waits : [0]) {
    if (w) await sleep(w);
    try { const { error } = await call(); if (!error) return null; err = error; } catch (e) { err = e; }
  }
  return err;
}
// the ids of this lane already accepted by the provider whose mark failed earlier (empty on any problem)
// deno-lint-ignore no-explicit-any
export async function ledgerOpenIds(admin: any, lane: LedgerLane): Promise<Set<string>> {
  try {
    const { data, error } = await admin.rpc("ops_send_ledger_open");
    if (error || !Array.isArray(data)) return new Set();
    // deno-lint-ignore no-explicit-any
    return new Set(data.filter((x: any) => x && String(x.lane ?? "") === lane && UUIDISH.test(String(x.id ?? ""))).map((x: any) => String(x.id)));
  } catch (_) { return new Set(); }
}
// deno-lint-ignore no-explicit-any
export async function ledgerNote(admin: any, lane: LedgerLane, id: string, ref: string | null, waits: number[]): Promise<boolean> {
  for (const w of waits) {
    if (w) await sleep(w);
    try { const { data, error } = await admin.rpc("ops_send_ledger_note", { p_lane: lane, p_id: id, p_ref: ref }); if (!error && data !== false) return true; } catch (_) { /* next try */ }
  }
  return false;
}
// one helper per run: already(id) = sent before, only the mark was missing; mark(...) = mark with retry + ledger note
// deno-lint-ignore no-explicit-any
export async function sendLedger(admin: any, lane: LedgerLane, waitsEnv: string | undefined) {
  const waits = markWaits(waitsEnv);
  const before = await ledgerOpenIds(admin, lane);
  return {
    already: (id: string) => before.has(id),
    // deno-lint-ignore no-explicit-any
    mark: async (id: string, sent: boolean, call: () => PromiseLike<{ error: any }>, ref: string | null = null): Promise<{ error: any; noted: boolean }> => {
      const error = await markWithRetry(call, sent, waits);
      const noted = !!error && sent ? await ledgerNote(admin, lane, id, ref, waits) : false;
      return { error, noted };
    },
  };
}

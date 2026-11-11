// _shared/http.ts - R142: deadlines for every outbound call an edge function makes (Meta Graph, Razorpay, Resend,
// MSG91, Turnstile, OpenAI, Storage, an antivirus scanner). Before, a provider that accepted the connection and then
// never answered held the request - or a whole cron batch - open until the platform killed the worker, with rows left
// half done. Now each call gives up after `ms` (default 10 s) and rejects with a DOMException named "TimeoutError",
// which every caller handles exactly like the provider failing (row -> retry / failed, request -> the usual
// "try again" answer). Nothing about the provider, the request or the recipient is added to the error.
//
//   fetchWithTimeout(url, init?, ms?)   fetch with a deadline that covers connect, headers AND reading the body.
//                                       A signal the caller passes in still works (whichever fires first wins).
//   isTimeout(e)                        true for the error a passed deadline produces
//   withDeadline(promise, ms, onLate?)  the same deadline for anything that is not a fetch (SMTP connect / TLS);
//                                       onLate(value) gets a result that arrives after the deadline (e.g. to close a
//                                       connection that opened too late), so nothing is leaked.
// The global fetch is looked up at CALL time (the edge test harness replaces it).

export const DEFAULT_TIMEOUT_MS = 10_000;

const msOf = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS);

// a signal that aborts after `ms`, or when `other` (the caller's own signal) aborts - whichever is first
export function timeoutSignal(ms: number, other?: AbortSignal | null): AbortSignal {
  const t = AbortSignal.timeout(msOf(ms));
  if (!other) return t;
  // deno-lint-ignore no-explicit-any
  const any = (AbortSignal as any).any;
  if (typeof any === "function") return any([other, t]);
  const c = new AbortController();
  const follow = (s: AbortSignal) => { if (s.aborted) c.abort(s.reason); else s.addEventListener("abort", () => c.abort(s.reason), { once: true }); };
  follow(other); follow(t);
  return c.signal;
}

export function fetchWithTimeout(url: string | URL, init: RequestInit = {}, ms: number = DEFAULT_TIMEOUT_MS): Promise<Response> {
  return globalThis.fetch(url, { ...init, signal: timeoutSignal(ms, init.signal) });
}

export function isTimeout(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "TimeoutError";
}

export function withDeadline<T>(p: Promise<T>, ms: number, onLate?: (v: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { late = true; reject(new DOMException("the server did not answer in time", "TimeoutError")); }, msOf(ms));
  });
  return Promise.race([p, deadline]).finally(() => {
    clearTimeout(timer);
    // the slow operation still settles later: close what it opened, swallow what it throws
    if (late) p.then((v) => { try { onLate?.(v); } catch (_) { /* ignore */ } }, () => { /* ignore */ });
  });
}

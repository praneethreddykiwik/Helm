// _shared/log.ts - R142: one JSON line per log event from the edge functions, so the Supabase log explorer can filter
// by level / function / code and follow one request through its lines:
//   {"level":"error","fn":"comms-dispatch","msg":"mark failed","code":"PGRST202","req":"0b6c3f0e-...","lane":"trial"}
//   level  info (console.log) | warn (console.warn) | error (console.error)
//   fn     the function's name
//   msg    a FIXED description written in the code (never data)
//   code   errTag(e) (SQLSTATE / error name), an HTTP status or a short provider kind
//   req    the platform's request id (sb-request-id, else x-request-id) when the request has a well-formed one
//   extra  counts, flags and short fixed tags only
// PRIVACY (same rule as errTag in cors.ts): never pass a token, phone number, e-mail address, name, amount, body or a
// provider's message. Defence in depth: a code or extra value that does not look like a short tag or a small number
// (it contains "@", "/", quotes, a long run of digits, a long hex run, or is too long) is printed as "?".
// No imports and no state - usable from any function and from _shared/cors.ts.

type Level = "info" | "warn" | "error";
export type LogExtra = Record<string, string | number | boolean | null | undefined>;

const CODE = /^[A-Za-z0-9_.:-]{1,48}$/;
const TEXT = /^[A-Za-z0-9 _.,:;()+-]{1,80}$/;
const REQ_ID = /^[A-Za-z0-9_.:-]{8,128}$/;
const KEY = /^[a-z][a-z0-9_]{0,23}$/;
// a phone number (7+ digits in a row) or a token / id (12+ hex characters in a row) is never printed
const looksPrivate = (s: string) => /[0-9]{7,}/.test(s) || /[0-9a-f]{12,}/i.test(s);

function safeValue(v: unknown, re: RegExp): string | number | boolean | null {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) < 1e9 ? v : "?";
  const s = String(v ?? "");
  return re.test(s) && !looksPrivate(s) ? s : "?";
}

// the incoming request's id (for following one request through its log lines), or undefined
export function requestId(req?: Request | null): string | undefined {
  try {
    const v = (req?.headers.get("sb-request-id") || req?.headers.get("x-request-id") || "").trim();
    return REQ_ID.test(v) ? v : undefined;
  } catch (_) { return undefined; }
}

// one log line as a string (exported for tests)
export function logLine(level: Level, fn: string, msg: string, code?: unknown, extra?: LogExtra, req?: string): string {
  const o: Record<string, unknown> = { level, fn: CODE.test(fn) ? fn : "unknown", msg: String(msg || "").replace(/[\r\n]+/g, " ").slice(0, 160) };
  if (code !== undefined && code !== null && code !== "") o.code = safeValue(code, CODE);
  if (req) o.req = req;
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || !KEY.test(k) || k in o) continue;
    o[k] = safeValue(v, TEXT);
  }
  return JSON.stringify(o);
}

export type Logger = {
  info: (msg: string, extra?: LogExtra) => void;
  warn: (msg: string, code?: unknown, extra?: LogExtra) => void;
  error: (msg: string, code?: unknown, extra?: LogExtra) => void;
};

// logger("comms-dispatch")        module-level helpers (no request at hand)
// logger("comms-dispatch", req)   inside the handler: every line carries the request id
export function logger(fn: string, req?: Request | null): Logger {
  const rid = requestId(req);
  return {
    info: (msg, extra) => console.log(logLine("info", fn, msg, undefined, extra, rid)),
    warn: (msg, code, extra) => console.warn(logLine("warn", fn, msg, code, extra, rid)),
    error: (msg, code, extra) => console.error(logLine("error", fn, msg, code, extra, rid)),
  };
}

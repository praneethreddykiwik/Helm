// plain-date.mjs - R243 (P11 LOC-04): one date style for every studio country in server-sent messages.
// "20/10/2026" reads as 20 October in India / UAE but as nonsense (month 20) or the wrong day (05/10) in the USA,
// so a message never shows a bare dd/mm/yyyy: it shows "20 Oct 2026" (the same style the staff e-mails already
// use), which reads the same everywhere. A trailing time is kept: "20/10/2026, 09:30 AM" -> "20 Oct 2026, 09:30 AM".
// ISO "2026-10-20" is read too. Anything else comes back unchanged (never throws, never guesses).
// Pure - shared by comms-dispatch (Deno) and the node tests.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function plainDate(s) {
  const v = String(s == null ? "" : s);
  let m = /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})(,? .*)?$/.exec(v), d, mo, y, rest;
  if (m) { d = +m[1]; mo = +m[2]; y = m[3]; rest = m[4] || ""; }
  else {
    m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(v);
    if (!m) return v;
    y = m[1]; mo = +m[2]; d = +m[3]; rest = "";
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return v;
  return d + " " + MON[mo - 1] + " " + y + rest;
}

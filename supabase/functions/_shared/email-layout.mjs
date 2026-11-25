// Shared Helm e-mail layout (2026-10 redesign). Plain JS so both the Deno edge functions and the
// Node generator (scripts/gen-email-templates.mjs, which writes the Supabase Auth templates) use the
// SAME markup. Table-based, inline styles, 600px, preheader, hosted logo PNG (no tracking pixels, no
// other images), footer "Helm Events · helm.events". Callers must pass ALREADY-ESCAPED HTML into the
// block helpers.
// R207 (owner decision): LIGHT-ONLY. Outlook showed the reset e-mail as a dark card because of the old
// dark-mode overrides (a dark media query, Outlook.com dark selectors, color-scheme "light dark"). Now:
// color-scheme "light only", no dark rules at all, every background is also a bgcolor attribute, a
// soft light-green header band, and the button is light green with DARK text (never white text on a
// colour, so a client that still force-inverts keeps it readable). WCAG AA contrast is checked in
// test/r207-email-light.test.mjs (button text ~7:1, link green ~5:1 on white, footer ~5:1 on the page).

import { DEFAULT_POSTAL_ADDRESS } from "./email-compliance.mjs";

export const SITE = "https://www.helm.events";
// r19: current compass-H app tile (public/brand/helm-email-emerald.svg rendered to an 80x80 PNG = 2x the
// 40px display size). The file NAME is versioned on purpose: /*.png is served "immutable" for a year and
// Gmail/Outlook image proxies cache by URL, so overwriting helm-logo.png in place kept showing the old
// two-pill mark. Never overwrite an e-mail image in place - add a new file name and point LOGO_URL at it
// (keep the old file for old mail).
export const LOGO_URL = "https://www.helm.events/email/helm-logo-v3.png";
export const LOGO_ALT = "Helm Events";
export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
// R207 light palette. brand = the green used for TEXT (links, chips, eyebrow) - AA on white and on
// brandSoft. accent = the light-green button fill; text on it is btnInk (never white). band = header band.
export const C = {
  bg: "#f2f8f4", card: "#ffffff", ink: "#101511", body: "#3d4540", muted: "#66706a",
  faint: "#626c66", rule: "#dcebe2", brand: "#0b7a4b", brandSoft: "#e8f5ee",
  accent: "#34d399", accentEdge: "#10b981", btnInk: "#052e1c", band: "#e8f5ee", bandRule: "#c9e9d6",
};

export const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const h1 = (t) =>
  `<tr><td class="ink" style="padding:0 0 12px;font-family:${FONT};font-size:24px;line-height:31px;font-weight:700;letter-spacing:-.01em;color:${C.ink};">${t}</td></tr>`;
export const para = (t, pad = "0 0 20px") =>
  `<tr><td class="body" style="padding:${pad};font-family:${FONT};font-size:15px;line-height:24px;color:${C.body};">${t}</td></tr>`;
export const strong = (t) => `<strong class="ink" style="color:${C.ink};font-weight:600;">${t}</strong>`;
export const note = (t) =>
  `<tr><td class="rule muted" style="border-top:1px solid ${C.rule};padding:18px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">${t}</td></tr>`;
export const link = (href, label) => `<a href="${href}" class="lnk" style="color:${C.brand};text-decoration:underline;">${label}</a>`;

/** big primary button; href/label must already be escaped (or be a Supabase {{ }} variable) */
export function button(href, label) {
  // 0205 bulletproof button: Outlook desktop (Word engine) gets the VML roundrect; every other client
  // (Outlook web / new Outlook, Gmail, Apple Mail) gets a table cell + a real <a href> with inline
  // styles - no <!--[if !mso]> wrapper that some webmail sanitisers drop. The plain URL line
  // (fallback()) always follows, so the link works even when buttons are stripped.
  // R207: light-green fill + dark text (stays readable when a client inverts colours).
  return `<tr><td align="left" style="padding:4px 0 24px;">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:280px;" arcsize="22%" fillcolor="${C.accent}" strokecolor="${C.accentEdge}" strokeweight="1px"><w:anchorlock/><center style="color:${C.btnInk};font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;mso-hide:all;"><tr><td align="center" bgcolor="${C.accent}" style="background:${C.accent};border-radius:10px;mso-hide:all;"><a href="${href}" target="_blank" rel="noopener" class="btn" style="display:inline-block;background:${C.accent};color:${C.btnInk};font-family:${FONT};font-size:16px;font-weight:700;line-height:20px;padding:14px 30px;border:1px solid ${C.accentEdge};border-radius:10px;text-decoration:none;mso-hide:all;">${label}</a></td></tr></table>
</td></tr>`;
}

/** "Button not working?" fallback line with the raw URL */
export const fallback = (href) =>
  `<tr><td class="muted" style="padding:0 0 20px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};word-break:break-all;">Button not working? Copy and paste this link into your browser:<br><a href="${href}" class="lnk" style="color:${C.brand};">${href}</a></td></tr>`;

/** one-time code panel */
export const codeBox = (code) =>
  `<tr><td style="padding:4px 0 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="codebox" bgcolor="${C.brandSoft}" style="background:${C.brandSoft};border:1px solid ${C.bandRule};border-radius:12px;padding:16px 28px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:30px;line-height:36px;font-weight:700;letter-spacing:8px;color:${C.ink};">${code}</td></tr></table></td></tr>`;

/** label / value rows (values already escaped). R255 (owner): "Label:" always - a label that ends with its own sign keeps it */
const factLabel = (k) => { const t = String(k == null ? "" : k).trim(); return !t || /[:?!.]$/.test(t) ? t : t + ":"; };
export const facts = (rows) =>
  `<tr><td style="padding:0 0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rule" style="border:1px solid ${C.rule};border-radius:12px;">${rows.map(([k, v], i) =>
    `<tr><td class="muted${i ? " rule" : ""}" style="padding:12px 16px;${i ? `border-top:1px solid ${C.rule};` : ""}font-family:${FONT};font-size:14px;line-height:20px;color:${C.muted};">${factLabel(k)}</td><td align="right" class="ink${i ? " rule" : ""}" style="padding:12px 16px;${i ? `border-top:1px solid ${C.rule};` : ""}font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${C.ink};">${v}</td></tr>`).join("")}</table></td></tr>`;

/**
 * Full document. title + preheader are plain text (escaped here); inner is a set of <tr> rows.
 * opts.site: link target for the footer (default SITE). opts.sub: optional footer second line (escaped).
 */
export function layout(title, preheader, inner, opts = {}) {
  const site = opts.site || SITE;
  const sub = opts.sub == null ? "Run every event, end to end." : String(opts.sub);
  // opts.reason: compliance line (email-compliance.mjs) - "You received this because ..." + Privacy + postal address.
  const comp = opts.reason ? `<br>You received this because ${escHtml(opts.reason)}. &middot; <a href="${site}/privacy" class="muted" style="color:${C.faint};text-decoration:underline;">Privacy</a> &middot; Helm Events, ${escHtml(opts.address || DEFAULT_POSTAL_ADDRESS)}` : "";
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escHtml(title)}</title>
<style>
  :root{color-scheme:light only;supported-color-schemes:light;}
  @media (max-width:620px){ .container{width:100%!important} .px{padding-left:22px!important;padding-right:22px!important} .btn{display:block!important;text-align:center!important} }
</style>
</head>
<body class="bg" bgcolor="${C.bg}" style="margin:0;padding:0;background:${C.bg};color-scheme:light only;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">${escHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" bgcolor="${C.bg}" style="background:${C.bg};">
<tr><td align="center" bgcolor="${C.bg}" style="padding:32px 12px;background:${C.bg};">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="container" style="width:600px;max-width:600px;">
<tr><td class="card" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.rule};border-radius:18px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="band px" bgcolor="${C.band}" align="left" style="background:${C.band};border-bottom:1px solid ${C.bandRule};border-radius:17px 17px 0 0;padding:20px 44px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="40" height="40" valign="middle" style="width:40px;height:40px;"><a href="${site}" style="text-decoration:none;"><img src="${LOGO_URL}" width="40" height="40" alt="${LOGO_ALT}" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;border-radius:8px;"></a></td>
    <td class="ink" valign="middle" style="padding-left:12px;font-family:${FONT};font-size:20px;line-height:24px;font-weight:700;letter-spacing:-.02em;color:${C.ink};">Helm <span style="font-weight:500;color:${C.brand};">Events</span></td>
  </tr></table>
</td></tr>
<tr><td class="px" bgcolor="${C.card}" style="background:${C.card};border-radius:0 0 17px 17px;padding:36px 44px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${inner}
</table>
</td></tr>
</table>
</td></tr>
<tr><td align="center" class="muted" style="padding:22px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};">
Helm Events &middot; <a href="${site}" class="muted" style="color:${C.faint};text-decoration:underline;">helm.events</a>${sub ? `<br>${escHtml(sub)}` : ""}${comp}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** plain-text footer appended to every text alternative */
export const TEXT_FOOTER = "\n--\nHelm Events · helm.events";

/* country-profile.js - window.HelmCountry (0089 country tax).
 * One table per target country (India, UAE, USA) that every page reads for currency,
 * number format, tax name/ID label/format, default rate, regions, phone code, date
 * format, invoice title and how the tax line is split. Pure data + pure functions:
 * no DOM, no network, no storage. A studio with no country is India, exactly as before.
 *
 * Money rule (unchanged, D8): ONE effective rate per quote (pricing.gstPct). The server
 * (helm_quote_total) prices with that rate; this file only decides the DEFAULT rate
 * (country / US state / studio override) and how the tax amount is LABELLED and SPLIT.
 * A tax-exempt client (pricing.taxExempt) prices at 0% on both sides (0089).
 *
 * Rates researched Oct 2026 - see 0089_country_tax.sql header for sources. US state
 * rates are the STATE base rate only (no county/city add-ons); service taxability for
 * events varies by state, so the studio can always override the rate.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HelmCountry = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  "use strict";

  var IN_STATES = ["Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh",
    "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand",
    "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha",
    "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"];
  var AE_EMIRATES = ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"];
  // US: [code, name, state base sales-tax rate %] (Tax Foundation, 2026; no local add-ons)
  var US_STATES = [["AL", "Alabama", 4], ["AK", "Alaska", 0], ["AZ", "Arizona", 5.6], ["AR", "Arkansas", 6.5], ["CA", "California", 7.25],
    ["CO", "Colorado", 2.9], ["CT", "Connecticut", 6.35], ["DE", "Delaware", 0], ["DC", "District of Columbia", 6], ["FL", "Florida", 6],
    ["GA", "Georgia", 4], ["HI", "Hawaii", 4], ["ID", "Idaho", 6], ["IL", "Illinois", 6.25], ["IN", "Indiana", 7], ["IA", "Iowa", 6],
    ["KS", "Kansas", 6.5], ["KY", "Kentucky", 6], ["LA", "Louisiana", 5], ["ME", "Maine", 5.5], ["MD", "Maryland", 6],
    ["MA", "Massachusetts", 6.25], ["MI", "Michigan", 6], ["MN", "Minnesota", 6.875], ["MS", "Mississippi", 7], ["MO", "Missouri", 4.225],
    ["MT", "Montana", 0], ["NE", "Nebraska", 5.5], ["NV", "Nevada", 6.85], ["NH", "New Hampshire", 0], ["NJ", "New Jersey", 6.625],
    ["NM", "New Mexico", 4.875], ["NY", "New York", 4], ["NC", "North Carolina", 4.75], ["ND", "North Dakota", 5], ["OH", "Ohio", 5.75],
    ["OK", "Oklahoma", 4.5], ["OR", "Oregon", 0], ["PA", "Pennsylvania", 6], ["RI", "Rhode Island", 7], ["SC", "South Carolina", 6],
    ["SD", "South Dakota", 4.2], ["TN", "Tennessee", 7], ["TX", "Texas", 6.25], ["UT", "Utah", 6.1], ["VT", "Vermont", 6],
    ["VA", "Virginia", 5.3], ["WA", "Washington", 6.5], ["WV", "West Virginia", 6], ["WI", "Wisconsin", 5], ["WY", "Wyoming", 4]];

  var P = {
    IN: { code: "IN", name: "India", currency: "INR", symbol: "₹", locale: "en-IN", taxName: "GST", taxIdLabel: "GSTIN",
      taxIdRegex: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, taxIdExample: "36ABCDE1234F1Z5", taxIdRequired: false,
      defaultRate: 18, sac: "998596", regionLabel: "State", regions: IN_STATES.map(function (n) { return { code: n, name: n }; }),
      postalLabel: "PIN code", postalRegex: /^[1-9][0-9]{5}$/, phoneCode: "+91", dateFormat: "DD/MM/YYYY",
      invoiceTitle: "Tax Invoice", splitRules: "in-gst" },
    AE: { code: "AE", name: "United Arab Emirates", currency: "AED", symbol: "AED ", locale: "en-AE", taxName: "VAT", taxIdLabel: "TRN",
      taxIdRegex: /^[0-9]{15}$/, taxIdExample: "100123456700003", taxIdRequired: false, defaultRate: 5, sac: "",
      regionLabel: "Emirate", regions: AE_EMIRATES.map(function (n) { return { code: n, name: n }; }),
      postalLabel: "P.O. box", postalRegex: /^[0-9]{0,6}$/, phoneCode: "+971", dateFormat: "DD/MM/YYYY",
      invoiceTitle: "Tax Invoice", splitRules: "single" },
    US: { code: "US", name: "United States", currency: "USD", symbol: "$", locale: "en-US", taxName: "Sales tax", taxIdLabel: "EIN",
      taxIdRegex: /^[0-9]{2}-?[0-9]{7}$/, taxIdExample: "12-3456789", taxIdRequired: false, defaultRate: 0, sac: "",
      regionLabel: "State", regions: US_STATES.map(function (s) { return { code: s[0], name: s[1], rate: s[2] }; }),
      postalLabel: "ZIP code", postalRegex: /^[0-9]{5}(-[0-9]{4})?$/, phoneCode: "+1", dateFormat: "MM/DD/YYYY",
      invoiceTitle: "Invoice", splitRules: "single" },
  };
  var DEFAULT = "IN";

  function code(cc) { cc = String(cc || "").trim().toUpperCase(); return P[cc] ? cc : DEFAULT; }
  function clone(p) { var o = {}; for (var k in p) o[k] = p[k]; o.regions = p.regions.map(function (r) { var x = {}; for (var j in r) x[j] = r[j]; return x; }); return o; }
  function get(cc) { return clone(P[code(cc)]); }
  function list() { return Object.keys(P).map(function (k) { return { code: k, name: P[k].name }; }); }
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z]/g, ""); }
  function findRegion(cc, region) {
    var p = P[code(cc)], n = norm(region); if (!n) return null;
    for (var i = 0; i < p.regions.length; i++) { var r = p.regions[i]; if (norm(r.code) === n || norm(r.name) === n) return r; }
    return null;
  }
  function validRate(v) { var r = Number(v); return v !== null && v !== "" && v !== undefined && isFinite(r) && r >= 0 && r <= 100 ? r : null; }
  // studio default rate: explicit override > US state base rate > country default
  function defaultRate(cc, region, override) {
    var o = validRate(override); if (o != null) return o;
    cc = code(cc);
    if (cc === "US") { var r = findRegion(cc, region); return r ? r.rate : 0; }
    return P[cc].defaultRate;
  }
  function validateTaxId(cc, raw) {
    var p = P[code(cc)], v = String(raw == null ? "" : raw).toUpperCase().replace(/\s+/g, "");
    if (!v) return { ok: !p.taxIdRequired, value: "" };
    if (v.length > 20 || !p.taxIdRegex.test(v)) return { ok: false, value: v, error: "Enter a valid " + p.taxIdLabel + ", e.g. " + p.taxIdExample + " (or leave it blank)." };
    return { ok: true, value: v };
  }
  function validatePostal(cc, raw) { var v = String(raw || "").trim(); return !v || P[code(cc)].postalRegex.test(v); }
  function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  // amount in the country's currency + digit grouping (en-IN -> 5,36,000; en-US -> 536,000)
  function formatMoney(n, cc, opts) {
    var p = P[code(cc)], x = Number(n); if (!isFinite(x)) x = 0;
    opts = opts || {}; var neg = x < 0; x = Math.abs(x);
    var dec = opts.decimals != null ? opts.decimals : (x % 1 ? 2 : 0), s;
    try { s = x.toLocaleString(p.locale, { minimumFractionDigits: dec, maximumFractionDigits: dec }); } catch (e) { s = x.toFixed(dec); }
    return (neg ? "− " : "") + p.symbol + s;
  }
  // India place of supply: same state -> intra (CGST+SGST); different -> inter (IGST)
  function placeOfSupply(studioRegion, clientRegion) { var a = norm(studioRegion), b = norm(clientRegion); if (!a || !b) return null; return a === b ? "intra" : "inter"; }
  // Tax lines for a quote. taxable = post-discount value; opts: {rate, inclusive, exempt, placeOfSupply, region}
  // Returns {rate, tax, total, lines:[{label, pct, amount}]}. total is rounded to whole units
  // (D7, same as the server); line amounts are rounded to 2 decimals for display.
  function computeTax(cc, taxable, opts) {
    var p = P[code(cc)]; opts = opts || {};
    var base = Math.max(0, Number(taxable) || 0);
    var rate = opts.exempt ? 0 : (validRate(opts.rate) != null ? validRate(opts.rate) : defaultRate(p.code, opts.region));
    var inc = !!opts.inclusive;
    var tax = inc ? base - base / (1 + rate / 100) : base * rate / 100;
    var total = Math.round(inc ? base : base + tax);
    var sfx = inc ? " (included)" : "", lines;
    if (opts.exempt) lines = [{ label: p.taxName + " (exempt)", pct: 0, amount: 0 }];
    else if (p.splitRules === "in-gst") {
      lines = opts.placeOfSupply === "inter" ? [{ label: "IGST" + sfx, pct: rate, amount: round2(tax) }]
        : [{ label: "CGST" + sfx, pct: rate / 2, amount: round2(tax / 2) }, { label: "SGST" + sfx, pct: rate / 2, amount: round2(tax / 2) }];
    } else {
      var lbl = p.code === "US" && opts.region ? p.taxName + " (" + ((findRegion("US", opts.region) || {}).code || opts.region) + ")" : p.taxName;
      lines = [{ label: lbl + sfx, pct: rate, amount: round2(tax) }];
    }
    return { rate: rate, tax: round2(tax), total: total, lines: lines, currency: p.currency };
  }
  // immutable per-quote snapshot (stored in quotes.pricing + quotes.tax_snapshot)
  function snapshot(cc, opts) {
    var p = P[code(cc)]; opts = opts || {};
    return { country: p.code, currency: p.currency, taxName: p.taxName, region: opts.region || null,
      rate: opts.exempt ? 0 : defaultRate(p.code, opts.region, opts.rate), exempt: !!opts.exempt, inclusive: !!opts.inclusive,
      placeOfSupply: opts.placeOfSupply || null, invoiceTitle: p.invoiceTitle };
  }
  return { VERSION: "0089", DEFAULT: DEFAULT, get: get, list: list, code: code, findRegion: findRegion, defaultRate: defaultRate,
    validateTaxId: validateTaxId, validatePostal: validatePostal, formatMoney: formatMoney, placeOfSupply: placeOfSupply,
    computeTax: computeTax, snapshot: snapshot };
});

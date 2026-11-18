// r221-ui-fixes.test.mjs - R221 (audit 18 Nov 2026, owner's live look at a paid studio with "Hide amounts" ON):
//   1. Hide amounts: every amount the money pages DRAW sits in a [data-money] element (masked by shell-b-privacy.css
//      before any script runs, and always by shell-b-privacy.js), not only text the privacy scan happens to recognise.
//      A static scan of flow / event / settlement / closure / budget finds every money-formatter call that is drawn as
//      markup or set as textContent and fails on any that is not inside a [data-money] element. Plus: a page restored
//      from the back/forward cache re-reads the tab's hide/show state.
//   2. One quotation numbering: the event page names the quote by its saved quotation (Q1, Q2 ...) like the quote flow,
//      not by the floor-plan layout version ("Version v2").
//   3. Dashboard "Get set up": "Finish studio setup" is ticked from the studio's saved setup state, and the setup chip
//      counts the same steps the setup page counts.
//   4. Onboarding Menu dishes: Back from "Review before importing" keeps the veg / non-veg choices.
//   5. ui-pickers list: solid background + stacking above the page's buttons.
//   6. Onboarding: one name for the prices step ("Item prices") + a "Business details - saved" line on Finish.
// Static checks only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };

/* ---------------- 1. Hide amounts ---------------- */
// page -> the names of its money formatters (each returns "₹1,23,456" text)
const MONEY_PAGES = { 'flow.html': ['inr'], 'event.html': ['inr'], 'settlement.html': ['inr'], 'closure.html': ['inr', 'fmtMoney'], 'budget.html': ['inr'] };
// every un-masked rendering path: "<file>:<line> <why>"
function unmasked(file, fns, text) {
  const src = text != null ? text : read('public/' + file), lines = src.split('\n'), out = [];
  const moneyIds = new Set([...src.matchAll(/<[a-z][^<>]*\bid="([^"]+)"[^<>]*\bdata-money\b[^<>]*>/g)].map((m) => m[1]));
  const re = new RegExp('\\b(' + fns.join('|') + ')\\(', 'g');
  lines.forEach((ln, i) => {
    re.lastIndex = 0; let m;
    while ((m = re.exec(ln))) {
      const pre = ln.slice(0, m.index);
      if (/\b(const|let|var)\s+\w+\s*=\s*$/.test(pre) || /\bfunction\s+\w+\s*$/.test(pre)) continue;   // the formatter's own definition
      if (/=\s*"[^"]*$/.test(pre.replace(/"[^"]*"/g, (q) => q.includes('${') ? q : '""')) && /\$\{[^}]*$/.test(pre)) continue;   // inside an attribute value (data-amt, aria-label): never drawn as text
      const lt = Math.max(pre.lastIndexOf('<'), -1), open = lt >= 0 && /^<[a-zA-Z/]/.test(pre.slice(lt)) ? pre.slice(lt) : null;
      let why = null;
      if (open) {
        if (open.startsWith('</')) why = 'bare text after ' + open.slice(0, 12);
        else if (!/\bdata-money\b/.test(open)) why = 'inside ' + open.slice(0, 40) + ' without data-money';
      } else if (/`[^`]*$/.test(pre) && /<[a-z]/i.test(ln)) why = 'bare text in a markup template';
      else if (/\.textContent\s*=/.test(pre)) {
        const id = (pre.match(/\$\(\s*["']#([\w-]+)["']\s*\)\s*\.textContent\s*=[^;]*$/) || [])[1];
        const v = !id && (pre.match(/\b(\w+)\.textContent\s*=[^;]*$/) || [])[1];   // const mn=$("#t_mar") ... mn.textContent=
        const vid = v && (ln.match(new RegExp('\\b(?:const|let)\\s+' + v + '\\s*=\\s*\\$\\(\\s*["\']#([\\w-]+)')) || [])[1];
        if (vid && moneyIds.has(vid)) continue;
        if (!(id && moneyIds.has(id)) && !/data-money/.test(ln)) why = 'textContent' + (id ? ' of #' + id : '');
      }
      if (why) out.push(file + ':' + (i + 1) + ' ' + why);
    }
  });
  return out;
}
t('hide amounts: every amount drawn on flow / event / settlement / closure / budget sits in a [data-money] element', () => {
  const bad = Object.entries(MONEY_PAGES).flatMap(([f, fns]) => unmasked(f, fns));
  assert.deepEqual(bad, [], 'un-masked money rendering paths:\n  ' + bad.join('\n  '));
});
t('hide amounts: the scan itself catches the shapes it is meant to catch', () => {
  // self-check on synthetic lines so a broken scanner cannot pass silently
  const fake = ['  const inr=(n)=>x;', 'a=`<td class="num">${inr(1)}</td>`;', 'a=`<td class="num" data-money>${inr(1)}</td>`;', 'a=`<b>x</b> ${inr(2)}`;',
    '$("#zz").textContent=inr(3);', 'q=`<button data-amt="${esc(inr(4))}">`;', 'h.textContent="Paid "+inr(5);'];
  const got = unmasked('fake', ['inr'], fake.join('\n')).map((x) => +x.split(':')[1].split(' ')[0]);
  assert.deepEqual(got, [2, 4, 5, 7], 'flags: td without data-money, bare text after a tag, textContent of a plain #id, a mixed sentence');
});
t('hide amounts: the money pages share the same small helpers (putMoney / M$, mh)', () => {
  for (const f of ['flow.html', 'event.html', 'settlement.html', 'closure.html', 'budget.html']) {
    const s = read('public/' + f);
    assert.match(s, /const M\$=\(n\)=>\(\{__m:n\}\);/, f + ' M$');
    assert.match(s, /const putMoney=\(el,\.\.\.parts\)=>\{ el\.replaceChildren\(\.\.\.parts\.flat\(4\)\.map\(x=>\{ if\(x&&typeof x==="object"&&"__m" in x\)\{ const sp=document\.createElement\("span"\); sp\.setAttribute\("data-money",""\); sp\.textContent=inr\(x\.__m\);/, f + ' putMoney');
  }
});
t('hide amounts: flow step 10 - advance line, receipts and the payment schedule rows are [data-money]', () => {
  const F = read('public/flow.html'), PS = read('public/payment-schedule.js');
  assert.match(F, /putMoney\(h, `Advance \(\$\{pct\}%\) `, M\$\(amt\), " · Paid ", M\$\(PAID_SUM\), " · Remaining ", M\$\(rem\)/);
  assert.match(F, /" · Outstanding ", M\$\(sd\.outstanding\)\);/);
  assert.match(F, /<span data-money>\$\{inr\(p\.amount\)\}<\/span><span class="meta">/, 'RECEIPTS list');
  assert.match(PS, /function moneyEl\(tag, cls, n, cur\) \{ var e = el\(tag, cls, money\(n, cur\)\); e\.setAttribute\("data-money", ""\); return e; \}/);
  assert.match(PS, /tr\.appendChild\(moneyEl\("td", "num", r\.amount, d\.currency\)\);/, 'schedule rows');
});
t('hide amounts: event header TOTAL, Budget & margin card and the "Advance recorded" button are [data-money]', () => {
  const E = read('public/event.html');
  assert.match(E, /<div class="amt" id="total" data-money>—<\/div>/);
  assert.match(E, /`\$\{mh\(budgetSummary\.revenueExTax!=null\?budgetSummary\.revenueExTax:budgetSummary\.revenue\)\} rev \(ex-tax\)/);
  assert.match(E, /const advanceDoneParts=\(\)=>\{ const amt=paidAmount\(\); return canFin&&amt>0 \? \["Advance recorded ", M\$\(amt\), " — record another payment"\]/);
  assert.match(E, /if\(show\)\{ putMoney\(pb, advanceDoneParts\(\)\);/);
  assert.doesNotMatch(E, /advanceDoneLabel/);
});
t('hide amounts: client page + closure checklist already draw amounts as [data-money]', () => {
  assert.match(read('public/client.js'), /if \(p\.money\) \{ const sp = el\("span", "", p\.text\); sp\.setAttribute\("data-money", ""\);/);
  for (const k of ['t_quoted', 't_paid', 't_due']) assert.match(read('public/client.html'), new RegExp('<dd id="' + k + '" data-money>—</dd>'), k);
  assert.match(read('public/closure-checklist.js'), /function money\(node\) \{ node\.setAttribute\("data-money", ""\); return node; \}/);
});
t('hide amounts: a page restored from the back/forward cache re-reads the tab\'s hide/show state', () => {
  const P = read('public/shell-b-privacy.js');
  assert.match(P, /window\.addEventListener\("pageshow", function \(e\) \{\s*if \(!e \|\| !e\.persisted\) return;/);
  assert.match(P, /if \(ss\(SK\) !== "shown" && !hidden\(\)\) setHidden\(true\);/);
  assert.match(P, /else if \(hidden\(\)\) fullScan\(\);/);
});

/* ---------------- 2. one quotation numbering ---------------- */
t('versions: the event page names the quote by its saved quotation (Q1, Q2 ...), not "Version v<layout>"', () => {
  const E = read('public/event.html'), Q = read('public/quotes.html');
  assert.doesNotMatch(E, /Version v\$\{/);
  assert.match(E, /S\(async\(\)=>\{ const qv=BPStore\.quotationVersions\?await BPStore\.quotationVersions\.list\(id\):\[\]; qvLabel=\(Array\.isArray\(qv\)&&qv\[0\]&&qv\[0\]\.label\)\?String\(qv\[0\]\.label\):""; \}\),/);
  assert.match(E, /sum:`\$\{qvLabel\?"Quotation "\+esc\(qvLabel\):qvLabel===""\?"No quotation saved yet":"Quotation"\}/);
  assert.doesNotMatch(Q, /"Quote V"\+esc\(full\.currentVersion\)/, 'the downloaded quote header too');
  assert.match(Q, /\(qLabel\?"Quotation "\+esc\(qLabel\):"Quote"\)/);
  assert.match(read('public/store-api.js'), /const quotationVersions = \{\s*async list\(quoteId\) \{[\s\S]{0,300}?order\("created_at", \{ ascending: false \}\)/, 'newest first, so [0] is the current Q');
});

/* ---------------- 3. dashboard "Get set up" ---------------- */
t('get set up: "Finish studio setup" + "Invite your team" tick from the saved state, and re-paint when it arrives', () => {
  const D = read('public/shell-b-dash.js'), W = read('public/onboarding-wizard.js'), G = read('public/getting-started.js');
  assert.doesNotMatch(D, /t: "Finish studio setup", s: "Brand, packages and preferences\.", done: false/);
  assert.match(D, /t: "Finish studio setup", s: "Brand, packages and preferences\.", live: onbDone,/);
  assert.match(D, /t: "Invite your team", s: "Give planners and crew their own access\.", live: function \(\) \{ return gsDone\("team"\); \}/);
  assert.match(D, /document\.addEventListener\("helm:onb-state", paint\); document\.addEventListener\("helm:gs-model", paint\);/);
  assert.match(D, /pill\.textContent = steps\.filter\(function \(x\) \{ return x\.done; \}\)\.length \+ " of " \+ steps\.length \+ " done";/);
  assert.match(W, /api\.lastState = \{ complete: !!p\.completed_at, pct: percent\(p\.done, p\.skipped\), started: !!\(p\.step \|\| p\.done\.length\) \};/);
  assert.ok(W.indexOf('api.lastState =') < W.indexOf('const n = nudgeFor(o, role); if (!n) return;'), 'set before the nudge returns early for a finished setup');
  assert.match(G, /api\.last = m; try \{ global\.document\.dispatchEvent\(new CustomEvent\("helm:gs-model", \{ detail: m \}\)\); \} catch \(e\) \{\}/);
});
t('get set up: the top-bar chip names the card it opens ("Getting started 2 of 10", not "Setup 2 of 10")', () => {
  assert.match(read('public/shell-b-dash.js'), /=== "trial" \? "Trial steps " : "Getting started "\) \+ m\[1\] \+ " of " \+ m\[2\]/);
});

/* ---------------- 4. onboarding Menu dishes: Back keeps the veg / non-veg choice ---------------- */
t('onboarding: Review reads the typed table back from the screen, and a picker\'s change event is kept', () => {
  const O = read('public/onboarding.js');
  assert.match(O, /function syncManualFromDom\(kind\) \{/);
  assert.match(O, /if \(a === "review" && st\.stage !== "preview"\) \{ syncManualFromDom\(kind\); saveDraft\(\); \}/);
  assert.match(O, /if \(t\.dataset && t\.dataset\.r !== undefined && t\.dataset\.f && Array\.isArray\(st\.manual\)\) \{ const r = st\.manual\[Number\(t\.dataset\.r\)\]; if \(r\) \{ r\[t\.dataset\.f\] = t\.value; saveDraft\(\); \} return; \}/);
  assert.match(O, /if \(f\.type === "diet"\) return `<select \$\{base\}>\$\{\["", "veg", "nonveg", "special"\]\.map\(\(o\) => `<option value="\$\{esc\(o\)\}"\$\{o === v \? " selected" : ""\}/, 'the redrawn picker selects the kept value');
});

/* ---------------- 5. ui-pickers list is solid ---------------- */
t('ui-pickers: the list is an opaque card on top (no fade-in see-through state)', () => {
  const C = read('public/ui-pickers.css'), pop = C.slice(C.indexOf('.uip-pop {'), C.indexOf('}', C.indexOf('.uip-pop {')));
  assert.match(pop, /position: fixed; z-index: 2147483000; box-sizing: border-box; isolation: isolate;/);
  assert.match(pop, /background-color: #fff; background: var\(--bg-raised, #fff\);/);
  assert.match(pop, /opacity: 1;/);
  assert.doesNotMatch(pop, /opacity: 0/);
  assert.doesNotMatch(pop, /transition:[^;]*opacity/);
});

/* ---------------- 6. onboarding names ---------------- */
t('onboarding: one name for each step (title = step list) + "Business details - saved" on Finish', () => {
  const O = read('public/onboarding.js'), C = read('public/onboarding-core.js'), W = read('public/onboarding-wizard.js');
  assert.match(O, /function header\(kind\) \{ return `<h2>\$\{esc\(lbl\(kind\)\)\}<\/h2>/);
  assert.match(W, /pricing: "Item prices"/);
  assert.match(C, /label: "Item prices", noun: "rate"/);
  assert.doesNotMatch(C, /label: "Rates"/);
  assert.match(O, /const billLine = billingOk\(\) \? `<li><b>\$\{esc\(lbl\("billing"\)\)\}<\/b> — saved<\/li>` : "";/);
  assert.match(O, /<ul>\$\{billLine\}\$\{lines\}<\/ul>/);
});

console.log('# r221-ui-fixes: ' + n + ' passed');

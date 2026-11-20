// r238-signup-safety.test.mjs - R238 (fix plan Phase 2, owner approved 20 Nov 2026):
//  * ACC-01 / SEC-05: HelmValidate.emailSuggest - "Did you mean ...@gmail.com?" for common provider typos, never for a valid
//    unusual domain; sign-up, Invite people, Add user and the Staff e-mail all load the shared helper and stop ONCE on a typo
//  * ACC-02: "x@gmail" (no ending) is refused with a message that says what is missing (browser + 0403 server guard)
//  * ACC-26: names in Arabic, Devanagari, Telugu (and more) pass the shared rule AND the sign-up page's own rule
//  * LEG-07: the required "I am 18 or older" tick on sign-up (e-mail + Google), carried to the studio step and recorded on
//    the server (confirm_account_age, 0403); invitees never see it; existing users are not asked
//  * 0403 / APPLY-0403: additive, idempotent, ASCII, pasteable (no temp table / psql meta), check rows
//  * FILE-06 / BAK-01: the off-site backup script is read-only, encrypted, never committed secrets, nothing runs by itself
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
const HV = require(root + 'public/form-validate.js');
const tests = []; const t = (n, f) => tests.push([n, f]);

/* ---- e-mail typo suggestions ---------------------------------------------------------------------------------- */
const TYPOS = {
  'ravi@gamil.com': 'ravi@gmail.com', 'ravi@gmial.com': 'ravi@gmail.com', 'ravi@gmai.com': 'ravi@gmail.com',
  'ravi@gnail.com': 'ravi@gmail.com', 'ravi@gmal.com': 'ravi@gmail.com', 'ravi@gmaill.com': 'ravi@gmail.com',
  'ravi@gmail.con': 'ravi@gmail.com', 'ravi@gmail.co': 'ravi@gmail.com', 'ravi@gmail.cm': 'ravi@gmail.com',
  
  'Ravi@GAMIL.com ': 'ravi@gmail.com',
  'priya@yaho.com': 'priya@yahoo.com', 'priya@yahooo.com': 'priya@yahoo.com', 'priya@yahooo.co.in': 'priya@yahoo.co.in',
  'priya@yahoo.cm': 'priya@yahoo.com', 'priya@yahoo.con': 'priya@yahoo.com',
  'a@hotmial.com': 'a@hotmail.com', 'a@hotmal.com': 'a@hotmail.com', 'a@hotmail.co': 'a@hotmail.com',
  'a@outlok.com': 'a@outlook.com', 'a@outloo.com': 'a@outlook.com', 'a@icoud.com': 'a@icloud.com', 'a@icloud.co': 'a@icloud.com',
  'a@rediffmal.com': 'a@rediffmail.com', 'a@rediffmial.com': 'a@rediffmail.com', 'a@redifmail.com': 'a@rediffmail.com',
  'a@rediffmail.co': 'a@rediffmail.com', 'hello@aurora.con': 'hello@aurora.com', 'hello@aurora.cmo': 'hello@aurora.com',
};
t('ACC-01: every common typo gets its one suggestion', () => {
  for (const [typed, want] of Object.entries(TYPOS)) assert.equal(HV.emailSuggest(typed), want, typed);
});
t('ACC-01: a valid or unusual address never gets one (a suggestion, never a block)', () => {
  for (const ok of ['ravi@gmail.com', 'priya@yahoo.co.in', 'priya@yahoo.in', 'a@hotmail.co.uk', 'a@outlook.in', 'a@live.in',
    'hello@aurora.events', 'a@mail.com', 'a@ymail.com', 'a@gmx.de', 'a@zoho.in', 'a@iitb.ac.in', 'a@nic.gov.in', 'a@studio.ae',
    'a@me.com', 'a@gmailstudio.com', 'a@company.in', 'a@infosys.com', 'a@xn--80ak6aa92e.xn--p1ai', '', null, 'not-an-email']) {
    assert.equal(HV.emailSuggest(ok), null, String(ok));
    if (ok && /^[^@]+@[^@]+\.[a-z0-9-]{2,}$/i.test(ok)) assert.equal(HV.rules.email(ok).ok, true, ok + ' must stay valid');
  }
});
t('ACC-01: the algorithm is mailcheck 1.1.2 (sift4, max offset 5, thresholds 2/2/2) with its default lists', () => {
  assert.equal(HV._sift4('kitten', 'sitting'), 3); assert.equal(HV._sift4('gmial.com', 'gmail.com'), 1);
  assert.equal(HV._sift4('gmail.con', 'gmail.com'), 1); assert.equal(HV._sift4('', 'abc'), 3); assert.equal(HV._sift4('abc', 'abc'), 0);
  for (const d of ['msn.com', 'bellsouth.net', 'optusnet.com.au', 'googlemail.com', 'xtra.co.nz', 'rocketmail.com', 'btinternet.com', 'shaw.ca']) assert.ok(fv.includes('"' + d + '"'), d);
  assert.match(fv, /var MC_SLDS = \["yahoo", "hotmail", "mail", "live", "outlook", "gmx",/);
  assert.match(fv, /var MC_THRESH = \{ domain: 2, sld: 2, tld: 2 \};/);
  assert.match(fv, /mailcheck\.js 1\.1\.2 \(Kicksend, MIT licence,/);
  // mailcheck's own behaviour (documented false friends - a suggestion, one tap to keep): never blocks
  assert.equal(HV.emailSuggest('a@tcs.com'), 'a@msn.com'); assert.equal(HV.rules.email('a@tcs.com').ok, true);
});
t('ACC-02: "x@gmail" (no ending) is refused and the message says what is missing; trim + lower-case', () => {
  for (const bad of ['ravi@gmail', 'ravi@studio', 'ravi@gmail.', 'x@b.c']) {
    const r = HV.rules.email(bad); assert.equal(r.ok, false, bad); assert.match(r.error, /missing its ending, like \.com or \.in/);
  }
  assert.match(HV.rules.email('ravi@gmail').error, /for example ravi@gmail\.com/);
  assert.deepEqual(HV.rules.email('  Ravi@Gmail.COM '), { ok: true, value: 'ravi@gmail.com' });
  assert.equal(HV.missingTld('ravi@gmail.com'), false); assert.equal(HV.missingTld('ravi@gmail'), true);
});

/* ---- the forms use the shared helper ---------------------------------------------------------------------------- */
const login = read('public/login.html'), control = read('public/control.html'), staff = read('public/staff.html');
const fv = read('public/form-validate.js');
t('ACC-01: sign-up, Invite people, Add user and the Staff e-mail load form-validate.js and show the suggestion', () => {
  for (const [name, html] of [['login', login], ['control', control], ['staff', staff]]) assert.match(html, /<script src="\/?form-validate\.js\?v=\d+"><\/script>/, name);
  assert.match(login, /HelmValidate\.suggestEmail\(\$\("#email"\), \{after:\$\("#email_err"\)\}\)/);
  assert.match(control, /\["inv","um"\]\.forEach\(w=>\{ const i=\$\("#"\+w\+"_email"\), f=\$\("#"\+w\+"_add"\);[\s\S]{0,140}HelmValidate\.suggestEmail\(i,\{after:f\}\)/);
  assert.match(staff, /HelmValidate\.suggestEmail\(\$\("#s_email"\),\{after:\$\("#s_email_msg"\)\}\)/);
});
t('SEC-05: Invite people / Add user stop ONCE on a suggestion (then send what was typed); sign-up + Staff never stop', () => {
  assert.doesNotMatch(login, /EMAIL_SG && EMAIL_SG\.hold\(\)/); assert.doesNotMatch(staff, /STAFF_EMAIL_SG\.hold\(\)/);
  assert.match(control, /if\(EMAIL_SG\.inv && EMAIL_SG\.inv\.hold\(\)\) return;[^\n]*\n\s*await sendInvite\(/);
  assert.match(control, /if\(EMAIL_SG\.um && EMAIL_SG\.um\.hold\(\)\) return;/);
  assert.ok(control.indexOf('const EMAIL_SG={}') < control.indexOf('$("#um_add").addEventListener("submit"'), 'declared before the Add user handler');
  assert.match(login, /emailProblem\(v\)\{[^\n]*HelmValidate\.missingTld\(e\)\) return HelmValidate\.rules\.email\(e\)\.error/);
});

/* ---- suggestEmail in a tiny DOM ------------------------------------------------------------------------------------ */
function miniDom() {
  const mk = (tag) => { const n = { tagName: tag.toUpperCase(), children: [], attrs: {}, hidden: false, className: '', listeners: {}, parentNode: null, _text: '',
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
    get firstChild() { return this.children[0] || null; },
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    dispatchEvent(e) { (this.listeners[e.type] || []).forEach((f) => f(e)); return true; },
    classList: { add() {}, remove() {}, toggle() {} }, focus() { doc.activeElement = this; },
    querySelector(sel) { const cls = sel.replace(/^\./, ''); const walk = (x) => { for (const c of x.children || []) { if (String(c.className).split(' ').includes(cls)) return c; const r = walk(c); if (r) return r; } return null; }; return walk(this); },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }, set textContent(v) { this._text = String(v); this.children = []; } };
    return n; };
  const doc = { activeElement: null, createElement: mk, createTextNode: (s) => ({ textContent: String(s), parentNode: null }), querySelector: () => null };
  return { doc, mk };
}
t('suggestEmail: shown when the box is left, one tap uses it, "Keep mine" hides it, hold() stops only the first press', async () => {
  const { doc, mk } = miniDom();
  const g = { document: doc, Event: class { constructor(t) { this.type = t; } }, setTimeout: (f) => f(), CSS: null };
  const src = fv.replace(/\(typeof window !== "undefined" \? window : globalThis\);\s*$/, '(__g);');
  new Function('__g', 'module', 'document', src)(g, undefined, doc);
  const V = g.HelmValidate;
  const form = mk('form'), input = mk('input'); input.id = 'email'; input.value = 'ravi@gamil.com'; form.appendChild(input);
  let typed = 0; input.addEventListener('input', () => typed++);
  const sg = V.suggestEmail(input);
  const box = form.children[1];
  assert.equal(box.className, 'fv-suggest'); assert.equal(box.hidden, true, 'nothing while typing');
  input.listeners.blur.forEach((f) => f()); await new Promise((r) => setTimeout(r, 5));   // shown just after the box is left
  assert.equal(box.hidden, false); assert.match(box.textContent, /Did you mean ravi@gmail\.com\?/); assert.equal(sg.current(), 'ravi@gmail.com');
  box.querySelector('.fv-sg-use').listeners.click[0]();
  assert.equal(input.value, 'ravi@gmail.com'); assert.equal(box.hidden, true); assert.equal(typed, 1, 'the form hears the change');
  input.value = 'ravi@gmial.com';
  assert.equal(sg.hold(), true, 'first press stops'); assert.match(box.textContent, /Press the button again to keep what you typed/);
  assert.equal(sg.hold(), false, 'second press goes ahead'); assert.equal(input.value, 'ravi@gmial.com', 'never changed without a tap');
  input.value = 'x@yaho.com'; sg.update(); box.querySelector('.fv-sg-keep').listeners.click[0]();
  assert.equal(box.hidden, true); assert.equal(sg.hold(), false, 'kept -> never asked again for it');
  input.value = 'hello@aurora.events'; assert.equal(sg.hold(), false, 'a valid unusual address is never stopped');
  input.value = 'ravi@gamil.com'; input.readOnly = true; assert.equal(sg.update(), null, 'a locked (invitation) address is left alone');
});

/* ---- names in every script ---------------------------------------------------------------------------------------- */
const NAMES = ['محمد علي', 'فاطمة الزهراء', 'عبد الله بن عمر', 'प्रिया शर्मा', 'श्रीनिवास', 'క్ష్మీ నారాయణ', 'శ్రీనివాస్ రెడ్డి', 'వెంకటేశ్వర్లు',
  'தமிழ்செல்வி', 'ಶ್ರೀನಿವಾಸ', 'সৌমিত্র', 'ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ', 'ગીતા પટેલ', 'നന്ദിനി', 'ଶ୍ରୀକାନ୍ତ', 'عائشہ خان',
  'K. Srinivas', "D'Souza", 'Anne-Marie', 'Zoë Brontë', 'र‍ाम', 'Ravi K.'];
t('ACC-26: Arabic, Devanagari, Telugu (and 10 more scripts) pass the shared name rule', () => {
  for (const n of NAMES) { const r = HV.rules.name(n, { required: true }); assert.equal(r.ok, true, n + ': ' + r.error); assert.equal(r.value, n.normalize ? r.value : n); }
  for (const bad of ['123', '!!', 'a--b', 'x@y']) assert.equal(HV.rules.name(bad).ok, false, bad);
});
t('ACC-26: the sign-up page\'s own name rule agrees (same scripts pass, same rules refuse)', () => {
  const m = /const NAME_RE=(\/[^\n]+\/u);/.exec(login); assert.ok(m, 'login.html NAME_RE');
  const RE = eval(m[1]);
  for (const n of NAMES) assert.equal(RE.test(n), true, n);
  for (const bad of ['123', '!!']) assert.equal(RE.test(bad), false, bad);
});
t('ACC-26: studio names and cities in any script pass the studio step (signup-flow detailsCheck)', () => {
  const g = { location: { search: '', hash: '', pathname: '/login' }, localStorage: null, sessionStorage: null, document: { querySelector: () => null } };
  new Function('global', read('public/signup-flow.js').replace(/\}\)\(typeof window !== "undefined" \? window : globalThis\);\s*$/, '})(global);'))(g);
  const SF = g.BPSignupFlow;
  for (const [name, city] of [['అరోరా ఈవెంట్స్', 'హైదరాబాద్'], ['शुभ विवाह डेकोर', 'दिल्ली'], ['زفاف الأحلام', 'دبي']]) {
    const r = SF.detailsCheck({ name, city, country: name.startsWith('ز') ? 'AE' : 'IN', state: 'Telangana' }, []);
    assert.equal(r.ok, true, name + ' ' + JSON.stringify(r.errors));
  }
});

/* ---- 18+ at sign-up ------------------------------------------------------------------------------------------------- */
t('LEG-07: a required "I am 18 or older" tick sits with the Terms on step 1 (invitees never see that row)', () => {
  const row = /<div id="agreeRow" hidden>([\s\S]*?)<\/div>/.exec(login)[1];
  assert.match(row, /<input type="checkbox" id="adult" aria-describedby="adult_err"><span>I am 18 or older <span class="req"/);
  assert.match(row, /<p class="ferr" id="adult_err" hidden><\/p>/);
  assert.match(login, /if\(!ad\.checked\)\{ ae\.textContent="Please confirm you are 18 or older\. Helm accounts are for adults only\.";/);
  assert.match(login, /needsAgree: \(\)=>mode==="signup" && !J\(\) && !\(\$\("#agree"\)\.checked && \$\("#adult"\)\.checked\)/, 'Google button stays shielded');
  assert.match(login, /\$\("#adult"\)\.addEventListener\("change", \(\)=>GIS\.refresh\(\)\)/);
  assert.equal((login.match(/BPSignupFlow\.stashTerms\("google", \$\("#adult"\)\.checked\)/g) || []).length, 2);
  assert.match(login, /BPSignupFlow\.stashTerms\("signup", \$\("#adult"\)\.checked\)/);
  assert.match(login, /termsAgreed:true, adultConfirmed:\$\("#adult"\)\.checked===true/);
  assert.match(login, /<div id="obAdultRow" hidden><label class="agree" for="ob_adult"><input type="checkbox" id="ob_adult"><span>I am 18 or older/);
});
t('LEG-07: the tick reaches the server at the studio step (this browser or the account note) - never blocks if older server', () => {
  const g = { location: { search: '', hash: '', pathname: '/login' }, localStorage: null, sessionStorage: null, document: { querySelector: () => null } };
  const src = read('public/signup-flow.js');
  new Function('global', src.replace(/\}\)\(typeof window !== "undefined" \? window : globalThis\);\s*$/, '})(global);'))(g);
  const A = g.BPSignupFlow.adultEarlier, now = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(A(JSON.stringify({ t: now - 60000, src: 'signup', adult: true }), null, now), true);
  assert.equal(A(JSON.stringify({ t: now - 60000, src: 'signup', adult: false }), null, now), false);
  assert.equal(A(JSON.stringify({ t: now - 60000, src: 'signup' }), null, now), false, 'an older stash (no tick) is not counted');
  assert.equal(A(JSON.stringify({ t: now - 3 * 86400000, adult: true }), null, now), false, 'stash older than 2 days');
  assert.equal(A(null, { helm_adult_confirmed_at: '2026-11-19T10:00:00Z' }, now), true, 'verified on another device');
  assert.equal(A(null, { helm_adult_confirmed_at: '2026-09-01T10:00:00Z' }, now), false);
  assert.equal(A('not json', {}, now), false);
  assert.match(src, /function stashTerms\(src, adult\) \{ lsSet\(TERMS_KEY, JSON\.stringify\(\{ t: Date\.now\(\), src: src === "google" \? "google" : "signup", adult: adult === true \}\)\); \}/);
  assert.match(src, /if \(adult\) await ageRecord\(/);
  assert.match(src, /Please confirm you are 18 or older\. Helm accounts are for adults only\./);
  assert.match(src, /try \{ var r = await B\.signup\.confirmAge\(how\); if \(r && r\.confirmed\) st\.adultSaved = true; \} catch \(e\) \{\}/);
  const api = read('public/store-api.js');
  assert.match(api, /confirmAge: \(source\) => \(supa \? rpc\("confirm_account_age", \{/);
  assert.match(api, /opts\.adultConfirmed === true\) so\.data = Object\.assign\(\{\}, so\.data \|\| \{\}, \{ helm_adult_confirmed_at:/);
});

/* ---- 0403 + APPLY-0403 -------------------------------------------------------------------------------------------------- */
const mig = read('supabase/migrations/0403_r238_signup_safety.sql'), apply = read('supabase/APPLY-0403.sql'), manifest = read('supabase/migrations/MANIFEST');
t('0403: additive + idempotent + ASCII; no data dropped, updated or deleted', () => {
  assert.equal(/[^\x00-\x7f]/.test(mig), false, 'ASCII'); assert.equal(/[^\x00-\x7f]/.test(apply), false, 'APPLY ASCII');
  assert.doesNotMatch(mig, /\bdrop table\b|\bdelete from\b|\btruncate\b|\bupdate public\.|\bupdate auth\.|\balter table [^;]* drop /i);
  assert.match(mig, /create table if not exists public\.account_age_confirmations/);
  assert.match(mig, /on conflict \(user_id\) do nothing/);
  assert.match(mig, /exception when others then\s+v_bad := null;/, 'fails open: a bug never stops sign-in');
  assert.match(mig, /errcode = '22023', hint = 'email_no_tld'/);
  assert.match(mig, /revoke all on table public\.account_age_confirmations from authenticated/);
  assert.match(manifest, /\nforward  supabase\/migrations\/0402_r236_ops_health\.sql\n# 0403 [^\n]+\nforward  supabase\/migrations\/0403_r238_signup_safety\.sql\n/);
  assert.doesNotMatch(manifest, /0401_/, '0401 left free for the parallel PR');
});
t('APPLY-0403: one transaction, 5 s lock wait, the migration verbatim, check rows, pasteable', () => {
  assert.match(apply, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
  assert.ok(apply.includes(mig), 'migration verbatim'); assert.match(apply, /\ncommit;\n$/);
  assert.doesNotMatch(apply, /\btemp(orary)? table\b|^\\/im); assert.doesNotMatch(apply, /set_config\(|\bset (session|role)\b/i);
  const rows = apply.match(/select '0\d [^']+'/g) || []; assert.ok(rows.length >= 8, 'check rows');
  assert.match(read('scripts/db-test/run-all.sh'), /run "r238-signup-safety-0403"[\s\S]*run "r238-apply-0403"/);
});

/* ---- off-site backup script ---------------------------------------------------------------------------------------------- */
t('FILE-06 / BAK-01: backup script is read-only, encrypts, keeps secrets in env, runs only by hand; restore drill documented', () => {
  const p = 'scripts/backup/helm-offsite-backup.sh'; assert.ok(existsSync(root + p), p);
  const sh = read(p), drill = read('scripts/backup/RESTORE-DRILL.md'), readme = read('scripts/backup/README.md');
  assert.match(sh, /^#!\/usr\/bin\/env bash\nset -euo pipefail/);
  assert.match(sh, /pg_dump [^\n]*--format=custom/); assert.match(sh, /default_transaction_read_only=on/);
  assert.match(sh, /age -r|gpg --batch[^\n]*--encrypt/); assert.match(sh, /DATABASE_URL/); assert.match(sh, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(sh, /\bpg_restore\b[^\n]*DATABASE_URL/, 'never restores into the source database');
  assert.ok(sh.indexOf('export PGOPTIONS="${PGOPTIONS:-} -c default_transaction_read_only=on"') < sh.indexOf('pg_dump --dbname'), 'read-only before the first connection');
  const py = read('scripts/backup/storage_copy.py');
  assert.match(py, /if method not in \("GET", "POST"\):/); assert.doesNotMatch(py, /"(DELETE|PUT|PATCH)"|method="(DELETE|PUT|PATCH)"/);
  assert.match(py, /\/storage\/v1\/object\/list\//); assert.match(py, /\/storage\/v1\/object\/authenticated\//);
  assert.doesNotMatch(py, /print\([^)]*key/i, 'the key is never printed');
  assert.doesNotMatch(sh, /eyJ[A-Za-z0-9_-]{10,}|sk_live|postgres(ql)?:\/\/[^$\s"']+@/i, 'no secret / connection string in the file');
  assert.match(sh, /rm -f "\$\{?PLAIN/, 'the unencrypted dump is removed');
  assert.match(drill, /pg_restore/); assert.match(drill, /row counts?/i); assert.match(drill, /throwaway|disposable/i);
  assert.match(readme, /never runs by itself|nothing runs automatically/i);
  assert.doesNotMatch(read('.gitignore'), /^scripts\/backup\/?$/m);
});

t('CSP: the new Google sign-in inline-style hash is allowed exactly where Google\'s stylesheet is (never unsafe-inline)', () => {
  const H = "'sha256-88QphsXJQwxKP9xXR175ZSMzpaq6Swzj9u3QQ+G2Wig='";
  assert.match(read('scripts/csp-hashes.cjs'), /const GIS_INLINE_STYLE_HASHES = \[GIS_INLINE_STYLE_HASH, "'sha256-88QphsXJQwxKP9xXR175ZSMzpaq6Swzj9u3QQ\+G2Wig='"\];/);
  let n = 0;
  for (const r of JSON.parse(read('vercel.json')).headers) {
    const csp = (r.headers || []).find((h) => h.key === 'Content-Security-Policy'); if (!csp) continue;
    const elem = (csp.value.match(/style-src-elem [^;]*/) || [''])[0];
    assert.equal(elem.includes(H), elem.includes('https://accounts.google.com/gsi/style'), r.source);
    if (elem.includes(H)) n++;
    assert.ok(!/style-src-elem [^;]*'unsafe-inline'/.test(csp.value));
  }
  assert.ok(n >= 1, 'on the sign-in policy');
  assert.match(read('public/_headers'), /sha256-88QphsXJQwxKP9xXR175ZSMzpaq6Swzj9u3QQ\+G2Wig=/);
});
t('smoke: a Google sign-in inline-style hash change is a WARNING listing the hash; a Helm inline-style violation still fails', async () => {
  const c = await import(root + 'tests/smoke/config.mjs');
  const msg = "Applying inline style violates the following Content Security Policy directive 'style-src-elem 'self''. Either the 'unsafe-inline' keyword, a hash ('sha256-NEWHASH+abc='), or a nonce ('nonce-...') is required to enable inline execution.";
  assert.equal(c.classifyStyleCsp(msg, [{ directive: 'style-src-elem', sourceFile: 'https://accounts.google.com/gsi/client' }], false), 'gsi');
  assert.equal(c.classifyStyleCsp(msg, [], true), 'gsi', 'Google script on the page, no Helm file named');
  assert.equal(c.classifyStyleCsp(msg, [{ directive: 'style-src-elem', sourceFile: 'https://www.helm.events/login' }], true), 'error', 'Helm\'s own');
  assert.equal(c.classifyStyleCsp(msg, [], false), 'error', 'no Google script: our problem');
  assert.equal(c.classifyStyleCsp('Refused to load the script', [], true), 'error');
  assert.equal(c.cspHashOf(msg), 'sha256-NEWHASH+abc=');
  const spec = read('tests/smoke/site.smoke.spec.mjs');
  assert.match(spec, /test\.info\(\)\.annotations\.push\(\{ type: 'warning', description: msg \}\)/);
  assert.equal((spec.match(/await errors\.settle\(\);\n    expect\(errors, 'console errors on \//g) || []).length, 2);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.stack || e)); }
}
console.log(`\nr238-signup-safety: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);

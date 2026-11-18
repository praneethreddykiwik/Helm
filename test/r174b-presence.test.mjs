// r174b-presence.test.mjs - R174b (owner, 16 Nov 2026): chat online status. Green = online now, amber = away, grey = offline
// with "Active 5 min ago" / "Last seen yesterday"; own studio only; "Show when I'm online" switch; no extra load.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.message)); } };

const MIG = r('supabase/migrations/0366_r174b_presence.sql');
const APPLY = r('supabase/APPLY-0366.sql');
const API = r('public/store-api.js');
const CHAT = r('public/chat.html');
const STAFF = r('public/staff.html');
const P = API.slice(API.indexOf('const presence = (() => {'), API.indexOf('  const BPStore = {'));

t('0366: one closed table (RLS on, no grants), three functions, own-studio realtime policies; additive', () => {
  assert.match(MIG, /create table if not exists public\.member_presence \(/);
  assert.match(MIG, /alter table public\.member_presence enable row level security;/);
  assert.match(MIG, /revoke all on table public\.member_presence from authenticated/);
  assert.match(MIG, /create or replace function public\.presence_touch\(\)/);
  assert.match(MIG, /create or replace function public\.presence_list\(\)/);
  assert.match(MIG, /create or replace function public\.presence_set_visible\(p_show boolean\)/);
  assert.match(MIG, /mp\.last_seen_at < now\(\) - interval '2 minutes'/);
  assert.match(MIG, /realtime\.topic\(\) = 'presence:org:' \|\| public\.current_org_id\(\)::text/);
  assert.match(MIG, /to_regclass\('realtime\.messages'\) is null/);
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /\bdrop\s+(table|function|policy)\b|\bdelete\s+from\b|\btruncate\b/i);
  assert.ok(!/^--.*'/m.test(MIG), 'editor-safe comments');
});

t('presence_list: my studio only, never me, hidden people listed apart', () => {
  assert.match(MIG, /where p\.org_id = v_org and p\.id <> v_uid\), '\[\]'::jsonb\),\n    'hidden'/);
  assert.match(MIG, /join public\.member_presence mp on mp\.user_id = p\.id and mp\.org_id = v_org and mp\.show_online/);
});

t('APPLY-0366 = the migration, ASCII, editor-safe; MANIFEST + checker override + DB suite registered', () => {
  assert.equal(APPLY.slice(APPLY.indexOf('begin;\n') + 7, APPLY.lastIndexOf('\ncommit;')).trim(), MIG.trim());
  assert.ok(/^[\x00-\x7f]*$/.test(APPLY));
  assert.ok(r('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0366_r174b_presence.sql'));
  assert.match(r('supabase/check-prod-overrides.json'), /"0366": \{[^\n]*"policy helm_presence_read_own_studio on realtime\.messages"/);
  assert.match(r('scripts/db-test/run-all.sh'), /R174B-PRESENCE-0366: ALL PASS \\\(15\/15\\\)/);
});

t('client: ONE private channel per tab on studio app pages, tracks only user id + online/away', () => {
  assert.match(P, /supa\.channel\("presence:org:" \+ orgId, \{ config: \{ private: true, presence: \{ key: uid\(\) \} \} \}\)/);
  assert.match(P, /function payload\(\) \{ return meShow && uid\(\) \? \{ u: uid\(\), s: mineNow\(\) \} : null; \}/);   // R209: tracked via presenceTracker
  assert.match(API, /const r = p \? ch\.track\(p\) : ch\.untrack\(\);/);
  assert.match(P, /if \(started \|\| mode !== "supabase"/);
  assert.match(P, /getAttribute\("data-shell"\) !== "b"\) return;   \/\/ studio app pages only/);
  assert.match(API, /presence\.autoStart\(\); \} catch \(e\) \{\} \}, 1500\)/);
  assert.match(API, / chat, presence, profile,/);
});

t('client: no extra load - 60 s tick, touch every 3 min, list every 2 min only when dots show, away after 5 min', () => {
  assert.match(P, /const IDLE_MS = 5 \* 60000, TOUCH_MS = 3 \* 60000, LIST_MS = 2 \* 60000, TICK_MS = 60000, PEER_MS = 150000;/);
  assert.match(P, /if \(hasDots\(\)\) refreshList\(false\);/);
  assert.doesNotMatch(P, /setInterval\([^,]+, *(?:[1-5]?\d{1,4})\)/, 'no fast polling');
});

t('client: labels + dots (green / amber / grey), hidden people never shown, my switch', () => {
  assert.match(P, /label: "Online now"/);
  assert.match(P, /return "Active " \+ m \+ " min ago"/);
  assert.match(P, /return "Last seen yesterday"/);
  assert.match(P, /const COLORS = \{ online: "#22a35a", away: "#f0a020", offline: "#aab3ae" \};/);
  assert.match(P, /if \(s\.status === "hidden" \|\| !started\) \{ el\.hidden = true; return; \}/);
  assert.match(P, /supa\.rpc\("presence_set_visible", \{ p_show: !!on \}\)/);
  assert.match(P, /if \(leading\(\) && tracker\) tracker\.want\(\);   \/\/ R209: track \/ untrack through the throttle/);
});

t('chat: dots on the chat list, header, pickers; DM header says Online now / Last seen; menu switch', () => {
  assert.match(CHAT, /personAv\(convOther\(c\),"",true\)/);
  assert.match(CHAT, /data-presence-uid="'\+esc\(id\)\+'" data-presence-corner hidden/);
  assert.match(CHAT, /<span data-presence-uid="\$\{esc\(p\.id\)\}" data-presence-corner data-presence-size="10px" hidden><\/span>/);
  assert.match(CHAT, /function presenceLine\(uid\)/);
  assert.match(CHAT, /BPStore\.presence\.paint\(root\)/);
  assert.match(CHAT, /BPStore\.presence\.setVisible\(!on\)/);
  assert.match(CHAT, /position:relative\}/);
});

t('staff page: dot next to people who sign in to Helm', () => {
  assert.match(STAFF, /linked&&s\.profile_id\?' <span data-presence-uid="'\+esc\(s\.profile_id\)\+'"/);
  assert.match(STAFF, /BPStore\.presence\.paint\(\$\("#grid"\)\)/);
});

console.log(`\nr174b-presence: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

#!/usr/bin/env bash
# r233 (log-noise guard): public/store-api.js answers every database function sent with the bare anon key (a signed-out
# tab) from the browser with 401 / 42501 - without a network call - UNLESS the function is in ANON_RPCS (or is a
# public_* / submit_* function). That is only safe while ANON_RPCS holds EVERY function the anon role may run.
# This suite reads ANON_RPCS out of store-api.js and checks it against a freshly migrated database:
#   1. every public-schema function anon can EXECUTE is allowed by ANON_RPCS (else a public link page would be blocked)
#   2. every name in ANON_RPCS (other than the public_ / submit_ prefixes) exists and anon can run it (no stale entries)
#   3. every function the browser code calls exists (a call to a function no migration creates = a 404 on every call)
# Run it on a fresh database BEFORE the behavioural suites (some of them commit grant changes).
# Local disposable PG only (PGHOST/PGPORT/PGDATABASE from the caller). Reads only.
set -uo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
LIST="$(node -e '
const fs = require("fs"); const S = fs.readFileSync("public/store-api.js", "utf8");
const m = S.match(/const ANON_RPCS = \/\^\(\?:([^)]*)\)\$\/;/); if (!m) { console.error("ANON_RPCS not found"); process.exit(2); }
console.log(m[1].split("|").filter((x) => !/\[/.test(x)).join("\n"));')" || { echo "R233-ANON-RPCS: FAIL (list not found)"; exit 1; }
CALLED="$(node -e '
const fs = require("fs"); const out = new Set();
for (const f of fs.readdirSync("public")) { if (!/\.(js|html)$/.test(f)) continue;
  const s = fs.readFileSync("public/" + f, "utf8");
  for (const m of s.matchAll(/(?:\b(?:rpc|wrpc|rpcOnce)|\.rpc|\b_call)\(\s*["\x27]([a-z_][a-z0-9_]*)["\x27]/g)) out.add(m[1]);
  for (const m of s.matchAll(/(?:\.hq|\bcall)\(\s*["\x27](hq_[a-z0-9_]*)["\x27]/g)) out.add(m[1]); }
console.log([...out].sort().join("\n"));')"
q() { psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
pass=0; total=0; bad=""
chk() { total=$((total+1)); if [ -z "$2" ]; then pass=$((pass+1)); echo "  ok $1"; else bad="$bad\n  FAIL $1: $2"; echo "  FAIL $1: $2"; fi; }
ALLOWED_SQL="$(printf '%s\n' "$LIST" | sed "s/'/''/g; s/.*/'&'/" | paste -sd, -)"
CALLED_SQL="$(printf '%s\n' "$CALLED" | sed "s/'/''/g; s/.*/'&'/" | paste -sd, -)"
# 1. anon-executable functions that the browser list would refuse
r1="$(q -c "select string_agg(distinct p.proname, ', ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
    and p.proname !~ '^(public|submit)_' and p.proname not in ($ALLOWED_SQL)")"
chk "every function anon may run is in ANON_RPCS" "$r1"
# 2. stale entries: listed but missing, or anon may not run them
r2="$(q -c "select string_agg(x, ', ' order by x) from unnest(array[$ALLOWED_SQL]::text[]) x
  where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = x and has_function_privilege('anon', p.oid, 'execute'))")"
chk "every ANON_RPCS name exists and anon may run it" "$r2"
# 3. browser calls to functions no migration creates
r3="$(q -c "select string_agg(x, ', ' order by x) from unnest(array[$CALLED_SQL]::text[]) x
  where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = x)")"
chk "every function the browser calls exists ($(printf '%s\n' "$CALLED" | wc -l | tr -d ' ') names)" "$r3"
if [ "$pass" = "$total" ]; then echo "R233-ANON-RPCS: ALL PASS ($pass/$total)"; else printf "R233-ANON-RPCS: FAIL ($pass/$total)$bad\n"; exit 1; fi

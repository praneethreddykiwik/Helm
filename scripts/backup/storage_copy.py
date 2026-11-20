#!/usr/bin/env python3
"""storage_copy.py - R238 backup helper: copy every Supabase Storage bucket's files to a local folder.

READ-ONLY on Supabase: it only LISTS buckets / objects and DOWNLOADS files (GET + the list POST). It never uploads,
moves or deletes anything. Settings come from the environment only: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the
key is sent as a request header and never printed or written to disk). Gentle: one request at a time.

usage: python3 -I scripts/backup/storage_copy.py <destination folder>
"""
import json, os, sys, time, urllib.parse, urllib.request

def main():
    if len(sys.argv) != 2:
        sys.exit("usage: storage_copy.py <destination folder>")
    dest = os.path.abspath(sys.argv[1])
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base.startswith("https://") and not base.startswith("http://127.0.0.1") and not base.startswith("http://localhost"):
        sys.exit("STOP: SUPABASE_URL must be https://<ref>.supabase.co")
    if not key:
        sys.exit("STOP: SUPABASE_SERVICE_ROLE_KEY is not set")
    hdr = {"Authorization": "Bearer " + key, "apikey": key}

    def call(method, path, body=None):
        if method not in ("GET", "POST"):
            raise SystemExit("refused: read-only helper")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method, headers=dict(hdr, **({"Content-Type": "application/json"} if data else {})))
        time.sleep(0.05)
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()

    buckets = json.loads(call("GET", "/storage/v1/bucket"))
    total = 0
    for b in buckets:
        bid = b.get("id") or b.get("name")
        if not bid:
            continue
        files = []
        todo = [""]
        while todo:
            prefix = todo.pop()
            offset = 0
            while True:
                rows = json.loads(call("POST", "/storage/v1/object/list/" + urllib.parse.quote(bid, safe=""),
                                       {"prefix": prefix, "limit": 1000, "offset": offset, "sortBy": {"column": "name", "order": "asc"}}))
                for row in rows:
                    name = row.get("name") or ""
                    if not name:
                        continue
                    full = prefix + name
                    if row.get("id") is None:
                        todo.append(full + "/")        # a folder
                    else:
                        files.append(full)
                if len(rows) < 1000:
                    break
                offset += 1000
        for path in files:
            parts = [p for p in path.split("/") if p not in ("", ".", "..")]
            if not parts:
                continue
            out = os.path.join(dest, bid, *parts)
            if not os.path.abspath(out).startswith(os.path.join(dest, bid) + os.sep):
                continue
            os.makedirs(os.path.dirname(out), exist_ok=True)
            data = call("GET", "/storage/v1/object/authenticated/" + urllib.parse.quote(bid, safe="") + "/" + "/".join(urllib.parse.quote(p, safe="") for p in parts))
            with open(out, "wb") as f:
                f.write(data)
            total += 1
        print("    bucket %s: %d file(s)" % (bid, len(files)))
    print("    %d file(s) copied" % total)

if __name__ == "__main__":
    main()

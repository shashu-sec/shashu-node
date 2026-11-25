"""npm pack --json linter. stdin may carry a PowerShell UTF-8 BOM."""
from __future__ import annotations

import json
import sys

blob = sys.stdin.buffer.read()
if blob.startswith(b"\xef\xbb\xbf"):
    blob = blob[3:]
d = json.loads(blob.decode("utf-8"))
files = d[0]["files"] if isinstance(d, list) else d.get("files", [])
allowed_files = {"package.json", "README.md", "LICENSE", "NOTICE", "CHANGELOG.md"}
bad = []
for f in files:
    p = f["path"].replace("\\", "/")
    if p in allowed_files or p.startswith("dist/"):
        if p.endswith(".map") and "internal" in p.lower():
            bad.append(p)
        continue
    bad.append(p)
    if "_internal" in p or p.endswith(".env"):
        bad.append(p)
if bad:
    print("FORBIDDEN", *sorted(set(bad)), sep="\n")
    sys.exit(1)
print("pack files", len(files))

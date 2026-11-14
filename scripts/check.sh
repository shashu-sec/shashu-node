#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
step() { echo "== $* =="; }

step "eslint"
npx eslint src test

step "prettier --check"
npx prettier --check src test README.md CHANGELOG.md package.json

step "tsc --noEmit"
npx tsc --noEmit

step "tests"
npm test

step "build"
npm run build

step "npm pack contents"
npm pack --dry-run --json | python - <<'PY'
import json, sys
d = json.load(sys.stdin)
files = d[0]["files"] if isinstance(d, list) else d.get("files", [])
allowed_files = {"package.json", "README.md", "LICENSE", "NOTICE", "CHANGELOG.md"}
bad = []
for f in files:
    p = f["path"].replace("\\", "/")
    if p in allowed_files or p.startswith("dist/"):
        continue
    bad.append(p)
if bad:
    print("FORBIDDEN")
    print("\n".join(bad))
    raise SystemExit(1)
print("pack files", len(files))
PY

step "npm audit --omit=dev"
npm audit --omit=dev

step "gitleaks"
command -v gitleaks >/dev/null || { echo "gitleaks missing"; exit 1; }
gitleaks detect --no-git --source "$ROOT" --redact

echo "ALL CHECKS PASSED"

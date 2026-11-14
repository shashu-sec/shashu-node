# SHASHU Node SDK public-release gate. Exit non-zero on any failure.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Find-Gitleaks {
    $cmd = Get-Command gitleaks -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($hint in @(
        "$env:TEMP\gitleaks\gitleaks.exe",
        "C:\Users\sathi\AppData\Local\Temp\gitleaks\gitleaks.exe",
        "D:\Trustgate\_agent\det-hardening-data\streamBCD\tools\gitleaks\bin\gitleaks.exe"
    )) {
        if (Test-Path $hint) { return $hint }
    }
    throw "gitleaks not found"
}

Write-Host "== eslint =="
npx eslint src test
if ($LASTEXITCODE -ne 0) { throw "eslint" }

Write-Host "== prettier --check =="
npx prettier --check "src" "test" "README.md" "CHANGELOG.md" "package.json"
if ($LASTEXITCODE -ne 0) { throw "prettier --check" }

Write-Host "== tsc --noEmit =="
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw "tsc" }

Write-Host "== tests =="
npm test
if ($LASTEXITCODE -ne 0) { throw "tests" }

Write-Host "== build =="
npm run build
if ($LASTEXITCODE -ne 0) { throw "build" }

Write-Host "== npm pack contents =="
$packJson = npm pack --dry-run --json | Out-String
$packJson | py -3.13 -c @"
import json, sys
raw = sys.stdin.read()
d = json.loads(raw)
files = d[0]['files'] if isinstance(d, list) else d.get('files', [])
allowed_prefixes = ('dist/',)
allowed_files = {'package.json', 'README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md'}
bad = []
for f in files:
    p = f['path'].replace('\\', '/')
    if p in allowed_files or p.startswith('dist/'):
        if p.endswith('.map') and 'internal' in p.lower():
            bad.append(p)
        continue
    bad.append(p)
    if '_internal' in p or p.endswith('.env'):
        bad.append(p)
if bad:
    print('FORBIDDEN', *sorted(set(bad)), sep='\n')
    sys.exit(1)
print('pack files', len(files))
"@
if ($LASTEXITCODE -ne 0) { throw "pack contents" }

Write-Host "== npm audit --omit=dev =="
npm audit --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm audit" }

Write-Host "== gitleaks =="
$gitleaks = Find-Gitleaks
& $gitleaks detect --no-git --source $Root --redact
if ($LASTEXITCODE -ne 0) { throw "gitleaks" }

Write-Host "ALL CHECKS PASSED"

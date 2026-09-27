# Puts the browser build on the server: https://uleditor.truss (ADR 0002, step 7).
#
# Builds the WebAssembly, the OCR assets and the shell; ships the built `dist`
# with deploy/web/compose.yml and deploy/web/Caddyfile to /opt/stacks/uleditor;
# swaps the site in and restarts the one container. The shared Caddy gets a
# block for uleditor.truss the first time only, with a dated .bak beside it,
# and is reloaded rather than restarted. Then the served headers are read
# back on the server itself, so the check does not depend on this machine's
# DNS or on it trusting the internal CA.
#
#   pwsh tools/deploy-web.ps1            # build and deploy
#   pwsh tools/deploy-web.ps1 -SkipBuild # deploy what is already built
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot/.."
$ssh = 'C:\WINDOWS\System32\OpenSSH\ssh.exe'
$scp = 'C:\WINDOWS\System32\OpenSSH\scp.exe'
$opts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8')

function Remote([string]$script) {
    ($script -replace "`r", '') | & $ssh @opts server 'bash -s'
    if ($LASTEXITCODE -ne 0) { throw "the server step failed ($LASTEXITCODE)" }
}

Push-Location $root
try {
    if (-not $SkipBuild) {
        node tools/wasm-assets.mjs; if ($LASTEXITCODE) { throw 'wasm-assets failed' }
        node tools/ocr-assets.mjs; if ($LASTEXITCODE) { throw 'ocr-assets failed' }
        pnpm --filter '@uleditor/shell-ui' build; if ($LASTEXITCODE) { throw 'the build failed' }
    }
    foreach ($needed in 'index.html', 'wasm/ul_image_bg.wasm', 'ocr/manifest.json') {
        if (-not (Test-Path "packages/shell-ui/dist/$needed")) { throw "dist has no $needed — build first" }
    }

    $bundle = Join-Path ([IO.Path]::GetTempPath()) 'uleditor-web.tgz'
    # Windows' own tar: a Git Bash on the PATH brings GNU tar, which reads
    # `C:` in the path as the name of a remote host.
    & "$env:SystemRoot\System32\tar.exe" -czf $bundle -C packages/shell-ui/dist .
    if ($LASTEXITCODE) { throw 'packing dist failed' }
    & $scp @opts -q $bundle deploy/web/compose.yml deploy/web/Caddyfile 'server:/tmp/'
    if ($LASTEXITCODE) { throw 'the upload failed' }
    Remove-Item $bundle

    Remote @'
set -eu
dir=/opt/stacks/uleditor
mkdir -p "$dir"
install -m 0644 /tmp/compose.yml "$dir/compose.yml"
install -m 0644 /tmp/Caddyfile "$dir/Caddyfile"
rm -rf "$dir/site.new"
mkdir "$dir/site.new"
tar -xzf /tmp/uleditor-web.tgz -C "$dir/site.new"
chmod -R a+rX "$dir/site.new"
rm -f /tmp/uleditor-web.tgz /tmp/compose.yml /tmp/Caddyfile
rm -rf "$dir/site.old"
[ -d "$dir/site" ] && mv "$dir/site" "$dir/site.old"
mv "$dir/site.new" "$dir/site"
cd "$dir"
docker compose up -d --force-recreate --quiet-pull
echo "deployed: $(du -sh site | cut -f1)"

shared=/opt/stacks/caddy/Caddyfile
if ! grep -q '^uleditor.truss {' "$shared"; then
  cp "$shared" "$shared.bak-$(date +%Y%m%d-%H%M%S)"
  printf '\nuleditor.truss {\n\ttls internal\n\treverse_proxy uleditor:8080\n}\n' >> "$shared"
  docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "the shared Caddy now serves uleditor.truss"
fi
true #
'@

    # What is served, asked of the shared Caddy on the server itself.
    Remote @'
set -eu
for i in 1 2 3 4 5 6 7 8 9 10; do
  docker inspect -f '{{.State.Health.Status}}' uleditor | grep -q healthy && break
  sleep 3
done
echo "container: $(docker inspect -f '{{.State.Health.Status}}' uleditor)"
fetch() { curl -sk --resolve uleditor.truss:443:127.0.0.1 "https://uleditor.truss$1" -o /dev/null -D - -w '%{http_code}\n'; }
fetch / | grep -i -E '^HTTP|^content-security-policy|^x-content-type|^cache-control'
fetch /wasm/ul_image_bg.wasm | grep -i -E '^HTTP|^content-type'
true #
'@
}
finally {
    Pop-Location
}

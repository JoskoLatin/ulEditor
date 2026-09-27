# Puts the browser build on the server: https://uleditor.truss (ADR 0002, step 7).
#
# Builds the WebAssembly, the OCR assets and the shell; ships the built `dist`
# (without source maps)
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
    # `C:` in the path as the name of a remote host. No source maps: they
    # carry the source as it stood in the working tree, committed or not.
    & "$env:SystemRoot\System32\tar.exe" -czf $bundle --exclude '*.map' -C packages/shell-ui/dist .
    if ($LASTEXITCODE) { throw 'packing dist failed' }

    # Into a directory of the stack's own, not /tmp with names anyone could
    # guess.
    Remote @'
set -eu
install -d -m 0700 /opt/stacks/uleditor/incoming
true #
'@
    & $scp @opts -q $bundle deploy/web/compose.yml deploy/web/Caddyfile 'server:/opt/stacks/uleditor/incoming/'
    if ($LASTEXITCODE) { throw 'the upload failed' }
    Remove-Item $bundle

    Remote @'
set -eu
dir=/opt/stacks/uleditor
in="$dir/incoming"
install -m 0644 "$in/compose.yml" "$dir/compose.yml"
install -m 0644 "$in/Caddyfile" "$dir/Caddyfile"
rm -rf "$dir/site.new"
mkdir "$dir/site.new"
tar -xzf "$in/uleditor-web.tgz" -C "$dir/site.new"
chmod -R a+rX "$dir/site.new"
rm -f "$in/uleditor-web.tgz" "$in/compose.yml" "$in/Caddyfile"
rm -rf "$dir/site.old"
[ -d "$dir/site" ] && mv "$dir/site" "$dir/site.old"
mv "$dir/site.new" "$dir/site"
cd "$dir"
docker compose up -d --force-recreate --quiet-pull
echo "deployed: $(du -sh site | cut -f1)"

# The shared Caddy serves every *.truss site, so its file is never left in a
# state it would not start from: a change that does not validate, or does not
# reload, is put back. With cp, into the same inode — the file is a single-file
# bind mount, and after an mv the container would go on seeing the old one.
shared=/opt/stacks/caddy/Caddyfile
if ! grep -q '^uleditor.truss {' "$shared"; then
  bak="$shared.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$shared" "$bak"
  printf '\nuleditor.truss {\n\ttls internal\n\treverse_proxy uleditor:8080\n}\n' >> "$shared"
  if ! docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
    || ! docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cp "$bak" "$shared"
    echo "the shared Caddyfile did not take the change and is as it was" >&2
    exit 1
  fi
  echo "the shared Caddy now serves uleditor.truss"
fi
true #
'@

    # What is served, asked of the shared Caddy on the server itself — and a
    # deploy that is not healthy or not answering is a failed deploy.
    Remote @'
set -eu
state=starting
for i in $(seq 1 20); do
  state=$(docker inspect -f '{{.State.Health.Status}}' uleditor)
  [ "$state" = healthy ] && break
  sleep 3
done
echo "container: $state"
[ "$state" = healthy ] || { echo "the container is not healthy" >&2; exit 1; }
status() { curl -sk --resolve uleditor.truss:443:127.0.0.1 -o /dev/null -w '%{http_code}' "https://uleditor.truss$1"; }
headers() { curl -sk --resolve uleditor.truss:443:127.0.0.1 -o /dev/null -D - "https://uleditor.truss$1"; }
for path in / /wasm/ul_image_bg.wasm; do
  code=$(status "$path")
  echo "$path $code"
  [ "$code" = 200 ] || { echo "$path answered $code" >&2; exit 1; }
done
[ "$(status /assets/missing-00000000.js)" = 404 ] || { echo "a missing asset is not a 404" >&2; exit 1; }
headers / | grep -i -E '^content-security-policy|^cache-control'
headers /wasm/ul_image_bg.wasm | grep -i '^content-type'
true #
'@
}
finally {
    Pop-Location
}

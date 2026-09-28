# Puts the browser build on the server: https://uleditor.truss:8443 (ADR 0002, step 7).
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
#   pwsh tools/deploy-web.ps1 -ServiceWorkerOff
#       ship sw/off.js as /sw.js: every browser that has the service worker
#       deletes ulEditor's caches, unregisters it and reloads its tabs from
#       the server. Deleting sw.js does not do that. It does not reach the
#       browser's HTTP cache — see sw/off.js. A later plain deploy brings the
#       worker back.
param([switch]$SkipBuild, [switch]$ServiceWorkerOff)

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
    foreach ($needed in 'index.html', 'sw.js', 'wasm/ul_image_bg.wasm', 'ocr/manifest.json') {
        if (-not (Test-Path "packages/shell-ui/dist/$needed")) { throw "dist has no $needed — build first" }
    }

    # Into the bundle only: dist keeps the real worker, so a later -SkipBuild
    # does not ship the off switch again by accident.
    $worker = [IO.File]::ReadAllBytes("$root/packages/shell-ui/dist/sw.js")
    if ($ServiceWorkerOff) {
        Copy-Item packages/shell-ui/sw/off.js packages/shell-ui/dist/sw.js -Force
        Write-Host 'shipping the off switch as /sw.js'
    }

    $bundle = Join-Path ([IO.Path]::GetTempPath()) 'uleditor-web.tgz'
    # Windows' own tar: a Git Bash on the PATH brings GNU tar, which reads
    # `C:` in the path as the name of a remote host. No source maps: they
    # carry the source as it stood in the working tree, committed or not.
    & "$env:SystemRoot\System32\tar.exe" -czf $bundle --exclude '*.map' -C packages/shell-ui/dist .
    $packed = $LASTEXITCODE
    [IO.File]::WriteAllBytes("$root/packages/shell-ui/dist/sw.js", $worker)
    if ($packed) { throw 'packing dist failed' }

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

# The container's one network is made once, by hand, outside both stacks
# (ADR 0002, step 7). Not made here: a network the shared Caddy is not on
# would take the site down, and joining the Caddy to it is a change to the
# shared stack, not to this one. Checked before anything on the host is
# touched, so a refused deploy leaves the site as it was.
net=caddy-uleditor
if [ "$(docker network inspect -f '{{.Internal}}' $net 2>/dev/null)" != true ]; then
  echo "$net is missing or not internal: docker network create --internal $net" >&2
  exit 1
fi
if ! docker network inspect -f '{{range .Containers}}{{println .Name}}{{end}}' $net | grep -qx caddy; then
  echo "the shared Caddy is not on $net: docker network connect $net caddy, and list it in /opt/stacks/caddy/compose.yml" >&2
  exit 1
fi

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
# Present is whatever block proxies to this container, however its address is
# written: the sites moved to :8443 on 2026-09-28, and the list that redirects
# the old portless links names uleditor.truss too without serving it.
shared=/opt/stacks/caddy/Caddyfile
if ! grep -q 'reverse_proxy uleditor:8080' "$shared"; then
  bak="$shared.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$shared" "$bak"
  printf '\nuleditor.truss:8443 {\n\ttls internal\n\treverse_proxy uleditor:8080\n}\n' >> "$shared"
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
site=uleditor.truss:8443
status() { curl -sk --resolve $site:127.0.0.1 -o /dev/null -w '%{http_code}' "https://$site$1"; }
headers() { curl -sk --resolve $site:127.0.0.1 -o /dev/null -D - "https://$site$1"; }
for path in / /sw.js /wasm/ul_image_bg.wasm; do
  code=$(status "$path")
  echo "$path $code"
  [ "$code" = 200 ] || { echo "$path answered $code" >&2; exit 1; }
done
for path in /assets/missing-00000000.js /wasm/missing.wasm /ocr/missing.js; do
  [ "$(status $path)" = 404 ] || { echo "missing $path is not a 404" >&2; exit 1; }
done
headers / | grep -i -E '^content-security-policy|^cache-control'
headers /wasm/ul_image_bg.wasm | grep -i '^content-type'

# The isolation, shown rather than assumed. The container is on its one
# network; the same probe that must fail below first reaches the site itself,
# so a refused exec or a missing wget cannot pass for "isolated"; there is no
# default route to try, rather than one remote host that happened not to
# answer; and a neighbour on `proxy` is asked by its address, not its name —
# a name would fail on DNS alone and say nothing of the bridge's firewall.
nets=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' uleditor)
[ "$nets" = "caddy-uleditor " ] || { echo "uleditor is on: $nets" >&2; exit 1; }
probe() { docker exec uleditor wget -q -T 3 -O /dev/null "$1" 2>/dev/null; }
probe http://127.0.0.1:8080/ || { echo "the probe cannot reach the site itself" >&2; exit 1; }
# A default route, v4 or v6; the kernel's unreachable v6 default on `lo` is not one.
routes=$(docker exec uleditor cat /proc/net/route /proc/net/ipv6_route 2>/dev/null || true)
if echo "$routes" | grep -v '[[:space:]]lo$' | grep -qE '^[^[:space:]]+[[:space:]]+00000000[[:space:]]|^0{32} 00 '; then
  echo "uleditor has a default route" >&2; exit 1
fi
dockge=$(docker inspect -f '{{with index .NetworkSettings.Networks "proxy"}}{{.IPAddress}}{{end}}' dockge)
[ -n "$dockge" ] || { echo "no address for dockge on proxy to probe" >&2; exit 1; }
probe "http://$dockge:5001/" && { echo "uleditor reaches dockge at $dockge" >&2; exit 1; }
echo "isolated: no default route, dockge at $dockge unreachable"
true #
'@
}
finally {
    Pop-Location
}

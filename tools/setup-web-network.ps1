# Once, before the first deploy onto it: the web container's own network
# (ADR 0002, step 7).
#
# Makes `caddy-uleditor` with --internal, lists it in the shared Caddy's
# compose file (with a dated .bak beside it, put back if the file does not
# validate), and joins the running Caddy to it without restarting it, so no
# other *.truss site stops. Every step is skipped when it is already done,
# so running it again changes nothing. Then `pnpm deploy:web` moves the
# container onto it and shows the isolation.
#
#   pwsh tools/setup-web-network.ps1
#
# Adding the network changes the Caddy compose file's hash: the next
# `docker compose up -d` in /opt/stacks/caddy recreates the Caddy, a few
# seconds without any *.truss site. Expected, and not done here.

$ErrorActionPreference = 'Stop'
$ssh = 'C:\WINDOWS\System32\OpenSSH\ssh.exe'
$opts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8')

$script = @'
set -eu
net=caddy-uleditor
compose=/opt/stacks/caddy/compose.yml

# 1. The network. One that exists but is not internal is not taken as it is.
internal=$(docker network inspect -f '{{.Internal}}' $net 2>/dev/null || true)
if [ -z "$internal" ]; then
  docker network create --internal $net >/dev/null
  echo "made $net (internal)"
elif [ "$internal" != true ]; then
  echo "$net exists and is not internal; remove it by hand first" >&2
  exit 1
else
  echo "$net is there, internal"
fi

# 2. The shared Caddy's compose file lists it, so a recreate keeps it.
if grep -q "^  $net:" "$compose"; then
  echo "the Caddy compose file already lists $net"
else
  bak="$compose.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$compose" "$bak"
  python3 - "$compose" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
svc_old = "    networks:\n      - proxy\n"
svc_new = ("    networks:\n      - proxy\n"
           "      # ulEditor's static site only; internal, see /opt/stacks/uleditor.\n"
           "      - caddy-uleditor\n")
net_old = "networks:\n  proxy:\n    external: true\n"
net_new = net_old + ("  caddy-uleditor:\n"
                     "    # If it is ever gone: docker network create --internal caddy-uleditor\n"
                     "    external: true\n")
if s.count(svc_old) != 1 or s.count(net_old) != 1 or not s.endswith(net_old):
    sys.exit("the Caddy compose file is not laid out as expected; nothing changed")
open(p, "w").write(s.replace(svc_old, svc_new).replace(net_old, net_new))
PY
  if ! (cd /opt/stacks/caddy && docker compose config -q); then
    cp -p "$bak" "$compose"
    echo "the Caddy compose file did not validate and is as it was" >&2
    exit 1
  fi
  echo "listed $net in the Caddy compose file ($bak beside it)"
fi

# 3. The running Caddy joins it: no restart, the other sites keep serving.
if docker network inspect -f '{{range .Containers}}{{println .Name}}{{end}}' $net | grep -qx caddy; then
  echo "the Caddy is already on $net"
else
  docker network connect $net caddy
  echo "the Caddy joined $net"
fi

echo "on $net: $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' $net)"
true #
'@

($script -replace "`r", '') | & $ssh @opts server 'bash -s'
if ($LASTEXITCODE -ne 0) { throw "the server step failed ($LASTEXITCODE)" }
Write-Host 'next: pnpm deploy:web'

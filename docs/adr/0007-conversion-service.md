# ADR 0007 — The conversion service: not now; a drawing's own preview instead

**Status:** proposed 2026-10-08. Čovik asked the same day for all open work
to go ahead without waiting, so the steps for now are built on the
recommended answers to the three questions at the end; his answers can still
reverse them.
**Date:** 2026-10-08
**Context:** card 447, after card 505. Depends on ADR 0002 (the web target,
which left the backend out of phase 3) and ADR 0003 (the phone first).
Decided by the architect on Opus.

## The problem

On the web, `.cdr`, `.eps`, `.ps` and a PostScript `.ai` do not open: the web
build's conversion service is `NoConversion`
([host/index.ts:122](../../packages/shell-ui/src/host/index.ts),
[services.ts:309-321](../../packages/shell-ui/src/host/services.ts)), and
LibreOffice runs only through `ul-convert` on the desktop. Card 447 asks for
LibreOffice in Docker on server.truss, reached over HTTP.

Card 505 measured why that is the largest attack surface the web target could
add. LibreOffice decides what a document is by its content, imports HTML
wearing a `.cdr` name as a web page, and fetches its linked images, query
string and all; a fresh profile, macros off and "update links = never" do not
stop it. 0d32887 and 33cbdc1 close that on the desktop with a gate on the
first bytes of a private copy. And LibreOffice hands PostScript to whichever
of pstoedit, Ghostscript and ImageMagick it finds on the PATH (measured
2026-10-08; the desktop now gives it the system's folders only).

What had not been measured is what a conversion gives.

## What was measured (2026-10-08)

- **The files**, by extension and first bytes over Documents, Downloads and
  Desktop, as ADR 0003 counted them: 13 `.eps` with a DOS EPS header, each
  carrying a TIFF preview and none a WMF; 2 `.eps` and 3 `.ai` that are
  PostScript with no preview; 1 `.cdr`, a ZIP — CorelDRAW X6 or later — which
  the gate refuses on purpose. The 126 `.ai` that are PDF open everywhere
  already. The largest of the 19 is 14,834,176 bytes.
- **What LibreOffice makes of them.** One of each kind, converted with
  `ul-convert`'s own arguments and a fresh profile by LibreOffice 26.8 on a
  machine with no Ghostscript, pstoedit or ImageMagick: the DOS EPS becomes
  its stored TIFF preview, a small dithered thumbnail (9,400 bytes, 3.7 s);
  the PostScript EPS becomes LibreOffice's placeholder, a frame with the
  file's title, creator, date and language level (15,020 bytes, 0.8 s).
  Neither is the drawing.
- **Why**, in LibreOffice's `ieps.cxx`: a DOS EPS with a WMF or TIFF preview
  is imported as that preview, and the external renderers are tried only
  `if (!bHasPreview)` — pstoedit, then `gs` with `-dPARANOIDSAFER`, then
  ImageMagick's `convert`, then `MakePreview`, the placeholder. Ghostscript,
  where installed, serves the 5 preview-less PostScript files and never the
  13 others.
- **The server**: Debian 13 with Docker and runc (the measured details are
  on the wiki, not in this public repository). Debian's
  `libreoffice-draw-nogui` (4:25.2.3-2+deb13u8) depends on libcdr and on no
  PostScript interpreter.

A service with LibreOffice alone would therefore show what the desktop
shows: 13 thumbnails, 5 placeholders and a refusal. A drawing would appear
for at most 5 files, and only with Ghostscript running a stranger's
PostScript on the server.

## Decision

**The conversion service is not built now.** Instead:

- **The stored preview is shown without LibreOffice, everywhere.**
  `ul_image::preview` learns the DOS EPS container: magic `C5 D0 D3 C6`, the
  TIFF section's offset at bytes 20–23 and its length at 24–27,
  little-endian. It cuts the TIFF out with checked bounds and previews it
  under the limits it already has. The desktop's `image_preview`
  ([lib.rs](../../apps/desktop/src-tauri/src/lib.rs)) and the web's
  worker ([wasm-images.ts](../../packages/shell-ui/src/host/wasm-images.ts))
  hand `preview` whatever bytes they read and do not look at the extension,
  so neither changes, and `ImageService.preview` is in the contract already
  ([host.ts](../../packages/plugin-sdk/src/host.ts)). On the web and the
  phone the 13 files show the picture the desktop's LibreOffice gives. ulul,
  where `images` is a `No*` stub (Kapa ADR 0001), shows the explanation.
- **A PostScript file without a preview shows what the placeholder shows** —
  its `%%Title`, `%%Creator`, `%%CreationDate` and `%%BoundingBox`, read from
  its first 4 KiB as text — and says it is a program this build does not run.
- **No message off the desktop says to install LibreOffice.**
- **The service's shape is decided now**, below, so that the reasoning is
  not redone when a trigger fires.

### When it is built: the triggers

1. **A second host needs it**: ulul takes CorelDRAW or PostScript
   attachments, other people's too.
2. **The desktop proves a drawing**: a live test on the desktop shows the
   drawing — not a preview, not the placeholder — for the format the service
   would serve. For PostScript that means a PostScript interpreter on the
   desktop first (card 505); for CorelDRAW, a `.cdr` the gate accepts.
3. **The need is counted**: a count by ADR 0003's method finds more than 20
   preview-less PostScript and CorelDRAW files (6 today), or card 447 records
   three occasions on which one was needed away from the desk.

### When it is built: the shape

- **Same origin, the stack's own Caddy in front.**
  `POST https://uleditor.truss:8443/api/convert/v1/pdf`: the web build's
  `connect-src 'self'` covers it and the shared Caddy does not change. The
  `uleditor` container that serves the site proxies the path.
- **A network of its own, with one neighbour.** The converter is on
  `uleditor-convert`, made once by hand with `--internal`, and on nothing
  else; its one neighbour is the site container. Not on `caddy-uleditor`:
  from there it would reach the shared Caddy, and through it every `*.truss`
  site. Not on `proxy`.
- **One container; nothing outlives a conversion.** The server is the
  container's PID 1 and converts one file at a time; a second request is
  answered 429. Each conversion gets a fresh directory on tmpfs for the
  profile, the input, the output and `HOME`. After every conversion, whatever
  its outcome, PID 1 sends SIGKILL to every other process in the container
  (`kill(-1, …)` spares only the caller and init, and here they are one),
  reaps them, and empties every writable mount. It makes itself non-dumpable,
  so a LibreOffice running as the same user cannot attach to it. It exits on
  SIGTERM.
- **No interpreter in the image.** Debian's `libreoffice-draw-nogui`, pinned,
  on a pinned `debian:trixie-slim`; the build fails if `gs`, `pstoedit`,
  `convert` or `magick` exist. Ghostscript comes in only on question 2.
- **The server's gate is the desktop's without PDF**: PostScript, a DOS EPS,
  a RIFF CorelDRAW. The web opens a PDF with pdf.js and has no reason to send
  one. The file is staged as `drawing.<kind>`; no name is ever sent.
- **Who may call it.** The browser, with HTTP Basic credentials checked by
  Caddy's `basic_auth` before a byte reaches the converter, which never sees
  the header (`header_up -Authorization`). The hash is in
  `/opt/stacks/uleditor/.env` and reaches Caddy as `{env.CONVERT_HASH}`,
  never through git; the password is in the password manager. The page never holds
  it: the browser asks in its own dialog. One credential, for this alone;
  ulul's worker would get its own.
- **Limits.** Caddy: `request_body max_size 32MB` — 32,000,000 bytes, more
  than twice the largest real file — answers 413, and
  `response_header_timeout 90s`. The service: headers within 5 s and 8 KiB,
  `Content-Length` required (411), the body within 30 s, the conversion
  within 60 s, no PDF over 64 MiB sent. The container: 1 GiB without swap,
  1.5 CPUs, 256 processes and threads. No rate-limit plugin — the pinned
  Caddy image has none — and one conversion at a time is the limit.
- **Logs**: one line per request — time, route, bytes in, which signature
  matched, outcome, milliseconds, bytes out. Never the bytes, a name, a
  header, or what LibreOffice wrote on stderr. `json-file`, 1 MB × 3.
- **The answer is untrusted too.** It must begin `%PDF-`; the page opens it
  read-only, from memory, in the PDF viewer that already opens PDFs from
  anywhere, under `script-src 'self'`.
- **A ulul `servis`**: `GET /api/convert/health`, `GET /api/convert/meta`
  (name, version, LibreOffice's version, the three signatures, data class
  `privatno`, network: none), `POST /api/convert/v1/pdf`, and a `MODUL.md`.

## Rejected

| Option | A hostile file gets | A device on the LAN gets | Cost for one person | Verdict |
| --- | --- | --- | --- | --- |
| (a) Do not build, and say so | nothing new | nothing new | one string and its translation | taken, with (g) |
| (b) A long-running LibreOffice behind Caddy, every file fed to one office process | code that stays for every later conversion, sees later uploads and shapes later answers; on a network with the shared Caddy, every `*.truss` site through it | without a password, the right to feed it | least to build with a ready-made image, which is a third party's image with routes beyond these formats (none verified here) | no: nothing separates one conversion from the next |
| (c) `docker run --rm` per conversion, started by a front service | a fresh box | whoever takes the front service, the part that reads the LAN's requests, has the Docker API: root on the server | the Docker socket in a container, which the house rules forbid | no |
| (c') The same box restarted by Docker after each conversion | as (c), without the socket | as below | Docker's documentation does not say how soon a container that lived under ten seconds is restarted | not chosen: PID 1 gives the same guarantee, deterministically |
| (d) gVisor (`runsc` 0.0~20240729.0-4+b7 is in Debian 13) or a microVM (`/dev/kvm` is there; Firecracker and Kata are not packaged) | a box whose kernel is in user space or a VM: an escape needs a second bug | as below | a runtime in `/etc/docker/daemon.json` on a host shared by every stack; a 2024 gVisor snapshot as the boundary; LibreOffice under it unmeasured | the path when the service takes other people's files (trigger 1), not now |
| (e) In the browser, as WebAssembly | a worker's sandbox | nothing | no WASM build of LibreOffice, libcdr or Ghostscript is in `Cargo.lock` or `pnpm-lock.yaml`; Ghostscript is AGPL-3.0, kept out of `deny.toml` on purpose; porting libcdr and librevenge is a project | no |
| (f) Convert on the desktop and carry the PDF | nothing new | nothing | a manual step per file; no "save a copy" exists for a converted tab | superseded: that PDF is the stored preview or the placeholder, which (g) shows directly |
| (g) Show the stored preview and the DSC header, without LibreOffice | ul-image's decoders under their limits, as for any TIFF opened today | nothing | some fifty lines of Rust, a text view, one review | taken |
| A Unix socket instead of a network (`network_mode: none`) | as below | as below | Docker says tmpfs mounts cannot be shared between containers; a tmpfs-type named volume is unverified; a bind mount would sit on the server's root file system | not chosen: the internal network reaches the same one container, and its probes exist |

## What changes for the person

- In the browser and on the phone, an `.eps` with a stored preview shows it,
  at its own size, labelled "The preview stored in the file — not the
  drawing itself". The desktop shows the same at once, with "Open through
  LibreOffice" still below it where LibreOffice is installed; that gives the
  same picture as a PDF.
- A PostScript file with no preview shows its title, program, date and size,
  and says this build does not run PostScript. On the desktop LibreOffice
  makes a placeholder of the same facts.
- A CorelDRAW file says only the desktop app reads it, through LibreOffice.
- No message in a browser or on a phone says to install LibreOffice.
- Nothing is sent to the server.

## Steps — now

1. *[F3]* This ADR, accepted on Čovik's answers.
2. *[F2]* `crates/ul-image/src/lib.rs`: `preview` reads the DOS EPS container
   with `get` and `checked_add`, so that nothing panics (`panic = "abort"`
   freezes a WASM instance, ADR 0002 step 4). Tests: a specimen the test
   builds (header and a small TIFF); an offset past the end; an offset and
   length that overflow; a length of zero; a WMF section only, refused with
   a message; a section that is not a TIFF; and every truncation of the
   specimen, each an error and none a panic. The WASM module is rebuilt;
   `image_preview` and the worker do not change.
3. *[F2]* `packages/editor-vector/src/eps.ts`, pure and without the DOM:
   `isDosEps(bytes)` and `dscFields(bytes)` — the first 4 KiB, `%%` lines
   only, printable ASCII, 200 characters each — tested in Node. `index.ts`
   draws the preview from `host.images.preview?.(doc.uri)` into an `<img>`
   from a `blob:` URL (`img-src` allows it; revoked on unmount), with its
   label, or the fields as `textContent`.
4. *[F1]* `editor-vector` says what is true everywhere ("LibreOffice is not
   available here. The desktop app converts this format when LibreOffice is
   installed."). `shell/actions.ts`, on the web and on a phone, says the
   desktop app is needed and offers no download. `hr.json` in the same
   change; `pnpm verify:i18n`.
5. *[F2]* A web check opens a DOS EPS specimen and finds the preview drawn
   and labelled, and a PostScript specimen with its title and no LibreOffice
   advice. A local run over the 13 real files — not in CI: the corpus is
   personal — finds all 13 previewed. Each check is proved by a mutation: an
   offset off by one, the label removed.
6. *[F4]* An independent review of steps 2 and 3.
7. *[F1]* The board: card 447 to `waiting` with the triggers; a card for what
   this found on the desktop; a dated note under ADR 0003's rejected row.

## Steps — when a trigger fires

1. *[F3]* This ADR reopened: which trigger, which formats, questions 2 and 3
   confirmed.
2. *[F0]* On the server, in a throwaway container with the flags below:
   Debian's LibreOffice on the specimens, its peak memory and time, and card
   505's fetch repeated against it (I-2's control).
3. *[F2]* `crates/ul-convert`: `service_kind(head)`, the gate less `%PDF-`,
   with its tests. `crates/ul-convert-serve`, a new binary with its
   `MODUL.md`: the PID 1 loop over `ul_convert::to_pdf`, and unit tests of
   the request reader against malformed requests.
4. *[F4]* `deploy/convert/Dockerfile`, `deploy/convert/compose.yml`, the
   network made once by hand (`docker network create --internal
   uleditor-convert`), `deploy/web/compose.yml` and `deploy/web/Caddyfile`;
   `/opt/stacks/uleditor/.env` written by Čovik.
5. *[F2]* `tools/deploy-convert.ps1` builds `ul-convert-serve` for
   `x86_64-unknown-linux-musl` here, ships it with the two files to
   `/opt/stacks/uleditor-convert`, builds and starts the container, and runs
   I-1 to I-11 on the server. `tools/deploy-web.ps1` expects two networks and
   gains I-1's probes for the site container.
6. *[F2]* `packages/shell-ui/src/host/http-convert.ts` (`HttpConversion`);
   the PDF opened read-only from memory; the button names the server
   ("Convert on server.truss — the file is sent there and not kept"). A web
   check (I-12). The phone is not part of this: its CSP and its trust of the
   internal CA are a step of their own.
7. *[F4]* An independent review of 3 to 6; two rounds expected, as in ADR
   0002. Ghostscript, if question 2 brings it, gets a round of its own.
8. *[F1]* Kapa: the STACK exception in `odluke/` (question 3), a row in
   `portfelj/MODULI.md`, and the wiki's documentation page.

### deploy/convert/Dockerfile (sketch)

    # ulEditor's conversion service (ADR 0007): LibreOffice Draw without a
    # GUI, and nothing that runs PostScript.
    FROM debian:trixie-slim@sha256:<read from the registry on the day>
    # As apt-cache offered it on server.truss, 2026-10-08. A security update
    # replaces it in the archive and this build fails: that is the reminder.
    ARG LO=4:25.2.3-2+deb13u8
    RUN apt-get update \
     && apt-get install -y --no-install-recommends \
          libreoffice-draw-nogui=${LO} \
          <a fonts package: to verify which one Draw needs> \
     && rm -rf /var/lib/apt/lists/* \
     && for p in gs pstoedit convert magick; do ! command -v "$p" || exit 1; done
    COPY ul-convert-serve /usr/local/bin/ul-convert-serve
    USER 10001:10001
    ENTRYPOINT ["/usr/local/bin/ul-convert-serve", "--listen", "0.0.0.0:8090"]

### deploy/convert/compose.yml (sketch)

    # ulEditor's conversion service (ADR 0007), at /opt/stacks/uleditor-convert.
    services:
      convert:
        build: .
        image: uleditor-convert:25.2.3-2-deb13u8
        container_name: uleditor-convert
        restart: unless-stopped
        user: "10001:10001"          # never root
        read_only: true
        tmpfs:                       # uid/gid on tmpfs: to verify
          - /work:size=256m,mode=0700,uid=10001,gid=10001
          - /tmp:size=64m,mode=0700,uid=10001,gid=10001
        shm_size: 16m
        environment:
          HOME: /work/home
        networks: [uleditor-convert]
        security_opt: [no-new-privileges:true]   # Docker's default seccomp and AppArmor stay
        cap_drop: [ALL]
        pids_limit: 256
        mem_limit: 1g
        memswap_limit: 1g
        cpus: 1.5
        ulimits:
          core: 0
          nofile: 1024
        logging:
          driver: json-file
          options: { max-size: "1m", max-file: "3" }
    networks:
      uleditor-convert:
        external: true   # made once by hand, --internal

### deploy/web (additions, sketch)

compose.yml, the `uleditor` service: `networks: [caddy-uleditor,
uleditor-convert]` (the second `external: true`), and
`environment: { CONVERT_USER: ${CONVERT_USER:?}, CONVERT_HASH: ${CONVERT_HASH:?} }`,
so that it does not start without them. In `.env` the hash is single-quoted:
it is full of `$` (to verify with `docker compose config`).

Caddyfile, before the last `handle`:

    # The conversion service (ADR 0007). Caddy asks for the password before
    # a byte reaches the converter, which never sees it.
    handle /api/convert/* {
        header Cache-Control "no-store"
        request_body {
            max_size 32MB
        }
        basic_auth argon2id {
            {env.CONVERT_USER} {env.CONVERT_HASH}
        }
        reverse_proxy uleditor-convert:8090 {
            header_up -Authorization
            transport http {
                dial_timeout 3s
                response_header_timeout 90s
            }
        }
    }

The hash is made with `caddy hash-password` inside the site container
(`--algorithm argon2id`: to verify).

### The tests that prove each property

Each is proved by the mutation named, in this repository's way.

- **I-1 No way out.** Inside the converter, no default route (v4 or v6); the
  probe reaches `uleditor:8080` first, so a broken probe cannot pass for
  isolation, then fails to reach the shared Caddy's address on
  `caddy-uleditor` and dockge's on `proxy`; its networks are exactly
  `uleditor-convert`. Mutation: add `proxy`.
- **I-2 LibreOffice's own fetch, past the gate.** `soffice --convert-to pdf`
  run straight on an HTML file whose `<img>` names a listener on `proxy`: a
  throwaway container of the same image on `bridge` reaches it (card 505,
  repeated on Debian's LibreOffice), the converter does not. Mutation: the
  converter on `bridge`.
- **I-3 The gate before LibreOffice.** HTML wearing a `.cdr`, and a `%PDF-`
  file: 415 each, `refused` in the log, no `soffice` started. Mutation: the
  desktop gate on the server.
- **I-4 No interpreter.** `gs`, `pstoedit`, `convert` and `magick` are absent;
  the preview-less PostScript specimen comes back as the placeholder; one
  that reads `(/etc/passwd) (r) file` and `(%pipe%id) (r) file` and shows
  what it read comes back without `root:` or `uid=`. Mutation: Ghostscript
  in the image.
- **I-5 Nothing outlives a conversion.** Before one, `docker exec -u 10001`
  starts `setsid sleep 600` and leaves a marker in `/work`, `/tmp` and
  `/dev/shm`; after it, neither. Mutations: no `kill(-1)`; no emptying.
- **I-6 PID 1 out of reach.** As 10001, `/proc/1/environ` is refused.
  Mutation: the non-dumpable call removed.
- **I-7 The hardening, shown.** `docker inspect`: user 10001, read-only
  root, `CapDrop` ALL and no `CapAdd`, not privileged, `no-new-privileges`,
  no `seccomp=unconfined`, the two tmpfs and no other mount, the limits.
  Inside: `CapEff` 0, `NoNewPrivs` 1, `Seccomp` 2, and `/proc/1/attr/current`
  names Docker's AppArmor profile (to verify that it is applied).
- **I-8 Limits.** 32,000,001 bytes: 413, and nothing in the converter's log.
  Chunked, straight to the service: 411. Two at once: one 429.
- **I-9 Who may call it.** No credentials, wrong ones, right ones: 401, 401,
  200, and neither 401 in the converter's log. Mutation: no `basic_auth`.
- **I-10 Logs.** After I-1 to I-9, the converter's and both Caddies' logs
  hold no marker planted in every specimen, no password and no
  `Authorization`. Mutation: the first 64 bytes logged.
- **I-11 The answer's shape** (Kapa SIGURNOST §8): it opens in pdf.js with at
  least one page.
- **I-12 The web, end to end.** Chromium with Playwright's `httpCredentials`:
  the PDF opens read-only from memory, the request carries no name, and the
  service worker kept nothing.

## How we will know this was right

- All 13 real DOS EPS files open with their preview in the web build and on
  the phone, and the corpus run is green.
- No string shown in a browser or on a phone advises installing LibreOffice.
- In the six months after step 2 ships, card 447 records fewer than three
  occasions on which a file this cannot show was needed away from the desk.
  At three, trigger 3 fires and the service is built as written here.

## Čovik's three questions

1. **Not now.** The previews and the honest messages now; the service waits
   for a trigger. *Recommendation: yes.*
2. **Ghostscript, if trigger 2 fires for PostScript, goes into the image,**
   inside the box above and through a review of its own. Without it the
   service draws none of the 19 files; with it, the 5 preview-less ones.
   *Recommendation: yes, and only then.*
3. **The service in Rust, reading HTTP with the standard library alone,** over
   `ul-convert`'s reviewed gate: an exception to Kapa STACK's Python and
   FastAPI for a `servis`, recorded in Kapa's `odluke/`. The Rust
   alternative, `hyper` (1.11 is in `Cargo.lock`, through `reqwest`), would
   be a new direct dependency with its runtime. *Recommendation: yes, the
   standard library alone; its only client is Caddy, after the password.*

## Sources

- LibreOffice EPS import (`ieps.cxx`): <https://docs.libreoffice.org/vcl/html/ieps_8cxx_source.html>
- Caddy `reverse_proxy`, `request_body`, `basic_auth`: <https://caddyserver.com/docs/caddyfile/directives/>
- Docker tmpfs mounts and restart policies: <https://docs.docker.com/engine/storage/tmpfs/>,
  <https://docs.docker.com/engine/containers/start-containers-automatically/>
- The server: `apt-cache policy`, `apt-cache depends` and `docker info` on
  server.truss, 2026-10-08.

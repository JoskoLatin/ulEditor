/**
 * What the page can reach on the network **past the CSP**, in the program as
 * it is installed.
 *
 * The CSP holds what it names — an image, a fetch, a WebSocket, a beacon. It
 * names nothing for the browser's own network hints, and Chromium implements
 * no CSP for WebRTC (`webrtc 'block'` is "Unrecognized" in WebView2 154).
 * Measured on 2026-10-08 (card 505), script in the page could, with no
 * gesture:
 *
 * - make the resolver look up any name — `<link rel=dns-prefetch>` and
 *   `preconnect`, in the page or in a `srcdoc` frame, an iframe or a form the
 *   CSP refuses (Chromium connects before it checks), and a STUN or TURN
 *   server's name. A name is a message: `secret.example.net` reaches whoever
 *   answers for `example.net`;
 * - open a TCP connection to any address: a preconnect, a refused iframe, a
 *   TURN server over TCP;
 * - and talk to any address in both directions over WebRTC — a peer
 *   connection needs no server at all when the page writes the other side's
 *   description itself.
 *
 * Two WebView2 switches close all of it (`additionalBrowserArgs` in
 * tauri.conf.json), each shown necessary by taking it away:
 *
 * - `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE …"` answers every name
 *   and every address the network service would connect to with "not found",
 *   except Google Fonts (ADR 0005) and `localhost` (the dev server; on an
 *   installed copy at most a connection to a local port, which leaves no
 *   machine);
 * - `--webrtc-ip-handling-policy=disable_non_proxied_udp` keeps WebRTC off
 *   UDP, and with no proxy off the network.
 *
 * So the check builds the program as it ships (`tauri build --debug
 * --no-bundle`; under `tauri dev` no CSP is sent at all) under an identifier
 * of its own, which leaves an ulEditor the person has open alone, and reads
 * two things: Chromium's NetLog for a DNS query for any of the names it made
 * up, and listeners of its own for any packet or connection to an address.
 * Both have a positive control, so a check that sees nothing can be told from
 * one that cannot see.
 *
 * Windows only, like the other desktop checks. The names end in `.invalid`,
 * which nothing answers for; a query that does leave goes no further than the
 * resolver saying so.
 *
 *   node tools/verify-desktop-egress.mjs            (builds first, ~1-2 min)
 *   node tools/verify-desktop-egress.mjs --no-build (the binary is current)
 */

import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildDesktop, startDesktop, stopDesktop } from './desktop-session.mjs';

const IDENTIFIER = 'org.uleditor.app.check';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* One made-up name per way out, so a query names the way that made it. */
const tag = Math.random().toString(36).slice(2, 10);
const NAMES = Object.fromEntries(
  [
    'dnsprefetch',
    'preconnect',
    'framedprefetch',
    'framedpreconnect',
    'iframe',
    'form',
    'image',
    'fetch',
    'socket',
    'beacon',
    'stun',
    'turn',
  ].map((way) => [way, `${way}-${tag}.invalid`]),
);

/* And one port per way out to an address. */
const PORTS = {
  stun: 34780,
  preconnect: 34781,
  iframe: 34782,
  peerUdp: 34783,
  peerTcp: 34784,
  turnTcp: 34785,
  control: 34786,
};

/* The machine's own LAN address where it has one, besides loopback: an
   address the resolver rules cannot tell from a stranger's. */
const lan =
  Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? null;

const reached = {};
const listeners = [];
for (const way of ['stun', 'peerUdp']) {
  /* Both families, as the TCP listeners below. */
  const socket = createSocket({ type: 'udp6', ipv6Only: false });
  socket.on('message', (msg, from) => (reached[way] ??= []).push(`${msg.length} B over UDP from ${from.address}`));
  await new Promise((r) => socket.bind(PORTS[way], '::', r));
  listeners.push(() => socket.close());
}
for (const way of ['preconnect', 'iframe', 'peerTcp', 'turnTcp', 'control']) {
  const server = createServer((conn) => {
    (reached[way] ??= []).push(`TCP from ${conn.remoteAddress}`);
    conn.on('error', () => {});
    setTimeout(() => conn.destroy(), 300);
  });
  /* Both families: `localhost`, the positive control, may be ::1 first, and
     the addresses tried include IPv6's loopback. */
  await new Promise((r) => server.listen(PORTS[way], '::', r));
  listeners.push(() => server.close());
}

if (!process.argv.includes('--no-build')) {
  console.log('building the program as it ships …');
  await buildDesktop(IDENTIFIER);
}

const netlog = join(await mkdtemp(join(tmpdir(), 'ul-egress-')), 'netlog.json');
let session;
const consoleLines = [];
try {
  session = await startDesktop({
    port: 9353,
    identifier: IDENTIFIER,
    built: true,
    browserArgs: [`--log-net-log=${netlog}`, '--net-log-capture-mode=Everything'],
  });
  const { page } = session;
  page.on('console', (m) => consoleLines.push(m.text()));
  check('attached to the program as it ships', page.url().startsWith('http://tauri.localhost'), page.url());

  /* The switches reach the browser only through tauri.conf.json, so the
     check reads them where they take effect: the browser process's own
     command line. */
  const browser = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*ul-profile-*' -and $_.CommandLine -notlike '*--type=*' } | " +
        'Select-Object -ExpandProperty CommandLine',
    ],
    { encoding: 'utf8' },
  ).stdout;
  check(
    'the browser runs with the resolver rules',
    /--host-resolver-rules="MAP \* ~NOTFOUND/.test(browser),
  );
  check('and with no proxy to hand names to', /--no-proxy-server/.test(browser));
  check(
    'and with WebRTC kept off UDP',
    /--webrtc-ip-handling-policy=disable_non_proxied_udp/.test(browser),
  );

  /* An address in a URL is written in brackets when it is IPv6, and in a
     description without. */
  /* And loopback in another spelling, kept to catch the rules narrowed from
     `*` to the obvious forms. */
  const addresses = ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', ...(lan ? [lan] : [])];
  const said = await page.evaluate(
    async ({ n, P, addresses }) => {
      const out = {};
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const link = (rel, href) => {
        const l = document.createElement('link');
        l.rel = rel;
        l.href = href;
        document.head.append(l);
      };

      /* The positive control for addresses: the one host the rules let
         through, so a connection from the page is seen when there is one. */
      link('preconnect', `http://localhost:${P.control}/`);
      /* And for names: the one the rules let through, which only asks the
         resolver — the application looks it up anyway when the person turns
         Google Fonts on. */
      link('dns-prefetch', 'https://fonts.gstatic.com/');

      link('dns-prefetch', `https://${n.dnsprefetch}/`);
      link('preconnect', `https://${n.preconnect}/`);
      const framed = document.createElement('iframe');
      framed.srcdoc = `<link rel="dns-prefetch" href="https://${n.framedprefetch}/"><link rel="preconnect" href="https://${n.framedpreconnect}/">`;
      document.body.append(framed);
      const refused = document.createElement('iframe');
      refused.src = `https://${n.iframe}/`;
      document.body.append(refused);
      const sink = document.createElement('iframe');
      sink.name = 'egress-sink';
      document.body.append(sink);
      const form = document.createElement('form');
      form.method = 'POST';
      form.target = 'egress-sink';
      form.action = `https://${n.form}/`;
      document.body.append(form);
      form.submit();
      new Image().src = `https://${n.image}/x.png`;
      await fetch(`https://${n.fetch}/`).catch(() => {});
      try {
        new WebSocket(`wss://${n.socket}/`);
      } catch {}
      navigator.sendBeacon(`https://${n.beacon}/`, 'x');

      for (const address of addresses) {
        link('preconnect', `http://${address}:${P.preconnect}/`);
        const frame = document.createElement('iframe');
        frame.src = `http://${address}:${P.iframe}/`;
        document.body.append(frame);
      }

      const gather = async (iceServers) => {
        const pc = new RTCPeerConnection({ iceServers });
        pc.createDataChannel('x');
        await pc.setLocalDescription(await pc.createOffer());
        await wait(2500);
        pc.close();
      };
      await gather([{ urls: `stun:${n.stun}:3478` }]);
      await gather([{ urls: `turn:${n.turn}:443?transport=tcp`, username: 'u', credential: 'c' }]);
      for (const address of addresses) {
        await gather([{ urls: `stun:${address}:${P.stun}` }]);
        await gather([{ urls: `turn:${address}:${P.turnTcp}?transport=tcp`, username: 'u', credential: 'c' }]);

        /* The other side's description written by the page itself: no
           signalling server, nobody else involved. */
        const pc = new RTCPeerConnection();
        pc.createDataChannel('x');
        await pc.setLocalDescription(await pc.createOffer());
        const fingerprint = pc.localDescription.sdp.match(/a=fingerprint:(.*)/)[1];
        await pc.setRemoteDescription({
          type: 'answer',
          sdp: [
            'v=0',
            'o=- 1 2 IN IP4 127.0.0.1',
            's=-',
            't=0 0',
            'a=group:BUNDLE 0',
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
            'c=IN IP4 0.0.0.0',
            'a=ice-ufrag:abcd',
            'a=ice-pwd:abcdefghijklmnopqrstuvwx',
            `a=fingerprint:${fingerprint}`,
            'a=setup:active',
            'a=mid:0',
            'a=sctp-port:5000',
            `a=candidate:1 1 udp 2122260223 ${address.replace(/[[\]]/g, '')} ${P.peerUdp} typ host`,
            `a=candidate:2 1 tcp 1518280447 ${address.replace(/[[\]]/g, '')} ${P.peerTcp} typ host tcptype passive`,
            '',
          ].join('\r\n'),
        });
        await wait(3000);
        pc.close();
      }

      out.ipc = await window.__TAURI_INTERNALS__.invoke('devtools_available').then(
        () => true,
        () => false,
      );
      return out;
    },
    { n: NAMES, P: PORTS, addresses },
  );
  check('the program still answers the page', said.ipc === true);
  await sleep(3000);
} catch (err) {
  check('the run itself', false, err.message);
} finally {
  await stopDesktop(session);
  for (const close of listeners) close();
}

/* The NetLog is written as the browser goes; one that was cut short lacks
   its closing brackets. */
let events = [];
let types = {};
try {
  let text = (await readFile(netlog, 'utf8')).trim();
  if (!text.endsWith('}')) text = text.replace(/,\s*$/, '') + ']}';
  let log;
  try {
    log = JSON.parse(text);
  } catch {
    log = JSON.parse(text.replace(/,\s*\]\}$/, ']}'));
  }
  events = log.events;
  types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
} catch (err) {
  check('the NetLog was written and read', false, err.message);
}
check('the NetLog holds the run', events.length > 100, `${events.length} events`);

/* A name is a leak if any resolver event carries it — a DNS transaction of
   Chromium's own, or the system's resolver it falls back to when it cannot
   read the DNS settings (a VPN's rules, say), which runs no transaction at
   all. Under the rules a made-up name reaches no resolver event: measured,
   it is in none (the review of card 505). */
const queried = new Set();
let controlQueried = false;
for (const event of events) {
  if (!/^(HOST_RESOLVER|DNS_)/.test(types[event.type] ?? '')) continue;
  const params = JSON.stringify(event.params ?? {});
  for (const [way, name] of Object.entries(NAMES)) if (params.includes(name)) queried.add(way);
  if (params.includes('fonts.gstatic.com')) controlQueried = true;
}

check(
  'positive control: a name the page has looked up is seen',
  controlQueried,
  controlQueried ? '' : 'no query for fonts.gstatic.com — the check cannot see names',
);

check(
  'positive control: a connection from the page to a listener is seen',
  (reached.control ?? []).length > 0,
  (reached.control ?? []).join(', ') || 'nothing arrived — the check cannot see connections',
);
check(
  'positive control: the CSP is in force',
  consoleLines.some((l) => /violates the following Content Security Policy/.test(l)),
);

const LABELS = {
  dnsprefetch: 'a <link rel=dns-prefetch>',
  preconnect: 'a <link rel=preconnect>',
  framedprefetch: 'a dns-prefetch in a srcdoc frame',
  framedpreconnect: 'a preconnect in a srcdoc frame',
  iframe: 'an iframe the CSP refuses',
  form: 'a form posted into a frame',
  image: 'an image',
  fetch: 'a fetch',
  socket: 'a WebSocket',
  beacon: 'a beacon',
  stun: "a STUN server's name",
  turn: "a TURN server's name",
};
for (const [way, label] of Object.entries(LABELS)) {
  check(`no name goes out through ${label}`, !queried.has(way), queried.has(way) ? NAMES[way] : '');
}

const ADDRESS_LABELS = {
  preconnect: 'a preconnect to an address',
  iframe: 'an iframe to an address',
  stun: 'a STUN server at an address (UDP)',
  turnTcp: 'a TURN server at an address (TCP)',
  peerUdp: "a peer connection the page described itself (UDP)",
  peerTcp: "a peer connection the page described itself (TCP)",
};
for (const [way, label] of Object.entries(ADDRESS_LABELS)) {
  check(`nothing reaches ${label}`, !reached[way], (reached[way] ?? []).slice(0, 2).join(', '));
}
if (!lan) console.log('  (no LAN address here: the addresses were tried on loopback only)');

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);

/**
 * How long the application takes to start, **as installed**.
 *
 * The plan's last unmeasured budget is "cold start < 1.5 s". It stayed
 * unmeasured because it needs a release build on a computer somebody uses:
 * `tauri dev` is a debug build behind a Vite server, and a CI runner is not a
 * computer anybody uses. The installer the updater hands out is both, so this
 * starts that — `%LOCALAPPDATA%\ulEditor\uleditor-desktop.exe`, where the NSIS
 * installer puts it — or whatever `--exe` names.
 *
 * What is timed is what a person waits for: from the process being started to
 * the first frame with the application in it. `index.html` is an empty
 * `#root`, so the first contentful paint is React's first render of the shell,
 * not a splash. Both ends are wall-clock milliseconds on the same machine —
 * `Date.now()` here, `performance.timeOrigin + startTime` in the webview — so
 * how long the debugging connection takes to come up is not in the figure.
 *
 * The first start is on an empty profile, which is what the very first launch
 * after installing costs: WebView2 builds its profile then. Every start after
 * it reuses that profile, which is what every other launch costs. The profile
 * is a scratch one, never the person's own, so nothing of theirs is restored
 * into the measurement and nothing of the measurement lands in their recent
 * list. The file cache is warm after the first start; a start after a reboot
 * is not what this measures, and it says so rather than pretending.
 *
 *   node tools/cold-start.mjs [--exe path] [--runs 10]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALREADY_RUNNING, alreadyRunning, killTree } from './desktop-session.mjs';

const BUDGET_MS = 1500;

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const exe = option('--exe', join(process.env.LOCALAPPDATA ?? '', 'ulEditor', 'uleditor-desktop.exe'));
const runs = Number(option('--runs', 10));
const port = 9344;

if (!existsSync(exe)) {
  console.error(`no application at ${exe} — install a release, or name one with --exe`);
  process.exit(2);
}
if (alreadyRunning()) {
  console.error(ALREADY_RUNNING);
  process.exit(2);
}

const profile = await mkdtemp(join(tmpdir(), 'ul-cold-start-'));

/** One start: from spawn to the first contentful paint, and to the page beginning to load. */
async function start() {
  const started = Date.now();
  const app = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: 'ignore',
  });
  try {
    /* Attaching is retried until the port opens; what happens once attached
       is not, so a wrong clock or a missing shell is an error and not a retry. */
    let browser;
    while (!browser) {
      if (Date.now() > started + 60_000) throw new Error('WebView2 never opened a debugging port');
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
      if (!browser) await new Promise((r) => setTimeout(r, 100));
    }
    try {
      const context = browser.contexts()[0];
      const page = context?.pages()[0] ?? (await context.waitForEvent('page'));
      await page.waitForSelector('.shell', { timeout: 30_000 });
      const paint = await page.evaluate(
        () =>
          new Promise((done) => {
            const settle = () => {
              const entry = performance.getEntriesByName('first-contentful-paint')[0];
              if (entry) done({ origin: performance.timeOrigin, at: entry.startTime, now: Date.now() });
              else requestAnimationFrame(settle);
            };
            settle();
          }),
      );
      /* The two ends are read off two clocks said to be the same wall clock,
         and this is where that is checked rather than assumed: the page's
         `Date.now()` against this one's, a round trip apart. */
      const skew = Math.abs(Date.now() - paint.now);
      if (skew > 250) throw new Error(`the webview's clock is ${skew} ms from this one's`);
      return { total: paint.origin + paint.at - started, loading: paint.origin - started };
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    killTree(app);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const first = await start();
const again = [];
for (let i = 1; i < runs; i++) again.push(await start());
again.sort((a, b) => a.total - b.total);

const median = again[Math.floor(again.length / 2)];
const worst = again.at(-1);
const ms = (n) => `${Math.round(n)} ms`;

console.log(`${exe}\n`);
console.log(`first start, empty profile   ${ms(first.total)}  (page began loading at ${ms(first.loading)})`);
console.log(`every start after it         ${ms(median.total)} median, ${ms(again[0].total)}–${ms(worst.total)} over ${again.length}  (loading began at ${ms(median.loading)})`);
console.log(`budget                       ${ms(BUDGET_MS)}\n`);

const met = Math.max(first.total, worst.total) < BUDGET_MS;
console.log(met ? 'met' : 'NOT met');
process.exit(met ? 0 : 1);

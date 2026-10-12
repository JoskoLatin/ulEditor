/**
 * The window can be moved by its title bar, **in the desktop application**.
 *
 * The window has no system title bar (`decorations: false`), so moving it is
 * ours to do: Tauri's drag script starts the system's move when a press lands
 * on an element marked `data-tauri-drag-region`. Bare, the mark counts only
 * for a press on that very element, never on anything inside it — and a
 * clickable element blocks it all the way up.
 *
 * Measured 2026-10-12 on 0.6.4, which only the bar itself and the title were
 * marked on: in a maximised window the left and the right group stretch over
 * their columns, so all the empty bar beside the buttons was the groups' and
 * moved nothing, and with a document open its name, drawn in a `<b>` inside
 * the title, moved nothing either. What was left to take hold of was a twelve
 * pixel gap either side of the title.
 *
 * So the bar is walked, point by point, at the window's own size and
 * maximised, with nothing open and with a document open: a press on anything
 * that is not there to be pressed must start the move, and one on a button
 * must not. A real press (through CDP) where the move is wanted; on a button
 * only a `mousedown`, since a real click there would minimise or close the
 * window under the check, and on a menu heading nothing at all, since one
 * opens on the press.
 *
 * Whether the system then really moves the window is not asked here — a real
 * mouse would be taken from whoever is at the machine. It was measured once by
 * hand: a press on the title and a move of 100 px moved the window 100 px.
 *
 * Windows only, like the other desktop checks.
 *
 *   node tools/verify-desktop-titlebar.mjs
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDesktop, stopDesktop, openFromOutside } from './desktop-session.mjs';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How far apart the points on the bar are, in CSS pixels. */
const STEP = 12;

const base = await mkdtemp(join(tmpdir(), 'ul-titlebar-'));
const note = join(base, 'a-note-with-a-fairly-long-name.md');
await writeFile(note, '# Naslov\n\nPrvi redak.\n');

let session;
try {
  session = await startDesktop({
    port: 9351,
    identifier: 'org.uleditor.app.check',
  });
  const { page } = session;
  check('attached to the desktop application', true);

  /* Every move the drag script asks for, and every maximise a double press
     would ask for — the latter must never come from a single press. */
  const asked = [];
  page.on('request', (r) => {
    const url = decodeURIComponent(r.url());
    if (/plugin:window\|(start_dragging|internal_toggle_maximize)/.test(url)) asked.push(url);
  });

  /** What lies under a point of the bar, and whether a press there is one on something to press. */
  const under = (x, y) =>
    page.evaluate(
      ([x, y]) => {
        const bar = document.querySelector('.titlebar');
        const el = document.elementFromPoint(x, y);
        if (!el || !bar.contains(el)) return null;
        const ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option']);
        let pressable = null;
        for (let e = el; e && e !== bar.parentElement; e = e.parentElement) {
          if (
            /^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY)$/.test(e.tagName) ||
            ROLES.has(e.getAttribute('role')) ||
            (e.hasAttribute('tabindex') && e.getAttribute('tabindex') !== '-1') ||
            (e.hasAttribute('contenteditable') && e.getAttribute('contenteditable') !== 'false')
          ) {
            pressable = e;
            break;
          }
        }
        const name = (e) =>
          `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : ''}`;
        return {
          what: name(el),
          pressable: pressable ? name(pressable) : null,
          menu: !!pressable?.classList.contains('menu-title'),
        };
      },
      [x, y],
    );

  /** Presses one point and says whether the window was asked to move. */
  async function press(x, y, hit) {
    const before = asked.length;
    if (hit.pressable) {
      await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          const opts = {
            bubbles: true,
            composed: true,
            cancelable: true,
            button: 0,
            detail: 1,
            clientX: x,
            clientY: y,
          };
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
        },
        [x, y],
      );
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
    }
    await sleep(90);
    return asked.slice(before);
  }

  /** Walks the bar along two lines — through the middle, and just under its top edge. */
  async function walk(label) {
    const box = await page.evaluate(() => {
      const r = document.querySelector('.titlebar').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const wrong = new Map();
    let moved = 0;
    let held = 0;
    let doubled = 0;
    for (const y of [box.y + box.height / 2, box.y + 3]) {
      for (let x = box.x + 2; x < box.x + box.width - 2; x += STEP) {
        const hit = await under(x, y);
        if (!hit || hit.menu) continue;
        const got = await press(x, y, hit);
        if (got.some((u) => u.includes('internal_toggle_maximize'))) doubled++;
        const moves = got.some((u) => u.includes('start_dragging'));
        if (hit.pressable ? moves : !moves) {
          const key = hit.pressable ? `${hit.pressable} moved the window` : `${hit.what} did not`;
          const at = wrong.get(key) ?? [];
          at.push(Math.round(x));
          wrong.set(key, at);
        } else if (moves) moved++;
        else held++;
      }
    }
    const said = [...wrong].map(([k, xs]) => `${k} (${xs.length}× from x=${xs[0]})`).join('; ');
    check(
      `${label}: a press on the bar moves the window wherever there is nothing to press`,
      wrong.size === 0,
      said || `${moved} points moved it, ${held} on buttons did not`,
    );
    check(`${label}: no single press maximised the window`, doubled === 0, doubled ? `${doubled} times` : '');
    return box.width;
  }

  const invoke = (cmd) => page.evaluate((c) => window.__TAURI_INTERNALS__.invoke(c), cmd);
  const maximised = () => invoke('plugin:window|is_maximized');

  if (await maximised()) await invoke('plugin:window|toggle_maximize');
  await sleep(600);
  const narrow = await walk('its own size, nothing open');

  await invoke('plugin:window|toggle_maximize');
  await sleep(1000);
  check('the window was maximised for the second walk', await maximised());
  const wide = await walk('maximised, nothing open');
  check('the maximised bar is the wider one', wide > narrow, `${Math.round(narrow)} px → ${Math.round(wide)} px`);

  /* An open menu hangs inside the left group, and its rules and edges are
     nothing to press — but they are the panel's, not the group's, so a press
     there must close nothing and move nothing. A real press, on the panel's
     own edge and on a rule — measured once the panel has finished rising
     into place, and looked at again just before the press: measured while
     it still rose, the edge of the File menu was where Exit came to rest,
     and the press closed the program. Edit, whose rows close nothing, and a
     press only where nothing is to be pressed. */
  await page.locator('.menu-title').nth(1).dispatchEvent('mousedown', { button: 0 });
  await page.waitForSelector('.menu-panel', { timeout: 5000 });
  await page.waitForFunction(() =>
    document
      .querySelector('.menu-panel')
      .getAnimations()
      .every((a) => a.playState === 'finished'),
  );
  const spots = await page.evaluate(() => {
    const panel = document.querySelector('.menu-panel').getBoundingClientRect();
    const rule = document.querySelector('.menu-panel .menu-rule')?.getBoundingClientRect();
    const out = [
      {
        at: 'the panel edge',
        x: panel.x + panel.width / 2,
        y: panel.bottom - 2,
      },
    ];
    if (rule)
      out.push({
        at: 'a rule',
        x: rule.x + rule.width / 2,
        y: rule.y + rule.height / 2,
      });
    return out;
  });
  for (const spot of spots) {
    const hit = await under(spot.x, spot.y);
    if (!hit || hit.pressable) {
      check(
        `${spot.at} of an open menu is nothing to press`,
        false,
        hit ? `${hit.pressable} is there` : 'nothing there',
      );
      continue;
    }
    const before = asked.length;
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.down({ clickCount: 1 });
    await page.mouse.up({ clickCount: 1 });
    await sleep(120);
    check(
      `a press on ${spot.at} of an open menu does not move the window`,
      asked.length === before,
      hit?.what ?? 'nothing there',
    );
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('.menu-panel', {
    state: 'detached',
    timeout: 5000,
  });

  await openFromOutside(page, [note]);
  await page.waitForFunction(
    () => document.querySelector('.titlebar-title b')?.textContent?.includes('a-note-with'),
    null,
    { timeout: 15000 },
  );
  check('a document is open, its name in the title', true);
  await walk('maximised, a document open');

  await invoke('plugin:window|toggle_maximize');
  await sleep(1000);
  await walk('its own size, a document open');
} catch (err) {
  check('the check ran to the end', false, err?.message ?? String(err));
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);

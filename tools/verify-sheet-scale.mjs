/**
 * A spreadsheet the size of a real one: every row read, and scrolled at the
 * speed a frame allows.
 *
 * The plan set the budget years before this was built — *"scrolling through a
 * 100k-row XLSX at 60 fps"* — and the program met it by never trying: sheets
 * were cut at 5 000 rows. That was measured to matter on this machine. A
 * till's six-month receipt analysis has 10 831 rows, and opened with more than
 * half of them missing and unsearchable; the grid before this one scrolled
 * 5 000 rows at 64 ms a frame, and 100 000 rows never finished appearing. The
 * reader under it, a DOM parser, took 13.7 s and 579 MB to read 100 000 rows
 * in order to keep 5 000.
 *
 * So this asks the whole question, of the reader and of the grid, in a browser:
 *
 * - **the reader keeps everything, quickly** — all 100 000 rows, in a time the
 *   old reader could not approach — and the formulas that do not look like
 *   formulas are formulas: a shared formula's dependents, an array formula's
 *   other cells, a formula whose result is empty. Each of those was offered
 *   for retyping and refused by the writer without a word;
 * - **the grid draws a window, not a sheet** — the page holds the same few
 *   thousand cells at row 1 and at row 100 000 — and scrolls within the budget;
 * - **nothing reached through the window is lost** — a search hit on row
 *   90 000 is revealed, a cell retyped there survives scrolling away and back,
 *   an undo applied while it is out of view is there when it returns, typing
 *   interrupted by a scroll is written down, a selection survives a scroll,
 *   and a merged cell cut by the window's edge is still drawn;
 * - **and the real file**, where it exists: the 10 831-row analysis, whole.
 *
 * Needs the development server (`pnpm --filter @uleditor/shell-ui dev`).
 *
 *   node tools/verify-sheet-scale.mjs [--url http://localhost:5273]
 */

import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

import { makeBigXlsx, makeFormulaXlsx } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const MODULE = `/@fs/${ROOT.replace(/\\/g, '/')}/packages/editor-office/src/xlsx.ts`;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the writer, which needs no browser ──────────────────────────────── */

const { findCells, applyCellEdits } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/xlsx-edit.ts')).href
);

const formulaBook = makeFormulaXlsx();
{
  const xml = strFromU8(unzipSync(formulaBook)['xl/worksheets/sheet1.xml']);
  const spans = findCells(xml);
  const written = applyCellEdits(xml, spans, [
    { ref: 'B3', value: '1' },
    { ref: 'C2', value: '2' },
    { ref: 'C4', value: '3' },
    { ref: 'A4', value: '4' },
  ]);
  check(
    'the writer refuses a shared formula\'s dependent, an array\'s other cells, and the gap in an array',
    written.includes('<c r="B3"><f t="shared" si="0"/><v>70</v></c>') &&
      written.includes('<c r="C2"><v>40</v></c>') &&
      !written.includes('r="C4"'),
    written.includes('r="C4"') ? 'C4 was written into the array' : 'B3, C2 and C4 untouched',
  );
  check('and still writes the cell beside them', written.includes('<c r="A4"><v>4</v></c>'));
}

/* ── the browser ─────────────────────────────────────────────────────── */

const bigBook = makeBigXlsx();

function findReal() {
  const corpus = process.env.UL_CORPUS ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Documents');
  const walk = (dir, depth = 0) => {
    if (depth > 6) return null;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
      } else if (/^Excel analiza racuna od .*\.xlsx$/i.test(entry.name)) {
        return full;
      }
    }
    return null;
  };
  return walk(corpus);
}

let browser;
try {
  browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.shell', { timeout: 20000 });

  /* ── the reader ───────────────────────────────────────────────────── */

  const formulas = await page.evaluate(
    async ({ module, b64 }) => {
      const { readXlsx } = await import(module);
      const book = readXlsx(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      const cells = book.sheets[0].cells;
      const view = (key) => {
        const cell = cells.get(key);
        return cell ? { text: cell.text, formula: cell.formula ?? null } : null;
      };
      return { B3: view('2,1'), B4: view('3,1'), C2: view('1,2'), C3: view('2,2'), C4: view('3,2'), D1: view('0,3'), E1: view('0,4') };
    },
    { module: MODULE, b64: Buffer.from(formulaBook).toString('base64') },
  );
  check(
    'a shared formula\'s dependents are formula cells, each with its own references',
    formulas.B3?.formula === 'A3*2+$A$1' && formulas.B4?.formula === 'A4*2+$A$1',
    `B3 =${formulas.B3?.formula} · B4 =${formulas.B4?.formula}`,
  );
  check(
    'an array formula\'s other cells are formula cells, the gap in it included',
    formulas.C2?.formula === 'A1:A4*2' && formulas.C3?.formula === 'A1:A4*2' && formulas.C4?.formula === 'A1:A4*2',
    `C2 =${formulas.C2?.formula} · C4 =${formulas.C4?.formula}`,
  );
  check(
    'a formula whose result is empty is in the grid, so it cannot be typed over',
    formulas.D1?.formula === 'IF(A1>100,"veliko","")' && formulas.D1?.text === '',
    JSON.stringify(formulas.D1),
  );
  check('a line break written as CR LF reads as the parser reads it', formulas.E1?.text === 'prvi\ndrugi', JSON.stringify(formulas.E1?.text));

  const read = await page.evaluate(
    async ({ module, b64 }) => {
      const { readXlsx } = await import(module);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const t0 = performance.now();
      const book = readXlsx(bytes);
      const ms = performance.now() - t0;
      const sheet = book.sheets[0];
      return {
        ms: Math.round(ms),
        rows: sheet.rows,
        cells: sheet.cells.size,
        marker: sheet.cells.get('89999,3')?.text ?? null,
        last: sheet.cells.get(`${sheet.rows - 1},1`)?.text ?? null,
        notes: book.notes,
      };
    },
    { module: MODULE, b64: Buffer.from(bigBook).toString('base64') },
  );
  check(
    'every one of 100 000 rows is read, the last included',
    read.rows === 100000 && read.last === 'zadnjiRedak' && read.marker === 'biljegZaPretragu-90000',
    `${read.rows} rows · ${read.cells} cells`,
  );
  /* Not a performance budget of the plan's — opening is not one — but a floor
     under a regression: the DOM reader took 13.7 s here and kept 5 000 rows. */
  check('in less than half the time the old reader took to keep 5 000 of them', read.ms < 6850, `${read.ms} ms`);
  check('and no note says anything was left out', !read.notes.some((n) => /first/i.test(n)), read.notes.join(' | ').slice(0, 80));

  /* ── the grid ─────────────────────────────────────────────────────── */

  const drop = async (name, bytes) =>
    page.evaluate(
      async ({ name, b64 }) => {
        const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name);
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const before = document.querySelectorAll('.ul-sheet-book').length;
        const t0 = performance.now();
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
        while (
          document.querySelectorAll('.ul-sheet-book').length === before ||
          !document.querySelector('.ul-sheet-book:not([hidden]) .ul-sheet tbody tr[data-row]')
        ) {
          await new Promise((r) => setTimeout(r, 20));
        }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return Math.round(performance.now() - t0);
      },
      { name, b64: Buffer.from(bytes).toString('base64') },
    );

  const opened = await drop('prodaja-100k.xlsx', bigBook);
  check('the 100 000-row sheet opens', opened > 0, `${opened} ms to the first row on screen`);

  /* Everything below runs in the page against the visible grid. */
  const grid = () =>
    page.evaluate(() => {
      const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
      const rows = [...(scroller?.querySelectorAll('tbody tr[data-row]') ?? [])];
      const heights = rows.map((row) => row.getBoundingClientRect().height);
      return {
        cells: scroller?.querySelectorAll('td[data-ref]').length ?? 0,
        rows: rows.length,
        first: rows[0] ? Number(rows[0].dataset.row) : -1,
        last: rows.length ? Number(rows[rows.length - 1].dataset.row) : -1,
        heights: [Math.min(...heights), Math.max(...heights)],
        scrollHeight: scroller?.scrollHeight ?? 0,
      };
    });

  const atTop = await grid();
  check(
    'the page holds a window of the sheet, not the sheet',
    atTop.cells > 0 && atTop.cells < 200 * 27,
    `${atTop.rows} rows, ${atTop.cells} cells in the page · ${atTop.scrollHeight} px of scroll`,
  );
  check(
    'and every row in it is the same height, which is what makes a row\'s place arithmetic',
    atTop.heights[1] - atTop.heights[0] < 0.5,
    `${atTop.heights[0].toFixed(2)}–${atTop.heights[1].toFixed(2)} px`,
  );

  const frames = await page.evaluate(async () => {
    const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
    const run = async (count, step) => {
      const times = [];
      let last = performance.now();
      for (let i = 0; i < count; i++) {
        scroller.scrollTop += step();
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        times.push(now - last);
        last = now;
      }
      times.sort((a, b) => a - b);
      return { median: times[Math.floor(count / 2)], p95: times[Math.floor(count * 0.95)] };
    };
    /* Once to warm up — the first pass pays for compiling the code it runs,
       measured at twice the p95 of every pass after it — and then measured: a
       wheel's worth a frame, and a whole page a frame. */
    await run(120, () => 90);
    const wheel = await run(300, () => 90);
    const pages = await run(120, () => scroller.clientHeight);
    return { wheel, pages };
  });
  check(
    "a wheel scrolls it within a frame — the plan's budget, 60 fps",
    frames.wheel.median <= 17.5,
    `median ${frames.wheel.median.toFixed(1)} ms, p95 ${frames.wheel.p95.toFixed(1)}`,
  );
  /*
   * A whole new page every frame is not what the plan asked, and the budget it
   * is held to here is two frames rather than one — for a measured reason. A
   * trace of it puts ~21 ms of every such frame in the browser's own paint of
   * a screen of new text, in this headless browser's software rasteriser; the
   * grid's own work in the same frame was 3.7 ms. What is guarded is that it
   * never falls back towards what it was — 64 ms a frame at 5 000 rows.
   */
  check(
    'and a page a frame, the hard case, stays within two',
    frames.pages.median <= 33.4,
    `median ${frames.pages.median.toFixed(1)} ms, p95 ${frames.pages.p95.toFixed(1)}`,
  );

  const deep = await grid();
  check('and the page is no bigger deep in the sheet than at its top', deep.cells < 200 * 27, `${deep.cells} cells at row ${deep.first}`);

  const bottom = await page.evaluate(async () => {
    const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 150));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const heads = [...scroller.querySelectorAll('th.ul-sheet-rowhead')].map((th) => th.textContent);
    return { last: heads[heads.length - 1], text: scroller.querySelector('td[data-ref="99999,1"]')?.textContent ?? null };
  });
  check('the last row is there at the bottom', bottom.last === '100000' && bottom.text === 'zadnjiRedak', `row ${bottom.last}: ${bottom.text}`);

  /* A search hit on row 90 000, found in the data and revealed in the grid. */
  const found = await page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    const instance = activeInstance();
    const results = await instance.find({ query: 'biljegZaPretragu', caseSensitive: false });
    results[0]?.reveal();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
    const td = scroller.querySelector('td[data-ref="89999,3"]');
    const box = td?.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    return {
      results: results.length,
      label: results[0]?.label ?? null,
      inPage: Boolean(td),
      visible: Boolean(box && box.top >= view.top && box.bottom <= view.bottom),
      hit: td?.dataset.hit === 'true',
    };
  });
  check(
    'a search hit on row 90 000 is revealed — in the page, in view, and marked',
    found.results === 1 && found.inPage && found.visible && found.hit,
    `${found.label} · in the page ${found.inPage}, in view ${found.visible}`,
  );

  /* Retyped on row 90 000; away to the top and back; still retyped. */
  const cell = () => page.locator('.ul-sheet-scroll:visible td[data-ref="89999,3"]');
  await cell().dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('prepisano daleko dolje');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);

  const travel = (to) =>
    page.evaluate(async (to) => {
      const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
      scroller.scrollTop = to === 'top' ? 0 : to;
      await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, to);
  const revealAgain = () =>
    page.evaluate(async () => {
      const { activeInstance } = await import('/src/state/workspace.ts');
      const results = await activeInstance().find({ query: 'daleko', caseSensitive: false });
      const original = await activeInstance().find({ query: 'biljegZaPretragu', caseSensitive: false });
      (results[0] ?? original[0])?.reveal();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
      return scroller.querySelector('td[data-ref="89999,3"]')?.textContent ?? null;
    });

  await travel('top');
  const away = await page.evaluate(() => {
    const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
    return Boolean(scroller.querySelector('td[data-ref="89999,3"]'));
  });
  const back = await revealAgain();
  check(
    'a cell retyped on row 90 000 is still retyped after scrolling away and back',
    !away && back === 'prepisano daleko dolje',
    `out of the page while away: ${!away} · on return: ${back}`,
  );

  await travel('top');
  await page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    activeInstance().undo();
  });
  const undone = await revealAgain();
  check('an undo applied while it was out of view is there when it comes back', undone === 'biljegZaPretragu-90000', String(undone));

  /* Typing, and then a scroll that takes the row out of the page. */
  await cell().dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('prekinuto listanjem');
  await travel('top');
  const interrupted = await page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    return activeInstance().isDirty();
  });
  const kept = await revealAgain();
  check(
    'typing interrupted by a scroll is written down, not taken out of the page mid-word',
    interrupted && kept === 'prekinuto listanjem',
    `dirty ${interrupted} · on return: ${kept}`,
  );
  await page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    activeInstance().undo();
  });

  /* A selection from row 10 to row 40, and a scroll of a few screens. Text
     length is not the measure: a spacer row changes how many newlines
     `toString()` inserts without the selection having moved at all. Nor is
     `Range.intersectsNode` on a re-queried cell, in the end — a boundary
     that has decayed to the front of the table still "intersects" whatever
     is now drawn there, so a row silently swapped out from under the
     selection reads as held regardless. (`Selection.containsNode` was tried
     first and rejected for the opposite reason: measured directly, Chromium
     answers it wrong for a range spanning table rows even when the range's
     own boundary points plainly surround the node.) What actually has to
     survive is the two `<tr>` elements themselves — captured before the
     scroll, checked for `isConnected` after it, so a row that was replaced
     rather than kept cannot pass by coincidence. */
  const selection = await page.evaluate(async () => {
    const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
    scroller.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const from = scroller.querySelector('tr[data-row="9"]');
    const to = scroller.querySelector('tr[data-row="39"]');
    const range = document.createRange();
    range.setStartBefore(from);
    range.setEndAfter(to);
    const selected = window.getSelection();
    selected.removeAllRanges();
    selected.addRange(range);
    for (let i = 0; i < 6; i++) {
      scroller.scrollTop += scroller.clientHeight;
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const stillFrom = Boolean(scroller.querySelector('tr[data-row="9"]'));
    const kept = { top: from.isConnected, bottom: to.isConnected, collapsed: selected.isCollapsed };
    selected.removeAllRanges();
    return { stillFrom, ...kept };
  });
  check(
    'a selection survives a scroll of six screens, both ends of it',
    selection.stillFrom && selection.top && selection.bottom && !selection.collapsed,
    `top row kept its element: ${selection.top} · bottom row kept its element: ${selection.bottom} · row 10 still in the page: ${selection.stillFrom}`,
  );

  /* The merge from row 5 to row 300, cut by the window's top edge. */
  const merge = await page.evaluate(async () => {
    const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
    const rowHeight = scroller.querySelector('tbody tr[data-row]').getBoundingClientRect().height;
    scroller.scrollTop = 200 * rowHeight;
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const first = Number(scroller.querySelector('tbody tr[data-row]').dataset.row);
    const anchor = scroller.querySelector('td[data-ref="4,0"]');
    return { first, text: anchor?.textContent ?? null, rowSpan: anchor?.rowSpan ?? 0 };
  });
  check(
    'a merged cell whose top is above the window is still drawn, spanning what is left of it',
    merge.first > 4 && merge.text === 'Spojeno kroz tristo redaka' && merge.rowSpan > 1,
    `window starts at row ${merge.first + 1} · rowspan ${merge.rowSpan}`,
  );

  /* ── the formulas, in the interface ───────────────────────────────── */

  await drop('formule.xlsx', formulaBook);
  const refused = page.locator('.ul-sheet-scroll:visible td[data-ref="2,1"]');
  await refused.dblclick();
  await page.waitForTimeout(300);
  const editable = await refused.evaluate((td) => td.isContentEditable);
  const toast = await page.locator('.toast').last().innerText().catch(() => '');
  check(
    'double-clicking a shared formula\'s dependent names the formula instead of opening it',
    !editable && toast.includes('A3*2+$A$1'),
    editable ? 'it opened for typing' : toast.replace(/\s+/g, ' ').slice(0, 90),
  );

  /* ── the real file, where there is one ────────────────────────────── */

  const real = findReal();
  if (!real) {
    console.log('\n  (the 10 831-row receipt analysis is not on this machine — that part was not asked)');
  } else {
    const bytes = readFileSync(real);
    const xmlRows = (() => {
      const archive = unzipSync(new Uint8Array(bytes));
      let most = 0;
      for (const [path, data] of Object.entries(archive)) {
        if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) continue;
        for (const m of strFromU8(data).matchAll(/<row\b[^>]*\br="(\d+)"/g)) most = Math.max(most, Number(m[1]));
      }
      return most;
    })();
    const ms = await drop(real.split(/[\\/]/).pop(), bytes);
    const whole = await page.evaluate(async () => {
      const { activeInstance } = await import('/src/state/workspace.ts');
      const instance = activeInstance();
      const notes = [...document.querySelectorAll('.ul-sheet-book')].find((el) => el.offsetParent !== null)?.querySelector('.ul-office-notes')?.textContent ?? '';
      /* Every sheet, by switching to it — the reader's own count, as the grid has it. */
      const tabs = [...document.querySelectorAll('.ul-sheet-book')].find((el) => el.offsetParent !== null).querySelectorAll('.ul-sheet-tabs button');
      let most = 0;
      for (const tab of tabs) {
        tab.click();
        await new Promise((r) => requestAnimationFrame(r));
        const scroller = [...document.querySelectorAll('.ul-sheet-scroll')].find((el) => el.offsetParent !== null);
        scroller.scrollTop = scroller.scrollHeight;
        await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const heads = [...scroller.querySelectorAll('th.ul-sheet-rowhead')].map((th) => Number(th.textContent));
        most = Math.max(most, ...heads);
      }
      return { notes, most, dirty: instance.isDirty() };
    });
    check(
      'the 10 831-row receipt analysis opens whole, its last row reachable',
      whole.most === xmlRows && !/first/i.test(whole.notes),
      `${whole.most} of ${xmlRows} rows · ${ms} ms to open`,
    );
  }
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
} finally {
  await browser?.close().catch(() => {});
}

const failed = checks.filter((one) => !one.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);

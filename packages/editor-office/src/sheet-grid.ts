/**
 * The grid a sheet is drawn in — only the rows in view are in the page.
 *
 * The grid before this one put every cell of a sheet into the document, and it
 * was measured doing it: 5 000 rows by 27 columns took 1.9 seconds to appear
 * and scrolled at 64 ms a frame, 10 831 rows took 3.5 seconds and scrolled at
 * 114, and 100 000 never finished. A frame has 16.7 ms. So it capped sheets at
 * 5 000 rows, and a till's six-month analysis of 10 831 opened missing more
 * than half of itself.
 *
 * Here the table holds a window of rows around what is visible, with a spacer
 * above and below standing in for everything else, so the page is the same
 * size whatever the sheet is. Rows are uniform — cells do not wrap — so a row's
 * position is arithmetic and nothing has to be measured but one row.
 *
 * **What the page used to guarantee and this keeps.** The window moves by
 * adding and removing rows at its edges, never by rebuilding, so a row that
 * stays in view keeps its nodes — which is what a selection being dragged and
 * a cell being typed into are anchored to. Those two are also held in the
 * window when they would scroll out of it, within a bound; a cell being typed
 * into that would have to leave is finished first, so what was typed is
 * written down rather than taken out of the page mid-word. Columns are fixed
 * widths, worked out once from the data, because a table sized to what happens
 * to be in view would change width under the person as they scrolled.
 */

import { columnName, type Cell, type Merge, type Sheet } from './xlsx.js';

/** What a cell shows: the file's value, or what was typed over it. */
export interface GridCell {
  text: string;
  kind?: Cell['kind'];
  /** The formula behind the value, for the tooltip. */
  formula?: string;
}

/** Rows drawn beyond the visible ones on each side, so a scroll is not a redraw. */
const OVERSCAN = 40;
/** How far a selection or an edit may hold rows in the window before it lets go. */
const MOST_HELD = 2000;
/** The widest a column is drawn, however long its text. */
const WIDEST = 420;
/** How many cells are read to size the columns — the first rows of a sheet say what its columns hold. */
const SAMPLE = 200_000;

export class SheetGrid {
  readonly table: HTMLTableElement;

  #sheet: Sheet;
  #lookup: (key: string) => GridCell | undefined;
  #head: HTMLTableSectionElement;
  #body: HTMLTableSectionElement;
  #above: HTMLTableRowElement;
  #below: HTMLTableRowElement;
  #rows = new Map<number, HTMLTableRowElement>();
  #start = 0;
  #end = 0;

  /** A merge's anchor, keyed by its cell; and every cell a merge covers. */
  #spans = new Map<string, Merge>();
  #covered = new Set<string>();
  /** Merges over more than one row — the ones a window edge can cut. */
  #tall: Merge[] = [];

  #scroller: HTMLElement | null = null;
  #rowHeight = 25;
  #measured = false;
  #frame = 0;
  #resize: ResizeObserver | null = null;
  #hit: string | null = null;

  constructor(sheet: Sheet, lookup: (key: string) => GridCell | undefined) {
    this.#sheet = sheet;
    this.#lookup = lookup;

    for (const merge of sheet.merges) {
      this.#spans.set(`${merge.row},${merge.col}`, merge);
      if (merge.rows > 1) this.#tall.push(merge);
      for (let r = 0; r < merge.rows; r++) {
        for (let c = 0; c < merge.cols; c++) {
          if (r === 0 && c === 0) continue;
          this.#covered.add(`${merge.row + r},${merge.col + c}`);
        }
      }
    }

    const table = document.createElement('table');
    table.className = 'ul-sheet';
    this.table = table;

    this.#head = document.createElement('thead');
    this.#body = document.createElement('tbody');
    table.append(this.#columns(), this.#head, this.#body);

    const headRow = document.createElement('tr');
    headRow.appendChild(document.createElement('th')).className = 'ul-sheet-corner';
    for (let c = 0; c < sheet.cols; c++) {
      const th = document.createElement('th');
      th.textContent = columnName(c);
      th.className = 'ul-sheet-colhead';
      headRow.appendChild(th);
    }
    this.#head.appendChild(headRow);

    this.#above = this.#spacer();
    this.#below = this.#spacer();
  }

  /* ── the columns ─────────────────────────────────────────────────── */

  /**
   * Fixed widths, from the file where it says and from the text where it does
   * not. Measured with the grid's own font, once, over the first rows of the
   * sheet: a column's first thousands of rows say what the column holds.
   */
  #columns(): HTMLTableColElement {
    const group = document.createElement('colgroup') as HTMLTableColElement;
    const sheet = this.#sheet;

    const longest: string[] = [];
    let seen = 0;
    for (const [key, cell] of sheet.cells) {
      if (seen++ >= SAMPLE) break;
      const col = Number(key.slice(key.indexOf(',') + 1));
      if (cell.text.length > (longest[col]?.length ?? 0)) longest[col] = cell.text;
    }

    const measure = textMeasurer();
    const rowDigits = String(sheet.rows).length;
    const corner = document.createElement('col');
    corner.style.width = `${Math.max(46, 18 + rowDigits * 8)}px`;
    group.appendChild(corner);

    let total = parseFloat(corner.style.width);
    for (let c = 0; c < sheet.cols; c++) {
      const declared = sheet.widths.get(c);
      const text = longest[c] ?? '';
      const natural = Math.ceil(measure(text) + 18);
      const width = Math.round(Math.min(WIDEST, Math.max(declared ?? 0, natural, 56)));
      const col = document.createElement('col');
      col.style.width = `${width}px`;
      group.appendChild(col);
      total += width;
    }
    this.table.style.width = `${total}px`;
    return group;
  }

  /* ── the window ──────────────────────────────────────────────────── */

  #spacer(): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.className = 'ul-sheet-spacer';
    row.setAttribute('aria-hidden', 'true');
    const cell = document.createElement('td');
    cell.colSpan = this.#sheet.cols + 1;
    row.appendChild(cell);
    return row;
  }

  /** Starts following a scroll container, and draws the first window. */
  attach(scroller: HTMLElement): void {
    if (this.#scroller === scroller) return;
    this.detach();
    this.#scroller = scroller;
    scroller.addEventListener('scroll', this.#onScroll, { passive: true });
    /* Through a frame rather than straight away: changing the page inside a
       ResizeObserver callback is what makes the browser report a loop. */
    this.#resize = new ResizeObserver(() => this.#schedule());
    this.#resize.observe(scroller);
    this.update();
  }

  detach(): void {
    this.#scroller?.removeEventListener('scroll', this.#onScroll);
    this.#resize?.disconnect();
    this.#resize = null;
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#scroller = null;
  }

  #onScroll = (): void => this.#schedule();

  #schedule(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.update();
    });
  }

  /** The rows that should be in the page now, before anything holds any. */
  #wanted(): { start: number; end: number; first: number; last: number } {
    const scroller = this.#scroller;
    const rows = this.#sheet.rows;
    if (!scroller) return { start: 0, end: Math.min(rows, 2 * OVERSCAN), first: 0, last: 0 };
    const head = this.#head.offsetHeight;
    const h = this.#rowHeight;
    const first = Math.max(0, Math.min(rows - 1, Math.floor((scroller.scrollTop - head) / h)));
    const last = Math.min(rows, first + Math.ceil(scroller.clientHeight / h) + 1);
    return {
      start: Math.max(0, first - OVERSCAN),
      end: Math.min(rows, last + OVERSCAN),
      first,
      last,
    };
  }

  /**
   * The rows something is anchored to — a cell being typed into, the two ends
   * of a selection — so the window can keep them.
   */
  #held(): number[] {
    const rows: number[] = [];
    const rowOf = (node: Node | null | undefined): number | null => {
      const element = node instanceof Element ? node : node?.parentElement;
      const tr = element?.closest<HTMLElement>('tr[data-row]');
      return tr && this.#body.contains(tr) ? Number(tr.dataset.row) : null;
    };
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isContentEditable) {
      const row = rowOf(active);
      if (row !== null) rows.push(row);
    }
    /*
     * A selection's ends, read from its range rather than its anchor node: a
     * range can start *between* rows, on the table body with an offset — which
     * is what selecting whole rows produces — and the row it means is then the
     * child at that offset, not an ancestor of the node.
     */
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const ends: [Node, number, boolean][] = [
        [range.startContainer, range.startOffset, false],
        [range.endContainer, range.endOffset, true],
      ];
      for (const [container, offset, isEnd] of ends) {
        let node: Node | null | undefined =
          container === this.#body ? this.#body.childNodes[isEnd ? offset - 1 : offset] : container;
        /* A spacer is not a row: when rows above a selection leave the page,
           the spacer that replaces them is inserted at the boundary and the
           range starts before it. The row meant is the first real one past it
           — measured, reading the spacer instead let go of the selection's top
           at the third screen of a scroll. */
        while (node instanceof HTMLElement && node.classList.contains('ul-sheet-spacer')) {
          node = isEnd ? node.previousSibling : node.nextSibling;
        }
        const row = rowOf(node);
        if (row !== null) rows.push(row);
      }
    }
    return rows;
  }

  /** Brings the page into line with the scroll position. */
  update(force = false): void {
    const wanted = this.#wanted();
    let { start, end } = wanted;

    /* Anything anchored in the page stays in it, within a bound. */
    for (const row of this.#held()) {
      if (row < start && end - row <= MOST_HELD) start = row;
      else if (row >= end && row + 1 - start <= MOST_HELD) end = row + 1;
    }

    /* Nothing to do while what is visible is inside what is drawn, with some
       room to spare — the overscan exists so most scrolling is not a redraw. */
    const margin = OVERSCAN / 2;
    const low = Math.max(0, wanted.first - margin);
    const high = Math.min(this.#sheet.rows, wanted.last + margin);
    if (!force && this.#end > this.#start && low >= this.#start && high <= this.#end) return;

    this.#finishLeaving(start, end);

    const overlaps = start < this.#end && end > this.#start;
    if (force || !overlaps) this.#rebuild(start, end);
    else this.#shift(start, end);

    this.#measure();
  }

  /**
   * The merges over several rows, set right for where the window now is.
   *
   * A window edge can cut through one, and then its first visible row has to
   * carry it — with what is left of its span — while a row that carried it
   * before and no longer starts the window has to stop. The first version of
   * this redrew the whole window whenever any such merge was near an edge,
   * which was correct and took every node in the page with it: a selection
   * being made over the rows beside a tall merged label vanished at the first
   * scroll. Only the rows a merge actually changes are drawn again now, and a
   * span that only grows or shrinks is changed where it stands.
   */
  #fixMerges(): void {
    const start = this.#start;
    const end = this.#end;
    for (const merge of this.#tall) {
      const last = merge.row + merge.rows;
      if (last <= start || merge.row >= end) continue;
      const top = Math.max(merge.row, start);
      const ref = `${merge.row},${merge.col}`;

      /* A row that carries this merge without being where it starts now. */
      for (const td of [...this.#body.querySelectorAll<HTMLElement>(`td[data-ref="${ref}"]`)]) {
        const tr = td.closest<HTMLElement>('tr[data-row]');
        const row = tr ? Number(tr.dataset.row) : -1;
        if (tr && row !== top) this.#redraw(row);
      }

      let anchor = this.#rows.get(top)?.querySelector<HTMLTableCellElement>(`td[data-ref="${ref}"]`) ?? null;
      if (!anchor) {
        this.#redraw(top);
        anchor = this.#rows.get(top)?.querySelector<HTMLTableCellElement>(`td[data-ref="${ref}"]`) ?? null;
      }
      const rows = Math.min(last, end) - top;
      if (anchor && anchor.rowSpan !== rows) anchor.rowSpan = rows;
    }
  }

  /**
   * One row drawn again in place — for the rows a merge changes, and only
   * those. The row's own element stays: only its cells are replaced, not the
   * `<tr>` itself. Measured why it has to be this way — a selection ending on
   * the row the window's top edge cuts a merge through lost that end the
   * moment the merge crossed the edge, because `replaceWith` is a new node
   * and a Range tracks position, not the row it meant.
   */
  #redraw(r: number): void {
    const old = this.#rows.get(r);
    if (!old) return;
    const fresh = this.#row(r, this.#start, this.#end);
    old.replaceChildren(...fresh.childNodes);
    this.#rows.set(r, old);
  }

  /**
   * A cell being typed into whose row is about to leave the page is finished
   * first, so what was typed is written down — a focused element taken out of
   * the document fires no blur, and the typing would simply be gone.
   */
  #finishLeaving(start: number, end: number): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.isContentEditable) return;
    const tr = active.closest<HTMLElement>('tr[data-row]');
    if (!tr || !this.#body.contains(tr)) return;
    const row = Number(tr.dataset.row);
    if (row < start || row >= end) active.blur();
  }

  #rebuild(start: number, end: number): void {
    /* Every row is replaced, including the one a cell is being typed into, so
       that typing is finished first whether or not its row stays in view. */
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isContentEditable && this.#body.contains(active)) active.blur();
    this.#rows.clear();
    const fragment = document.createDocumentFragment();
    for (let r = start; r < end; r++) fragment.appendChild(this.#row(r, start, end));
    this.#start = start;
    this.#end = end;
    this.#body.replaceChildren(fragment);
    this.#spacers();
  }


  /** Moves the window by its edges: the rows that stay keep their nodes. */
  #shift(start: number, end: number): void {
    for (let r = this.#start; r < Math.min(start, this.#end); r++) {
      this.#rows.get(r)?.remove();
      this.#rows.delete(r);
    }
    for (let r = Math.max(end, this.#start); r < this.#end; r++) {
      this.#rows.get(r)?.remove();
      this.#rows.delete(r);
    }

    const firstKept = this.#rows.get(Math.max(start, this.#start));
    const before = document.createDocumentFragment();
    for (let r = start; r < Math.min(this.#start, end); r++) before.appendChild(this.#row(r, start, end));
    if (firstKept) this.#body.insertBefore(before, firstKept);
    else this.#body.appendChild(before);

    const after = document.createDocumentFragment();
    for (let r = Math.max(this.#end, start); r < end; r++) after.appendChild(this.#row(r, start, end));
    this.#body.appendChild(after);

    this.#start = start;
    this.#end = end;
    this.#spacers();
    this.#fixMerges();
  }

  #spacers(): void {
    const h = this.#rowHeight;
    const above = this.#start * h;
    const below = (this.#sheet.rows - this.#end) * h;
    /* Present only when they stand for something: a spacer of no height is
       still a row, and the first row of the body is where a person — and a
       check — expects row one to be. */
    if (above > 0) {
      (this.#above.firstElementChild as HTMLElement).style.height = `${above}px`;
      this.#body.insertBefore(this.#above, this.#body.firstChild);
    } else {
      this.#above.remove();
    }
    if (below > 0) {
      (this.#below.firstElementChild as HTMLElement).style.height = `${below}px`;
      this.#body.appendChild(this.#below);
    } else {
      this.#below.remove();
    }
  }

  /**
   * One row's height, from the rows actually drawn — once, the first time
   * there are some. A sheet's rows are all the same height, because no cell
   * wraps; if the estimate was off, the window is drawn again at the right
   * scale before anybody sees it.
   */
  #measure(): void {
    if (this.#measured || this.#rows.size < 2) return;
    const first = this.#rows.get(this.#start);
    const last = this.#rows.get(this.#end - 1);
    if (!first || !last || !first.isConnected) return;
    const span = last.offsetTop + last.offsetHeight - first.offsetTop;
    const height = span / (this.#end - this.#start);
    if (!(height > 0)) return;
    this.#measured = true;
    if (Math.abs(height - this.#rowHeight) > 0.01) {
      this.#rowHeight = height;
      this.update(true);
    }
  }

  /** The height every row is drawn at, as measured. */
  get rowHeight(): number {
    return this.#rowHeight;
  }

  /** The rows in the page now, `[start, end)`. */
  get window(): { start: number; end: number } {
    return { start: this.#start, end: this.#end };
  }

  /* ── one row ─────────────────────────────────────────────────────── */

  #row(r: number, start: number, end: number): HTMLTableRowElement {
    const sheet = this.#sheet;
    const row = document.createElement('tr');
    row.dataset.row = String(r);

    const rowHead = document.createElement('th');
    rowHead.textContent = String(r + 1);
    rowHead.className = 'ul-sheet-rowhead';
    row.appendChild(rowHead);

    for (let c = 0; c < sheet.cols; c++) {
      const key = `${r},${c}`;
      let merge = this.#spans.get(key);
      let ref = key;

      if (this.#covered.has(key)) {
        /* A merge whose top row is above the window still has to be drawn:
           its first visible row carries it, spanning what is left of it. */
        const cut = r === start ? this.#tall.find((m) => m.row < start && m.col === c && m.row + m.rows > r) : undefined;
        if (!cut) continue;
        merge = { row: r, col: c, rows: cut.row + cut.rows - r, cols: cut.cols };
        ref = `${cut.row},${cut.col}`;
      }

      const td = document.createElement('td');
      // The reference stays on the cell: merges shift positions within a row,
      // so counting children is not a reliable way to find a cell later.
      td.dataset.ref = ref;
      if (merge) {
        const rows = Math.min(merge.rows, end - r);
        if (rows > 1) td.rowSpan = rows;
        if (merge.cols > 1) td.colSpan = merge.cols;
      }
      this.#fill(td, ref);
      row.appendChild(td);
    }
    this.#rows.set(r, row);
    return row;
  }

  #fill(td: HTMLElement, ref: string): void {
    const cell = this.#lookup(ref);
    td.textContent = cell?.text ?? '';
    if (cell?.kind) td.dataset.kind = cell.kind;
    else delete td.dataset.kind;
    if (cell?.formula) td.title = `=${cell.formula}`;
    else td.removeAttribute('title');
    if (ref === this.#hit) td.dataset.hit = 'true';
    else td.removeAttribute('data-hit');
  }

  /* ── what the editor asks of it ──────────────────────────────────── */

  /** Draws every cell in the page again from what it should show — after an undo, say. */
  refresh(): void {
    for (const td of this.#body.querySelectorAll<HTMLElement>('td[data-ref]')) {
      this.#fill(td, td.dataset.ref ?? '');
    }
  }

  /** The cell at this position if it is in the page, following a merge to its anchor. */
  cell(row: number, col: number): HTMLElement | null {
    const merge = this.#sheet.merges.find(
      (m) => row >= m.row && row < m.row + m.rows && col >= m.col && col < m.col + m.cols,
    );
    const ref = merge ? `${merge.row},${merge.col}` : `${row},${col}`;
    return this.#body.querySelector<HTMLElement>(`td[data-ref="${ref}"]`);
  }

  /**
   * Scrolls a cell into the middle of the view and marks it — from anywhere in
   * the sheet, which is the point: a search hit on row 9 000 has to be reached
   * without the rows before it having been drawn.
   */
  reveal(row: number, col: number): HTMLElement | null {
    const scroller = this.#scroller;
    if (!scroller) return null;
    const head = this.#head.offsetHeight;
    scroller.scrollTop = head + row * this.#rowHeight - scroller.clientHeight / 2 + this.#rowHeight / 2;
    this.update(true);

    const td = this.cell(row, col);
    this.#hit = td?.dataset.ref ?? null;
    for (const previous of this.#body.querySelectorAll('td[data-hit="true"]')) previous.removeAttribute('data-hit');
    if (!td) return null;
    td.dataset.hit = 'true';

    const left = td.offsetLeft - scroller.clientWidth / 2 + td.offsetWidth / 2;
    scroller.scrollLeft = Math.max(0, left);
    return td;
  }
}

/** The width of a string in the grid's font, by canvas — no layout, no DOM. */
function textMeasurer(): (text: string) => number {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return (text) => text.length * 7.5;
  const probe = document.createElement('table');
  probe.className = 'ul-sheet';
  probe.style.cssText = 'position:absolute;visibility:hidden';
  const td = probe.appendChild(document.createElement('tbody')).appendChild(document.createElement('tr')).appendChild(document.createElement('td'));
  document.body.appendChild(probe);
  const style = getComputedStyle(td);
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  probe.remove();
  return (text) => (text ? context.measureText(text).width : 0);
}

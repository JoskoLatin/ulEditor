/**
 * Arak's driver: each step of `tools/mobile-scenarios.mjs` as taps on Arak
 * (ADR 0009, testing level C). It finds things only by their `data-ul-role`
 * marker, so a change of layout or wording does not break it; 250 lines at
 * most, as the ADR sets for every driver.
 *
 * The markers Arak draws:
 *
 * | marker | what |
 * | --- | --- |
 * | `mobile-shell` | Arak's root: `data-ui="arak"`, `data-place` (`wall`, `sheet`, `desk`, `find`), `data-layers` |
 * | `wall` | *zid*, the library; `data-hidden` while a sheet lies over it |
 * | `wall-group`, `wall-group-title` | a group of the wall, `data-group` `today`, `week`, `YYYY-MM` or `undated` |
 * | `library-row` | a document on the wall, `data-name`, `data-format` |
 * | `open-document` | a document already open, in the wall's row, `data-name` |
 * | `library-state` | the library looking, empty or failing |
 * | `permission-sheet`, `library-rescan` | Android hiding the documents; the one control, Scan again |
 * | `document-sheet` | the sheet, `data-name` and `data-format` of the document in front, `data-shown`, `data-lifted` |
 * | `document-stage` | the stage the editors live on (`mobile/common`); its inside is the editors' |
 * | `corner` | *ugao*, `data-count`, `data-dirty` |
 * | `hint`, `hint-dismiss` | *ceduljica*, `data-kind` `pdf`, `text`, `sheet` or `other` |
 * | `desk`, `desk-name`, `desk-state` | *stol*, the document's name and `data-state` `dirty`, `readonly` or `clean` |
 * | `desk-find`, `desk-put-away` | Traži and Odloži |
 * | `desk-document`, `desk-wall` | *hrpa*: another open document, `data-name`; and Svi dokumenti |
 * | `lifted-sheet` | the lifted sheet, a tap puts it down |
 * | `find-strip`, `find-field`, `find-count`, `find-prev`, `find-next`, `find-close`, `find-where` | *crta*: the count has `data-current` and `data-total` |
 * | `question`, `question-action` | the shell's question, `data-level`; an answer, `data-cancel` on the cancel |
 * | `notice`, `notice-dismiss` | a notice that only tells, and its OK |
 */

const PLACES = { wall: 'wall', sheet: 'document', desk: 'tools', find: 'find' };

/** A CSS attribute selector for a role, and a name when given. */
function marker(role, name) {
  return name === undefined ? `[data-ul-role="${role}"]` : `[data-ul-role="${role}"][data-name=${JSON.stringify(name)}]`;
}

export function arakDriver(page, { timeout = 15000 } = {}) {
  const locate = (role, name) => page.locator(marker(role, name)).first();

  /* Scrolled to first, as a person scrolls to it: the wall draws a group far
     down only once it comes near the screen (`content-visibility: auto`). */
  const tap = async (role, name) => {
    const target = locate(role, name);
    await target.waitFor({ state: 'attached', timeout });
    await target.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await target.waitFor({ state: 'visible', timeout });
    await target.tap({ timeout });
  };

  /** Everything a scenario asserts, read out of the markers in one go. */
  const state = () =>
    page.evaluate((places) => {
      const one = (role, root = document) => root.querySelector(`[data-ul-role="${role}"]`);
      const all = (role, root = document) => [...root.querySelectorAll(`[data-ul-role="${role}"]`)];
      const shell = one('mobile-shell');
      if (!shell) return { left: true, place: null };
      const place = places[shell.dataset.place] ?? null;
      const sheet = one('document-sheet');
      const stage = one('document-stage');
      const shownMount = stage ? [...stage.children].find((child) => child.style.display !== 'none') : null;
      const count = one('find-count');
      const question = one('question');
      const notice = one('notice');
      const permission = one('permission-sheet');
      const deskState = one('desk-state');
      return {
        left: false,
        ui: shell.dataset.ui,
        place,
        layers: Number(shell.dataset.layers),
        entries: window.history.state?.ulLayers ?? 0,
        front: place === 'wall' ? null : (sheet?.dataset.name ?? null),
        shown: Boolean(
          shownMount &&
            (shownMount.querySelector('canvas, table, [contenteditable="true"]') || shownMount.innerText.trim().length > 0),
        ),
        open: all('open-document').map((tile) => tile.dataset.name),
        pile: all('desk-document').map((tile) => tile.dataset.name),
        hint: one('hint')?.dataset.kind ?? null,
        state: deskState?.dataset.state ?? null,
        focus: document.activeElement?.getAttribute('data-ul-role') ?? null,
        groups: all('wall-group').map((group) => ({
          id: group.dataset.group,
          title: one('wall-group-title', group)?.textContent ?? '',
          names: all('library-row', group).map((row) => row.dataset.name),
        })),
        permission: permission
          ? { controls: [...permission.querySelectorAll('button, a, input')].map((control) => control.dataset.ulRole ?? '?') }
          : null,
        find: count
          ? { current: Number(count.dataset.current), total: Number(count.dataset.total), text: count.textContent ?? '' }
          : null,
        notice: notice ? { level: notice.dataset.level, message: notice.querySelector('p')?.textContent ?? '' } : null,
        question: question
          ? {
              level: question.dataset.level,
              message: question.querySelector('p')?.textContent ?? '',
              actions: all('question-action', question).map((action) => ({
                label: action.textContent ?? '',
                cancel: action.dataset.cancel === 'true',
              })),
            }
          : null,
      };
    }, PLACES);

  const placeIs = async (wanted) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await state()).place === wanted) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`Arak did not come to "${wanted}"`);
  };

  const openTools = async () => {
    if ((await state()).place === 'tools') return;
    if ((await state()).place === 'find') await tap('find-close');
    await tap('corner');
    await placeIs('tools');
  };

  const actions = {
    async openFromLibrary({ name }) {
      await tap('library-row', name);
      await placeIs('document');
    },
    async openFromOpen({ name }) {
      await tap('open-document', name);
      await placeIs('document');
    },
    async dismissHint() {
      await tap('hint-dismiss');
    },
    openTools,
    async closeTools() {
      await tap('lifted-sheet');
      await placeIs('document');
    },
    async openFind() {
      await openTools();
      await tap('desk-find');
      await locate('find-field').waitFor({ state: 'visible', timeout });
    },
    async type({ text }) {
      await locate('find-field').pressSequentially(text, { delay: 20 });
    },
    async nextHit() {
      await tap('find-next');
    },
    async previousHit() {
      await tap('find-prev');
    },
    async closeFind() {
      await tap('find-close');
      await placeIs('document');
    },
    async bringToFront({ name }) {
      await openTools();
      await tap('desk-document', name);
      await placeIs('document');
    },
    async putAway() {
      await openTools();
      await tap('desk-put-away');
    },
    async toWall() {
      await openTools();
      await tap('desk-wall');
      await placeIs('wall');
    },
    /** A tap into the text of the document in front: the editor's own, as it is today. */
    async typeInDocument({ text }) {
      const box = await locate('document-stage').boundingBox();
      await page.mouse.click(box.x + box.width / 4, box.y + box.height / 3);
      await page.keyboard.type(text);
    },
    /** `answer`: the index of the answer, or `'cancel'` for the one marked. */
    async answer({ answer }) {
      const question = locate('question');
      await question.waitFor({ state: 'visible', timeout });
      const buttons = question.locator(marker('question-action'));
      const target = answer === 'cancel' ? question.locator('[data-ul-role="question-action"][data-cancel="true"]') : buttons.nth(answer);
      await target.tap({ timeout });
    },
    /** The system's Back is the WebView's history back (ADR 0009, K2 b). */
    async back() {
      await page.goBack({ waitUntil: 'commit' }).catch(() => null);
    },
  };

  return {
    ui: 'arak',
    /** Arak is up: its root, with the interface's name on it. */
    async ready() {
      await page.waitForSelector('[data-ul-role="mobile-shell"][data-ui="arak"]', { timeout: 30000 });
    },
    state,
    async run(step) {
      const action = actions[step.do];
      if (!action) throw new Error(`Arak's driver has no action "${step.do}"`);
      await action(step);
    },
  };
}

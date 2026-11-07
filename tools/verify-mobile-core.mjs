/**
 * The rules of the mobile shell, checked without a phone and without a browser
 * (ADR 0009, level A).
 *
 * `packages/mobile-core` is pure TypeScript, so its rules are driven here as
 * they ship, through `ts-resolve.mjs`, as `verify-formula` drives the formulas.
 * What a rule is checked against is the ADR's own: the Pixel's measured figures
 * where there are any (the keyboard, Back), the decision's words where there
 * are not.
 *
 * The checks that matter most are the ones that guard against losing work:
 * Back on a question never answering "Discard", a typed correction never given
 * up by a second tap, a scan's text never dropped by "take another", a change
 * of interface refused while anything is unsaved.
 *
 *   node tools/verify-mobile-core.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(ROOT, 'packages/mobile-core');
const load = (name) => import(pathToFileURL(join(PACKAGE, 'src', name)).href);

const layers = await load('layers.ts');
const keyboard = await load('keyboard.ts');
const documents = await load('documents.ts');
const memory = await load('memory.ts');
const prefs = await load('prefs.ts');
const edit = await load('edit-session.ts');
const scan = await load('scan.ts');
const notes = await load('notes.ts');
const { fold } = await load('fold.ts');
const index = await load('index.ts');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** A store behind the two methods `SettingsService` has, that says which keys it was asked for. */
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  const keys = new Set();
  return {
    map,
    keys,
    get(key, fallback) {
      keys.add(key);
      return map.has(key) ? structuredClone(map.get(key)) : fallback;
    },
    set(key, value) {
      keys.add(key);
      map.set(key, structuredClone(value));
    },
  };
}

const ch = (code) => String.fromCodePoint(code);

/* ── layers: the stack and Back ──────────────────────────────────────── */

{
  const { back, openLayer, closeLayer, historyDelta, NO_LAYERS, cancelOf } = layers;
  const search = { id: 'search' };
  const desk = { id: 'desk' };
  const question = (actions) => ({ id: 'question', actions });
  const discard = { id: 'discard' };
  const save = { id: 'save' };
  const cancel = { id: 'cancel', cancel: true };

  check('Back with nothing open leaves the app', back(NO_LAYERS).kind === 'leave');

  const two = openLayer(openLayer(NO_LAYERS, search), desk);
  const once = back(two);
  check(
    'Back closes the top layer, and only it',
    once.kind === 'close' && once.layer.id === 'desk' && once.stack.length === 1 && once.stack[0].id === 'search',
  );

  const orders = [
    [discard, save, cancel],
    [cancel, discard, save],
    [save, cancel, discard],
    [discard, cancel, save],
  ];
  const answers = orders.map((actions) => back([search, question(actions)]));
  check(
    'on a question Back runs the action marked cancel, wherever it stands in the list',
    answers.every((outcome) => outcome.kind === 'cancel' && outcome.action.id === 'cancel'),
    answers.map((outcome) => outcome.action?.id ?? outcome.kind).join(', '),
  );
  check(
    'and never Discard, not even when Discard is first',
    answers.every((outcome) => outcome.action?.id !== 'discard'),
  );
  check(
    'a question answered by Back is closed, and what was under it stays',
    answers.every((outcome) => outcome.stack.length === 1 && outcome.stack[0].id === 'search'),
  );

  const unmarked = back([question([discard, save])]);
  check(
    'a question with no cancel marked stays: Back answers nothing for the person',
    unmarked.kind === 'stay' && unmarked.action === undefined && unmarked.stack.length === 1,
    unmarked.kind,
  );
  check('the cancel is found by its mark, not by its place', cancelOf(question([discard, save])) === null);

  /* The adapter, as the phone runs it: one entry per open layer, measured. */
  let stack = NO_LAYERS;
  let entries = 0;
  const steps = [];
  const sync = () => {
    entries += historyDelta(entries, stack);
    steps.push(entries === stack.length);
  };
  const systemBack = () => {
    if (entries === 0) return 'left';
    entries -= 1; /* the system already took the entry */
    const outcome = back(stack);
    stack = outcome.stack;
    sync();
    return outcome.kind;
  };
  stack = openLayer(stack, search);
  sync();
  stack = openLayer(stack, desk);
  sync();
  stack = openLayer(stack, desk);
  sync();
  const doubled = entries;
  stack = openLayer(stack, question([discard, save]));
  sync();
  const stayed = systemBack();
  stack = closeLayer(stack, 'question');
  sync();
  stack = closeLayer(stack, 'desk');
  sync();
  const closed = systemBack();
  const left = systemBack();
  check(
    'every open layer holds one history entry, through opening, Back and closing by a tap',
    steps.every(Boolean) && entries === 0,
    `${steps.filter(Boolean).length}/${steps.length} steps in step`,
  );
  check('opening a layer that is already open pushes no second entry', doubled === 2);
  check(
    'Back on a question with no cancel keeps its entry, and Back on the base layer leaves',
    stayed === 'stay' && closed === 'close' && left === 'left',
    `${stayed}, ${closed}, ${left}`,
  );

  const under = closeLayer([search, question([cancel])], 'search');
  check(
    'closing a layer under a question leaves the question open',
    under.length === 1 && under[0].id === 'question',
  );
}

/* ── keyboard: the inset ─────────────────────────────────────────────── */

{
  const { keyboardInset } = keyboard;
  const pixel = keyboardInset({ layoutHeight: 997, viewportHeight: 632 });
  check('the Pixel, measured: layout 997, visible 632, keyboard 365', pixel === 365, String(pixel));
  check('the keyboard down: the visible part is the layout, and the inset is 0', keyboardInset({ layoutHeight: 997, viewportHeight: 997 }) === 0);
  check(
    'a fractional keyboard is rounded up, so a field never sits a fraction into it',
    keyboardInset({ layoutHeight: 997, viewportHeight: 632.4 }) === 365,
    String(keyboardInset({ layoutHeight: 997, viewportHeight: 632.4 })),
  );
  check('what is left of the arithmetic is not a keyboard', keyboardInset({ layoutHeight: 997, viewportHeight: 996.9999 }) === 0);
  check(
    'a visible part scrolled down the layout: its offset is not keyboard',
    keyboardInset({ layoutHeight: 997, viewportHeight: 632, viewportOffsetTop: 100 }) === 265,
    String(keyboardInset({ layoutHeight: 997, viewportHeight: 632, viewportOffsetTop: 100 })),
  );
  const nonsense = [
    { layoutHeight: Number.NaN, viewportHeight: 632 },
    { layoutHeight: 997, viewportHeight: Number.NaN },
    { layoutHeight: 997, viewportHeight: -5 },
    { layoutHeight: 0, viewportHeight: 0 },
    { layoutHeight: Infinity, viewportHeight: 632 },
    { layoutHeight: 997, viewportHeight: 632, viewportOffsetTop: -40 },
  ].map(keyboardInset);
  check('a measure that is not a sane number says nothing about a keyboard', nonsense.every((n) => n === 0), nonsense.join(','));
  check(
    'never negative, never more than the layout',
    keyboardInset({ layoutHeight: 997, viewportHeight: 1200 }) === 0 &&
      keyboardInset({ layoutHeight: 997, viewportHeight: 0 }) === 997,
  );
}

/* ── documents: the pile ─────────────────────────────────────────────── */

{
  const { bringToFront, closeDocument, setDocumentMode, markSaved, documentMode, lastSaved, neighbourOf, NO_DOCUMENTS } = documents;
  let pile = bringToFront(NO_DOCUMENTS, 'a', 1);
  pile = bringToFront(pile, 'b', 2);
  pile = bringToFront(pile, 'c', 3);
  const order = (docs) => docs.map((doc) => doc.id).join('');
  check('the document used last is first', order(pile) === 'cba', order(pile));

  const again = bringToFront(pile, 'a', 4);
  check('bringing an open one up moves it to the front, once', order(again) === 'acb', order(again));

  /* Three swipes from the front, the way a finger goes. */
  let at = 'c';
  const visited = [at];
  for (let i = 0; i < 3; i++) {
    at = neighbourOf(pile, at, 'older') ?? at;
    visited.push(at);
  }
  check(
    'a swipe walks the pile without reordering it, so the third document is reached',
    visited.join('') === 'cbaa' && order(pile) === 'cba',
    visited.join(''),
  );
  check(
    'the pile does not wrap at either end',
    neighbourOf(pile, 'a', 'older') === null && neighbourOf(pile, 'c', 'newer') === null && neighbourOf(pile, 'b', 'newer') === 'c',
  );
  check('a document that is not open has no neighbour', neighbourOf(pile, 'x', 'older') === null);

  check('a document opens for reading', documentMode(pile, 'a') === 'read');
  const correcting = setDocumentMode(pile, 'b', 'correct');
  check('changing the mode is not using the document', order(correcting) === 'cba' && documentMode(correcting, 'b') === 'correct');
  const back = bringToFront(correcting, 'b', 5);
  check('coming back to a document keeps its mode', documentMode(back, 'b') === 'correct');
  check('unless a mode is given', documentMode(bringToFront(back, 'b', 6, 'read'), 'b') === 'read');

  const saved = markSaved(pile, 'a', 1000);
  check(
    'when it was saved is kept, through being brought up again',
    lastSaved(saved, 'a') === 1000 && lastSaved(bringToFront(saved, 'a', 2000), 'a') === 1000 && lastSaved(saved, 'b') === null,
  );
  const closed = closeDocument(saved, 'a');
  check('a closed document leaves the pile and its stamp with it', order(closed) === 'cb' && lastSaved(closed, 'a') === null);
}

/* ── memory: where each document was left ────────────────────────────── */

{
  const { rememberOpening, rememberPosition, recall, remembered, lastWithIntent, forgetDocument, MEMORY_KEY, MEMORY_LIMIT, POSITION_LIMIT } = memory;
  const store = fakeStore();
  rememberOpening(store, 'file:///ugovor.pdf', 1, 'read');
  rememberOpening(store, 'file:///racun.xlsx', 2, 'correct');
  rememberOpening(store, 'file:///ugovor.pdf', 3);
  const list = remembered(store).map((entry) => entry.uri);
  check(
    'opening puts the document first, one entry per document',
    list.join(' ') === 'file:///ugovor.pdf file:///racun.xlsx',
    list.join(' '),
  );
  check('an intent is replaced only when one is given', recall(store, 'file:///ugovor.pdf')?.intent === 'read');

  rememberPosition(store, 'file:///racun.xlsx', 'sheet=1;cell=D4', 4);
  check(
    'a position is written where the entry stands: moving through a document is not opening it',
    remembered(store)[0].uri === 'file:///ugovor.pdf' && recall(store, 'file:///racun.xlsx')?.position === 'sheet=1;cell=D4',
  );
  rememberOpening(store, 'file:///racun.xlsx', 5);
  check('the position survives the document being opened again', recall(store, 'file:///racun.xlsx')?.position === 'sheet=1;cell=D4');

  rememberPosition(store, 'file:///ugovor.pdf', 'x'.repeat(POSITION_LIMIT + 1), 6);
  check(
    'a position longer than the limit is not kept, nor written into the settings',
    recall(store, 'file:///ugovor.pdf')?.position === null &&
      !JSON.stringify(store.map.get(MEMORY_KEY)).includes('x'.repeat(POSITION_LIMIT)),
  );

  check(
    'the last document of each intent is there for the start screen',
    lastWithIntent(store, 'correct')?.uri === 'file:///racun.xlsx' && lastWithIntent(store, 'read')?.uri === 'file:///ugovor.pdf' && lastWithIntent(store, 'write') === null,
  );

  const many = fakeStore();
  for (let i = 0; i < MEMORY_LIMIT + 10; i++) rememberOpening(many, `file:///${i}.pdf`, i);
  const kept = remembered(many);
  check(
    `capped at ${MEMORY_LIMIT}, newest first, the oldest forgotten`,
    kept.length === MEMORY_LIMIT && kept[0].uri === `file:///${MEMORY_LIMIT + 9}.pdf` && recall(many, 'file:///9.pdf') === null && recall(many, 'file:///10.pdf') !== null,
    `${kept.length} kept`,
  );
  check('and the store holds no more than the cap', many.map.get(MEMORY_KEY).length === MEMORY_LIMIT);

  const handEdited = fakeStore({
    [MEMORY_KEY]: [
      { uri: 'file:///a.pdf', openedAt: 9, position: 'p=2', intent: 'read' },
      { uri: 'file:///a.pdf', openedAt: 1, position: 'p=1', intent: 'scan' },
      null,
      'file:///b.pdf',
      { uri: 42, openedAt: 1 },
      { uri: 'file:///c.pdf', openedAt: 'yesterday' },
      { uri: 'file:///d.pdf', openedAt: 3, position: 7, intent: 'dance' },
    ],
  });
  const read = remembered(handEdited);
  check(
    'what a hand-edited store holds is checked entry by entry; of two for one document the first counts',
    read.length === 2 && read[0].position === 'p=2' && read[1].uri === 'file:///d.pdf' && read[1].position === null && read[1].intent === null,
    JSON.stringify(read),
  );
  check('a store that holds something else entirely is an empty memory', remembered(fakeStore({ [MEMORY_KEY]: { oops: true } })).length === 0);

  forgetDocument(store, 'file:///racun.xlsx');
  check('a document forgotten is gone', recall(store, 'file:///racun.xlsx') === null && recall(store, 'file:///ugovor.pdf') !== null);
  check('the memory touches no key but its own', [...store.keys].join() === MEMORY_KEY, [...store.keys].join());
}

/* ── prefs: the phone's settings, and canSwitch ──────────────────────── */

{
  const { chosenInterface, setInterface, chosenHand, setHand, shouldAskInterface, markInterfaceAsked, hintSeen, markHintSeen, canSwitch, PREF_KEYS, HINTS_LIMIT, DEFAULT_INTERFACE } = prefs;
  check('the default interface is Arak', chosenInterface(fakeStore()) === 'arak' && DEFAULT_INTERFACE === 'arak');
  const chose = fakeStore();
  setInterface(chose, 'palac');
  check(
    'a chosen interface starts when the build has it, and the default when it does not',
    chosenInterface(chose, ['arak', 'palac']) === 'palac' && chosenInterface(chose, ['arak']) === 'arak',
  );
  check(
    'a stored value that is not an interface starts the default',
    chosenInterface(fakeStore({ [PREF_KEYS.ui]: 'desktop' }), ['arak', 'palac']) === 'arak' && chosenInterface(fakeStore({ [PREF_KEYS.ui]: 7 })) === 'arak',
  );
  setInterface(chose, 'nonsense');
  check('setting something that is not an interface writes nothing', chose.map.get(PREF_KEYS.ui) === 'palac');

  const hand = fakeStore({ [PREF_KEYS.hand]: 'both' });
  const wasJunk = chosenHand(hand);
  setHand(hand, 'left');
  check('the hand is the right one by default and after junk, and the left one once chosen', wasJunk === 'right' && chosenHand(fakeStore()) === 'right' && chosenHand(hand) === 'left');

  const fresh = fakeStore();
  const withOne = shouldAskInterface(fresh, ['arak']);
  const withTwo = shouldAskInterface(fresh, ['arak', 'palac']);
  markInterfaceAsked(fresh);
  const afterAsking = shouldAskInterface(fresh, ['arak', 'palac', 'boje']);
  check(
    'the interface is asked about once two exist, and once only',
    withOne === false && withTwo === true && afterAsking === false && shouldAskInterface(fakeStore(), ['arak', 'arak']) === false,
    `${withOne} ${withTwo} ${afterAsking}`,
  );

  const hints = fakeStore();
  const before = hintSeen(hints, 'corner:pdf');
  markHintSeen(hints, 'corner:pdf');
  markHintSeen(hints, 'corner:pdf');
  check(
    'a first-time hint is seen once per kind of document, and written once',
    before === false && hintSeen(hints, 'corner:pdf') && !hintSeen(hints, 'corner:docx') && hints.map.get(PREF_KEYS.hints).length === 1,
  );
  for (let i = 0; i < HINTS_LIMIT + 5; i++) markHintSeen(hints, `hint:${i}`);
  check('the hints seen are capped, the oldest going first', hints.map.get(PREF_KEYS.hints).length === HINTS_LIMIT && hintSeen(hints, `hint:${HINTS_LIMIT + 4}`) && !hintSeen(hints, 'corner:pdf'));

  const nothing = canSwitch({ tabs: [], scratch: false, editSession: false });
  check('with nothing unsaved the interface may change', nothing.ok === true);
  const everything = canSwitch({ tabs: [{ id: 't1', name: 'Zapisnik.docx' }, { id: 't2', name: 'Bilješka' }], scratch: true, editSession: true });
  check(
    'with something unsaved it may not, and everything in the way is listed',
    everything.ok === false && everything.blockers.map((b) => b.kind + (b.name ? `:${b.name}` : '')).join(', ') === 'tab:Zapisnik.docx, tab:Bilješka, scratch, edit-session',
    everything.ok ? 'ok' : everything.blockers.map((b) => b.kind).join(', '),
  );
  const alone = [
    canSwitch({ tabs: [{ id: 't1', name: 'a' }], scratch: false, editSession: false }),
    canSwitch({ tabs: [], scratch: true, editSession: false }),
    canSwitch({ tabs: [], scratch: false, editSession: true }),
  ];
  check('a tab, the scratch or an edit session is enough on its own to refuse', alone.every((verdict) => verdict.ok === false && verdict.blockers.length === 1));
}

/* ── edit-session: correcting one target ─────────────────────────────── */

{
  const { editStep, editPending, canStep, IDLE } = edit;
  const word = {
    id: 'run-12:3',
    kind: 'text',
    scopes: [
      { scope: 'word', text: 'srijeda' },
      { scope: 'sentence', text: 'Sastanak je u srijeda.' },
    ],
    inputMode: 'text',
    hasPrevious: true,
    hasNext: true,
  };
  const cell = { id: 'D4', kind: 'cell', scopes: [{ scope: 'cell', text: '38,40' }], label: 'D4 Plin, studeni', inputMode: 'decimal', hasPrevious: false, hasNext: true };
  const run = (events, from = IDLE) => events.reduce(editStep, from);

  const opened = run([{ type: 'open', target: word }]);
  check(
    'a target opens the field with its narrowest scope and that scope’s text',
    opened.state === 'editing' && opened.scope === 'word' && opened.text === 'srijeda' && opened.original === 'srijeda',
  );
  check('a target with no scope the editor writes back faithfully opens nothing', run([{ type: 'open', target: { ...word, scopes: [] } }]).state === 'idle');

  const typed = run([{ type: 'type', text: 'srijedu' }], opened);
  const previewed = run([{ type: 'preview', text: 'srijedu', preview: { changes: [] } }], typed);
  const retyped = run([{ type: 'type', text: 'srijedi' }], previewed);
  check(
    'a preview is for the text it was asked about, and typing drops it',
    typed.state === 'editing' && previewed.state === 'previewing' && retyped.state === 'editing' && retyped.text === 'srijedi',
  );
  check('a preview that comes back for an older text is not shown', run([{ type: 'preview', text: 'srijedu', preview: { changes: [] } }], retyped).state === 'editing');

  const nothingToWrite = run([{ type: 'commit' }], opened);
  check('a commit of the text the target already has writes nothing', nothingToWrite.state === 'done' && nothingToWrite.applied === false);

  const committing = run([{ type: 'commit' }], typed);
  const done = run([{ type: 'applied', ok: true }], committing);
  check('a changed text is committed, and done once the editor has written it', committing.state === 'committing' && done.state === 'done' && done.applied === true && done.text === 'srijedu');

  const refused = run([{ type: 'applied', ok: false }], committing);
  check('a commit the editor refuses leaves the text in the field', refused.state === 'editing' && refused.refused === true && refused.text === 'srijedu');

  const secondTap = run([{ type: 'open', target: cell }], typed);
  check('a second tap does not take away what is typed', secondTap.state === 'editing' && secondTap.target.id === 'run-12:3' && secondTap.text === 'srijedu');
  check('nor does a tap on nothing', run([{ type: 'open', target: null }], typed).text === 'srijedu');
  const gaveWay = run([{ type: 'open', target: cell }], opened);
  check('an untouched field gives way to the next target', gaveWay.state === 'editing' && gaveWay.target.id === 'D4' && gaveWay.text === '38,40');
  check('and so does a done one', run([{ type: 'open', target: cell }], done).target?.id === 'D4');

  const sentence = run([{ type: 'scope', scope: 'sentence' }], opened);
  check(
    'another scope is taken only from those offered, and only with nothing typed',
    sentence.scope === 'sentence' && sentence.text === 'Sastanak je u srijeda.' && run([{ type: 'scope', scope: 'paragraph' }], opened).scope === 'word' && run([{ type: 'scope', scope: 'sentence' }], typed).text === 'srijedu',
  );

  check(
    'cancel gives the text up, but not a write already handed to the editor',
    run([{ type: 'cancel' }], typed).state === 'idle' && run([{ type: 'cancel' }], committing).state === 'committing',
  );
  check(
    'pending while something typed is not written',
    editPending(typed) && editPending(committing) && editPending(refused) && !editPending(opened) && !editPending(done) && !editPending(IDLE),
  );
  check(
    'the arrows to a neighbour only with nothing typed, and only where the editor has one',
    canStep(opened, 'next') && !canStep(typed, 'next') && !canStep(gaveWay, 'previous') && canStep(gaveWay, 'next') && !canStep(IDLE, 'next'),
  );
  check(
    'nothing commits from idle, and typing goes nowhere there',
    run([{ type: 'commit' }]).state === 'idle' && run([{ type: 'type', text: 'x' }]).state === 'idle' && run([{ type: 'applied', ok: true }]).state === 'idle',
  );
}

/* ── scan: paper to text ─────────────────────────────────────────────── */

{
  const { scanStep, scanUnsaved, moveCorner, cornersValid, wholePicture, NO_SCAN } = scan;
  const size = { width: 1000, height: 800 };
  const run = (events, from = NO_SCAN) => events.reduce(scanStep, from);
  const pic = run([{ type: 'picture', size: { ...size, pixels: new Uint8Array(4) } }]);
  check(
    'a picture starts with the corners on the whole of it',
    pic.step === 'corners' && JSON.stringify(pic.corners) === JSON.stringify(wholePicture(size)),
  );
  check('of a picture only its size is held, nothing that came with it', pic.step === 'corners' && Object.keys(pic.size).join() === 'width,height');
  check(
    'a picture of no size, or of a size that is not one, is refused',
    [{ width: 0, height: 800 }, { width: 1000.5, height: 800 }, { width: Number.NaN, height: 1 }, { width: -1, height: 5 }].every((bad) => run([{ type: 'picture', size: bad }]).step === 'picture'),
  );

  const whole = wholePicture(size);
  const outside = moveCorner(whole, 1, { x: 5000, y: 100 }, size);
  const above = moveCorner(whole, 2, { x: 700, y: 9000 }, size);
  const inward = moveCorner(whole, 0, { x: 100, y: 120 }, size);
  check(
    'a corner dragged off the picture stays on its edge, where the finger is along it',
    outside[1].x === 1000 && outside[1].y === 100 && above[2].x === 700 && above[2].y === 800,
    `${JSON.stringify(outside[1])} ${JSON.stringify(above[2])}`,
  );
  check('a corner dragged inward goes where the finger is', inward[0].x === 100 && inward[0].y === 120);
  const bowTie = moveCorner(whole, 0, { x: 1000, y: 400 }, size);
  const dent = moveCorner(whole, 0, { x: 990, y: 10 }, size);
  const across = moveCorner(whole, 3, { x: 1000, y: 0 }, size);
  check(
    'a corner dragged past its neighbour or into a dent is refused, and stays where it was',
    bowTie === whole && dent === whole && across === whole,
  );
  check(
    'a crop that has all but closed is not a crop',
    !cornersValid([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }], size) && cornersValid([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }], size),
  );
  check('corners given in the wrong order are not a crop', !cornersValid([whole[1], whole[0], whole[3], whole[2]], size));

  const recognising = run([{ type: 'recognise' }], pic);
  const failed = run([{ type: 'failed' }], recognising);
  check('recognition that fails goes back to the corners, as they were', failed.step === 'corners' && failed.failed === true && JSON.stringify(failed.corners) === JSON.stringify(pic.corners));

  const result = run([{ type: 'recognised', text: 'Račun 0123' }], recognising);
  const revised = run([{ type: 'revise', text: 'Račun 0128' }], result);
  check('the result holds the text, and a correction replaces it', result.step === 'result' && revised.text === 'Račun 0128');
  check(
    'another picture is refused while a result holds text; only discard gives it up',
    run([{ type: 'retake' }], revised) === revised && run([{ type: 'discard' }], revised).step === 'picture',
  );

  const saving = run([{ type: 'save' }], revised);
  const notSaved = run([{ type: 'saved', ok: false }], saving);
  const saved = run([{ type: 'saved', ok: true }], saving);
  check(
    'a save that fails keeps the text; one that works ends the scan',
    saving.step === 'saving' && notSaved.step === 'result' && notSaved.saveFailed && notSaved.text === 'Račun 0128' && saved.step === 'saved',
  );
  const empty = run([{ type: 'recognised', text: '  ' }], recognising);
  check('an empty result is not saved', run([{ type: 'save' }], empty) === empty);
  check(
    'unsaved: a result with text, and a save under way',
    scanUnsaved(revised) && scanUnsaved(saving) && !scanUnsaved(saved) && !scanUnsaved(empty) && !scanUnsaved(pic),
  );
  check('another paper after one is saved', run([{ type: 'picture', size }], saved).step === 'corners');
}

/* ── notes: the name a note is offered under ─────────────────────────── */

{
  const { proposeNoteName, NOTE_STEM_MAX, LOOK_AHEAD } = notes;
  const name = proposeNoteName;

  /* `offered_name` in apps/desktop/src-tauri/src/lib.rs, as it reads on
     2026-11-07: the conditions a name has to meet to be offered at all. */
  const DEVICES = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
  const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x13441, 0x13442].map(ch);
  const alnum = (c) => /^[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]$/u.test(c);
  const rustOffers = (offered) => {
    const chars = Array.from(offered);
    const stem = Array.from(offered.split('.')[0].trimEnd(), (c) => {
      const code = c.codePointAt(0);
      return code >= 0xff01 && code <= 0xff5e ? ch(code - 0xfee0) : c;
    }).join('');
    return (
      chars.length > 0 &&
      chars.length <= 120 &&
      !/[. ]$/.test(offered) &&
      !offered.startsWith(' ') &&
      chars.some(alnum) &&
      !offered.includes('  ') &&
      chars.filter((c) => c === ' ').length <= 8 &&
      chars.filter((c) => !alnum(c) || c === ch(0x640)).length <= 16 &&
      chars.every((c) => (alnum(c) && !BLANK.includes(c)) || " -_.,()[]{}'!@#$+=~;&".includes(c)) &&
      !DEVICES.test(stem) &&
      /\.md$/i.test(offered)
    );
  };

  check('the first line names the note', name('Ideje za balkon\nsadnice, zemlja') === 'Ideje za balkon.md');
  check('blank lines before it are passed over', name('\n\n   \r\nPitanja za majstora\n') === 'Pitanja za majstora.md');
  const markdown = ['# Pitanja za majstora', '- [ ] Kupiti boju', '> 1. Plan puta', '[Ugovor](https://primjer.hr/x) o najmu'].map(name);
  check(
    'Markdown’s marks are not part of the name, and a link is named by its text',
    markdown.join(' | ') === 'Pitanja za majstora.md | Kupiti boju.md | Plan puta.md | Ugovor o najmu.md',
    markdown.join(' | '),
  );
  check('Croatian letters stay as they are', name('Za sastanak stanara: četvrtak, đak, žir') === 'Za sastanak stanara četvrtak, đak, žir.md', String(name('Za sastanak stanara: četvrtak, đak, žir')));

  const path = name('../../AppData/Startup/run:me*?"<>|.md');
  check('no separator and nothing a file name cannot hold', path !== null && !/[\\/:*?"<>|]/.test(path), String(path));
  const hidden = [
    `ugovor${ch(0x202e)}fdp.exe`,
    `nevid${ch(0x200b)}ljivo${ch(0x2066)} i${ch(0x9)}tab${ch(0x0)}`,
    `skriveno${ch(0x3164)}${ch(0x3164)}.exe`,
  ].map(name);
  const invisible = new RegExp(`[\\p{Cc}\\p{Cf}${BLANK.join('')}]`, 'u');
  check('no control, bidirectional or invisible character, no letter drawn as nothing', hidden.every((one) => one !== null && !invisible.test(one)), hidden.join(' | '));
  check('no leading or trailing dot or space', name('...skriveno.  ') === 'skriveno.md' && name(' .  Plan. ') === 'Plan.md');

  const long = name(`${'Vrlo dugačak naslov bilješke koji nikako ne staje '.repeat(5)}`);
  const longStem = long?.slice(0, -3) ?? '';
  check(
    `capped at ${NOTE_STEM_MAX} letters, and not in the middle of a word`,
    long !== null && Array.from(longStem).length <= NOTE_STEM_MAX && 'Vrlo dugačak naslov bilješke koji nikako ne staje'.split(' ').includes(longStem.split(' ').at(-1)),
    String(long),
  );
  /* 52 letters and spaces, then a word whose ninth letter is the 61st. */
  const cutForLength = name('Obavijest stanarima zgrade o planiranim radovima na krovištima');
  check(
    'a name cut for its length ends with the last whole word',
    cutForLength === 'Obavijest stanarima zgrade o planiranim radovima na.md',
    String(cutForLength),
  );
  const spaced = name('a b c d e f g h i j k l');
  const dotted = name('a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t');
  check(
    'no more spaces and marks than “Save as” takes',
    spaced === 'a b c d e f g h i.md' && Array.from(dotted ?? '').filter((c) => !alnum(c)).length <= 16,
    `${spaced} | ${dotted}`,
  );
  const devices = ['CON', 'nul. bilješka', 'ＣＯＮ', `COM${ch(0xb9)}`, 'lpt0', 'Aux'].map(name);
  check('a Windows device is not proposed, in any width', devices.every((one) => one === null), devices.join(','));
  const empty = ['', '   \n\n\t', '### ', '!!! ...', `${ch(0x1f642)}${ch(0x1f642)}`, `${ch(0x3164)}`, '- [ ] '].map(name);
  check('nothing to name the note by gives no proposal', empty.every((one) => one === null), empty.join(','));

  const hugeName = name(`${'x'.repeat(1_000_000)}\nkraj`);
  check('a line of a million letters gives a name of the usual length', hugeName !== null && Array.from(hugeName).length <= NOTE_STEM_MAX + 3, String(hugeName?.length));
  check(
    'only the start of a long text is looked through for its first line',
    name(`${'\n'.repeat(LOOK_AHEAD)}Kasni naslov`) === null && name(`${'\n'.repeat(LOOK_AHEAD - 20)}Rani naslov`) === 'Rani naslov.md',
  );
  check('a first line that ends in .md is not given a second', name('Popis za trgovinu.md') === 'Popis za trgovinu.md' && name('notes.MD ') === 'notes.md');

  const nasty = [
    'Ideje za balkon', '# Pitanja za majstora', '../../x', `ugovor${ch(0x202e)}fdp.exe`, 'invoice.pdf' + ch(0x30fc).repeat(50) + '.exe',
    '._._._._._._._._._._._._._._._._._._._._', `${'—'.repeat(40)}naslov`, 'CON.txt bilješka', 'Račun 12/2026: 263,24 €', '  %APPDATA%  ',
    'a'.repeat(300), 'Ž'.repeat(130), `x${ch(0x0640).repeat(30)}y`, 'Plin, struja; voda = 38,40 + 12', 'prvi [link](javascript:alert(1)) red',
  ];
  const offered = nasty.map(name).filter((one) => one !== null);
  const refused = offered.filter((one) => !rustOffers(one));
  check(
    'every name proposed is one “Save as” would offer as it is',
    offered.length >= 10 && refused.length === 0,
    refused.length ? refused.join(' | ') : `${offered.length} of ${nasty.length} proposed`,
  );
}

/* ── fold: Croatian letters for a search ─────────────────────────────── */

{
  check('č and ć to c, đ to d, š to s, ž to z', fold('čćđšž') === 'ccdsz', fold('čćđšž'));
  check('capitals to capitals', fold('ČĆĐŠŽ') === 'CCDSZ', fold('ČĆĐŠŽ'));
  check('“jamcevina” finds “Jamčevina”', fold('Jamčevina').toLowerCase() === 'jamcevina');
  check('other languages’ letters, and plain ones, are left as they are', fold('äéñøßü Äé abc XYZ 123') === 'äéñøßü Äé abc XYZ 123');
  const sentence = 'Đurđica je u džepu našla ključ od žute kuće.';
  check(
    'one for one: a hit in the folded text is at the same offset in the original',
    fold(sentence).length === sentence.length && fold(sentence).indexOf('dzepu') === sentence.indexOf('džepu') && fold(sentence).indexOf('kuce') === sentence.indexOf('kuće'),
  );
  check('a háček written as its own mark folds once the text is composed', fold(`c${ch(0x30c)}`.normalize('NFC')) === 'c' && fold(`Z${ch(0x30c)}`.normalize('NFC')) === 'Z');
}

/* ── the package as a whole ──────────────────────────────────────────── */

{
  const exported = ['back', 'historyDelta', 'keyboardInset', 'bringToFront', 'neighbourOf', 'rememberOpening', 'canSwitch', 'chosenInterface', 'editStep', 'scanStep', 'moveCorner', 'proposeNoteName', 'fold'];
  const missing = exported.filter((key) => typeof index[key] !== 'function');
  check('the index exports every module', missing.length === 0, missing.join(', '));

  const sources = readdirSync(join(PACKAGE, 'src')).filter((file) => file.endsWith('.ts'));
  const outside = [];
  for (const file of sources) {
    const text = readFileSync(join(PACKAGE, 'src', file), 'utf8');
    for (const [, specifier] of text.matchAll(/\bfrom\s+'([^']+)'/g)) {
      if (!/^\.\/[a-z-]+\.js$/.test(specifier)) outside.push(`${file}: ${specifier}`);
    }
    if (/\bimport\s*\(/.test(text)) outside.push(`${file}: import()`);
  }
  check('nothing is imported from outside the package', outside.length === 0, outside.join(', '));

  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
  const tsconfig = JSON.parse(readFileSync(join(PACKAGE, 'tsconfig.json'), 'utf8'));
  check(
    'no dependency, and no DOM for the type checker to find',
    manifest.dependencies === undefined && JSON.stringify(tsconfig.compilerOptions.lib) === '["ES2023"]',
  );
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

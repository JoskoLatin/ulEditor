/**
 * Printing the document in front, and only the document.
 *
 * The browser's own print takes the window as it is: the title bar, the tabs,
 * the side panel, and of a PDF only the page on screen, cropped at the zoom it
 * is read at. So an editor that can hands over its pages as pictures
 * (`printPages`), they go into a container of their own, and the print
 * stylesheet in `app.css` shows that container and nothing else.
 *
 * An editor without `printPages` is printed as its area stands, with the frame
 * around it hidden by the same stylesheet — better than the window, and as much
 * as the shell can do without knowing the format.
 */

import type { PrintPage } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { isHandheld, type Shell } from '../host/index.js';
import { activeInstance, activeTabId } from '../state/workspace.js';

/** Android's and iOS's webviews have `window.print` and do nothing with it. */
export function canPrint(): boolean {
  return activeTabId() !== null && !isHandheld();
}

let printing = false;

export async function printActive(shell: Shell): Promise<void> {
  if (printing || !canPrint()) return;
  const instance = activeInstance();
  printing = true;
  try {
    if (!instance?.printPages) {
      window.print();
      return;
    }
    shell.notify.show('info', t('Preparing the pages for printing…'));
    const pages = await instance.printPages();
    if (pages.length === 0) return;
    await printSheets(pages);
  } catch (err) {
    shell.notify.show('error', t('Printing failed: {reason}', { reason: String(err) }));
  } finally {
    printing = false;
  }
}

async function printSheets(pages: PrintPage[]): Promise<void> {
  const urls = pages.map((page) => URL.createObjectURL(page.image));
  const container = document.createElement('div');
  container.className = 'print-sheets';

  /* The paper is sized after the first page, the way pdf.js does it; a page of
     another shape is fitted onto it rather than cut. */
  const first = pages[0]!;
  const style = document.createElement('style');
  style.textContent = `@page { size: ${first.width}pt ${first.height}pt; margin: 0; }`;

  const loads = urls.map((url) => {
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    sheet.appendChild(img);
    container.appendChild(sheet);
    return img.decode().catch(() => undefined);
  });

  clearSheets();
  document.head.appendChild(style);
  document.body.appendChild(container);
  document.body.dataset.printing = 'true';
  clearSheets = () => {
    delete document.body.dataset.printing;
    container.remove();
    style.remove();
    for (const url of urls) URL.revokeObjectURL(url);
    clearSheets = () => {};
  };

  // A picture still decoding when the dialog takes its snapshot prints blank.
  await Promise.all(loads);
  /* Cleared on `afterprint` rather than when `print()` returns: whether it
     waits for the dialog to close is the webview's choice, and a sheet removed
     under an open preview prints blank. Should the event never come, the next
     print clears them — on screen the container is never shown. */
  window.addEventListener('afterprint', () => clearSheets(), { once: true });
  window.print();
}

let clearSheets: () => void = () => {};

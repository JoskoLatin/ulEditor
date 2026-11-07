import type { ReactNode } from 'react';

/**
 * A row of tools that never takes the focus (ADR 0003, step 5).
 *
 * With the keyboard up, a press on Bold or Save must not move the focus out of
 * the text: the keyboard would go down and the caret with it, and the person
 * would be typing into nothing. So the row cancels `pointerdown`, which is
 * where the focus moves, for a finger and a mouse alike; the `click` still
 * comes, and the button does what it does. Checked in Chromium for both a tap
 * and a click (`tools/verify-mobile-common.mjs`).
 *
 * A control in the row that has to take the focus itself, a field, does not
 * belong in it.
 */
export function ToolRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-ul-role="tool-row"
      className="m-tool-row"
      onPointerDown={(event) => event.preventDefault()}
    >
      {children}
    </div>
  );
}

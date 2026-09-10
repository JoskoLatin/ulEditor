/**
 * The thing that stands between one editor throwing and an empty window.
 *
 * React unmounts the whole tree when a render or an effect throws and nothing
 * catches it, and "the whole tree" here means everything: measured against the
 * real shell, `#root` goes from 12,725 characters to **0** — no tab bar, no
 * title bar, no menus, no status bar, and `Ctrl+Shift+P` opens nothing. A
 * uniform pale-grey rectangle, and no way back except closing the program.
 *
 * Two real failures produce exactly that today, and both were measured rather
 * than imagined:
 *
 * - a tab whose format is not in the registry, because `TabBar` was the one of
 *   eight `FORMATS[...]` sites that did not guard;
 * - an editor whose `focus()` throws, which the shell calls from a `Pane`
 *   effect — an effect that throws is as fatal as a render that throws.
 *
 * So the boundary goes around **the whole group** — the tabs, the find bar and
 * the surface together — and not around the surface alone. The first of those
 * two failures is in `TabBar`, which is the surface's sibling; a boundary
 * around the surface would not be in its ancestry and would never run, and the
 * window would go white exactly as before with the feature built and shipped.
 *
 * What stays alive is everything outside the group: the title bar, the activity
 * bar, the sidebar, the menus and the status bar. That is what makes "close the
 * tab" a way back rather than a suggestion printed on a dead page.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { t } from '@uleditor/i18n';

import { IconWarning } from './Icons.js';

interface Props {
  children: ReactNode;
  /** Called with what broke, so it can be written down where a person can send it. */
  onError?(error: Error, componentStack: string): void;
  /** Offered as the way out; the group decides what closing means. */
  onDismiss?(): void;
}

interface State {
  error: Error | null;
}

export class Boundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /* React's own default for a *caught* error is `console.error` and nothing
       else, so without this the report would exist only in a console the person
       cannot open. The stack is React's component stack, not the JavaScript one:
       it names the component that threw, which is the half that says where. */
    this.props.onError?.(error, info.componentStack ?? '');
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mount" style={{ display: 'flex' }}>
        <div className="surface-error">
          <IconWarning size={22} />
          <strong>{t('This document broke the editor')}</strong>
          <p style={{ margin: 0 }}>
            {t('The rest of the program is still running. Close the tab to carry on.')}
          </p>
          <code>{error.message || String(error)}</code>
          {this.props.onDismiss ? (
            <button className="ghost-btn" onClick={() => this.props.onDismiss?.()}>
              {t('Close the tab')}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}

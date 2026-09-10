import { useEffect, useState } from 'react';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { record } from '../shell/crash.js';
import type { ToastRecord } from '../host/index.js';

export function Toasts() {
  const shell = useShell();
  const [toasts, setToasts] = useState<ToastRecord[]>(shell.notify.toasts);

  useEffect(() => {
    const sub = shell.notify.onDidChange(setToasts);
    return () => sub.dispose();
  }, [shell]);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-level={toast.level}>
          <p>{toast.message}</p>

          {toast.details && toast.details.length > 0 && (
            <ul>
              {toast.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}

          {toast.actions.length > 0 && (
            <div className="toast-actions">
              {toast.actions.map((action, index) => (
                <button
                  key={action.label}
                  className="toast-btn"
                  data-primary={index === toast.actions.length - 1}
                  /* A notice about a failure whose own button fails silently is
                     the worst place in the program to swallow an error. */
                  onClick={() =>
                    void Promise.resolve(action.run()).catch((err: unknown) => {
                      record(err, { where: `the action on a ${toast.level} notice` });
                    })
                  }
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}

          {toast.actions.length === 0 && !toast.sticky && (
            <div className="toast-actions">
              <button className="toast-btn" onClick={() => shell.notify.dismiss(toast.id)}>
                {t('OK')}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

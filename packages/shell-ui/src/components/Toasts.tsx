import { useEffect, useState } from 'react';

import { useShell } from '../shell/context.js';
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
                  onClick={() => void action.run()}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}

          {toast.actions.length === 0 && !toast.sticky && (
            <div className="toast-actions">
              <button className="toast-btn" onClick={() => shell.notify.dismiss(toast.id)}>
                U redu
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

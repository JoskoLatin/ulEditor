import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { visibleViews } from '../shell/views.js';
import { useWorkspace } from '../state/workspace.js';
import { IconMonitor, IconMoon, IconSun } from './Icons.js';

/**
 * The vertical view bar along the left edge.
 *
 * It exists only on a wide screen; on a phone the CSS hides it and the same views
 * sit in the title bar at the top — see [`ViewSwitch`](./TitleBar.tsx).
 */
export function ActivityBar() {
  const shell = useShell();
  const view = useWorkspace((s) => s.sidebarView);
  const visible = useWorkspace((s) => s.sidebarVisible);
  const setView = useWorkspace((s) => s.setSidebarView);
  const setVisible = useWorkspace((s) => s.setSidebarVisible);

  const preference = shell.theme.preference;
  const ThemeIcon = preference === 'light' ? IconSun : preference === 'dark' ? IconMoon : IconMonitor;
  const themeLabel =
    preference === 'light' ? t('Light') : preference === 'dark' ? t('Dark') : t('Follow system');

  return (
    <nav className="activitybar" aria-label={t('Panels')}>
      {visibleViews().map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className="act-btn"
          data-active={visible && view === id}
          title={label}
          aria-label={label}
          onClick={() => (visible && view === id ? setVisible(false) : setView(id))}
        >
          <Icon size={18} />
        </button>
      ))}

      <div className="spacer" />

      <button
        className="act-btn"
        title={t('Theme: {name}', { name: themeLabel })}
        aria-label={t('Theme: {name}', { name: themeLabel })}
        onClick={() => void shell.commands.execute('view.cycleTheme')}
      >
        <ThemeIcon size={17} />
      </button>
    </nav>
  );
}

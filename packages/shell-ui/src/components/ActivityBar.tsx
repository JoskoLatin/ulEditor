import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { useWorkspace, type SidebarView } from '../state/workspace.js';
import { IconFiles, IconLayers, IconMonitor, IconMoon, IconSun } from './Icons.js';

/** Funkcija, ne konstanta: prijevod se mora dogoditi pri renderu. */
const views = (): { id: SidebarView; label: string; icon: typeof IconFiles }[] => [
  { id: 'explorer', label: t('Explorer (Ctrl+B)'), icon: IconFiles },
  { id: 'formats', label: t('Supported formats'), icon: IconLayers },
];

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
      {views().map(({ id, label, icon: Icon }) => (
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

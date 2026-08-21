/**
 * Implementations of the host services. Deliberately free of React dependencies —
 * the UI subscribes to them through `Emitter`, so the same services work in tests
 * and later in a Tauri context.
 */

import {
  Emitter,
  type Command,
  type CommandRegistry,
  type ConversionService,
  type ConvertFormat,
  type Disposable,
  type NotificationAction,
  type NotificationLevel,
  type NotificationService,
  type SettingsService,
  type Theme,
  type ThemeKind,
  type ThemeService,
  type Uri,
} from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

/* ── naredbe ─────────────────────────────────────────────────────────── */

export class Commands implements CommandRegistry {
  #map = new Map<string, Command>();
  #changed = new Emitter<void>();
  readonly onDidChange = this.#changed.event;

  register(command: Command): Disposable {
    if (this.#map.has(command.id)) {
      console.warn(`[uleditor] command ${command.id} is already registered — overwriting`);
    }
    this.#map.set(command.id, command);
    this.#changed.fire();
    return {
      dispose: () => {
        this.#map.delete(command.id);
        this.#changed.fire();
      },
    };
  }

  async execute(id: string, ...args: unknown[]): Promise<void> {
    const command = this.#map.get(id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    await command.run(...args);
  }

  all(): Command[] {
    return [...this.#map.values()].filter((c) => c.when?.() !== false);
  }
}

/* ── teme ────────────────────────────────────────────────────────────── */

/** The tokens editors with a canvas of their own have to know (PDF, spreadsheets). */
const EXPOSED_TOKENS = [
  '--ground',
  '--surface',
  '--surface-raised',
  '--ink',
  '--ink-soft',
  '--ink-faint',
  '--rule',
  '--rule-soft',
  '--accent',
  '--accent-wash',
  '--danger',
  '--warn',
] as const;

export type ThemePreference = ThemeKind | 'system';

export class Themes implements ThemeService {
  #kind: ThemeKind;
  #preference: ThemePreference;
  #tokens: Record<string, string> = {};
  #emitter = new Emitter<Theme>();
  readonly onDidChange = this.#emitter.event;

  #media = window.matchMedia('(prefers-color-scheme: dark)');

  constructor(preference: ThemePreference = 'system') {
    this.#preference = preference;
    this.#kind = this.#resolve();
    this.#apply();
    this.#media.addEventListener('change', () => {
      if (this.#preference === 'system') this.setPreference('system');
    });
  }

  #resolve(): ThemeKind {
    if (this.#preference !== 'system') return this.#preference;
    return this.#media.matches ? 'dark' : 'light';
  }

  #readTokens(): Record<string, string> {
    const computed = getComputedStyle(document.documentElement);
    const tokens: Record<string, string> = {};
    for (const name of EXPOSED_TOKENS) {
      tokens[name] = computed.getPropertyValue(name).trim();
    }
    return tokens;
  }

  #apply(): void {
    const root = document.documentElement;
    if (this.#preference === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', this.#preference);
    this.#kind = this.#resolve();
    this.#tokens = this.#readTokens();
  }

  get current(): Theme {
    return { kind: this.#kind, tokens: this.#tokens };
  }

  get preference(): ThemePreference {
    return this.#preference;
  }

  setPreference(preference: ThemePreference): void {
    this.#preference = preference;
    this.#apply();
    this.#emitter.fire(this.current);
  }

  /** Cycles light → dark → system. */
  cycle(): ThemePreference {
    const next: ThemePreference =
      this.#preference === 'light' ? 'dark' : this.#preference === 'dark' ? 'system' : 'light';
    this.setPreference(next);
    return next;
  }
}

/* ── settings ────────────────────────────────────────────────────────── */

const STORAGE_KEY = 'uleditor.settings';

export class Settings implements SettingsService {
  #values: Record<string, unknown>;
  #emitter = new Emitter<{ key: string }>();
  readonly onDidChange = this.#emitter.event;

  constructor() {
    let parsed: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Corrupted settings must not prevent startup.
    }
    this.#values = parsed;
  }

  get<T>(key: string, fallback: T): T {
    return key in this.#values ? (this.#values[key] as T) : fallback;
  }

  set<T>(key: string, value: T): void {
    this.#values[key] = value;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#values));
    } catch {
      // Private mode / quota full — the settings simply do not survive the session.
    }
    this.#emitter.fire({ key });
  }
}

/* ── notifications ───────────────────────────────────────────────────── */

export interface ToastRecord {
  id: number;
  level: NotificationLevel;
  message: string;
  actions: NotificationAction[];
  /** The list of unsupported features in a fidelity warning. */
  details?: string[];
  /** A modal warning does not dismiss itself. */
  sticky: boolean;
}

export class Notifications implements NotificationService {
  #next = 1;
  #toasts: ToastRecord[] = [];
  #emitter = new Emitter<ToastRecord[]>();
  readonly onDidChange = this.#emitter.event;

  get toasts(): ToastRecord[] {
    return this.#toasts;
  }

  #push(record: ToastRecord): Disposable {
    this.#toasts = [...this.#toasts, record];
    this.#emitter.fire(this.#toasts);
    return { dispose: () => this.dismiss(record.id) };
  }

  dismiss(id: number): void {
    this.#toasts = this.#toasts.filter((t) => t.id !== id);
    this.#emitter.fire(this.#toasts);
  }

  show(level: NotificationLevel, message: string, actions: NotificationAction[] = []): Disposable {
    const record: ToastRecord = { id: this.#next++, level, message, actions, sticky: false };
    const handle = this.#push(record);
    if (level === 'info' && actions.length === 0) {
      setTimeout(() => this.dismiss(record.id), 4000);
    }
    return handle;
  }

  /**
   * The project's most important rule: a document is never saved silently when
   * saving loses features the editor does not understand.
   */
  fidelityWarning(uri: Uri, unsupported: string[]): Promise<'save' | 'cancel'> {
    return new Promise((resolve) => {
      const name = uri.split('/').pop() ?? uri;
      const record: ToastRecord = {
        id: this.#next++,
        level: 'warning',
        message: t('Saving {name} cannot reproduce everything from the original.', { name }),
        details: unsupported,
        sticky: true,
        actions: [
          {
            label: t('Cancel'),
            run: () => {
              this.dismiss(record.id);
              resolve('cancel');
            },
          },
          {
            label: t('Save anyway'),
            run: () => {
              this.dismiss(record.id);
              resolve('save');
            },
          },
        ],
      };
      this.#push(record);
    });
  }
}

/* ── conversion ──────────────────────────────────────────────────────── */

/**
 * Conversion needs LibreOffice headless, which arrives in phase 2 through
 * `crates/ul-convert`. Until then the service exists but honestly declares
 * itself unavailable rather than leaving editors to guess.
 */
export class NoConversion implements ConversionService {
  async available(): Promise<boolean> {
    return false;
  }

  async convert(_source: Uri, target: ConvertFormat): Promise<Uint8Array> {
    throw new Error(
      t('Converting to {format} needs the LibreOffice backend, which arrives in phase 2.', {
        format: target,
      }),
    );
  }
}

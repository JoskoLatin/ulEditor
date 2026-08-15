/**
 * Implementacije host usluga. Namjerno bez React ovisnosti — UI se na njih
 * pretplaćuje kroz `Emitter`, pa iste usluge rade i u testovima i kasnije
 * u Tauri kontekstu.
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

/* ── naredbe ─────────────────────────────────────────────────────────── */

export class Commands implements CommandRegistry {
  #map = new Map<string, Command>();
  #changed = new Emitter<void>();
  readonly onDidChange = this.#changed.event;

  register(command: Command): Disposable {
    if (this.#map.has(command.id)) {
      console.warn(`[uleditor] naredba ${command.id} je već registrirana — prepisujem`);
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
    if (!command) throw new Error(`Nepoznata naredba: ${id}`);
    await command.run(...args);
  }

  all(): Command[] {
    return [...this.#map.values()].filter((c) => c.when?.() !== false);
  }
}

/* ── teme ────────────────────────────────────────────────────────────── */

/** Tokeni koje editori s vlastitim canvasom moraju znati (PDF, tablice). */
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

  /** Kruži svijetlo → tamno → sistemsko. */
  cycle(): ThemePreference {
    const next: ThemePreference =
      this.#preference === 'light' ? 'dark' : this.#preference === 'dark' ? 'system' : 'light';
    this.setPreference(next);
    return next;
  }
}

/* ── postavke ────────────────────────────────────────────────────────── */

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
      // Oštećene postavke ne smiju spriječiti pokretanje.
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
      // Privatni način / puna kvota — postavke jednostavno ne preživljavaju sesiju.
    }
    this.#emitter.fire({ key });
  }
}

/* ── obavijesti ──────────────────────────────────────────────────────── */

export interface ToastRecord {
  id: number;
  level: NotificationLevel;
  message: string;
  actions: NotificationAction[];
  /** Popis nepodržanih značajki kod upozorenja o vjernosti. */
  details?: string[];
  /** Modalna upozorenja se ne gase sama. */
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
   * Najvažnije pravilo projekta: dokument se nikad ne sprema tiho ako
   * spremanje gubi značajke koje editor ne razumije.
   */
  fidelityWarning(uri: Uri, unsupported: string[]): Promise<'save' | 'cancel'> {
    return new Promise((resolve) => {
      const name = uri.split('/').pop() ?? uri;
      const record: ToastRecord = {
        id: this.#next++,
        level: 'warning',
        message: `Spremanje datoteke ${name} ne može reproducirati sve iz originala.`,
        details: unsupported,
        sticky: true,
        actions: [
          {
            label: 'Odustani',
            run: () => {
              this.dismiss(record.id);
              resolve('cancel');
            },
          },
          {
            label: 'Svejedno spremi',
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

/* ── konverzija ──────────────────────────────────────────────────────── */

/**
 * Konverzija traži LibreOffice headless, koji stiže u fazi 2 preko
 * `crates/ul-convert`. Do tada usluga postoji, ali se pošteno izjašnjava
 * kao nedostupna umjesto da editori pogađaju.
 */
export class NoConversion implements ConversionService {
  async available(): Promise<boolean> {
    return false;
  }

  async convert(_source: Uri, target: ConvertFormat): Promise<Uint8Array> {
    throw new Error(
      `Konverzija u ${target} traži LibreOffice backend, koji stiže u fazi 2 (crates/ul-convert).`,
    );
  }
}

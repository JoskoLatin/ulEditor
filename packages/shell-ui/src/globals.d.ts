/**
 * Values Vite writes into the bundle at build time.
 *
 * `__APP_VERSION__` is read from `apps/desktop/src-tauri/tauri.conf.json`, which
 * is the one place the version is written — see vite.config.ts.
 */
declare const __APP_VERSION__: string;

/** Tauri built this as a debug build (`TAURI_ENV_DEBUG`); `false` everywhere else. See vite.config.ts. */
declare const __TAURI_DEBUG__: boolean;

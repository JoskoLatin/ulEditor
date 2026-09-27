/**
 * The Tauri API, for the parts of the shell that only exist on desktop.
 *
 * The window controls, zoom, the updater, the launch paths, the crash log and
 * the rest reach the platform from outside `host/`, each behind a
 * `shell.platform` check. They reach it through here and nowhere else, so that
 * `host/` stays the one place that knows which platform it is on — which is
 * what lets a second host be written at all — and `tools/verify-host.mjs`
 * holds the line.
 *
 * Every loader is a dynamic import, and none may become a static one: the web
 * build then never loads a byte of the Tauri API, and a module that imports
 * this one costs the browser nothing until it is on desktop and asks.
 */

export const native = {
  core: () => import('@tauri-apps/api/core'),
  event: () => import('@tauri-apps/api/event'),
  window: () => import('@tauri-apps/api/window'),
  webview: () => import('@tauri-apps/api/webview'),
  updater: () => import('@tauri-apps/plugin-updater'),
  process: () => import('@tauri-apps/plugin-process'),
};

/**
 * `shell.settings`, as the store `mobile-core` keeps what it remembers in.
 *
 * There is nothing to convert: `Settings` already has the two methods
 * `KeyValueStore` asks for, because `mobile-core` declared them after
 * `SettingsService` so that it could depend on nothing. This says so in one
 * place, and the type check fails here, not somewhere in an interface, the day
 * either side changes. And it hands over those two methods and nothing else:
 * not `onDidChange`, and not the rest of the shell.
 */

import type { KeyValueStore } from '@uleditor/mobile-core';

import type { Shell } from '../../host/index.js';

export function settingsStore(shell: Shell): KeyValueStore {
  const { settings } = shell;
  return {
    get: (key, fallback) => settings.get(key, fallback),
    set: (key, value) => settings.set(key, value),
  };
}

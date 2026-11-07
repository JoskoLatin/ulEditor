/**
 * Where the remembered things are kept: handed in, never taken.
 *
 * The same two methods as `SettingsService` in `@uleditor/plugin-sdk`, so the
 * shell passes `shell.settings` as it is. Declared here rather than imported so
 * that this package depends on nothing: a ulul module gets its services from
 * its host, and a check passes a `Map` behind the same two methods.
 *
 * What comes back is not necessarily what was written. Settings survive an
 * upgrade and can be edited by hand, so every reader in this package checks the
 * shape of what it gets and falls back rather than trusting it.
 */
export interface KeyValueStore {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
}

/*
 * The Node functions sw/plugin.ts calls at build time. The package has no
 * @types/node — vite.config.ts declares its `process` the same way — and these
 * few lines are cheaper than a dependency.
 */
declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
  export function readFileSync(path: string): Uint8Array;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
}

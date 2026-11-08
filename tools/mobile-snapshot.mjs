/**
 * A build of the interface for a check, served and taken down again.
 *
 * The same way `verify-mobile-common.mjs` builds its own (and for its reasons):
 * a build, which another hand on the same tree cannot change halfway through,
 * into a folder of its own under the system's temp, served by `vite preview` on
 * a free port of 127.0.0.1, all of it removed afterwards. No dev server.
 *
 * The trap: `?ui=` works in Vite's development mode only, and a development
 * build needs **both** `NODE_ENV=development` and `--mode development`, or
 * `import.meta.env.DEV` stays `false` and the mobile shell never starts.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_UI = resolve(ROOT, 'packages/shell-ui');
const VITE = resolve(SHELL_UI, 'node_modules/vite/bin/vite.js');

/** Vite in `packages/shell-ui`, as `node vite.js …`: no shell between, so nothing to quote and nothing left behind. */
function vite(argv, env) {
  const child = spawn(process.execPath, [VITE, ...argv], { cwd: SHELL_UI, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return { child, output: () => output };
}

/** The environment without the two variables a build is told apart by, so the caller's shell does not decide. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!('TAURI_ENV_DEBUG' in extra)) delete env.TAURI_ENV_DEBUG;
  if (!('NODE_ENV' in extra)) delete env.NODE_ENV;
  return env;
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function until(condition, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Builds and serves one snapshot. `kind`: `development` (what `?ui=` needs),
 * `release` or `debug` (`TAURI_ENV_DEBUG=true`, as Tauri builds a debug APK).
 * Returns its URL, its folder and `stop()`, which takes it all down.
 */
export async function snapshot(kind = 'development') {
  const scratch = await mkdtemp(join(tmpdir(), `uleditor-${kind}-`));
  const outDir = join(scratch, kind);
  const env =
    kind === 'development'
      ? cleanEnv({ NODE_ENV: 'development' })
      : kind === 'debug'
        ? cleanEnv({ TAURI_ENV_DEBUG: 'true' })
        : cleanEnv();
  const extra = kind === 'development' ? ['--mode', 'development'] : [];
  let server = null;
  const stop = async () => {
    if (server && server.exitCode === null) {
      await new Promise((done) => {
        server.once('close', done);
        server.kill();
      });
    }
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    const build = vite(['build', '--outDir', outDir, '--emptyOutDir', ...extra], env);
    const code = await new Promise((done) => build.child.on('close', done));
    if (code !== 0) throw new Error(`vite build (${kind}) failed (${code}):\n${build.output().slice(-2000)}`);

    const port = await freePort();
    const preview = vite(['preview', '--outDir', outDir, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], cleanEnv());
    server = preview.child;
    const url = `http://127.0.0.1:${port}/`;
    const up = await until(async () => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    }, 30000);
    if (!up) throw new Error(`vite preview (${kind}) did not come up on ${port}:\n${preview.output().slice(-2000)}`);
    return { url, dir: outDir, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

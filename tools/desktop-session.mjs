/**
 * Driving **the real desktop application** from the checks.
 *
 * Some behaviour exists only in the Tauri environment and cannot be checked in a
 * browser: the commands in Rust, and the CSP the program serves its page with. A check in a browser would be testing the
 * glue instead of the work.
 *
 * WebView2 opens a CDP endpoint on request, so Playwright attaches to the same
 * binary the user runs. Note that `tauri dev` sends no CSP at all — a check
 * about the CSP builds with `buildDesktop` and starts with `built: true`.
 */

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Where this checkout builds the program, as PowerShell reads a path: a
   dialog is answered only in a copy built here. Any `target\debug` would do
   as well until a second checkout — a worktree, another session — runs one of
   its own, and a check pressed a button in that one's dialog. */
const OWN_BUILDS = `${join(ROOT, 'target', 'debug')}\\`.replaceAll("'", "''");

/**
 * Brings the application up and returns the attached page.
 *
 * `browserArgs` go to WebView2 after the debugging port — the egress check
 * passes `--log-net-log` this way, to read what the network service did.
 *
 * @param {{ port?: number, timeoutMs?: number, profile?: string, browserArgs?: string[], identifier?: string, built?: boolean }} [opts]
 */
/**
 * Whether an ulEditor is already running, and would swallow the one we start.
 *
 * The application uses `tauri-plugin-single-instance`: a second copy hands its
 * arguments to the first and **exits**. So with the person's own ulEditor open,
 * every desktop check starts a window that is never theirs, waits four minutes
 * for a debugging port that will never open, and reports
 * `connect ECONNREFUSED` — a true sentence about a socket and a useless one
 * about the cause. Asking first costs nothing and turns that into an
 * instruction.
 *
 * Windows only, which is where these checks run; anywhere else it says nothing
 * rather than guessing.
 */
export function alreadyRunning() {
  if (process.platform !== 'win32') return false;
  /* No filter and no shell, deliberately. `tasklist /FI` through a shell is
     mangled when these checks are run from Git Bash — MSYS rewrites `/FI` into
     a path and tasklist answers with an error nobody reads — so the list is
     asked for whole and searched here. */
  const listed = spawnSync('tasklist', [], { encoding: 'utf8' });
  return /uleditor-desktop\.exe/i.test(listed.stdout ?? '');
}

export const ALREADY_RUNNING =
  'ulEditor is already open, and a second copy hands over to the first and exits — ' +
  'close it and run this again';

/** The debug build both ways of starting produce. */
const EXE = resolve(ROOT, 'target', 'debug', process.platform === 'win32' ? 'uleditor-desktop.exe' : 'uleditor-desktop');

function childEnv(port, profile, opts) {
  return {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [`--remote-debugging-port=${port}`, ...(opts.browserArgs ?? [])].join(' '),
    /* A scratch profile. Settings live in the WebView2 localStorage, and
       without this the checks run in the person's own — every fixture they
       open lands in the real recent list and the real session. A check that
       restarts the program passes the one it got back, to start again in it. */
    WEBVIEW2_USER_DATA_FOLDER: profile,
    /* And the Rust side's own answers — which projects a language server may
       run in (trust.rs) — go into the same scratch profile, not the person's. */
    UL_DATA_DIR: profile,
  };
}

/**
 * Builds the program as it is installed — the page inside the binary, served
 * by the program with its CSP — but as a debug build, so the checks' scratch
 * profile (`UL_DATA_DIR`) still applies. For `startDesktop({ built: true })`.
 * Under an identifier of its own, for the reason `startDesktop` gives.
 */
export async function buildDesktop(identifier, more = {}) {
  const config = join(await mkdtemp(join(tmpdir(), 'ul-build-')), 'tauri.check.json');
  /* `more` is merged over tauri.conf.json as the identifier is — an updater
     endpoint a check serves itself, say. */
  await writeFile(config, JSON.stringify({ ...more, identifier }));
  const built = spawnSync(
    'pnpm',
    ['--filter', '@uleditor/desktop', 'tauri', 'build', '--debug', '--no-bundle', '--config', config],
    { cwd: ROOT, shell: true, stdio: process.env.UL_DESKTOP_LOG ? 'inherit' : 'ignore' },
  );
  if (built.status !== 0) throw new Error(`the build failed (exit ${built.status}); UL_DESKTOP_LOG=1 shows why`);
}

export async function startDesktop(opts = {}) {
  const port = opts.port ?? 9333;
  const timeoutMs = opts.timeoutMs ?? 240000;

  /* Under an identifier of its own a check shares nothing with an ulEditor
     the person has open: the single-instance plugin names its mutex after the
     identifier, so neither hands its arguments to the other, and the
     program's data folders are apart as well. Without one, the person's copy
     would swallow this one. */
  if (!opts.identifier && alreadyRunning()) throw new Error(ALREADY_RUNNING);

  const profile = opts.profile ?? (await mkdtemp(join(tmpdir(), 'ul-profile-')));
  /* Silent, unless somebody is trying to find out why a check fails.
     `UL_DESKTOP_LOG=1` lets the application's own output through, which is
     the only way to read `UL_LSP_TRACE` — a check that swallows the program's
     stderr is a check that can only be debugged by guessing. */
  const stdio = process.env.UL_DESKTOP_LOG ? 'inherit' : 'ignore';
  const env = childEnv(port, profile, opts);

  /* `built` runs the binary `buildDesktop` made, which serves the page itself
     the way an installed copy does — and only that way does the CSP apply.
     Under `tauri dev` the page comes from Vite and no CSP is sent at all
     (measured 2026-10-08: an image, a fetch and a WebSocket to any host all
     reached the resolver), so a check about what the page can reach must not
     run there. */
  let app;
  if (opts.built) {
    app = spawn(EXE, [], { cwd: ROOT, env, stdio });
  } else {
    const args = ['--filter', '@uleditor/desktop', 'dev'];
    if (opts.identifier) {
      const config = join(profile, 'tauri.check.json');
      await writeFile(config, JSON.stringify({ identifier: opts.identifier }));
      args.push('--config', config);
    }
    app = spawn('pnpm', args, { cwd: ROOT, shell: true, env, stdio });
  }

  const until = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < until) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = browser.contexts()[0];
      const page = context?.pages()[0] ?? (await context.waitForEvent('page'));
      await page.waitForSelector('.shell', { timeout: 30000 });
      return { app, browser, page, profile };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  killTree(app);
  throw lastError ?? new Error('WebView2 never opened a CDP endpoint');
}

/**
 * Ends a process this harness started, and everything it started — in the one
 * order that does both.
 *
 * **By process tree, not by name.** `taskkill /IM uleditor-desktop.exe` closes
 * every ulEditor on the machine, including the one the person running the
 * check has open, with whatever is unsaved in it. The dev build and the
 * installed build share a name and nothing else, so the only safe handle is
 * the process the harness started itself, and `/T` takes the children Tauri
 * leaves behind with it.
 *
 * **And the tree first, while its root is still alive.** Every harness here
 * used to call `app.kill()` and then `taskkill /T` on the same pid — and `/T`
 * finds children by asking for their parent, which by then no longer exists.
 * Measured: `ERROR: The process "11016" not found.`, and the child lived on as
 * an orphan. It was found as a real debug build of ulEditor, still running
 * under `cargo run` after `verify:office-editing` had reported 51/51 and
 * exited — holding the single-instance lock the next check would have tripped
 * over, and looking to anyone who glanced at the task list like the person's
 * own program. Synchronous as well, because the harness calls `process.exit`
 * straight afterwards and an asynchronous `taskkill` may never have started.
 */
export function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

/**
 * Hands paths to the running application the way the system does: a second
 * copy started with them, which the single-instance plugin turns into a
 * gesture the core grants (ADR 0005) — a folder opened, a file alone — and the
 * page then opens. Returns once the first of them is let in.
 *
 * The checks used to call `adopt_paths` from the page for this, which is the
 * very thing ADR 0005 took away from the page: the page claims, it does not
 * grant, and a check that grants through the page tests a hole.
 */
export async function openFromOutside(page, paths) {
  const exe = EXE;
  /* The second copy hands over its arguments and exits at once. Bounded all
     the same: with no first copy to hand over to, it would be the program
     itself, and would never end. */
  const handed = spawnSync(exe, paths, { stdio: 'ignore', timeout: 30000, killSignal: 'SIGKILL' });
  if (handed.error) throw new Error(`could not hand ${paths[0]} over: ${handed.error.message}`);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const inside = await page.evaluate(
      (path) =>
        window.__TAURI_INTERNALS__.invoke('stat', { path }).then(
          () => true,
          () => false,
        ),
      paths[0],
    );
    if (inside) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the application never let ${paths[0]} in`);
}

/**
 * Presses one button of a question the application asks in a dialog the
 * system draws — the trust question before a language server starts, the
 * library's before it first looks — and returns its title, or why it could
 * not.
 *
 * A Windows task dialog: class `#32770`, owned by the debug build's process.
 * rfd numbers its custom buttons 1004, 1008 and 1001 (yes, no, cancel), and
 * `TDM_CLICK_BUTTON` (WM_USER + 102) presses one. Waited for, up to
 * `seconds`, since it comes up on a thread of its own.
 */
export function pressDialog(button, seconds = 60) {
  const script = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class UlTrust {
  delegate bool Each(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Each f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string Press(uint pid, int button) {
    IntPtr dialog = IntPtr.Zero; string title = "";
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      var name = new StringBuilder(64); GetClassName(h, name, 64);
      if (name.ToString() != "#32770") return true;
      var text = new StringBuilder(256); GetWindowText(h, text, 256);
      dialog = h; title = text.ToString(); return false;
    }, IntPtr.Zero);
    if (dialog == IntPtr.Zero) return "no dialog";
    PostMessage(dialog, 0x0466, (IntPtr)button, IntPtr.Zero);
    return "pressed: " + title;
  }
}
'@
$app = (Get-CimInstance Win32_Process -Filter "Name='uleditor-desktop.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${OWN_BUILDS}', 'OrdinalIgnoreCase') } | Select-Object -First 1).ProcessId
$said = 'no application'
for ($i = 0; $app -and $i -lt ${seconds * 4}; $i++) {
  $said = [UlTrust]::Press([uint32]$app, ${button})
  if ($said -like 'pressed*') { break }
  Start-Sleep -Milliseconds 250
}
$said`;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  return (out.stdout ?? '').trim().split(/\r?\n/).pop() || (out.stderr ?? '').trim();
}

/**
 * Answers the system's file dialog the program drew — Open or Cancel — and
 * returns its title and what its name box held, or why it could not. The
 * same `#32770` window as a task dialog, but its buttons are the classic IDOK
 * (1) and IDCANCEL (2), pressed with `WM_COMMAND`. `name`, when given, is put
 * in the name box first, as a person clicking that file would.
 */
export function answerFileDialog(open, seconds = 30, name = null) {
  const script = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class UlFileDialog {
  delegate bool Each(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Each f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, Each f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  public static IntPtr NameBox(IntPtr dialog) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (h, l) => {
      var name = new StringBuilder(64); GetClassName(h, name, 64);
      if (name.ToString() == "Edit" && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string NameIn(IntPtr dialog) {
    var box = NameBox(dialog); if (box == IntPtr.Zero) return "";
    var text = new StringBuilder(1024); SendMessage(box, 0x000D, (IntPtr)1024, text); return text.ToString();
  }
  public static void Type(IntPtr dialog, string value) {
    var box = NameBox(dialog); if (box != IntPtr.Zero) SendMessage(box, 0x000C, IntPtr.Zero, value);
  }
  public static IntPtr Find(uint pid, out string title) {
    IntPtr dialog = IntPtr.Zero; string found = "";
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      var name = new StringBuilder(64); GetClassName(h, name, 64);
      if (name.ToString() != "#32770") return true;
      var text = new StringBuilder(512); GetWindowText(h, text, 512);
      dialog = h; found = text.ToString(); return false;
    }, IntPtr.Zero);
    title = found; return dialog;
  }
  public static void Press(IntPtr dialog, int id) { PostMessage(dialog, 0x0111, (IntPtr)id, IntPtr.Zero); }
}
'@
$app = (Get-CimInstance Win32_Process -Filter "Name='uleditor-desktop.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${OWN_BUILDS}', 'OrdinalIgnoreCase') } | Select-Object -First 1).ProcessId
$said = 'no application'
for ($i = 0; $app -and $i -lt ${seconds * 4}; $i++) {
  $title = ''
  $dialog = [UlFileDialog]::Find([uint32]$app, [ref]$title)
  if ($dialog -ne [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 800
    $held = [UlFileDialog]::NameIn($dialog)
    ${name === null ? '' : `[UlFileDialog]::Type($dialog, '${String(name).replace(/'/g, "''")}')`}
    [UlFileDialog]::Press($dialog, ${open ? 1 : 2})
    $said = 'pressed: ' + $title + ' | name box: ' + $held
    break
  }
  $said = 'no dialog'
  Start-Sleep -Milliseconds 250
}
$said`;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  return (out.stdout ?? '').trim().split(/\r?\n/).pop() || (out.stderr ?? '').trim();
}

/** Closes the application and frees the ports for the next run. */
export async function stopDesktop(session) {
  await session?.browser?.close().catch(() => {});
  killTree(session?.app);
  await new Promise((r) => setTimeout(r, 1500));
}

/**
 * Whether a URL the window asked for stayed inside the application.
 *
 * The checks that count outgoing requests need this, and getting it wrong is
 * quiet in both directions: too narrow and the application's own IPC reads as an
 * escape, too wide and a CDN fetch reads as local. Tauri's bridge is
 * `http://ipc.localhost` — declared in the CSP's `connect-src` — and every
 * command invoked from the page goes through it, so opening a document at all
 * produces a handful.
 */
export function isLocal(url) {
  return /^(https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|ipc\.localhost|tauri\.localhost)|data:|blob:|ipc:)/.test(
    url,
  );
}

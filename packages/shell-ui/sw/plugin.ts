import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin, Rollup } from 'vite';

/**
 * Writes dist/sw.js: sw/sw.js with the build's own precache list, the digest
 * of every file it may keep, the headers the server sends (the Caddyfile's
 * `header` block, which the worker puts on everything it answers from its
 * cache), and a version made of all three.
 *
 * What is precached is what opening a document needs — index.html, the entry
 * with everything it imports statically, and each editor it loads lazily with
 * everything *that* imports statically, CSS included. What an editor loads
 * lazily in turn (the diagrams of a Markdown fence, the PDF worker) is kept on
 * first use instead: tools/verify-web-offline.mjs holds the list under its
 * budget.
 *
 * The digests are read off the disk once everything is written, public/
 * included, so they are of exactly the bytes the server will send. The worker
 * serves nothing kept whose digest is not in this list — something written
 * into Cache Storage by other code on the origin is thrown away, not run.
 *
 * Only in a build. The dev server has no sw.js, and a worker left over from a
 * build would answer for it with chunks that no longer exist.
 */
export function serviceWorker(): Plugin {
  const template = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const caddyfile = readFileSync(new URL('../../../deploy/web/Caddyfile', import.meta.url), 'utf8');
  const headers = serverHeaders(caddyfile);
  let outDir = '';
  let files: string[] = [];
  return {
    name: 'uleditor:service-worker',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      // sw.js names everything from the root; a build served from a subpath
      // would need a different worker, not this one quietly failing.
      if (config.base !== '/') throw new Error(`sw/plugin.ts expects base '/', not '${config.base}'.`);
      if (!headers['Content-Security-Policy']) throw new Error('deploy/web/Caddyfile states no Content-Security-Policy.');
      outDir = resolve(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      files = precache(bundle);
    },
    closeBundle() {
      for (const placeholder of ["'__UL_VERSION__'", '__UL_PRECACHE__', '__UL_DIGESTS__', '__UL_HEADERS__']) {
        if (!template.includes(placeholder)) throw new Error(`sw/sw.js has lost ${placeholder}.`);
      }
      const digests: Record<string, string> = {};
      for (const file of walk(outDir)) {
        const path = `/${relative(outDir, file).replace(/\\/g, '/')}`;
        if (path === '/sw.js' || path.endsWith('.map')) continue;
        digests[path] = createHash('sha256').update(readFileSync(file)).digest('hex');
      }
      const list = ['/index.html', ...files.map((f) => `/${f}`)];
      const missing = list.filter((p) => !digests[p]);
      if (missing.length) throw new Error(`Precached but not written: ${missing.join(', ')}`);

      const version = createHash('sha256')
        .update(template)
        .update(JSON.stringify(list))
        .update(JSON.stringify(digests))
        .update(JSON.stringify(headers))
        .digest('hex')
        .slice(0, 16);
      const source = template
        .replace("'__UL_VERSION__'", JSON.stringify(version))
        .replace('__UL_PRECACHE__', JSON.stringify(list, null, 2))
        .replace('__UL_DIGESTS__', JSON.stringify(digests, null, 2))
        .replace('__UL_HEADERS__', JSON.stringify(headers, null, 2));
      writeFileSync(join(outDir, 'sw.js'), source);
    },
  };
}

/**
 * The site's `header { … }` block: one `Name value` or `Name "value"` a line.
 * Comments and removals (`-Server`) are skipped; anything else is an error,
 * so a header the worker would silently drop cannot be added there.
 */
function serverHeaders(caddyfile: string): Record<string, string> {
  const block = /^\s*header \{\n([\s\S]*?)^\s*\}/m.exec(caddyfile.replace(/\r\n/g, '\n'))?.[1];
  if (!block) throw new Error('deploy/web/Caddyfile has no header block.');
  const out: Record<string, string> = {};
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const match = /^([A-Za-z-]+)\s+(?:"([^"]*)"|(\S+))$/.exec(line);
    if (!match) throw new Error(`sw/plugin.ts cannot read this header line: ${line}`);
    out[match[1]!] = match[2] ?? match[3]!;
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The file names to precache, sorted, without index.html. */
function precache(bundle: Rollup.OutputBundle): string[] {
  const chunks = Object.values(bundle).filter((f): f is Rollup.OutputChunk => f.type === 'chunk');
  const entry = chunks.find((c) => c.isEntry);
  if (!entry) throw new Error('The bundle has no entry chunk.');

  const keep = new Set<string>();
  const visit = (name: string) => {
    if (keep.has(name)) return;
    keep.add(name);
    const file = bundle[name];
    if (file?.type !== 'chunk') return;
    file.imports.forEach(visit);
    // CSS, yes. What a chunk imports by its URL (`?url`) is fetched later, if
    // ever — pdf.js's 2 MB worker and its fonts — and is kept on first use.
    file.viteMetadata?.importedCss.forEach((css) => keep.add(css));
  };
  visit(entry.fileName);
  entry.dynamicImports.forEach(visit);
  return [...keep].sort();
}

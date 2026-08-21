/**
 * Lets Node import TypeScript source directly, with no build step.
 *
 * Node 26 strips types itself but does not remap specifiers: TypeScript code
 * writes `./annotations.js` by convention, while only `./annotations.ts` exists
 * on disk. This hook fills that gap.
 *
 * Why at all: the checks then drive the SAME source that ships. Were we to test
 * bundled output, we would be testing the bundler too — and then a failure would
 * not say whether the bug is in the code or in the build chain.
 *
 * Import this module BEFORE dynamically importing any `.ts`.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTs = context.parentURL?.endsWith('.ts');
    if (fromTs && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

/**
 * Omogućuje da Node uveze TypeScript izvor izravno, bez build koraka.
 *
 * Node 26 sam skida tipove, ali ne preslikava specifikatore: TypeScript kod
 * po konvenciji piše `./annotations.js`, a na disku postoji samo
 * `./annotations.ts`. Ovaj hook popunjava tu rupu.
 *
 * Zašto uopće: provjere tako voze ISTI izvor koji se isporučuje. Da testiramo
 * bundlani izlaz, testirali bismo i bundler — a onda pad ne bi govorio je li
 * greška u kodu ili u lancu izgradnje.
 *
 * Uvezi ovaj modul PRIJE nego dinamički uvezeš bilo koji `.ts`.
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

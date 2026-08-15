import { createContext, useContext } from 'react';

import type { Shell } from '../host/index.js';

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('useShell mora biti unutar <ShellContext.Provider>');
  return shell;
}

/**
 * Working without a network, in the browser build.
 *
 * The service worker (sw/sw.js, written into the build by sw/plugin.ts) keeps
 * the program so that a reload offline still opens a document. Only on the
 * web — the desktop has the program on disk — and only in a build: the dev
 * server has no sw.js to register.
 */
export function keepForOffline(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  /* After the page has loaded: the precache is several megabytes, and the
     first paint should not wait behind it. */
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      // Without it the program works as before, only not offline.
      console.warn('ulEditor will not work offline:', error);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

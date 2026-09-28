/**
 * The folders opened in the browser, kept across a reload (ADR 0002, step 8).
 *
 * A `FileSystemDirectoryHandle` can be written to IndexedDB and read back on
 * the next visit; the permission that went with it usually cannot, and is
 * asked for again (see `BrowserFileSystem.restoreRoots`). What is kept is the
 * handle and its name, under the folder's uri — never anything read from it.
 *
 * Everything here fails quietly: a browser that has no IndexedDB, or will not
 * store a handle (a private window), simply does not remember folders, which
 * is how the web build behaved before.
 *
 * Two ulEditor tabs share this store, and a folder removed in one is not seen
 * as removed by the other until that one reloads — then it is gone there too.
 */

const DB = 'uleditor';
const STORE = 'roots';

export interface StoredRoot {
  uri: string;
  name: string;
  handle: unknown;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'uri' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function storeRoot(root: StoredRoot): Promise<void> {
  await run('readwrite', (store) => store.put(root)).catch(() => {});
}

export async function dropRoot(uri: string): Promise<void> {
  await run('readwrite', (store) => store.delete(uri)).catch(() => {});
}

export async function storedRoots(): Promise<StoredRoot[]> {
  const all = await run('readonly', (store) => store.getAll() as IDBRequest<StoredRoot[]>).catch(() => []);
  return all.filter((r) => !!r && typeof r.uri === 'string' && typeof r.name === 'string' && !!r.handle);
}

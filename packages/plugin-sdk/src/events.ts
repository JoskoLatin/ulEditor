/**
 * Minimalni event primitiv. Namjerno bez ovisnosti — plugin-sdk je javni
 * ugovor i ne smije vući runtime pakete u svaki editor plugin.
 */

export type Disposable = { dispose(): void };

export type Listener<T> = (value: T) => void;

export interface Event<T> {
  (listener: Listener<T>): Disposable;
}

export class Emitter<T> {
  #listeners = new Set<Listener<T>>();

  readonly event: Event<T> = (listener) => {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    // Kopija: listener smije dispose-ati sam sebe tijekom emisije.
    for (const listener of [...this.#listeners]) {
      try {
        listener(value);
      } catch (err) {
        console.error('[uleditor] greška u event listeneru', err);
      }
    }
  }

  get size(): number {
    return this.#listeners.size;
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export function disposeAll(items: Disposable[]): void {
  while (items.length) items.pop()?.dispose();
}

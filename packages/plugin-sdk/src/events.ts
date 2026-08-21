/**
 * A minimal event primitive. Deliberately dependency-free — plugin-sdk is the
 * public contract and must not drag runtime packages into every editor plugin.
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
    // A copy: a listener may dispose of itself during emission.
    for (const listener of [...this.#listeners]) {
      try {
        listener(value);
      } catch (err) {
        console.error('[uleditor] error inside an event listener', err);
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

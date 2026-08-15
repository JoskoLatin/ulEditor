/**
 * Ugovor koji svaki editor implementira.
 *
 * Ovo je javni API projekta i od v0.1 ide pod semver. Dodavanje neobaveznog
 * člana je minor; mijenjanje potpisa ili semantike postojećeg je major.
 */

import type { Event } from './events.js';
import type { ClipboardPayload } from './clipboard.js';
import type { DocumentHandle, Uri } from './fs.js';
import type { EditorHost } from './host.js';

export type Capability =
  /** Može prikazati sadržaj. Svaki editor mora imati barem ovo. */
  | 'view'
  /** Može mijenjati i spremati natrag u izvorni format. */
  | 'edit'
  /** Može dodavati sloj povrh sadržaja bez mijenjanja originala (PDF bilješke). */
  | 'annotate'
  /** Može izvesti u drugi format. */
  | 'export'
  /** Podržava pretragu unutar dokumenta. */
  | 'search'
  /** Spreman za realtime kolaboraciju (faza 5). */
  | 'collab';

export interface FormatMatcher {
  /** Bez točke, malim slovima: `['ts', 'tsx']`. */
  extensions: string[];
  mimeTypes?: string[];
  /** Potpisi na početku datoteke. Jači signal od ekstenzije. */
  magic?: Uint8Array[];
}

export interface FindQuery {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface FindResult {
  /** Oznaka mjesta, npr. "redak 42" ili "stranica 7". */
  label: string;
  /** Isječak s pogotkom, za prikaz u listi rezultata. */
  preview: string;
  /** Skok na pogodak. */
  reveal(): void;
}

export interface SaveResult {
  uri: Uri;
  /** Značajke izvornog dokumenta koje spremanje nije moglo reproducirati.
   *  Prazno polje znači potpuni round-trip. */
  lostFidelity: string[];
}

export interface SaveTarget {
  uri: Uri;
  /** Kad je zadano, editor izvozi u taj format umjesto da sprema izvorni. */
  format?: string;
}

export interface EditorInstance {
  mount(container: HTMLElement): void | Promise<void>;
  unmount(): void;

  isDirty(): boolean;
  save(target?: SaveTarget): Promise<SaveResult>;

  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;

  find(query: FindQuery): Promise<FindResult[]>;

  copySelection(): Promise<ClipboardPayload | null>;
  paste(payload: ClipboardPayload): Promise<boolean>;

  /** Fokusira uređivačku površinu — shell zove pri prebacivanju taba. */
  focus(): void;

  readonly onDirtyChange: Event<boolean>;
  /** Poruka za statusnu traku, npr. "Red 12, Stup 4" ili "Stranica 3 od 18". */
  readonly onStatusChange: Event<string>;
}

export interface EditorProvider {
  /** Reverse-DNS, npr. `org.uleditor.pdf`. */
  id: string;
  displayName: string;
  matches: FormatMatcher;
  capabilities: Capability[];
  /** Veći broj pobjeđuje kad više providera odgovara istoj datoteci. */
  priority: number;

  createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance>;
}

export function hasCapability(provider: EditorProvider, cap: Capability): boolean {
  return provider.capabilities.includes(cap);
}

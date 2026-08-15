/**
 * Knjižnica dokumenata — mobilni način dolaska do datoteke.
 *
 * Explorer sa stablom mapa pretpostavlja da korisnik zna gdje mu nešto stoji.
 * Na telefonu ne zna i nema razloga znati: zna da ima nekakav ugovor u PDF-u.
 * Zato se ovdje ne otvara mapa, nego se uređaj pregleda i ponudi što je nađeno,
 * najnovije prvo.
 *
 * Skeniranje radi Rust (`scan_library`) — isti razlog kao kod pretrage: preko
 * IPC-a ide samo popis, ne sadržaj.
 *
 * **Uskraćen pristup se prijavljuje, ne prešućuje.** Android bez dozvole za
 * pohranu vrati mape bez ijedne datoteke i ne javi grešku. Aplikacija bi tako
 * tvrdila da na telefonu nema dokumenata iako ih ima stotine. Jezgra tu razliku
 * prepozna i ovdje postaje `blocked`, na temelju čega prikaz nudi uputu umjesto
 * prazne liste.
 */

import { create } from 'zustand';
import { type FormatId, type Uri } from '@uleditor/plugin-sdk';

import { isTauri } from '../host/tauri-fs.js';

export interface LibraryItem {
  uri: Uri;
  name: string;
  format: FormatId;
  size: number;
  /** Unix ms; nedostaje kad ga platforma ne daje. */
  modified?: number;
  /** Mapa u kojoj je nađena, npr. `Download/Foxit`. */
  folder: string;
}

export type LibraryPhase = 'idle' | 'scanning' | 'done';

interface LibraryState {
  phase: LibraryPhase;
  items: LibraryItem[];
  /** Filtar po imenu; prazan znači sve. */
  filter: string;
  /** Odabrani format ili `null` za sve. */
  format: FormatId | null;
  /** Sustav skriva datoteke — treba dozvola, nije prazan uređaj. */
  blocked: boolean;
  scannedDirs: number;
  truncated: boolean;
  error: string | null;

  setFilter(filter: string): void;
  setFormat(format: FormatId | null): void;
}

export const useLibrary = create<LibraryState>((set) => ({
  phase: 'idle',
  items: [],
  filter: '',
  format: null,
  blocked: false,
  scannedDirs: 0,
  truncated: false,
  error: null,

  setFilter: (filter) => set({ filter }),
  setFormat: (format) => set({ format }),
}));

interface RawScan {
  entries: {
    uri: string;
    name: string;
    format: string;
    size: number;
    modified: number | null;
    folder: string;
  }[];
  scannedDirs: number;
  seenFiles: number;
  truncated: boolean;
}

/**
 * Pregledava uređaj. Ponovni poziv uvijek kreće ispočetka — knjižnica namjerno
 * nema predmemoriju, jer bi zastarjeli popis bio gori od kratkog čekanja.
 */
export async function scanLibrary(): Promise<void> {
  if (!isTauri()) {
    useLibrary.setState({
      phase: 'done',
      items: [],
      error: 'Library needs the desktop or mobile app.',
    });
    return;
  }

  useLibrary.setState({ phase: 'scanning', error: null });

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const scan = await invoke<RawScan>('scan_library', { limit: 2000 });

    /*
     * Prazan popis uz pregledane mape a nijednu viđenu datoteku znači da sustav
     * skriva sadržaj. Ista se provjera radi i u jezgri; ovdje se ponavlja jer
     * prikaz o njoj ovisi, a jezgra šalje brojke, ne zaključak.
     */
    const blocked = scan.seenFiles === 0 && scan.scannedDirs > 1;

    const fresh: LibraryItem[] = scan.entries.map((entry) => ({
      uri: entry.uri as Uri,
      name: entry.name,
      format: entry.format as FormatId,
      size: entry.size,
      modified: entry.modified ?? undefined,
      folder: entry.folder,
    }));

    /*
     * Uz zapreku popis ostaje kakav je bio. Prazan rezultat tada nije podatak o
     * uređaju nego o dozvoli, pa brisanje već prikazanih dokumenata značilo bi
     * tvrditi da su nestali.
     */
    const previous = useLibrary.getState().items;

    useLibrary.setState({
      phase: 'done',
      items: blocked ? previous : merge(previous, fresh),
      blocked,
      scannedDirs: scan.scannedDirs,
      truncated: scan.truncated,
    });
  } catch (err) {
    useLibrary.setState({
      phase: 'done',
      items: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Spaja novi pregled s onim što se već prikazuje.
 *
 * Ponovni pregled ne ruši popis i ne gradi ga ispočetka: stavka koja se nije
 * promijenila zadržava **isti objekt**, pa React ne prerenderira redak koji
 * stoji pred korisnikom. Novo se dodaje, promijenjeno se osvježava.
 *
 * Ono što se više ne nađe **ispada**. Popis koji samo raste ubrzo počne nuditi
 * obrisane datoteke, a dokument koji se ne otvori gori je od dokumenta kojeg
 * nema — knjižnica bi izgubila povjerenje na istom mjestu na kojem ga gradi.
 *
 * Iznimka je zapreka: kad Android sakrije datoteke, jezgra vrati prazno, a
 * pozivatelj tada uopće ne dira popis (vidi `blocked`).
 */
function merge(previous: LibraryItem[], fresh: LibraryItem[]): LibraryItem[] {
  if (previous.length === 0) return fresh;

  const known = new Map(previous.map((item) => [item.uri, item]));

  return fresh.map((item) => {
    const old = known.get(item.uri);
    const unchanged =
      old && old.modified === item.modified && old.size === item.size && old.name === item.name;
    return unchanged ? old : item;
  });
}

/** Formati koji se stvarno pojavljuju, po učestalosti — za trake filtra. */
export function formatCounts(items: LibraryItem[]): { format: FormatId; count: number }[] {
  const counts = new Map<FormatId, number>();
  for (const item of items) counts.set(item.format, (counts.get(item.format) ?? 0) + 1);
  return [...counts.entries()]
    .map(([format, count]) => ({ format, count }))
    .sort((a, b) => b.count - a.count);
}

export function filterItems(
  items: LibraryItem[],
  filter: string,
  format: FormatId | null,
): LibraryItem[] {
  const needle = filter.trim().toLowerCase();
  return items.filter((item) => {
    if (format && item.format !== format) return false;
    if (!needle) return true;
    return item.name.toLowerCase().includes(needle) || item.folder.toLowerCase().includes(needle);
  });
}

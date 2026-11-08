/**
 * How *zid*, Arak's wall, groups the library: Danas, Ovaj tjedan, then one
 * group per month, newest first (ADR 0009, Use 1, "See the documents").
 *
 * By the day each document was last changed (`modified`, which a library entry
 * carries when the platform gives it), in the phone's own time zone:
 *
 * - **today**: since midnight, and anything dated later than now, since a clock
 *   set wrong somewhere is no reason to hide a document at the bottom;
 * - **this week**: since Monday's midnight, the week as it is counted here;
 *   on a Monday that is today alone, and the group is not drawn;
 * - **a month**: each month before that, its name with the year when the year
 *   is not this one;
 * - **undated**: what the platform gave no date for, last.
 *
 * Pure: the list, the moment and the language in, the groups out.
 */

import type { LibraryItem } from '../../../shell/library.js';

export interface WallGroup {
  /** `today`, `week`, `undated` or `YYYY-MM`. */
  id: string;
  title: string;
  items: LibraryItem[];
}

export interface WallTitles {
  today: string;
  week: string;
  undated: string;
}

function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/** Monday 00:00 of the week `at` falls in. */
function startOfWeek(at: Date): Date {
  const day = startOfDay(at);
  const sinceMonday = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - sinceMonday);
}

function monthTitle(year: number, month: number, now: Date, locale: string): string {
  const options: Intl.DateTimeFormatOptions =
    year === now.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' };
  const title = new Intl.DateTimeFormat(locale, options).format(new Date(year, month, 1));
  return title.charAt(0).toLocaleUpperCase(locale) + title.slice(1);
}

export function groupByDate(items: readonly LibraryItem[], now: Date, locale: string, titles: WallTitles): WallGroup[] {
  const today = startOfDay(now).getTime();
  const week = startOfWeek(now).getTime();
  const groups = new Map<string, WallGroup>();
  const add = (id: string, title: () => string, item: LibraryItem) => {
    let group = groups.get(id);
    if (!group) {
      group = { id, title: title(), items: [] };
      groups.set(id, group);
    }
    group.items.push(item);
  };

  const dated = items
    .filter((item) => typeof item.modified === 'number' && Number.isFinite(item.modified))
    .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  for (const item of dated) {
    const at = item.modified ?? 0;
    if (at >= today) add('today', () => titles.today, item);
    else if (at >= week) add('week', () => titles.week, item);
    else {
      const day = new Date(at);
      const year = day.getFullYear();
      const month = day.getMonth();
      add(`${year}-${String(month + 1).padStart(2, '0')}`, () => monthTitle(year, month, now, locale), item);
    }
  }
  for (const item of items) {
    if (typeof item.modified !== 'number' || !Number.isFinite(item.modified)) add('undated', () => titles.undated, item);
  }
  return [...groups.values()];
}

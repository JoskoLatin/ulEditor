/**
 * Prikaz imena formata.
 *
 * `plugin-sdk` nosi engleski izvornik jer ugovor ne smije ovisiti o jeziku
 * sučelja. Prijevod se dogodi točno ovdje, na granici prema UI-u.
 */

import { FORMATS, type FormatId } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

export function formatLabel(id: FormatId): string {
  return t(FORMATS[id].label);
}

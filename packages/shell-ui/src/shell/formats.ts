/**
 * Displaying format names.
 *
 * `plugin-sdk` carries the English source because the contract must not depend on
 * the interface language. The translation happens exactly here, at the boundary
 * towards the UI.
 */

import { FORMATS, type FormatId } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

export function formatLabel(id: FormatId): string {
  return t(FORMATS[id].label);
}

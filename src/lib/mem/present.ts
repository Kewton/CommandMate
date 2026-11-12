/**
 * The one way an item leaves the server (Issue #4221, design §6.4・§12.3).
 *
 * Every exit — the list, `--json`, the version-conflict answer, the brief of #4223,
 * the screen of #4227 — goes through {@link presentMemItem}. A row checked against
 * an older rule set is re-read against the current one, and if any free field
 * matches, the item goes out in the withheld shape: the fields that say what and
 * whose it is, and none of the fields anyone typed (2nd review 6). The stored value
 * is left as it is; a person fixes or purges it.
 *
 * @module lib/mem/present
 */

import {
  MEM_WITHHELD_KEPT_KEYS,
  type MemCloseReason,
  type MemCloseWhen,
  type MemItemOwner,
  type MemItemView,
  type MemKind,
  type MemState,
} from '@/types/mem';
import { readStoredCloseWhen } from './close-when';
import { findSecretRule, MEM_SECRET_RULES, MEM_SECRET_RULES_VERSION, type MemSecretRule } from './secret-scan';
import { memItemStaleness } from './staleness';

/** An item as the store holds it, whichever table it is in. */
export interface MemRecord {
  id: string;
  kind: MemKind;
  state: MemState;
  text: string;
  closeWhen: string | null;
  promoteTo: string | null;
  quote: string | null;
  quoteAt: number | null;
  evidence: string[];
  closeNote: string | null;
  owner: MemItemOwner;
  createdBy: 'agent' | 'human';
  updatedBy: 'agent' | 'human' | 'server';
  version: number;
  checkedRulesVersion: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  closeReason: MemCloseReason | null;
}

export interface PresentOptions {
  now?: number;
  /** derived: shown, not evaluated. */
  frozen?: boolean;
  /** The rule set to re-read with; the current one unless a test raises the version. */
  rules?: readonly MemSecretRule[];
  rulesVersion?: number;
}

/** The free fields in the order they are re-read; the first match names the field. */
function freeFields(record: MemRecord): Array<[string, string]> {
  const fields: Array<[string, string]> = [['text', record.text]];
  if (record.quote !== null) fields.push(['quote', record.quote]);
  record.evidence.forEach((entry) => fields.push(['evidence', entry]));
  if (record.promoteTo !== null) fields.push(['promoteTo', record.promoteTo]);
  if (record.closeNote !== null) fields.push(['closeNote', record.closeNote]);
  return fields;
}

/** The field and rule a stored record matches under the given rules, or null. */
export function findWithheld(
  record: MemRecord,
  rules: readonly MemSecretRule[] = MEM_SECRET_RULES,
  rulesVersion: number = MEM_SECRET_RULES_VERSION
): { field: string; rule: string } | null {
  if (record.checkedRulesVersion >= rulesVersion) return null;
  for (const [field, value] of freeFields(record)) {
    const rule = findSecretRule(value, rules);
    if (rule) return { field, rule };
  }
  return null;
}

const iso = (epoch: number | null): string | null => (epoch === null ? null : new Date(epoch).toISOString());

export function presentMemItem(record: MemRecord, options: PresentOptions = {}): MemItemView {
  const closeWhen: MemCloseWhen | null = readStoredCloseWhen(record.closeWhen);
  const full: MemItemView = {
    id: record.id,
    kind: record.kind,
    state: record.state,
    text: record.text,
    closeWhen,
    promoteTo: record.promoteTo,
    quote: record.quote,
    quoteAt: iso(record.quoteAt),
    evidence: record.evidence,
    closeNote: record.closeNote,
    owner: record.owner,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    version: record.version,
    createdAt: iso(record.createdAt) as string,
    updatedAt: iso(record.updatedAt) as string,
    closedAt: iso(record.closedAt),
    closeReason: record.closeReason,
    stale:
      memItemStaleness(
        { kind: record.kind, state: record.state, closeWhen, updatedAt: record.updatedAt },
        options.now ?? Date.now()
      ) === 'stale',
    frozen: options.frozen ?? false,
  };

  const hit = findWithheld(record, options.rules, options.rulesVersion);
  if (!hit) return full;
  const kept: Record<string, unknown> = {};
  for (const key of MEM_WITHHELD_KEPT_KEYS) kept[key] = full[key];
  return { ...(kept as unknown as MemItemView), withheld: { code: 'secret_like', field: hit.field, rule: hit.rule } };
}

/**
 * The rules of the mem prompts and their fixed wording (Issue #4226, design §3.2・§3.4).
 *
 * Pure: the service hands the materials it read in the build of its last await (INV-A,
 * §3.6) and gets the hits back. The materials are ids, kinds, states, times, versions,
 * condition results and owners — never an item's text. Whether something should have
 * been written and was not is not found here: the rules look at what is written and at
 * an empty `now`.
 *
 * @module lib/mem-suggest/rules
 */

import { MEM_OPEN_LIMITS } from '@/lib/db/mem-db';
import { readStoredCloseWhen } from '@/lib/mem/close-when';
import type { MemRecord } from '@/lib/mem/present';
import { memItemStaleness } from '@/lib/mem/staleness';
import type { MemConditionView, MemKind } from '@/types/mem';
import { MEM_SUGGEST_CODES, type MemSuggestCode, type MemSuggestSkipped } from '@/types/mem-suggest';

/** The caller as the rules see it. */
export interface SuggestCaller {
  instanceId: string;
  /** The instance's incarnation now (null: it never wrote to mem). */
  incarnation: string | null;
  /** On the roster the worktree resolves to (a derived primary included). */
  onRoster: boolean;
}

export interface SuggestMaterials {
  full: boolean;
  now: number;
  /** null: no identity (no `now_*`, and only items a person wrote). */
  caller: SuggestCaller | null;
  /** The caller's `now` of this worktree, or null. */
  slot: MemRecord | null;
  /** The open items of the branch (every author: the rules pick the caller's). */
  items: MemRecord[];
  /** Open items per kind on the branch (A's `countOpenItems`). */
  openCounts: Partial<Record<Exclude<MemKind, 'now'>, number>>;
  /** full: the condition results that may be used (their version checked, §3.2). */
  conditions: ReadonlyMap<string, MemConditionView>;
  /** full: the caller's `now`, closed by its condition during this request, version checked. */
  closedNow: MemRecord | null;
  /** full: results dropped because the item changed under the query (`version_changed`). */
  versionChanged: readonly MemSuggestSkipped[];
  /** How many `path:` evidence entries of an item are missing now. */
  missingEvidence: (record: MemRecord) => number;
  /** Whether an item is withheld (a stored value looks like a secret). */
  withheld: (record: MemRecord) => boolean;
}

/** One rule that holds: what goes into the fingerprint, and the items it names. */
export interface SuggestHit {
  code: MemSuggestCode;
  itemIds: string[];
  versions: number[];
  material: unknown;
}

export interface SuggestJudgement {
  hits: SuggestHit[];
  skipped: MemSuggestSkipped[];
  /** The codes judged (hold or not); the ones not here were unavailable. */
  evaluated: MemSuggestCode[];
}

const NOT_FOUND_REASONS = new Set(['relay_not_found', 'not_found']);
const MANUAL_KINDS: readonly MemKind[] = ['next', 'external', 'note'];
const COUNTED_KINDS: ReadonlyArray<Exclude<MemKind, 'now'>> = ['waiting', 'next', 'external', 'note', 'decision'];

function staleOf(record: MemRecord, now: number): boolean {
  return memItemStaleness({ kind: record.kind, state: record.state, closeWhen: readStoredCloseWhen(record.closeWhen), updatedAt: record.updatedAt }, now) === 'stale';
}

/**
 * A's ownership (`ownedBy`): the instance and its incarnation, never `owner.worktreeId`
 * (it stays the id the item was written under, and a rename must not drop one's own
 * items). Items a person wrote belong to nobody's session and are everyone's to see.
 */
function ownsOrPerson(caller: SuggestCaller | null, record: MemRecord): boolean {
  if (record.createdBy === 'human') return true;
  if (!caller || caller.incarnation === null) return false;
  return record.owner.instanceId === caller.instanceId && record.owner.incarnation === caller.incarnation;
}

const byId = (a: MemRecord, b: MemRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function hitOf(code: MemSuggestCode, records: MemRecord[], material: (record: MemRecord) => unknown[]): SuggestHit | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort(byId);
  return { code, itemIds: sorted.map((r) => r.id), versions: sorted.map((r) => r.version), material: sorted.map(material) };
}

/** Apply every rule of the table to the materials. */
export function judgeSuggestions(m: SuggestMaterials): SuggestJudgement {
  const hits: SuggestHit[] = [];
  const skipped: MemSuggestSkipped[] = [];
  const evaluated: MemSuggestCode[] = [];
  const own = m.items.filter((record) => ownsOrPerson(m.caller, record));
  const push = (hit: SuggestHit | null) => {
    if (hit) hits.push(hit);
  };

  // now_condition_met first: a `now` that closed by its condition is not "missing".
  let conditionMet = false;
  if (!m.full) skipped.push({ code: 'now_condition_met', reason: 'quiet_no_query' });
  else if (!m.caller) skipped.push({ code: 'now_condition_met', reason: 'no_instance' });
  else {
    evaluated.push('now_condition_met');
    const closed = m.closedNow;
    if (closed && closed.owner.instanceId === m.caller.instanceId && m.caller.incarnation !== null && closed.owner.incarnation === m.caller.incarnation) {
      conditionMet = true;
      push({ code: 'now_condition_met', itemIds: [closed.id], versions: [closed.version], material: [closed.id, closed.version, 'met'] });
    }
  }

  if (!m.caller) {
    skipped.push({ code: 'now_missing', reason: 'no_instance' }, { code: 'now_stale', reason: 'no_instance' });
  } else {
    evaluated.push('now_missing', 'now_stale');
    if (m.slot === null && m.caller.onRoster && !conditionMet) {
      push({ code: 'now_missing', itemIds: [], versions: [], material: [m.caller.instanceId, 'missing'] });
    }
    if (m.slot !== null && staleOf(m.slot, m.now)) push(hitOf('now_stale', [m.slot], (r) => [r.id, r.version]));
  }

  evaluated.push('decision_unreflected');
  push(
    hitOf(
      'decision_unreflected',
      own.filter(
        (r) =>
          r.kind === 'decision' &&
          (r.state === 'open' || r.state === 'recorded') &&
          (staleOf(r, m.now) || (m.full && m.conditions.get(r.id)?.unreflected === true))
      ),
      (r) => [r.id, r.version, r.state]
    )
  );

  evaluated.push('manual_stale');
  push(hitOf('manual_stale', own.filter((r) => MANUAL_KINDS.includes(r.kind) && r.state === 'open' && staleOf(r, m.now)), (r) => [r.id, r.version]));

  evaluated.push('open_count');
  const over = COUNTED_KINDS.filter((kind) => (m.openCounts[kind] ?? 0) >= MEM_OPEN_LIMITS[kind].warn);
  if (over.length > 0) {
    push({ code: 'open_count', itemIds: [], versions: [], material: over.map((kind) => [kind, Math.floor((m.openCounts[kind] ?? 0) / 10)]) });
  }

  if (!m.full) skipped.push({ code: 'ref_unknown', reason: 'quiet_no_query' });
  else {
    evaluated.push('ref_unknown');
    const unknown = own.filter((r) => {
      const condition = m.conditions.get(r.id);
      return condition !== undefined && condition.result === 'unknown' && NOT_FOUND_REASONS.has(condition.reason);
    });
    push(hitOf('ref_unknown', unknown, (r) => [r.id, r.version, m.conditions.get(r.id)?.reason ?? null]));
  }

  evaluated.push('evidence_missing');
  const missing: MemRecord[] = [];
  for (const record of own) {
    if (!record.evidence.some((entry) => entry.startsWith('path:'))) continue;
    if (m.withheld(record)) {
      skipped.push({ code: 'evidence_missing', reason: 'withheld', itemId: record.id });
      continue;
    }
    if (m.missingEvidence(record) > 0) missing.push(record);
  }
  push(hitOf('evidence_missing', missing, (r) => [r.id, r.version, m.missingEvidence(r)]));

  evaluated.push('decision_no_destination');
  push(hitOf('decision_no_destination', own.filter((r) => r.kind === 'decision' && r.state === 'open' && r.promoteTo === null), (r) => [r.id, r.version]));

  // Results dropped because the item changed under the query: never a prompt (§3.2).
  skipped.push(...m.versionChanged);

  const order = (code: MemSuggestCode) => MEM_SUGGEST_CODES.indexOf(code);
  hits.sort((a, b) => order(a.code) - order(b.code));
  return { hits, skipped, evaluated };
}

/** Fixed wording per code (§3.4). No item text, branch name or free input ever goes in. */
export const MEM_SUGGEST_MESSAGES: Readonly<Record<MemSuggestCode, { message: string; command: string | null }>> = {
  now_missing: { message: '`now` がありません。今の作業を書いてください', command: 'commandmate mem now "<…>"' },
  now_stale: { message: '`now` が 1 日以上更新されていません。今の作業で書き換えてください', command: 'commandmate mem now "<…>"' },
  now_condition_met: { message: '`now` の条件が成立して閉じました。次の作業を書いてください', command: 'commandmate mem now "<…>"' },
  decision_unreflected: { message: '未反映の decision があります。画面で承認・反映を確かめてください', command: null },
  manual_stale: { message: '閉じる条件が manual の項目が古くなっています。今も要るか確かめて、更新か close をしてください', command: 'commandmate mem list' },
  open_count: { message: 'open の項目が警告の数に達しました。済んだものを close してください', command: 'commandmate mem list' },
  ref_unknown: { message: '条件の参照先が見つかりません。条件を直すか close してください', command: 'commandmate mem list' },
  evidence_missing: { message: 'evidence の path が今はありません。evidence を更新してください', command: 'commandmate mem list' },
  decision_no_destination: { message: '記録の行き先が無い decision があります。画面で行き先を確かめてください', command: null },
};

/** The byte bound of the quiet line (§3.4). */
export const MEM_SUGGEST_QUIET_LINE_MAX_BYTES = 280;

/** The one quiet line for the new prompts (§3.4), or null when there are none. */
export function formatQuietLine(hits: ReadonlyArray<Pick<SuggestHit, 'code' | 'itemIds'>>): string | null {
  if (hits.length === 0) return null;
  const total = hits.reduce((sum, hit) => sum + Math.max(1, hit.itemIds.length), 0);
  const count = total > 999 ? '999+' : String(total);
  const codes = [...hits].map((hit) => hit.code).sort((a, b) => MEM_SUGGEST_CODES.indexOf(a) - MEM_SUGGEST_CODES.indexOf(b));
  return `[CommandMate mem] 未更新の項目が ${count} 件あります（${codes.join(',')}）。open の項目と now を確かめて更新してください: commandmate mem check --suggest`;
}

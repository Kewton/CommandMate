/**
 * The counts of a branch's decisions (Issue #4355, design `docs/design/mem-decisions-ux-4355.md`
 * §3.1.3・I6): one way of counting for every reader — `commandmate mem decisions`, the
 * screen's branch select and count line (PR2) and the waiting count of #4354.
 *
 * - `open` is the number of decisions whose state is `open`; `recorded` those `recorded`
 *   (written to the canonical place, the reflection not yet confirmed). `promoted` and
 *   `closed` are not counted.
 * - `approvable` is whether the branch's mode is `on` (only then can a person approve on the
 *   screen). `off` / `derived` count their open decisions all the same: an item is still
 *   waiting, it just cannot be approved now.
 * - `ambiguous` (the roots of the same git disagree on the branch's mode) cannot be counted:
 *   `open` / `recorded` are null, never 0, so no reader says "nothing waits" when it does not
 *   know.
 *
 * Issue #4354 (design `docs/design/mem-approval-4354.md` §4.1): given the clock (`now`), the same
 * function also answers the breakdown of the open decisions and what ended in the last 24 hours
 * ({@link DecisionCountsDetail}). The fields above keep their meaning and type; the new ones are
 * added beside them, and every `open` decision is in exactly one of `pending` / `grants` /
 * `expiredGrants` / `noDestination` (their sum is `open`).
 *
 * Pure and free of path aliases: the CLI build (`tsconfig.cli.json`, no `paths`) imports it.
 *
 * @module lib/promote/decision-counts
 */

import type { MemCloseReason, MemCloseWhen, MemKind, MemMode, MemState } from '../../types/mem';

/** The mode a count is taken under: mem's modes, or `ambiguous` when the roots disagree. */
export type DecisionCountsMode = MemMode | 'ambiguous';

export interface DecisionCounts {
  mode: DecisionCountsMode;
  /** The mode is `on`: a person can approve the open decisions on the screen. */
  approvable: boolean;
  /** Decisions in `open`; null when the mode is `ambiguous` (unknown, not 0). */
  open: number | null;
  /** Decisions in `recorded` (the reflection waits for a person); null when `ambiguous`. */
  recorded: number | null;
}

/**
 * Issue #4354 §4.1: the fields added when the clock is given. Each is null when `ambiguous`.
 *
 * - `pending` (承認待ち): an `open` decision with a destination. A withheld item (its destination
 *   not shown) counts here: it is not known to have none.
 * - `grants` (許可): an `open` decision with no destination whose `at` is marked as an expiry
 *   (`expires: true`) and has not passed.
 * - `expiredGrants`: the same, its expiry passed and the item not closed yet.
 * - `noDestination`: an `open` decision with no destination and no marked expiry, whatever its
 *   condition (none, an unmarked `at`, `issue`, `pr`, `branch`).
 * - `endedGrants`: grants closed within {@link DECISION_RECENT_WINDOW_MS} (expired or withdrawn).
 * - `withdrawnDecisions`: decisions that are not grants, withdrawn within the window.
 */
export interface DecisionCountsDetail extends DecisionCounts {
  pending: number | null;
  grants: number | null;
  expiredGrants: number | null;
  noDestination: number | null;
  endedGrants: number | null;
  withdrawnDecisions: number | null;
}

/** §4.1: how far back `endedGrants` / `withdrawnDecisions` look (the purge keeps these rows as long). */
export const DECISION_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The items as a count reads them (a `MemItemView` or a `MemRecord` both fit). The fields past
 * `state` are read only for the breakdown: the condition as stored (JSON) or as shown, the time of
 * the close as epoch ms or ISO.
 */
export interface DecisionCountsItem {
  kind: MemKind;
  state: MemState;
  promoteTo?: string | null;
  closeWhen?: string | MemCloseWhen | null;
  closedAt?: number | string | null;
  closeReason?: MemCloseReason | null;
}

/** The marked expiry (`{ type: 'at', expires: true }`) of a condition, in epoch ms, or null. */
function markedExpiryOf(closeWhen: DecisionCountsItem['closeWhen']): number | null {
  let value: unknown = closeWhen ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const at = value as { type?: unknown; epochMs?: unknown; expires?: unknown } | null;
  if (!at || at.type !== 'at' || at.expires !== true || typeof at.epochMs !== 'number') return null;
  return at.epochMs;
}

function closedAtOf(item: DecisionCountsItem): number | null {
  if (typeof item.closedAt === 'number') return item.closedAt;
  if (typeof item.closedAt === 'string') {
    const parsed = Date.parse(item.closedAt);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** I6: the counts of `items` under `mode`. Items that are not decisions are ignored. */
export function decisionCountsOf(mode: DecisionCountsMode, items: readonly DecisionCountsItem[]): DecisionCounts;
/** Issue #4354 §4.1: the same, with the breakdown read at `now`. */
export function decisionCountsOf(mode: DecisionCountsMode, items: readonly DecisionCountsItem[], now: number): DecisionCountsDetail;
export function decisionCountsOf(mode: DecisionCountsMode, items: readonly DecisionCountsItem[], now?: number): DecisionCounts | DecisionCountsDetail {
  if (mode === 'ambiguous') {
    const unknown: DecisionCounts = { mode, approvable: false, open: null, recorded: null };
    if (now === undefined) return unknown;
    return { ...unknown, pending: null, grants: null, expiredGrants: null, noDestination: null, endedGrants: null, withdrawnDecisions: null };
  }
  let open = 0;
  let recorded = 0;
  let pending = 0;
  let grants = 0;
  let expiredGrants = 0;
  let noDestination = 0;
  let endedGrants = 0;
  let withdrawnDecisions = 0;
  for (const item of items) {
    if (item.kind !== 'decision') continue;
    if (item.state === 'recorded') recorded += 1;
    if (now === undefined) {
      if (item.state === 'open') open += 1;
      continue;
    }
    // `undefined`: withheld (the destination is not shown), so not known to be absent.
    const hasDestination = item.promoteTo !== null;
    const expiry = hasDestination ? null : markedExpiryOf(item.closeWhen);
    if (item.state === 'open') {
      open += 1;
      if (hasDestination) pending += 1;
      else if (expiry === null) noDestination += 1;
      else if (now >= expiry) expiredGrants += 1;
      else grants += 1;
    } else if (item.state === 'closed') {
      const closedAt = closedAtOf(item);
      if (closedAt === null || closedAt < now - DECISION_RECENT_WINDOW_MS) continue;
      if (expiry !== null) endedGrants += 1;
      else if (item.closeReason === 'withdrawn') withdrawnDecisions += 1;
    }
  }
  const counts: DecisionCounts = { mode, approvable: mode === 'on', open, recorded };
  if (now === undefined) return counts;
  return { ...counts, pending, grants, expiredGrants, noDestination, endedGrants, withdrawnDecisions };
}

/**
 * One branch of the decision screen's select (PR2, §3.1.2): its name and its counts. The
 * screen uses the name only (its count is the panel's list's, 5-2b); the counts are the API's.
 */
export interface DecisionBranchView extends DecisionCounts {
  branch: string;
}

/** `GET /api/repositories/:id/mem/decisions/branches` (§4.1). */
export interface DecisionBranchesBody {
  ok: true;
  branches: DecisionBranchView[];
}

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
 * Pure and free of path aliases: the CLI build (`tsconfig.cli.json`, no `paths`) imports it.
 *
 * @module lib/promote/decision-counts
 */

import type { MemKind, MemMode, MemState } from '../../types/mem';

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

/** The items as a count reads them (a `MemItemView` or a `MemRecord` both fit). */
export interface DecisionCountsItem {
  kind: MemKind;
  state: MemState;
}

/** I6: the counts of `items` under `mode`. Items that are not decisions are ignored. */
export function decisionCountsOf(mode: DecisionCountsMode, items: readonly DecisionCountsItem[]): DecisionCounts {
  if (mode === 'ambiguous') return { mode, approvable: false, open: null, recorded: null };
  let open = 0;
  let recorded = 0;
  for (const item of items) {
    if (item.kind !== 'decision') continue;
    if (item.state === 'open') open += 1;
    else if (item.state === 'recorded') recorded += 1;
  }
  return { mode, approvable: mode === 'on', open, recorded };
}

/** One branch of the decision screen's select (PR2, §3.1.2): its name and its counts. */
export interface DecisionBranchView extends DecisionCounts {
  branch: string;
}

/** Where the screen's `?item=` is, as seen from the repository and branch it shows (§3.1.4). */
export type DecisionItemWhere = 'here' | 'elsewhere' | 'gone';

/** `GET /api/repositories/:id/mem/decisions/branches` (§4.1). */
export interface DecisionBranchesBody {
  ok: true;
  branches: DecisionBranchView[];
  item?: { id: string; where: DecisionItemWhere };
}

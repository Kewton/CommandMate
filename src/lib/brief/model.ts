/**
 * What a brief is made of before it is drawn (Issue #4223): the entries in their
 * fixed order and the fixed part. Built by `build.ts`, drawn by `render.ts`,
 * cut to the budget by `fit.ts`.
 *
 * @module lib/brief/model
 */

import type { BriefEntry, BriefMode, BriefSourceReport } from '@/types/brief';
import type { SanitizedBranch } from './sanitize';

/** One entry and what the order and the notice receipt need to know about it. */
export interface BriefItem {
  entry: BriefEntry;
  /** 1〜9 for S1〜S9 (design §2.4). */
  sourceIndex: number;
  /** Epoch ms the order sorts by (newest first); null sorts by `entry.id` only. */
  sortAt: number | null;
  /** Set on a notice's entry (S8): what `reserve` hands to #4222. */
  notice?: { id: string; uncertain: boolean };
}

export interface BriefFixed {
  mode: BriefMode;
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
  repositoryId: string | null;
  repositoryIdBytes: number;
  branch: SanitizedBranch | null;
  detached: boolean;
  boundaryKind: string | null;
  generatedAt: string;
  /** `commandmate brief --worktree … --instance … --all` (text). */
  readAll: string;
}

export interface BriefModel {
  fixed: BriefFixed;
  /** Already in the fixed order (`rank.ts`). */
  items: BriefItem[];
  sources: BriefSourceReport[];
  /**
   * Issue #4224 (D2 design §7): the first line of the data after an unplanned end, put
   * right after the fixed 4 lines. A required line: a fit it does not enter makes no text.
   */
  lead?: string;
}

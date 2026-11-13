/**
 * The shapes `commandmate mem decisions` reads and prints (Issue #4355, design
 * `docs/design/mem-decisions-ux-4355.md` §3.4).
 *
 * - `PromoteListWire` / `PromoteReferenceDiffView`: what the server answers (read only).
 * - `MemDecisionsJsonV1` / `MemDecisionDiffJsonV1`: what `--json` prints. `schema: 1` keeps
 *   its keys and their types (I7): a key may be added, never removed or retyped. A reader
 *   (an agent) can rely on them.
 *
 * Type-only, relative imports: the CLI build has no path aliases.
 */

import type { MemItemView } from '../../types/mem';
import type { PromoteOperationView, PromoteReferenceDiffView } from '../../lib/promote/model';
import type { DecisionCounts } from '../../lib/promote/decision-counts';

export type { PromoteReferenceDiffView };

/** `GET /api/repositories/:id/mem/decisions?branch=` as the CLI reads it. */
export interface PromoteListWire {
  ok: true;
  mode: string;
  ambiguous?: { reason: string | null; roots: Array<{ repositoryId: string; name: string }> };
  branch: string;
  /** Issue #4355: absent from a server before it (the CLI then counts with the same function). */
  counts?: DecisionCounts;
  decisions: Array<{ item: MemItemView; unreflected: boolean; operations: PromoteOperationView[] }>;
  unresolved: Array<{ operation: PromoteOperationView; item: MemItemView | null; itemVersion: number | null }>;
}

/** One operation as `--json` prints it: every field a reconcile needs (I8), nothing folded. */
export interface MemDecisionOperationJsonV1 {
  id: string;
  state: PromoteOperationView['state'];
  transitionPending: boolean;
  transitionReason: string | null;
  concurrentEdit: boolean;
  unknownReason: string | null;
  decidedBy: 'server' | 'human' | null;
  effect: PromoteOperationView['effect'];
  destination: PromoteOperationView['destination'];
  resultRef: string | null;
  approvedAt: string;
  settledAt: string | null;
}

export interface MemDecisionJsonV1 {
  id: string;
  /** The item's state now (`open` / `recorded` / `promoted`). */
  state: string;
  version: number;
  /** How many times a person approved it on the screen: its operations, whatever their outcome. */
  humanApprovals: number;
  /** null when withheld. */
  text: string | null;
  promoteTo: string | null;
  quote: string | null;
  quoteAt: string | null;
  createdBy: 'agent' | 'human';
  author: { instanceId: string; worktreeId: string };
  /** The item matches a current rule: no free field is printed (I5). */
  withheld: { code: string; field: string; rule: string } | null;
  stale: boolean;
  operations: MemDecisionOperationJsonV1[];
}

export interface MemDecisionUnresolvedJsonV1 {
  itemId: string;
  /** null: the item was purged. */
  itemVersion: number | null;
  itemState: string | null;
  operation: MemDecisionOperationJsonV1;
}

/** `commandmate mem decisions --json` (schema 1). */
export interface MemDecisionsJsonV1 {
  schema: 1;
  repositoryId: string;
  branch: string;
  mode: string;
  /** Before `--pending` (I7). `open` / `recorded` are null when the mode is `ambiguous`. */
  counts: { open: number | null; recorded: number | null; approvable: boolean };
  /** Whether `--pending` filtered `decisions`. */
  pending: boolean;
  decisions: MemDecisionJsonV1[];
  unresolved: MemDecisionUnresolvedJsonV1[];
}

/** `commandmate mem decisions <itemId> --json` (schema 1): the server's reference diff, without `ok`. */
export type MemDecisionDiffJsonV1 = { schema: 1 } & Omit<PromoteReferenceDiffView, 'ok'>;

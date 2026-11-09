/**
 * The shapes of the promote path (Issue #4225, design `docs/design/mem-promote-4225.md`):
 * a person approves, on the screen, the diff that records a decision of mem in its
 * canonical place (an Issue / PR comment, or a document of a worktree).
 *
 * Types and constants only: imported by the screen too, so nothing here reaches the
 * database, `fs` or a child process.
 *
 * @module lib/promote/model
 */

/** What the record means (design E4). `spec` stays `recorded` until a person confirms the reflection. */
export type PromoteEffect = 'spec' | 'record_only';
export const PROMOTE_EFFECTS: readonly PromoteEffect[] = ['spec', 'record_only'];

export type PromoteQuoteOrigin = 'agent' | 'human' | 'none';

export interface IssueCommentDestination {
  kind: 'issue_comment';
  ref: 'issue' | 'pr';
  /** Lower case. Passed as `--hostname` to every `gh` call of the operation. */
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export interface WorktreeDocDestination {
  kind: 'worktree_doc';
  repositoryId: string;
  branch: string | null;
  worktreeId: string;
  worktreeIncarnation: string;
  /** Normalized, relative to the worktree root. */
  path: string;
  /** What git said when the preview was made (the branch and the git it belongs to). */
  head: { branch: string | null; commonDir: string | null };
}

export type PromoteDestination = IssueCommentDestination | WorktreeDocDestination;

export type PromoteOperationState = 'approved' | 'in_flight' | 'succeeded' | 'failed' | 'unknown' | 'abandoned';

/** Why an approval went back to the person (design §2.3 step 4): one word, nothing of the input. */
export type PromoteReapprovalReason =
  | 'item_changed'
  | 'destination_changed'
  | 'base_changed'
  | 'worktree_recreated'
  | 'branch_changed'
  | 'expired'
  | 'mode_not_on'
  | 'rules_changed'
  | 'withheld'
  | 'prior_record_exists'
  | 'poster_changed'
  | 'preview_mismatch'
  | 'preview_used';

/** Why an outcome is unknown (design §3.2・§3.4). */
export type PromoteUnknownReason =
  | 'timeout'
  | 'remote_error'
  | 'unexpected_response'
  | 'stale_attempt'
  | 'db_error'
  | 'poster_mismatch'
  | 'body_differs'
  | 'block_altered'
  | 'block_missing'
  | 'unreadable'
  | 'not_found_yet'
  | 'lookup_failed';

export type PromoteTransitionReason = 'incarnation_changed' | 'version_conflict' | 'disabled' | 'db_error' | 'state_forbids' | 'not_found';

export type PromoteErrorCode =
  | 'screen_only'
  | 'invalid_request'
  | 'not_found'
  | 'not_decision'
  | 'state_forbids'
  | 'disabled'
  | 'invalid_destination'
  | 'withheld'
  | 'secret_like'
  | 'reapproval_required'
  | 'operation_in_progress'
  | 'diff_not_acknowledged'
  | 'version_conflict'
  | 'worktree_recreated'
  | 'gh_failed'
  | 'internal_error';

export interface PromoteErrorBody {
  ok: false;
  code: PromoteErrorCode;
  message: string;
  reason?: string;
  field?: string;
}

export interface PromotePreviewView {
  id: string;
  operationId: string;
  itemId: string;
  itemVersion: number;
  destination: PromoteDestination;
  baseFingerprint: string;
  body: string;
  bodySha256: string;
  effect: PromoteEffect;
  quoteOrigin: PromoteQuoteOrigin;
  /** Invisible code points of a free field were shown as `[U+XXXX]` (never written silently). */
  invisibleReplaced: boolean;
  acknowledgedOperationIds: string[];
  poster: { id: number; login: string } | null;
  createdAt: string;
  expiresAt: string;
}

export interface PromoteOperationView {
  id: string;
  itemId: string;
  state: PromoteOperationState;
  destinationKind: PromoteDestination['kind'];
  destination: PromoteDestination;
  effect: PromoteEffect;
  resultRef: string | null;
  transitionPending: boolean;
  transitionReason: string | null;
  concurrentEdit: boolean;
  unknownReason: string | null;
  decidedBy: 'server' | 'human' | null;
  approvedAt: string;
  settledAt: string | null;
}

/** How long a preview may be approved (design U4: an initial value). */
export const PROMOTE_PREVIEW_TTL_MS = 30 * 60 * 1000;
/** How long the settled records are kept (design §6.1, U4). */
export const PROMOTE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** An attempt left `in_flight` this long, or by another boot, reads as unknown (B's value). */
export const PROMOTE_ATTEMPT_STALE_MS = 10 * 60 * 1000;
/** The largest document E appends to (design U4). */
export const PROMOTE_DOC_MAX_BYTES = 1024 * 1024;
/** The `gh` timeout of one call. */
export const PROMOTE_GH_TIMEOUT_MS = 15_000;

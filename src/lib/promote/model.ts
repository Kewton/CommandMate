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

/** The banner of a reference diff (Issue #4355, design §3.4.2): it is never what a person approves. */
export const PROMOTE_REFERENCE_NOTICE = 'REFERENCE ONLY — cannot be approved; approve on the screen';

/** Why a reference diff did not resolve a worktree document (design §3.4.2: it never guesses one). */
export type PromoteReferenceUnresolvedReason = 'worktree_required' | 'branch_changed' | 'branch_unresolved' | 'invalid_destination';

/** Where a reference diff's record would go, as far as it can tell without writing or asking gh. */
export type PromoteReferenceDestination =
  | {
      resolved: true;
      kind: 'issue_comment';
      ref: 'issue' | 'pr';
      number: number;
      /** Named in the destination; null: the repository's `origin` names it (not read here). */
      target: { host: string; owner: string; repo: string } | null;
    }
  | { resolved: true; kind: 'worktree_doc'; worktreeId: string; path: string; exists: boolean; headBranch: string | null }
  | { resolved: false; kind: 'worktree_doc'; reason: PromoteReferenceUnresolvedReason; detail?: string };

/**
 * `GET …/decisions/:itemId/diff` (Issue #4355, design §3.4.2・§4.2): the body a promote of
 * the item would write, drawn for reading. No preview row is made, so it cannot be
 * approved: an empty operation id, the time it was drawn, no poster, no expiry, and the
 * quote always as the agent recorded it (unconfirmed).
 */
export interface PromoteReferenceDiffView {
  ok: true;
  reference: true;
  approvable: false;
  notice: typeof PROMOTE_REFERENCE_NOTICE;
  repositoryId: string;
  item: { id: string; version: number; state: string; branch: string | null };
  /** The item's branch's mode; `ambiguous` when the roots disagree. Drawing does not depend on it. */
  mode: string;
  effect: PromoteEffect;
  quoteOrigin: Exclude<PromoteQuoteOrigin, 'human'>;
  destination: PromoteReferenceDestination | null;
  body: string;
  bodySha256: string;
  invisibleReplaced: boolean;
  drawnAt: string;
}

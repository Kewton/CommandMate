/**
 * The promote path of mem (Issue #4225, design `docs/design/mem-promote-4225.md`): a
 * person approves, on the screen, the diff that records a decision in its canonical
 * place, and the outcome of that external write is kept apart from the approval.
 *
 * Every entrance that writes (the database, a comment, a document, or the item's
 * state) asks for the screen's mark first (`isScreenRequest`), and the only callers
 * are the routes of `/api/repositories/:id/mem/decisions/**`. Nothing else starts a
 * write: no brief, check, prompt, Schedule or dreaming reaches here (design E3), so
 * an unattended path never writes outside.
 *
 * The order of one approval (design §2.3):
 * 1. Synchronously: the preview, what the screen sent back, the context worktree's
 *    lifetime (fixed here and kept in the operation, §3.5).
 * 2. Await: git's HEAD of the document's worktree, or gh (the token once, the poster
 *    and the Issue with that token).
 * 3. In the target's synchronous stretch: every check, the operation and its attempt,
 *    and for a document the append itself.
 * 4. A comment's POST (await), its outcome, then A's entrance with the values fixed in 1.
 *
 * An unknown outcome is never sent again by itself: only a person's reconcile looks for
 * the mark, and only a new approval writes again.
 *
 * @module lib/promote/service
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getMemRecord, listMem, type MemScope } from '@/lib/db/mem-db';
import { memModeOnFor } from '@/lib/db/mem-close-db';
import {
  abandonPromoteOperation,
  acceptFoundPromoteOperation,
  acknowledgePromoteTransition,
  beginPromoteTransition,
  claimPromoteOperation,
  destinationOf,
  docOperationsFor,
  finishPromoteTransition,
  getPromoteOperation,
  getPromotePreview,
  hasActivePromoteOperation,
  insertPromotePreview,
  invalidatePromotePreview,
  listPromoteOperations,
  listUnresolvedPromoteOperations,
  prunePromoteRecords,
  recordedOperationIds,
  settlePromoteOperation,
  settleStalePromoteAttempts,
  PROMOTE_MARK_FOUND_REASONS,
  type PromoteMarkFoundReason,
  type PromoteOperationRow,
  type PromotePreviewRow,
  type PromoteSettle,
  type PromoteTransitionRead,
} from '@/lib/db/mem-promote-db';
import { getWorktreeById, getWorktreesByRepository } from '@/lib/db/worktree-db';
import { getRepositoryById, type Repository } from '@/lib/db/db-repository';
import { resolveWorktreeIdWithAlias } from '@/lib/db/worktree-alias-db';
import { createLogger } from '@/lib/logger';
import { parseOriginUrl } from '@/lib/mem/close-when';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import { getOrCreateWorktreeIncarnation, getWorktreeIncarnation, worktreeIncarnationAlive } from '@/lib/mem/incarnation';
import { memServerBootId } from '@/lib/mem/process-boot';
import { findWithheld, presentMemItem, type MemRecord } from '@/lib/mem/present';
import { MEM_SECRET_RULES_VERSION } from '@/lib/mem/secret-scan';
import { memSettleDecisionTransition, type MemOutcome, type MemServiceDeps } from '@/lib/mem/service';
import { decideMemTarget, withMemTarget, type MemTarget, type MemTargetSpec } from '@/lib/mem/target';
import {
  AgentRoleTargetNotFoundError,
  MembershipUnsettledError,
  withSettledRepositoryMembership,
  type RoleRepositoryMembership,
} from '@/lib/agent-roles/resolve';
import { validatePromoteTo, validateQuote } from '@/lib/mem/validate';
import { isScreenRequest } from '@/lib/security/screen-request';
import type { MemDecisionTransition } from '@/lib/db/mem-db';
import { checkDocPath, docBaseFingerprint, issueBaseFingerprint, parsePromoteTo, resolveIssueTarget } from './destination';
import { docBlockOf, reconcileDocBlockFinding, writeDocBlock, type DocWriteHooks } from './doc-write';
import {
  defaultGhRun,
  fixedTokenEnv,
  listGhComments,
  postGhComment,
  readGhIssue,
  readGhToken,
  readGhUser,
  type GhRun,
} from './github-write';
import {
  PROMOTE_ATTEMPT_STALE_MS,
  PROMOTE_EFFECTS,
  PROMOTE_PREVIEW_TTL_MS,
  type IssueCommentDestination,
  type PromoteDestination,
  type PromoteEffect,
  type PromoteErrorBody,
  type PromoteErrorCode,
  type PromoteOperationView,
  type PromotePreviewView,
  type PromoteQuoteOrigin,
  type PromoteReapprovalReason,
  type PromoteTransitionReason,
  type WorktreeDocDestination,
} from './model';
import { commentMark, itemFingerprint, renderPromoteBody, sha256 } from './render';

const logger = createLogger('mem-promote');

type ScreenRequest = Parameters<typeof isScreenRequest>[0];

export interface PromoteHooks {
  /** The document's write (test seams of `doc-write.ts`). */
  doc?: DocWriteHooks;
  /** After the POST answered, before its outcome is written. Throwing here is the database update failing. */
  afterPost?: () => void;
  /** Replaces A's entrance's answer (a transition made to fail). */
  transition?: () => MemOutcome | null;
}

export interface PromoteDeps {
  now?: () => number;
  bootId?: () => string;
  gh?: GhRun;
  originUrl?: (worktreePath: string) => Promise<string | null>;
  /** What the mem target asks git (and the HEAD of a document's worktree). */
  mem?: MemServiceDeps;
  hooks?: PromoteHooks;
}

const STATUS: Record<PromoteErrorCode, number> = {
  screen_only: 403,
  invalid_request: 400,
  not_found: 404,
  not_decision: 409,
  state_forbids: 409,
  disabled: 409,
  invalid_destination: 400,
  withheld: 409,
  secret_like: 400,
  reapproval_required: 409,
  operation_in_progress: 409,
  diff_not_acknowledged: 409,
  version_conflict: 409,
  worktree_recreated: 409,
  gh_failed: 502,
  internal_error: 500,
};

const MESSAGES: Record<PromoteErrorCode, string> = {
  screen_only: 'This change is made from the screen only',
  invalid_request: 'The request is not valid',
  not_found: 'Not found',
  not_decision: 'Only a decision is promoted',
  state_forbids: 'The item or operation is in a state that does not allow this',
  disabled: 'mem is not on for this branch',
  invalid_destination: 'The destination is not valid',
  withheld: 'The item is withheld by the current rules',
  secret_like: 'The body looks like it contains a secret',
  reapproval_required: 'Something changed since the diff was shown; make a new diff and approve it again',
  operation_in_progress: 'Another write of this item is in progress or unsettled',
  diff_not_acknowledged: 'The item changed since it was written; look at the difference first',
  version_conflict: 'The item changed since that version',
  worktree_recreated: 'The worktree was deleted and made again since the request was read',
  gh_failed: 'gh could not answer',
  internal_error: 'Unexpected error',
};

export function promoteError(code: PromoteErrorCode, extra: Partial<PromoteErrorBody> & Record<string, unknown> = {}): MemOutcome {
  const body: PromoteErrorBody = { ok: false, code, message: MESSAGES[code], ...extra };
  return { status: STATUS[code], body };
}

const reapproval = (reason: PromoteReapprovalReason, extra: Record<string, unknown> = {}): MemOutcome =>
  promoteError('reapproval_required', { reason, ...extra });

const iso = (epoch: number | null): string | null => (epoch === null ? null : new Date(epoch).toISOString());

function previewView(row: PromotePreviewRow, invisibleReplaced = false): PromotePreviewView {
  return {
    id: row.id,
    operationId: row.operation_id,
    itemId: row.item_id,
    itemVersion: row.item_version,
    destination: JSON.parse(row.destination) as PromoteDestination,
    baseFingerprint: row.base_fingerprint,
    body: row.body,
    bodySha256: row.body_sha256,
    effect: row.effect,
    quoteOrigin: row.quote_origin,
    invisibleReplaced,
    acknowledgedOperationIds: JSON.parse(row.acknowledged_operation_ids) as string[],
    poster: row.poster_id !== null ? { id: row.poster_id, login: row.poster_login ?? '' } : null,
    createdAt: iso(row.created_at) as string,
    expiresAt: iso(row.expires_at) as string,
  };
}

/** The state as read (design §3.2's last row): an attempt of a gone boot, or too old, reads as unknown. */
function readState(db: Database.Database, row: PromoteOperationRow, bootId: string, now: number): PromoteOperationRow['state'] {
  if (row.state !== 'in_flight') return row.state;
  const attempt = db
    .prepare('SELECT boot_id, started_at FROM mem_promote_attempts WHERE operation_id = ? AND ended_at IS NULL')
    .get(row.id) as { boot_id: string; started_at: number } | undefined;
  if (!attempt) return 'unknown';
  return attempt.boot_id !== bootId || attempt.started_at < now - PROMOTE_ATTEMPT_STALE_MS ? 'unknown' : 'in_flight';
}

export function operationView(row: PromoteOperationRow, state: PromoteOperationRow['state'] = row.state): PromoteOperationView {
  return {
    id: row.id,
    itemId: row.item_id,
    state,
    destinationKind: row.destination_kind,
    destination: destinationOf(row),
    effect: row.effect,
    resultRef: row.result_ref,
    transitionPending: row.transition_pending === 1,
    transitionReason: row.transition_reason,
    concurrentEdit: row.concurrent_edit === 1,
    unknownReason: row.unknown_reason,
    decidedBy: row.decided_by,
    approvedAt: iso(row.approved_at) as string,
    settledAt: iso(row.settled_at),
  };
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((id, index) => id === y[index]);
};

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

async function defaultOrigin(worktreePath: string): Promise<string | null> {
  return (await import('@/lib/mem/git-observe')).readOriginUrl(worktreePath);
}

async function observeHead(path: string, deps: PromoteDeps): Promise<WorktreeHeadObservation> {
  if (deps.mem?.observe) return deps.mem.observe(path);
  return (await import('@/lib/mem/git-observe')).observeWorktreeHead(path);
}

/**
 * The target of the item's branch, reached through the context worktree (5-2b P1): the
 * membership is the worktree's, the mode is that of the item's branch at every root of
 * it (the same judgement as `decideMemTarget`: roots that differ are `ambiguous`). The
 * worktree's current branch is not the item's when the screen picks another worktree.
 */
function itemBranchSpec(worktreeId: string, branch: string | null): MemTargetSpec {
  // A named branch reaches `decideMemTarget` as it is; null is a detached item's branch.
  return { via: 'worktree', worktreeId, branch: branch as string };
}

/** Whether the item's branch is `on` at every root of the target (and at the item's own root). */
function itemModeOn(db: Database.Database, target: MemTarget, record: MemRecord): boolean {
  return target.ok && target.mode === 'on' && memModeOnFor(db, [record.owner.repositoryId], record.owner.branch);
}

/**
 * The worktree an operation named, as it is now (5-2b P2-1). A rename moves the id
 * (the old one becomes an alias) and keeps the lifetime with it, so the saved id is
 * resolved through the alias and kept only while the lifetime is the saved one; a
 * worktree deleted and made again (a new lifetime) is not it. The saved values are
 * kept as they were written (the record of what was approved).
 */
export function currentWorktreeIdOf(db: Database.Database, savedId: string, savedIncarnation: string): string | null {
  const id = resolveWorktreeIdWithAlias(db, savedId);
  return id !== null && getWorktreeIncarnation(db, id) === savedIncarnation ? id : null;
}

/** In the target's synchronous stretch: the context worktree resolves to the item's repository. */
function targetMatches(target: MemTarget, record: MemRecord, repositoryId: string): boolean {
  return target.ok && target.readRepositoryIds.includes(record.owner.repositoryId) && target.readRepositoryIds.includes(repositoryId);
}

const transitionOf = (effect: PromoteEffect): MemDecisionTransition => (effect === 'spec' ? 'record' : 'promote-record-only');

function transitionReasonOf(outcome: MemOutcome): PromoteTransitionReason {
  const body = outcome.body as { code?: string };
  switch (body.code) {
    case 'instance_not_found':
      return 'incarnation_changed';
    case 'version_conflict':
      return 'version_conflict';
    case 'disabled':
    case 'ambiguous':
      // The item's branch is not `on` at every root (5-2b P1).
      return 'disabled';
    case 'state_forbids':
      return 'state_forbids';
    case 'not_found':
    case 'item_not_found':
      return 'not_found';
    default:
      return 'db_error';
  }
}

/**
 * The item's transition after a write outside (design §3.5): A's entrance with the
 * worktree lifetime and the version fixed when the person's request arrived (§11.1 I1:
 * fixed before the request's first await and never taken again). Anything that does
 * not match leaves `transition_pending` and its reason.
 *
 * `read` is the operation as the caller read it in this same synchronous stretch. Every
 * write here is conditional on it (§11.1 I2): the claim is taken only from that state,
 * and A's failure is written only while this request still holds the claim, so a
 * person's acknowledgement or a later request made during A's await is not overwritten.
 */
async function settleTransition(
  db: Database.Database,
  operationId: string,
  read: PromoteTransitionRead,
  fixed: { worktreeId: string; incarnation: string; version: number; transition: MemDecisionTransition },
  deps: PromoteDeps
): Promise<{ ok: true } | { ok: false; reason: PromoteTransitionReason }> {
  const now = () => deps.now?.() ?? Date.now();
  // 5-2c: held pending from the settle's own synchronous stretch until A answers, so an
  // approval whose preview listed this write cannot write again while the item has not
  // moved yet (the settle and A's entrance are apart by A's await).
  const claim = beginPromoteTransition(db, operationId, read, now());
  if (claim === null) return { ok: false, reason: 'state_forbids' };
  let outcome: MemOutcome;
  try {
    outcome =
      deps.hooks?.transition?.() ??
      (await memSettleDecisionTransition(
        db,
        {
          // A rename since: the same lifetime under its new id (5-2b P2-1).
          worktreeId: currentWorktreeIdOf(db, fixed.worktreeId, fixed.incarnation) ?? fixed.worktreeId,
          expectedWorktreeIncarnation: fixed.incarnation,
          itemId: getPromoteOperation(db, operationId)?.item_id ?? '',
          expectedVersion: fixed.version,
          transition: fixed.transition,
        },
        deps.mem
      ));
  } catch {
    outcome = { status: 500, body: { code: 'internal_error' } };
  }
  if (outcome.status < 300) {
    // §11.1 I2: the result is seen; the item moved whoever holds the claim now (A's success).
    const lowered = finishPromoteTransition(db, operationId, claim, { moved: true }, now());
    if (!lowered) logger.info('mem-promote-transition-already-settled', { operationId });
    return { ok: true };
  }
  const reason = transitionReasonOf(outcome);
  const written = finishPromoteTransition(db, operationId, claim, { moved: false, reason }, now());
  logger.info('mem-promote-transition-pending', { operationId, reason, written });
  return { ok: false, reason };
}

/**
 * What a reconcile found of the operation's own mark when it is not exactly what was
 * written (design §3.4: `body_differs`・`block_altered`): both, for a person to judge.
 */
export interface PromoteFinding {
  reason: PromoteMarkFoundReason;
  /** What is there now (the comment's body, or the document around the marks); null when it could not be read. */
  found: string | null;
  /** What the operation was approved to write. */
  intended: string;
}

function operationAnswer(db: Database.Database, operationId: string, deps: PromoteDeps, status = 200, finding?: PromoteFinding): MemOutcome {
  const row = getPromoteOperation(db, operationId)!;
  const item = getMemRecord(db, row.item_id);
  return {
    status,
    body: {
      ok: true,
      operation: operationView(row, readState(db, row, deps.bootId?.() ?? memServerBootId(), deps.now?.() ?? Date.now())),
      item: item ? presentMemItem(item) : null,
      ...(finding ? { finding } : {}),
    },
  };
}

/** The transition of an operation whose settle has just written `succeeded`: not begun, no claim (§11.1 I2). */
const SETTLED_UNBEGUN: PromoteTransitionRead = { transition_pending: 0, transition_claim: null };

/**
 * Settle an outcome; if writing it fails, try once to leave it unknown (design §3.2: the DB update after the write failed).
 *
 * §11.1 I2 (5-2e): true only when this settle itself wrote `settle` (its CAS held). False
 * when the operation was no longer as the approval left it — a staleness made it unknown
 * and a person reconciled or abandoned it meanwhile — or when only the fallback to unknown
 * was written. The caller starts nothing after a false (no transition).
 */
function settleOrUnknown(db: Database.Database, operationId: string, settle: PromoteSettle, now: number, before?: () => void): boolean {
  try {
    before?.();
    const written = settlePromoteOperation(db, operationId, settle, now);
    if (!written) logger.info('mem-promote-settle-superseded', { operationId, state: settle.state });
    return written;
  } catch {
    try {
      const fellBack = settlePromoteOperation(db, operationId, { state: 'unknown', reason: 'db_error' }, now);
      logger.info('mem-promote-settle-fell-back', { operationId, fellBack });
    } catch {
      // Left in_flight: read as unknown once stale (another boot, or 10 minutes).
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

/** `POST …/decisions/:itemId/preview` — `{ worktreeId, effect?, destination?, quoteConfirmed?, quoteText? }`. */
export async function promotePreview(
  db: Database.Database,
  request: ScreenRequest,
  repositoryId: string,
  itemId: string,
  body: Record<string, unknown>,
  deps: PromoteDeps = {}
): Promise<MemOutcome> {
  if (!isScreenRequest(request)) return promoteError('screen_only');
  const now0 = deps.now?.() ?? Date.now();
  if (typeof body.worktreeId !== 'string' || body.worktreeId.length === 0) return promoteError('invalid_request', { field: 'worktreeId' });
  const contextId = body.worktreeId;
  const worktree = getWorktreeById(db, contextId);
  if (!worktree || !getRepositoryById(db, repositoryId)) return promoteError('not_found');
  const record = getMemRecord(db, itemId);
  if (!record) return promoteError('not_found');
  if (record.kind !== 'decision') return promoteError('not_decision');
  if (record.state !== 'open') return promoteError('state_forbids');
  const effect = (body.effect ?? 'spec') as PromoteEffect;
  if (!PROMOTE_EFFECTS.includes(effect)) return promoteError('invalid_request', { field: 'effect' });

  let quote: { text: string; origin: 'agent' | 'human'; at: number } | null = null;
  if (body.quoteConfirmed === true) {
    const checked = validateQuote(body.quoteText ?? record.quote);
    if (!checked.ok) return promoteError(checked.error.code === 'secret_like' ? 'secret_like' : 'invalid_request', { field: 'quoteText' });
    quote = { text: checked.value, origin: 'human', at: now0 };
  } else if (record.quote !== null && record.quoteAt !== null) {
    quote = { text: record.quote, origin: 'agent', at: record.quoteAt };
  }

  const rawDestination = body.destination ?? record.promoteTo;
  const checkedDestination = validatePromoteTo(rawDestination, worktree.path);
  if (!checkedDestination.ok || checkedDestination.value === null) return promoteError('invalid_destination', { field: 'destination' });
  const parsed = parsePromoteTo(checkedDestination.value);
  if (!parsed) return promoteError('invalid_destination', { field: 'destination' });
  // Fixed before any await: the preview is bound to this lifetime (A §16 I17).
  const contextIncarnation = getOrCreateWorktreeIncarnation(db, contextId, now0);
  const gh = deps.gh ?? defaultGhRun;

  let destination: PromoteDestination;
  let baseFingerprint: string;
  let poster: { id: number; login: string } | null = null;
  if (parsed.kind === 'issue') {
    const origin = parseOriginUrl(await (deps.originUrl ?? defaultOrigin)(worktree.path));
    const target = resolveIssueTarget(parsed, origin);
    if (!target) return promoteError('invalid_destination', { field: 'destination', reason: 'host_not_allowed' });
    const dest: IssueCommentDestination = { kind: 'issue_comment', ref: parsed.ref, ...target, number: parsed.number };
    const issue = await readGhIssue(gh, dest);
    const fingerprint = issueBaseFingerprint(issue);
    if (fingerprint === null) return promoteError('gh_failed', { reason: 'issue_unreadable' });
    poster = await readGhUser(gh, dest.host);
    if (!poster) return promoteError('gh_failed', { reason: 'user_unreadable' });
    destination = dest;
    baseFingerprint = fingerprint;
  } else {
    const checked = checkDocPath(worktree.path, parsed.path);
    if (!checked.ok) return promoteError('invalid_destination', { field: 'destination', reason: checked.code });
    const head = await observeHead(worktree.path, deps);
    if (!head.known || head.detached) return promoteError('invalid_destination', { reason: 'branch_unresolved' });
    if (head.branch !== record.owner.branch) return promoteError('invalid_destination', { reason: 'branch_changed' });
    const dest: WorktreeDocDestination = {
      kind: 'worktree_doc',
      repositoryId: record.owner.repositoryId,
      branch: record.owner.branch,
      worktreeId: contextId,
      worktreeIncarnation: contextIncarnation,
      path: checked.rel,
      head: { branch: head.branch, commonDir: head.commonDir },
    };
    destination = dest;
    baseFingerprint = docBaseFingerprint(checked.abs);
    if (baseFingerprint === 'unreadable') return promoteError('invalid_destination', { reason: 'unreadable' });
  }

  return withMemTarget(db, itemBranchSpec(contextId, record.owner.branch), deps.mem ?? {}, (target): MemOutcome => {
    if (!target.ok && target.code === 'ambiguous') return promoteError('disabled', { reason: 'ambiguous' });
    const current = getMemRecord(db, itemId);
    if (!current || !targetMatches(target, current, repositoryId)) return promoteError('not_found');
    if (current.version !== record.version || itemFingerprint(current) !== itemFingerprint(record) || current.state !== 'open') {
      return reapproval('item_changed');
    }
    if (!itemModeOn(db, target, current)) return promoteError('disabled');
    if (getWorktreeIncarnation(db, contextId) !== contextIncarnation) return promoteError('worktree_recreated');
    if (findWithheld(current)) return promoteError('withheld');
    const now = deps.now?.() ?? Date.now();
    prunePromoteRecords(db, now);
    settleStalePromoteAttempts(db, deps.bootId?.() ?? memServerBootId(), now);
    const operationId = randomUUID();
    const rendered = renderPromoteBody({
      operationId,
      itemId,
      itemVersion: current.version,
      branch: current.owner.branch,
      effect,
      authorInstanceId: current.owner.instanceId,
      authorCreatedAt: current.createdAt,
      createdAt: now,
      text: current.text,
      quote,
    });
    if (!rendered.ok) return promoteError('secret_like', { reason: rendered.rule });
    const quoteOrigin: PromoteQuoteOrigin = quote ? quote.origin : 'none';
    const row: PromotePreviewRow = {
      id: randomUUID(),
      operation_id: operationId,
      item_id: itemId,
      item_version: current.version,
      item_fingerprint: itemFingerprint(current),
      repository_id: current.owner.repositoryId,
      branch: current.owner.branch,
      destination: JSON.stringify(destination),
      base_fingerprint: baseFingerprint,
      body: rendered.body,
      body_sha256: rendered.bodySha256,
      effect,
      quote_origin: quoteOrigin,
      quote_confirmed_at: quote?.origin === 'human' ? quote.at : null,
      rules_version: MEM_SECRET_RULES_VERSION,
      context_worktree_id: contextId,
      context_worktree_incarnation: contextIncarnation,
      acknowledged_operation_ids: JSON.stringify(recordedOperationIds(db, itemId)),
      poster_host: destination.kind === 'issue_comment' ? destination.host : null,
      poster_id: poster?.id ?? null,
      poster_login: poster?.login ?? null,
      created_at: now,
      expires_at: now + PROMOTE_PREVIEW_TTL_MS,
      used_at: null,
      invalidated_reason: null,
    };
    insertPromotePreview(db, row);
    logger.info('mem-promote-previewed', { itemId, kind: destination.kind, length: rendered.body.length });
    return { status: 201, body: { ok: true, preview: previewView(row, rendered.invisibleReplaced) } };
  });
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

type Claimed =
  | { kind: 'outcome'; outcome: MemOutcome }
  | { kind: 'comment'; operationId: string; env: Record<string, string>; dest: IssueCommentDestination; posterId: number }
  // §11.1 I2 (5-2e): whether this approval's own settle wrote `succeeded` (its CAS held).
  | { kind: 'doc'; operationId: string; succeededByThis: boolean };

/** `POST …/decisions/:itemId/approve` — `{ previewId, itemVersion, baseFingerprint, bodySha256, acknowledgedOperationIds }`. */
export async function promoteApprove(
  db: Database.Database,
  request: ScreenRequest,
  repositoryId: string,
  itemId: string,
  body: Record<string, unknown>,
  deps: PromoteDeps = {}
): Promise<MemOutcome> {
  if (!isScreenRequest(request)) return promoteError('screen_only');
  if (typeof body.previewId !== 'string') return promoteError('invalid_request', { field: 'previewId' });
  const preview = getPromotePreview(db, body.previewId);
  if (!preview || preview.item_id !== itemId) return promoteError('not_found');
  const refuse = (reason: PromoteReapprovalReason): MemOutcome => {
    invalidatePromotePreview(db, preview.id, reason);
    logger.info('mem-promote-reapproval', { itemId, reason });
    return reapproval(reason);
  };
  if (preview.used_at !== null || preview.invalidated_reason !== null) return reapproval('preview_used');
  if (
    body.itemVersion !== preview.item_version ||
    body.baseFingerprint !== preview.base_fingerprint ||
    body.bodySha256 !== preview.body_sha256 ||
    !isIdList(body.acknowledgedOperationIds) ||
    !sameIds(body.acknowledgedOperationIds, JSON.parse(preview.acknowledged_operation_ids) as string[])
  ) {
    return refuse('preview_mismatch');
  }
  // Fixed here, before the awaits, and kept in the operation (design §3.5).
  const fixedIncarnation = preview.context_worktree_incarnation;
  // A rename since the preview is the same worktree under a new id (5-2b P2-1).
  const contextId = currentWorktreeIdOf(db, preview.context_worktree_id, fixedIncarnation) ?? preview.context_worktree_id;
  const worktree = getWorktreeById(db, contextId);
  const recordBefore = getMemRecord(db, itemId);
  if (!recordBefore) return promoteError('not_found');
  if (!worktree || getWorktreeIncarnation(db, contextId) !== fixedIncarnation) return refuse('worktree_recreated');
  const destination = JSON.parse(preview.destination) as PromoteDestination;
  const gh = deps.gh ?? defaultGhRun;

  let head: WorktreeHeadObservation | null = null;
  let env: Record<string, string> | null = null;
  let issueFingerprint: string | null = null;
  let posterId: number | null = null;
  if (destination.kind === 'worktree_doc') {
    head = await observeHead(worktree.path, deps);
  } else {
    // R2・R3: the token is read once and given to both the check of the poster and the POST.
    const token = await readGhToken(gh, destination.host);
    if (token === null) return promoteError('gh_failed', { reason: 'token_unavailable' });
    env = fixedTokenEnv(token);
    posterId = (await readGhUser(gh, destination.host, env))?.id ?? null;
    issueFingerprint = issueBaseFingerprint(await readGhIssue(gh, destination, env));
  }

  const claimed = await withMemTarget(db, itemBranchSpec(contextId, recordBefore.owner.branch), deps.mem ?? {}, (target): Claimed => {
    const outcome = (o: MemOutcome): Claimed => ({ kind: 'outcome', outcome: o });
    const now = deps.now?.() ?? Date.now();
    const bootId = deps.bootId?.() ?? memServerBootId();
    if (!target.ok && target.code === 'ambiguous') return outcome(refuse('mode_not_on'));
    const current = getMemRecord(db, itemId);
    if (!current || !targetMatches(target, current, repositoryId)) return outcome(promoteError('not_found'));
    const fresh = getPromotePreview(db, preview.id);
    if (!fresh || fresh.used_at !== null || fresh.invalidated_reason !== null) return outcome(reapproval('preview_used'));
    if (now > preview.expires_at) return outcome(refuse('expired'));
    if (current.version !== preview.item_version || itemFingerprint(current) !== preview.item_fingerprint || current.state !== 'open') {
      return outcome(refuse('item_changed'));
    }
    if (!itemModeOn(db, target, current)) return outcome(refuse('mode_not_on'));
    if (preview.rules_version !== MEM_SECRET_RULES_VERSION) return outcome(refuse('rules_changed'));
    if (findWithheld(current)) return outcome(refuse('withheld'));
    if (getWorktreeIncarnation(db, contextId) !== fixedIncarnation || !worktreeIncarnationAlive(db, fixedIncarnation)) {
      return outcome(refuse('worktree_recreated'));
    }
    let block: string | null = null;
    if (destination.kind === 'worktree_doc') {
      if (!head || !head.known || head.branch !== destination.head.branch || head.commonDir !== destination.head.commonDir) {
        return outcome(refuse('branch_changed'));
      }
      const checked = checkDocPath(worktree.path, destination.path);
      if (!checked.ok || checked.rel !== destination.path) return outcome(refuse('destination_changed'));
      if (docBaseFingerprint(checked.abs) !== preview.base_fingerprint) return outcome(refuse('base_changed'));
      block = docBlockOf(preview.operation_id, preview.body);
    } else {
      if (issueFingerprint === null) return outcome(refuse('destination_changed'));
      if (issueFingerprint !== preview.base_fingerprint) return outcome(refuse('base_changed'));
      if (posterId === null || posterId !== preview.poster_id) return outcome(refuse('poster_changed'));
    }
    settleStalePromoteAttempts(db, bootId, now);
    if (hasActivePromoteOperation(db, itemId)) return outcome(promoteError('operation_in_progress'));
    if (!sameIds(recordedOperationIds(db, itemId), JSON.parse(preview.acknowledged_operation_ids) as string[])) {
      return outcome(refuse('prior_record_exists'));
    }
    const claim = claimPromoteOperation(db, {
      preview,
      destinationWorktreeIncarnation: destination.kind === 'worktree_doc' ? destination.worktreeIncarnation : null,
      posterId,
      block,
      bootId,
      now,
    });
    if (!claim.ok) return outcome(promoteError('operation_in_progress'));
    logger.info('mem-promote-approved', { itemId, operationId: claim.operationId, kind: destination.kind });
    if (destination.kind === 'issue_comment') {
      return { kind: 'comment', operationId: claim.operationId, env: env!, dest: destination, posterId: posterId! };
    }
    // The document is written in this same stretch (design §3.3).
    try {
      const written = writeDocBlock(
        {
          root: worktree.path,
          rel: destination.path,
          operationId: claim.operationId,
          body: preview.body,
          baseFingerprint: preview.base_fingerprint,
          leftovers: docOperationsFor(db, contextId, destination.path),
        },
        deps.hooks?.doc
      );
      if (written.result === 'not_written') {
        // §11.1 I2: the result is seen; nothing follows a failure whichever way it went.
        if (!settleOrUnknown(db, claim.operationId, { state: 'failed', reason: written.reason }, now)) {
          logger.info('mem-promote-failure-not-written', { operationId: claim.operationId });
        }
        return outcome(written.refusal ? reapproval(written.reason === 'base_changed' ? 'base_changed' : 'destination_changed', {
          operationId: claim.operationId,
        }) : promoteError('invalid_destination', { reason: written.reason, operationId: claim.operationId }));
      }
      if (written.result === 'success') {
        const own = settleOrUnknown(db, claim.operationId, { state: 'succeeded', reason: null, resultRef: written.resultRef, concurrentEdit: written.concurrentEdit }, now);
        return { kind: 'doc', operationId: claim.operationId, succeededByThis: own };
      }
      if (!settleOrUnknown(db, claim.operationId, { state: 'unknown', reason: written.reason }, now)) {
        logger.info('mem-promote-unknown-not-written', { operationId: claim.operationId });
      }
    } catch {
      if (!settleOrUnknown(db, claim.operationId, { state: 'unknown', reason: 'unreadable' }, now)) {
        logger.info('mem-promote-unknown-not-written', { operationId: claim.operationId });
      }
    }
    return { kind: 'doc', operationId: claim.operationId, succeededByThis: false };
  });

  if (claimed.kind === 'outcome') return claimed.outcome;
  let succeededByThis: boolean;
  if (claimed.kind === 'comment') {
    const posted = await postGhComment(gh, claimed.dest, preview.body, claimed.env);
    const now = deps.now?.() ?? Date.now();
    const settle: PromoteSettle =
      posted.outcome === 'success'
        ? posted.userId !== null && posted.userId !== claimed.posterId
          ? { state: 'unknown', reason: 'poster_mismatch' }
          : { state: 'succeeded', reason: null, resultRef: JSON.stringify({ id: posted.commentId, url: posted.url }) }
        : posted.outcome === 'failure'
          ? { state: 'failed', reason: posted.reason }
          : { state: 'unknown', reason: posted.reason };
    const own = settleOrUnknown(db, claimed.operationId, settle, now, deps.hooks?.afterPost);
    logger.info('mem-promote-posted', { operationId: claimed.operationId, outcome: posted.outcome, settled: own });
    succeededByThis = own && settle.state === 'succeeded';
  } else {
    succeededByThis = claimed.succeededByThis;
  }
  // §11.1 I2 (5-2e): the transition starts only from this approval's own settle. When its
  // CAS did not hold (a staleness made the operation unknown and a person reconciled,
  // moved, acknowledged or abandoned it while the answer was out), the row read again is
  // someone else's settled state and the late answer starts nothing from it.
  if (succeededByThis) {
    const row = getPromoteOperation(db, claimed.operationId)!;
    await settleTransition(
      db,
      row.id,
      // The transition as this settle left it (never begun): a change since fails the CAS.
      SETTLED_UNBEGUN,
      { worktreeId: row.context_worktree_id, incarnation: row.context_worktree_incarnation, version: row.item_version, transition: transitionOf(row.effect) },
      deps
    );
  }
  return operationAnswer(db, claimed.operationId, deps);
}

// ---------------------------------------------------------------------------
// confirm the reflection
// ---------------------------------------------------------------------------

function memFailure(outcome: MemOutcome): MemOutcome {
  const reason = transitionReasonOf(outcome);
  switch (reason) {
    case 'incarnation_changed':
      return promoteError('worktree_recreated');
    case 'version_conflict':
      return promoteError('version_conflict');
    case 'disabled':
      return promoteError('disabled');
    case 'state_forbids':
      return promoteError('state_forbids');
    case 'not_found':
      return promoteError('not_found');
    default:
      return promoteError('internal_error');
  }
}

/** `POST …/decisions/:itemId/confirm-reflected` — `{ worktreeId, ifVersion }`: a person checked the canonical place (`recorded → promoted`). */
export async function promoteConfirmReflected(
  db: Database.Database,
  request: ScreenRequest,
  repositoryId: string,
  itemId: string,
  body: Record<string, unknown>,
  deps: PromoteDeps = {}
): Promise<MemOutcome> {
  if (!isScreenRequest(request)) return promoteError('screen_only');
  if (typeof body.ifVersion !== 'number' || !Number.isInteger(body.ifVersion)) return promoteError('invalid_request', { field: 'ifVersion' });
  if (typeof body.worktreeId !== 'string' || !getWorktreeById(db, body.worktreeId) || !getRepositoryById(db, repositoryId)) {
    return promoteError('not_found');
  }
  const record = getMemRecord(db, itemId);
  if (!record) return promoteError('not_found');
  if (record.kind !== 'decision') return promoteError('not_decision');
  if (record.state !== 'recorded') return promoteError('state_forbids');
  const incarnation = getOrCreateWorktreeIncarnation(db, body.worktreeId, deps.now?.() ?? Date.now());
  const outcome = await memSettleDecisionTransition(
    db,
    { worktreeId: body.worktreeId, expectedWorktreeIncarnation: incarnation, itemId, expectedVersion: body.ifVersion, transition: 'promote' },
    deps.mem
  );
  if (outcome.status >= 300) return memFailure(outcome);
  logger.info('mem-promote-confirmed', { itemId });
  return outcome;
}

// ---------------------------------------------------------------------------
// Which operations a repository's screen reaches (5-2c P2-1・P2-2)
// ---------------------------------------------------------------------------

/** Every root judged to be the same repository, disabled ones included (the list's `readRepositoryIds`). */
const readIdsOf = (membership: RoleRepositoryMembership): string[] =>
  (membership.candidates && membership.candidates.length > 0 ? membership.candidates : membership.members).map((root) => root.id);

/**
 * The roots of the same git as `repositoryId`, whatever their mem settings say (5-2c P2-2):
 * the list shows the operations of all of them, so the reconcile, the abandon and the
 * settle reach the same ones. The membership does not depend on the mode, so a branch
 * whose roots disagree (`ambiguous`) still has one. Unknown or unsettled → the root alone.
 */
async function repositoryReadIds(db: Database.Database, repositoryId: string, deps: MemServiceDeps | undefined): Promise<string[]> {
  try {
    return await withSettledRepositoryMembership(db, repositoryId, deps ?? {}, (_repository, membership) => readIdsOf(membership));
  } catch (error) {
    if (error instanceof AgentRoleTargetNotFoundError || error instanceof MembershipUnsettledError) return [repositoryId];
    throw error;
  }
}

const ownsOperation = (row: PromoteOperationRow, repositoryId: string, readIds: readonly string[]): boolean =>
  row.repository_id === repositoryId || readIds.includes(row.repository_id);

// ---------------------------------------------------------------------------
// reconcile, abandon, settle the transition
// ---------------------------------------------------------------------------


/** `POST …/decisions/operations/:opId/reconcile` — look for the mark, never write outside (design §3.4). */
export async function promoteReconcile(
  db: Database.Database,
  request: ScreenRequest,
  repositoryId: string,
  operationId: string,
  deps: PromoteDeps = {}
): Promise<MemOutcome> {
  if (!isScreenRequest(request)) return promoteError('screen_only');
  const readIds = await repositoryReadIds(db, repositoryId, deps.mem);
  const now0 = deps.now?.() ?? Date.now();
  settleStalePromoteAttempts(db, deps.bootId?.() ?? memServerBootId(), now0);
  const row = getPromoteOperation(db, operationId);
  if (!row || !ownsOperation(row, repositoryId, readIds)) return promoteError('not_found');
  if (row.state === 'in_flight') return promoteError('operation_in_progress');
  if (row.state !== 'unknown') return promoteError('state_forbids');
  const destination = destinationOf(row);

  let finding: { settle: PromoteSettle; found?: string | null };
  if (destination.kind === 'issue_comment') {
    const listed = await listGhComments(deps.gh ?? defaultGhRun, destination);
    if (listed === null) {
      finding = { settle: { state: 'unknown', reason: 'lookup_failed' } };
    } else {
      const mark = commentMark(row.id, row.item_id);
      // A copy of the mark by someone else is not ours: the poster fixed before the POST decides.
      const ours = listed.filter((comment) => comment.body.includes(mark) && comment.userId !== null && comment.userId === row.poster_id);
      const exact = ours.find((comment) => sha256(comment.body) === row.body_sha256);
      // P3-2: our mark by our poster with another body is kept with where it is and shown
      // to the person beside what was meant (design §3.4), never settled by itself.
      const differs = ours[0];
      finding = exact
        ? { settle: { state: 'succeeded', reason: null, resultRef: JSON.stringify({ id: exact.id, url: exact.url }) } }
        : differs
          ? { settle: { state: 'unknown', reason: 'body_differs', resultRef: JSON.stringify({ id: differs.id, url: differs.url }) }, found: differs.body }
          : { settle: { state: 'unknown', reason: 'not_found_yet' } };
    }
  } else {
    // The worktree it was written in, renamed or not (5-2b P2-1); a new lifetime is not it.
    const worktreeId = currentWorktreeIdOf(db, destination.worktreeId, destination.worktreeIncarnation);
    const worktree = worktreeId !== null ? getWorktreeById(db, worktreeId) : null;
    if (!worktree || worktreeId === null) {
      finding = { settle: { state: 'unknown', reason: 'unreadable' } };
    } else {
      // The judgement and what is shown come from one read (Codex review 5 P2-2): an
      // altered block always carries the document as it is now; one that cannot be read
      // is `unreadable`, never a finding offered as "treat as written".
      const read = reconcileDocBlockFinding(
        worktree.path,
        destination.path,
        row.id,
        row.body_sha256,
        docOperationsFor(db, worktreeId, destination.path),
        deps.hooks?.doc
      );
      finding =
        read.result === 'altered'
          ? // P3-2: the altered block as it is now, beside what was meant (design §3.4).
            { settle: { state: 'unknown', reason: 'block_altered' }, found: read.found }
          : {
              settle:
                read.result === 'found'
                  ? { state: 'succeeded', reason: null, resultRef: JSON.stringify({ path: destination.path, sha256: row.body_sha256 }) }
                  : { state: 'unknown', reason: read.result === 'missing' ? 'block_missing' : 'unreadable' },
            };
    }
  }
  const now = deps.now?.() ?? Date.now();
  // §11.1 I2: from the state read before the awaits (`unknown`) only.
  if (!settlePromoteOperation(db, operationId, finding.settle, now, ['unknown'])) return promoteError('state_forbids');
  logger.info('mem-promote-reconciled', { operationId, state: finding.settle.state, reason: finding.settle.reason });
  const settled = getPromoteOperation(db, operationId);
  if (finding.settle.state === 'succeeded' && settled) {
    // E1: the outcome is kept whatever the mode; the item moves only through A's entrance.
    await settleTransition(
      db,
      operationId,
      settled,
      { worktreeId: row.context_worktree_id, incarnation: row.context_worktree_incarnation, version: row.item_version, transition: transitionOf(row.effect) },
      deps
    );
  }
  const markFound = PROMOTE_MARK_FOUND_REASONS.find((reason) => reason === finding.settle.reason);
  return operationAnswer(
    db,
    operationId,
    deps,
    200,
    markFound !== undefined && finding.found !== undefined ? { reason: markFound, found: finding.found, intended: row.body } : undefined
  );
}

/** `POST …/decisions/operations/:opId/abandon` — `{ ifState: 'unknown' }`: a person checked outside that nothing is there. */
export async function promoteAbandon(
  db: Database.Database,
  request: ScreenRequest,
  repositoryId: string,
  operationId: string,
  body: Record<string, unknown>,
  deps: PromoteDeps = {}
): Promise<MemOutcome> {
  if (!isScreenRequest(request)) return promoteError('screen_only');
  if (body.ifState !== 'unknown') return promoteError('invalid_request', { field: 'ifState' });
  const readIds = await repositoryReadIds(db, repositoryId, deps.mem);
  const row = getPromoteOperation(db, operationId);
  if (!row || !ownsOperation(row, repositoryId, readIds)) return promoteError('not_found');
  if (!abandonPromoteOperation(db, operationId, deps.now?.() ?? Date.now())) return promoteError('state_forbids');
  logger.info('mem-promote-abandoned', { operationId });
  return operationAnswer(db, operationId, deps);
}

/**
 * `POST …/decisions/operations/:opId/accept-found` — `{ ifState: 'unknown', ifReason }`: the
 * reconcile found the operation's own mark with another body (`body_differs`) or an altered
 * block (`block_altered`), the screen showed both, and a person judged it written (design
 * §3.4, PM review P3-2). `unknown → succeeded` with `decided_by='human'`, from the unknown
 * of that reason only (§11.1 I2), then the item's transition as after a reconcile (§3.5:
 * the lifetime and the version saved in the operation). Writes nothing outside.
 *
 * Without this, the only way out of such an unknown was "it is not there" (abandon), after
 * which a new approval writes the same decision a second time.
 */
export async function promoteAcceptFound(
  db: Database.Database,
  request: ScreenRequest,
  repositoryId: string,
  operationId: string,
  body: Record<string, unknown>,
  deps: PromoteDeps = {}
): Promise<MemOutcome> {
  if (!isScreenRequest(request)) return promoteError('screen_only');
  if (body.ifState !== 'unknown') return promoteError('invalid_request', { field: 'ifState' });
  const ifReason = PROMOTE_MARK_FOUND_REASONS.find((reason) => reason === body.ifReason);
  if (ifReason === undefined) return promoteError('invalid_request', { field: 'ifReason' });
  const readIds = await repositoryReadIds(db, repositoryId, deps.mem);
  const row = getPromoteOperation(db, operationId);
  if (!row || !ownsOperation(row, repositoryId, readIds)) return promoteError('not_found');
  if (!acceptFoundPromoteOperation(db, operationId, ifReason, deps.now?.() ?? Date.now())) return promoteError('state_forbids');
  logger.info('mem-promote-accepted-found', { operationId, reason: ifReason });
  const settled = getPromoteOperation(db, operationId);
  if (settled) {
    // E1: the outcome is kept whatever the mode; the item moves only through A's entrance.
    await settleTransition(
      db,
      operationId,
      settled,
      { worktreeId: row.context_worktree_id, incarnation: row.context_worktree_incarnation, version: row.item_version, transition: transitionOf(row.effect) },
      deps
    );
  }
  return operationAnswer(db, operationId, deps);
}

/**
 * `POST …/decisions/operations/:opId/settle-transition` — `{ worktreeId, ifVersion, acknowledgeDiff? }`:
 * "記録済みとして扱う" for a write that succeeded while the item did not move. Writes
 * nothing outside. The lifetime and the version are fixed at this request (§3.5).
 */
export async function promoteSettleTransition(
  db: Database.Database,
  request: ScreenRequest,
  repositoryId: string,
  operationId: string,
  body: Record<string, unknown>,
  deps: PromoteDeps = {}
): Promise<MemOutcome> {
  if (!isScreenRequest(request)) return promoteError('screen_only');
  const itemClosedAcknowledged = body.acknowledgeItemClosed === true;
  if (body.acknowledgeItemClosed !== undefined && typeof body.acknowledgeItemClosed !== 'boolean') {
    return promoteError('invalid_request', { field: 'acknowledgeItemClosed' });
  }
  if (!itemClosedAcknowledged) {
    if (typeof body.ifVersion !== 'number' || !Number.isInteger(body.ifVersion)) return promoteError('invalid_request', { field: 'ifVersion' });
    if (typeof body.worktreeId !== 'string' || !getWorktreeById(db, body.worktreeId)) return promoteError('not_found');
  }
  // §11.1 I1 (5-2d P1): the lifetime is fixed before the first await (the membership's
  // lookup) and given to A as it is; a worktree made again meanwhile is not this one.
  const incarnation = itemClosedAcknowledged ? null : getOrCreateWorktreeIncarnation(db, body.worktreeId as string, deps.now?.() ?? Date.now());
  const readIds = await repositoryReadIds(db, repositoryId, deps.mem);
  const row = getPromoteOperation(db, operationId);
  if (!row || !ownsOperation(row, repositoryId, readIds)) return promoteError('not_found');
  if (row.state !== 'succeeded' || row.transition_pending !== 1) return promoteError('state_forbids');
  const record = getMemRecord(db, row.item_id);
  // 5-2c P2-3: a closed or purged item never moves (the transitions forbid every move out of
  // closed). The outcome outside is already settled; the person only acknowledges that the
  // item will not follow it, which ends the pending without A's entrance.
  const itemGone = !record || record.state === 'closed';
  if (itemClosedAcknowledged) {
    if (!itemGone) return promoteError('state_forbids', { reason: 'item_open' });
    // §11.1 I2 (5-2d P2): conditional on the operation as read here; an earlier request's
    // answer of A after this is not written (its claim is gone).
    if (!acknowledgePromoteTransition(db, operationId, row, deps.now?.() ?? Date.now())) return promoteError('state_forbids');
    logger.info('mem-promote-item-closed-acknowledged', { operationId });
    return operationAnswer(db, operationId, deps);
  }
  if (!record) return promoteError('not_found', { reason: 'item_gone' });
  if (record.state === 'closed') return promoteError('state_forbids', { reason: 'item_closed' });
  if (typeof body.ifVersion !== 'number' || typeof body.worktreeId !== 'string' || incarnation === null) return promoteError('invalid_request');
  if (record.version !== body.ifVersion) return promoteError('version_conflict');
  if (itemFingerprint(record) !== row.item_fingerprint && body.acknowledgeDiff !== true) {
    return promoteError('diff_not_acknowledged', { written: row.body, item: presentMemItem(record) });
  }
  const settled = await settleTransition(
    db,
    operationId,
    row,
    { worktreeId: body.worktreeId, incarnation, version: body.ifVersion, transition: transitionOf(row.effect) },
    deps
  );
  if (!settled.ok) return promoteError(settled.reason === 'incarnation_changed' ? 'worktree_recreated' : settled.reason === 'version_conflict' ? 'version_conflict' : settled.reason === 'disabled' ? 'disabled' : 'state_forbids', { reason: settled.reason });
  return operationAnswer(db, operationId, deps);
}

// ---------------------------------------------------------------------------
// The list (read only)
// ---------------------------------------------------------------------------

export interface PromoteListDeps {
  now?: () => number;
  bootId?: () => string;
  mem?: MemServiceDeps;
}

/** `GET /api/repositories/:id/mem/decisions?branch=` — the branch's decisions, their operations and the worktrees to choose from. */
export async function promoteList(db: Database.Database, repositoryId: string, branch: string, deps: PromoteListDeps = {}): Promise<MemOutcome> {
  if (!getRepositoryById(db, repositoryId)) return promoteError('not_found');
  const now = deps.now?.() ?? Date.now();
  const bootId = deps.bootId?.() ?? memServerBootId();
  const unresolvedOf = (readRepositoryIds: readonly string[], shown: ReadonlySet<string>) =>
    listUnresolvedPromoteOperations(db, readRepositoryIds, branch)
      .filter((row) => !shown.has(row.item_id))
      .map((row) => {
        const record = getMemRecord(db, row.item_id);
        return {
          operation: operationView(row, readState(db, row, bootId, now)),
          item: record ? presentMemItem(record, { now }) : null,
          itemVersion: record ? record.version : null,
        };
      });
  const worktreesOf = (members: readonly Repository[]) =>
    members.flatMap((root) =>
      getWorktreesByRepository(db, root.path).map((entry) => {
        const full = getWorktreeById(db, entry.id);
        return { id: entry.id, path: entry.path, name: full?.name ?? entry.id, branch: full?.branch ?? null };
      })
    );
  try {
    // The membership and the mode in one settled stretch (as `withMemTarget` does for a
    // repository), so that a mode the roots disagree on still has the membership (5-2c P2-1).
    return await withSettledRepositoryMembership(db, repositoryId, deps.mem ?? {}, (_repository, membership): MemOutcome => {
      const target = decideMemTarget(db, membership, branch, { via: 'repository', worktree: null, detached: false, head: null });
      if (!target.ok) {
        if (target.code !== 'ambiguous' || membership.members.length === 0) return promoteError('not_found', { reason: target.code });
        // 5-2c P2-1: the roots disagree on the branch's mode. Nothing can be approved, but a
        // write already outside keeps its reconcile: the outcome is kept whatever the mode (E1).
        return {
          status: 200,
          body: {
            ok: true,
            mode: 'ambiguous',
            ambiguous: { reason: target.reason ?? null, roots: target.roots ?? [] },
            branch,
            decisions: [],
            unresolved: unresolvedOf(readIdsOf(membership), new Set()),
            worktrees: worktreesOf(membership.members),
          },
        };
      }
      const scope: MemScope = { storageRepositoryId: target.storageRepositoryId, readRepositoryIds: target.readRepositoryIds, branch, worktreeId: null };
      const decisions = listMem(db, scope, { all: true }).items.filter((item) => item.kind === 'decision' && item.state !== 'closed');
      const operations = listPromoteOperations(
        db,
        decisions.map((item) => item.id)
      ).map((row) => operationView(row, readState(db, row, bootId, now)));
      // 5-2b P2-2: an unsettled operation stays reachable after its item was closed or
      // purged (the item's close does not wait for the write outside).
      const shown = new Set(decisions.map((item) => item.id));
      return {
        status: 200,
        body: {
          ok: true,
          mode: target.mode,
          branch,
          decisions: decisions.map((item) => ({
            item: presentMemItem(item, { now }),
            unreflected: item.state === 'recorded',
            operations: operations.filter((operation) => operation.itemId === item.id),
          })),
          unresolved: unresolvedOf(target.readRepositoryIds, shown),
          worktrees: worktreesOf(target.members),
        },
      };
    });
  } catch (error) {
    if (error instanceof AgentRoleTargetNotFoundError) return promoteError('not_found', { reason: 'not_found' });
    if (error instanceof MembershipUnsettledError) return promoteError('not_found', { reason: 'ambiguous' });
    throw error;
  }
}

/** For tests and the routes: what an invalid body answers. */
export const promoteInvalidBody = (): MemOutcome => promoteError('invalid_request');

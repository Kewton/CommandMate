/**
 * POST /api/worktrees/[id]/skills/[skillId]/update — apply an Update Plan (Issue #1244)
 *
 * The request presents a single-use update plan token (#1243) and nothing else
 * that could change where or what is written. Everything the switch needs —
 * the worktree path, the candidate bytes, the exact new receipt bytes, the old
 * receipt digest and tree hash — was fixed server-side when the plan was built
 * and is re-verified here against the live worktree before anything moves.
 *
 * The order of operations mirrors the install route (#1235), because the two
 * must be auditable side by side:
 *
 * 1. open the journal entry, so a crash at any later point is recoverable;
 * 2. take the exclusive (worktree, skill) lock (#1234);
 * 3. re-read branch, HEAD, the receipt digest and the destination tree, and
 *    spend the token only if they still match what the user approved —
 *    otherwise `SKILL_PLAN_STALE`;
 * 4. re-assess every recorded root, back up the old payload into the
 *    service-owned root, stage the verified new payload, and switch each root
 *    with the aside → publish rename sequence (#1244's `updater`). The rename
 *    that publishes the new payload at the primary root is the one commit
 *    point, recorded as `FS_COMMITTED` the moment it lands;
 * 5. index and audit.
 *
 * A local change, unknown file or any drift from the plan is answered as a
 * zero-write refusal: neither the old nor the new payload was touched. A
 * failure after the commit point is answered as *committed, reconciling* and
 * converges forward from the new receipt — never backward.
 *
 * Nothing in the package is executed at any point, by any path in this route.
 *
 * @module api/worktrees/[id]/skills/[skillId]/update
 */

import { realpathSync } from 'fs';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId, resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { validateSkillId } from '@/lib/skills/schema';
import { isSkillFetchError } from '@/lib/skills/integrity';
import { inspectSkillPackage } from '@/lib/skills/package-validator';
import { isSkillPackageError } from '@/lib/skills/package-reader';
import {
  getSkillSnapshot,
  readSkillSnapshotBytes,
  releaseSkillSnapshot,
} from '@/lib/skills/snapshot-store';
import {
  SKILL_RECEIPT_FILENAME,
  isSkillPlanError,
  type SkillPlanActor,
} from '@/lib/skills/install-plan';
import {
  computeSkillTreeHash,
  readExistingSkillTree,
  readSkillGitTargetState,
  resolveSkillInstallRoot,
} from '@/lib/skills/preview-diff';
import { computeSha256Hex } from '@/lib/skills/integrity';
import { readSkillReceiptDigest } from '@/lib/skills/uninstall-plan';
import type { SkillUninstallBlocker } from '@/lib/skills/uninstall-plan';
import {
  SKILL_UPDATE_PLAN_TOKEN_PATTERN,
  consumeSkillUpdatePlan,
  getSkillUpdatePlan,
  type SkillUpdateBlocker,
} from '@/lib/skills/update-plan';
import {
  acquireSkillOperationLock,
  buildSkillOperationLockKey,
  releaseSkillOperationLock,
} from '@/lib/skills/operation-lock';
import {
  beginSkillOperation,
  deleteSkillOperationJournal,
  hasSkillFilesystemCommit,
  readSkillOperationJournal,
  transitionSkillOperation,
  type SkillOperationJournalEntry,
} from '@/lib/skills/operation-journal';
import { mayReplaySkillUpdate } from '@/lib/skills/operation-replay';
import {
  buildSkillOperationAuditInput,
  recordSkillOperationAudit,
} from '@/lib/skills/operation-audit';
import { redactSkillOperationText } from '@/lib/skills/operation-store';
import {
  SKILL_UPDATE_APPLY_NEXT_ACTION_KEYS,
  SKILL_UPDATE_RELOAD_MESSAGE_KEYS,
  SKILL_UPDATE_ROLLBACK_MESSAGE_KEY,
  SkillUpdateErrorCode,
  applySkillUpdate,
  isSkillUpdateError,
  type SkillUpdateBackupRef,
} from '@/lib/skills/updater';
import {
  getSkillInstallation,
  upsertSkillInstallation,
} from '@/lib/skills/installed-state';
import { ensureSkillPlanSweeper } from '@/lib/skills/plan-sweeper';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';
import type { SkillAgentSupport, SkillInstalledFile } from '@/types/skills';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/worktrees/[id]/skills/[skillId]/update');

// =============================================================================
// Wire shape
// =============================================================================

/** How the operation ended, from the caller's point of view. */
export type SkillUpdateResult = 'succeeded' | 'committed_reconciling';

/** Journal state of the operation, plus what the user should do about it. */
export interface SkillUpdateOperationDto {
  operationId: string;
  idempotencyKey: string;
  state: SkillOperationJournalEntry['state'];
  result: SkillUpdateResult;
  /** The new payload is at the primary root regardless of how later steps ended. */
  committed: boolean;
  /** Reconciliation still owes this operation a root switch or an index write. */
  reconcilePending: boolean;
  nextActionKey: string;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

/** How to pick up the version that was just switched in. */
export interface SkillUpdateReloadGuidance {
  skillId: string;
  version: string;
  installRoot: string;
  agents: Array<{ agent: string; support: SkillAgentSupport; messageKey: string }>;
}

/** What the switch produced, described without a machine-absolute path. */
export interface SkillUpdatePayloadDto {
  skillId: string;
  fromVersion: string;
  toVersion: string;
  /** Primary repository-relative install root (`.agents/skills/<id>`). */
  installRoot: string;
  /** Every root the update targeted, primary first (#1460). */
  installRoots: string[];
  /** Roots whose switch landed. */
  committedRoots: string[];
  /** Roots still owed to reconciliation. */
  pendingRoots: string[];
  receipt: { path: string; sha256: string; size: number };
  files: SkillInstalledFile[];
  treeHash: string;
}

/** Whether the previous version can be brought back, and from where (#1245). */
export interface SkillUpdateRollbackDto {
  /** A verified backup of the replaced payload exists in the service root. */
  available: boolean;
  backup: SkillUpdateBackupRef;
  /** i18n key describing the rollback possibility to the user. */
  messageKey: string;
}

export interface SkillUpdateResponse {
  operation: SkillUpdateOperationDto;
  update: SkillUpdatePayloadDto;
  reload: SkillUpdateReloadGuidance;
  rollback: SkillUpdateRollbackDto;
}

/**
 * Answer to a retried request.
 *
 * Deliberately narrower than {@link SkillUpdateResponse}: a replay is served
 * from the index, which records what is installed now but not the per-file
 * switch inventory or the backup reference. Returning a fabricated one would
 * be worse than omitting it.
 */
export interface SkillUpdateReplayResponse {
  operation: SkillUpdateOperationDto;
  update: {
    skillId: string;
    version: string;
    installRoot: string;
    installRoots: string[];
    receipt: { path: string; sha256: string };
  } | null;
}

/** Body of a refusal that names the facts responsible. */
export interface SkillUpdateBlockedResponse {
  error: string;
  code: string;
  nextActionKey: string;
  blockers: Array<SkillUpdateBlocker | SkillUninstallBlocker>;
}

// =============================================================================
// Body
// =============================================================================

/**
 * Fields a client must never be able to supply.
 *
 * Mirrors the install apply route: a rejected field is answered explicitly
 * rather than dropped, so a caller cannot conclude that a different spelling
 * might work. `force` is named because there is no forced update over local
 * changes, by design.
 */
const REJECTED_BODY_KEYS = [
  'path',
  'paths',
  'worktreePath',
  'repositoryPath',
  'installRoot',
  'targetPath',
  'url',
  'artifactUrl',
  'artifact',
  'files',
  'checksum',
  'sha256',
  'snapshotId',
  'commit',
  'receipt',
  'receiptDigest',
  'force',
] as const;

const ALLOWED_BODY_KEYS = [
  'planToken',
  'version',
  'acknowledgeRisk',
  'acknowledgeRiskIncrease',
  'idempotencyKey',
] as const;

/** Bound on a client-supplied idempotency key, which is hashed before it names a file. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

interface UpdateRequestBody {
  planToken: string;
  version: string;
  acknowledgeRisk: boolean;
  acknowledgeRiskIncrease: boolean;
  idempotencyKey: string | null;
}

type BodyResult = { ok: true; body: UpdateRequestBody } | { ok: false; response: NextResponse };

function invalidBody(message: string): { ok: false; response: NextResponse } {
  return { ok: false, response: skillApiError('SKILL_UPDATE_INVALID_BODY', message, 400) };
}

async function readBody(request: NextRequest): Promise<BodyResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return invalidBody('Malformed JSON body.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalidBody('Body must be a JSON object.');
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if ((REJECTED_BODY_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        response: skillApiError(
          'SKILL_PLAN_INPUT_REJECTED',
          'The update target is resolved by the server and cannot be supplied by the client.',
          400
        ),
      };
    }
    if (!(ALLOWED_BODY_KEYS as readonly string[]).includes(key)) {
      return invalidBody('Unknown field in body.');
    }
  }

  const { planToken, version, idempotencyKey } = record;
  if (typeof planToken !== 'string' || !SKILL_UPDATE_PLAN_TOKEN_PATTERN.test(planToken)) {
    return invalidBody('Field `planToken` must be a plan token issued by the update-plan endpoint.');
  }
  if (typeof version !== 'string' || version.length === 0) {
    return invalidBody('Field `version` must name the version the plan was built for.');
  }
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
  ) {
    return invalidBody('Field `idempotencyKey` has an unsupported format.');
  }

  return {
    ok: true,
    body: {
      planToken,
      version,
      acknowledgeRisk: record.acknowledgeRisk === true,
      acknowledgeRiskIncrease: record.acknowledgeRiskIncrease === true,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
    },
  };
}

/**
 * Actor identity available to a single-token deployment.
 *
 * CommandMate authenticates one shared token, so there is no per-user id to
 * bind. The channel is still distinguished, because a plan issued to the
 * browser must not be spendable by a CLI run and vice versa.
 */
function resolveActor(request: NextRequest): SkillPlanActor {
  return { type: request.headers.get('authorization') ? 'cli' : 'user', id: null };
}

// =============================================================================
// Response assembly
// =============================================================================

function describeOperation(
  entry: SkillOperationJournalEntry,
  options: { replayed: boolean }
): SkillUpdateOperationDto {
  const committed = hasSkillFilesystemCommit(entry);
  const succeeded = entry.state === 'SUCCEEDED';
  return {
    operationId: entry.operationId,
    idempotencyKey: entry.idempotencyKey,
    state: entry.state,
    result: succeeded ? 'succeeded' : 'committed_reconciling',
    committed,
    reconcilePending: !succeeded,
    nextActionKey: succeeded
      ? SKILL_UPDATE_APPLY_NEXT_ACTION_KEYS.succeeded
      : SKILL_UPDATE_APPLY_NEXT_ACTION_KEYS.committedReconciling,
    replayed: options.replayed,
  };
}

/** A refusal that carries the offending facts, so the UI can explain them. */
function blockedResponse(
  code: string,
  message: string,
  status: number,
  blockers: readonly (SkillUpdateBlocker | SkillUninstallBlocker)[]
): NextResponse<SkillUpdateBlockedResponse> {
  return NextResponse.json(
    {
      error: message,
      code,
      nextActionKey: SKILL_UPDATE_APPLY_NEXT_ACTION_KEYS.failed,
      blockers: [...blockers],
    },
    { status, headers: SKILL_API_NO_STORE_HEADERS }
  );
}

// =============================================================================
// Route
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; skillId: string }> }
): Promise<NextResponse> {
  ensureSkillPlanSweeper();

  let snapshotId: string | null = null;
  let lock: ReturnType<typeof acquireSkillOperationLock> | null = null;

  try {
    const { id: requestedWorktreeId, skillId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);

    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) return worktree;

    const idResult = validateSkillId(skillId);
    if (!idResult.ok) return skillApiError(idResult.errors[0].code, 'Invalid Skill ID.', 400);

    const parsed = await readBody(request);
    if (!parsed.ok) return parsed.response;

    const actor = resolveActor(request);

    // A recorded update may only be replayed while the new receipt it claims
    // is still what is on disk (Issue #1552's contract, extended to `update`).
    const isReplayable = (entry: SkillOperationJournalEntry): boolean =>
      mayReplaySkillUpdate(entry, worktree.path, idResult.value);

    // A retried request must be answered from its recorded outcome, not by
    // spending a token that is already gone.
    if (parsed.body.idempotencyKey !== null) {
      const replay = readSkillOperationJournal(parsed.body.idempotencyKey);
      if (replay !== null && isReplayable(replay)) {
        return answerReplay(replay, worktree.id, idResult.value, parsed.body.version);
      }
    }

    let worktreeRealPath: string;
    try {
      worktreeRealPath = realpathSync(worktree.path);
    } catch {
      return skillApiError(
        'SKILL_UPDATE_TARGET_UNSAFE',
        'The registered worktree path could not be resolved.',
        409
      );
    }

    // Peeking does not spend the token; the plan is only consumed once the lock
    // is held and the live target has been re-read.
    const plan = getSkillUpdatePlan(parsed.body.planToken);
    // A blocked plan is refused before any operation is opened, and without
    // spending the token: the user has to resolve the named paths and re-plan,
    // and burning the token would only cost them the preview they are reading.
    if (!plan.dto.updatable) {
      return blockedResponse(
        SkillUpdateErrorCode.LOCAL_CHANGES,
        'The update was refused; nothing was written.',
        409,
        plan.dto.blockers
      );
    }

    const lockKey = buildSkillOperationLockKey(worktreeRealPath, idResult.value);
    const begun = beginSkillOperation({
      idempotencyKey: parsed.body.idempotencyKey ?? undefined,
      binding: {
        actor,
        operation: 'update',
        target: {
          worktreeId: worktree.id,
          skillId: idResult.value,
          version: parsed.body.version,
          // The version being replaced comes from the plan's own receipt read,
          // never from the request; the audit derives from→to from it (#1248).
          fromVersion: plan.binding.fromVersion,
        },
        planHash: plan.bindingHash,
      },
      lockKey,
      isReplayable,
      source: {
        origin: 'github-release',
        repository: plan.dto.skill.source.repository,
        ref: plan.dto.skill.source.ref,
        commit: plan.dto.skill.source.commit,
        artifactSha256: plan.binding.artifactSha256,
      },
    });
    if (!begun.ok) {
      return skillApiError(
        'SKILL_UPDATE_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different request.',
        409
      );
    }
    if (begun.replayed) {
      return answerReplay(begun.entry, worktree.id, idResult.value, parsed.body.version);
    }

    let entry = begun.entry;
    lock = acquireSkillOperationLock({ key: lockKey, operationId: entry.operationId });
    if (!lock.ok) {
      // Nothing was attempted, so the key must stay reusable rather than be
      // pinned to a failure the caller never caused.
      deleteSkillOperationJournal(entry.idempotencyKey);
      lock = null;
      return skillApiError(
        'SKILL_UPDATE_LOCKED',
        'Another operation is already running for this Skill and worktree.',
        409
      );
    }

    const git = await readSkillGitTargetState(worktree.path);
    // The primary root is re-derived server-side, exactly as the plan derived
    // it; nothing the request carried names a location.
    const existing = readExistingSkillTree(
      resolveSkillInstallRoot(worktree.path, idResult.value)
    );

    let consumed;
    try {
      consumed = consumeSkillUpdatePlan(
        parsed.body.planToken,
        {
          actor,
          worktreeId: worktree.id,
          skillId: idResult.value,
          toVersion: parsed.body.version,
          riskAcknowledged: parsed.body.acknowledgeRisk,
          riskIncreaseAcknowledged: parsed.body.acknowledgeRiskIncrease,
        },
        {
          branch: git.branch,
          headCommit: git.headCommit,
          currentTreeHash: computeSkillTreeHash(existing.files),
          receiptDigest: readSkillReceiptDigest(existing),
        }
      );
    } catch (error) {
      deleteSkillOperationJournal(entry.idempotencyKey);
      throw error;
    }
    // The snapshot reference passed to us when the token was spent.
    snapshotId = consumed.binding.snapshotId;

    let result;
    try {
      // Bytes come from the verified read-only snapshot the plan was computed
      // from. Re-downloading here would reopen the door the plan closed.
      const handle = getSkillSnapshot(snapshotId);
      if (handle.sha256 !== consumed.binding.artifactSha256) {
        throw new Error('snapshot artifact digest does not match the plan binding');
      }
      const snapshot = inspectSkillPackage(readSkillSnapshotBytes(snapshotId), {
        skillId: idResult.value,
        version: consumed.binding.toVersion,
      });
      const newReceiptSha256 = computeSha256Hex(consumed.receiptBytes);

      result = applySkillUpdate({
        worktreePath: worktree.path,
        worktreeRealPath,
        worktreeId: worktree.id,
        skillId: idResult.value,
        operationId: entry.operationId,
        snapshot,
        receiptBytes: consumed.receiptBytes,
        plannedTreeHash: consumed.binding.plannedTreeHash,
        expectedReceiptDigest: consumed.binding.currentReceiptDigest,
        expectedTreeHash: consumed.binding.currentTreeHash,
        // Switch every root the plan targeted (#1460): the receipt's own set.
        rootPrefixes: consumed.rootPrefixes,
        onCommitPoint: () => {
          // The publish rename at the primary root just landed: record the
          // commit point before anything else runs, so a crash from here on is
          // converged forward from the new receipt (#1234), never rolled back.
          entry = transitionSkillOperation(entry, 'FS_COMMITTED', {
            receiptDigest: newReceiptSha256,
          });
        },
      });
    } catch (error) {
      if (isSkillUpdateError(error) && error.code === SkillUpdateErrorCode.RESTORE_FAILED) {
        // The primary root is empty; the old payload survives in the aside
        // directory and the service-owned backup. The entry is left in place
        // (PREPARING) so startup reconciliation retries the restore and then
        // reports the operation as genuinely rolled back.
        recordAuditSafely(entry, 'failed');
        logger.error('skill-update-restore-failed', {
          operationId: entry.operationId,
        });
        throw error;
      }
      // Nothing was published: staging is gone, the backup is service-owned
      // scratch, and both roots are byte-for-byte what they were. Drop the
      // journal entry so the key stays reusable (Issue #1428's rule).
      deleteSkillOperationJournal(entry.idempotencyKey);
      throw error;
    }

    if (result.reconciling) {
      // The primary root committed but a secondary root's switch did not: the
      // new version is on disk and usable for the primary Agent, and #1234
      // reconciliation converges the remaining root(s) forward from the
      // primary. Indexing is deferred to that pass so the index never claims a
      // root that still holds the previous version.
      entry = transitionSkillOperation(entry, 'FAILED_RECONCILABLE', {
        error: {
          code: 'SKILL_UPDATE_SECONDARY_ROOT_PENDING',
          message: 'a secondary install root was not switched',
        },
      });
      recordAuditSafely(entry, 'failed');
      logger.warn('skill-update-secondary-root-pending', {
        operationId: entry.operationId,
        pendingRoots: result.pendingRoots.join(','),
      });
    } else {
      try {
        const db = getDbInstance();
        upsertSkillInstallation(db, {
          worktreeId: worktree.id,
          receipt: consumed.receipt,
          receiptSha256: result.receiptSha256,
          operationId: entry.operationId,
          installedAt: entry.fsCommittedAt ?? Date.now(),
        });
        entry = transitionSkillOperation(entry, 'INDEXED');
        entry = transitionSkillOperation(entry, 'SUCCEEDED', { error: null });
        recordAuditSafely(entry, 'succeeded');
      } catch (error) {
        // The switch already landed. Reporting this as a failed update would
        // contradict what the user can see on disk, so the operation is handed
        // to #1234 reconciliation instead of being rolled back.
        entry = transitionSkillOperation(entry, 'FAILED_RECONCILABLE', {
          error: { code: 'SKILL_UPDATE_INDEX_FAILED', message: messageOf(error) },
        });
        recordAuditSafely(entry, 'failed');
        logger.error('skill-update-index-failed', {
          operationId: entry.operationId,
          error: redactSkillOperationText(messageOf(error)),
        });
      }
    }

    const response: SkillUpdateResponse = {
      operation: describeOperation(entry, { replayed: false }),
      update: {
        skillId: consumed.receipt.skill_id,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        installRoot: result.installRoot,
        installRoots: result.installRoots,
        committedRoots: result.committedRoots,
        pendingRoots: result.pendingRoots,
        receipt: {
          path: result.receiptPath,
          sha256: result.receiptSha256,
          size: result.receiptSize,
        },
        files: result.files,
        treeHash: result.treeHash,
      },
      reload: {
        skillId: consumed.receipt.skill_id,
        version: consumed.receipt.version,
        installRoot: result.installRoot,
        agents: consumed.receipt.agent_compatibility.map((agent) => ({
          agent: agent.agent,
          support: agent.support,
          messageKey: SKILL_UPDATE_RELOAD_MESSAGE_KEYS[agent.support],
        })),
      },
      rollback: {
        available: true,
        backup: result.backup,
        messageKey: SKILL_UPDATE_ROLLBACK_MESSAGE_KEY,
      },
    };
    return NextResponse.json(response, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    if (isSkillPlanError(error)) {
      return skillApiError(error.code, 'The update plan was rejected.', error.status);
    }
    if (isSkillUpdateError(error)) {
      return blockedResponse(
        error.code,
        error.code === SkillUpdateErrorCode.RESTORE_FAILED
          ? 'The update did not complete. The previous payload is preserved and will be restored automatically.'
          : 'The update was refused; nothing was written.',
        error.status,
        error.blockers
      );
    }
    if (isSkillPackageError(error)) {
      return skillApiError(error.code, 'The Skill package failed verification.', 422);
    }
    if (isSkillFetchError(error)) {
      return skillApiError(error.code, 'The verified artifact could not be read.', 502);
    }
    logger.error('skill-update-failed', {
      error: redactSkillOperationText(messageOf(error)),
    });
    return skillApiError('SKILL_UPDATE_INTERNAL_ERROR', 'Failed to apply the update.', 500);
  } finally {
    if (lock?.ok) releaseSkillOperationLock(lock.lock);
    if (snapshotId) releaseSkillSnapshot(snapshotId);
  }
}

// =============================================================================
// Replay
// =============================================================================

/**
 * Answer from a journal entry an earlier request already produced.
 *
 * A replay is only honoured for the same target: the same key naming a
 * different worktree, Skill or version is a conflict, never a substitution of
 * someone else's update.
 */
function answerReplay(
  entry: SkillOperationJournalEntry,
  worktreeId: string,
  skillId: string,
  version: string
): NextResponse {
  if (
    entry.target.worktreeId !== worktreeId ||
    entry.target.skillId !== skillId ||
    entry.target.version !== version
  ) {
    return skillApiError(
      'SKILL_UPDATE_IDEMPOTENCY_CONFLICT',
      'This idempotency key was already used for a different request.',
      409
    );
  }
  if (!hasSkillFilesystemCommit(entry)) {
    return skillApiError(
      entry.state === 'PREPARING' ? 'SKILL_UPDATE_IN_PROGRESS' : 'SKILL_UPDATE_FAILED',
      entry.state === 'PREPARING'
        ? 'The operation for this idempotency key is still running.'
        : 'The operation for this idempotency key did not update anything.',
      409
    );
  }

  const installation = getSkillInstallation(getDbInstance(), worktreeId, skillId);
  const response: SkillUpdateReplayResponse = {
    operation: describeOperation(entry, { replayed: true }),
    update: installation
      ? {
          skillId: installation.skillId,
          version: installation.version,
          installRoot: installation.installRoot,
          installRoots: installation.installRoots,
          receipt: {
            path: `${installation.installRoot}/${SKILL_RECEIPT_FILENAME}`,
            sha256: installation.receiptSha256,
          },
        }
      : null,
  };
  return NextResponse.json(response, { headers: SKILL_API_NO_STORE_HEADERS });
}

// =============================================================================
// Error helpers
// =============================================================================

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Audit failures must not mask the outcome they are describing. */
function recordAuditSafely(
  entry: SkillOperationJournalEntry,
  outcome: 'succeeded' | 'failed'
): void {
  try {
    recordSkillOperationAudit(getDbInstance(), buildSkillOperationAuditInput(entry, outcome));
  } catch (error) {
    logger.warn('skill-update-audit-failed', {
      operationId: entry.operationId,
      error: redactSkillOperationText(messageOf(error)),
    });
  }
}

/**
 * POST /api/worktrees/[id]/skills/[skillId]/install — apply an Install Plan (Issue #1235)
 *
 * The request presents a single-use plan token and nothing else that could
 * change where or what is written. Everything the write needs — the worktree
 * path, the artifact bytes, the payload inventory, the exact receipt bytes — was
 * fixed server-side when the plan was built (#1233) and is re-verified here
 * against the live worktree before a single byte is staged.
 *
 * The order of operations is the contract:
 *
 * 1. open the journal entry, so a crash at any later point is recoverable;
 * 2. take the exclusive (worktree, skill) lock (#1234);
 * 3. re-read branch, HEAD and the destination tree, and spend the token only if
 *    they still match what the user approved — otherwise `SKILL_PLAN_STALE`;
 * 4. stage, verify and atomically rename (#1235's `install-apply`);
 * 5. index and audit.
 *
 * Steps 1–3 are undoable and are reported as "nothing happened". Step 4 is the
 * commit point: once the rename lands, a failure in step 5 is answered as
 * *committed, reconciling* — never as an unchanged worktree, because the payload
 * is on disk and the user can see it.
 *
 * Nothing in the package is executed at any point, by any path in this route.
 *
 * @module api/worktrees/[id]/skills/[skillId]/install
 */

import { realpathSync } from 'fs';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
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
  SKILL_PLAN_TOKEN_PATTERN,
  SKILL_RECEIPT_FILENAME,
  consumeSkillInstallPlan,
  getSkillInstallPlan,
  isSkillPlanError,
  type SkillPlanActor,
} from '@/lib/skills/install-plan';
import {
  computeSkillTreeHash,
  readExistingSkillTree,
  readSkillGitTargetState,
} from '@/lib/skills/preview-diff';
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
import {
  buildSkillOperationAuditInput,
  recordSkillOperationAudit,
} from '@/lib/skills/operation-audit';
import { redactSkillOperationText } from '@/lib/skills/operation-store';
import {
  SKILL_INSTALL_NEXT_ACTION_KEYS,
  applySkillInstall,
  buildSkillReloadGuidance,
  isSkillInstallError,
  resolveSkillInstallTarget,
  type SkillReloadGuidance,
} from '@/lib/skills/install-apply';
import {
  getSkillInstallation,
  upsertSkillInstallation,
} from '@/lib/skills/installed-state';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';
import type { SkillInstalledFile } from '@/types/skills';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/worktrees/[id]/skills/[skillId]/install');

// =============================================================================
// Wire shape
// =============================================================================

/** How the operation ended, from the caller's point of view. */
export type SkillInstallResult = 'succeeded' | 'committed_reconciling';

/** Journal state of the operation, plus what the user should do about it. */
export interface SkillInstallOperationDto {
  operationId: string;
  idempotencyKey: string;
  state: SkillOperationJournalEntry['state'];
  result: SkillInstallResult;
  /** The payload is on disk regardless of how the index step ended. */
  committed: boolean;
  /** Reconciliation still owes this operation an index write. */
  reconcilePending: boolean;
  nextActionKey: string;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

/** What landed, described without a machine-absolute path. */
export interface SkillInstallPayloadDto {
  skillId: string;
  version: string;
  installRoot: string;
  receipt: { path: string; sha256: string; size: number };
  files: SkillInstalledFile[];
  treeHash: string;
}

export interface SkillInstallResponse {
  operation: SkillInstallOperationDto;
  install: SkillInstallPayloadDto;
  reload: SkillReloadGuidance;
}

/**
 * Answer to a retried request.
 *
 * Deliberately narrower than {@link SkillInstallResponse}: a replay is served
 * from the index, which records what is installed but not the per-file
 * inventory. Returning a fabricated file list would be worse than omitting it.
 */
export interface SkillInstallReplayResponse {
  operation: SkillInstallOperationDto;
  install: {
    skillId: string;
    version: string;
    installRoot: string;
    receipt: { path: string; sha256: string };
  } | null;
}

// =============================================================================
// Body
// =============================================================================

/**
 * Fields a client must never be able to supply.
 *
 * Mirrors the plan route: a rejected field is answered explicitly rather than
 * dropped, so a caller cannot conclude that a different spelling might work.
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
] as const;

const ALLOWED_BODY_KEYS = [
  'planToken',
  'version',
  'acknowledgeRisk',
  'idempotencyKey',
] as const;

/** Bound on a client-supplied idempotency key, which is hashed before it names a file. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

interface InstallRequestBody {
  planToken: string;
  version: string;
  acknowledgeRisk: boolean;
  idempotencyKey: string | null;
}

type BodyResult = { ok: true; body: InstallRequestBody } | { ok: false; response: NextResponse };

function invalidBody(message: string): { ok: false; response: NextResponse } {
  return { ok: false, response: skillApiError('SKILL_INSTALL_INVALID_BODY', message, 400) };
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
          'The install target is resolved by the server and cannot be supplied by the client.',
          400
        ),
      };
    }
    if (!(ALLOWED_BODY_KEYS as readonly string[]).includes(key)) {
      return invalidBody('Unknown field in body.');
    }
  }

  const { planToken, version, idempotencyKey } = record;
  if (typeof planToken !== 'string' || !SKILL_PLAN_TOKEN_PATTERN.test(planToken)) {
    return invalidBody('Field `planToken` must be a plan token issued by the plan endpoint.');
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
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
    },
  };
}

/**
 * Actor identity available to a single-token deployment.
 *
 * CommandMate authenticates one shared token, so there is no per-user id to
 * bind. The channel is still distinguished, because a plan issued to the browser
 * must not be spendable by a CLI run and vice versa.
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
): SkillInstallOperationDto {
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
      ? SKILL_INSTALL_NEXT_ACTION_KEYS.succeeded
      : SKILL_INSTALL_NEXT_ACTION_KEYS.committedReconciling,
    replayed: options.replayed,
  };
}

// =============================================================================
// Route
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; skillId: string }> }
): Promise<NextResponse> {
  let snapshotId: string | null = null;
  let lock: ReturnType<typeof acquireSkillOperationLock> | null = null;

  try {
    const { id, skillId } = await params;

    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) return worktree;

    const idResult = validateSkillId(skillId);
    if (!idResult.ok) return skillApiError(idResult.errors[0].code, 'Invalid Skill ID.', 400);

    const parsed = await readBody(request);
    if (!parsed.ok) return parsed.response;

    const actor = resolveActor(request);

    // A retried request must be answered from its recorded outcome, not by
    // spending a token that is already gone: the plan is single-use, so without
    // this the second delivery of the *same* request would look like a replay
    // attack rather than the network retry it is.
    if (parsed.body.idempotencyKey !== null) {
      const replay = readSkillOperationJournal(parsed.body.idempotencyKey);
      if (replay !== null) {
        return answerReplay(replay, worktree.id, idResult.value, parsed.body.version);
      }
    }

    let worktreeRealPath: string;
    try {
      worktreeRealPath = realpathSync(worktree.path);
    } catch {
      return skillApiError(
        'SKILL_INSTALL_TARGET_UNSAFE',
        'The registered worktree path could not be resolved.',
        409
      );
    }

    // Peeking does not spend the token; the plan is only consumed once the lock
    // is held and the live target has been re-read.
    const plan = getSkillInstallPlan(parsed.body.planToken);

    const lockKey = buildSkillOperationLockKey(worktreeRealPath, idResult.value);
    const begun = beginSkillOperation({
      idempotencyKey: parsed.body.idempotencyKey ?? undefined,
      binding: {
        actor,
        operation: 'install',
        target: {
          worktreeId: worktree.id,
          skillId: idResult.value,
          version: parsed.body.version,
        },
        planHash: plan.bindingHash,
      },
      lockKey,
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
        'SKILL_INSTALL_IDEMPOTENCY_CONFLICT',
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
        'SKILL_INSTALL_LOCKED',
        'Another operation is already running for this Skill and worktree.',
        409
      );
    }

    const installRootAbs = resolveSkillInstallTarget(worktree.path, idResult.value);
    const git = await readSkillGitTargetState(worktree.path);
    const existing = readExistingSkillTree(installRootAbs);

    let consumed;
    try {
      consumed = consumeSkillInstallPlan(
        parsed.body.planToken,
        {
          actor,
          worktreeId: worktree.id,
          skillId: idResult.value,
          version: parsed.body.version,
          riskAcknowledged: parsed.body.acknowledgeRisk,
        },
        {
          branch: git.branch,
          headCommit: git.headCommit,
          currentTreeHash: computeSkillTreeHash(existing.files),
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
        version: consumed.binding.version,
      });

      result = applySkillInstall({
        worktreePath: worktree.path,
        worktreeRealPath,
        skillId: idResult.value,
        operationId: entry.operationId,
        snapshot,
        receiptBytes: consumed.receiptBytes,
        plannedTreeHash: consumed.binding.plannedTreeHash,
      });
    } catch (error) {
      // Nothing was published: the staging directory is already gone and the
      // destination was never touched.
      entry = transitionSkillOperation(entry, 'FAILED_RECONCILABLE', {
        error: { code: errorCodeOf(error), message: messageOf(error) },
      });
      recordAuditSafely(entry, 'failed');
      throw error;
    }

    entry = transitionSkillOperation(entry, 'FS_COMMITTED', {
      receiptDigest: result.receiptSha256,
    });

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
      // The rename already landed. Reporting this as a failed install would
      // contradict what the user can see on disk, so the operation is handed to
      // #1234 reconciliation instead of being rolled back.
      entry = transitionSkillOperation(entry, 'FAILED_RECONCILABLE', {
        error: { code: 'SKILL_INSTALL_INDEX_FAILED', message: messageOf(error) },
      });
      recordAuditSafely(entry, 'failed');
      logger.error('skill-install-index-failed', {
        operationId: entry.operationId,
        error: redactSkillOperationText(messageOf(error)),
      });
    }

    const response: SkillInstallResponse = {
      operation: describeOperation(entry, { replayed: false }),
      install: {
        skillId: consumed.receipt.skill_id,
        version: consumed.receipt.version,
        installRoot: result.installRoot,
        receipt: {
          path: result.receiptPath,
          sha256: result.receiptSha256,
          size: result.receiptSize,
        },
        files: result.files,
        treeHash: result.treeHash,
      },
      reload: buildSkillReloadGuidance(consumed.receipt),
    };
    return NextResponse.json(response, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    if (isSkillPlanError(error)) {
      return skillApiError(error.code, 'The install plan was rejected.', error.status);
    }
    if (isSkillInstallError(error)) {
      return skillApiError(error.code, 'The install could not be applied.', error.status);
    }
    if (isSkillPackageError(error)) {
      return skillApiError(error.code, 'The Skill package failed verification.', 422);
    }
    if (isSkillFetchError(error)) {
      return skillApiError(error.code, 'The verified artifact could not be read.', 502);
    }
    logger.error('skill-install-failed', {
      error: redactSkillOperationText(messageOf(error)),
    });
    return skillApiError('SKILL_INSTALL_INTERNAL_ERROR', 'Failed to apply the install.', 500);
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
 * someone else's install.
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
      'SKILL_INSTALL_IDEMPOTENCY_CONFLICT',
      'This idempotency key was already used for a different request.',
      409
    );
  }
  if (!hasSkillFilesystemCommit(entry)) {
    return skillApiError(
      entry.state === 'PREPARING' ? 'SKILL_INSTALL_IN_PROGRESS' : 'SKILL_INSTALL_FAILED',
      entry.state === 'PREPARING'
        ? 'The operation for this idempotency key is still running.'
        : 'The operation for this idempotency key did not install anything.',
      409
    );
  }

  const installation = getSkillInstallation(getDbInstance(), worktreeId, skillId);
  const response: SkillInstallReplayResponse = {
    operation: describeOperation(entry, { replayed: true }),
    install: installation
      ? {
          skillId: installation.skillId,
          version: installation.version,
          installRoot: installation.installRoot,
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

function errorCodeOf(error: unknown): string {
  if (isSkillInstallError(error) || isSkillPlanError(error)) return error.code;
  if (isSkillPackageError(error) || isSkillFetchError(error)) return error.code;
  return 'SKILL_INSTALL_INTERNAL_ERROR';
}

/** Audit failures must not mask the outcome they are describing. */
function recordAuditSafely(
  entry: SkillOperationJournalEntry,
  outcome: 'succeeded' | 'failed'
): void {
  try {
    recordSkillOperationAudit(getDbInstance(), buildSkillOperationAuditInput(entry, outcome));
  } catch (error) {
    logger.warn('skill-install-audit-failed', {
      operationId: entry.operationId,
      error: redactSkillOperationText(messageOf(error)),
    });
  }
}

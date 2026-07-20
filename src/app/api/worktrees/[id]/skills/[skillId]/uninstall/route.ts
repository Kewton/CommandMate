/**
 * POST /api/worktrees/[id]/skills/[skillId]/uninstall — apply an Uninstall Plan (Issue #1236)
 *
 * The mirror of #1235's install route, with the order of operations kept
 * deliberately identical so the two are auditable side by side:
 *
 * 1. open the journal entry, so a crash at any later point is recoverable;
 * 2. take the exclusive (worktree, skill) lock (#1234);
 * 3. re-read branch, HEAD, the receipt digest and the destination tree, and
 *    spend the token only if they still match what the user approved —
 *    otherwise `SKILL_PLAN_STALE`;
 * 4. re-assess the install root and delete only provably managed, unchanged
 *    files, receipt last;
 * 5. drop the index row and audit.
 *
 * Where install and uninstall differ is the commit point. Install has an atomic
 * rename to hang it on; a delete does not, so step 4 reports its own commit
 * point through a callback, immediately before the first `unlink`. Everything
 * before it leaves the worktree untouched and is answered as "nothing happened".
 * Everything after it is answered as *committed, reconciling* — the payload is
 * partly gone and the user can see that.
 *
 * The refusal path matters as much as the success path: if a single file is
 * modified, unknown, missing or irregular, this route deletes nothing at all and
 * says which path stopped it (UX-07).
 *
 * @module api/worktrees/[id]/skills/[skillId]/uninstall
 */

import { realpathSync } from 'fs';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { validateSkillId } from '@/lib/skills/schema';
import { isSkillPlanError, type SkillPlanActor } from '@/lib/skills/install-plan';
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
  SKILL_UNINSTALL_NEXT_ACTION_KEYS,
  SKILL_UNINSTALL_RELOAD_MESSAGE_KEYS,
  consumeSkillUninstallPlan,
  getSkillUninstallPlan,
  readSkillReceiptDigest,
  type SkillUninstallBlocker,
} from '@/lib/skills/uninstall-plan';
import {
  applySkillUninstall,
  isSkillUninstallError,
  resolveSkillUninstallTarget,
  type SkillUninstallRemovedFile,
  type SkillUninstallRetainedPath,
} from '@/lib/skills/uninstall-apply';
import { deleteSkillInstallation } from '@/lib/skills/installed-state';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';
import type { SkillAgentSupport } from '@/types/skills';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/worktrees/[id]/skills/[skillId]/uninstall');

// =============================================================================
// Wire shape
// =============================================================================

/** How the operation ended, from the caller's point of view. */
export type SkillUninstallResult = 'succeeded' | 'committed_reconciling';

/** Journal state of the operation, plus what the user should do about it. */
export interface SkillUninstallOperationDto {
  operationId: string;
  idempotencyKey: string;
  state: SkillOperationJournalEntry['state'];
  result: SkillUninstallResult;
  /** Files were already being removed when the operation ended. */
  committed: boolean;
  reconcilePending: boolean;
  nextActionKey: string;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

/** What was removed, described without a machine-absolute path. */
export interface SkillUninstallPayloadDto {
  skillId: string;
  version: string;
  installRoot: string;
  removedFiles: SkillUninstallRemovedFile[];
  removedDirectories: string[];
  /** Anything still on disk, with the reason it stayed (UX-07). */
  retained: SkillUninstallRetainedPath[];
  receiptRemoved: boolean;
  fullyRemoved: boolean;
}

/** How to stop using the Skill that was just removed. */
export interface SkillUninstallReloadGuidance {
  skillId: string;
  version: string;
  installRoot: string;
  agents: Array<{ agent: string; support: SkillAgentSupport; messageKey: string }>;
}

export interface SkillUninstallResponse {
  operation: SkillUninstallOperationDto;
  uninstall: SkillUninstallPayloadDto;
  reload: SkillUninstallReloadGuidance;
}

/** Answer to a retried request. Narrower: the index row is already gone. */
export interface SkillUninstallReplayResponse {
  operation: SkillUninstallOperationDto;
  uninstall: { skillId: string; version: string | null } | null;
}

/** Body of a refusal that names the paths responsible. */
export interface SkillUninstallBlockedResponse {
  error: string;
  code: string;
  nextActionKey: string;
  blockers: SkillUninstallBlocker[];
}

// =============================================================================
// Body
// =============================================================================

/**
 * Fields a client must never be able to supply.
 *
 * `force` is listed rather than merely absent: the MVP has no force delete
 * (Non-goal), and a caller who tries one deserves to be told so instead of
 * having the flag silently dropped and concluding it worked.
 */
const REJECTED_BODY_KEYS = [
  'path',
  'paths',
  'worktreePath',
  'repositoryPath',
  'installRoot',
  'targetPath',
  'files',
  'checksum',
  'sha256',
  'receipt',
  'receiptDigest',
  'force',
  'recursive',
] as const;

const ALLOWED_BODY_KEYS = ['planToken', 'idempotencyKey'] as const;

/** Bound on a client-supplied idempotency key, which is hashed before it names a file. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Token grammar, checked before the plan store is consulted. */
const PLAN_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

interface UninstallRequestBody {
  planToken: string;
  idempotencyKey: string | null;
}

type BodyResult = { ok: true; body: UninstallRequestBody } | { ok: false; response: NextResponse };

function invalidBody(message: string): { ok: false; response: NextResponse } {
  return { ok: false, response: skillApiError('SKILL_UNINSTALL_INVALID_BODY', message, 400) };
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
          'The uninstall target is resolved by the server and cannot be supplied by the client.',
          400
        ),
      };
    }
    if (!(ALLOWED_BODY_KEYS as readonly string[]).includes(key)) {
      return invalidBody('Unknown field in body.');
    }
  }

  const { planToken, idempotencyKey } = record;
  if (typeof planToken !== 'string' || !PLAN_TOKEN_PATTERN.test(planToken)) {
    return invalidBody(
      'Field `planToken` must be a plan token issued by the uninstall-plan endpoint.'
    );
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
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
    },
  };
}

function resolveActor(request: NextRequest): SkillPlanActor {
  return { type: request.headers.get('authorization') ? 'cli' : 'user', id: null };
}

// =============================================================================
// Response assembly
// =============================================================================

function describeOperation(
  entry: SkillOperationJournalEntry,
  options: { replayed: boolean }
): SkillUninstallOperationDto {
  const succeeded = entry.state === 'SUCCEEDED';
  return {
    operationId: entry.operationId,
    idempotencyKey: entry.idempotencyKey,
    state: entry.state,
    result: succeeded ? 'succeeded' : 'committed_reconciling',
    committed: hasSkillFilesystemCommit(entry),
    reconcilePending: !succeeded,
    nextActionKey: succeeded
      ? SKILL_UNINSTALL_NEXT_ACTION_KEYS.succeeded
      : SKILL_UNINSTALL_NEXT_ACTION_KEYS.committedReconciling,
    replayed: options.replayed,
  };
}

/** A refusal that carries the offending paths, so the UI can explain them. */
function blockedResponse(
  code: string,
  message: string,
  status: number,
  blockers: readonly SkillUninstallBlocker[]
): NextResponse<SkillUninstallBlockedResponse> {
  return NextResponse.json(
    {
      error: message,
      code,
      nextActionKey: SKILL_UNINSTALL_NEXT_ACTION_KEYS.blocked,
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
    // spending a token that is already gone.
    if (parsed.body.idempotencyKey !== null) {
      const replay = readSkillOperationJournal(parsed.body.idempotencyKey);
      if (replay !== null) return answerReplay(replay, worktree.id, idResult.value);
    }

    let worktreeRealPath: string;
    try {
      worktreeRealPath = realpathSync(worktree.path);
    } catch {
      return skillApiError(
        'SKILL_UNINSTALL_TARGET_UNSAFE',
        'The registered worktree path could not be resolved.',
        409
      );
    }

    // Peeking does not spend the token; the plan is only consumed once the lock
    // is held and the live target has been re-read.
    const plan = getSkillUninstallPlan(parsed.body.planToken);
    // A blocked plan is refused before any operation is opened, and without
    // spending the token: the user has to resolve the named paths and re-plan,
    // and burning the token would only cost them the preview they are reading.
    if (!plan.dto.removable) {
      return blockedResponse(
        'SKILL_UNINSTALL_BLOCKED',
        'The uninstall was refused; nothing was deleted.',
        409,
        plan.dto.blockers
      );
    }

    const lockKey = buildSkillOperationLockKey(worktreeRealPath, idResult.value);
    const begun = beginSkillOperation({
      idempotencyKey: parsed.body.idempotencyKey ?? undefined,
      binding: {
        actor,
        operation: 'uninstall',
        target: {
          worktreeId: worktree.id,
          skillId: idResult.value,
          // The version comes from the receipt, not from the request: binding
          // the key to it is what makes a replay provably about *this* install.
          version: plan.binding.version,
        },
        planHash: plan.bindingHash,
      },
      lockKey,
      source: {
        origin: 'github-release',
        repository: plan.receipt.source.repository,
        ref: plan.receipt.source.ref,
        commit: plan.receipt.source.commit,
        artifactSha256: plan.receipt.artifact.sha256,
      },
    });
    if (!begun.ok) {
      return skillApiError(
        'SKILL_UNINSTALL_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different request.',
        409
      );
    }
    if (begun.replayed) return answerReplay(begun.entry, worktree.id, idResult.value);

    let entry = begun.entry;
    lock = acquireSkillOperationLock({ key: lockKey, operationId: entry.operationId });
    if (!lock.ok) {
      // Nothing was attempted, so the key must stay reusable.
      deleteSkillOperationJournal(entry.idempotencyKey);
      lock = null;
      return skillApiError(
        'SKILL_UNINSTALL_LOCKED',
        'Another operation is already running for this Skill and worktree.',
        409
      );
    }

    const installRootAbs = resolveSkillUninstallTarget(worktree.path, idResult.value);
    const git = await readSkillGitTargetState(worktree.path);
    const existing = readExistingSkillTree(installRootAbs);

    let consumed;
    try {
      consumed = consumeSkillUninstallPlan(
        parsed.body.planToken,
        { actor, worktreeId: worktree.id, skillId: idResult.value },
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

    let committed = false;
    let result;
    try {
      result = applySkillUninstall({
        worktreePath: worktree.path,
        worktreeRealPath,
        skillId: idResult.value,
        expectedReceiptDigest: consumed.binding.receiptDigest,
        expectedTreeHash: consumed.binding.currentTreeHash,
        onCommitPoint: () => {
          committed = true;
          entry = transitionSkillOperation(entry, 'FS_COMMITTED', {
            receiptDigest: consumed.binding.receiptDigest,
          });
        },
      });
    } catch (error) {
      entry = transitionSkillOperation(entry, 'FAILED_RECONCILABLE', {
        error: { code: errorCodeOf(error), message: messageOf(error) },
      });
      recordAuditSafely(entry, 'failed');
      if (!committed) throw error;

      // Deletion had already begun, so the receipt and the surviving files are
      // the diagnostic record; reconciliation converges from there.
      logger.error('skill-uninstall-partial', {
        operationId: entry.operationId,
        error: redactSkillOperationText(messageOf(error)),
      });
      throw error;
    }

    try {
      deleteSkillInstallation(getDbInstance(), worktree.id, idResult.value);
      entry = transitionSkillOperation(entry, 'INDEXED');
      entry = transitionSkillOperation(entry, 'SUCCEEDED', { error: null });
      recordAuditSafely(entry, 'succeeded');
    } catch (error) {
      // The files are gone. Reporting this as a failed uninstall would
      // contradict what the user can see on disk.
      entry = transitionSkillOperation(entry, 'FAILED_RECONCILABLE', {
        error: { code: 'SKILL_UNINSTALL_INDEX_FAILED', message: messageOf(error) },
      });
      recordAuditSafely(entry, 'failed');
      logger.error('skill-uninstall-index-failed', {
        operationId: entry.operationId,
        error: redactSkillOperationText(messageOf(error)),
      });
    }

    const response: SkillUninstallResponse = {
      operation: describeOperation(entry, { replayed: false }),
      uninstall: {
        skillId: idResult.value,
        version: result.version,
        installRoot: result.installRoot,
        removedFiles: result.removedFiles,
        removedDirectories: result.removedDirectories,
        retained: result.retained,
        receiptRemoved: result.receiptRemoved,
        fullyRemoved: result.fullyRemoved,
      },
      reload: {
        skillId: idResult.value,
        version: result.version,
        installRoot: result.installRoot,
        agents: consumed.receipt.agent_compatibility.map((agent) => ({
          agent: agent.agent,
          support: agent.support,
          messageKey: SKILL_UNINSTALL_RELOAD_MESSAGE_KEYS[agent.support],
        })),
      },
    };
    return NextResponse.json(response, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    if (isSkillUninstallError(error)) {
      // A 5xx is the only case where deletion may already have started, so it
      // is the only one that must not claim the worktree is untouched.
      return blockedResponse(
        error.code,
        error.status >= 500
          ? 'The uninstall did not complete. The receipt and the remaining files are still in place.'
          : 'The uninstall was refused; nothing was deleted.',
        error.status,
        error.blockers
      );
    }
    if (isSkillPlanError(error)) {
      return skillApiError(error.code, 'The uninstall plan was rejected.', error.status);
    }
    logger.error('skill-uninstall-failed', {
      error: redactSkillOperationText(messageOf(error)),
    });
    return skillApiError('SKILL_UNINSTALL_INTERNAL_ERROR', 'Failed to apply the uninstall.', 500);
  } finally {
    if (lock?.ok) releaseSkillOperationLock(lock.lock);
  }
}

// =============================================================================
// Replay
// =============================================================================

/**
 * Answer from a journal entry an earlier request already produced.
 *
 * A replay is only honoured for the same target: the same key naming a
 * different worktree or Skill is a conflict, never a substitution of someone
 * else's uninstall.
 */
function answerReplay(
  entry: SkillOperationJournalEntry,
  worktreeId: string,
  skillId: string
): NextResponse {
  if (entry.target.worktreeId !== worktreeId || entry.target.skillId !== skillId) {
    return skillApiError(
      'SKILL_UNINSTALL_IDEMPOTENCY_CONFLICT',
      'This idempotency key was already used for a different request.',
      409
    );
  }
  if (!hasSkillFilesystemCommit(entry)) {
    return skillApiError(
      entry.state === 'PREPARING' ? 'SKILL_UNINSTALL_IN_PROGRESS' : 'SKILL_UNINSTALL_FAILED',
      entry.state === 'PREPARING'
        ? 'The operation for this idempotency key is still running.'
        : 'The operation for this idempotency key did not remove anything.',
      409
    );
  }

  const response: SkillUninstallReplayResponse = {
    operation: describeOperation(entry, { replayed: true }),
    uninstall: { skillId, version: entry.target.version },
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
  if (isSkillUninstallError(error) || isSkillPlanError(error)) return error.code;
  return 'SKILL_UNINSTALL_INTERNAL_ERROR';
}

/** Audit failures must not mask the outcome they are describing. */
function recordAuditSafely(
  entry: SkillOperationJournalEntry,
  outcome: 'succeeded' | 'failed'
): void {
  try {
    recordSkillOperationAudit(getDbInstance(), buildSkillOperationAuditInput(entry, outcome));
  } catch (error) {
    logger.warn('skill-uninstall-audit-failed', {
      operationId: entry.operationId,
      error: redactSkillOperationText(messageOf(error)),
    });
  }
}

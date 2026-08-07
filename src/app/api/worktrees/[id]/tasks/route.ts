/**
 * API Route: POST / GET /api/worktrees/:id/tasks
 * Execution contracts (Issue #1545, Phase 2-1).
 *
 * POST parses the contract at `contractPath` inside the worktree, records a
 * `pending` task, and returns the composed message for the caller to send. The
 * parse happens here rather than in the CLI because the contract path is
 * relative to the worktree — which only the server knows — and because the
 * completion criterion is resolved against that worktree's verify.yaml.
 *
 * The task row is created only after the contract validates: an unreadable
 * contract has nothing to record.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { createTask, getWorktreeById, listTasks } from '@/lib/db';
import { isValidInstanceId, isCliToolType } from '@/lib/cli-tools/types';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { loadTaskContract, TaskContractError } from '@/lib/tasks/contract-parser';
import {
  composeContractMessage,
  validateContractAgainstVerifyConfig,
} from '@/lib/tasks/contract-message';
import { loadVerifyConfig, VerifyConfigError } from '@/lib/verification/verify-config';
import { resolveRequireEnvClean } from '@/lib/verification/env-clean-gate';
import { captureEnvSnapshot, saveEnvSnapshot } from '@/lib/verification/env-snapshot';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/tasks');

const MAX_CONTRACT_PATH_LENGTH = 512;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;

/**
 * Record the machine's state as this task begins (Issue #1740).
 *
 * Only when a declaration switched `env-clean` on. The gate is opt-in, and an
 * opt-in gate that writes a file on every send would not be off — "省略時に既存
 *契約の挙動が 1 bit も変わらない" has to include side effects, not just
 * verdicts. The cost of that choice is that switching the gate on mid-flight
 * cannot retroactively produce a baseline, which is correct: the gate reports
 * UNKNOWN rather than inventing one.
 *
 * Never throws. A snapshot that could not be written leaves no baseline, and a
 * missing baseline is UNKNOWN at verification time — failing the send instead
 * would make an unrelated `lsof` problem block the delegation itself.
 */
async function recordEnvBaseline(
  taskId: string,
  worktreeId: string,
  contract: Parameters<typeof resolveRequireEnvClean>[0],
  verifyConfig: Parameters<typeof resolveRequireEnvClean>[1]
): Promise<void> {
  if (!resolveRequireEnvClean(contract, verifyConfig).required) return;
  try {
    saveEnvSnapshot(taskId, await captureEnvSnapshot({ worktreeId }));
  } catch (error) {
    logger.warn('env-baseline-capture-failed', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    const body: unknown = await request.json().catch(() => ({}));
    const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;

    const contractPath = payload.contractPath;
    if (
      typeof contractPath !== 'string' ||
      contractPath.trim() === '' ||
      contractPath.length > MAX_CONTRACT_PATH_LENGTH
    ) {
      return NextResponse.json(
        { error: `contractPath is required (1..${MAX_CONTRACT_PATH_LENGTH} characters)` },
        { status: 400 }
      );
    }

    if (payload.cliToolId !== undefined) {
      if (typeof payload.cliToolId !== 'string' || !isCliToolType(payload.cliToolId)) {
        return NextResponse.json({ error: 'Invalid cliToolId' }, { status: 400 });
      }
    }

    if (payload.instanceId !== undefined) {
      if (typeof payload.instanceId !== 'string' || !isValidInstanceId(payload.instanceId)) {
        return NextResponse.json({ error: 'Invalid instanceId' }, { status: 400 });
      }
    }

    // Contract issues are returned as a list, not one at a time: the loader
    // collects every violation and the caller prints all of them (exit 2).
    let contract;
    try {
      contract = loadTaskContract(worktree.path, contractPath);
    } catch (error) {
      if (error instanceof TaskContractError) {
        return NextResponse.json(
          { error: 'Invalid task contract', issues: error.issues },
          { status: 400 }
        );
      }
      throw error;
    }

    // A malformed verify.yaml is reported as a contract issue rather than a 500:
    // it is the same class of problem for the caller, and the same fix.
    let verifyConfig = null;
    try {
      verifyConfig = loadVerifyConfig(worktree.path);
    } catch (error) {
      if (!(error instanceof VerifyConfigError)) throw error;
      return NextResponse.json(
        { error: 'Invalid task contract', issues: error.issues },
        { status: 400 }
      );
    }

    const gateIssues = validateContractAgainstVerifyConfig(contract, verifyConfig);
    if (gateIssues.length > 0) {
      return NextResponse.json(
        { error: 'Invalid task contract', issues: gateIssues },
        { status: 400 }
      );
    }

    const task = createTask(db, {
      worktreeId: id,
      cliToolId: (payload.cliToolId as string | undefined) ?? worktree.cliToolId ?? 'claude',
      instanceId: (payload.instanceId as string | undefined) ?? null,
      contractPath,
      contract,
    });

    await recordEnvBaseline(task.id, id, contract, verifyConfig);

    return NextResponse.json(
      { task, message: composeContractMessage(contract, verifyConfig) },
      { status: 201 }
    );
  } catch (error: unknown) {
    logger.error('error-creating-task:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    const rawLimit = new URL(request.url).searchParams.get('limit');
    let limit = DEFAULT_LIST_LIMIT;
    if (rawLimit !== null) {
      if (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > MAX_LIST_LIMIT) {
        return NextResponse.json(
          { error: `limit must be an integer 1..${MAX_LIST_LIMIT}` },
          { status: 400 }
        );
      }
      limit = Number(rawLimit);
    }

    return NextResponse.json({ tasks: listTasks(db, id, limit) }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-listing-tasks:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to list tasks' }, { status: 500 });
  }
}

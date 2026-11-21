/**
 * The read and the write of `POST /tasks`, cut out of the route (Issue #4466 PR1a).
 *
 * {@link readTaskContractForCreate} only reads (the contract and verify.yaml inside the
 * worktree; nothing written). {@link findTaskWriteRefusal} and {@link createTaskIfAllowed}
 * are synchronous: the judgment, and the judgment followed by the row with nothing in
 * between, for the target the caller passes in. The route calls them in the order it
 * always had; the answers, codes and the order of the writes are unchanged.
 *
 * @module app/api/worktrees/[id]/tasks/task-create
 */

import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import { createTask, type Task } from '@/lib/db';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { loadTaskContract, TaskContractError, type TaskContract } from '@/lib/tasks/contract-parser';
import { validateContractAgainstVerifyConfig } from '@/lib/tasks/contract-message';
import { loadVerifyConfig, VerifyConfigError, type VerifyConfig } from '@/lib/verification/verify-config';
import { findWriteToolPolicyRefusal, type WriteToolPolicyRequest } from '../send/write-tool-policy';

/** The contract a task is created from, and the verify.yaml it was checked against. */
export interface TaskContractForCreate {
  contract: TaskContract;
  verifyConfig: VerifyConfig | null;
}

/**
 * Read and check the contract at `contractPath` inside the worktree. Reads only: no row,
 * no file. Synchronous.
 *
 * @returns The contract and verify.yaml, or the 400 the route answers
 */
export function readTaskContractForCreate(
  worktreePath: string,
  contractPath: string,
): { ok: true; value: TaskContractForCreate } | { ok: false; response: NextResponse } {
  // Contract issues are returned as a list, not one at a time: the loader
  // collects every violation and the caller prints all of them (exit 2).
  let contract;
  try {
    contract = loadTaskContract(worktreePath, contractPath);
  } catch (error) {
    if (error instanceof TaskContractError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Invalid task contract', issues: error.issues },
          { status: 400 }
        ),
      };
    }
    throw error;
  }

  // A malformed verify.yaml is reported as a contract issue rather than a 500:
  // it is the same class of problem for the caller, and the same fix.
  let verifyConfig = null;
  try {
    verifyConfig = loadVerifyConfig(worktreePath);
  } catch (error) {
    if (!(error instanceof VerifyConfigError)) throw error;
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Invalid task contract', issues: error.issues },
        { status: 400 }
      ),
    };
  }

  const gateIssues = validateContractAgainstVerifyConfig(contract, verifyConfig);
  if (gateIssues.length > 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Invalid task contract', issues: gateIssues },
        { status: 400 }
      ),
    };
  }
  return { ok: true, value: { contract, verifyConfig } };
}

/** The target a task row is judged and written for (the route's strict resolution). */
export interface TaskWriteTarget {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
}

/**
 * The tool policy for a task written for `target`: the 409, or null when it may be
 * written. Synchronous; reads only.
 */
export function findTaskWriteRefusal(
  db: Database.Database,
  target: TaskWriteTarget,
  request: WriteToolPolicyRequest,
): NextResponse | null {
  const refusal = findWriteToolPolicyRefusal(db, {
    worktreeId: target.worktreeId,
    tool: target.cliToolId,
    instanceId: target.instanceId,
    request,
  });
  return refusal ? NextResponse.json(refusal, { status: 409 }) : null;
}

/**
 * Judge the task for `target` and, when allowed, write its `pending` row — with
 * nothing in between. Synchronous.
 *
 * @param rowInstanceId The instance id the row records (the body's, else null)
 */
export function createTaskIfAllowed(
  db: Database.Database,
  target: TaskWriteTarget,
  request: WriteToolPolicyRequest,
  row: { rowInstanceId: string | null; contractPath: string; contract: TaskContract },
): { ok: true; task: Task } | { ok: false; response: NextResponse } {
  const refusal = findTaskWriteRefusal(db, target, request);
  if (refusal) return { ok: false, response: refusal };
  const task = createTask(db, {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId: row.rowInstanceId,
    contractPath: row.contractPath,
    contract: row.contract,
  });
  return { ok: true, task };
}

/**
 * API Route: POST /api/worktrees/:id/verify
 * Starts a verification run for a worktree (Issue #1543).
 *
 * Responds 202 with the run id rather than the verdict: gates are test suites
 * and builds, so the caller polls `/verify/runs/:runId` instead of holding a
 * connection open for minutes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, VERIFICATION_TRIGGERS, type VerificationTrigger } from '@/lib/db';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { startVerification, VerificationConflictError } from '@/lib/verification/gate-runner';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/verify');

/** Bounded so a request body cannot make the runner iterate an unbounded list. */
const MAX_GATE_IDS = 32;

function isTrigger(value: unknown): value is VerificationTrigger {
  return typeof value === 'string' && (VERIFICATION_TRIGGERS as readonly string[]).includes(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!isValidWorktreeId(id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    // A verify request carries no required fields, so an absent or unparseable
    // body is treated as "all defaults" rather than a 400.
    const body: unknown = await request.json().catch(() => ({}));
    const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;

    if (payload.instanceId !== undefined) {
      if (typeof payload.instanceId !== 'string' || !isValidInstanceId(payload.instanceId)) {
        return NextResponse.json({ error: 'Invalid instanceId' }, { status: 400 });
      }
    }

    if (payload.trigger !== undefined && !isTrigger(payload.trigger)) {
      return NextResponse.json(
        { error: `trigger must be one of: ${VERIFICATION_TRIGGERS.join(', ')}` },
        { status: 400 }
      );
    }

    let gateIds: string[] | undefined;
    if (payload.gateIds !== undefined) {
      if (
        !Array.isArray(payload.gateIds) ||
        payload.gateIds.length === 0 ||
        payload.gateIds.length > MAX_GATE_IDS ||
        !payload.gateIds.every((gateId) => typeof gateId === 'string' && gateId.trim() !== '')
      ) {
        return NextResponse.json(
          { error: `gateIds must be 1..${MAX_GATE_IDS} non-empty strings` },
          { status: 400 }
        );
      }
      gateIds = payload.gateIds as string[];
    }

    const { runId } = await startVerification({
      worktreeId: id,
      worktreePath: worktree.path,
      instanceId: payload.instanceId as string | undefined,
      trigger: isTrigger(payload.trigger) ? payload.trigger : 'api',
      gateIds,
    });

    return NextResponse.json({ runId }, { status: 202 });
  } catch (error: unknown) {
    if (error instanceof VerificationConflictError) {
      return NextResponse.json(
        { error: error.message, runningRunId: error.runningRunId },
        { status: 409 }
      );
    }
    logger.error('error-starting-verification:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to start verification' }, { status: 500 });
  }
}

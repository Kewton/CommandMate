/**
 * Timer API endpoint
 * Issue #534: Timer-based delayed message sending
 *
 * POST   - Register a new timer
 * GET    - List timers for a worktree
 * DELETE - Cancel a timer (via ?timerId=xxx query param)
 *
 * Security:
 * - [SEC-SF-002] worktreeId typeof/non-empty check + DB existence
 * - [SEC-SF-001] timerId UUID v4 validation (DELETE)
 * - [SEC-MF-001] Fixed-string error responses in catch blocks
 * - [CON-C-002] MAX_TIMER_MESSAGE_LENGTH from timer-constants.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db-instance';
import {
  createTimer,
  getTimersByWorktree,
  getTimerById,
  getPendingTimerCountByWorktree,
} from '@/lib/db/timer-db';
import { isValidTimerDelay, MAX_TIMERS_PER_WORKTREE, MAX_TIMER_MESSAGE_LENGTH } from '@/config/timer-constants';
import { isValidUuidV4 } from '@/config/schedule-config';
import { scheduleTimer, cancelScheduledTimer } from '@/lib/timer-manager';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/timers');

// MAX_TIMER_MESSAGE_LENGTH imported from timer-constants.ts [CON-C-002]

/**
 * POST /api/worktrees/[id]/timers
 * Register a new timer
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // [SEC-SF-002] Validate worktreeId
    if (typeof id !== 'string' || id.length === 0) {
      return NextResponse.json({ error: 'Invalid worktree ID' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    const body = await req.json();
    const { cliToolId, message, delayMs } = body;

    // Validate cliToolId
    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json({ error: 'Invalid agent' }, { status: 400 });
    }

    // Validate message
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Invalid message' }, { status: 400 });
    }
    if (message.length > MAX_TIMER_MESSAGE_LENGTH) {
      return NextResponse.json({ error: 'Invalid message' }, { status: 400 });
    }

    // Validate delayMs [DP-001]
    if (!isValidTimerDelay(delayMs)) {
      return NextResponse.json({ error: 'Invalid delay' }, { status: 400 });
    }

    // Check pending timer limit
    const pendingCount = getPendingTimerCountByWorktree(db, id);
    if (pendingCount >= MAX_TIMERS_PER_WORKTREE) {
      return NextResponse.json({ error: 'Max timers reached' }, { status: 400 });
    }

    // Create timer in DB
    const timer = createTimer(db, {
      worktreeId: id,
      cliToolId,
      message,
      delayMs,
    });

    // Schedule in-memory setTimeout
    const remaining = timer.scheduledSendTime - Date.now();
    scheduleTimer(timer.id, id, Math.max(0, remaining));

    return NextResponse.json({
      id: timer.id,
      worktreeId: timer.worktreeId,
      cliToolId: timer.cliToolId,
      message: timer.message,
      delayMs: timer.delayMs,
      scheduledSendTime: timer.scheduledSendTime,
      status: timer.status,
      createdAt: timer.createdAt,
    }, { status: 201 });
  } catch (error) {
    // [SEC-MF-001] Fixed-string error response
    logger.error('timer:post-error', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/worktrees/[id]/timers
 * List timers for a worktree
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // [SEC-SF-002] Validate worktreeId
    if (typeof id !== 'string' || id.length === 0) {
      return NextResponse.json({ error: 'Invalid worktree ID' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    const timers = getTimersByWorktree(db, id);

    // [CON-SF-002] Omit worktreeId from GET response (client already knows it)
    return NextResponse.json({
      timers: timers.map(t => ({
        id: t.id,
        cliToolId: t.cliToolId,
        message: t.message,
        delayMs: t.delayMs,
        scheduledSendTime: t.scheduledSendTime,
        status: t.status,
        createdAt: t.createdAt,
        sentAt: t.sentAt,
      })),
    });
  } catch (error) {
    // [SEC-MF-001] Fixed-string error response
    logger.error('timer:get-error', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/worktrees/[id]/timers?timerId=xxx
 * Cancel a timer
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // [SEC-SF-002] Validate worktreeId
    if (typeof id !== 'string' || id.length === 0) {
      return NextResponse.json({ error: 'Invalid worktree ID' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    // [SEC-SF-001] Validate timerId UUID format
    const timerId = req.nextUrl.searchParams.get('timerId');
    if (!timerId || !isValidUuidV4(timerId)) {
      return NextResponse.json({ error: 'Invalid timer ID' }, { status: 400 });
    }

    // Check timer exists
    const timer = getTimerById(db, timerId);
    if (!timer) {
      return NextResponse.json({ error: 'Timer not found' }, { status: 404 });
    }

    // [CON-SF-004] Only pending timers can be cancelled
    if (timer.status !== 'pending') {
      return NextResponse.json({ error: 'Timer is not in pending status' }, { status: 409 });
    }

    // Cancel in-memory timer and update DB
    cancelScheduledTimer(timerId);

    return NextResponse.json({ success: true });
  } catch (error) {
    // [SEC-MF-001] Fixed-string error response
    logger.error('timer:delete-error', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

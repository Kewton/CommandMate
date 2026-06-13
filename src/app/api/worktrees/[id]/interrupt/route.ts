/**
 * API Route: POST /api/worktrees/:id/interrupt
 * Sends Escape key to interrupt CLI tool processing
 *
 * Issue #46: エスケープを入力可能にしたい
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, getAgentInstance, getAgentInstances } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { createLogger, generateRequestId } from '@/lib/logger';
import { CLI_TOOL_IDS, isCliToolType, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';

const logger = createLogger('interrupt');

interface InterruptRequest {
  cliToolId?: CLIToolType;
  instanceId?: string;  // Issue #868: target a specific agent instance (defaults to primary)
}

interface InterruptResult {
  cliToolId: CLIToolType;
  instanceId: string;
  sessionName: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: worktreeId } = await params;
  const requestId = generateRequestId();
  const log = logger.withContext({ worktreeId, requestId });

  log.info('interrupt:request');

  try {
    const db = getDbInstance();

    // 1. Worktree存在確認
    const worktree = getWorktreeById(db, worktreeId);
    if (!worktree) {
      log.warn('interrupt:worktree_not_found');
      return NextResponse.json(
        { error: `Worktree '${worktreeId}' not found` },
        { status: 404 }
      );
    }

    // 2. リクエストボディを取得
    let body: InterruptRequest = {};
    try {
      body = await request.json();
    } catch {
      // body is optional
    }

    // Issue #868: validate the optional instance selector (embedded in session names).
    if (body.instanceId !== undefined && !isValidInstanceId(body.instanceId)) {
      return NextResponse.json(
        { error: 'Invalid instanceId parameter' },
        { status: 400 }
      );
    }

    const manager = CLIToolManager.getInstance();
    const interrupted: InterruptResult[] = [];

    // 3. 指定されたCLIツール/インスタンスまたは全てに中断を送信
    // Issue #868: build the (cliToolId, instanceId) target list. The primary
    // instance uses instanceId === cliToolId (backward compatible).
    const targets: Array<{ cliToolId: CLIToolType; instanceId: string }> = [];

    if (body.instanceId) {
      // Single-instance interrupt: resolve the backing CLI tool.
      const known = getAgentInstance(db, worktreeId, body.instanceId);
      const resolvedTool: CLIToolType | null =
        (body.cliToolId ?? null)
        ?? (known ? known.cliTool : null)
        ?? (isCliToolType(body.instanceId) ? body.instanceId : null);
      if (!resolvedTool) {
        return NextResponse.json(
          { error: 'Could not resolve CLI tool for the specified instance. Provide cliToolId.' },
          { status: 400 }
        );
      }
      targets.push({ cliToolId: resolvedTool, instanceId: body.instanceId });
    } else {
      // Issue #368: Use CLI_TOOL_IDS instead of hardcoded array (DRY)
      const targetToolIds: readonly CLIToolType[] = body.cliToolId
        ? [body.cliToolId]
        : CLI_TOOL_IDS;
      const seen = new Set<string>();
      for (const tool of targetToolIds) {
        const key = `${tool}:${tool}`;
        if (!seen.has(key)) {
          seen.add(key);
          targets.push({ cliToolId: tool, instanceId: tool });
        }
      }
      // Include additional registered instances of the targeted tools.
      for (const ai of getAgentInstances(db, worktreeId)) {
        if (targetToolIds.includes(ai.cliTool)) {
          const key = `${ai.cliTool}:${ai.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            targets.push({ cliToolId: ai.cliTool, instanceId: ai.id });
          }
        }
      }
    }

    for (const { cliToolId, instanceId } of targets) {
      const cliTool = manager.getTool(cliToolId);
      const isRunning = await cliTool.isRunning(worktreeId, instanceId);

      if (isRunning) {
        const sessionName = cliTool.getSessionName(worktreeId, instanceId);
        log.debug('interrupt:sending', { cliToolId, sessionName });

        await cliTool.interrupt(worktreeId, instanceId);

        interrupted.push({ cliToolId, instanceId, sessionName });
        log.info('interrupt:sent', { cliToolId, sessionName });
      }
    }

    // 4. 結果を返却
    if (interrupted.length === 0) {
      log.warn('interrupt:no_active_sessions');
      return NextResponse.json(
        { error: 'No active sessions found' },
        { status: 404 }
      );
    }

    log.info('interrupt:success', { interruptedCount: interrupted.length });

    return NextResponse.json(
      {
        success: true,
        message: `Interrupt sent to ${interrupted.length} session(s)`,
        interrupted,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('interrupt:error', { error: errorMessage });

    return NextResponse.json(
      { error: 'Failed to send interrupt' },
      { status: 500 }
    );
  }
}

/**
 * API Route: POST /api/worktrees/:id/interrupt
 * Sends Escape key to interrupt CLI tool processing
 *
 * Issue #46: エスケープを入力可能にしたい
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { createLogger, generateRequestId } from '@/lib/logger';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';

const logger = createLogger('interrupt');

interface InterruptRequest {
  cliToolId?: CLIToolType;
}

interface InterruptResult {
  cliToolId: CLIToolType;
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

    const manager = CLIToolManager.getInstance();
    const interrupted: InterruptResult[] = [];

    // 3. 指定されたCLIツールまたは全CLIツールに中断を送信
    // Issue #368: Use CLI_TOOL_IDS instead of hardcoded array (DRY)
    const targetToolIds: readonly CLIToolType[] = body.cliToolId
      ? [body.cliToolId]
      : CLI_TOOL_IDS;

    for (const cliToolId of targetToolIds) {
      const cliTool = manager.getTool(cliToolId);
      const isRunning = await cliTool.isRunning(worktreeId);

      if (isRunning) {
        const sessionName = cliTool.getSessionName(worktreeId);
        log.debug('interrupt:sending', { cliToolId, sessionName });

        await cliTool.interrupt(worktreeId);

        interrupted.push({ cliToolId, sessionName });
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

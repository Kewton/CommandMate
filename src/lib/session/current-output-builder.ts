/**
 * Shared builder for the "current terminal output" payload (Issue #1120).
 *
 * Extracted from the GET /api/worktrees/[id]/current-output route so the exact
 * same payload can be produced by the server-side response poller and pushed
 * over WebSocket (terminal streaming), keeping the pull (HTTP) and push (WS)
 * paths byte-for-byte consistent (DRY).
 */

import type Database from 'better-sqlite3';
import { getSessionState } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { detectSessionStatus, STATUS_REASON, SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import {
  getAutoYesState,
  getLastServerResponseTimestamp,
  isPollerActive,
  buildCompositeKey,
} from '@/lib/polling/auto-yes-manager';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import type { PromptData } from '@/types/models';

export interface CurrentOutputPayload {
  isRunning: boolean;
  cliToolId: CLIToolType;
  sessionStatus: string;
  sessionStatusReason: string;
  content: string;
  fullOutput?: string;
  realtimeSnippet?: string;
  lineCount: number;
  lastCapturedLine?: number;
  isComplete?: boolean;
  isGenerating?: boolean;
  thinking?: boolean;
  thinkingMessage?: string | null;
  isPromptWaiting?: boolean;
  promptData?: PromptData | null;
  autoYes?: {
    enabled: boolean;
    expiresAt: number | null;
    stopReason?: string;
  };
  isSelectionListActive?: boolean;
  isPagerActive?: boolean;
  isUnclassifiedActive?: boolean;
  lastServerResponseTimestamp?: number | null;
  serverPollerActive?: boolean;
}

/**
 * Build the current-output payload for a worktree session.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID (assumed already validated by the caller)
 * @param cliToolId - CLI tool ID
 * @param instanceId - Optional agent instance ID (defaults to the primary instance)
 */
export async function buildCurrentOutput(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<CurrentOutputPayload> {
  const resolvedInstanceId = instanceId ?? cliToolId;
  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);

  const running = await cliTool.isRunning(worktreeId, instanceId);
  if (!running) {
    return {
      isRunning: false,
      content: '',
      lineCount: 0,
      cliToolId,
      sessionStatus: 'idle',
      sessionStatusReason: 'session_not_running',
    };
  }

  const sessionState = getSessionState(db, worktreeId, resolvedInstanceId);
  const lastCapturedLine = sessionState?.lastCapturedLine || 0;

  const output = await captureSessionOutput(worktreeId, cliToolId, STATUS_CAPTURE_LINES, instanceId);
  const lines = output.split('\n');
  const totalLines = lines.length;

  const newLines = lines.slice(Math.max(0, lastCapturedLine));
  const newContent = newLines.join('\n');

  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const lastServerResponseTimestamp = getLastServerResponseTimestamp(compositeKey);
  const lastOutputTimestamp = lastServerResponseTimestamp ? new Date(lastServerResponseTimestamp) : undefined;

  const statusResult = detectSessionStatus(output, cliToolId, lastOutputTimestamp);
  const thinking = statusResult.status === 'running' && statusResult.reason === STATUS_REASON.THINKING_INDICATOR;
  const isPromptWaiting = statusResult.hasActivePrompt;
  const isSelectionListActive =
    statusResult.status === 'waiting' && SELECTION_LIST_REASONS.has(statusResult.reason);
  const isPagerActive = statusResult.reason === STATUS_REASON.CODEX_PAGER;
  const isUnclassifiedActive =
    statusResult.status === 'running' && statusResult.reason === STATUS_REASON.DEFAULT;

  const realtimeSnippet = lines.slice(-100).join('\n');
  const autoYesState = getAutoYesState(worktreeId, cliToolId, instanceId);

  return {
    isRunning: true,
    cliToolId,
    sessionStatus: statusResult.status,
    sessionStatusReason: statusResult.reason,
    content: newContent,
    fullOutput: output,
    realtimeSnippet,
    lineCount: totalLines,
    lastCapturedLine,
    isComplete: isPromptWaiting,
    isGenerating: thinking,
    thinking,
    thinkingMessage: thinking ? 'Claude is thinking...' : null,
    isPromptWaiting,
    promptData: isPromptWaiting ? statusResult.promptDetection.promptData ?? null : null,
    autoYes: {
      enabled: autoYesState?.enabled ?? false,
      expiresAt: autoYesState?.enabled ? autoYesState.expiresAt : null,
      stopReason: autoYesState?.stopReason,
    },
    isSelectionListActive,
    isPagerActive,
    isUnclassifiedActive,
    lastServerResponseTimestamp,
    serverPollerActive: isPollerActive(compositeKey),
  };
}

/**
 * Worktree session status detection helper
 *
 * Issue #405: Extracted from worktrees/route.ts and worktrees/[id]/route.ts
 * to eliminate code duplication (DRY principle).
 *
 * Provides batch session status detection for all CLI tools of a given worktree,
 * including:
 * - Session existence check via pre-queried tmux session name Set
 * - Claude-only health check (other tools use simple session existence)
 * - Terminal output capture and status detection
 * - Stale pending prompt cleanup
 */

import { CLIToolManager } from './cli-tools/manager';
import { CLI_TOOL_IDS, type CLIToolType } from './cli-tools/types';
import { captureSessionOutput } from './cli-session';
import { detectSessionStatus } from './status-detector';
import { OPENCODE_PANE_HEIGHT } from './cli-tools/opencode';
import { isSessionHealthy } from './claude-session';
import type { getMessages as GetMessagesFn, markPendingPromptsAsAnswered as MarkPendingFn } from './db';

/** Per-CLI-tool session status */
export interface CliToolSessionStatus {
  isRunning: boolean;
  isWaitingForResponse: boolean;
  isProcessing: boolean;
}

/** Aggregated session status result for a worktree */
export interface WorktreeSessionStatus {
  /** Per-CLI-tool session status map */
  sessionStatusByCli: Partial<Record<CLIToolType, CliToolSessionStatus>>;
  /** Whether any CLI tool session is running */
  isSessionRunning: boolean;
  /** Whether any CLI tool is waiting for a user response */
  isWaitingForResponse: boolean;
  /** Whether any CLI tool is actively processing */
  isProcessing: boolean;
}

/**
 * Detect session status for all CLI tools of a single worktree.
 *
 * Consolidates the duplicated logic previously in worktrees/route.ts (GET)
 * and worktrees/[id]/route.ts (GET). Both routes now delegate to this function.
 *
 * @param worktreeId - Worktree ID
 * @param sessionNameSet - Pre-queried Set of active tmux session names (from listSessions())
 * @param db - Database instance
 * @param getMessages - DB function to get messages for a worktree
 * @param markPendingPromptsAsAnswered - DB function to mark stale prompts as answered
 * @returns Aggregated session status for the worktree
 */
export async function detectWorktreeSessionStatus(
  worktreeId: string,
  sessionNameSet: Set<string>,
  db: ReturnType<typeof import('./db-instance').getDbInstance>,
  getMessages: typeof GetMessagesFn,
  markPendingPromptsAsAnswered: typeof MarkPendingFn,
): Promise<WorktreeSessionStatus> {
  const manager = CLIToolManager.getInstance();
  const allCliTools: readonly CLIToolType[] = CLI_TOOL_IDS;

  const sessionStatusByCli: Partial<Record<CLIToolType, CliToolSessionStatus>> = {};
  let anyRunning = false;
  let anyWaiting = false;
  let anyProcessing = false;

  for (const cliToolId of allCliTools) {
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(worktreeId);

    // Issue #405: Use Set.has() instead of individual hasSession() calls
    let isRunning = sessionNameSet.has(sessionName);

    // [DR1-005] Claude-only health check (other tools use simple session existence)
    if (isRunning && cliToolId === 'claude') {
      const healthResult = await isSessionHealthy(sessionName);
      if (!healthResult.healthy) {
        isRunning = false;
      }
    }

    // Check status based on terminal state
    // - isWaitingForResponse: Interactive prompt (yes/no, multiple choice)
    // - isProcessing: Thinking indicator visible
    let isWaitingForResponse = false;
    let isProcessing = false;
    if (isRunning) {
      try {
        // OpenCode TUI uses a 200-line pane; capture full pane to see content area
        const captureLines = cliToolId === 'opencode' ? OPENCODE_PANE_HEIGHT : 100;
        const output = await captureSessionOutput(worktreeId, cliToolId, captureLines);
        const statusResult = detectSessionStatus(output, cliToolId);
        isWaitingForResponse = statusResult.status === 'waiting';
        isProcessing = statusResult.status === 'running';

        // Clean up stale pending prompts if no prompt is showing
        // NOTE: !statusResult.hasActivePrompt is logically equivalent to
        //       !promptDetection.isPrompt in the previous implementation (C-004)
        if (!statusResult.hasActivePrompt) {
          const messages = getMessages(db, worktreeId, undefined, 10, cliToolId);
          const hasPendingPrompt = messages.some(
            msg => msg.messageType === 'prompt' && msg.promptData?.status !== 'answered'
          );
          if (hasPendingPrompt) {
            markPendingPromptsAsAnswered(db, worktreeId, cliToolId);
          }
        }
      } catch {
        // If capture fails, assume processing
        isProcessing = true;
      }
    }

    sessionStatusByCli[cliToolId] = {
      isRunning,
      isWaitingForResponse,
      isProcessing,
    };

    if (isRunning) anyRunning = true;
    if (isWaitingForResponse) anyWaiting = true;
    if (isProcessing) anyProcessing = true;
  }

  return {
    sessionStatusByCli,
    isSessionRunning: anyRunning,
    isWaitingForResponse: anyWaiting,
    isProcessing: anyProcessing,
  };
}

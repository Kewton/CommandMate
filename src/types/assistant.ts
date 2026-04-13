/**
 * Type definitions for the assistant chat feature
 * Issue #649: Assistant chat with global (non-worktree) sessions
 *
 * These types define the API request/response shapes for:
 * - Starting an assistant session
 * - Sending terminal commands
 * - Retrieving current output
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * Request body for POST /api/assistant/start
 */
export interface StartAssistantRequest {
  /** CLI tool to use for the session (claude, codex, gemini, etc.) */
  cliToolId: CLIToolType;
  /** Working directory path for the session */
  workingDirectory: string;
}

/**
 * Response body for POST /api/assistant/start
 */
export interface StartAssistantResponse {
  /** Whether the session was started successfully */
  success: boolean;
  /** The tmux session name that was created */
  sessionName: string;
}

/**
 * Request body for POST /api/assistant/terminal
 */
export interface AssistantTerminalRequest {
  /** CLI tool ID for the active session */
  cliToolId: CLIToolType;
  /** Command/message to send to the session */
  command: string;
}

/**
 * Response body for GET /api/assistant/current-output
 */
export interface AssistantCurrentOutputResponse {
  /** Captured terminal output */
  output: string;
  /** Whether the session is still active */
  sessionActive: boolean;
}

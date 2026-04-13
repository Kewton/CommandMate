/**
 * Assistant API client
 * Issue #649: Client-side API calls for assistant chat feature
 *
 * Provides a typed interface for interacting with /api/assistant/* endpoints.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type {
  StartAssistantResponse,
  AssistantCurrentOutputResponse,
} from '@/types/assistant';

/**
 * Assistant API client object.
 * All methods throw on network errors; callers should handle errors appropriately.
 */
export const assistantApi = {
  /**
   * Start a new assistant session.
   *
   * @param cliToolId - CLI tool to use
   * @param workingDirectory - Working directory path
   * @returns StartAssistantResponse
   */
  async startSession(
    cliToolId: CLIToolType,
    workingDirectory: string,
  ): Promise<StartAssistantResponse> {
    const res = await fetch('/api/assistant/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId, workingDirectory }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to start session (${res.status})`);
    }

    return res.json();
  },

  /**
   * Send a command/message to the assistant session.
   *
   * @param cliToolId - CLI tool ID for the active session
   * @param command - Command text to send
   */
  async sendCommand(
    cliToolId: CLIToolType,
    command: string,
  ): Promise<void> {
    const res = await fetch('/api/assistant/terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId, command }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to send command (${res.status})`);
    }
  },

  /**
   * Get current terminal output from the assistant session.
   *
   * @param cliToolId - CLI tool ID for the active session
   * @returns AssistantCurrentOutputResponse
   */
  async getCurrentOutput(
    cliToolId: CLIToolType,
  ): Promise<AssistantCurrentOutputResponse> {
    const res = await fetch(
      `/api/assistant/current-output?cliToolId=${encodeURIComponent(cliToolId)}`,
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to get output (${res.status})`);
    }

    return res.json();
  },

  /**
   * Stop the assistant session.
   *
   * @param cliToolId - CLI tool ID for the session to stop
   * @returns Object with success and killed fields
   */
  async stopSession(
    cliToolId: CLIToolType,
  ): Promise<{ success: boolean; killed: boolean }> {
    const res = await fetch(
      `/api/assistant/session?cliToolId=${encodeURIComponent(cliToolId)}`,
      { method: 'DELETE' },
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to stop session (${res.status})`);
    }

    return res.json();
  },
};

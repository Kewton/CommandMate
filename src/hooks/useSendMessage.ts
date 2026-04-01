/**
 * useSendMessage - Hook for sending messages to terminal API with chat-db persistence.
 *
 * Issue #600: UX refresh - shared send logic [DR1-001]
 * Responsibility: terminal API call + chat-db persistence only.
 * No UI state management (caller handles that).
 */

'use client';

import { useState, useCallback } from 'react';

/**
 * Options for the useSendMessage hook.
 */
export interface UseSendMessageOptions {
  /** Worktree ID */
  worktreeId: string;
  /** CLI tool identifier */
  cliToolId: string;
  /** Callback on successful send */
  onSuccess?: () => void;
  /** Callback on error */
  onError?: (error: Error) => void;
}

/**
 * Return value of useSendMessage hook.
 */
export interface UseSendMessageReturn {
  /** Send a message */
  send: (message: string) => Promise<void>;
  /** Whether a send is currently in progress */
  isSending: boolean;
  /** Last error, if any */
  error: Error | null;
}

/**
 * Hook that provides message sending functionality.
 *
 * Sends the message to the terminal API and persists it to chat-db.
 * Provides onSuccess/onError callbacks for the caller to handle UI updates.
 *
 * @param options - Configuration options
 * @returns Send function, loading state, and error state
 */
export function useSendMessage(options: UseSendMessageOptions): UseSendMessageReturn {
  const { worktreeId, cliToolId, onSuccess, onError } = options;
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const send = useCallback(async (message: string) => {
    if (isSending) return;

    setIsSending(true);
    setError(null);

    try {
      // Send to terminal API
      const terminalResponse = await fetch(`/api/worktrees/${worktreeId}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: message, cliToolId }),
      });

      if (!terminalResponse.ok) {
        throw new Error(`Terminal API error: ${terminalResponse.status}`);
      }

      // Persist to chat-db
      const chatResponse = await fetch(`/api/worktrees/${worktreeId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'user',
          content: message,
          cliToolId,
        }),
      });

      if (!chatResponse.ok) {
        throw new Error(`Chat DB error: ${chatResponse.status}`);
      }

      onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      onError?.(error);
    } finally {
      setIsSending(false);
    }
  }, [worktreeId, cliToolId, isSending, onSuccess, onError]);

  return { send, isSending, error };
}

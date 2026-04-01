/**
 * SimpleMessageInput Component
 *
 * Issue #600: UX refresh - Lightweight message input for Review screen.
 * Uses useSendMessage() for shared send logic [DR1-001].
 *
 * Security [DR4-004]: No dangerouslySetInnerHTML.
 * Input is plain text only. React default escaping handles XSS prevention.
 * Command length is validated by the terminal API (MAX_COMMAND_LENGTH = 10000).
 */

'use client';

import React, { useState, useCallback } from 'react';
import { useSendMessage } from '@/hooks/useSendMessage';

export interface SimpleMessageInputProps {
  /** Worktree ID to send message to */
  worktreeId: string;
  /** CLI tool identifier */
  cliToolId: string;
}

/**
 * Lightweight text input + send button for inline replies.
 * onSuccess clears the input text; no other side effects.
 */
export function SimpleMessageInput({ worktreeId, cliToolId }: SimpleMessageInputProps) {
  const [text, setText] = useState('');

  const onSuccess = useCallback(() => {
    setText('');
  }, []);

  const { send, isSending } = useSendMessage({
    worktreeId,
    cliToolId,
    onSuccess,
  });

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    send(trimmed);
  }, [text, send]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Send a message..."
        disabled={isSending}
        className="flex-1 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-cyan-500 focus:border-transparent disabled:opacity-50"
      />
      <button
        onClick={handleSend}
        disabled={isSending || !text.trim()}
        aria-label="Send"
        className="px-3 py-1.5 text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isSending ? 'Sending...' : 'Send'}
      </button>
    </div>
  );
}

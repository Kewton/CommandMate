/**
 * MessageInput Component
 * Input form for sending messages to Claude
 */

'use client';

import React, { useState, FormEvent } from 'react';
import { Button } from '@/components/ui';
import { worktreeApi, handleApiError } from '@/lib/api-client';

export interface MessageInputProps {
  worktreeId: string;
  onMessageSent?: () => void;
}

/**
 * Message input component
 *
 * @example
 * ```tsx
 * <MessageInput worktreeId="main" onMessageSent={handleRefresh} />
 * ```
 */
export function MessageInput({ worktreeId, onMessageSent }: MessageInputProps) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Handle message submission
   */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!message.trim() || sending) {
      return;
    }

    try {
      setSending(true);
      setError(null);
      await worktreeApi.sendMessage(worktreeId, message.trim());
      setMessage('');
      onMessageSent?.();
    } catch (err) {
      setError(handleApiError(err));
    } finally {
      setSending(false);
    }
  };

  /**
   * Handle keyboard shortcuts
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Submit on Enter
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  return (
    <div className="space-y-2">
      {error && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex items-center gap-2 bg-white border border-gray-300 rounded-lg px-4 py-2 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message..."
          disabled={sending}
          className="flex-1 outline-none bg-transparent"
        />
        <button
          type="submit"
          disabled={!message.trim() || sending}
          className="flex-shrink-0 p-2 text-blue-600 hover:bg-blue-50 rounded-full transition-colors disabled:text-gray-300 disabled:hover:bg-transparent"
        >
          {sending ? (
            <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          )}
        </button>
      </form>
    </div>
  );
}

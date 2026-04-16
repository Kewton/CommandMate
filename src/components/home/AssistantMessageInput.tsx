/**
 * AssistantMessageInput Component
 * Issue #649: Simplified message input for the assistant chat panel.
 *
 * Unlike the main MessageInput, this component:
 * - Has no slash command support
 * - Has no image attachment
 * - Has no draft persistence
 * - Only supports simple text input + send
 *
 * Supports IME composing guard and dark mode.
 */

'use client';

import React, { memo, useState, useCallback, useRef, useEffect } from 'react';

export interface AssistantMessageInputProps {
  /** Called when the user sends a message */
  onSend: (message: string) => Promise<void>;
  /** Whether the input should be disabled */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
}

export const AssistantMessageInput = memo(function AssistantMessageInput({
  onSend,
  disabled = false,
  placeholder = 'Type your message...',
}: AssistantMessageInputProps) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const compositionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const justFinishedComposingRef = useRef(false);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      if (!message) {
        textarea.style.height = '24px';
      } else {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
      }
    }
  }, [message]);

  const submitMessage = useCallback(async () => {
    if (isComposing || !message.trim() || sending || disabled) {
      return;
    }

    try {
      setSending(true);
      await onSend(message.trim());
      setMessage('');
    } catch {
      // Error handling is delegated to the parent component
    } finally {
      setSending(false);
    }
  }, [isComposing, message, sending, disabled, onSend]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      await submitMessage();
    },
    [submitMessage],
  );

  const handleCompositionStart = useCallback(() => {
    setIsComposing(true);
    justFinishedComposingRef.current = false;
    if (compositionTimeoutRef.current) {
      clearTimeout(compositionTimeoutRef.current);
    }
  }, []);

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
    justFinishedComposingRef.current = true;
    if (compositionTimeoutRef.current) {
      clearTimeout(compositionTimeoutRef.current);
    }
    compositionTimeoutRef.current = setTimeout(() => {
      justFinishedComposingRef.current = false;
    }, 300);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME composition check via keyCode
      const { keyCode } = e.nativeEvent;
      if (keyCode === 229) {
        return;
      }

      // Ignore Enter right after composition end
      if (justFinishedComposingRef.current && e.key === 'Enter') {
        justFinishedComposingRef.current = false;
        return;
      }

      // Enter submits, Shift+Enter inserts newline
      if (e.key === 'Enter' && !isComposing && !e.shiftKey) {
        e.preventDefault();
        void submitMessage();
      }
    },
    [isComposing, submitMessage],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="flex shrink-0 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 focus-within:border-cyan-500 focus-within:ring-1 focus-within:ring-cyan-500 dark:border-gray-600 dark:bg-gray-800"
      data-testid="assistant-message-input"
    >
      <textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder={placeholder}
        disabled={sending || disabled}
        rows={1}
        className="flex-1 outline-none bg-transparent resize-none overflow-y-auto scrollbar-thin text-sm"
        style={{
          minHeight: '24px',
          maxHeight: '120px',
          paddingTop: '4px',
          paddingBottom: '4px',
          lineHeight: '18px',
        }}
        data-testid="assistant-message-textarea"
      />

      <button
        type="submit"
        disabled={!message.trim() || sending || disabled}
        className="flex-shrink-0 p-1.5 text-cyan-600 hover:bg-cyan-50 dark:text-cyan-400 dark:hover:bg-cyan-900/30 rounded-full transition-colors disabled:text-gray-300 dark:disabled:text-gray-600 disabled:hover:bg-transparent"
        aria-label="Send message"
        data-testid="assistant-send-button"
      >
        {sending ? (
          <svg
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
        )}
      </button>
    </form>
  );
});

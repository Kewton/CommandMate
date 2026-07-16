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
import { useTranslations } from 'next-intl';
import { Button, Spinner } from '@/components/ui';

export interface AssistantMessageInputProps {
  /** Called when the user sends a message */
  onSend: (message: string) => Promise<void>;
  /** Whether the input should be disabled */
  disabled?: boolean;
  /** Placeholder text. Falls back to the translated default when omitted — a
   * default parameter cannot call t(), which would pin it to English. */
  placeholder?: string;
}

export const AssistantMessageInput = memo(function AssistantMessageInput({
  onSend,
  disabled = false,
  placeholder,
}: AssistantMessageInputProps) {
  const t = useTranslations('home');
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
      className="flex shrink-0 items-center gap-2 rounded-lg border border-input bg-surface dark:bg-surface-2 px-3 py-1.5 focus-within:border-accent-500 focus-within:ring-1 focus-within:ring-accent-500"
      data-testid="assistant-message-input"
    >
      <textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder={placeholder ?? t('assistant.input.defaultPlaceholder')}
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

      <Button
        type="submit"
        variant="ghost"
        disabled={!message.trim() || sending || disabled}
        className="flex-shrink-0 rounded-full p-1.5 text-accent-600 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-900/30 disabled:text-muted-foreground disabled:hover:bg-transparent"
        aria-label={t('assistant.input.send')}
        data-testid="assistant-send-button"
      >
        {sending ? (
          <Spinner size="sm" />
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
      </Button>
    </form>
  );
});

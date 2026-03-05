/**
 * MessageInput Component
 * Input form for sending messages to Claude
 */

'use client';

import React, { memo, useState, useCallback, FormEvent, useRef, useEffect } from 'react';
import { worktreeApi, handleApiError } from '@/lib/api-client';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { SlashCommandSelector } from './SlashCommandSelector';
import { InterruptButton } from './InterruptButton';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useIsMobile } from '@/hooks/useIsMobile';
import type { SlashCommand } from '@/types/slash-commands';

export interface MessageInputProps {
  worktreeId: string;
  onMessageSent?: (cliToolId: CLIToolType) => void;
  cliToolId?: CLIToolType;
  isSessionRunning?: boolean;
}

/**
 * Message input component
 *
 * @example
 * ```tsx
 * <MessageInput worktreeId="main" onMessageSent={handleRefresh} cliToolId="claude" />
 * ```
 */
export const MessageInput = memo(function MessageInput({ worktreeId, onMessageSent, cliToolId, isSessionRunning = false }: MessageInputProps) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [showCommandSelector, setShowCommandSelector] = useState(false);
  const [isFreeInputMode, setIsFreeInputMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const compositionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const justFinishedComposingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Hooks for slash command functionality
  // Issue #4: Pass cliToolId to filter commands by CLI tool
  const isMobile = useIsMobile();
  const { groups } = useSlashCommands(worktreeId, cliToolId);

  /**
   * Auto-resize textarea based on content
   */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      if (!message) {
        textarea.style.height = '24px';
      } else {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
      }
    }
  }, [message]);

  /**
   * Handle message submission
   */
  const submitMessage = useCallback(async () => {
    if (isComposing || !message.trim() || sending) {
      return;
    }

    try {
      setSending(true);
      setError(null);
      const effectiveCliTool: CLIToolType = cliToolId || 'claude';
      await worktreeApi.sendMessage(worktreeId, message.trim(), effectiveCliTool);
      setMessage('');
      setIsFreeInputMode(false);
      onMessageSent?.(effectiveCliTool);
    } catch (err) {
      setError(handleApiError(err));
    } finally {
      setSending(false);
    }
  }, [isComposing, message, sending, worktreeId, cliToolId, onMessageSent]);

  const handleSubmit = useCallback(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await submitMessage();
  }, [submitMessage]);

  /**
   * Handle composition start (IME starts)
   */
  const handleCompositionStart = useCallback(() => {
    setIsComposing(true);
    justFinishedComposingRef.current = false;

    // Clear any existing timeout
    if (compositionTimeoutRef.current) {
      clearTimeout(compositionTimeoutRef.current);
    }
  }, []);

  /**
   * Handle composition end (IME finishes)
   */
  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
    justFinishedComposingRef.current = true;

    // Clear the flag after a longer delay to catch the Enter key event
    // that might follow immediately after composition end
    if (compositionTimeoutRef.current) {
      clearTimeout(compositionTimeoutRef.current);
    }
    compositionTimeoutRef.current = setTimeout(() => {
      justFinishedComposingRef.current = false;
    }, 300);
  }, []);

  /**
   * Handle slash command selection
   */
  const handleCommandSelect = useCallback((command: SlashCommand) => {
    setMessage(`/${command.name} `);
    setShowCommandSelector(false);
    textareaRef.current?.focus();
  }, []);

  /**
   * Handle slash command selector cancel
   */
  const handleCommandCancel = useCallback(() => {
    setShowCommandSelector(false);
    setIsFreeInputMode(false);
    textareaRef.current?.focus();
  }, []);

  /**
   * Handle free input mode (Issue #56, #288)
   * Closes selector and carries over filter text as the custom command prefix
   *
   * Empty dependency array rationale (R1-001):
   * - setState functions (setShowCommandSelector, setIsFreeInputMode, setMessage)
   *   are stable across renders (React guarantee).
   * - textareaRef is a React ref (stable reference, never reassigned).
   * - filterText is received as a callback argument, not captured from closure.
   */
  const handleFreeInput = useCallback((filterText: string) => {
    setShowCommandSelector(false);
    setIsFreeInputMode(true);
    setMessage(filterText ? `/${filterText}` : '/');
    // Focus textarea with a small delay to ensure selector is closed
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
  }, []);

  /**
   * Handle message input change
   */
  const handleMessageChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setMessage(newValue);

    // Free input mode reset: when message is fully cleared
    if (newValue === '') {
      setIsFreeInputMode(false);
      setShowCommandSelector(false);
      return;
    }

    // Skip selector display logic during free input mode
    // NOTE: setShowCommandSelector(false) is not needed here.
    // handleFreeInput() already executed setShowCommandSelector(false),
    // and there is no path through handleMessageChange that sets showCommandSelector to true
    // when isFreeInputMode is true (this early return prevents it).
    // Mobile command button bypass path is guarded separately (Stage 2 SF-001).
    // (Stage 1 SF-002: Considered defensive setShowCommandSelector(false) here,
    //  but path analysis shows no reachable case, so omitted per KISS principle)
    if (isFreeInputMode) {
      return;
    }

    // Show command selector when '/' is typed at the start
    if (newValue === '/' || (newValue.startsWith('/') && !newValue.includes(' '))) {
      setShowCommandSelector(true);
    } else {
      setShowCommandSelector(false);
    }
  }, [isFreeInputMode]);

  /**
   * Handle keyboard shortcuts
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Check for IME composition using keyCode
    // keyCode 229 indicates IME composition in progress
    const { keyCode } = e.nativeEvent;
    if (keyCode === 229) {
      return;
    }

    // Close command selector on Escape
    if (e.key === 'Escape' && showCommandSelector) {
      e.preventDefault();
      handleCommandCancel();
      return;
    }

    // If we just finished composing, ignore the next Enter key
    if (justFinishedComposingRef.current && e.key === 'Enter') {
      justFinishedComposingRef.current = false;
      return;
    }

    // Submit on Enter (but not when Shift is pressed or composing with IME)
    // Shift+Enter allows line breaks
    // Don't submit when command selector is open (unless in free input mode - Issue #288)
    if (e.key === 'Enter' && !isComposing && (!showCommandSelector || isFreeInputMode)) {
      if (isMobile) {
        // Mobile: Enter inserts newline (default behavior)
        return;
      }
      // Desktop: Enter submits, Shift+Enter inserts newline
      if (!e.shiftKey) {
        e.preventDefault();
        void submitMessage();
      }
    }
  }, [showCommandSelector, isFreeInputMode, isComposing, isMobile, submitMessage, handleCommandCancel]);

  return (
    <div ref={containerRef} className="space-y-2 relative">
      {error && (
        <div className="p-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex items-center gap-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-2 focus-within:border-cyan-500 focus-within:ring-1 focus-within:ring-cyan-500">
        {/* Mobile: Slash command button */}
        {isMobile && (
          <button
            type="button"
            onClick={() => {
              if (isFreeInputMode) {
                setIsFreeInputMode(false);
              }
              setShowCommandSelector(true);
            }}
            className="flex-shrink-0 p-2 text-gray-500 hover:text-cyan-600 hover:bg-cyan-50 dark:text-gray-400 dark:hover:text-cyan-400 dark:hover:bg-cyan-900/30 rounded-full transition-colors"
            aria-label="Show slash commands"
            data-testid="mobile-command-button"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
            </svg>
          </button>
        )}

        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleMessageChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          placeholder={isMobile ? "Type your message..." : "Type your message... (/ for commands, Shift+Enter for line break)"}
          disabled={sending}
          rows={1}
          className="flex-1 outline-none bg-transparent resize-none overflow-y-auto scrollbar-thin"
          style={{ minHeight: '36px', maxHeight: '160px', paddingTop: '8px', paddingBottom: '8px', lineHeight: '20px' }}
        />

        {/* Interrupt Button - visible when session is running */}
        <InterruptButton
          worktreeId={worktreeId}
          cliToolId={cliToolId || 'claude'}
          disabled={!isSessionRunning}
        />

        <button
          type="submit"
          disabled={!message.trim() || sending}
          className="flex-shrink-0 p-2 text-cyan-600 hover:bg-cyan-50 dark:text-cyan-400 dark:hover:bg-cyan-900/30 rounded-full transition-colors disabled:text-gray-300 dark:disabled:text-gray-600 disabled:hover:bg-transparent"
          aria-label="Send message"
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

      {/* Slash Command Selector */}
      <SlashCommandSelector
        isOpen={showCommandSelector}
        groups={groups}
        onSelect={handleCommandSelect}
        onClose={handleCommandCancel}
        isMobile={isMobile}
        onFreeInput={handleFreeInput}
      />
    </div>
  );
});

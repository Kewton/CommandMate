/**
 * MessageInput Component
 * Input form for sending messages to Claude
 */

'use client';

import React, { memo, useState, useCallback, FormEvent, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { worktreeApi, handleApiError } from '@/lib/api-client';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { Kbd } from '@/components/ui/Kbd';
import { Button, Spinner } from '@/components/ui';
import { SlashCommandSelector } from './SlashCommandSelector';
import { InterruptButton } from './InterruptButton';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useImageAttachment } from '@/hooks/useImageAttachment';
import type { SlashCommand } from '@/types/slash-commands';
import { getSlashCommandTrigger } from '@/lib/slash-command-format';
import type { ShowToast } from '@/types/markdown-editor';

export interface MessageInputProps {
  worktreeId: string;
  onMessageSent?: (cliToolId: CLIToolType) => void;
  cliToolId?: CLIToolType;
  /**
   * Issue #869: agent instance id to send to. Defaults to the primary instance
   * (`=== cliToolId`) when omitted, preserving pre-#869 single-session behavior.
   */
  instanceId?: string;
  isSessionRunning?: boolean;
  /** Issue #485: Text to insert into message input from history or memo */
  pendingInsertText?: string | null;
  /** Issue #485: Callback to signal that pendingInsertText has been consumed */
  onInsertConsumed?: () => void;
  /**
   * Issue #728: split index used to scope the draft localStorage key.
   * Defaults to 0 for backward compatibility (mobile / single-terminal usage).
   */
  splitIndex?: number;
  /**
   * Issue #728: invoked when the textarea gains focus.
   * TerminalSplitContainer wires this to setFocusedSplitIndex so HistoryPane /
   * MemoPane insertions land in the most recently focused split.
   */
  onFocus?: () => void;
  /**
   * Issue #806: whether the target session is currently busy (processing
   * another task). When true, a successful send is queued behind the running
   * task on the CLI side rather than executed immediately, so we surface a
   * "queued (session busy)" toast to avoid the send looking like a no-op.
   * Defaults to false (idle) for backward compatibility — idle sends behave
   * exactly as before (no extra toast).
   */
  isProcessing?: boolean;
  /**
   * Issue #806: toast surface used to show the "queued (session busy)" hint.
   * Optional — when omitted (or when the session is idle) no toast is shown.
   */
  showToast?: ShowToast;
  /**
   * Issue #1080: content rendered in the composer's bottom meta row (left side),
   * typically the per-instance Auto-Yes toggle. Sits alongside the keyboard-hint
   * pills so Auto-Yes no longer occupies its own full-width row.
   */
  autoYesSlot?: React.ReactNode;
  /**
   * Issue #1121: optimistic-send hook. When provided, the composer delegates the
   * actual send to this callback (which inserts a pending bubble into the history
   * and fires the API in the background) instead of awaiting the send API itself.
   * The composer clears immediately (optimistic); send failures surface on the
   * pending bubble, not the composer's error banner. Omitted by callers without
   * an optimistic-UI history (mobile / assistant chat), which keep the legacy
   * await-then-clear behavior.
   */
  onOptimisticSend?: (
    content: string,
    options: { cliToolId: CLIToolType; instanceId?: string; imagePath?: string },
  ) => void;
}

/**
 * Message input component
 *
 * @example
 * ```tsx
 * <MessageInput worktreeId="main" onMessageSent={handleRefresh} cliToolId="claude" />
 * ```
 */
/** localStorage key prefix for draft message persistence */
const DRAFT_STORAGE_KEY_PREFIX = 'commandmate:draft-message:';

/**
 * Issue #806: shown when a message is successfully sent to a session that is
 * already busy with another task. The send itself succeeds (200) and the CLI
 * queues the message, so this clarifies it will not be processed until the
 * current task finishes.
 */
const QUEUED_BUSY_TOAST_MESSAGE =
  'Queued (session busy) — your message will run after the current task finishes.';

/**
 * Issue #728: Per-(worktree, split) draft key. Falls back to the legacy
 * worktree-only key path during migration (see migrateLegacyDraftKey).
 */
function getDraftKey(worktreeId: string, splitIndex: number): string {
  return `${DRAFT_STORAGE_KEY_PREFIX}${worktreeId}:${splitIndex}`;
}

/**
 * Issue #728: Best-effort migration of the legacy draft key.
 * If `commandmate:draft-message:${worktreeId}` exists and the new
 * `${...}:0` key is empty, copy the value over and delete the legacy entry.
 * Safe to call repeatedly (no-op when legacy key absent).
 */
function migrateLegacyDraftKey(worktreeId: string): void {
  try {
    const legacyKey = `${DRAFT_STORAGE_KEY_PREFIX}${worktreeId}`;
    const legacyValue = window.localStorage.getItem(legacyKey);
    if (legacyValue === null) return;
    const newKey = getDraftKey(worktreeId, 0);
    if (window.localStorage.getItem(newKey) === null) {
      window.localStorage.setItem(newKey, legacyValue);
    }
    window.localStorage.removeItem(legacyKey);
  } catch {
    /* localStorage unavailable; migration is best-effort */
  }
}

export const MessageInput = memo(function MessageInput({ worktreeId, onMessageSent, cliToolId, instanceId, isSessionRunning = false, pendingInsertText, onInsertConsumed, splitIndex = 0, onFocus, isProcessing = false, showToast, autoYesSlot, onOptimisticSend }: MessageInputProps) {
  const t = useTranslations('worktree');
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
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hooks for slash command functionality
  // Issue #4: Pass cliToolId to filter commands by CLI tool
  const isMobile = useIsMobile();
  const { groups, isCatalogStale } = useSlashCommands(worktreeId, cliToolId);

  // Issue #1166: the composer no longer lifts itself with a translateY hack.
  // The mobile shell (WorktreeDetailRefactored) now sizes its container to
  // visualViewport.height and places this composer in normal flow at the bottom,
  // so it docks above the software keyboard without any transform. This keeps
  // the composer a plain in-flow element on every surface (mobile / PC / chat).

  // Issue #474: Image attachment hook
  const uploadFn = useCallback(
    (wId: string, file: File) => worktreeApi.uploadImageFile(wId, file),
    []
  );
  const {
    attachedImage,
    fileInputRef,
    isUploading,
    error: imageError,
    acceptAttribute,
    openFileDialog,
    handleFileSelect,
    removeAttachment,
    resetAfterSend,
  } = useImageAttachment(worktreeId, uploadFn);

  // Restore draft message from localStorage on mount or (worktreeId, splitIndex) change.
  // Issue #728: also runs the legacy-key migration for splitIndex=0.
  useEffect(() => {
    try {
      if (splitIndex === 0) {
        migrateLegacyDraftKey(worktreeId);
      }
      const saved = window.localStorage.getItem(getDraftKey(worktreeId, splitIndex));
      if (saved) {
        setMessage(saved);
      } else {
        setMessage('');
      }
    } catch { /* localStorage unavailable */ }
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [worktreeId, splitIndex]);

  // Debounced save of draft message to localStorage (per-split key, Issue #728)
  useEffect(() => {
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      try {
        const key = getDraftKey(worktreeId, splitIndex);
        if (message) {
          window.localStorage.setItem(key, message);
        } else {
          window.localStorage.removeItem(key);
        }
      } catch { /* localStorage unavailable */ }
    }, 500);
  }, [message, worktreeId, splitIndex]);

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
   * Issue #485: Insert pending text into message input
   */
  useEffect(() => {
    if (!pendingInsertText) return;
    setMessage((prev) => {
      if (prev.trim() === '') return pendingInsertText;
      return prev + '\n\n' + pendingInsertText;
    });
    onInsertConsumed?.();
  }, [pendingInsertText, onInsertConsumed]);

  /**
   * Handle message submission
   */
  const submitMessage = useCallback(async () => {
    if (isComposing || (!message.trim() && !attachedImage) || sending) {
      return;
    }

    const trimmed = message.trim();
    const effectiveCliTool: CLIToolType = cliToolId || 'claude';
    const options: { cliToolId: CLIToolType; instanceId?: string; imagePath?: string } = { cliToolId: effectiveCliTool };
    // Issue #869: route to the specific instance when it differs from the primary.
    if (instanceId && instanceId !== effectiveCliTool) {
      options.instanceId = instanceId;
    }
    if (attachedImage) {
      options.imagePath = attachedImage.path;
    }

    // Issue #1121: optimistic path. Hand the send to the history layer (which
    // shows a pending bubble and fires the API in the background) and clear the
    // composer immediately rather than blocking on the API. Send failures surface
    // on the pending bubble, so the composer never sets its own error/sending
    // state here.
    if (onOptimisticSend) {
      setError(null);
      onOptimisticSend(trimmed, options);
      setMessage('');
      setIsFreeInputMode(false);
      resetAfterSend();
      try { window.localStorage.removeItem(getDraftKey(worktreeId, splitIndex)); } catch { /* ignore */ }
      if (isProcessing) {
        showToast?.(QUEUED_BUSY_TOAST_MESSAGE, 'warning');
      }
      onMessageSent?.(effectiveCliTool);
      return;
    }

    try {
      setSending(true);
      setError(null);
      await worktreeApi.sendMessage(worktreeId, trimmed, options);
      setMessage('');
      setIsFreeInputMode(false);
      resetAfterSend();
      try { window.localStorage.removeItem(getDraftKey(worktreeId, splitIndex)); } catch { /* ignore */ }
      // Issue #806: when the session is busy, the CLI queues this message behind
      // the running task. Surface a toast so the (successful) send doesn't look
      // like a no-op. Idle sessions are unchanged (no toast).
      if (isProcessing) {
        showToast?.(QUEUED_BUSY_TOAST_MESSAGE, 'warning');
      }
      onMessageSent?.(effectiveCliTool);
    } catch (err) {
      setError(handleApiError(err));
    } finally {
      setSending(false);
    }
  }, [isComposing, message, attachedImage, sending, worktreeId, cliToolId, instanceId, onMessageSent, resetAfterSend, splitIndex, isProcessing, showToast, onOptimisticSend]);

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
    setMessage(`${getSlashCommandTrigger(command)} `);
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

    // Show command selector when a trigger character is typed at the start.
    // Issue #799: Codex skills are surfaced via the `$NAME` trigger (introduced
    // in #790), so on the Codex tab the selector also opens on a leading '$'.
    // Other CLI tools (Claude/Copilot/Gemini) treat '$' as a normal character
    // to avoid false triggers.
    const isSlashTrigger =
      newValue === '/' || (newValue.startsWith('/') && !newValue.includes(' '));
    const isDollarTrigger =
      cliToolId === 'codex' &&
      (newValue === '$' || (newValue.startsWith('$') && !newValue.includes(' ')));
    if (isSlashTrigger || isDollarTrigger) {
      setShowCommandSelector(true);
    } else {
      setShowCommandSelector(false);
    }
  }, [isFreeInputMode, cliToolId]);

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
    <div
      ref={containerRef}
      className="space-y-2 relative"
      data-testid="message-input-container"
    >
      {/* Error display (send error or image error) */}
      {(error || imageError) && (
        <div className="p-2 bg-danger-subtle border border-danger-border rounded text-sm text-danger-foreground">
          {error || imageError}
        </div>
      )}

      {/* Issue #474: Image attachment preview */}
      {attachedImage && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-accent-50 dark:bg-accent-900/20 border border-accent-200 dark:border-accent-800 rounded-lg text-sm" data-testid="image-attachment-preview">
          <svg className="h-4 w-4 flex-shrink-0 text-accent-600 dark:text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className="truncate text-accent-800 dark:text-accent-300">{attachedImage.file.name}</span>
          {/* Issue #1061: dense p-0.5 icon action in the attachment pill (hover-lift would disturb the compact pill) — 残置 */}
          <button
            type="button"
            onClick={removeAttachment}
            className="flex-shrink-0 p-0.5 text-accent-600 hover:text-danger-foreground dark:text-accent-400 rounded transition-colors"
            aria-label={t('composer.removeAttachment')}
            data-testid="remove-attachment-button"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Hidden file input for image selection */}
      <input
        ref={fileInputRef as React.RefObject<HTMLInputElement>}
        type="file"
        accept={acceptAttribute}
        onChange={handleFileSelect}
        className="hidden"
        data-testid="image-file-input"
      />

      <form onSubmit={handleSubmit} className="rounded-xl bg-surface border border-border shadow-sm px-3 py-2 focus-within:ring-2 focus-within:ring-accent-500/40 transition-shadow flex flex-col gap-1.5">
        {/* Issue #1080: input area (action buttons + textarea + send) */}
        <div className={isMobile ? 'flex flex-col gap-1' : 'flex items-center gap-2'}>
        {/* Mobile: Row 1 - action buttons (slash command, attach, interrupt) */}
        {isMobile && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                if (isFreeInputMode) {
                  setIsFreeInputMode(false);
                }
                setShowCommandSelector(true);
              }}
              className="flex-shrink-0 p-2 text-muted-foreground hover:text-accent-600 hover:bg-accent-50 dark:hover:text-accent-400 dark:hover:bg-accent-900/30 rounded-full transition-colors"
              aria-label={t('composer.showSlashCommands')}
              data-testid="mobile-command-button"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
              </svg>
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={openFileDialog}
              disabled={isUploading || sending}
              className="flex-shrink-0 p-2 text-muted-foreground hover:text-accent-600 hover:bg-accent-50 dark:hover:text-accent-400 dark:hover:bg-accent-900/30 rounded-full transition-colors disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
              aria-label={t('composer.attachImage')}
              data-testid="attach-image-button"
            >
              {isUploading ? (
                <Spinner size="md" />
              ) : (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              )}
            </Button>
            <InterruptButton
              worktreeId={worktreeId}
              cliToolId={cliToolId || 'claude'}
              instanceId={instanceId}
              disabled={!isSessionRunning}
            />
          </div>
        )}

        {/* Desktop: Image attach button (inline) */}
        {!isMobile && (
          <Button
            variant="ghost"
            type="button"
            onClick={openFileDialog}
            disabled={isUploading || sending}
            className="flex-shrink-0 p-2 text-muted-foreground hover:text-accent-600 hover:bg-accent-50 dark:hover:text-accent-400 dark:hover:bg-accent-900/30 rounded-full transition-colors disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
            aria-label={t('composer.attachImage')}
            data-testid="attach-image-button"
          >
            {isUploading ? (
              <Spinner size="md" />
            ) : (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            )}
          </Button>
        )}

        {/* Row 2 (mobile) / inline (desktop): message input + send */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <textarea
            ref={textareaRef}
            data-testid="message-input-textarea"
            value={message}
            onChange={handleMessageChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onFocus={onFocus}
            placeholder={t('composer.placeholder')}
            disabled={sending}
            rows={1}
            // Issue #1128: mobile keyboard hints — the composer's primary action
            // is to send, and it accepts free-form text.
            inputMode="text"
            enterKeyHint="send"
            className="flex-1 outline-none bg-transparent resize-none overflow-y-auto scrollbar-thin"
            style={{ minHeight: '36px', maxHeight: '160px', paddingTop: '8px', paddingBottom: '8px', lineHeight: '20px' }}
          />

          {/* Desktop: Interrupt Button */}
          {!isMobile && (
            <InterruptButton
              worktreeId={worktreeId}
              cliToolId={cliToolId || 'claude'}
              instanceId={instanceId}
              disabled={!isSessionRunning}
            />
          )}

          <Button
            variant="ghost"
            type="submit"
            data-testid="send-message-button"
            data-can-send={String((!!message.trim() || !!attachedImage) && !sending)}
            disabled={(!message.trim() && !attachedImage) || sending}
            className={`flex-shrink-0 p-2 rounded-full transition-colors disabled:hover:bg-transparent ${
              (!!message.trim() || !!attachedImage) && !sending
                ? 'bg-accent-600 text-white hover:bg-accent-700 shadow-sm'
                : 'text-muted-foreground/50'
            }`}
            aria-label={t('composer.sendMessage')}
          >
            {sending ? (
              <Spinner size="md" />
            ) : (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            )}
          </Button>
        </div>
        </div>

        {/* Issue #1080: composer meta row — Auto-Yes (left) + keyboard hints (right).
            Renders when Auto-Yes is embedded (mobile + desktop) or on desktop for
            the hint pills (mobile Enter inserts a newline, so no Shift+Enter hint). */}
        {(autoYesSlot || !isMobile) && (
          <div className="flex items-center justify-between gap-2 min-w-0" data-testid="composer-meta-row">
            <div className="flex items-center gap-2 min-w-0 overflow-x-auto scrollbar-hide">
              {autoYesSlot}
            </div>
            {!isMobile && (
              <div className="flex flex-shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground select-none">
                <Kbd>/</Kbd>
                <span>{t('composer.commandsHint')}</span>
                <span aria-hidden="true" className="opacity-50">·</span>
                <Kbd>⇧</Kbd>
                <Kbd>↵</Kbd>
                <span>{t('composer.newlineHint')}</span>
              </div>
            )}
          </div>
        )}
      </form>

      {/* Slash Command Selector */}
      <SlashCommandSelector
        isOpen={showCommandSelector}
        groups={groups}
        onSelect={handleCommandSelect}
        onClose={handleCommandCancel}
        isMobile={isMobile}
        onFreeInput={handleFreeInput}
        isCatalogStale={isCatalogStale}
      />
    </div>
  );
});

'use client';

/**
 * DirectInputBar — type straight into the agent's pane (Issue #2766).
 *
 * Every other way into a pane from this UI asks the detection layer a question
 * first: NavigationButtons needs `isSelectionListActive`, TerminalEscapeHatch
 * needs `isUnclassifiedActive`, PromptPanel needs a parsed prompt. When the
 * screen is one nobody classified and the key it wants is not on any pad, all
 * three are silent — Command Code's plan review on 2026-09-20 wanted `ctrl+a`
 * and the only way to press it was `tmux attach`.
 *
 * This bar asks nothing. It is a text field that never keeps its value: what it
 * receives it encodes with {@link encodeKeyEvent} and posts, and the pane is the
 * only place the characters end up.
 *
 * ## What it deliberately leaves to the browser
 *
 * `encodeKeyEvent` returning `null` is an ANSWER, not a failure, and the one
 * rule this component must not get wrong is that `null` is also where
 * `preventDefault()` must not be called. Cmd+C / Cmd+V / Cmd+R, the F keys and
 * every keystroke of an IME composition are `null`, so they keep doing what
 * they do in any other input: a user who cannot copy the error message out of
 * the page, or cannot type Japanese, has been handed a worse terminal than the
 * one they were stuck in.
 *
 * ## Why Esc does not close it
 *
 * Esc is a key the pane wants — it is the single most useful thing to send to a
 * stuck overlay. Binding it to "leave direct input" would make the mode unable
 * to send the key it exists for. The only way out is the button.
 *
 * ## Why the input is uncontrolled
 *
 * No `value`, no state, no re-render per keystroke. A printable key is
 * `preventDefault()`ed so it never reaches the field at all; an IME composition
 * is NOT, precisely so the field can show the candidate text being composed,
 * and `compositionend` both sends the committed string and wipes the field.
 * That is the whole of the `change` story — there is nothing to keep.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { useDirectInput } from '@/hooks/useDirectInput';
import { MAX_DIRECT_INPUT_TEXT_LENGTH, encodeKeyEvent, type DirectInputEvent } from '@/types/direct-input';

export interface DirectInputBarProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Agent instance to target; defaults to the primary instance when omitted. */
  instanceId?: string;
  /** Trigger an immediate terminal refresh once the keys have been sent. */
  onKeysSent?: () => void;
  /** Leave direct-input mode. Reached from the button only — never from Esc. */
  onClose: () => void;
}

/**
 * Split a pasted string into events the route will accept.
 *
 * Newlines become `\r` first: a terminal reads Enter as CR, and a `\n` pasted
 * into a shell or a TUI composer is a line feed that moves the cursor without
 * submitting anything.
 */
export function buildPasteEvents(text: string): DirectInputEvent[] {
  const normalized = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  const events: DirectInputEvent[] = [];
  for (let i = 0; i < normalized.length; i += MAX_DIRECT_INPUT_TEXT_LENGTH) {
    events.push({ type: 'text', text: normalized.slice(i, i + MAX_DIRECT_INPUT_TEXT_LENGTH) });
  }
  return events;
}

export function DirectInputBar({
  worktreeId,
  cliToolId,
  instanceId,
  onKeysSent,
  onClose,
}: DirectInputBarProps) {
  const t = useTranslations('worktree');
  const inputRef = useRef<HTMLInputElement>(null);
  const { send, error } = useDirectInput(worktreeId, cliToolId, instanceId, onKeysSent);

  // The mode is useless until the field has the keyboard, and the user asked
  // for it by pressing the toggle — so take focus rather than make them click
  // a second time. A later blur does NOT leave the mode (see the docblock);
  // clicking back in resumes.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const event = encodeKeyEvent(e.nativeEvent);
      // `null` = the browser's key, not ours. No preventDefault, no send.
      if (event === null) return;
      e.preventDefault();
      send([event]);
    },
    [send],
  );

  const handleCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLInputElement>) => {
      const text = e.data;
      if (text) send([{ type: 'text', text }]);
      // Unconditional: the field's contract is that it is empty between
      // compositions, and a composition cancelled with no data still leaves the
      // candidate glyphs behind on some IMEs.
      if (inputRef.current) inputRef.current.value = '';
    },
    [send],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text');
      if (!text) return;
      send(buildPasteEvents(text));
    },
    [send],
  );

  return (
    <div
      data-testid="direct-input-bar"
      role="region"
      aria-label={t('directInput.toggleAria')}
      className="flex flex-wrap items-center gap-2 px-2 py-1.5 bg-info-subtle border border-info-border rounded-lg"
    >
      <span className="text-xs font-medium text-info-foreground shrink-0">
        {t('directInput.notice')}
      </span>
      <input
        ref={inputRef}
        type="text"
        data-testid="direct-input-capture"
        placeholder={t('directInput.placeholder')}
        aria-label={t('directInput.placeholder')}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onKeyDown={handleKeyDown}
        onCompositionEnd={handleCompositionEnd}
        onPaste={handlePaste}
        className="flex-1 min-w-[8rem] min-h-[32px] px-2 rounded-md font-mono text-xs bg-surface border border-info-border text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <button
        type="button"
        data-testid="direct-input-close"
        onClick={onClose}
        aria-label={t('directInput.close')}
        className="min-h-[32px] px-3 rounded-md text-xs font-medium bg-surface border border-info-border text-info-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background shrink-0"
      >
        {t('directInput.close')}
      </button>
      {error ? (
        <p role="alert" data-testid="direct-input-error" className="w-full text-xs text-danger-foreground">
          {t(error)}
        </p>
      ) : null}
    </div>
  );
}

export default DirectInputBar;

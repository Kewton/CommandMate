'use client';

/**
 * The reply that is still being written, as the last bubble in the column
 * (Issue #2233).
 *
 * ## What moved, and why it had to
 *
 * Issue #2199 put the in-flight body in a footer strip below the transcript:
 * `.assistant-md`, `text-xs`, a `rounded-lg` box the full width of the pane,
 * self-scrolling inside `max-h-[7.5rem]`. The settled row that replaced it a
 * second later is `.chat-md`, `text-sm`, `rounded-2xl`, capped at
 * {@link CHAT_BUBBLE_MAX_WIDTH_ASSISTANT} and never clamped. So the reader
 * watched a paragraph grow in one place, in one typeface, and then watched it
 * vanish and reappear somewhere else in another. This component is the same
 * bubble the settled row wears — literally the same constants and the same
 * Markdown renderer — so the swap changes nothing on screen except that the
 * spinner stops.
 *
 * ## The spinner is UNDER the body, not over it
 *
 * Above the body, the status line's disappearance at settle-time pulls the
 * whole reply up by one line — the exact jump this Issue exists to remove.
 * Under it, the body's first line never moves.
 *
 * ## Where this is mounted (and where it must never be)
 *
 * `ChatTranscript` renders it INSIDE the scroll container and OUTSIDE the
 * virtualizer. Both halves are load-bearing:
 *
 *  - inside the scroll container, because a footer sibling is a different place
 *    on the screen and the settled row is what the reader ends up looking at;
 *  - outside the virtual list, because `@tanstack/react-virtual` unmounts every
 *    row beyond the visible window — a "generating" row at index `n-1` is gone
 *    the moment the reader scrolls up, which is Issue #2194's original reason
 *    for the footer and is still true.
 *
 * The consequence Issue #2233 accepts deliberately: scrolling up moves this
 * bubble off screen (it is in the flow, not fixed to the viewport). The reader
 * is not left guessing — `ChatSurface`'s jump-to-latest chip carries the
 * spinner while a turn is live, so "still running, and it is below you" is on
 * screen the whole time.
 *
 * ## Theme
 *
 * Semantic tokens only. The only dark thing this can produce is a fenced code
 * block, which is `.chat-md pre`'s documented exception (docs/design-system.md).
 */

import React, { memo } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import {
  CHAT_BUBBLE_ASSISTANT_CLASS,
  CHAT_BUBBLE_MARKDOWN_BODY_CLASS,
  CHAT_BUBBLE_ROW_CLASS,
  ChatMarkdownBody,
} from './ChatMessageBubble';

/** The testid the transcript's live bubble publishes. */
export const CHAT_LIVE_TURN_TESTID = 'chat-live-turn';

export interface ChatLiveTurnBubbleProps {
  /**
   * The `requestId` the settled row will carry — the join key `ChatSurface`
   * swaps on. Absent for a tool that publishes no progress at all.
   */
  turnKey?: string;
  /** The progress frame counter behind `body`. Published for the #2199 guard. */
  version?: number;
  /** The reply so far. Empty / absent renders the indicator alone. */
  body?: string;
  /** True when `body` does not start at the beginning of the turn (#2199). */
  partial?: boolean;
  /** The CLI is painting a thinking indicator rather than a plain "generating". */
  isThinking?: boolean;
  /**
   * Whether to draw the "Assistant" header, answered by
   * `shouldShowLiveRoleHeader` from the row above — the same predicate the
   * settled row is about to be asked, so the header does not blink at settle.
   */
  showHeader?: boolean;
  /** Same linkifier the settled row is given, so a path does not restyle at settle. */
  onFilePathClick: (path: string) => void;
}

export const ChatLiveTurnBubble = memo(function ChatLiveTurnBubble({
  turnKey,
  version,
  body,
  partial = false,
  isThinking = false,
  showHeader = false,
  onFilePathClick,
}: ChatLiveTurnBubbleProps) {
  const t = useTranslations('worktree');
  const hasBody = typeof body === 'string' && body.length > 0;

  return (
    <div
      data-testid={CHAT_LIVE_TURN_TESTID}
      data-role="assistant"
      data-turn-key={turnKey}
      data-version={version === undefined ? undefined : String(version)}
      data-has-body={hasBody ? 'true' : 'false'}
      role="group"
      aria-label={t('chatSurface.progressLabel')}
      className={CHAT_BUBBLE_ROW_CLASS}
    >
      {showHeader && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span className="font-medium">{t('conversation.assistant')}</span>
        </div>
      )}

      <div className={CHAT_BUBBLE_ASSISTANT_CLASS}>
        {hasBody && (
          <div
            data-testid="chat-live-turn-body"
            data-markdown="true"
            className={CHAT_BUBBLE_MARKDOWN_BODY_CLASS}
          >
            <ChatMarkdownBody content={body as string} onFilePathClick={onFilePathClick} />
          </div>
        )}

        {/* Under the body on purpose — see the file header. `role="status"`
            keeps the sentence announced without the body being re-read on every
            frame, which is what an `aria-live` region around the prose would do. */}
        <div
          data-testid="chat-live-turn-indicator"
          role="status"
          aria-live="polite"
          className={[
            'flex flex-wrap items-center gap-2 text-xs text-muted-foreground',
            hasBody ? 'mt-1.5' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          <span>{isThinking ? t('chatSurface.thinking') : t('chatSurface.generating')}</span>
          {partial && (
            <span
              data-testid="chat-live-turn-partial"
              className="rounded border border-warning-border bg-warning-subtle px-1 py-0.5 text-warning-foreground"
            >
              {t('chatSurface.progressPartial')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

export default ChatLiveTurnBubble;

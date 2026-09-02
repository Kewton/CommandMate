'use client';

/**
 * One message in the chat transcript (Issue #2232).
 *
 * ## Why this is not `ConversationPairCard`
 *
 * That component renders one TURN as one bordered card: user on top, assistant
 * underneath, both clamped to ~100 characters by default. Measured on this
 * repository's own history, an assistant body has a median length of 2,478
 * characters and 25 of 26 rows exceed the clamp — so the History card shows
 * about 4% of nearly every reply, which is right for browsing and useless for
 * reading. This renders one MESSAGE as one bubble, in full, and lets the two
 * roles sit on opposite sides so a conversation looks like one.
 *
 * Epic #2192 originally decided the chat surface would just BE `HistoryPane`;
 * #2232 withdrew that after looking at the shipped screen. The price of the
 * second implementation is that the first one does not move: `HistoryPane`,
 * `ConversationPairCard` and `lib/history-virtualization` are untouched by this
 * Issue, and the Markdown styling here is a separate `.chat-md` namespace rather
 * than a second consumer of `.assistant-md` (which History and `/chat` share).
 *
 * ## Actions are always visible
 *
 * `ConversationPairCard` hides copy / insert behind `opacity-0
 * group-hover:opacity-100` with an `[@media(hover:none)]` escape for touch. That
 * escape keeps a hover-shaped design alive on a device that has no hover; on a
 * surface people use from a phone the actions are simply rendered.
 *
 * ## Theme
 *
 * Every color is a semantic token. The one always-dark element is the fenced
 * code block (`.chat-md pre`), which is the documented exception in
 * docs/design-system.md §"常時ダーク領域" — it carries github-dark syntax
 * tokens that are unreadable on a light ground. Nothing else here may be dark.
 */

import React, { memo, useCallback, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, ArrowDownToLine, Copy, Loader2, RotateCcw, X } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage } from '@/types/models';
import { isAgentAuthoredMarkdown } from '@/types/agent-transcript';
import { getDateFnsLocale } from '@/lib/date-locale';
import { formatMessageTimestamp } from '@/lib/date-utils';
import { splitFilePathParts } from '@/lib/chat/chat-transcript-view';

// ============================================================================
// Bubble geometry
// ============================================================================

/**
 * The bubble's width cap, per role.
 *
 * Both roles are capped so the column has a visible left/right axis — a bubble
 * that fills the pane is a paragraph, and two full-width paragraphs stacked read
 * as a log no matter what color they are. The assistant's cap is looser because
 * its body is the thing being read (code blocks and tables in particular need
 * the width), while the user's is the prompt that produced it.
 *
 * Exported so the transcript's tests can assert the caps by value: removing
 * either one is the mutation Issue #2232 requires a test to catch.
 */
export const CHAT_BUBBLE_MAX_WIDTH_USER = 'max-w-[85%] sm:max-w-[75%]';
export const CHAT_BUBBLE_MAX_WIDTH_ASSISTANT = 'max-w-[92%]';

/** Side the bubble is pushed to. `ml-auto` / `mr-auto` inside a block row. */
export const CHAT_BUBBLE_ALIGN_USER = 'ml-auto';
export const CHAT_BUBBLE_ALIGN_ASSISTANT = 'mr-auto';

// ============================================================================
// Body renderers
// ============================================================================

/**
 * A verbatim body with its file paths turned into buttons.
 *
 * `whitespace-pre-wrap` is load-bearing: everything that is not agent-authored
 * Markdown is a scrape of a terminal, where the line breaks and the leading
 * spaces ARE the content.
 */
const ChatPlainBody = memo(function ChatPlainBody({
  content,
  onFilePathClick,
}: {
  content: string;
  onFilePathClick: (path: string) => void;
}) {
  const t = useTranslations('worktree');
  const parts = useMemo(() => splitFilePathParts(content), [content]);

  const handlePathClick = useCallback(
    (path: string) => () => onFilePathClick(path),
    [onFilePathClick],
  );

  return (
    <span>
      {parts.map((part, index) =>
        part.type === 'path' ? (
          <button
            key={index}
            type="button"
            onClick={handlePathClick(part.content)}
            className="cursor-pointer font-mono text-sm text-accent-700 underline-offset-2 hover:underline dark:text-accent-400"
            aria-label={t('conversation.openFile', { path: part.content })}
          >
            {part.content}
          </button>
        ) : (
          <span key={index}>{part.content}</span>
        ),
      )}
    </span>
  );
});

/**
 * An agent-authored Markdown body (Issue #2041's distinction, unchanged).
 *
 * Same plugin set as History's renderer — `remarkGfm` + `rehypeSanitize` +
 * `rehypeHighlight`, and deliberately no `rehypeRaw`, because this renders
 * whatever a language model emitted and turning the HTML parser on costs every
 * unfenced `<T>` in ordinary prose. File paths stay clickable by splicing the
 * linkifier into the block elements it can safely reach; `code` and `pre` are
 * left alone, since a path inside a fence is part of a command and a `<button>`
 * there would break selection and copy.
 */
const ChatMarkdownBody = memo(function ChatMarkdownBody({
  content,
  onFilePathClick,
}: {
  content: string;
  onFilePathClick: (path: string) => void;
}) {
  const components = useMemo<Components>(() => {
    const linkify = (children: React.ReactNode): React.ReactNode =>
      React.Children.map(children, (child) =>
        typeof child === 'string' ? (
          <ChatPlainBody content={child} onFilePathClick={onFilePathClick} />
        ) : (
          child
        ),
      );
    return {
      p: ({ children }) => <p>{linkify(children)}</p>,
      li: ({ children }) => <li>{linkify(children)}</li>,
      td: ({ children }) => <td>{linkify(children)}</td>,
      th: ({ children }) => <th>{linkify(children)}</th>,
      strong: ({ children }) => <strong>{linkify(children)}</strong>,
      em: ({ children }) => <em>{linkify(children)}</em>,
    };
  }, [onFilePathClick]);

  const remarkPlugins = useMemo(() => [remarkGfm], []);
  const rehypePlugins = useMemo(() => [rehypeSanitize, rehypeHighlight], []);

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});

// ============================================================================
// Bubble
// ============================================================================

export interface ChatMessageBubbleProps {
  message: ChatMessage;
  /**
   * Whether to draw the role + timestamp header. False for a message that
   * continues the role above it — see `shouldShowRoleHeader`.
   */
  showHeader: boolean;
  onFilePathClick: (path: string) => void;
  onCopy?: (content: string) => void;
  /** Issue #485: put a user message back into the composer. */
  onInsertToMessage?: (content: string) => void;
  /** Issue #1121: re-send an optimistic message whose send failed. */
  onRetryPending?: (tempId: string) => void;
  /** Issue #1121: drop an optimistic message whose send failed. */
  onDiscardPending?: (tempId: string) => void;
}

export const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  showHeader,
  onFilePathClick,
  onCopy,
  onInsertToMessage,
  onRetryPending,
  onDiscardPending,
}: ChatMessageBubbleProps) {
  const locale = useLocale();
  const t = useTranslations('worktree');
  const tCommon = useTranslations('common');

  const isUser = message.role === 'user';
  const sendState = message.optimisticState;
  const isMarkdown = isAgentAuthoredMarkdown(message.requestId);
  const formattedTime = formatMessageTimestamp(message.timestamp, getDateFnsLocale(locale));

  // The bubble. `rounded-2xl` with one squared-off corner on the speaker's side
  // is what makes the two columns read as a dialogue rather than two lists.
  const bubbleClassName = [
    'w-fit rounded-2xl border px-3 py-2 text-sm text-foreground',
    // Same size for both roles (Issue #2232): History renders assistant bodies
    // at `text-xs` and user bodies at `text-sm`, which makes the ANSWER look
    // like metadata attached to the question.
    isUser
      ? `${CHAT_BUBBLE_ALIGN_USER} ${CHAT_BUBBLE_MAX_WIDTH_USER} rounded-br-md`
      : `${CHAT_BUBBLE_ALIGN_ASSISTANT} ${CHAT_BUBBLE_MAX_WIDTH_ASSISTANT} rounded-bl-md border-border bg-surface-2`,
    isUser && sendState === 'error' ? 'border-danger-border bg-danger-subtle' : '',
    isUser && sendState !== 'error' ? 'border-accent-500/30 bg-accent-500/10' : '',
    sendState === 'sending' ? 'opacity-70' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const bodyClassName = [
    'max-w-full overflow-x-hidden break-words [word-break:break-word]',
    // No clamp, no expand toggle, no "..." — a reply is read here, not previewed.
    isMarkdown ? 'chat-md' : 'whitespace-pre-wrap',
  ].join(' ');

  return (
    <div
      data-testid="chat-message-row"
      data-role={message.role}
      data-row-message-id={message.id}
      className={[
        // No `items-end` / `items-start` here on purpose: the bubble's own
        // `ml-auto` / `mr-auto` is the ONLY thing that places it, so deleting
        // that class actually breaks the layout instead of being masked by a
        // second alignment mechanism saying the same thing.
        'flex w-full flex-col gap-1 pb-3',
        // Issue #168's archived dimming, carried over from HistoryPane's row
        // wrapper. The row is still readable; it is just visibly not this
        // session.
        message.archived ? 'opacity-60' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showHeader && (
        <div
          className={[
            'flex items-center gap-2 px-1 text-xs text-muted-foreground',
            isUser ? 'justify-end' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className={isUser ? 'font-medium text-accent-700 dark:text-accent-400' : 'font-medium'}>
            {isUser ? t('conversation.you') : t('conversation.assistant')}
          </span>
          {formattedTime && <span>{formattedTime}</span>}
        </div>
      )}

      <div className={bubbleClassName}>
        <div data-message-id={message.id} data-markdown={isMarkdown ? 'true' : undefined} className={bodyClassName}>
          {isMarkdown ? (
            <ChatMarkdownBody content={message.content} onFilePathClick={onFilePathClick} />
          ) : (
            <ChatPlainBody content={message.content} onFilePathClick={onFilePathClick} />
          )}
        </div>
      </div>

      {/* Send state and actions. Always rendered — see the file header on why
          this surface does not hide them behind hover. */}
      <div
        data-testid="chat-message-actions"
        className={['flex items-center gap-1 px-1', isUser ? 'justify-end' : '']
          .filter(Boolean)
          .join(' ')}
      >
        {sendState === 'sending' && (
          <span
            data-testid="chat-optimistic-sending"
            className="flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            <span>{t('conversation.sending')}</span>
          </span>
        )}
        {sendState === 'error' && (
          <span
            data-testid="chat-optimistic-error"
            className="flex items-center gap-1 text-xs text-danger-foreground"
          >
            <AlertCircle size={12} aria-hidden="true" />
            <span>{t('conversation.failedToSend')}</span>
          </span>
        )}

        {sendState === 'error' ? (
          <>
            {onRetryPending && (
              <button
                type="button"
                data-testid="chat-pending-retry"
                onClick={() => onRetryPending(message.id)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-700 transition-colors hover:bg-muted dark:text-accent-400"
                aria-label={t('conversation.retrySending')}
                title={tCommon('retry')}
              >
                <RotateCcw size={12} aria-hidden="true" />
                {tCommon('retry')}
              </button>
            )}
            {onDiscardPending && (
              <button
                type="button"
                data-testid="chat-pending-discard"
                onClick={() => onDiscardPending(message.id)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-danger-foreground"
                aria-label={t('conversation.discardMessage')}
                title={t('conversation.discard')}
              >
                <X size={12} aria-hidden="true" />
                {t('conversation.discard')}
              </button>
            )}
          </>
        ) : (
          <>
            {onCopy && (
              <button
                type="button"
                data-testid="chat-copy-message"
                onClick={() => onCopy(message.content)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={t('conversation.copyMessage')}
                title={t('conversation.copy')}
              >
                <Copy size={14} aria-hidden="true" />
              </button>
            )}
            {isUser && onInsertToMessage && (
              <button
                type="button"
                data-testid="chat-insert-user-message"
                onClick={() => onInsertToMessage(message.content)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-accent-600 dark:hover:text-accent-400"
                aria-label={t('conversation.insertToMessage')}
                title={t('conversation.insertToMessage')}
              >
                <ArrowDownToLine size={14} aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});

export default ChatMessageBubble;

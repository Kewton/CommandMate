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

import React, { memo, useCallback, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertCircle,
  ArrowDownToLine,
  Brain,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage } from '@/types/models';
import { isAgentAuthoredMarkdown } from '@/types/agent-transcript';
import { getDateFnsLocale } from '@/lib/date-locale';
import { formatMessageTimestamp } from '@/lib/date-utils';
import { stripAnsi } from '@/lib/detection/ansi';
import { splitFilePathParts } from '@/lib/chat/chat-transcript-view';
import type {
  ToolApprovalEntry,
  ToolApprovalOutcome,
} from '@/lib/chat/chat-tool-approvals';

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

/**
 * What every bubble looks like regardless of who is speaking (Issue #2233).
 *
 * Split out of the component because the settled row is no longer the only
 * thing wearing it: the in-flight reply is now a bubble at the tail of the same
 * column, and the whole point of that Issue is that the reader sees no change
 * when one becomes the other. Two hand-written copies of "rounded-2xl border
 * px-3 py-2 text-sm" would drift the first time either is touched, and the
 * symptom would be a paragraph that visibly re-typesets at the exact moment the
 * turn completes.
 */
export const CHAT_BUBBLE_BASE_CLASS = 'w-fit rounded-2xl border px-3 py-2 text-sm text-foreground';

/** The bubble an assistant message wears — base plus the assistant's side, cap and ground. */
export const CHAT_BUBBLE_ASSISTANT_CLASS = [
  CHAT_BUBBLE_BASE_CLASS,
  CHAT_BUBBLE_ALIGN_ASSISTANT,
  CHAT_BUBBLE_MAX_WIDTH_ASSISTANT,
  'rounded-bl-md border-border bg-surface-2',
].join(' ');

/** The row a bubble sits in. Alignment is the bubble's own `ml-auto` / `mr-auto`. */
export const CHAT_BUBBLE_ROW_CLASS = 'flex w-full flex-col gap-1 pb-3';

/** Wrapping rules every body obeys, Markdown or not. */
export const CHAT_BUBBLE_BODY_BASE_CLASS =
  'max-w-full overflow-x-hidden break-words [word-break:break-word]';

/**
 * A Markdown body's classes, `.chat-md` included.
 *
 * `.chat-md` and NOT `.assistant-md`: the shared namespace styles History and
 * `/chat`'s `AssistantMessageList` too (see the file header). Issue #2233 moved
 * the last chat-surface consumer of `.assistant-md` — #2199's footer body — onto
 * this constant, which is what makes the live and settled bodies the same size,
 * the same measure and the same namespace.
 */
export const CHAT_BUBBLE_MARKDOWN_BODY_CLASS = `${CHAT_BUBBLE_BODY_BASE_CLASS} chat-md`;

// ============================================================================
// Body text (Issue #2245)
// ============================================================================

/**
 * What a non-Markdown body actually shows, and what copying it yields.
 *
 * Everything that is not agent-authored Markdown is a scrape of a terminal, and
 * two of the producers writing those rows have no cleaner for the tool they are
 * scraping (codex and antigravity), so the escape sequences arrive intact and
 * render as literal `[32m●[39m` in the middle of the sentence. `stripAnsi` is
 * the same pattern the terminal display normalizer and `VerificationPane` use.
 *
 * Applied HERE rather than inside {@link ChatPlainBody} on purpose: that
 * component is also the linkifier for Markdown text nodes, so stripping inside
 * it would silently reach the Markdown path too — which Issue #2245 requires to
 * stay untouched, since a transcript-reader body is authored text and an `ESC`
 * in it is content.
 */
export function toPlainBodyText(content: unknown): string {
  return typeof content === 'string' ? stripAnsi(content) : '';
}

// ============================================================================
// Folded reasoning (Issue #2272)
// ============================================================================

/**
 * The label the five transcript readers write in front of a reasoning quote.
 *
 * It is `lib/hooks/sources/turn-body`'s `TURN_REASONING_LABEL` and is spelled
 * again here rather than imported: that module is server-side reader code, this
 * is a `'use client'` bundle, and the two are only allowed to agree on a string
 * that is already baked into `chat_messages.content` — the rows this reader has
 * to fold were written months before it existed and cannot be re-labelled.
 * `tests/unit/components/worktree/ChatThinking-2272.test.tsx` asserts the two
 * constants are equal, which is the seam that would otherwise drift.
 */
export const CHAT_THINKING_LABEL = 'Thinking';

/**
 * The first line of a reasoning section, in either shape.
 *
 *  - `> **Thinking (4)**` — what `separateTurnBody` writes since #2272.
 *  - `> **Thinking**` — what the five readers wrote inline before it, and what
 *    every row already in the database still holds.
 *
 * Anchored to the whole line so `> **Tool calls (1)**` and a paragraph that
 * merely mentions thinking cannot match.
 */
const CHAT_THINKING_HEADING = /^>[ \t]*\*\*Thinking(?:[ \t]*\((\d+)\))?\*\*[ \t]*$/;

/** What {@link splitChatThinking} answers. */
export interface ChatThinkingSplit {
  /** The body with every reasoning section removed. */
  readonly body: string;
  /** The reasoning, unquoted and joined, or null when the body had none. */
  readonly reasoning: string | null;
  /** How many blocks the chip stands for; 0 when {@link reasoning} is null. */
  readonly blocks: number;
}

/** One quoted section's lines, with the `> ` prefix taken back off. */
function unquoteSection(lines: readonly string[]): string {
  return lines
    .map((line) => line.replace(/^>[ \t]?/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * Take the reasoning out of a body so the answer is what the bubble opens with.
 *
 * ## Why the renderer and not only the writer
 *
 * #2272's writer change fixes rows written from now on. It cannot fix the rows
 * already saved — `writeOpencodeTurn` matches on `request_id` and stands down
 * rather than rewriting — and those are the ones the operator is looking at.
 * Measured against opencode 1.18.22, a `reasoning` part arrives in front of
 * every text part, so *every* saved opencode row opens with `> **Thinking**`.
 * Folding on the read side is what makes the two shapes one chip.
 *
 * ## What counts as a section
 *
 * A line matching {@link CHAT_THINKING_HEADING} that OPENS a blockquote — the
 * line above it is not itself quoted — plus every `>` line that follows it. The
 * "opens" test is what stops a `Thinking` heading nested inside some larger
 * quote being torn out of the middle of it.
 *
 * Pure and total: any string in, a string out, and a body with no section comes
 * back untouched byte for byte, which is what keeps every non-opencode bubble
 * exactly as #2245 left it.
 *
 * @param content - The Markdown body of one message
 */
export function splitChatThinking(content: string): ChatThinkingSplit {
  // The cheap reject first: this runs on every Markdown bubble in the column.
  if (!content.includes(CHAT_THINKING_LABEL)) {
    return { body: content, reasoning: null, blocks: 0 };
  }

  const lines = content.split('\n');
  const kept: string[] = [];
  const folded: string[] = [];
  let blocks = 0;
  let index = 0;

  while (index < lines.length) {
    const heading = CHAT_THINKING_HEADING.exec(lines[index]);
    const opensQuote = index === 0 || !lines[index - 1].startsWith('>');
    if (!heading || !opensQuote) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && lines[end].startsWith('>')) end += 1;
    const declared = heading[1] ? Number.parseInt(heading[1], 10) : 1;
    blocks += Number.isFinite(declared) && declared > 0 ? declared : 1;
    folded.push(unquoteSection(lines.slice(index + 1, end)));
    index = end;
  }

  if (blocks === 0) return { body: content, reasoning: null, blocks: 0 };

  return {
    // Removing a section from the middle leaves the blank lines that fenced it
    // on both sides; collapsing them is what stops a gap opening where the
    // quote used to be.
    body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    reasoning: folded.join('\n\n').replace(/^\n+/, '').replace(/\n+$/, ''),
    blocks,
  };
}

/** The collapsible row a folded reasoning section is drawn as. */
export const CHAT_THINKING_GROUP_TESTID = 'chat-thinking-group';
/** The disclosure control on that row. */
export const CHAT_THINKING_TOGGLE_TESTID = 'chat-thinking-toggle';
/** The opened region holding the reasoning itself. */
export const CHAT_THINKING_BODY_TESTID = 'chat-thinking-body';

/**
 * The reasoning, behind one chip.
 *
 * Deliberately the same part as #2245's `ChatToolApprovalGroup`: a
 * `rounded-full` chip on the muted ground, an icon, a count, a chevron, closed
 * by default and openable. Two folds on one surface that looked different would
 * read as two different KINDS of thing, and they are the same thing — a
 * subordinate log the reader may want and does not want first.
 *
 * `<details>` is not used, for the reason `turn-body` records: this renders
 * agent output with no `rehypeRaw`, so raw HTML in the body never becomes an
 * element. The disclosure is React state instead, and the children are only
 * mounted while it is open.
 */
export const ChatThinkingDisclosure = memo(function ChatThinkingDisclosure({
  blocks,
  children,
}: {
  blocks: number;
  children: React.ReactNode;
}) {
  const t = useTranslations('worktree');
  const [isOpen, setIsOpen] = useState(false);
  const toggle = useCallback(() => setIsOpen((open) => !open), []);

  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <div
      data-testid={CHAT_THINKING_GROUP_TESTID}
      data-thinking-blocks={blocks}
      className="mt-2 flex w-full flex-col gap-1"
    >
      <button
        type="button"
        data-testid={CHAT_THINKING_TOGGLE_TESTID}
        onClick={toggle}
        aria-expanded={isOpen}
        aria-label={isOpen ? t('chatTranscript.thinking.collapse') : t('chatTranscript.thinking.expand')}
        className="mr-auto flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Brain size={12} aria-hidden="true" />
        <span>{t('chatTranscript.thinking.summary', { count: blocks })}</span>
        <Chevron size={12} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          data-testid={CHAT_THINKING_BODY_TESTID}
          className="max-w-full border-l-2 border-border pl-2 text-muted-foreground"
        >
          {children}
        </div>
      )}
    </div>
  );
});

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
 *
 * Since #2272 the reasoning is lifted out first ({@link splitChatThinking}) and
 * drawn as a chip under the answer. The chip renders the reasoning through this
 * same pipeline — same components, same plugins — because it is the same kind of
 * text; what differs is only where the reader has to go to find it. History's
 * `ConversationPairCard` is NOT changed: it clamps to two lines and browses,
 * and folding a fold gains it nothing.
 */
export const ChatMarkdownBody = memo(function ChatMarkdownBody({
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

  // [#2272] The answer, then the chip. `<ReactMarkdown>` inside the chip is an
  // ELEMENT, not a render: nothing of it reaches the DOM while the chip is shut.
  const thinking = useMemo(() => splitChatThinking(content), [content]);

  return (
    <>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {thinking.body}
      </ReactMarkdown>
      {thinking.reasoning !== null && (
        <ChatThinkingDisclosure blocks={thinking.blocks}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={components}
          >
            {thinking.reasoning}
          </ReactMarkdown>
        </ChatThinkingDisclosure>
      )}
    </>
  );
});

// ============================================================================
// Tool approvals (Issue #2245)
// ============================================================================

/** The collapsible row a run of approval dialogs is drawn as. */
export const CHAT_TOOL_APPROVAL_GROUP_TESTID = 'chat-tool-approval-group';
/** The disclosure control on that row. */
export const CHAT_TOOL_APPROVAL_TOGGLE_TESTID = 'chat-tool-approval-toggle';
/** One chip inside an opened group. */
export const CHAT_TOOL_APPROVAL_ENTRY_TESTID = 'chat-tool-approval-entry';

/** The `chatTranscript.toolApproval.*` key describing each outcome. */
const OUTCOME_LABEL_KEY: Record<ToolApprovalOutcome, string> = {
  human: 'chatTranscript.toolApproval.answeredByHuman',
  auto: 'chatTranscript.toolApproval.autoApproved',
  terminal: 'chatTranscript.toolApproval.answeredInTerminal',
  pending: 'chatTranscript.toolApproval.awaitingAnswer',
  unclassified: 'chatTranscript.toolApproval.unclassified',
  unknown: 'chatTranscript.toolApproval.resolved',
};

/**
 * A run of tool-approval dialogs, as one collapsed row.
 *
 * ## Why a group rather than one chip per row
 *
 * Chips are an improvement over 2 KB bubbles even one at a time, but the shape
 * of the data is runs: 41 consecutive `Approve Bash?` rows between two sentences
 * on the codex worktree, 13 on the antigravity one. Forty-one one-line chips is
 * still forty-one rows of scrolling between a question and its answer. Closed by
 * default, therefore — and openable, because the information is not deleted,
 * only folded.
 *
 * ## Why the state lives here and nothing else does
 *
 * Open/closed is the reader's, so it is local state. Everything else is derived
 * from `entries` on every render, with nothing cached: `promptData.status` flips
 * pending → answered through a `message_updated` push, and a chip that
 * remembered its own outcome would keep saying "awaiting answer" after the
 * dialog was answered.
 */
export const ChatToolApprovalGroup = memo(function ChatToolApprovalGroup({
  entries,
}: {
  entries: ToolApprovalEntry[];
}) {
  const t = useTranslations('worktree');
  const [isOpen, setIsOpen] = useState(false);
  const toggle = useCallback(() => setIsOpen((open) => !open), []);

  if (entries.length === 0) return null;

  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <div
      data-testid={CHAT_TOOL_APPROVAL_GROUP_TESTID}
      data-approval-count={entries.length}
      className={`${CHAT_BUBBLE_ROW_CLASS} items-start`}
    >
      <button
        type="button"
        data-testid={CHAT_TOOL_APPROVAL_TOGGLE_TESTID}
        onClick={toggle}
        aria-expanded={isOpen}
        aria-label={isOpen ? t('chatTranscript.toolApproval.collapse') : t('chatTranscript.toolApproval.expand')}
        className="mr-auto flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ShieldCheck size={12} aria-hidden="true" />
        <span>{t('chatTranscript.toolApproval.summary', { count: entries.length })}</span>
        <Chevron size={12} aria-hidden="true" />
      </button>

      {isOpen && (
        <ul
          data-testid="chat-tool-approval-list"
          className="mr-auto flex w-full max-w-full flex-col gap-1 pl-1"
        >
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-testid={CHAT_TOOL_APPROVAL_ENTRY_TESTID}
              data-approval-outcome={entry.outcome}
              data-approval-audit={entry.isPermissionAudit ? 'true' : undefined}
              data-approval-merged={entry.messageIds.length}
              className="flex max-w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
            >
              <span className="min-w-0 break-words [word-break:break-word] font-mono text-foreground">
                {entry.label || t('chatTranscript.toolApproval.unlabeled')}
              </span>
              <span data-testid="chat-tool-approval-outcome">
                {t(OUTCOME_LABEL_KEY[entry.outcome])}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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

  // [#2245] What the reader sees, and therefore what copy has to hand them. The
  // Markdown path keeps `message.content` verbatim — see `toPlainBodyText`.
  const plainBody = useMemo(() => toPlainBodyText(message.content), [message.content]);
  const displayContent = isMarkdown ? message.content : plainBody;

  // The bubble. `rounded-2xl` with one squared-off corner on the speaker's side
  // is what makes the two columns read as a dialogue rather than two lists.
  const bubbleClassName = [
    // Same size for both roles (Issue #2232): History renders assistant bodies
    // at `text-xs` and user bodies at `text-sm`, which makes the ANSWER look
    // like metadata attached to the question. The assistant half is the shared
    // constant (Issue #2233), because the in-flight bubble wears it too.
    isUser
      ? `${CHAT_BUBBLE_BASE_CLASS} ${CHAT_BUBBLE_ALIGN_USER} ${CHAT_BUBBLE_MAX_WIDTH_USER} rounded-br-md`
      : CHAT_BUBBLE_ASSISTANT_CLASS,
    isUser && sendState === 'error' ? 'border-danger-border bg-danger-subtle' : '',
    isUser && sendState !== 'error' ? 'border-accent-500/30 bg-accent-500/10' : '',
    sendState === 'sending' ? 'opacity-70' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // No clamp, no expand toggle, no "..." — a reply is read here, not previewed.
  const bodyClassName = isMarkdown
    ? CHAT_BUBBLE_MARKDOWN_BODY_CLASS
    : `${CHAT_BUBBLE_BODY_BASE_CLASS} whitespace-pre-wrap`;

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
        CHAT_BUBBLE_ROW_CLASS,
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
            <ChatPlainBody content={plainBody} onFilePathClick={onFilePathClick} />
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
                onClick={() => onCopy(displayContent)}
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
                onClick={() => onInsertToMessage(displayContent)}
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

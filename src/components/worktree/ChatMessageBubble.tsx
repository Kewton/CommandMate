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
 * reading. This renders one MESSAGE as one row, in full.
 *
 * ## Only one of the two roles is a bubble (Issue #2284)
 *
 * The prompt is a right-aligned bubble; the reply is the page — no border, no
 * ground, no width cap. #2232 shipped both roles as bubbles and the shipped
 * screen said that was wrong for the half being read: a fenced code block, a
 * table and a diff all want every column the pane has, and two capped bubbles
 * stacked read as a log rather than as a conversation. Claude Desktop and Codex
 * Desktop draw the same asymmetry. What replaces the box as the left edge is
 * the role header and the actions row, which is why the body now carries their
 * `px-1`.
 *
 * The same Issue folds the last thing that was still spilling into the reply:
 * the trailing `Tool calls (N)` section (`lib/chat/chat-tool-log`), which joins
 * #2272's reasoning and #2245's approval run as a one-line chip. All three
 * answer to ONE toggle, published by `ChatTranscript` through
 * {@link ChatToolActivityProvider}.
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
  Wrench,
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
import { classifyChatLink, normalizeChatFilePath } from '@/lib/chat/chat-file-path';
import { splitToolLog } from '@/lib/chat/chat-tool-log';
import type {
  ToolApprovalEntry,
  ToolApprovalOutcome,
} from '@/lib/chat/chat-tool-approvals';

// ============================================================================
// Bubble geometry
// ============================================================================

/**
 * The user bubble's width cap.
 *
 * The prompt is capped so the column keeps a visible right-hand axis: a message
 * that fills the pane is a paragraph, and a paragraph on both sides reads as a
 * log no matter what color it is. Issue #2284 removed the assistant's cap and
 * left this one untouched, byte for byte — that asymmetry IS the layout.
 *
 * Exported so the transcript's tests can assert the cap by value: removing it
 * is the mutation Issue #2232 requires a test to catch.
 */
export const CHAT_BUBBLE_MAX_WIDTH_USER = 'max-w-[85%] sm:max-w-[75%]';

/**
 * The assistant body's width: the whole row (Issue #2284).
 *
 * `max-w-[92%]` in a bordered bubble was the shape Issue #2232 shipped, and on
 * a real transcript it is the wrong one for the half of the conversation that
 * is being READ. A fenced code block, a table and a diff all want every column
 * the pane has, and 8 % of a phone's width is a wrapped line each. Claude
 * Desktop and Codex Desktop both draw the same asymmetry — the prompt in a
 * bubble, the answer as the page — and this is that.
 *
 * Named for what it is rather than kept as a "max width" whose value happens to
 * be 100 %: the old name is gone so nothing can go on believing there is a cap
 * here to tune.
 */
export const CHAT_BUBBLE_WIDTH_ASSISTANT = 'w-full max-w-full';

/** Side the bubble is pushed to. `ml-auto` / `mr-auto` inside a block row. */
export const CHAT_BUBBLE_ALIGN_USER = 'ml-auto';
export const CHAT_BUBBLE_ALIGN_ASSISTANT = 'mr-auto';

/**
 * What a bubble looks like — which since Issue #2284 means what the USER's
 * message looks like.
 *
 * The name and the value are #2233's: the constant exists because the settled
 * row is not the only thing wearing a given shape, and two hand-written copies
 * of "rounded-2xl border px-3 py-2 text-sm" would drift the first time either
 * was touched. What changed is who wears it — the assistant's side is no longer
 * a bubble at all, so this is now the prompt's shape alone.
 */
export const CHAT_BUBBLE_BASE_CLASS = 'w-fit rounded-2xl border px-3 py-2 text-sm text-foreground';

/**
 * What an assistant message wears: the row, and nothing around it (#2284).
 *
 * No border, no ground, no radius, no `w-fit` and no cap — the reply is the
 * page. `px-1` rather than the bubble's `px-3` so the body's left edge lines up
 * with the "Assistant" header above it and the copy button below it, which are
 * both `px-1`: with the box gone, those two are the only things left saying
 * where the column starts.
 *
 * Still ONE constant shared by three renderers — the settled row here, the
 * in-flight bubble (`ChatLiveTurnBubble`, #2233) and the held one
 * (`ChatSettlingTurnBubble`, #2248). That sharing is what makes "a turn ending
 * re-typesets nothing" true by construction rather than by inspection, and
 * `ChatTranscript-settling-2248.test.tsx` compares the three rendered strings.
 */
export const CHAT_BUBBLE_ASSISTANT_CLASS = [
  CHAT_BUBBLE_ALIGN_ASSISTANT,
  CHAT_BUBBLE_WIDTH_ASSISTANT,
  'px-1 text-sm text-foreground',
].join(' ');

/**
 * The box a message body sits in, whatever it is styled as.
 *
 * A structural handle rather than a class probe: the suites used to find it
 * with `[class*="rounded-2xl"]`, which stopped resolving the moment Issue #2284
 * took the radius off the assistant's half. What the tests actually want is
 * "the element wearing the role's presentation", and that is a fact about the
 * markup, not about which utilities the presentation happens to use this month.
 */
export const CHAT_BUBBLE_TESTID = 'chat-bubble';

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
// Tool activity (Issue #2284)
// ============================================================================

/** What the transcript has decided about the folded logs beneath it. */
export interface ChatToolActivityState {
  /** True while every folded tool row in this subtree should be open. */
  readonly showAll: boolean;
}

/**
 * The transcript-wide answer to "is tool activity showing?".
 *
 * A context rather than a prop threaded through four components because the
 * three things it governs are at three different depths — the approval group is
 * a ROW of the virtual list, the tool log and the reasoning are inside a
 * Markdown body inside a bubble — and because the live and held bubbles reach
 * `ChatMarkdownBody` by a different path from the settled one. A prop would
 * have to be added to every one of those signatures, and the first renderer
 * that forgot to pass it would silently opt itself out of the toggle.
 *
 * Defaulting to folded matters: `ChatMessageBubble` is rendered directly by
 * several suites and by `HistoryPane`'s neighbours with no provider above it,
 * and "no provider" has to mean the same thing as "the reader has not asked for
 * the logs".
 */
const ChatToolActivityContext = React.createContext<ChatToolActivityState>({ showAll: false });

/** Publishes the transcript's verdict to every chip below it. */
export const ChatToolActivityProvider = ChatToolActivityContext.Provider;

/**
 * The value one row wears while it is holding a search hit (Issue #2284).
 *
 * A module constant, not an object literal at the call site: the provider's
 * value is compared by identity, and a fresh `{ showAll: true }` per render
 * would re-render every chip in every matched row on every keystroke.
 */
export const CHAT_TOOL_ACTIVITY_OPEN: ChatToolActivityState = { showAll: true };

/**
 * What all three folded logs are drawn as: one `rounded-full` chip.
 *
 * #2245 gave the approval run this shape and #2272 copied it for the reasoning;
 * #2284 adds the tool log and turns the third copy into the one constant. They
 * have to look the same because they ARE the same thing to a reader — a
 * subordinate log they may want and do not want first — and three chips that
 * differed by a padding value would read as three different kinds of row.
 */
export const CHAT_TOOL_ACTIVITY_CHIP_CLASS = [
  'mr-auto flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border',
  'bg-surface-2 px-2.5 py-1 text-xs text-muted-foreground transition-colors',
  'hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
].join(' ');

/**
 * One folded chip's open/closed state, obeying the transcript's toggle.
 *
 * The rule the Issue asks for is "the toggle sets every chip, and a chip the
 * reader opened by hand stays open until the toggle moves again". That is
 * exactly React's documented shape for adjusting state when a prop changes,
 * with the transcript's verdict as the prop: the local override records WHICH
 * verdict it was taken against, so the moment the verdict changes the override
 * stops applying and every chip in the column agrees again. No effect, no
 * subscription, and nothing to clean up when a virtualized row unmounts.
 *
 * @returns Whether this chip is open, and the click handler that flips it
 */
export function useChatToolActivityDisclosure(): {
  isOpen: boolean;
  toggle: () => void;
} {
  const { showAll } = React.useContext(ChatToolActivityContext);
  const [override, setOverride] = useState<{ against: boolean; isOpen: boolean } | null>(null);

  const isOpen = override !== null && override.against === showAll ? override.isOpen : showAll;
  const toggle = useCallback(
    () => setOverride({ against: showAll, isOpen: !isOpen }),
    [showAll, isOpen],
  );

  return { isOpen, toggle };
}

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
  // [#2284] Not local state any more: the transcript's one toggle governs the
  // reasoning, the tool log and the approval run together.
  const { isOpen, toggle } = useChatToolActivityDisclosure();

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
        className={CHAT_TOOL_ACTIVITY_CHIP_CLASS}
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
// Folded tool log (Issue #2284)
// ============================================================================

/** The collapsible row a folded tool section is drawn as. */
export const CHAT_TOOL_LOG_GROUP_TESTID = 'chat-tool-log-group';
/** The disclosure control on that row. */
export const CHAT_TOOL_LOG_TOGGLE_TESTID = 'chat-tool-log-toggle';
/** The opened region holding the calls themselves. */
export const CHAT_TOOL_LOG_BODY_TESTID = 'chat-tool-log-body';

/**
 * The tool calls, behind one chip.
 *
 * The third of the three folds on this surface, and deliberately identical to
 * the other two: the same {@link CHAT_TOOL_ACTIVITY_CHIP_CLASS} chip, the same
 * chevron, the same left-ruled region when it opens, closed by default and
 * openable. Before this Issue a turn's tool log was drawn as an ordinary
 * blockquote — a left rule and muted text — so a reply that called twenty tools
 * ran twenty lines of `- \`Bash\` — …` under it and the next reply started
 * below all of them.
 *
 * `<details>` is not used, for the reason `lib/chat/chat-tool-log` records: this
 * renders agent output with no `rehypeRaw`, so raw HTML in the body never
 * becomes an element. The disclosure is React state instead — shared state,
 * since #2284 — and the children are only mounted while it is open.
 */
export const ChatToolLogDisclosure = memo(function ChatToolLogDisclosure({
  toolCalls,
  children,
}: {
  toolCalls: number;
  children: React.ReactNode;
}) {
  const t = useTranslations('worktree');
  const { isOpen, toggle } = useChatToolActivityDisclosure();

  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <div
      data-testid={CHAT_TOOL_LOG_GROUP_TESTID}
      data-tool-calls={toolCalls}
      className="mt-2 flex w-full flex-col gap-1"
    >
      <button
        type="button"
        data-testid={CHAT_TOOL_LOG_TOGGLE_TESTID}
        onClick={toggle}
        aria-expanded={isOpen}
        aria-label={isOpen ? t('chatTranscript.toolLog.collapse') : t('chatTranscript.toolLog.expand')}
        className={CHAT_TOOL_ACTIVITY_CHIP_CLASS}
      >
        <Wrench size={12} aria-hidden="true" />
        <span>{t('chatTranscript.toolLog.summary', { count: toolCalls })}</span>
        <Chevron size={12} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          data-testid={CHAT_TOOL_LOG_BODY_TESTID}
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
 * What a clickable path wears, on both surfaces (Issue #2345).
 *
 * The bare-path `<button>` below already looked like this; the Markdown link
 * renderer now wears the same string rather than a second copy of it, so a body
 * that names the same file twice — once as prose and once as `[label](path)` —
 * does not draw the two in different colors. History's own bare-path button
 * keeps its pre-existing classes (Issue #2232 froze how that card looks); what
 * is shared across the two surfaces is the LINK, which had no styling at all
 * before this Issue.
 */
export const CHAT_FILE_LINK_CLASS =
  'cursor-pointer font-mono text-sm text-accent-700 underline-offset-2 hover:underline dark:text-accent-400';

/** The testid every in-app file link publishes, on both surfaces. */
export const CHAT_FILE_LINK_TESTID = 'chat-file-link';

/**
 * One Markdown link in an agent-authored body (Issue #2345).
 *
 * ## Why an `a` renderer had to exist at all
 *
 * The linkifier below only ever sees TEXT. A Markdown link's destination is
 * consumed by the parser, so `[整理文書](/Users/…/notes.md)` never reaches
 * {@link splitFilePathParts} and react-markdown's default `<a>` was emitted
 * verbatim — with no `target`, so clicking it navigated the CommandMate tab to
 * `http://localhost:3000/Users/…` and left the app on a 404. Both halves of that
 * are fixed here: an in-worktree destination opens the file panel, and an
 * ordinary URL opens in a new tab so this tab is never lost either way.
 *
 * ## One component, two surfaces
 *
 * `ConversationPairCard` imports this rather than growing a second `a`
 * override. #2274 already established the precedent: History and chat had
 * separate copies of the path rule, both were wrong the same way, and one copy
 * is what makes "the same link behaves the same in both places" a fact instead
 * of a coincidence.
 *
 * ## Where the path is turned into a path
 *
 * Nowhere here. The click reports the href exactly as written and the surface's
 * own `handleFilePathClick` — which is also where the bare-path button lands,
 * and the only place that knows this worktree's root — runs
 * {@link normalizeChatFilePath}. Normalizing in the renderer would mean doing it
 * twice, in two components, from a prop each would have to be handed.
 *
 * `rehypeSanitize` has already dropped the href of anything whose scheme is not
 * http / https / mailto (measured: `file:`, `tel:` and `javascript:` all arrive
 * with no href at all), so a hrefless link simply renders as text.
 */
export const ChatFileLink = memo(function ChatFileLink({
  href,
  children,
  onFilePathClick,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  /** Where the surface should look for the file. Given the href verbatim. */
  onFilePathClick: (path: string) => void;
}) {
  const t = useTranslations('worktree');
  const target = href ? classifyChatLink(href) : null;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!href) return;
      event.preventDefault();
      onFilePathClick(href);
    },
    [href, onFilePathClick],
  );

  // No href, an anchor, or a scheme nothing here can act on: the browser's own
  // behaviour is already right (or already nothing).
  if (!href || target === null || target === 'anchor') {
    // `rest` is forwarded on every branch so remark's own attributes survive —
    // a GFM footnote reference is an anchor carrying `id` and
    // `data-footnote-ref`, and dropping those breaks the jump back.
    return (
      <a {...rest} href={href}>
        {children}
      </a>
    );
  }

  if (target === 'external') {
    // `noopener noreferrer` with `_blank`: the new tab must not get a handle on
    // this one, and the point of the whole renderer is that this tab stays put.
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  return (
    <a
      {...rest}
      href={href}
      data-testid={CHAT_FILE_LINK_TESTID}
      onClick={handleClick}
      className={CHAT_FILE_LINK_CLASS}
      aria-label={t('conversation.openFile', { path: normalizeChatFilePath(href) ?? href })}
    >
      {children}
    </a>
  );
});

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
 * Since #2272 the reasoning is lifted out ({@link splitChatThinking}) and drawn
 * as a chip under the answer, and since #2284 the trailing tool section is too
 * (`splitToolLog`). Both chips render their contents through this same pipeline
 * — same components, same plugins — because it is the same kind of text; what
 * differs is only where the reader has to go to find it. History's
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
      // [#2345] The one element the linkifier above cannot reach: a Markdown
      // link's destination is consumed by the parser, so it is never a text
      // child of anything. Its children are deliberately NOT linkified — a path
      // inside a link's label is part of the label.
      a: ({ href, children, node: _node, ...rest }) => (
        <ChatFileLink {...rest} href={href} onFilePathClick={onFilePathClick}>
          {children}
        </ChatFileLink>
      ),
    };
  }, [onFilePathClick]);

  const remarkPlugins = useMemo(() => [remarkGfm], []);
  const rehypePlugins = useMemo(() => [rehypeSanitize, rehypeHighlight], []);

  // [#2272] / [#2284] The answer, then the chips. `<ReactMarkdown>` inside a
  // chip is an ELEMENT, not a render: nothing of it reaches the DOM while the
  // chip is shut.
  //
  // The tool log comes off FIRST and the reasoning second, because that is the
  // order `separateTurnBody` laid them in — prose, then `Thinking (N)`, then
  // `Tool calls (N)` at the very end. Taking the trailing section off leaves a
  // body whose last block is the reasoning, which is exactly what
  // `splitChatThinking` was written against.
  const tools = useMemo(() => splitToolLog(content), [content]);
  const thinking = useMemo(() => splitChatThinking(tools.prose), [tools.prose]);

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
      {tools.toolCalls > 0 && (
        <ChatToolLogDisclosure toolCalls={tools.toolCalls}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={components}
          >
            {tools.toolLog}
          </ReactMarkdown>
        </ChatToolLogDisclosure>
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
 * ## Why nothing but open/closed is remembered
 *
 * Open/closed is the reader's, and since Issue #2284 it is the READER'S for the
 * whole column: {@link useChatToolActivityDisclosure} answers to the
 * transcript's one tool-activity toggle, with a per-chip override that lasts
 * until that toggle moves again. Everything else is derived
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
  // [#2284] The transcript's toggle reaches this run too: approvals, the tool
  // log and the reasoning are one kind of thing and answer to one control.
  const { isOpen, toggle } = useChatToolActivityDisclosure();

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
        className={CHAT_TOOL_ACTIVITY_CHIP_CLASS}
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

      <div data-testid={CHAT_BUBBLE_TESTID} className={bubbleClassName}>
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

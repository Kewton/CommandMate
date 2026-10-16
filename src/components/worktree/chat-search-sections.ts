/**
 * Where chat's folded sections sit in a message's raw text, for search
 * (Issue #3503).
 *
 * `ChatMarkdownBody` does not draw a message in raw order: `splitChatMarkdownBody`
 * takes the trailing (or legacy leading) tool log off, then lifts every
 * `> **Thinking**` quote out of the rest, and the bubble draws the answer, then
 * the reasoning chip, then the tool-log chip. The search highlighter maps raw
 * offsets onto that DOM, so it needs to know which raw lines went to which chip
 * — otherwise a diagram in the reasoning and an identical one in the answer are
 * paired the wrong way round.
 *
 * The answer comes from the splitters themselves rather than a second copy of
 * their rules:
 *
 * - the tool log is a prefix or a suffix cut, so `splitToolLog`'s prose locates
 *   it exactly;
 * - for the reasoning, `splitChatThinking` answers each section's line range
 *   (`lineRanges`), heading included.
 *
 * @module components/worktree/chat-search-sections
 */

import {
  CHAT_THINKING_LABEL,
  chatThinkingLineOrigins,
  splitChatThinking,
  type ChatThinkingLineOrigin,
} from '@/lib/chat/chat-thinking';
import { splitToolLog } from '@/lib/chat/chat-tool-log';
import type { ChatMarkdownBodySplit } from '@/lib/chat/chat-markdown-body';
import {
  alignDerivedText,
  IDENTITY_RAW_OFFSET,
  type HighlightSection,
  type MatchPosition,
  type RawOffsetMapper,
} from '@/lib/terminal-highlight';
import { mapDerivedLines, type DerivedLineOrigin } from '@/lib/terminal-highlight-offsets';

/** `data-search-section` of the reasoning chip's Markdown. */
export const CHAT_SEARCH_SECTION_REASONING = 'chat-reasoning';
/** `data-search-section` of the tool-log chip's Markdown. */
export const CHAT_SEARCH_SECTION_TOOL_LOG = 'chat-tool-log';

/** Raw ranges of the lines `splitChatThinking` lifts out of `prose`. */
function reasoningRanges(prose: string, proseStart: number): MatchPosition[] {
  if (!prose.includes(CHAT_THINKING_LABEL)) return [];
  const split = splitChatThinking(prose);
  if (split.reasoning === null || !split.lineRanges) return [];

  const lines = prose.split('\n');
  const ranges: MatchPosition[] = [];
  let offset = proseStart;
  const starts = lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });
  for (const [first, last] of split.lineRanges) {
    for (let index = first; index < last; index++) {
      ranges.push({ start: starts[index], end: starts[index] + lines[index].length + 1 });
    }
  }
  return ranges;
}

/**
 * The folded sections of one chat message, as raw ranges. Empty when the
 * message has neither a reasoning section nor a tool log.
 */
export function chatSearchSections(content: string): HighlightSection[] {
  const tools = splitToolLog(content);
  let proseStart = 0;
  const sections: HighlightSection[] = [];
  if (tools.prose !== content) {
    if (content.startsWith(tools.prose)) {
      sections.push({
        key: CHAT_SEARCH_SECTION_TOOL_LOG,
        ranges: [{ start: tools.prose.length, end: content.length }],
      });
    } else {
      proseStart = content.length - tools.prose.length;
      sections.push({ key: CHAT_SEARCH_SECTION_TOOL_LOG, ranges: [{ start: 0, end: proseStart }] });
    }
  }
  const reasoning = reasoningRanges(tools.prose, proseStart);
  if (reasoning.length > 0) sections.push({ key: CHAT_SEARCH_SECTION_REASONING, ranges: reasoning });
  return sections;
}

/**
 * [Issue #3525] For each part `ChatMarkdownBody` hands react-markdown, how an
 * offset into that part maps back to `content` — so a mermaid source can name
 * where its fence is in the message search runs on. `null` for a part whose
 * lines cannot be lined up with the message's (search then pairs that part's
 * diagrams by body, as before).
 *
 * - answer and reasoning [Issue #3554]: from where `splitChatThinking` took
 *   each of their lines (`chatThinkingLineOrigins`), not by matching strings —
 *   the split trims the answer's ends and joins reasoning sections with a blank
 *   line no raw line holds, which the matching could not follow;
 * - tool log: the trailing quoted section unquoted (or the legacy leading run
 *   as is), against the tool-log section's lines.
 */
export function chatMarkdownRawOffsets(
  content: string,
  split: ChatMarkdownBodySplit,
): { body: RawOffsetMapper | null; reasoning: RawOffsetMapper | null; toolLog: RawOffsetMapper | null } {
  if (!split.folded) return { body: IDENTITY_RAW_OFFSET, reasoning: null, toolLog: null };
  const sections = chatSearchSections(content);
  const rangesOf = (key: string): MatchPosition[] =>
    sections.find((section) => section.key === key)?.ranges ?? [];

  // `splitChatThinking` read the prose `splitToolLog` left, which is whole
  // lines of `content` from `proseStart` on.
  const tools = splitToolLog(content);
  const proseStart = content.startsWith(tools.prose) ? 0 : content.length - tools.prose.length;
  const lineStarts: number[] = [];
  let cursor = proseStart;
  for (const line of tools.prose.split('\n')) {
    lineStarts.push(cursor);
    cursor += line.length + 1;
  }
  const origins = chatThinkingLineOrigins(tools.prose);
  const toRaw = (lines: readonly ChatThinkingLineOrigin[]): DerivedLineOrigin[] =>
    lines.map((line) => ({
      text: line.text,
      rawStart: line.line === null ? null : lineStarts[line.line] + line.column,
    }));

  return {
    body: mapDerivedLines(split.body, toRaw(origins.body)),
    reasoning: split.reasoning === null ? null : mapDerivedLines(split.reasoning, toRaw(origins.reasoning)),
    toolLog: split.toolCalls > 0 ? alignDerivedText(split.toolLog, content, rangesOf(CHAT_SEARCH_SECTION_TOOL_LOG)) : null,
  };
}

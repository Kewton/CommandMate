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
 * - for the reasoning, the prose is handed to `splitChatThinking` with every
 *   line that cannot be a `Thinking` heading replaced by a marker that keeps
 *   the one property the splitter reads from it (whether it starts with `>`).
 *   The markers that come back in the body are the lines it kept; every other
 *   line went to (or headed) the reasoning.
 *
 * @module components/worktree/chat-search-sections
 */

import { CHAT_THINKING_LABEL, splitChatThinking } from '@/lib/chat/chat-thinking';
import { splitToolLog } from '@/lib/chat/chat-tool-log';
import type { ChatMarkdownBodySplit } from '@/lib/chat/chat-markdown-body';
import {
  alignDerivedText,
  IDENTITY_RAW_OFFSET,
  type HighlightSection,
  type MatchPosition,
  type RawOffsetMapper,
} from '@/lib/terminal-highlight';

/** `data-search-section` of the reasoning chip's Markdown. */
export const CHAT_SEARCH_SECTION_REASONING = 'chat-reasoning';
/** `data-search-section` of the tool-log chip's Markdown. */
export const CHAT_SEARCH_SECTION_TOOL_LOG = 'chat-tool-log';

const marker = (index: number): string => `\u0001${index}\u0001`;

/** Raw ranges of the lines `splitChatThinking` lifts out of `prose`. */
function reasoningRanges(prose: string, proseStart: number): MatchPosition[] {
  if (!prose.includes(CHAT_THINKING_LABEL)) return [];
  const lines = prose.split('\n');
  const probe = lines.map((line, index) =>
    line.startsWith('>')
      ? line.includes(CHAT_THINKING_LABEL)
        ? line
        : `> ${marker(index)}`
      : marker(index),
  );
  const split = splitChatThinking(probe.join('\n'));
  if (split.reasoning === null) return [];

  const kept = split.body.split('\n');
  const ranges: MatchPosition[] = [];
  let cursor = 0;
  let offset = proseStart;
  lines.forEach((line, index) => {
    const end = offset + line.length;
    if (kept[cursor] === probe[index]) {
      cursor += 1;
    } else {
      ranges.push({ start: offset, end: end + 1 });
    }
    offset = end + 1;
  });
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
 * - answer: `content` itself when nothing was folded; otherwise the lines left
 *   once the tool log and the reasoning are out (blank runs collapsed, ends
 *   trimmed), lined up against the lines outside both sections;
 * - reasoning: the `> **Thinking**` quotes' lines, unquoted, against the
 *   reasoning section's lines;
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
  const folded = sections.flatMap((section) => section.ranges).sort((a, b) => a.start - b.start);
  const answer: MatchPosition[] = [];
  let from = 0;
  for (const range of folded) {
    if (range.start > from) answer.push({ start: from, end: range.start });
    from = Math.max(from, range.end);
  }
  if (from <= content.length) answer.push({ start: from, end: content.length + 1 });
  return {
    body: alignDerivedText(split.body, content, answer),
    reasoning:
      split.reasoning === null
        ? null
        : alignDerivedText(split.reasoning, content, rangesOf(CHAT_SEARCH_SECTION_REASONING)),
    toolLog: split.toolCalls > 0 ? alignDerivedText(split.toolLog, content, rangesOf(CHAT_SEARCH_SECTION_TOOL_LOG)) : null,
  };
}

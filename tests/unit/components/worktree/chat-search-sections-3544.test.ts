/**
 * When chat's parts cannot be lined up with the message (Issue #3544).
 *
 * `chatMarkdownRawOffsets` maps each part `ChatMarkdownBody` hands react-markdown
 * back to the message as written; a part it answers `null` for draws its mermaid
 * sources without a raw range, and search falls back to `findMermaidFences`.
 * These pin which real inputs take that fallback — so it is reachable, and the
 * fallback has to read fences the way Markdown does.
 */

import { describe, it, expect } from 'vitest';
import { splitChatMarkdownBody } from '@/lib/chat/chat-markdown-body';
import { chatMarkdownRawOffsets } from '@/components/worktree/chat-search-sections';

const THINKING = ['> **Thinking**', '> pondering', ''];

function offsetsOf(content: string) {
  return chatMarkdownRawOffsets(content, splitChatMarkdownBody(content));
}

describe('[#3544] chatMarkdownRawOffsets: when the answer cannot be lined up', () => {
  it('lines up an answer whose leading whitespace the split trimmed', () => {
    const content = [...THINKING, '  indented first line', 'Done.'].join('\n');
    const toRaw = offsetsOf(content).body;
    expect(toRaw).not.toBeNull();
    expect(content.slice(toRaw!(0)!, toRaw!(0)! + 8)).toBe('indented');
  });

  it.each([
    ['trailing spaces on its last line (a hard break)', [...THINKING, 'Answer.', 'Done.  ']],
    ['a trailing tab', [...THINKING, 'Answer.', 'Done.\t']],
    ['CRLF line endings (the last line’s `\\r`)', [...THINKING, 'Answer.\r', 'Done.\r']],
  ])('is null for an answer with %s — the split trims it off', (_label, lines) => {
    expect(offsetsOf(lines.join('\n')).body).toBeNull();
  });

  it('negative control: nothing folded is the identity, trailing whitespace or not', () => {
    const toRaw = offsetsOf('Answer.\nDone.  ').body;
    expect(toRaw?.(9)).toBe(9);
  });
});

describe('[#3544] chatMarkdownRawOffsets: the reasoning', () => {
  it('lines up one Thinking section', () => {
    expect(offsetsOf([...THINKING, 'Answer.'].join('\n')).reasoning).not.toBeNull();
  });

  it('is null for two Thinking sections — the blank line that joins them is in neither', () => {
    const content = ['> **Thinking**', '> first', '', 'Answer.', '', '> **Thinking**', '> second', '', 'More.'].join('\n');
    const split = splitChatMarkdownBody(content);
    expect(split.reasoning).toBe('first\n\nsecond');
    expect(chatMarkdownRawOffsets(content, split).reasoning).toBeNull();
  });
});

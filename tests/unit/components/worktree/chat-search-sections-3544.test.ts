/**
 * When chat's parts cannot be lined up with the message (Issue #3544).
 *
 * `chatMarkdownRawOffsets` maps each part `ChatMarkdownBody` hands react-markdown
 * back to the message as written; a part it answers `null` for draws its mermaid
 * sources without a raw range, and search falls back to `findMermaidFences`.
 * These pinned which real inputs took that fallback — so it was reachable, and
 * the fallback has to read fences the way Markdown does. Since #3554 the answer
 * and the reasoning map from where the split took each line, and the inputs
 * below that used to be null line up.
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
  ])('[#3554] lines up an answer with %s — the split trims it off (was null)', (_label, lines) => {
    const content = lines.join('\n');
    const split = splitChatMarkdownBody(content);
    const toRaw = chatMarkdownRawOffsets(content, split).body;
    expect(toRaw).not.toBeNull();
    expect(toRaw!(split.body.indexOf('Answer.'))).toBe(content.indexOf('Answer.'));
    expect(toRaw!(split.body.length)).toBe(content.indexOf('Done.') + 'Done.'.length);
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

  it('[#3554] lines up two Thinking sections — the blank line that joins them is in neither (was null)', () => {
    const content = ['> **Thinking**', '> first', '', 'Answer.', '', '> **Thinking**', '> second', '', 'More.'].join('\n');
    const split = splitChatMarkdownBody(content);
    expect(split.reasoning).toBe('first\n\nsecond');
    const toRaw = chatMarkdownRawOffsets(content, split).reasoning;
    expect(toRaw).not.toBeNull();
    expect(toRaw!(split.reasoning!.indexOf('second'))).toBe(content.indexOf('second'));
  });
});

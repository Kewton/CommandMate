/**
 * Chat's answer and reasoning map back to the message from where the split
 * took each line (Issue #3554).
 *
 * `chatMarkdownRawOffsets` used to line the parts up with the message by
 * matching strings, under a rule that only knew lines losing a front. The
 * answer is trimmed (its last line's hard-break spaces, a tab, the `\r` of a
 * mixed CRLF body, a full-width space in front) and two legacy reasoning
 * sections are joined by a blank line no raw line holds — on all of those the
 * mapping was null. It is now built from `chatThinkingLineOrigins`.
 */

import { describe, it, expect } from 'vitest';
import { splitChatMarkdownBody } from '@/lib/chat/chat-markdown-body';
import { chatThinkingLineOrigins, splitChatThinking } from '@/lib/chat/chat-thinking';
import { chatMarkdownRawOffsets } from '@/components/worktree/chat-search-sections';
import type { RawOffsetMapper } from '@/lib/terminal-highlight';
import { TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

const LEGACY = ['> **Thinking**', '> pondering', ''];

function offsetsOf(content: string) {
  const split = splitChatMarkdownBody(content);
  return { split, ...chatMarkdownRawOffsets(content, split) };
}

/**
 * Every character of `needle` (its `nth` occurrence in `derived`) maps onto the
 * same character at `rawAt` in `content`, and its end onto the end there.
 */
function expectMapped(
  toRaw: RawOffsetMapper | null,
  derived: string,
  content: string,
  needle: string,
  rawAt: number,
  nth = 0,
): void {
  expect(toRaw).not.toBeNull();
  let at = -1;
  for (let i = 0; i <= nth; i++) at = derived.indexOf(needle, at + 1);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(content.slice(rawAt, rawAt + needle.length)).toBe(needle);
  for (let k = 0; k <= needle.length; k++) expect(toRaw!(at + k)).toBe(rawAt + k);
}

describe('[#3554] the answer maps back where the split trimmed it', () => {
  it.each([
    ['trailing spaces on its last line (a hard break)', [...LEGACY, 'Answer.', 'Done.  ']],
    ['a trailing tab', [...LEGACY, 'Answer.', 'Done.\t']],
    ['a mixed CRLF body’s last `\\r`', [...LEGACY, 'Answer.\r', 'Done.\r']],
    ['a full-width space in front', [...LEGACY, '　Answer.', 'Done.']],
    ['a no-break space in front', [...LEGACY, ' Answer.', 'Done.']],
  ])('%s', (_label, lines) => {
    const content = lines.join('\n');
    const { split, body } = offsetsOf(content);
    expectMapped(body, split.body, content, 'Answer.', content.indexOf('Answer.'));
    expectMapped(body, split.body, content, 'Done.', content.indexOf('Done.'));
    expect(body!(split.body.length)).toBe(content.indexOf('Done.') + 'Done.'.length);
  });

  it('the line just above a later Thinking section, with a hard break', () => {
    const content = ['Answer.', 'Done.  ', '', '> **Thinking**', '> later'].join('\n');
    const { split, body, reasoning } = offsetsOf(content);
    expect(split.body).toBe('Answer.\nDone.');
    expectMapped(body, split.body, content, 'Done.', content.indexOf('Done.'));
    expectMapped(reasoning, split.reasoning!, content, 'later', content.indexOf('later'));
  });

  it('a hard break on the last line before the tool log', () => {
    const content = [...LEGACY, 'Answer.', 'Done.  ', '', `> **${TURN_TOOL_LOG_LABEL} (1)**`, '>', '> - `Read` — x.md'].join(
      '\n',
    );
    const { split, body, toolLog } = offsetsOf(content);
    expectMapped(body, split.body, content, 'Done.', content.indexOf('Done.'));
    expectMapped(toolLog, split.toolLog, content, 'x.md', content.indexOf('x.md'));
  });
});

describe('[#3554] the reasoning maps back across the blank line that joins two sections', () => {
  it('two legacy sections (no `>` line under the heading)', () => {
    const content = ['> **Thinking**', '> first', '', 'Answer.', '', '> **Thinking**', '> second', '', 'More.'].join('\n');
    const { split, reasoning, body } = offsetsOf(content);
    expect(split.reasoning).toBe('first\n\nsecond');
    expectMapped(reasoning, split.reasoning!, content, 'first', content.indexOf('first'));
    expectMapped(reasoning, split.reasoning!, content, 'second', content.indexOf('second'));
    expectMapped(body, split.body, content, 'More.', content.indexOf('More.'));
  });

  it('the joining blank line is in no raw line, so it maps to nothing', () => {
    const content = ['> **Thinking**', '> first', '', 'Answer.', '', '> **Thinking**', '> second'].join('\n');
    const { split, reasoning } = offsetsOf(content);
    const blank = split.reasoning!.indexOf('\n\n') + 1;
    expect(reasoning!(blank)).toBeNull();
  });
});

describe('[#3554] the same text in the reasoning and the answer stays apart', () => {
  it('each part maps onto its own occurrence', () => {
    const content = ['> **Thinking**', '> same words', '', 'same words  '].join('\n');
    const { split, body, reasoning } = offsetsOf(content);
    expect(split.body).toBe('same words');
    expectMapped(body, split.body, content, 'same words', content.lastIndexOf('same words'));
    expectMapped(reasoning, split.reasoning!, content, 'same words', content.indexOf('same words'));
  });
});

describe('[#3554] negative controls: what already mapped maps as before', () => {
  it('nothing folded is the identity', () => {
    const { body, reasoning } = offsetsOf('Answer  \nDone.  ');
    expect(body?.(9)).toBe(9);
    expect(reasoning).toBeNull();
  });

  it('a hard break in the middle of the answer keeps its spaces and its place', () => {
    const content = [...LEGACY, 'Answer  ', 'Done.'].join('\n');
    const { split, body } = offsetsOf(content);
    expect(split.body).toBe('Answer  \nDone.');
    expectMapped(body, split.body, content, 'Answer  ', content.indexOf('Answer  '));
    expectMapped(body, split.body, content, 'Done.', content.indexOf('Done.'));
  });

  it('two sections in the new shape (a `>` line under the heading)', () => {
    const content = ['> **Thinking**', '>', '> first', '', 'Answer.', '', '> **Thinking**', '>', '> second'].join('\n');
    const { split, reasoning } = offsetsOf(content);
    expectMapped(reasoning, split.reasoning!, content, 'first', content.indexOf('first'));
    expectMapped(reasoning, split.reasoning!, content, 'second', content.indexOf('second'));
  });

  it('what is drawn and copied is unchanged', () => {
    const cases: Array<[string, string, string | null]> = [
      [[...LEGACY, 'Answer.', 'Done.  '].join('\n'), 'Answer.\nDone.', 'pondering'],
      [[...LEGACY, '　Answer.', 'Done.\r'].join('\n'), 'Answer.\nDone.', 'pondering'],
      [
        ['> **Thinking**', '> first', '', 'A.', '', '', '', '> **Thinking**', '> second', '', 'B.'].join('\n'),
        'A.\n\nB.',
        'first\n\nsecond',
      ],
      ['Plain  \nanswer', 'Plain  \nanswer', null],
    ];
    for (const [content, body, reasoning] of cases) {
      const split = splitChatThinking(content);
      expect(split.body).toBe(body);
      expect(split.reasoning).toBe(reasoning);
      const origins = chatThinkingLineOrigins(content);
      expect(origins.body.map((line) => line.text).join('\n')).toBe(split.body);
      expect(origins.reasoning.map((line) => line.text).join('\n')).toBe(split.reasoning ?? '');
    }
  });
});

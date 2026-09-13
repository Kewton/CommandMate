/**
 * `chatMarkdownFullCopyText` — what "copy the full message" hands over, and on
 * which rows it is offered at all (Issue #2545).
 *
 * ## What this file pins
 *
 *  1. **the stored row, byte for byte** — the answer and every folded section,
 *     which is what the bubble's copy handed over before #2544;
 *  2. **only where something was folded** — decided by `splitChatMarkdownBody`'s
 *     `folded`, so a row with no chips offers no second copy of the same text;
 *  3. **the tools-only turn** — the answer-only copy answers null there, and this
 *     one does not, so the row still has a way to copy what it ran.
 *
 * Every "offered" assertion carries a positive control on the source string, so
 * none of them can pass on a fixture that never held a folded section.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  chatMarkdownCopyText,
  chatMarkdownFullCopyText,
  splitChatMarkdownBody,
  type ChatMarkdownBodySplit,
} from '@/lib/chat/chat-markdown-body';
import {
  separateTurnBody,
  TURN_REASONING_LABEL,
  TURN_TOOL_LOG_LABEL,
} from '@/lib/hooks/sources/turn-body';

const ANSWER = 'Created `probe.txt` and wrote one line to it.';

/** A turn that answered, thought and called two tools, as the reader stores it. */
const WRITTEN = separateTurnBody([
  { kind: 'prose', text: ANSWER },
  { kind: 'reasoning', text: 'The write succeeded; now check the content.' },
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `apply_patch` — probe.txt' },
]).body;

/** A turn that only thought before answering. */
const THINKING_ONLY = separateTurnBody([
  { kind: 'prose', text: ANSWER },
  { kind: 'reasoning', text: 'The write succeeded.' },
]).body;

/** A turn that ran tools and said nothing. */
const TOOLS_ONLY = separateTurnBody([
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `Bash` — pwd' },
]).body;

/** A row from before #2272: the reasoning quoted inline. */
const LEGACY_THINKING = [`> **${TURN_REASONING_LABEL}**`, '>', '> Preparing', '', ANSWER].join('\n');

/** A row from before #2234 moved the log: the calls lead the body. */
const LEGACY_TOOL_RUN = ['- `Bash` — ls', '- `Read` — src/index.ts', '', ANSWER].join('\n');

function fullCopyOf(content: string): string | null {
  return chatMarkdownFullCopyText(content, splitChatMarkdownBody(content));
}

describe('[#2545] chatMarkdownFullCopyText — offered where a section was folded', () => {
  it.each([
    ['Thinking and Tool calls', WRITTEN, [TURN_REASONING_LABEL, TURN_TOOL_LOG_LABEL]],
    ['Thinking only', THINKING_ONLY, [TURN_REASONING_LABEL]],
    ['Tool calls only', TOOLS_ONLY, [TURN_TOOL_LOG_LABEL]],
    ['the legacy inline Thinking quote', LEGACY_THINKING, [TURN_REASONING_LABEL]],
  ])('hands over the whole stored row for %s', (_shape, content, labels) => {
    for (const label of labels) {
      expect(content, `positive control: ${label}`).toContain(`> **${label}`);
    }
    expect(splitChatMarkdownBody(content).folded).toBe(true);

    expect(fullCopyOf(content)).toBe(content);
  });

  it('hands over the whole stored row for the legacy leading tool run', () => {
    expect(LEGACY_TOOL_RUN.startsWith('- `Bash` — ls')).toBe(true);
    expect(fullCopyOf(LEGACY_TOOL_RUN)).toBe(LEGACY_TOOL_RUN);
  });

  it('differs from the answer-only copy on every row it is offered on', () => {
    for (const content of [WRITTEN, THINKING_ONLY, TOOLS_ONLY, LEGACY_THINKING, LEGACY_TOOL_RUN]) {
      const split = splitChatMarkdownBody(content);
      expect(chatMarkdownFullCopyText(content, split)).not.toBe(chatMarkdownCopyText(split));
    }
  });
});

describe('[#2545] chatMarkdownFullCopyText — not offered where nothing was folded', () => {
  it.each([
    ['a plain answer', 'Just the answer.'],
    ['an answer with its own quote and list', 'Just the answer.\n\n> a quote the agent wrote\n\n- a list\n'],
    ['an empty body', ''],
  ])('answers null for %s', (_shape, content) => {
    expect(splitChatMarkdownBody(content).folded).toBe(false);
    expect(fullCopyOf(content)).toBeNull();
  });
});

describe('[#2545] chatMarkdownFullCopyText — the tools-only turn', () => {
  it('is the one copy a row with a blank answer offers', () => {
    const split = splitChatMarkdownBody(TOOLS_ONLY);
    expect(split.body.trim()).toBe('');

    expect(chatMarkdownCopyText(split)).toBeNull();
    expect(chatMarkdownFullCopyText(TOOLS_ONLY, split)).toBe(TOOLS_ONLY);
  });
});

describe('[#2545] chatMarkdownFullCopyText — reads `folded`, not the content', () => {
  const split = (folded: boolean): ChatMarkdownBodySplit => ({
    body: 'anything',
    reasoning: null,
    reasoningBlocks: 0,
    toolLog: '',
    toolCalls: 0,
    folded,
  });

  it('follows the split it is handed rather than re-detecting sections', () => {
    // A body with both sections, told nothing was folded: no offer.
    expect(chatMarkdownFullCopyText(WRITTEN, split(false))).toBeNull();
    // A body with none, told something was: the content, unchanged.
    expect(chatMarkdownFullCopyText('Just the answer.', split(true))).toBe('Just the answer.');
  });
});

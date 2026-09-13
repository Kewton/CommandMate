/**
 * `splitChatMarkdownBody` — the one split behind a Markdown bubble's screen and
 * its clipboard (Issue #2544).
 *
 * ## What this file pins
 *
 *  1. **the answer is what is left** once both folded sections are off, in
 *     every shape the database holds: #2234 / #2272's trailing sections, the
 *     legacy inline `> **Thinking**` quotes, and the legacy leading run of
 *     `- \`Bash\` — …` lines;
 *  2. **byte identity** for a body neither splitter folds — the copy of every
 *     such row has to stay exactly what it was before this Issue;
 *  3. **the composition is the two splitters, in #2284's order**, so moving the
 *     split into one function changed nothing the chips show;
 *  4. **what copy hands over**, including the rows that must offer no copy.
 *
 * ## Non-vacuity
 *
 * Every fold assertion is paired with a positive control on the SOURCE string —
 * the section really is in the body being split — so none of them can pass on a
 * fixture that never carried what the Issue is about.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  chatMarkdownCopyText,
  splitChatMarkdownBody,
} from '@/lib/chat/chat-markdown-body';
import { splitChatThinking } from '@/lib/chat/chat-thinking';
import { splitToolLog } from '@/lib/chat/chat-tool-log';
import {
  separateTurnBody,
  TURN_REASONING_LABEL,
  TURN_TOOL_LOG_LABEL,
} from '@/lib/hooks/sources/turn-body';

// ---------------------------------------------------------------------------
// Fixtures — the strings the writers actually produce
// ---------------------------------------------------------------------------

const ANSWER = 'Created `probe.txt` and wrote one line to it.\n\n```sh\ncat probe.txt\n```';

/** What `separateTurnBody` writes for a turn that answered, thought and called tools. */
const WRITTEN = separateTurnBody([
  { kind: 'prose', text: 'Created `probe.txt` and wrote one line to it.' },
  { kind: 'prose', text: '```sh\ncat probe.txt\n```' },
  { kind: 'reasoning', text: 'The write succeeded.' },
  { kind: 'reasoning', text: 'Now check the content.' },
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `apply_patch` — probe.txt' },
]).body;

/** A row from before #2272: the reasoning quoted inline, above and below the answer. */
const LEGACY_THINKING = [
  `> **${TURN_REASONING_LABEL}**`,
  '>',
  '> Preparing for patch application',
  '',
  ANSWER,
  '',
  `> **${TURN_REASONING_LABEL}**`,
  '>',
  '> The write succeeded.',
].join('\n');

/** A row from before #2234 moved the log: the calls lead the body. */
const LEGACY_TOOL_RUN = ['- `Bash` — ls', '- `Read` — src/index.ts', '', ANSWER].join('\n');

// ---------------------------------------------------------------------------
// 1. The answer
// ---------------------------------------------------------------------------

describe('[#2544] splitChatMarkdownBody — the answer', () => {
  it('leaves the answer of a body `separateTurnBody` wrote, and nothing else', () => {
    // Positive control: the stored row carries both sections this Issue keeps
    // off the clipboard.
    expect(WRITTEN).toContain(`> **${TURN_REASONING_LABEL} (2)**`);
    expect(WRITTEN).toContain(`> **${TURN_TOOL_LOG_LABEL} (2)**`);

    const split = splitChatMarkdownBody(WRITTEN);

    // The Markdown SOURCE of the answer, fence and backticks intact.
    expect(split.body).toBe(ANSWER);
    expect(split.body).not.toContain(`**${TURN_REASONING_LABEL}`);
    expect(split.body).not.toContain(`**${TURN_TOOL_LOG_LABEL}`);
    expect(split.folded).toBe(true);
  });

  it('carries what each chip holds, with its count', () => {
    const split = splitChatMarkdownBody(WRITTEN);
    expect(split.reasoning).toBe('The write succeeded.\n\nNow check the content.');
    expect(split.reasoningBlocks).toBe(2);
    expect(split.toolLog).toBe('- `Bash` — ls\n- `apply_patch` — probe.txt');
    expect(split.toolCalls).toBe(2);
  });

  it('takes the legacy inline `Thinking` quotes off, wherever they sat', () => {
    expect(LEGACY_THINKING.split('\n')[0]).toBe(`> **${TURN_REASONING_LABEL}**`);

    const split = splitChatMarkdownBody(LEGACY_THINKING);
    expect(split.body).toBe(ANSWER);
    expect(split.reasoningBlocks).toBe(2);
    expect(split.folded).toBe(true);
  });

  it('takes the legacy leading run of tool lines off', () => {
    expect(LEGACY_TOOL_RUN.startsWith('- `Bash` — ls\n')).toBe(true);

    const split = splitChatMarkdownBody(LEGACY_TOOL_RUN);
    expect(split.body).toBe(ANSWER);
    expect(split.toolCalls).toBe(2);
    expect(split.folded).toBe(true);
  });

  it('answers an empty body for a turn that only ran tools', () => {
    const toolsOnly = separateTurnBody([
      { kind: 'tool', text: '- `Bash` — ls' },
      { kind: 'tool', text: '- `Bash` — pwd' },
    ]).body;
    expect(toolsOnly).toContain(`> **${TURN_TOOL_LOG_LABEL} (2)**`);

    const split = splitChatMarkdownBody(toolsOnly);
    expect(split.body).toBe('');
    expect(split.toolCalls).toBe(2);
    expect(split.folded).toBe(true);
  });

  it('answers an empty body for a turn that only thought and called tools', () => {
    const noAnswer = separateTurnBody([
      { kind: 'reasoning', text: 'Looking around first.' },
      { kind: 'tool', text: '- `Bash` — ls' },
    ]).body;

    const split = splitChatMarkdownBody(noAnswer);
    expect(split.body).toBe('');
    expect(split.reasoning).toBe('Looking around first.');
    expect(split.toolCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Byte identity
// ---------------------------------------------------------------------------

describe('[#2544] splitChatMarkdownBody — a body with nothing to fold', () => {
  it.each([
    ['a one-line answer', 'Just the answer.'],
    ['an answer with the edges the renderer would forgive', '\n  Leading blank and trailing space.  \n\n'],
    ['an ordinary blockquote the agent wrote', 'As the docs put it:\n\n> never trust the pane\n\nSo I read the file.'],
    ['a prose list', '- first\n- second'],
    ['a paragraph that merely names both labels', `**${TURN_REASONING_LABEL}** and **${TURN_TOOL_LOG_LABEL}** are words.`],
    ['a Thinking heading nested in a larger quote', `> a quote\n> **${TURN_REASONING_LABEL}**\n> same quote`],
    ['the empty string', ''],
  ])('comes back byte-identical: %s', (_name, content) => {
    const split = splitChatMarkdownBody(content);
    expect(split.body).toBe(content);
    expect(split.folded).toBe(false);
    expect(split.reasoning).toBeNull();
    expect(split.reasoningBlocks).toBe(0);
    expect(split.toolLog).toBe('');
    expect(split.toolCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The composition
// ---------------------------------------------------------------------------

describe('[#2544] splitChatMarkdownBody is the two splitters, tool log first', () => {
  it.each([
    ['the written shape', WRITTEN],
    ['the legacy Thinking shape', LEGACY_THINKING],
    ['the legacy tool run', LEGACY_TOOL_RUN],
  ])('agrees with splitToolLog → splitChatThinking on %s', (_name, content) => {
    // What `ChatMarkdownBody` computed by hand before this Issue. Pinned so the
    // move into one function cannot have changed a single chip.
    const tools = splitToolLog(content);
    const thinking = splitChatThinking(tools.prose);

    expect(splitChatMarkdownBody(content)).toEqual({
      body: thinking.body,
      reasoning: thinking.reasoning,
      reasoningBlocks: thinking.blocks,
      toolLog: tools.toolLog,
      toolCalls: tools.toolCalls,
      folded: true,
    });
  });

  it('counts a tool heading with no calls under it as folded, though it draws no chip', () => {
    const content = `Done.\n\n> **${TURN_TOOL_LOG_LABEL}**`;
    const split = splitChatMarkdownBody(content);
    expect(split.body).toBe('Done.');
    expect(split.toolCalls).toBe(0);
    expect(split.folded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. What copy hands over
// ---------------------------------------------------------------------------

describe('[#2544] chatMarkdownCopyText', () => {
  it('hands over the answer and not the folded sections', () => {
    const copied = chatMarkdownCopyText(splitChatMarkdownBody(WRITTEN));
    expect(copied).toBe(ANSWER);
    expect(copied).not.toContain(`> **${TURN_REASONING_LABEL}`);
    expect(copied).not.toContain(`> **${TURN_TOOL_LOG_LABEL}`);
  });

  it('hands over an unfolded body byte for byte', () => {
    const content = '\n  Leading blank and trailing space.  \n\n';
    expect(chatMarkdownCopyText(splitChatMarkdownBody(content))).toBe(content);
  });

  it('offers nothing — not the whole row — when the answer is blank', () => {
    // The fallback this Issue refuses: a whole-row copy is #2545's operation,
    // and falling back to it here would put exactly the folded sections back.
    const toolsOnly = separateTurnBody([{ kind: 'tool', text: '- `Bash` — ls' }]).body;
    expect(chatMarkdownCopyText(splitChatMarkdownBody(toolsOnly))).toBeNull();
    expect(chatMarkdownCopyText(splitChatMarkdownBody(''))).toBeNull();
    expect(chatMarkdownCopyText(splitChatMarkdownBody(' \n\n '))).toBeNull();
  });
});

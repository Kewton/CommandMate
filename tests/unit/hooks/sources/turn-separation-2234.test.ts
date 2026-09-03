/**
 * Separating an agent's own words from its tool log (Issue #2234).
 *
 * The Issue's complaint is about a *body*, so every assertion here is on a body
 * — the exact string that becomes `chat_messages.content` — and the two headline
 * cases are real captures rather than hand-written turns:
 *
 *  - `tests/fixtures/turn-separation-2234/` — one Claude Code turn, 30 unedited
 *    records, chosen from a 586-turn census because it is the shape the Issue
 *    describes: two `Bash` calls, then the sentence about them.
 *  - `tests/fixtures/hooks/opencode/history-turns-1-18-22.json` — the live SSE
 *    tap #2041 captured from opencode 1.18.22. Its middle turn is the same shape
 *    from the other reader.
 *
 * The `.before.md` half of the claude fixture is the body the code produced at
 * `362b6814`, which is what rows written before this Issue still hold. It is
 * asserted here for the acceptance condition "既存行が壊れずに表示される": those
 * rows are never rewritten (`writeClaudeTurn` stands down on
 * `findMessageByRequestId`), so what has to be shown is that the text they hold
 * still survives the card's Markdown pipeline — which is done below by running
 * the real pipeline over it.
 *
 * ## Issue #2272 extends this file rather than opening another
 *
 * The reasoning became a second folded section on the same mechanism, so its
 * assertions belong next to the tool log's. Its fixture is built inline from the
 * parts the Issue quotes, because the captured opencode tap has no `reasoning`
 * part in it at all — 1.18.22 emitted none for those three prompts — and the
 * `aside` path it contrasts against is the layout the code produced before the
 * change, run as a positive control rather than described.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import { describe, expect, it } from 'vitest';
import {
  separateTurnBody,
  TURN_REASONING_LABEL,
  TURN_TOOL_LOG_LABEL,
  type TurnRenderBlock,
} from '@/lib/hooks/sources/turn-body';
import {
  buildClaudeTurns,
  parseClaudeTranscript,
  renderClaudeTurn,
} from '@/lib/hooks/sources/claude/transcript';
import {
  addOpencodePart,
  claimOpencodeMessage,
  createOpencodeTurn,
  ownsOpencodeMessage,
  readOpencodePart,
  renderOpencodeTurn,
  type OpencodeTurnAccumulator,
} from '@/lib/hooks/sources/opencode/transcript';

const FIXTURES = join(process.cwd(), 'tests/fixtures/turn-separation-2234');
const OPENCODE_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

/** A fixture body file, with the one trailing newline the file adds removed. */
function bodyFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8').replace(/\n$/, '');
}

const CLAUDE_TRANSCRIPT = readFileSync(join(FIXTURES, 'claude-tool-first-turn.jsonl'), 'utf-8');
const BEFORE = bodyFixture('claude-tool-first-turn.before.md');
const AFTER = bodyFixture('claude-tool-first-turn.after.md');

/** The captured turn, through the production reader. */
function claudeFixtureBody(): string {
  const built = buildClaudeTurns(parseClaudeTranscript(CLAUDE_TRANSCRIPT).records, 'ses_2234');
  expect(built.turns).toHaveLength(1);
  return renderClaudeTurn(built.turns[0]).body;
}

/**
 * The card's Markdown pipeline, exactly as `ConversationPairCard` and
 * `ChatSurface` configure it: `remarkGfm` + `rehypeSanitize` + `rehypeHighlight`
 * and deliberately no `rehypeRaw`.
 */
function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown as never, {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [rehypeSanitize, rehypeHighlight],
      children: markdown,
    } as never)
  );
}

describe('separateTurnBody', () => {
  const blocks = (...items: TurnRenderBlock[]): readonly TurnRenderBlock[] => items;

  it('puts every prose block in front of every tool line', () => {
    const separated = separateTurnBody(
      blocks(
        { kind: 'tool', text: '- `Bash` — ls' },
        { kind: 'prose', text: 'Listed the directory.' },
        { kind: 'tool', text: '- `Bash` — pwd' },
        { kind: 'prose', text: 'And printed the path.' }
      )
    );
    expect(separated.body).toBe(
      [
        'Listed the directory.',
        '',
        'And printed the path.',
        '',
        `> **${TURN_TOOL_LOG_LABEL} (2)**`,
        '>',
        '> - `Bash` — ls',
        '> - `Bash` — pwd',
      ].join('\n')
    );
    expect(separated.prose).toBe('Listed the directory.\n\nAnd printed the path.');
    expect(separated.toolCalls).toBe(2);
  });

  it('keeps each half in the order the transcript had it', () => {
    const separated = separateTurnBody(
      blocks(
        { kind: 'prose', text: 'one' },
        { kind: 'tool', text: '- `a`' },
        { kind: 'prose', text: 'two' },
        { kind: 'tool', text: '- `b`' },
        { kind: 'prose', text: 'three' },
        { kind: 'tool', text: '- `c`' }
      )
    );
    expect(separated.prose).toBe('one\n\ntwo\n\nthree');
    expect(separated.toolLog).toBe(
      `> **${TURN_TOOL_LOG_LABEL} (3)**\n>\n> - \`a\`\n> - \`b\`\n> - \`c\``
    );
  });

  it('leaves a turn that called nothing byte-identical to the old layout', () => {
    // The whole point of the change is the section it adds; a turn with no
    // calls must not move a single byte, or every tool-free row in History
    // would disagree with the one the reader would write today.
    const separated = separateTurnBody(
      blocks(
        { kind: 'aside', text: '> **Thinking**\n>\n> weigh it up' },
        { kind: 'prose', text: '## Heading A\n\n- item one\n- item two' }
      )
    );
    expect(separated.body).toBe(
      '> **Thinking**\n>\n> weigh it up\n\n## Heading A\n\n- item one\n- item two'
    );
    expect(separated.toolLog).toBe('');
    expect(separated.toolCalls).toBe(0);
  });

  it('keeps a folded aside with the prose rather than with the tool log', () => {
    // An `aside` is text a reader already quoted itself, and it does not move.
    // #2272 left this kind alone precisely so the four readers that still use it
    // — claude, codex, antigravity, command-code — write the same bytes they
    // wrote before; the opencode reader moved to `reasoning` instead.
    const separated = separateTurnBody(
      blocks(
        { kind: 'tool', text: '- `Bash` — ls' },
        { kind: 'aside', text: '> **Thinking**\n>\n> weigh it up' },
        { kind: 'prose', text: 'Done.' }
      )
    );
    expect(separated.prose).toBe('> **Thinking**\n>\n> weigh it up\n\nDone.');
    expect(separated.body.startsWith('> **Thinking**')).toBe(true);
    expect(separated.reasoningLog).toBe('');
    expect(separated.reasoningBlocks).toBe(0);
  });

  it('emits the section alone when the turn only ran tools', () => {
    const separated = separateTurnBody(blocks({ kind: 'tool', text: '- `Bash` — ls' }));
    expect(separated.prose).toBe('');
    expect(separated.body).toBe(`> **${TURN_TOOL_LOG_LABEL} (1)**\n>\n> - \`Bash\` — ls`);
  });

  it('answers an empty body for no blocks at all', () => {
    expect(separateTurnBody([]).body).toBe('');
  });

  it('drops an empty block rather than opening a blank paragraph', () => {
    expect(separateTurnBody([{ kind: 'prose', text: '' }, { kind: 'prose', text: 'x' }]).body).toBe(
      'x'
    );
  });

  it('quotes every line of a tool block that somehow arrived multi-line', () => {
    // The readers collapse whitespace so this cannot happen from their side.
    // The guard is here because a line that escaped the quote would break out
    // of the blockquote and read as prose.
    const separated = separateTurnBody([{ kind: 'tool', text: '- `Bash` — a\n  continued' }]);
    expect(separated.toolLog.split('\n').every((line) => line.startsWith('>'))).toBe(true);
  });
});

describe('[#2272] separateTurnBody and the reasoning section', () => {
  const blocks = (...items: TurnRenderBlock[]): readonly TurnRenderBlock[] => items;

  it('lifts every reasoning block out of the prose into one trailing section', () => {
    const separated = separateTurnBody(
      blocks(
        { kind: 'reasoning', text: 'weigh it up' },
        { kind: 'prose', text: 'The answer.' },
        { kind: 'reasoning', text: 'weigh it again' }
      )
    );
    expect(separated.prose).toBe('The answer.');
    expect(separated.reasoningLog).toBe(
      `> **${TURN_REASONING_LABEL} (2)**\n>\n> weigh it up\n>\n> weigh it again`
    );
    expect(separated.reasoningBlocks).toBe(2);
    expect(separated.body).toBe(`The answer.\n\n${separated.reasoningLog}`);
  });

  it('orders the body prose, then reasoning, then the tool log', () => {
    const separated = separateTurnBody(
      blocks(
        { kind: 'reasoning', text: 'plan it' },
        { kind: 'tool', text: '- `Bash` — ls' },
        { kind: 'prose', text: 'Listed it.' }
      )
    );
    expect(separated.body).toBe(
      [
        'Listed it.',
        '',
        `> **${TURN_REASONING_LABEL} (1)**`,
        '>',
        '> plan it',
        '',
        `> **${TURN_TOOL_LOG_LABEL} (1)**`,
        '>',
        '> - `Bash` — ls',
      ].join('\n')
    );
  });

  it('keeps a blank quote line between two thoughts so they stay two paragraphs', () => {
    // Without the `>` separator the two blocks would run into one Markdown
    // paragraph and the reader would lose the boundary between two thoughts.
    const separated = separateTurnBody(
      blocks({ kind: 'reasoning', text: 'one' }, { kind: 'reasoning', text: 'two' })
    );
    expect(separated.reasoningLog.split('\n')).toEqual([
      `> **${TURN_REASONING_LABEL} (2)**`,
      '>',
      '> one',
      '>',
      '> two',
    ]);
  });

  it('quotes a multi-paragraph thought line by line, blank lines included', () => {
    const separated = separateTurnBody([{ kind: 'reasoning', text: 'first\n\nsecond' }]);
    expect(separated.reasoningLog.split('\n').every((line) => line.startsWith('>'))).toBe(true);
    expect(separated.reasoningLog).toContain('> first\n>\n> second');
  });

  it('leaves a turn with no reasoning byte-identical to what #2234 produced', () => {
    // The regression guard for the four readers this Issue does not touch.
    const separated = separateTurnBody(
      blocks(
        { kind: 'prose', text: 'Done.' },
        { kind: 'tool', text: '- `Bash` — ls' }
      )
    );
    expect(separated.body).toBe(`Done.\n\n> **${TURN_TOOL_LOG_LABEL} (1)**\n>\n> - \`Bash\` — ls`);
    expect(separated.reasoningLog).toBe('');
  });

  it('drops an empty reasoning block rather than counting it', () => {
    const separated = separateTurnBody(
      blocks({ kind: 'reasoning', text: '' }, { kind: 'prose', text: 'x' })
    );
    expect(separated.body).toBe('x');
    expect(separated.reasoningBlocks).toBe(0);
  });
});

describe('the captured claude turn', () => {
  it('opened with a tool log before this Issue', () => {
    // Non-vacuity: without this the assertions below would pass on a fixture
    // that never had the defect.
    expect(BEFORE.split('\n')[0].startsWith('- `Bash` — ')).toBe(true);
    expect(BEFORE).toContain('Batch 1: **3/3 exit 0**');
  });

  it('now opens with the agent’s own sentence', () => {
    const body = claudeFixtureBody();
    expect(body).toBe(AFTER);
    expect(body.split('\n')[0]).toBe(
      'Batch 1: **3/3 exit 0** (load 10.4 / 31.5 / 37.5). Hot batch is running — it waits for load avg ≥ 55 before the first run.'
    );
  });

  it('keeps both sentences and all three calls, and moves nothing else', () => {
    const body = claudeFixtureBody();
    const [prose, toolLog] = body.split(`\n\n> **${TURN_TOOL_LOG_LABEL} (3)**\n>\n`);
    expect(prose.split('\n\n')).toEqual([
      'Batch 1: **3/3 exit 0** (load 10.4 / 31.5 / 37.5). Hot batch is running — it waits for load avg ≥ 55 before the first run.',
      'Batch 1 green 3/3. Waiting on the saturated-load batch before the final gate run and commit.',
    ]);
    // The three calls, in the order the agent made them, each still one line.
    expect(toolLog.split('\n').map((line) => line.slice(0, 14))).toEqual([
      '> - `Bash` — S',
      '> - `Bash` — S',
      '> - `Monitor` ',
    ]);
  });

  it('is the same set of lines as before, re-ordered and quoted — nothing lost', () => {
    const strip = (body: string): string[] =>
      body
        .split('\n')
        .map((line) => line.replace(/^> ?/, ''))
        .filter((line) => line.length > 0 && !line.startsWith(`**${TURN_TOOL_LOG_LABEL}`));
    expect([...strip(claudeFixtureBody())].sort()).toEqual([...strip(BEFORE)].sort());
  });
});

describe('the captured opencode turn', () => {
  interface Frame {
    type: string;
    properties: Record<string, unknown>;
  }

  const FRAMES: Frame[] = JSON.parse(
    readFileSync(join(OPENCODE_FIXTURES, 'history-turns-1-18-22.json'), 'utf-8')
  ) as Frame[];

  /**
   * Replay the captured stream the way `./history` does — the same rule
   * `opencode-transcript-2041.test.ts` states: `message.updated(assistant)`
   * opens a turn keyed on `parentID`, `message.part.updated` fills a slot, and
   * a part may only join a turn that has claimed its message.
   */
  function replay(): Map<string, OpencodeTurnAccumulator> {
    const open = new Map<string, OpencodeTurnAccumulator>();
    const done = new Map<string, OpencodeTurnAccumulator>();
    for (const frame of FRAMES) {
      const sessionId = frame.properties.sessionID as string;
      if (frame.type === 'message.updated') {
        const info = frame.properties.info as Record<string, unknown> | undefined;
        if (!info || info.role !== 'assistant') continue;
        const parent = info.parentID as string | undefined;
        if (!parent) continue;
        const existing = open.get(sessionId);
        const turn =
          existing?.userMessageId === parent ? existing : createOpencodeTurn(sessionId, parent, 0);
        if (turn !== existing) open.set(sessionId, turn);
        claimOpencodeMessage(turn, info.id as string);
        continue;
      }
      if (frame.type === 'message.part.updated') {
        const part = readOpencodePart(frame.properties.part);
        const turn = open.get(sessionId);
        if (part && turn && ownsOpencodeMessage(turn, part.messageId)) addOpencodePart(turn, part);
        continue;
      }
      if (frame.type === 'session.idle') {
        const turn = open.get(sessionId);
        if (turn) {
          done.set(turn.userMessageId, turn);
          open.delete(sessionId);
        }
      }
    }
    return done;
  }

  it('leads with the sentence and folds the bash call behind it', () => {
    const turn = replay().get('msg_user0000000000000000002');
    expect(turn).toBeDefined();
    const body = renderOpencodeTurn(turn as OpencodeTurnAccumulator).body;
    expect(body).toBe(
      [
        'It printed `CMATE-2041-TOOL-MARKER`.',
        '',
        `> **${TURN_TOOL_LOG_LABEL} (1)**`,
        '>',
        '> - `bash` — echo CMATE-2041-TOOL-MARKER',
      ].join('\n')
    );
  });
});

/**
 * The shape Issue #2272 reports, through the production opencode renderer.
 *
 * Not a captured file, because `tests/fixtures/hooks/opencode`'s three-turn tap
 * has no `reasoning` part in it at all — opencode 1.18.22 emitted none for those
 * prompts. The parts below are the ones the Issue quotes verbatim from a live
 * session (four reasoning blocks around one sentence and one `apply_patch`), fed
 * through `readOpencodePart` so they arrive by the same route a frame does.
 */
describe('[#2272] an opencode turn with four reasoning blocks', () => {
  const REASONING = [
    '**Preparing for patch application**\n\nI think I need to edit the patch application process. First, I must verify the file does not already exist.',
    'The write succeeded. Now check the content is exactly one line.',
    'Reading it back confirms `hello` with a trailing newline.',
    'Nothing else to do — report what was written.',
  ];
  const PROSE = 'カレントディレクトリに `probe.txt` を作成し、`hello` の1行を書き込みました。';

  /** The turn, with the parts in the order the server produced them. */
  function fixtureTurn(): OpencodeTurnAccumulator {
    const turn = createOpencodeTurn('ses_2272', 'msg_user2272', 0);
    claimOpencodeMessage(turn, 'msg_a');
    const raw: Record<string, unknown>[] = [
      { id: 'prt_1', type: 'reasoning', text: REASONING[0] },
      {
        id: 'prt_2',
        type: 'tool',
        tool: 'apply_patch',
        state: { status: 'completed', title: 'probe.txt' },
      },
      { id: 'prt_3', type: 'reasoning', text: REASONING[1] },
      { id: 'prt_4', type: 'reasoning', text: REASONING[2] },
      { id: 'prt_5', type: 'text', text: PROSE },
      { id: 'prt_6', type: 'reasoning', text: REASONING[3] },
    ];
    for (const entry of raw) {
      const part = readOpencodePart({ messageID: 'msg_a', ...entry });
      expect(part).not.toBeNull();
      addOpencodePart(turn, part!);
    }
    return turn;
  }

  /** The pre-#2272 layout of the same turn: each thought quoted where it sat. */
  function beforeBody(): string {
    const quote = (text: string): string =>
      `> **${TURN_REASONING_LABEL}**\n>\n${text
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n')}`;
    return separateTurnBody([
      { kind: 'aside', text: quote(REASONING[0]) },
      { kind: 'tool', text: '- `apply_patch` — probe.txt' },
      { kind: 'aside', text: quote(REASONING[1]) },
      { kind: 'aside', text: quote(REASONING[2]) },
      { kind: 'prose', text: PROSE },
      { kind: 'aside', text: quote(REASONING[3]) },
    ]).body;
  }

  it('opened with a Thinking quote before this Issue', () => {
    // Non-vacuity, the same way the claude fixture above earns its assertions:
    // without this the claims below would pass on a turn that never had the
    // defect. `beforeBody` is the OLD code path — `aside` blocks, which
    // `separateTurnBody` still leaves inline — so this is the mutation the
    // Issue asks for, run as a positive control rather than by hand.
    const before = beforeBody();
    expect(before.split('\n')[0]).toBe(`> **${TURN_REASONING_LABEL}**`);
    expect(before.indexOf('Preparing for patch application')).toBeLessThan(
      before.indexOf(PROSE)
    );
    // Four separate labelled quotes, which is what "reasoning が 4 ブロック挟まる"
    // means on the screen.
    expect(before.split(`> **${TURN_REASONING_LABEL}**`)).toHaveLength(5);
  });

  it('now leads with the answer and folds both sections behind it', () => {
    const rendered = renderOpencodeTurn(fixtureTurn());
    expect(rendered.reasoningParts).toBe(4);
    expect(rendered.toolParts).toBe(1);
    expect(rendered.body).toBe(
      [
        PROSE,
        '',
        `> **${TURN_REASONING_LABEL} (4)**`,
        '>',
        '> **Preparing for patch application**',
        '>',
        '> I think I need to edit the patch application process. First, I must verify the file does not already exist.',
        '>',
        '> The write succeeded. Now check the content is exactly one line.',
        '>',
        '> Reading it back confirms `hello` with a trailing newline.',
        '>',
        '> Nothing else to do — report what was written.',
        '',
        `> **${TURN_TOOL_LOG_LABEL} (1)**`,
        '>',
        '> - `apply_patch` — probe.txt',
      ].join('\n')
    );
  });

  it('loses not one line of what the old layout held', () => {
    // Re-ordered and re-labelled, never dropped: the reasoning is folded, not
    // discarded, which is the Issue's own scope note.
    const strip = (body: string): string[] =>
      body
        .split('\n')
        .map((line) => line.replace(/^> ?/, ''))
        .filter(
          (line) =>
            line.length > 0 &&
            !line.startsWith(`**${TURN_TOOL_LOG_LABEL}`) &&
            !line.startsWith(`**${TURN_REASONING_LABEL}`)
        );
    expect([...strip(renderOpencodeTurn(fixtureTurn()).body)].sort()).toEqual(
      [...strip(beforeBody())].sort()
    );
  });

  it('renders as one paragraph and two quoted sections, answer first', () => {
    const html = renderMarkdown(renderOpencodeTurn(fixtureTurn()).body);
    expect(html.match(/<blockquote>/g)).toHaveLength(2);
    expect(html).toContain(`<strong>${TURN_REASONING_LABEL} (4)</strong>`);
    expect(html).toContain(`<strong>${TURN_TOOL_LOG_LABEL} (1)</strong>`);
    expect(html.indexOf('probe.txt')).toBeLessThan(html.indexOf('<blockquote>'));
  });
});

describe('what the card does with the body', () => {
  it('renders the folded section as a quoted list, label intact', () => {
    const html = renderMarkdown(AFTER);
    expect(html).toContain('<blockquote>');
    expect(html).toContain(`<strong>${TURN_TOOL_LOG_LABEL} (3)</strong>`);
    // The three calls survive as list items inside the quote.
    expect(html.match(/<li>/g)).toHaveLength(3);
    // And the agent's sentence is a paragraph OUTSIDE the quote — which is the
    // whole claim of this Issue, checked on the rendered output.
    expect(html.indexOf('Batch 1: ')).toBeLessThan(html.indexOf('<blockquote>'));
  });

  it('would have dropped a <details> wrapper whole, which is why one is not used', () => {
    // Measured, not assumed. No `rehypeRaw` means raw HTML never becomes an
    // element: the wrapper AND its `<summary>` label vanish, leaving a bare
    // list with nothing to say what it is.
    const html = renderMarkdown(
      `<details>\n<summary>${TURN_TOOL_LOG_LABEL}</summary>\n\n- \`Bash\` — ls\n\n</details>`
    );
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
    expect(html).not.toContain(TURN_TOOL_LOG_LABEL);
    expect(html).toContain('<li>');
  });

  it('still renders a row saved before the change, unchanged', () => {
    // The acceptance condition. Existing rows keep the `.before.md` text — they
    // are matched by `request_id` and never rewritten — so what must hold is
    // that nothing this Issue adds affects them.
    const html = renderMarkdown(BEFORE);
    expect(html).toContain('Batch 1 green 3/3.');
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).not.toContain('<blockquote>');
    expect(html).not.toContain(TURN_TOOL_LOG_LABEL);
  });
});

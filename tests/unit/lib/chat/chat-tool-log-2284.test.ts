/**
 * `splitToolLog` — taking the tool section out of a chat body (Issue #2284).
 *
 * ## What this reader has to survive
 *
 * Three shapes are in the database at once and none of them can be migrated:
 *
 *  1. **#2234's section**, written by `separateTurnBody` and therefore by all
 *     five transcript readers: prose, then an optional `Thinking (N)` quote,
 *     then a trailing `> **Tool calls (N)**` blockquote;
 *  2. **the legacy leading run** the readers wrote before #2234 — `- \`Bash\`
 *     — ls` lines at the TOP of the body, measured on 141 of 586 real claude
 *     turns;
 *  3. **everything else** — a hand-typed message, a terminal scrape, a reply
 *     that merely ends in a quotation — which must come back untouched.
 *
 * The third is the one worth being strict about, so the "no tool log" cases
 * below assert BYTE identity rather than "looks about right": this function
 * runs on every Markdown bubble in the column on every render, and a body it
 * quietly reshapes is a paragraph the reader watches change for no reason.
 *
 * ## Non-vacuity
 *
 * Every fold assertion is built from `separateTurnBody`'s own output or from a
 * fixture that is checked for the defect first, so a test cannot pass because
 * the input never had a tool log in it. The two `describe`s at the end are the
 * mutations the Issue names: drop the "must be the LAST block" rule, or the
 * "every line from here is quoted" rule, and a body loses text it should have
 * kept.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { splitToolLog } from '@/lib/chat/chat-tool-log';
import {
  separateTurnBody,
  TURN_REASONING_LABEL,
  TURN_TOOL_LOG_LABEL,
  type TurnRenderBlock,
} from '@/lib/hooks/sources/turn-body';

// ---------------------------------------------------------------------------
// Fixtures — the strings the writers actually produce
// ---------------------------------------------------------------------------

/** What `separateTurnBody` writes for a turn that answered and called two tools. */
const BLOCKS: readonly TurnRenderBlock[] = [
  { kind: 'prose', text: 'Created `probe.txt` and wrote one line to it.' },
  { kind: 'reasoning', text: 'The write succeeded. Now check the content.' },
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `apply_patch` — probe.txt' },
];

const WRITTEN = separateTurnBody(BLOCKS);

/** A real row from before #2234 moved the log: the calls lead the body. */
const LEGACY_SHAPE = [
  '- `Bash` — ls',
  '- `Read` — src/index.ts',
  '',
  'Here is what I found.',
].join('\n');

describe('[#2284] splitToolLog — the trailing section', () => {
  it('splits the body `separateTurnBody` actually writes', () => {
    // Positive control on the producer: the fixture is the writer's own output
    // and it really does end with the section this function has to find.
    expect(WRITTEN.body).toContain(`> **${TURN_TOOL_LOG_LABEL} (2)**`);
    expect(WRITTEN.body.endsWith('> - `apply_patch` — probe.txt')).toBe(true);

    const split = splitToolLog(WRITTEN.body);

    expect(split.toolCalls).toBe(2);
    expect(split.toolLog).toBe('- `Bash` — ls\n- `apply_patch` — probe.txt');
    // The prose keeps the answer AND the reasoning quote: folding that one is
    // `splitChatThinking`'s job, and doing it twice would nest chip in chip.
    expect(split.prose).toContain('Created `probe.txt` and wrote one line to it.');
    expect(split.prose).toContain(`> **${TURN_REASONING_LABEL} (1)**`);
    // Nothing of the section is left behind in the prose.
    expect(split.prose).not.toContain(TURN_TOOL_LOG_LABEL);
    expect(split.prose).not.toContain('apply_patch');
    // And no blank line is left hanging where the section was cut off.
    expect(split.prose.endsWith('\n')).toBe(false);
  });

  it('leaves a `Thinking` section in the prose, wherever it sits', () => {
    const body = [
      'Done.',
      '',
      `> **${TURN_REASONING_LABEL} (1)**`,
      '>',
      '> I should check the file first.',
      '',
      `> **${TURN_TOOL_LOG_LABEL} (1)**`,
      '>',
      '> - `Read` — probe.txt',
    ].join('\n');

    const split = splitToolLog(body);

    expect(split.prose).toBe(
      [
        'Done.',
        '',
        `> **${TURN_REASONING_LABEL} (1)**`,
        '>',
        '> I should check the file first.',
      ].join('\n'),
    );
    expect(split.toolLog).toBe('- `Read` — probe.txt');
    expect(split.toolCalls).toBe(1);
  });

  it('reports an empty prose for a turn that only ran tools', () => {
    const toolsOnly = separateTurnBody([
      { kind: 'tool', text: '- `Bash` — ls' },
      { kind: 'tool', text: '- `Bash` — pwd' },
      { kind: 'tool', text: '- `Bash` — whoami' },
    ]).body;
    expect(toolsOnly.startsWith(`> **${TURN_TOOL_LOG_LABEL} (3)**`)).toBe(true);

    const split = splitToolLog(toolsOnly);

    expect(split.prose).toBe('');
    expect(split.toolCalls).toBe(3);
    expect(split.toolLog.split('\n')).toHaveLength(3);
  });

  it('counts the entries when the heading declares no number', () => {
    // The shape a reader would produce if it stopped writing the count. The
    // chip still has to say how many rows it is hiding.
    const body = [
      'Done.',
      '',
      `> **${TURN_TOOL_LOG_LABEL}**`,
      '>',
      '> - `Bash` — ls',
      '> - `Bash` — pwd',
    ].join('\n');

    expect(splitToolLog(body).toolCalls).toBe(2);
  });
});

describe('[#2284] splitToolLog — the legacy leading run', () => {
  it('lifts a leading run of call lines out of the body', () => {
    // Positive control: the fixture has the #2234 defect — the row OPENS with
    // the log, which is what made 24 % of claude bubbles start with `- \`Bash\``.
    expect(LEGACY_SHAPE.split('\n')[0]).toBe('- `Bash` — ls');

    const split = splitToolLog(LEGACY_SHAPE);

    expect(split.toolCalls).toBe(2);
    expect(split.toolLog).toBe('- `Bash` — ls\n- `Read` — src/index.ts');
    expect(split.prose).toBe('Here is what I found.');
  });

  it('takes a call with no detail as readily as one with', () => {
    const split = splitToolLog('- `Bash`\n\nDone.');

    expect(split.toolCalls).toBe(1);
    expect(split.toolLog).toBe('- `Bash`');
    expect(split.prose).toBe('Done.');
  });

  it('leaves an ordinary Markdown list alone', () => {
    // A reply that opens with a bullet list is prose. Only a backticked first
    // token — the shape both `renderToolBlock` and `renderToolItem` compose —
    // is a tool line.
    const list = '- first thing\n- second thing\n\nThat is all.';

    expect(splitToolLog(list).prose).toBe(list);
    expect(splitToolLog(list).toolCalls).toBe(0);
  });
});

describe('[#2284] splitToolLog — bodies it must not touch', () => {
  const untouched: readonly [string, string][] = [
    ['a plain answer', 'Just the answer.'],
    ['an empty body', ''],
    [
      'a reply that ends in a quotation',
      'As the docs put it:\n\n> never trust the pane',
    ],
    [
      'a reply that only mentions tool calls',
      'I made two Tool calls before answering; both failed.',
    ],
    [
      'a body with only a reasoning section',
      `Done.\n\n> **${TURN_REASONING_LABEL} (1)**\n>\n> That was easy.`,
    ],
    [
      'a heading nested inside somebody else’s blockquote',
      [
        'The log looked like this:',
        '',
        '> Here is what the agent wrote:',
        `> **${TURN_TOOL_LOG_LABEL} (1)**`,
        '>',
        '> - `Bash` — ls',
      ].join('\n'),
    ],
  ];

  for (const [name, body] of untouched) {
    it(`returns ${name} byte-identical`, () => {
      const split = splitToolLog(body);
      expect(split.prose).toBe(body);
      expect(split.toolLog).toBe('');
      expect(split.toolCalls).toBe(0);
    });
  }

  it('is pure: the same input gives the same answer', () => {
    expect(splitToolLog(WRITTEN.body)).toEqual(splitToolLog(WRITTEN.body));
  });
});

// ---------------------------------------------------------------------------
// The mutations the Issue names
// ---------------------------------------------------------------------------

describe('[#2284] splitToolLog — what the two rules are load-bearing for', () => {
  it('does not fold a section that is not the last block', () => {
    // Drop the "the section ENDS the body" rule and this body loses its final
    // paragraph — the reply itself — into the chip.
    const body = [
      `> **${TURN_TOOL_LOG_LABEL} (1)**`,
      '>',
      '> - `Bash` — ls',
      '',
      'And here is the answer.',
    ].join('\n');

    const split = splitToolLog(body);

    expect(split.toolCalls).toBe(0);
    expect(split.prose).toBe(body);
    expect(split.prose).toContain('And here is the answer.');
  });

  it('does not fold when an unquoted line follows the heading', () => {
    // Drop the "every line from here is quoted" rule and the paragraph below
    // the quote is swallowed by the chip.
    const body = [
      'Done.',
      '',
      `> **${TURN_TOOL_LOG_LABEL} (1)**`,
      '>',
      '> - `Bash` — ls',
      'This line is not part of the quote.',
    ].join('\n');

    const split = splitToolLog(body);

    expect(split.toolCalls).toBe(0);
    expect(split.prose).toBe(body);
  });

  it('agrees with the writer on how many calls there were', () => {
    // The seam between the producer's count and the chip's label. Two
    // constants would drift; this is the assertion that says they have not.
    expect(splitToolLog(WRITTEN.body).toolCalls).toBe(WRITTEN.toolCalls);
  });
});

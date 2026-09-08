/**
 * Reading codex's rollout JSONL back into the reply it wrote (Issue #2197).
 *
 * Fixture-driven, against **real** rollout files captured off codex-cli 0.151.0
 * — see `tests/fixtures/transcripts/codex/README.md` for how, and
 * `docs/design/codex-transcript-reader.md` for what the capture measured. The
 * point of using real files rather than hand-written ones is the same as
 * #2041's and #2121's: a hand-written fixture agrees with the reader by
 * construction, and every defect this module can have is a disagreement between
 * the reader and the *file*.
 *
 * The file-touching half — which rollout belongs to this instance, what happens
 * when it is missing — is pinned in `./codex-history-2197.test.ts`.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildCodexTurns,
  parseCodexRollout,
  readCodexRolloutItem,
  renderCodexTurn,
  CODEX_THINKING_LABEL,
  MAX_CODEX_TOOL_DETAIL_LENGTH,
  MAX_CODEX_TURN_ITEMS,
  type CodexTurnAccumulator,
} from '@/lib/hooks/sources/codex/transcript';
import { TURN_REASONING_LABEL, TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

const FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/codex');

/** The three-turn session: text only, a shell call, and a Markdown answer. */
const THREE_TURNS = readFileSync(join(FIXTURES, 'rollout-three-turns-01510.jsonl'), 'utf8');
/** The session `/new` opened, whose second turn edits a file. */
const AFTER_NEW = readFileSync(join(FIXTURES, 'rollout-after-new-01510.jsonl'), 'utf8');
/** The second codex running in the same directory at the same time. */
const SECOND_INSTANCE = readFileSync(
  join(FIXTURES, 'rollout-second-instance-01510.jsonl'),
  'utf8'
);
/** The hook payloads those three sessions actually posted. */
const HOOK_EVENTS = JSON.parse(
  readFileSync(join(FIXTURES, 'hook-events-01510.json'), 'utf8')
) as Array<{ pane: string; event: string; payload: Record<string, string> }>;

const THREE_TURNS_SESSION = '01a05a82-d71b-7bc3-8901-487b0db19d40';
const AFTER_NEW_SESSION = '01a05a85-f872-79d3-85c3-c1933dc86828';
const SECOND_INSTANCE_SESSION = '01a05a85-2e16-7253-96be-cd143be9049c';

function turnsOf(text: string, sessionId: string): readonly CodexTurnAccumulator[] {
  return buildCodexTurns(parseCodexRollout(text).records, sessionId).turns;
}

function bodiesOf(text: string, sessionId: string): string[] {
  return turnsOf(text, sessionId).map((turn) => renderCodexTurn(turn).body);
}

describe('[#2197] turn boundaries', () => {
  it('splits the captured session on `turn_id`, in file order', () => {
    const turns = turnsOf(THREE_TURNS, THREE_TURNS_SESSION);
    expect(turns.map((turn) => turn.turnId)).toEqual([
      '01a05a83-0933-7723-8eb2-2e459b5a1ebd',
      '01a05a83-a87d-7362-80fe-027b7584e589',
      '01a05a84-76f2-7390-83f3-51ea1346a364',
    ]);
  });

  it('keeps a turn together across the records codex interleaves into it', () => {
    // `token_count` carries no `turn_id` and lands between a turn's items. A
    // reader that grouped on file order alone would split the second turn in
    // two at that line — the turn that has a tool call in the middle of it is
    // the one where this matters.
    const turns = turnsOf(THREE_TURNS, THREE_TURNS_SESSION);
    expect(turns[1].items.map((item) => item.type)).toEqual([
      'AgentMessage',
      'CommandExecution',
      'AgentMessage',
    ]);
  });

  it('marks every captured turn closed, because codex wrote `task_complete`', () => {
    expect(turnsOf(THREE_TURNS, THREE_TURNS_SESSION).map((turn) => turn.closed)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('leaves a turn open when its `task_complete` has not been written yet', () => {
    // The shape of a read taken while the agent is still answering: everything
    // up to the last `task_complete` is there and the closing record is not.
    const cut = THREE_TURNS.split('\n');
    const lastComplete = cut.findLastIndex((line) => line.includes('"task_complete"'));
    const truncated = cut.slice(0, lastComplete).join('\n');

    const turns = turnsOf(truncated, THREE_TURNS_SESSION);
    expect(turns.at(-1)?.closed).toBe(false);
    // The body is still readable; `./history` is what refuses to save it.
    expect(renderCodexTurn(turns.at(-1) as CodexTurnAccumulator).body).toContain('## Result');
  });

  it('dates a turn by the first record that carried its id', () => {
    const turns = turnsOf(THREE_TURNS, THREE_TURNS_SESSION);
    expect(turns[0].startedAt).toBe(Date.parse('2026-09-01T01:08:52.185Z'));
  });

  it('carries the session id off `session_meta` rather than trusting the caller', () => {
    const turns = turnsOf(THREE_TURNS, 'not-the-session-in-the-file');
    expect(new Set(turns.map((turn) => turn.sessionId))).toEqual(new Set([THREE_TURNS_SESSION]));
  });
});

describe('[#2197] the operator’s own prompts', () => {
  it('records exactly one prompt per captured turn, with the text that was typed', () => {
    const turns = turnsOf(THREE_TURNS, THREE_TURNS_SESSION);
    expect(turns.map((turn) => turn.prompts.map((prompt) => prompt.text))).toEqual([
      ['Reply with exactly: PONG-1'],
      [
        'Run the shell command: echo CMATE-2197 > marker.txt   then read marker.txt back and report its contents in one short sentence.',
      ],
      [
        'Reply with exactly this markdown and nothing else: a level-2 heading "## Result", then a blank line, then a bullet list with two items "alpha" and "beta", then a blank line, then the sentence "Done." in bold.',
      ],
    ]);
  });

  it('names each prompt by the `UserMessage` item’s own id', () => {
    // Not the turn id: codex folds a prompt submitted mid-turn into the same
    // turn (measured on 23 of 326 archived turns), so the turn id is not unique
    // per prompt and a row keyed on it would swallow the second one.
    const turns = turnsOf(THREE_TURNS, THREE_TURNS_SESSION);
    expect(turns[0].prompts[0].itemId).toBe('01a05a83-0ffb-7563-afdb-1d9277ff5242');
    expect(turns[0].prompts[0].itemId).not.toBe(turns[0].turnId);
  });

  it('does not mistake codex’s injected `role: "user"` records for the operator', () => {
    // The same file carries `<environment_context>` and the plugin
    // recommendations as `response_item` messages with `role: "user"`. If any of
    // them reached a prompt, the first turn would have more than one — and
    // History would show machinery as something the human said.
    const firstTurn = turnsOf(THREE_TURNS, THREE_TURNS_SESSION)[0];
    expect(firstTurn.prompts).toHaveLength(1);
    // The injected records are in the fixture — their bodies are elided, but
    // codex's own label for them survives, and there are two of them in the
    // turn that produced exactly one prompt.
    expect(THREE_TURNS).toContain('environments.environment_context');
    expect(THREE_TURNS).toContain('"role": "user"');
  });

  it('keeps two prompts in one turn as two rows-to-be', () => {
    // Synthesised from the archived shape rather than captured — the live
    // capture had no mid-turn submission. The property under test is the
    // grouping, and the record shape is the fixture's, field for field.
    const extra = JSON.stringify({
      timestamp: '2026-09-01T01:08:54.000Z',
      ordinal: 999,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: THREE_TURNS_SESSION,
        turn_id: '01a05a83-0933-7723-8eb2-2e459b5a1ebd',
        item: {
          type: 'UserMessage',
          id: '01a05a83-0ffb-7563-afdb-000000000002',
          content: [{ type: 'text', text: 'and also say PONG-2', text_elements: [] }],
        },
      },
    });
    const turns = turnsOf(`${THREE_TURNS}${extra}\n`, THREE_TURNS_SESSION);
    expect(turns[0].prompts.map((prompt) => prompt.itemId)).toEqual([
      '01a05a83-0ffb-7563-afdb-1d9277ff5242',
      '01a05a83-0ffb-7563-afdb-000000000002',
    ]);
  });
});

describe('[#2197] the Markdown body', () => {
  it('is the agent’s own Markdown, not the pane’s rendering', () => {
    const bodies = bodiesOf(THREE_TURNS, THREE_TURNS_SESSION);
    expect(bodies[2]).toBe('## Result\n\n- alpha\n- beta\n\n**Done.**');
  });

  it('never contains the operator’s prompt', () => {
    // The defect #2121 measured on claude — 9,584 of 13,253 saved characters
    // were the human's own echoed prompt — is structurally impossible here, and
    // that is worth asserting rather than asserting about.
    const bodies = bodiesOf(THREE_TURNS, THREE_TURNS_SESSION);
    for (const body of bodies) {
      expect(body).not.toContain('Reply with exactly');
      expect(body).not.toContain('Run the shell command');
    }
  });

  it('leads with the answer and folds the commentary and the call behind it', () => {
    // REWRITTEN BY #2420. This test used to pin the opposite — that "the
    // commentary and the answer keep their order and lead" — and that
    // expectation stopped being right for a reason outside this file:
    //
    //  - #2197 kept the commentary in the body because it explained the tool
    //    line printed directly underneath it.
    //  - #2234 then moved every tool line into the folded section at the end,
    //    so there is no line underneath the commentary any more. What led the
    //    bubble was narration with nothing left to narrate.
    //
    // #2420 therefore folds `phase: 'commentary'` and leaves the answer
    // leading. The `exec` line is where #2234 put it; only the first paragraph
    // moved.
    const bodies = bodiesOf(THREE_TURNS, THREE_TURNS_SESSION);
    expect(bodies[1]).toBe(
      [
        'marker.txt contains `CMATE-2197`.',
        '',
        `> **${TURN_REASONING_LABEL} (1)**`,
        '>',
        '> I’ll create the marker file and verify its contents.',
        '',
        `> **${TURN_TOOL_LOG_LABEL} (1)**`,
        '>',
        "> - `exec` — echo CMATE-2197 > marker.txt && sed -n '1p' marker.txt",
      ].join('\n')
    );
  });

  it('summarises a file edit by its path, not by its diff', () => {
    const bodies = bodiesOf(AFTER_NEW, AFTER_NEW_SESSION);
    expect(bodies[1]).toContain('> - `edit` — /tmp/cmate-2197/work/cx/README.md');
    // The unified diff is in the record and must not reach the row.
    expect(AFTER_NEW).toContain('unified_diff');
    expect(bodies[1]).not.toContain('unified_diff');
  });

  it('drops the reasoning items codex writes empty', () => {
    // Measured empty on 12,084 of 12,084 archived items. An empty blockquote in
    // every reply would be the cost of not checking.
    const turns = turnsOf(AFTER_NEW, AFTER_NEW_SESSION);
    expect(turns[1].items.some((item) => item.type === 'Reasoning')).toBe(true);
    // NARROWED BY #2420. This used to read `.not.toContain('Thinking')`, which
    // stopped discriminating once this turn's commentary began arriving under
    // `> **Thinking (1)**`. The shape being ruled out is the one an EMPTY
    // `Reasoning` item would render — `renderReasoningItem`'s bare, uncounted
    // heading over a blank quote — and that is a different string, so the
    // property survives the rewrite intact.
    expect(bodiesOf(AFTER_NEW, AFTER_NEW_SESSION)[1]).not.toContain(
      `> **${CODEX_THINKING_LABEL}**`
    );
  });

  it('folds a reasoning summary into a quote when codex does write one', () => {
    const turn: CodexTurnAccumulator = {
      sessionId: 's',
      turnId: 't',
      startedAt: 0,
      prompts: [],
      items: [
        readCodexRolloutItem({
          type: 'Reasoning',
          id: 'rs_1',
          summary_text: ['Checking the marker file.'],
          raw_content: [],
        })!,
      ],
      started: true,
      closed: true,
      overflowed: false,
    };
    expect(renderCodexTurn(turn).body).toBe('> **Thinking**\n>\n> Checking the marker file.');
  });

  it('counts an item type it has no rule for instead of dropping it', () => {
    const turn: CodexTurnAccumulator = {
      sessionId: 's',
      turnId: 't',
      startedAt: 0,
      prompts: [],
      items: [
        readCodexRolloutItem({ type: 'AgentMessage', id: 'm', content: [{ text: 'hi' }] })!,
        readCodexRolloutItem({ type: 'HolographicPairProgramming', id: 'x' })!,
        readCodexRolloutItem({ type: 'ContextCompaction', id: 'c' })!,
      ],
      started: true,
      closed: true,
      overflowed: false,
    };
    const rendered = renderCodexTurn(turn);
    // Reported, so a codex release that grows an item type is visible before
    // somebody notices a missing paragraph…
    expect(rendered.unknownBlockTypes).toEqual(['HolographicPairProgramming']);
    // …and `ContextCompaction`, whose whole payload is `{type,id}`, is not
    // reported, because it was measured to carry nothing.
    expect(rendered.body).toBe('hi');
  });

  it('bounds a tool detail rather than putting a heredoc in the row', () => {
    const item = readCodexRolloutItem({
      type: 'CommandExecution',
      id: 'e',
      parsed_cmd: [{ type: 'unknown', cmd: `echo ${'x'.repeat(400)}\n  continued` }],
    });
    expect(item?.detail).toHaveLength(MAX_CODEX_TOOL_DETAIL_LENGTH);
    expect(item?.detail?.endsWith('…')).toBe(true);
  });

  it('falls back to the argv when codex could not parse the command', () => {
    const item = readCodexRolloutItem({
      type: 'CommandExecution',
      id: 'e',
      command: ['/bin/zsh', '-lc', 'git status'],
    });
    expect(item?.detail).toBe('/bin/zsh -lc git status');
  });
});

describe('[#2420] which AgentMessage phases lead the bubble', () => {
  /**
   * One turn built from `AgentMessage` items alone.
   *
   * Synthesised rather than captured, and deliberately so: the whole point of
   * this Issue is the phases the archived corpus does NOT contain. Measured on
   * the fixtures, `phase` is `commentary` or `final_answer` and never absent,
   * never unknown, and never attached to an empty body — so a missing phase, a
   * phase codex has not shipped yet, and a blank `final_answer` can only be
   * written by hand. The record shape is the fixture's, field for field: every
   * item goes through `readCodexRolloutItem`, the same reader the real file
   * does, so a change to how `phase` is parsed breaks these too.
   *
   * `phase: undefined` is dropped from the object rather than passed, because
   * `readStringField` must see the key ABSENT to answer `null`.
   */
  function turnOfMessages(
    messages: readonly { readonly text: string; readonly phase?: string }[]
  ): CodexTurnAccumulator {
    return {
      sessionId: 's',
      turnId: 't',
      startedAt: 0,
      prompts: [],
      items: messages.map(
        (message, index) =>
          readCodexRolloutItem({
            type: 'AgentMessage',
            id: `m${index}`,
            content: [{ type: 'text', text: message.text, text_elements: [] }],
            ...(message.phase === undefined ? {} : { phase: message.phase }),
          })!
      ),
      started: true,
      closed: true,
      overflowed: false,
    };
  }

  const REASONING_HEADING = (blocks: number) => `> **${TURN_REASONING_LABEL} (${blocks})**`;

  it('opens with the final answer and puts the commentary in the folded section', () => {
    const body = renderCodexTurn(
      turnOfMessages([
        { text: 'Reading the file now.', phase: 'commentary' },
        { text: 'The file holds two entries.', phase: 'final_answer' },
      ])
    ).body;
    expect(body).toBe(
      [
        'The file holds two entries.',
        '',
        REASONING_HEADING(1),
        '>',
        '> Reading the file now.',
      ].join('\n')
    );
    // The property, stated once so a later change to the exact bytes above
    // cannot quietly drop it: the first line of the bubble is the answer.
    expect(body.split('\n')[0]).toBe('The file holds two entries.');
  });

  it('folds four commentary blocks under one heading, in transcript order', () => {
    // The shape #2420 was reported against: `codex-turn:01a07e37-0658` carried
    // 4 commentary blocks / 754 characters in front of one 495-character
    // answer, so the operator read four paragraphs before reaching the reply.
    const body = renderCodexTurn(
      turnOfMessages([
        { text: 'First I will look around.', phase: 'commentary' },
        { text: 'Now I will read the config.', phase: 'commentary' },
        { text: 'The config points at a second file.', phase: 'commentary' },
        { text: 'Reading that one too.', phase: 'commentary' },
        { text: 'The timeout is 30 seconds.', phase: 'final_answer' },
      ])
    ).body;
    expect(body).toBe(
      [
        'The timeout is 30 seconds.',
        '',
        REASONING_HEADING(4),
        '>',
        '> First I will look around.',
        '>',
        '> Now I will read the config.',
        '>',
        '> The config points at a second file.',
        '>',
        '> Reading that one too.',
      ].join('\n')
    );
  });

  it('keeps every final answer in the body, not only the last', () => {
    // The corpus has turns carrying more than one `final_answer`, so "keep the
    // last one" would drop a paragraph the agent meant the operator to read.
    const body = renderCodexTurn(
      turnOfMessages([
        { text: 'Checking both halves.', phase: 'commentary' },
        { text: 'The first half passes.', phase: 'final_answer' },
        { text: 'The second half passes too.', phase: 'final_answer' },
      ])
    ).body;
    expect(body).toBe(
      [
        'The first half passes.',
        '',
        'The second half passes too.',
        '',
        REASONING_HEADING(1),
        '>',
        '> Checking both halves.',
      ].join('\n')
    );
  });

  it('leaves a message with no phase in the body even when a final answer exists', () => {
    // The allow-list, from the side that matters: only `commentary` folds. A
    // deny-list ("fold everything that is not `final_answer`") would hide this
    // paragraph, and hide it silently.
    const body = renderCodexTurn(
      turnOfMessages([
        { text: 'A message codex wrote without a phase.' },
        { text: 'Done.', phase: 'final_answer' },
      ])
    ).body;
    expect(body).toBe('A message codex wrote without a phase.\n\nDone.');
    expect(body).not.toContain(TURN_REASONING_LABEL);
  });

  it('leaves a phase it has never seen in the body rather than guessing', () => {
    // The regression a deny-list would ship the day codex adds a phase name.
    const body = renderCodexTurn(
      turnOfMessages([
        { text: 'Something from a newer codex.', phase: 'plan_update' },
        { text: 'Done.', phase: 'final_answer' },
      ])
    ).body;
    expect(body).toBe('Something from a newer codex.\n\nDone.');
    expect(body).not.toContain(TURN_REASONING_LABEL);
  });

  it('keeps the commentary when the only final answer is whitespace', () => {
    // The fallback is on the RENDERED body, not on the item count: this turn
    // HAS a `final_answer` item, and it draws nothing, so folding the
    // commentary away would leave an empty bubble.
    const turn = turnOfMessages([
      { text: 'Looking into it.', phase: 'commentary' },
      { text: '   \n  ', phase: 'final_answer' },
    ]);
    expect(turn.items.some((item) => item.phase === 'final_answer')).toBe(true);
    expect(renderCodexTurn(turn).body).toBe('Looking into it.');
  });

  it('keeps the commentary when the turn produced no final answer at all', () => {
    // A turn cut short, or one that only narrated. Folding is an improvement
    // only when there is something better to lead with.
    const body = renderCodexTurn(
      turnOfMessages([
        { text: 'Starting on the migration.', phase: 'commentary' },
        { text: 'Still working through the fixtures.', phase: 'commentary' },
      ])
    ).body;
    expect(body).toBe('Starting on the migration.\n\nStill working through the fixtures.');
    expect(body).not.toContain(TURN_REASONING_LABEL);
  });

  it('counts the folded commentary as text the agent wrote', () => {
    // `textBlocks` is the log line's answer to "how much did the agent say",
    // and folding is a layout decision — it must not change the number.
    const rendered = renderCodexTurn(
      turnOfMessages([
        { text: 'Working on it.', phase: 'commentary' },
        { text: 'Done.', phase: 'final_answer' },
      ])
    );
    expect(rendered.textBlocks).toBe(2);
  });

  it('does not break the bubble when the final answer is a single short word', () => {
    // Measured at 18 % of turns: `PONG-1` (6 characters) and `PATCHED` (7) are
    // real captured answers. A one-word reply plus a folded heading must stay
    // one short paragraph and one quote — not a heading with nothing over it.
    const bodies = bodiesOf(THREE_TURNS, THREE_TURNS_SESSION);
    expect(bodies[0]).toBe('PONG-1');

    const patched = bodiesOf(AFTER_NEW, AFTER_NEW_SESSION)[1];
    expect(patched.startsWith('PATCHED\n\n')).toBe(true);
    expect(patched).toContain(`${REASONING_HEADING(1)}\n>\n> I’ll patch \`README.md\` directly.`);
    expect(patched.split('\n')[0]).toBe('PATCHED');
  });

  it('folds nothing on a turn that never had a phase to fold', () => {
    // The negative control for the whole Issue: the third captured turn is one
    // `final_answer` and no commentary, and must come out byte-identical to
    // what #2234 produced.
    expect(bodiesOf(THREE_TURNS, THREE_TURNS_SESSION)[2]).toBe(
      '## Result\n\n- alpha\n- beta\n\n**Done.**'
    );
  });
});

describe('[#2197] reading a file that is being written', () => {
  it('counts a fragment at the tail and reads everything before it', () => {
    // codex appends while CommandMate reads, so the last line of a read can be
    // half a record. That must cost one record, not the file.
    const fragment = `${THREE_TURNS}{"timestamp":"2026-09-01T01:10:29.000Z","ordi`;
    const parsed = parseCodexRollout(fragment);
    expect(parsed.malformedLines).toBe(1);
    expect(buildCodexTurns(parsed.records, THREE_TURNS_SESSION).turns).toHaveLength(3);
  });

  it('reads a window that starts mid-file without inventing a turn', () => {
    const lines = THREE_TURNS.trim().split('\n');
    // Start after the first turn's `task_started`, which is what a 4 MiB window
    // landing inside a long session looks like.
    const windowed = lines.slice(20).join('\n');
    const turns = turnsOf(windowed, THREE_TURNS_SESSION);
    expect(turns.map((turn) => turn.turnId)).toEqual([
      '01a05a83-a87d-7362-80fe-027b7584e589',
      '01a05a84-76f2-7390-83f3-51ea1346a364',
    ]);
    // Issue #2402: and it says which of the two it watched begin. The first
    // one's `task_started` is on the far side of the window's first byte, so it
    // is read as headless rather than as a turn that opened here.
    expect(turns.map((turn) => turn.started)).toEqual([false, true]);
  });

  it('survives a line that is valid JSON but not a record', () => {
    const parsed = parseCodexRollout('[1,2,3]\n"a string"\n{"no":"type"}\n');
    expect(parsed.records).toHaveLength(0);
    expect(parsed.malformedLines).toBe(3);
  });
});

describe('[#2197] accounting — nothing is dropped in silence', () => {
  it('counts the duplicate `response_item` stream rather than ignoring it', () => {
    const built = buildCodexTurns(
      parseCodexRollout(THREE_TURNS).records,
      THREE_TURNS_SESSION
    );
    expect(built.duplicateStreamRecords).toBeGreaterThan(0);
    expect(built.turnlessRecords).toBeGreaterThan(0);
  });

  it('accounts for every parsed record', () => {
    // The receipt: the two counters plus the turn-bearing records are every
    // record the parser produced, so neither counter can quietly absorb the
    // other's share.
    const parsed = parseCodexRollout(THREE_TURNS);
    const built = buildCodexTurns(parsed.records, THREE_TURNS_SESSION);
    const turnBearing = parsed.records.filter(
      (record) => record.type !== 'response_item' && record.turnId !== null
    ).length;
    expect(built.duplicateStreamRecords + built.turnlessRecords + turnBearing).toBe(
      parsed.records.length
    );
  });

  it('keeps every item and prompt a turn-bearing record carried', () => {
    // The other half: of the turn-bearing records, the `item_completed` ones
    // become items or prompts and the `task_complete` ones close a turn.
    // Nothing that carries content is dropped on the way in.
    const parsed = parseCodexRollout(THREE_TURNS);
    const built = buildCodexTurns(parsed.records, THREE_TURNS_SESSION);

    const itemRecords = parsed.records.filter((record) => record.item !== null);
    const prompts = built.turns.flatMap((turn) => turn.prompts);
    const items = built.turns.flatMap((turn) => turn.items);
    expect(prompts.length + items.length).toBe(itemRecords.length);

    const closes = parsed.records.filter(
      (record) => record.payloadType === 'task_complete'
    ).length;
    expect(built.turns.filter((turn) => turn.closed)).toHaveLength(closes);
  });

  it('reports overflow rather than truncating in silence', () => {
    const line = (n: number) =>
      JSON.stringify({
        timestamp: '2026-09-01T01:08:53.000Z',
        ordinal: n,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'overflow-turn',
          item: { type: 'AgentMessage', id: `m-${n}`, content: [{ text: `p${n}` }] },
        },
      });
    const many = Array.from({ length: MAX_CODEX_TURN_ITEMS + 5 }, (_, i) => line(i)).join('\n');
    const turn = turnsOf(many, 'session')[0];
    expect(turn.items).toHaveLength(MAX_CODEX_TURN_ITEMS);
    expect(turn.overflowed).toBe(true);
  });
});

describe('[#2197] the hook payloads name the file this reader opens', () => {
  it('gives each captured session the id its rollout file is named after', () => {
    const sessionsInHooks = new Set(HOOK_EVENTS.map((event) => event.payload.session_id));
    expect(sessionsInHooks).toEqual(
      new Set([THREE_TURNS_SESSION, AFTER_NEW_SESSION, SECOND_INSTANCE_SESSION])
    );
  });

  it('points every event at the rollout whose name ends with that id', () => {
    // The measurement the whole pointer design rests on. If codex's hook
    // `session_id` were not the file's uuid there would be nothing to resolve a
    // path from, and this reader could not exist in this shape.
    for (const event of HOOK_EVENTS) {
      expect(event.payload.transcript_path.endsWith(`-${event.payload.session_id}.jsonl`)).toBe(
        true
      );
    }
  });

  it('gives the second instance in the same directory a different session', () => {
    // Two codex processes, one cwd, at the same time. The cwd is identical and
    // the session ids are not — which is why `./history` has no cwd fallback.
    const byPane = new Map<string, Set<string>>();
    for (const event of HOOK_EVENTS) {
      const seen = byPane.get(event.pane) ?? new Set<string>();
      seen.add(event.payload.session_id);
      byPane.set(event.pane, seen);
    }
    expect([...(byPane.get('cx2') ?? [])]).toEqual([SECOND_INSTANCE_SESSION]);
    expect(byPane.get('cx1')?.has(SECOND_INSTANCE_SESSION)).toBe(false);

    const cwds = new Set(HOOK_EVENTS.map((event) => event.payload.cwd));
    expect(cwds.size).toBe(1);
  });

  it('moves the pointer when `/new` opens a second session in one pane', () => {
    const cx1Starts = HOOK_EVENTS.filter(
      (event) => event.pane === 'cx1' && event.event === 'SessionStart'
    );
    expect(cx1Starts.map((event) => event.payload.session_id)).toEqual([
      THREE_TURNS_SESSION,
      AFTER_NEW_SESSION,
    ]);
  });

  it('reads the two sessions of that pane as two separate conversations', () => {
    expect(bodiesOf(THREE_TURNS, THREE_TURNS_SESSION).at(-1)).toContain('**Done.**');
    expect(bodiesOf(AFTER_NEW, AFTER_NEW_SESSION)[0]).toBe('PONG-AFTER-NEW');
    expect(bodiesOf(SECOND_INSTANCE, SECOND_INSTANCE_SESSION)).toEqual([
      'PONG-FROM-SECOND-INSTANCE',
    ]);
  });
});

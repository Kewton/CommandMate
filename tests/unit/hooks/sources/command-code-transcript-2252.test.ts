/**
 * Command Code's transcript, read back into the reply the agent wrote (#2252).
 *
 * The pure half of Epic #2249 Phase C. Everything here runs against
 * `tests/fixtures/transcripts/command-code/`, which is a live capture from
 * Command Code v1.40.1 — see that directory's README for which bytes are the
 * tool's and which three identifiers were rewritten.
 *
 * ## What this file is really pinning
 *
 * Three claims, each of which was measured rather than assumed and each of which
 * has a mutation that reddens it:
 *
 *  1. **A turn opens on a fresh `role: "user"` record and not on a tool result.**
 *     That is Command Code's own rule — its bundle's `isFreshUserTurn` is
 *     `role === 'user' && !content.some(c => c.type === 'tool_result')` — and
 *     dropping the `tool_result` half splits a turn in two at the point the agent
 *     called a tool, which the body pins below would then fail.
 *  2. **A turn is closed when the agent's last record carries prose and no
 *     `tool_use`.** There is no `stop_reason` on this tool (grep the fixture),
 *     so the loop's own `if (!hadToolCalls)` condition is the only evidence
 *     there is. `open-turn-1401` is a real capture of a turn that stopped on a
 *     `tool_use`, and its rendered body is **not empty** — which is exactly why
 *     the emptiness guard cannot stand in for this rule (#2264).
 *  3. **A `user` row is written only on positive evidence** (`meta.source ===
 *     "user"`), so the `steering` and `followup` prompts the agent loop appends
 *     on the operator's behalf never appear as something a person said.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildCommandCodeTurns,
  COMMAND_CODE_TURN_TRUNCATION_MARKER,
  createCommandCodeTurn,
  isCommandCodeOperatorPromptRecord,
  isCommandCodePromptRecord,
  isCommandCodeTurnClosingRecord,
  isCommandCodeTurnWritable,
  MAX_COMMAND_CODE_TOOL_DETAIL_LENGTH,
  MAX_COMMAND_CODE_TURN_BLOCKS,
  MAX_COMMAND_CODE_TURN_BODY_LENGTH,
  parseCommandCodeTranscript,
  readCommandCodeContentBlock,
  readCommandCodeTranscriptRecord,
  renderCommandCodeTurn,
  type CommandCodeTranscriptRecord,
} from '@/lib/hooks/sources/command-code/transcript';

const FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/command-code');

const THREE_TURNS = readFileSync(join(FIXTURES, 'three-turns-1401.jsonl'), 'utf8');
const OPEN_TURN = readFileSync(join(FIXTURES, 'open-turn-1401.jsonl'), 'utf8');

/** A body fixture, without the trailing newline a text file has to end with. */
function bodyFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8').replace(/\n$/, '');
}

const SESSION = '33333333-3333-4333-8333-333333333333';

function turnsOf(text: string) {
  const parsed = parseCommandCodeTranscript(text);
  return { parsed, built: buildCommandCodeTurns(parsed.records, parsed.sessionId ?? '') };
}

/** One `message` entry, with only the fields a test cares about spelled out. */
function messageRecord(
  role: string,
  content: unknown[],
  meta: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
): CommandCodeTranscriptRecord {
  const record = readCommandCodeTranscriptRecord({
    type: 'message',
    id: 'aaaaaaaa',
    parentId: null,
    timestamp: '2026-09-03T07:13:50.884Z',
    message: { role, content, meta },
    ...overrides,
  });
  if (!record) throw new Error('fixture record did not parse');
  return record;
}

describe('[#2252] parsing Command Code transcript lines', () => {
  it('reads the header and every message entry of the live capture', () => {
    const { parsed } = turnsOf(THREE_TURNS);

    expect(parsed.malformedLines).toBe(0);
    expect(parsed.sessionId).toBe(SESSION);
    expect(parsed.cwd).toBe('/private/tmp/MyCodeBranchDesk/probe');
    expect(parsed.parentSession).toBeNull();
    // 1 header + 9 message entries.
    expect(parsed.records).toHaveLength(10);
  });

  it('never lets the header id become a turn key', () => {
    // The header's `id` IS the session id, and an entry's `id` is a turn key.
    // Reading one as the other would key a row on the session, which every later
    // turn of that session would then find already saved.
    const header = readCommandCodeTranscriptRecord(
      JSON.parse(THREE_TURNS.split('\n')[0]) as unknown
    );
    expect(header?.sessionId).toBe(SESSION);
    expect(header?.id).toBeNull();
  });

  it('counts a truncated tail line instead of throwing (the mid-write case)', () => {
    // Command Code appends while CommandMate reads, so the last line of a read
    // taken mid-append is a fragment. It costs one record, never the file.
    const cut = THREE_TURNS.slice(0, THREE_TURNS.length - 120);
    expect(cut.endsWith('\n')).toBe(false);

    const parsed = parseCommandCodeTranscript(cut);
    expect(parsed.malformedLines).toBe(1);
    expect(parsed.records).toHaveLength(9);
  });

  it('counts a line that is JSON but not a record, and keeps reading', () => {
    const parsed = parseCommandCodeTranscript(
      ['[1,2,3]', '"a string"', '{"no":"type"}', '{"type":"label","id":"x","targetId":"y"}'].join(
        '\n'
      )
    );
    expect(parsed.malformedLines).toBe(3);
    expect(parsed.records).toHaveLength(1);
  });

  it('prefers meta.createdAt over the entry timestamp, because the store buffers', () => {
    // Measured: `persistEntry` writes nothing until the first assistant entry and
    // then flushes everything at once, so three records of one turn share one
    // `timestamp` while their `createdAt`s are seconds apart.
    const { built } = turnsOf(THREE_TURNS);
    expect(built.turns.map((turn) => turn.startedAt)).toEqual([
      1788419625705, 1788419735534, 1788419746723,
    ]);

    const withoutCreatedAt = messageRecord('user', [{ type: 'text', text: 'hi' }]);
    expect(withoutCreatedAt.timestampMs).toBe(Date.parse('2026-09-03T07:13:50.884Z'));
  });
});

describe('[#2252] what opens a turn — Command Code’s own isFreshUserTurn', () => {
  it('opens on a fresh user record', () => {
    expect(isCommandCodePromptRecord(messageRecord('user', [{ type: 'text', text: 'go' }]))).toBe(
      true
    );
  });

  it('does NOT open on a user record carrying tool results', () => {
    // The mutation: drop this clause and the captured two-tool turn is split in
    // half at the tool call, which the body pins below then fail on.
    const carrier = messageRecord(
      'user',
      [{ type: 'tool_result', tool_use_id: 'call_00_x', content: [{ type: 'text', text: 'alpha' }] }],
      { source: 'tool' }
    );
    expect(isCommandCodePromptRecord(carrier)).toBe(false);
  });

  it('does not read a tool_result’s nested text as the record’s own', () => {
    // `tool_result.content[].text` is the tool's output. Reaching it would make
    // the carrier above look like a prompt on text alone.
    const carrier = messageRecord('user', [
      { type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: 'alpha' }] },
    ]);
    expect(carrier.text).toBe('');
  });

  it('does not open on a hidden, empty, id-less or non-message record', () => {
    expect(
      isCommandCodePromptRecord(
        messageRecord('user', [{ type: 'text', text: 'go' }], { isMeta: true })
      )
    ).toBe(false);
    expect(isCommandCodePromptRecord(messageRecord('user', [{ type: 'text', text: '   ' }]))).toBe(
      false
    );
    expect(
      isCommandCodePromptRecord(
        messageRecord('user', [{ type: 'text', text: 'go' }], {}, { id: undefined })
      )
    ).toBe(false);
    expect(isCommandCodePromptRecord(messageRecord('assistant', [{ type: 'text', text: 'go' }]))).toBe(
      false
    );
  });

  it('accepts a bare string content, which a migrated v2 session can carry', () => {
    const record = readCommandCodeTranscriptRecord({
      type: 'message',
      id: 'bbbbbbbb',
      parentId: null,
      timestamp: '2026-09-03T07:13:50.884Z',
      message: { role: 'user', content: 'typed at the composer' },
    });
    expect(record?.text).toBe('typed at the composer');
    expect(isCommandCodePromptRecord(record as CommandCodeTranscriptRecord)).toBe(true);
  });
});

describe('[#2252] whose words they are — the #2196 positive-evidence rule', () => {
  it('accepts only meta.source "user"', () => {
    const operator = messageRecord('user', [{ type: 'text', text: 'go' }], { source: 'user' });
    expect(isCommandCodeOperatorPromptRecord(operator)).toBe(true);

    for (const source of ['steering', 'followup', 'cli', 'branch-summary', 'model']) {
      const record = messageRecord('user', [{ type: 'text', text: 'go' }], { source });
      // Still a turn — the agent really answers it…
      expect(isCommandCodePromptRecord(record), source).toBe(true);
      // …but never the operator's own message.
      expect(isCommandCodeOperatorPromptRecord(record), source).toBe(false);
    }
  });

  it('answers false when there is no source at all, rather than guessing', () => {
    expect(
      isCommandCodeOperatorPromptRecord(messageRecord('user', [{ type: 'text', text: 'go' }]))
    ).toBe(false);
  });

  it('refuses a summary or an automated message even if it claims to be the user', () => {
    for (const meta of [
      { source: 'user', isSummary: true },
      { source: 'user', isAutomated: true },
    ]) {
      expect(
        isCommandCodeOperatorPromptRecord(messageRecord('user', [{ type: 'text', text: 'go' }], meta))
      ).toBe(false);
    }
  });

  it('marks all three captured prompts as the operator’s', () => {
    const { built } = turnsOf(THREE_TURNS);
    expect(built.turns.map((turn) => turn.promptIsOperatorInput)).toEqual([true, true, true]);
    expect(built.turns[2].promptText).toBe(
      'Reply with exactly this one line and nothing else: phase-c fixture complete'
    );
  });
});

describe('[#2252] what closes a turn — there is no stop_reason on this tool', () => {
  it('has no stop_reason anywhere in the live capture', () => {
    // The measurement the closing rule exists because of. If a later Command
    // Code starts writing one, this is the line that says so.
    expect(THREE_TURNS).not.toContain('stop_reason');
    expect(THREE_TURNS).not.toContain('stopReason');
  });

  it('closes on prose with no tool_use beside it', () => {
    expect(
      isCommandCodeTurnClosingRecord(messageRecord('assistant', [{ type: 'text', text: 'done' }]))
    ).toBe(true);
  });

  it('does not close on a record that reached for a tool', () => {
    // The loop's own condition: `if (!hadToolCalls) { … end_turn … }`. Prose and
    // a call on one record is the agent mid-loop, and the capture writes exactly
    // that shape.
    expect(
      isCommandCodeTurnClosingRecord(
        messageRecord('assistant', [
          { type: 'text', text: 'running them now' },
          { type: 'tool_use', id: 'c', name: 'shell_command', input: { command: 'echo alpha' } },
        ])
      )
    ).toBe(false);
  });

  it('does not close on thinking alone, or on blank prose', () => {
    expect(
      isCommandCodeTurnClosingRecord(
        messageRecord('assistant', [{ type: 'thinking', thinking: 'hmm', signature: '' }])
      )
    ).toBe(false);
    expect(
      isCommandCodeTurnClosingRecord(messageRecord('assistant', [{ type: 'text', text: '  ' }]))
    ).toBe(false);
  });

  it('is closed || superseded, and nothing else', () => {
    const base = createCommandCodeTurn(
      messageRecord('user', [{ type: 'text', text: 'go' }], { source: 'user' }),
      SESSION
    );
    expect(isCommandCodeTurnWritable({ ...base })).toBe(false);
    expect(isCommandCodeTurnWritable({ ...base, closed: true })).toBe(true);
    expect(isCommandCodeTurnWritable({ ...base, superseded: true })).toBe(true);
  });

  it('reads the LAST assistant record, so a resumed turn is open again', () => {
    const { built } = turnsOf(
      [
        JSON.stringify({ type: 'session', version: 3, id: SESSION, timestamp: '2026-09-03T07:00:00.000Z', cwd: '/w' }),
        JSON.stringify({
          type: 'message', id: '11111111', parentId: null, timestamp: '2026-09-03T07:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'go' }], meta: { source: 'user' } },
        }),
        JSON.stringify({
          type: 'message', id: '22222222', parentId: '11111111', timestamp: '2026-09-03T07:00:02.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }], meta: { source: 'model' } },
        }),
        JSON.stringify({
          type: 'message', id: '33333333', parentId: '22222222', timestamp: '2026-09-03T07:00:03.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'c1', name: 'shell_command', input: { command: 'ls' } }],
            meta: { source: 'model' },
          },
        }),
      ].join('\n')
    );
    expect(built.turns).toHaveLength(1);
    expect(built.turns[0].closed).toBe(false);
  });

  it('the captured open turn is open AND renders a non-empty body (#2264)', () => {
    // The whole argument for the closed rule in one assertion: the emptiness
    // guard the writer already had cannot see anything wrong with this turn.
    const { built } = turnsOf(OPEN_TURN);
    expect(built.turns).toHaveLength(2);

    const open = built.turns[1];
    expect(open.closed).toBe(false);
    expect(open.superseded).toBe(false);
    expect(isCommandCodeTurnWritable(open)).toBe(false);
    expect(renderCommandCodeTurn(open).body).toBe(bodyFixture('open-turn-1401.turn-b.md'));
    expect(renderCommandCodeTurn(open).body.length).toBeGreaterThan(0);
  });

  it('a later prompt supersedes it, and then it may be written', () => {
    // The second proof. An interrupted turn never gets its closing prose and is
    // still a finished turn whose reply nobody else will write.
    const withNextPrompt = `${OPEN_TURN.trimEnd()}\n${JSON.stringify({
      type: 'message',
      id: '99999999',
      parentId: 'ee4e93b1',
      timestamp: '2026-09-03T07:16:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'never mind' }],
        meta: { source: 'user', createdAt: 1788419760000 },
      },
    })}\n`;

    const { built } = turnsOf(withNextPrompt);
    expect(built.turns).toHaveLength(3);
    expect(built.turns[1].closed).toBe(false);
    expect(built.turns[1].superseded).toBe(true);
    expect(isCommandCodeTurnWritable(built.turns[1])).toBe(true);
  });
});

describe('[#2252] grouping the captured session into turns', () => {
  it('finds three turns, and keeps both assistant records of each closed one', () => {
    const { built } = turnsOf(THREE_TURNS);

    expect(built.turns.map((turn) => turn.promptId)).toEqual([
      'cb06ab09',
      'c1c8338e',
      'e37e1055',
    ]);
    // Two rounds of the agent loop per closed turn: the record that called the
    // tool and the record that answered. A boundary that opened on `tool_result`
    // would report one each and split the bodies.
    expect(built.turns.map((turn) => turn.assistantRecords)).toEqual([2, 2, 0]);
    expect(built.turns.map((turn) => turn.closed)).toEqual([true, true, false]);
    expect(built.turns.map((turn) => turn.superseded)).toEqual([true, true, false]);
    expect(built.turns.map((turn) => turn.sessionId)).toEqual([SESSION, SESSION, SESSION]);
  });

  it('reports nothing anomalous about a whole, unforked capture', () => {
    const { built } = turnsOf(THREE_TURNS);
    expect(built.orphanedAssistantRecords).toBe(0);
    expect(built.unresolvedParentRecords).toBe(0);
    expect(built.nonMessageRecords).toBe(0);
  });

  it('counts a window that opened mid-turn instead of writing from the middle', () => {
    // The tail window can start anywhere. An assistant record with no prompt
    // before it has no id to key a row on, so it is counted and dropped — never
    // attached to an invented turn.
    const lines = THREE_TURNS.trimEnd().split('\n');
    const { built } = turnsOf([lines[3], lines[4], lines[5]].join('\n'));

    expect(built.orphanedAssistantRecords).toBe(1);
    expect(built.turns).toHaveLength(1);
    expect(built.turns[0].promptId).toBe('c1c8338e');
    // The first record of a windowed read always names a parent outside it.
    expect(built.unresolvedParentRecords).toBeGreaterThan(0);
  });

  it('skips the eight non-message entry types and counts them', () => {
    const { built } = turnsOf(
      [
        THREE_TURNS.trimEnd(),
        JSON.stringify({
          type: 'label',
          id: 'ab12cd34',
          parentId: 'e37e1055',
          timestamp: '2026-09-03T07:16:00.000Z',
          targetId: 'cb06ab09',
          label: 'good one',
        }),
        JSON.stringify({
          type: 'session_info',
          id: 'ef56ab78',
          parentId: 'ab12cd34',
          timestamp: '2026-09-03T07:16:01.000Z',
          name: 'phase c',
        }),
      ].join('\n')
    );
    expect(built.nonMessageRecords).toBe(2);
    expect(built.turns).toHaveLength(3);
  });

  it('surfaces a forked header rather than reattaching its records', () => {
    // Out of scope by name in #2252; the honest thing is to report it.
    const forked = parseCommandCodeTranscript(
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: SESSION,
          timestamp: '2026-09-03T07:00:00.000Z',
          cwd: '/w',
          parentSession: '/Users/example/.commandcode/projects/p/other.jsonl',
        }),
      ].join('\n')
    );
    expect(forked.parentSession).toBe('/Users/example/.commandcode/projects/p/other.jsonl');
  });
});

describe('[#2252] rendering a turn to Markdown', () => {
  it('reproduces the captured bodies exactly', () => {
    const { built } = turnsOf(THREE_TURNS);
    const [a, b] = built.turns;

    expect(renderCommandCodeTurn(a).body).toBe(bodyFixture('three-turns-1401.turn-a.md'));
    expect(renderCommandCodeTurn(b).body).toBe(bodyFixture('three-turns-1401.turn-b.md'));
  });

  it('puts prose first and the tool log last (#2234)', () => {
    const { built } = turnsOf(THREE_TURNS);
    const body = renderCommandCodeTurn(built.turns[1]).body;

    const prose = body.indexOf('The first printed "alpha"');
    const tools = body.indexOf('> **Tool calls (2)**');
    expect(prose).toBeGreaterThanOrEqual(0);
    expect(tools).toBeGreaterThan(prose);
    // The captured turn's first block is `thinking` and its next two are
    // `tool_use`; in transcript order the body would open with the tool log.
    expect(body.startsWith('> **Tool calls')).toBe(false);
  });

  it('never lets a tool result reach the body', () => {
    // The captured turns carry their tool output on `role: "user"` records, and
    // those records never contribute blocks — so no accumulated block is one.
    const { built } = turnsOf(THREE_TURNS);
    for (const turn of built.turns) {
      expect(turn.blocks.map((block) => block.type)).not.toContain('tool_result');
      expect(renderCommandCodeTurn(turn).unknownBlockTypes).toEqual([]);
    }

    // And if one were handed to the renderer anyway it is silent, not unknown:
    // a sentinel that only a tool result could carry stays out of the body.
    const turn = createCommandCodeTurn(
      messageRecord('user', [{ type: 'text', text: 'go' }], { source: 'user' }),
      SESSION
    );
    turn.blocks.push({
      type: 'tool_result',
      text: 'TOOL-OUTPUT-SENTINEL',
      toolName: null,
      toolDetail: null,
    });
    const rendered = renderCommandCodeTurn(turn);
    expect(rendered.body).not.toContain('TOOL-OUTPUT-SENTINEL');
    expect(rendered.unknownBlockTypes).toEqual([]);
  });

  it('counts an unfamiliar block type instead of rendering it', () => {
    const turn = createCommandCodeTurn(
      messageRecord('user', [{ type: 'text', text: 'go' }], { source: 'user' }),
      SESSION
    );
    turn.blocks.push(
      { type: 'redacted_thinking', text: null, toolName: null, toolDetail: null },
      { type: 'tool_result', text: null, toolName: null, toolDetail: null }
    );
    const rendered = renderCommandCodeTurn(turn);
    expect(rendered.unknownBlockTypes).toEqual(['redacted_thinking']);
    expect(rendered.body).toBe('');
  });

  it('summarises a tool call by its most useful input field, bounded', () => {
    expect(
      readCommandCodeContentBlock({
        type: 'tool_use',
        name: 'write_file',
        input: { file_path: '/w/probe.txt', content: 'hello' },
      })
    ).toEqual({ type: 'tool_use', text: null, toolName: 'write_file', toolDetail: '/w/probe.txt' });

    // A heredoc `command` is multi-line; the summary is one line.
    expect(
      readCommandCodeContentBlock({
        type: 'tool_use',
        name: 'shell_command',
        input: { command: 'cat <<EOF\nline\nEOF', description: 'unused' },
      })?.toolDetail
    ).toBe('cat <<EOF line EOF');

    const long = readCommandCodeContentBlock({
      type: 'tool_use',
      name: 'shell_command',
      input: { command: 'x'.repeat(1000) },
    });
    expect(long?.toolDetail).toHaveLength(MAX_COMMAND_CODE_TOOL_DETAIL_LENGTH);
    expect(long?.toolDetail?.endsWith('…')).toBe(true);

    expect(
      readCommandCodeContentBlock({ type: 'tool_use', name: 'todo_write', input: { todos: [] } })
        ?.toolDetail
    ).toBeNull();
  });

  it('bounds the body and marks the truncation', () => {
    const turn = createCommandCodeTurn(
      messageRecord('user', [{ type: 'text', text: 'go' }], { source: 'user' }),
      SESSION
    );
    turn.blocks.push({
      type: 'text',
      text: 'y'.repeat(MAX_COMMAND_CODE_TURN_BODY_LENGTH + 10),
      toolName: null,
      toolDetail: null,
    });
    const body = renderCommandCodeTurn(turn).body;
    expect(body).toHaveLength(MAX_COMMAND_CODE_TURN_BODY_LENGTH);
    expect(body.endsWith(COMMAND_CODE_TURN_TRUNCATION_MARKER)).toBe(true);
  });

  it('stops accumulating blocks at the cap and says so', () => {
    const header = JSON.stringify({
      type: 'session',
      version: 3,
      id: SESSION,
      timestamp: '2026-09-03T07:00:00.000Z',
      cwd: '/w',
    });
    const prompt = JSON.stringify({
      type: 'message',
      id: '11111111',
      parentId: null,
      timestamp: '2026-09-03T07:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'go' }], meta: { source: 'user' } },
    });
    const reply = JSON.stringify({
      type: 'message',
      id: '22222222',
      parentId: '11111111',
      timestamp: '2026-09-03T07:00:02.000Z',
      message: {
        role: 'assistant',
        content: Array.from({ length: MAX_COMMAND_CODE_TURN_BLOCKS + 5 }, (_, index) => ({
          type: 'text',
          text: `block ${index}`,
        })),
        meta: { source: 'model' },
      },
    });

    const { built } = turnsOf([header, prompt, reply].join('\n'));
    expect(built.turns[0].overflowed).toBe(true);
    expect(built.turns[0].blocks).toHaveLength(MAX_COMMAND_CODE_TURN_BLOCKS);
  });
});

/**
 * Reading antigravity's transcript JSONL back into the reply it wrote
 * (Issue #2198).
 *
 * Fixture-driven, against a **real** transcript captured off agy 1.1.18 — see
 * `tests/fixtures/transcripts/antigravity/README.md` for how, and
 * `docs/design/antigravity-transcript-reader.md` for the go/no-go measurement
 * that made this Issue an implementation rather than a closed report. The point
 * of using a real file rather than a hand-written one is the same as #2041's,
 * #2121's and #2197's: a hand-written fixture agrees with the reader by
 * construction, and every defect this module can have is a disagreement between
 * the reader and the *file*.
 *
 * The second fixture — `transcript-record-types` — is assembled rather than
 * captured whole, and that is stated where it is used. Its records are real, one
 * per shape the 1,024-record corpus contained, with the prose elided; what it
 * pins is the vocabulary, which is the half of this reader that a single
 * captured session cannot exercise.
 *
 * The file-touching half — which transcript belongs to this instance, what
 * happens when it is missing — is pinned in `./antigravity-history-2198.test.ts`.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildAntigravityTurns,
  extractAntigravityUserRequest,
  isAntigravityPromptRecord,
  parseAntigravityTranscript,
  readAntigravityToolCall,
  readAntigravityTranscriptRecord,
  renderAntigravityTurn,
  ANTIGRAVITY_SYSTEM_TYPES,
  ANTIGRAVITY_THINKING_LABEL,
  ANTIGRAVITY_TOOL_RESULT_TYPES,
  ANTIGRAVITY_TURN_TRUNCATION_MARKER,
  MAX_ANTIGRAVITY_TOOL_DETAIL_LENGTH,
  MAX_ANTIGRAVITY_TURN_BODY_LENGTH,
  MAX_ANTIGRAVITY_TURN_RECORDS,
  type AntigravityTranscriptRecord,
  type AntigravityTurnAccumulator,
} from '@/lib/hooks/sources/antigravity/transcript';
import { TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

const FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/antigravity');

/** The captured three-turn session, byte for byte apart from path redaction. */
const THREE_TURNS = readFileSync(join(FIXTURES, 'transcript-three-turns-1118.jsonl'), 'utf8');
/** One real record per shape the corpus contained, prose elided. */
const RECORD_TYPES = readFileSync(join(FIXTURES, 'transcript-record-types-1118.jsonl'), 'utf8');
/** The hook payloads that session actually posted. */
const HOOK_EVENTS = JSON.parse(
  readFileSync(join(FIXTURES, 'hook-events-1118.json'), 'utf8')
) as Array<{ turn: number; kind: string; payload: Record<string, unknown> }>;

const CONVERSATION = '1ce50bef-fc2a-4039-8114-5aae518678e6';

function turnsOf(text: string, conversationId = CONVERSATION): readonly AntigravityTurnAccumulator[] {
  return buildAntigravityTurns(parseAntigravityTranscript(text).records, conversationId).turns;
}

function bodiesOf(text: string): string[] {
  return turnsOf(text).map((turn) => renderAntigravityTurn(turn).body);
}

describe('[#2198] parsing the captured transcript', () => {
  it('reads every line of the captured file, with none malformed', () => {
    // 0 of 1,024 across the whole corpus. A non-zero count here would mean the
    // reader's idea of a record and agy's have come apart.
    const parsed = parseAntigravityTranscript(THREE_TURNS);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.records).toHaveLength(13);
  });

  it('keeps the file order agy appended in, gaps and all', () => {
    // step 9 and 11 are absent from the captured file — agy dropped the steps of
    // two refused tool calls. A reader that assumed contiguity would either skip
    // records or invent them.
    expect(parseAntigravityTranscript(THREE_TURNS).records.map((r) => r.stepIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 14,
    ]);
  });

  it('counts a torn final line rather than losing the file', () => {
    // agy appends while CommandMate reads, so the last line of a windowed read
    // can be a fragment. It costs one record, not the read.
    const parsed = parseAntigravityTranscript(`${THREE_TURNS}{"step_index":15,"sou`);
    expect(parsed.malformedLines).toBe(1);
    expect(parsed.records).toHaveLength(13);
  });

  it('refuses a record with no usable `step_index`, because that is its name', () => {
    // The index is half the `request_id` an idempotency check is made on, so a
    // record that cannot be named must not be given a synthetic index — two
    // reads would name it differently and write the turn twice.
    for (const bad of ['{}', '{"step_index":"3","source":"MODEL","type":"PLANNER_RESPONSE"}',
      '{"step_index":1.5,"source":"MODEL","type":"PLANNER_RESPONSE"}',
      '{"step_index":-1,"source":"MODEL","type":"PLANNER_RESPONSE"}',
      '{"step_index":0,"type":"PLANNER_RESPONSE"}',
      '{"step_index":0,"source":"MODEL"}', '[]', '"text"']) {
      expect(parseAntigravityTranscript(bad).records, bad).toHaveLength(0);
      expect(parseAntigravityTranscript(bad).malformedLines, bad).toBe(1);
    }
  });

  it('reads `created_at` as epoch ms and tolerates an unparseable one', () => {
    const first = parseAntigravityTranscript(THREE_TURNS).records[0];
    expect(first.timestampMs).toBe(Date.parse('2026-09-01T02:12:41Z'));

    const record = readAntigravityTranscriptRecord({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: 'not a date',
    });
    expect(record?.timestampMs).toBeNull();
  });
});

describe('[#2198] tool calls', () => {
  it('summarises a call with agy’s own `toolAction`', () => {
    // 439 of 439 calls in the corpus carry one, so the summary is agy's words
    // rather than an argv this reader reassembled.
    expect(readAntigravityToolCall({ name: 'list_dir', args: { toolAction: 'Listing home directory', toolSummary: 'List directory' } })).toEqual({
      name: 'list_dir',
      detail: 'Listing home directory',
    });
  });

  it('falls back to `toolSummary`, then to no detail at all', () => {
    expect(readAntigravityToolCall({ name: 'list_dir', args: { toolSummary: 'List directory' } })?.detail).toBe('List directory');
    expect(readAntigravityToolCall({ name: 'list_dir', args: {} })?.detail).toBeNull();
    expect(readAntigravityToolCall({ name: 'list_dir' })?.detail).toBeNull();
  });

  it('is null for anything that is not a named call', () => {
    expect(readAntigravityToolCall({ args: { toolAction: 'x' } })).toBeNull();
    expect(readAntigravityToolCall('list_dir')).toBeNull();
    expect(readAntigravityToolCall(null)).toBeNull();
  });

  it('collapses a multi-line detail and bounds a long one', () => {
    expect(readAntigravityToolCall({ name: 'run_command', args: { toolAction: 'a\n  b\tc' } })?.detail).toBe('a b c');

    const long = 'x'.repeat(MAX_ANTIGRAVITY_TOOL_DETAIL_LENGTH + 50);
    const detail = readAntigravityToolCall({ name: 'run_command', args: { toolAction: long } })?.detail;
    expect(detail).toHaveLength(MAX_ANTIGRAVITY_TOOL_DETAIL_LENGTH);
    expect(detail?.endsWith('…')).toBe(true);
  });
});

describe('[#2198] turn boundaries', () => {
  it('splits the captured session on `USER_INPUT`, in file order', () => {
    expect(turnsOf(THREE_TURNS).map((turn) => turn.stepIndex)).toEqual([0, 2, 12]);
  });

  it('keeps a turn together across the records agy interleaves into it', () => {
    // The second turn has a `SYSTEM_MESSAGE` agy injected right after the
    // prompt, then four tool calls with their results between them. All of it is
    // one turn, because only a `USER_INPUT` opens one.
    expect(turnsOf(THREE_TURNS)[1].records.map((r) => `${r.source}/${r.type}`)).toEqual([
      'SYSTEM/SYSTEM_MESSAGE',
      'MODEL/PLANNER_RESPONSE',
      'MODEL/GENERIC',
      'MODEL/PLANNER_RESPONSE',
      'MODEL/GENERIC',
      'MODEL/PLANNER_RESPONSE',
      'MODEL/PLANNER_RESPONSE',
    ]);
  });

  it('does not sort, because `step_index` is not reliably ascending', () => {
    // One of the 41 corpus files runs 8 → 7. File order is the order agy
    // appended, which is the order the conversation happened in; sorting would
    // move a reply in front of the tool result it describes.
    const swapped = [
      '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>\\nq\\n</USER_REQUEST>"}',
      '{"step_index":8,"source":"MODEL","type":"PLANNER_RESPONSE","content":"eight"}',
      '{"step_index":7,"source":"MODEL","type":"PLANNER_RESPONSE","content":"seven"}',
    ].join('\n');
    expect(bodiesOf(swapped)).toEqual(['eight\n\nseven']);
  });

  it('counts records that arrive before any prompt instead of inventing a turn', () => {
    // The 4 MiB window can cut mid-conversation, and one corpus file's
    // `transcript_full.jsonl` held a single record while the truncated
    // `transcript.jsonl` beside it held 133. Neither may become a headless turn.
    const orphaned = '{"step_index":9,"source":"MODEL","type":"PLANNER_RESPONSE","content":"answer with no question"}';
    const built = buildAntigravityTurns(parseAntigravityTranscript(orphaned).records, CONVERSATION);
    expect(built.turns).toHaveLength(0);
    expect(built.preludeRecords).toBe(1);
  });

  it('names the prompt record and nothing else as a turn opener', () => {
    const records = parseAntigravityTranscript(THREE_TURNS).records;
    expect(records.filter(isAntigravityPromptRecord).map((r) => r.stepIndex)).toEqual([0, 2, 12]);
  });

  it('reports overflow rather than growing without bound', () => {
    const flood = [
      '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>\\nq\\n</USER_REQUEST>"}',
      ...Array.from(
        { length: MAX_ANTIGRAVITY_TURN_RECORDS + 5 },
        (_, i) => `{"step_index":${i + 1},"source":"MODEL","type":"PLANNER_RESPONSE","content":"line ${i}"}`
      ),
    ].join('\n');
    const turn = turnsOf(flood)[0];
    expect(turn.records).toHaveLength(MAX_ANTIGRAVITY_TURN_RECORDS);
    expect(turn.overflowed).toBe(true);
  });
});

describe('[#2198] the operator’s own text', () => {
  it('takes only what is inside `<USER_REQUEST>`', () => {
    // agy wraps the prompt and then appends its own `<ADDITIONAL_METADATA>` (the
    // local time) and, on the first prompt of a session, `<USER_SETTINGS_CHANGE>`
    // (which model was picked). Both are agy's words, and neither belongs in the
    // operator's history row.
    expect(turnsOf(THREE_TURNS).map((turn) => turn.prompt?.text)).toEqual([
      'Answer in exactly one short sentence: what is 2+2? Do not use any tools.',
      'Read the file NOTES.md in this directory with a tool and tell me its contents in one sentence.',
      'Reply with exactly: THIRD TURN OK. Use **bold** markdown in your reply and a bullet list of two items. No tools.',
    ]);
  });

  it('is positive extraction, so a prompt that mentions the trailers survives', () => {
    // Stripping the trailers would truncate this one; taking what is inside the
    // wrapper cannot.
    expect(
      extractAntigravityUserRequest(
        '<USER_REQUEST>\nwhat does <ADDITIONAL_METADATA> mean?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nthe time\n</ADDITIONAL_METADATA>'
      )
    ).toBe('what does <ADDITIONAL_METADATA> mean?');
  });

  it('is null when the wrapper is absent, unterminated or empty', () => {
    expect(extractAntigravityUserRequest('bare text')).toBeNull();
    expect(extractAntigravityUserRequest('<USER_REQUEST>\nno close')).toBeNull();
    expect(extractAntigravityUserRequest('<USER_REQUEST>\n \n</USER_REQUEST>')).toBeNull();
  });

  it('leaves a turn with an unreadable prompt still renderable', () => {
    // The prompt is null and the reply is not lost: #2196's user row is worth
    // having, but the assistant row does not depend on it.
    const odd = [
      '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"no wrapper here"}',
      '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","content":"the reply"}',
    ].join('\n');
    const turn = turnsOf(odd)[0];
    expect(turn.prompt).toBeNull();
    expect(renderAntigravityTurn(turn).body).toBe('the reply');
  });

  it('dates the prompt from agy’s own clock', () => {
    expect(turnsOf(THREE_TURNS)[2].prompt?.timestampMs).toBe(Date.parse('2026-09-01T02:14:40Z'));
  });
});

describe('[#2198] rendering the captured turns', () => {
  it('writes the agent’s Markdown, not a rendering of its TUI', () => {
    const bodies = bodiesOf(THREE_TURNS);
    expect(bodies[0]).toBe('2 plus 2 equals 4.');
    // Turn 3 asked for Markdown and got it — bold and a bullet list, with the
    // model's own `thinking` folded in front of it.
    expect(bodies[2]).toContain('**THIRD TURN OK**\n\n- Item 1\n- Item 2');
  });

  it('summarises each tool call on its own line, in the order agy made them', () => {
    // Issue #2234 folded the calls into one labelled section. The turn said
    // nothing else, so the section is the whole body.
    expect(bodiesOf(THREE_TURNS)[1]).toBe(
      [
        `> **${TURN_TOOL_LOG_LABEL} (4)**`,
        '>',
        '> - `find_by_name` — Searching for NOTES.md',
        '> - `find_by_name` — Searching for NOTES.md in user home',
        '> - `find_by_name` — Searching for NOTES.md in home directory',
        '> - `list_dir` — Listing home directory',
      ].join('\n')
    );
  });

  it('folds `thinking` into a blockquote in front of the prose it produced', () => {
    const body = bodiesOf(THREE_TURNS)[2];
    expect(body.startsWith(`> **${ANTIGRAVITY_THINKING_LABEL}**\n>\n> `)).toBe(true);
    // The reasoning must not run into the answer: agy's own causal order is
    // reason, then speak, and a blank line is what keeps them separate blocks.
    expect(body).toContain('\n\n**THIRD TURN OK**');
  });

  it('drops the tool results, because the call line already named them', () => {
    // The second turn's `GENERIC` records hold agy's raw tool transcript
    // ("Created At: … Found 0 results"). Rendering them would bury the reply.
    expect(bodiesOf(THREE_TURNS)[1]).not.toContain('Created At:');
    expect(bodiesOf(THREE_TURNS)[1]).not.toContain('Found 0 results');
  });

  it('drops the context agy injects, because nobody said it', () => {
    // A `SYSTEM_MESSAGE` opens with "not actually sent by the user" in agy's own
    // words. Two of them sit inside the captured turns.
    for (const body of bodiesOf(THREE_TURNS)) {
      expect(body).not.toContain('not actually sent by the user');
    }
  });

  it('counts what it rendered', () => {
    const rendered = turnsOf(THREE_TURNS).map(renderAntigravityTurn);
    expect(rendered.map((r) => [r.textBlocks, r.toolBlocks])).toEqual([
      [1, 0],
      [0, 4],
      [1, 0],
    ]);
    expect(rendered.map((r) => r.stepIndex)).toEqual([0, 2, 12]);
    expect(rendered.every((r) => r.conversationId === CONVERSATION)).toBe(true);
  });
});

describe('[#2198] the record vocabulary', () => {
  // This fixture is assembled from real records rather than captured whole —
  // one per `(source, type, fields)` shape the 1,024-record corpus held, with
  // the prose elided. It is the only way to drive fifteen record types through
  // the renderer without shipping somebody's actual work as a fixture.

  it('renders the agent’s prose and its calls, and nothing else', () => {
    const turn = turnsOf(RECORD_TYPES)[0];
    const rendered = renderAntigravityTurn(turn);

    // Five `PLANNER_RESPONSE` records: prose, prose+thinking, calls only,
    // prose+calls, thinking+calls.
    expect(rendered.textBlocks).toBe(3);
    expect(rendered.toolBlocks).toBe(3);
    // The eleven tool-result and five SYSTEM records contributed nothing…
    expect(rendered.body).not.toContain('Created At:');
    expect(rendered.body).not.toContain('CHECKPOINT');
    // …and none of them was mistaken for a type this reader has never seen.
    expect(rendered.unknownRecordTypes).toEqual([]);
  });

  it('covers every record type the corpus contained', () => {
    // The fixture and the two silent sets have to stay in step: a type in the
    // file that is on neither set would show up as unknown, and a type on a set
    // that the file never exercises is an untested branch.
    const types = new Set(
      parseAntigravityTranscript(RECORD_TYPES).records.map((record) => record.type)
    );
    for (const type of ANTIGRAVITY_TOOL_RESULT_TYPES) expect(types.has(type), type).toBe(true);
    for (const type of ANTIGRAVITY_SYSTEM_TYPES) expect(types.has(type), type).toBe(true);
    expect(types.has('PLANNER_RESPONSE')).toBe(true);
    expect(types.has('USER_INPUT')).toBe(true);
  });

  it('carries a `RUNNING` record, and renders around it rather than stopping', () => {
    // 4 of 1,024 records are a background task agy never marked done. They are
    // tool results, so they are silent — but a reader that treated `RUNNING` as
    // "stop here" would drop everything a long-running turn said afterwards.
    const parsed = parseAntigravityTranscript(RECORD_TYPES);
    expect(parsed.records.some((record) => record.status === 'RUNNING')).toBe(true);
    expect(renderAntigravityTurn(turnsOf(RECORD_TYPES)[0]).body.length).toBeGreaterThan(0);
  });

  it('reports a record type it has no rule for instead of dropping it', () => {
    // An agy release that grows a sixteenth type must surface, not vanish.
    const future = [
      '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>\\nq\\n</USER_REQUEST>"}',
      '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","content":"a"}',
      '{"step_index":2,"source":"MODEL","type":"HOLOGRAM","content":"?"}',
      '{"step_index":3,"source":"ORACLE","type":"PROPHECY","content":"?"}',
    ].join('\n');
    const rendered = renderAntigravityTurn(turnsOf(future)[0]);
    expect([...rendered.unknownRecordTypes].sort()).toEqual(['HOLOGRAM', 'PROPHECY']);
    expect(rendered.body).toBe('a');
  });
});

describe('[#2198] bounds', () => {
  it('truncates a body that would not fit, and says so in the text', () => {
    const turn: AntigravityTurnAccumulator = {
      conversationId: CONVERSATION,
      stepIndex: 0,
      startedAt: 1,
      prompt: null,
      records: [
        {
          stepIndex: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          timestampMs: 1,
          content: 'x'.repeat(MAX_ANTIGRAVITY_TURN_BODY_LENGTH + 1000),
          thinking: null,
          toolCalls: [],
        } satisfies AntigravityTranscriptRecord,
      ],
      overflowed: false,
    };
    const body = renderAntigravityTurn(turn).body;
    expect(body).toHaveLength(MAX_ANTIGRAVITY_TURN_BODY_LENGTH);
    expect(body.endsWith(ANTIGRAVITY_TURN_TRUNCATION_MARKER)).toBe(true);
  });

  it('is an empty body for a turn that said nothing', () => {
    const silent = [
      '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>\\nq\\n</USER_REQUEST>"}',
      '{"step_index":1,"source":"MODEL","type":"LIST_DIRECTORY","content":"Created At: … "}',
    ].join('\n');
    expect(renderAntigravityTurn(turnsOf(silent)[0]).body).toBe('');
  });
});

describe('[#2198] the hook payloads that name the transcript', () => {
  it('puts one conversation id on every event of the captured session', () => {
    // Including across `--continue`, which is what makes the pointer stable for
    // the life of the conversation rather than per invocation.
    const ids = new Set(
      HOOK_EVENTS.map((event) =>
        String(event.payload.sessionId ?? event.payload.conversationId ?? '')
      )
    );
    expect([...ids]).toEqual([CONVERSATION]);
    expect(HOOK_EVENTS.filter((e) => e.turn === 3)).not.toHaveLength(0);
  });

  it('names a transcript whose directory is that conversation id', () => {
    // The measurement the whole reader rests on: the path is computed from the
    // pointer, not searched for.
    const paths = new Set(
      HOOK_EVENTS.filter((e) => e.kind === 'permission-request').map((e) =>
        String(e.payload.transcriptPath)
      )
    );
    expect(paths.size).toBe(1);
    expect([...paths][0]).toContain(`/brain/${CONVERSATION}/.system_generated/logs/`);
    expect([...paths][0].endsWith('transcript_full.jsonl')).toBe(true);
  });

  it('reports a `cwd` that is agy’s config directory, not the workspace', () => {
    // Which is why worktree identity keeps coming from the relay argument and
    // never from the payload — and why there is no cwd fallback in `./history`.
    for (const event of HOOK_EVENTS.filter((e) => e.kind === 'agent-event')) {
      expect(String(event.payload.cwd)).toContain('/gemini/config');
    }
  });
});

/**
 * A codex turn whose head fell outside the window (Issue #2402).
 *
 * Measured on 2026-09-07: a 30 MB / 7,408-line rollout whose newest turn ran
 * seven hours over 387 items and four compactions, so its `task_started` and its
 * first two prompts sat outside the 4 MiB tail `readTranscriptTail` reads while
 * its later items sat inside it. `buildCodexTurns` opened that turn on whichever
 * record the window happened to start with and could not tell it from a turn it
 * had watched begin, so the reply was written with its opening silently missing.
 *
 * Two halves, in this file because they are one claim:
 *
 *  1. The pure half. `started` is the opening mark, paired with `closed`, and a
 *     turn without it renders behind `CODEX_TURN_HEAD_TRUNCATION_MARKER`.
 *  2. The writer half. The row is **written** — that is the divergence from
 *     claude, whose `collectHeadlessClaudeTurn` renders the same situation and
 *     refuses, because claude has no key for a turn whose prompt record is
 *     outside the window and codex does (`turn_id` is on every
 *     `item_completed`). The report that goes with it carries only what the
 *     window measured.
 *
 * The negative control runs against the same captured rollout **whole**, where
 * every turn's `task_started` is inside the window: every body has to come out
 * byte-identical to what it was before this Issue.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

/** A stand-in for `chat_messages`, keyed the way the real table's index is. */
const rows = new Map<string, Record<string, unknown>>();
function defaultCreateMessage(_db: unknown, message: Record<string, unknown>) {
  const saved = { id: `msg-${rows.size + 1}`, ...message };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
}
const createMessage = vi.fn(defaultCreateMessage);
const findMessageByRequestId = vi.fn(
  (_db: unknown, worktreeId: string, requestId: string) =>
    rows.get(`${worktreeId}::${requestId}`) ?? null
);

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => [],
  setMessageRequestId: () => true,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

const info = vi.fn();
vi.mock('@/lib/logger', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: (...a: unknown[]) => info(...a),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: () => mockLogger,
  };
  return { createLogger: () => mockLogger, generateRequestId: () => 'test-request-id' };
});

import {
  captureCodexTranscriptTurn,
  codexSessionsRoot,
  resetCodexTranscriptSessions,
  CODEX_TRANSCRIPT_TAIL_BYTES,
} from '@/lib/hooks/sources/codex/history';
import {
  buildCodexTurns,
  parseCodexRollout,
  renderCodexTurn,
  CODEX_TURN_HEAD_TRUNCATION_MARKER,
  type CodexTurnAccumulator,
} from '@/lib/hooks/sources/codex/transcript';
import { codexPromptRequestId, codexTurnRequestId } from '@/types/agent-transcript';

const FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/codex');
const THREE_TURNS = readFileSync(join(FIXTURES, 'rollout-three-turns-01510.jsonl'), 'utf8');
/**
 * The same capture, from the byte the window would have opened on.
 *
 * Byte-for-byte the tail of `rollout-three-turns-01510.jsonl` starting at the
 * line after its last `task_started` — which is exactly what
 * `readTranscriptTail` hands the parser when the window opens inside that line,
 * because it drops its own partial first line.
 */
const HEADLESS_TAIL = readFileSync(join(FIXTURES, 'rollout-headless-tail-2402.jsonl'), 'utf8');

const WORKTREE_ID = 'wt-2402';
const SESSION = '01a05a82-d71b-7bc3-8901-487b0db19d40';
const LAST_TURN = '01a05a84-76f2-7390-83f3-51ea1346a364';
const LAST_PROMPT_ITEM = '01a05a84-773a-7bc1-84b3-13ab3d89aedd';
/** What turn 3 renders to when the window did see its `task_started`. */
const LAST_BODY = '## Result\n\n- alpha\n- beta\n\n**Done.**';

const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'codex', instanceId: 'codex' } as const;

let codexHome: string;

async function writeRollout(body: string): Promise<string> {
  const dir = join(codexSessionsRoot(codexHome), '2026', '09', '01');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-01T10-08-39-${SESSION}.jsonl`);
  await writeFile(path, body, 'utf8');
  return path;
}

function turnsOf(text: string): readonly CodexTurnAccumulator[] {
  return buildCodexTurns(parseCodexRollout(text).records, SESSION).turns;
}

function savedRows(): Array<Record<string, unknown>> {
  return createMessage.mock.calls.map(([, message]) => message);
}

function loggedHeadless(): Array<Record<string, unknown>> {
  return info.mock.calls
    .filter(([event]) => event === 'codex-transcript-turn-headless')
    .map(([, detail]) => detail as Record<string, unknown>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  resetCodexTranscriptSessions();
  codexHome = await mkdtemp(join(tmpdir(), 'cmate-2402-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

describe('[#2402] `started` is the opening mark, paired with `closed`', () => {
  it('is true for every turn of a capture read whole', () => {
    const turns = turnsOf(THREE_TURNS);
    expect(turns).toHaveLength(3);
    expect(turns.map((turn) => turn.started)).toEqual([true, true, true]);
    expect(turns.map((turn) => turn.closed)).toEqual([true, true, true]);
  });

  it('is false for the turn the window opened in the middle of', () => {
    const turns = turnsOf(HEADLESS_TAIL);
    expect(turns).toHaveLength(1);
    expect(turns[0].turnId).toBe(LAST_TURN);
    // The whole point: the id is still readable. codex stamps `turn_id` on every
    // `item_completed`, not only on `task_started`, so a window that missed the
    // opening still knows which turn this is — which is what makes the row
    // writable under a key a later read recognises.
    expect(turns[0].started).toBe(false);
    expect(turns[0].closed).toBe(true);
  });

  it('is not inferred from "this was the first record we saw"', () => {
    // The defect. Every turn in a window has a first record; only some of them
    // have a `task_started`. A `started` derived from record order would be true
    // here, which is how the missing head stayed invisible.
    const [headless] = turnsOf(HEADLESS_TAIL);
    const [, , whole] = turnsOf(THREE_TURNS);
    expect(headless.turnId).toBe(whole.turnId);
    expect(headless.startedAt).toBeGreaterThan(0);
    expect(whole.startedAt).toBeGreaterThan(0);
    expect(headless.started).not.toBe(whole.started);
  });

  it('opens a turn that never got a `task_started` record at all', () => {
    // A turn whose opening was lost is still a turn: the items are read, the id
    // is read, and only the mark differs. Nothing about the grouping changes.
    const [headless] = turnsOf(HEADLESS_TAIL);
    const [, , whole] = turnsOf(THREE_TURNS);
    expect(headless.items.map((item) => item.type)).toEqual(
      whole.items.map((item) => item.type)
    );
    expect(headless.prompts.map((prompt) => prompt.itemId)).toEqual(
      whole.prompts.map((prompt) => prompt.itemId)
    );
  });
});

describe('[#2402] the body says so', () => {
  it('marks the head of a headless turn and leaves the rest alone', () => {
    const rendered = renderCodexTurn(turnsOf(HEADLESS_TAIL)[0]);
    expect(rendered.headless).toBe(true);
    expect(rendered.body).toBe(`${CODEX_TURN_HEAD_TRUNCATION_MARKER}${LAST_BODY}`);
    expect(CODEX_TURN_HEAD_TRUNCATION_MARKER).toBe('_(head truncated)_\n\n');
  });

  it('leaves a turn the window watched begin byte-identical (negative control)', () => {
    const bodies = turnsOf(THREE_TURNS).map((turn) => renderCodexTurn(turn));
    expect(bodies.map((rendered) => rendered.headless)).toEqual([false, false, false]);
    expect(bodies.map((rendered) => rendered.body)).toEqual([
      'PONG-1',
      expect.stringContaining('marker.txt'),
      LAST_BODY,
    ]);
    for (const rendered of bodies) {
      expect(rendered.body).not.toContain('head truncated');
    }
  });

  it('does not put a marker on a headless turn that rendered to nothing', () => {
    // A row whose entire content is "something is missing" is worse than no row:
    // `writeCodexTurn` hands an empty body to the scraper, and it can only do
    // that while the body is still empty.
    const turn: CodexTurnAccumulator = {
      sessionId: SESSION,
      turnId: 'silent',
      startedAt: 1,
      prompts: [],
      items: [],
      started: false,
      closed: true,
      overflowed: false,
    };
    const rendered = renderCodexTurn(turn);
    expect(rendered.headless).toBe(true);
    expect(rendered.body).toBe('');
  });
});

describe('[#2402] the writer keeps the turn instead of dropping it', () => {
  it('writes the marked body and reports the headless turn', async () => {
    await writeRollout(HEADLESS_TAIL);

    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);

    const assistant = savedRows().filter((row) => row.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].requestId).toBe(codexTurnRequestId(LAST_TURN));
    expect(assistant[0].content).toBe(`${CODEX_TURN_HEAD_TRUNCATION_MARKER}${LAST_BODY}`);

    const [report] = loggedHeadless();
    expect(report).toMatchObject({
      worktreeId: WORKTREE_ID,
      instanceId: 'codex',
      sessionId: SESSION,
      turnId: LAST_TURN,
      windowBytes: CODEX_TRANSCRIPT_TAIL_BYTES,
      // The prompt that IS in the window. An earlier one folded into the same
      // turn before the window opened would not be here — that is the fact this
      // number exists to make readable.
      promptsInWindow: 1,
      itemsInWindow: 1,
    });
    // Only measured quantities. How much fell out of the window is not knowable
    // from a read that never saw those bytes, so it is not reported.
    expect(report.windowFirstRecordAt).toBe(Date.parse('2026-09-01T01:10:25.802Z'));
    expect(Object.keys(report)).not.toContain('droppedRecords');
  });

  it('still records the prompts the window did hold', async () => {
    await writeRollout(HEADLESS_TAIL);
    await captureCodexTranscriptTurn(TARGET, { codexHome });

    const user = savedRows().filter((row) => row.role === 'user');
    expect(user.map((row) => row.requestId)).toEqual([codexPromptRequestId(LAST_PROMPT_ITEM)]);
  });

  it('writes the row once, under a key the next read recognises', async () => {
    // The property that lets codex write what claude cannot: the key comes off
    // the records that ARE in the window, so a second read of the same window
    // finds the row rather than writing a second one.
    await writeRollout(HEADLESS_TAIL);
    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);
    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);

    expect(savedRows().filter((row) => row.role === 'assistant')).toHaveLength(1);
    expect(loggedHeadless()).toHaveLength(1);
  });

  it('says nothing about a turn the window watched begin (negative control)', async () => {
    await writeRollout(THREE_TURNS);

    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);

    const assistant = savedRows().filter((row) => row.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(LAST_BODY);
    expect(loggedHeadless()).toEqual([]);
  });

  it('marks the turn the 4 MiB window actually cuts, on a file larger than it', async () => {
    // The measured failure, through the real window rather than a pre-sliced
    // fixture. The turn's own output is what pushes its opening out: everything
    // after `task_started` here is more than CODEX_TRANSCRIPT_TAIL_BYTES, which
    // is the shape of the 30 MB rollout measured on 2026-09-07 (387 items, four
    // compactions, seven hours). The filler is the rollout's OWN duplicate
    // stream — `response_item` lines, which this reader counts and drops — so
    // the padding cannot contribute to the body it is supposed to be pushing
    // out of reach.
    const lines = THREE_TURNS.trim().split('\n');
    const throughThePrompt = lines.slice(0, 34).join('\n'); // …`task_started`…`UserMessage`
    const duplicateLine = lines[32]; // the model-facing copy of that prompt
    const reply = [lines[34], lines[37]].join('\n'); // `AgentMessage`, `task_complete`
    expect(duplicateLine).toContain('"response_item"');
    expect(lines[30]).toContain('"task_started"');

    const fillerLines = Math.ceil(
      (CODEX_TRANSCRIPT_TAIL_BYTES + 8192) / (Buffer.byteLength(duplicateLine, 'utf8') + 1)
    );
    const filler = Array.from({ length: fillerLines }, () => duplicateLine).join('\n');
    const path = await writeRollout(`${throughThePrompt}\n${filler}\n${reply}\n`);
    const { statSync } = await import('fs');
    expect(statSync(path).size).toBeGreaterThan(CODEX_TRANSCRIPT_TAIL_BYTES);

    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);

    const assistant = savedRows().filter((row) => row.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].requestId).toBe(codexTurnRequestId(LAST_TURN));
    expect(assistant[0].content).toBe(`${CODEX_TURN_HEAD_TRUNCATION_MARKER}${LAST_BODY}`);

    // The prompt went out of the window with the opening, so there is no user
    // row for it — the orphan this Issue deliberately does NOT adopt, because
    // there is no text to match an unkeyed `/send` row against. The count is
    // what makes it readable afterwards.
    expect(savedRows().filter((row) => row.role === 'user')).toEqual([]);
    expect(loggedHeadless()).toHaveLength(1);
    expect(loggedHeadless()[0]).toMatchObject({ promptsInWindow: 0, itemsInWindow: 1 });
  });
});

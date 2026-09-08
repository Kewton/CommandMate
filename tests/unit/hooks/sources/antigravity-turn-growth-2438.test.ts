/**
 * A saved antigravity row grows when the conclusion arrives (Issue #2438).
 *
 * agy has no record that closes a turn, so `isAntigravityTurnClosingRecord` has
 * to read prose-with-no-`tool_calls` as "it answered" — and an **interim
 * report** has exactly that shape. The reported failure is what happens next:
 * the writer saves that interim body under
 * `antigravity-turn:<conversationId>#<stepIndex>`, the conclusion is appended to
 * the same turn, and every later read finds the row, answers "already saved",
 * and suppresses the scrape that could have carried the missing half. The row
 * was frozen and nothing in the system revisited it.
 *
 * So the subject here is the **second** read of one transcript, and the file is
 * organised around it: the two-stage capture first, then the conditions under
 * which a row must be left alone, then the bounds of the recheck.
 *
 * The transcripts are `tests/fixtures/antigravity-turn-growth-2438`; see that
 * directory's README for what in them is agy's shape and what is invented. The
 * measured lengths of the real session (16,959 → 21,581) are deliberately not
 * asserted anywhere: what is pinned is `renderAntigravityTurn`'s own output.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * The write half of the table, and it really writes.
 *
 * A `vi.fn()` that only records its arguments would let every assertion in this
 * file pass against an implementation that broadcast an update and changed
 * nothing — and "the row still holds the interim report" is the whole defect.
 * So the stored row is mutated here, which is also what makes the third read
 * below meaningful: it finds the grown body and therefore has nothing to do.
 */
const updateMessageContent = vi.fn((_db: unknown, messageId: string, content: string) => {
  for (const row of rows.values()) {
    if (row.id === messageId) {
      row.content = content;
      return;
    }
  }
  throw new Error(`updateMessageContent for a row that does not exist: ${messageId}`);
});

const createMessage = vi.fn(defaultCreateMessage);
function defaultFindMessageByRequestId(_db: unknown, worktreeId: string, requestId: string) {
  return rows.get(`${worktreeId}::${requestId}`) ?? null;
}
const findMessageByRequestId = vi.fn(defaultFindMessageByRequestId);
const broadcastMessage = vi.fn();

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateMessageContent: (...a: [unknown, string, string]) => updateMessageContent(...a),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => [],
  setMessageRequestId: () => true,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...a: unknown[]) => broadcastMessage(...a),
}));

import {
  ANTIGRAVITY_TURN_RECHECK_LIMIT,
  antigravityTranscriptPath,
  captureAntigravityTranscriptTurn,
  resetAntigravityTranscriptConversations,
} from '@/lib/hooks/sources/antigravity/history';
import {
  buildAntigravityTurns,
  parseAntigravityTranscript,
  renderAntigravityTurn,
} from '@/lib/hooks/sources/antigravity/transcript';
import { antigravityTurnRequestId } from '@/types/agent-transcript';
import type { StructuredHistoryCaptureReport } from '@/lib/polling/structured-history-gate';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/antigravity-turn-growth-2438');
const WORKTREE_ID = 'wt-2438';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const TARGET = {
  worktreeId: WORKTREE_ID,
  cliToolId: 'antigravity',
  instanceId: 'antigravity',
} as const;

/** The one turn both fixtures hold. */
const TURN = 0;

let intermediate: string;
let completed: string;
let home: string;

async function writeTranscript(body: string): Promise<string> {
  const path = antigravityTranscriptPath(home, CONVERSATION);
  if (!path) throw new Error('not a conversation id');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
  return path;
}

function capture(): Promise<boolean> {
  return captureAntigravityTranscriptTurn(TARGET, { antigravityHome: home });
}

/** What the reader would render this transcript's turn to. */
function bodyOf(text: string, stepIndex = TURN): string {
  const turns = buildAntigravityTurns(
    parseAntigravityTranscript(text).records,
    CONVERSATION
  ).turns;
  const turn = turns.find((candidate) => candidate.stepIndex === stepIndex);
  if (!turn) throw new Error(`no turn for step ${stepIndex}`);
  return renderAntigravityTurn(turn).body;
}

function requestIdOf(stepIndex = TURN): string {
  return antigravityTurnRequestId(CONVERSATION, stepIndex);
}

function rowOf(stepIndex = TURN): Record<string, unknown> | undefined {
  return rows.get(`${WORKTREE_ID}::${requestIdOf(stepIndex)}`);
}

/** A row this reader is to believe it wrote on an earlier poll. */
function pretendSaved(stepIndex: number, content: string): void {
  rows.set(`${WORKTREE_ID}::${requestIdOf(stepIndex)}`, {
    id: `pre-${stepIndex}`,
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content,
    requestId: requestIdOf(stepIndex),
    timestamp: new Date('2026-09-09T00:00:03Z'),
  });
}

function assistantRows(): Array<Record<string, unknown>> {
  return createMessage.mock.calls
    .map(([, message]) => message)
    .filter((message) => message.role === 'assistant');
}

/**
 * The fixture's own lines with every `step_index` moved, so one file can hold
 * several turns without any record being invented for the occasion.
 */
function shiftSteps(text: string, offset: number): string {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = JSON.parse(line) as { step_index: number };
      return JSON.stringify({ ...record, step_index: record.step_index + offset });
    })
    .join('\n');
}

/** `count` copies of the completed turn, ten steps apart. Turn N opens at N*10. */
function manyTurns(count: number): string {
  const blocks: string[] = [];
  for (let index = 0; index < count; index += 1) blocks.push(shiftSteps(completed, index * 10));
  return `${blocks.join('\n')}\n`;
}

/** agy reaching for a tool again after the reply this transcript ends on. */
function reopenedWith(text: string, stepIndex: number): string {
  const reopening = JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-09-09T00:00:06Z',
    content: 'Checking the worker once more before I answer.',
    tool_calls: [{ name: 'run_command', args: { toolAction: 'Re-check worker' } }],
  });
  return `${text.trimEnd()}\n${reopening}\n`;
}

beforeAll(async () => {
  intermediate = await readFile(join(FIXTURE_DIR, 'intermediate.jsonl'), 'utf8');
  completed = await readFile(join(FIXTURE_DIR, 'completed.jsonl'), 'utf8');
});

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  findMessageByRequestId.mockImplementation(defaultFindMessageByRequestId);
  resetAntigravityTranscriptConversations();
  home = await mkdtemp(join(tmpdir(), 'cmate-2438-agy-'));
  getLastAgentEvent.mockReturnValue({ sessionId: CONVERSATION });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('what the fixtures are, before anything is asserted about them', () => {
  it('are one turn each, and the interim body is a prefix problem rather than a parse one', () => {
    expect(bodyOf(intermediate)).toContain('Intermediate report');
    expect(bodyOf(intermediate)).not.toContain('FINAL_RESULT');
    expect(bodyOf(completed)).toContain('FINAL_RESULT');
    expect(bodyOf(completed).length).toBeGreaterThan(bodyOf(intermediate).length);
  });
});

describe('the second read of a turn that has since concluded', () => {
  it('saves the interim report first — which is the defect, not a mistake in the fixture', async () => {
    await writeTranscript(intermediate);

    expect(await capture()).toBe(true);

    expect(assistantRows()).toHaveLength(1);
    expect(rowOf()?.content).toBe(bodyOf(intermediate));
  });

  it('replaces that row with the conclusion, with pending empty', async () => {
    await writeTranscript(intermediate);
    await capture();
    const first = rowOf();

    await writeTranscript(completed);
    expect(await capture()).toBe(true);

    expect(rowOf()?.content).toBe(bodyOf(completed));
    expect(rowOf()?.content).toContain('FINAL_RESULT');
    expect(updateMessageContent).toHaveBeenCalledWith({}, first?.id, bodyOf(completed));
  });

  it('adds no assistant row and keeps the id, requestId and timestamp', async () => {
    await writeTranscript(intermediate);
    await capture();
    const { id, requestId, timestamp } = rowOf() as Record<string, unknown>;

    await writeTranscript(completed);
    await capture();

    expect(assistantRows()).toHaveLength(1);
    expect(rowOf()).toMatchObject({ id, requestId, timestamp });
  });

  it('delivers the replacement as `message_updated`, never as a second `message`', async () => {
    await writeTranscript(intermediate);
    await capture();

    await writeTranscript(completed);
    broadcastMessage.mockClear();
    await capture();

    expect(broadcastMessage).toHaveBeenCalledWith('message_updated', {
      worktreeId: WORKTREE_ID,
      message: expect.objectContaining({
        id: rowOf()?.id,
        requestId: requestIdOf(),
        content: bodyOf(completed),
      }),
    });
    const announced = broadcastMessage.mock.calls.filter(
      ([event, payload]) =>
        event === 'message' &&
        (payload as { message: { role: string } }).message.role === 'assistant'
    );
    expect(announced).toHaveLength(0);
  });

  it('does nothing at all on a third read of the same transcript', async () => {
    await writeTranscript(intermediate);
    await capture();
    await writeTranscript(completed);
    await capture();

    updateMessageContent.mockClear();
    broadcastMessage.mockClear();
    expect(await capture()).toBe(true);

    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(broadcastMessage).not.toHaveBeenCalled();
  });
});

describe('a row is left alone unless the turn really grew', () => {
  it('leaves a different body of the same length', async () => {
    // Longer implies different; different does not imply longer. Only the first
    // is evidence that agy wrote more, and the second is how a window that slid
    // would look.
    const sameLength = 'x'.repeat(bodyOf(completed).length);
    pretendSaved(TURN, sameLength);
    await writeTranscript(completed);

    expect(await capture()).toBe(true);

    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(rowOf()?.content).toBe(sameLength);
  });

  it('never overwrites a full reply with a shorter render', async () => {
    // The transcript window slid, or the file was truncated: whatever it is, a
    // shorter body is not a turn that grew, and putting it over the row would
    // be worse than the bug.
    pretendSaved(TURN, bodyOf(completed));
    await writeTranscript(intermediate);

    expect(await capture()).toBe(true);

    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(rowOf()?.content).toBe(bodyOf(completed));
  });

  it('waits while a saved turn is open again, however much longer it renders', async () => {
    // agy reached for a tool after the reply the row was written from. The body
    // in the file is longer AND is mid-loop — writing it would put a paragraph
    // ending in a tool call into History and rewrite the row on every poll.
    const reopened = reopenedWith(intermediate, 4);
    expect(bodyOf(reopened).length).toBeGreaterThan(bodyOf(intermediate).length);
    pretendSaved(TURN, bodyOf(intermediate));
    await writeTranscript(reopened);

    expect(await capture()).toBe(true);

    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(rowOf()?.content).toBe(bodyOf(intermediate));
  });
});

describe('the recheck runs alongside the ordinary write path', () => {
  it('repairs the old turn and still refuses the new one that is unfinished', async () => {
    // The case the return value has to keep straight: A is repaired, B is not
    // saved, and the answer is about B. A caller told `true` here would drop the
    // scrape that is B's only record.
    const twoTurns = reopenedWith(`${completed.trimEnd()}\n${shiftSteps(intermediate, 10)}`, 14);
    pretendSaved(TURN, bodyOf(intermediate));
    await writeTranscript(twoTurns);

    expect(await capture()).toBe(false);

    expect(rowOf()?.content).toBe(bodyOf(twoTurns, TURN));
    expect(rowOf()?.content).toContain('FINAL_RESULT');
    expect(rowOf(10)).toBeUndefined();
  });

  it('grows a row that appeared between the anchor scan and the write', async () => {
    // The writer's own already-saved branch, which is the other half of the
    // Issue's "do not implement the comparison twice". It is reachable when a
    // row is created between the two lookups, so the row is hidden from the
    // anchor scan alone.
    pretendSaved(TURN, bodyOf(intermediate));
    let hidden = true;
    findMessageByRequestId.mockImplementation((db, worktreeId, requestId) => {
      if (hidden && requestId === requestIdOf()) {
        hidden = false;
        return null;
      }
      return defaultFindMessageByRequestId(db, worktreeId, requestId);
    });
    await writeTranscript(completed);

    expect(await capture()).toBe(true);

    expect(assistantRows()).toHaveLength(0);
    expect(rowOf()?.content).toBe(bodyOf(completed));
  });

  it('does not report a repair as a verdict about the newest turn', async () => {
    // #2436's out-parameter answers "why false", and a grow is neither a false
    // nor about this turn's completeness. The pending-empty read returns true,
    // so it leaves the field exactly as the caller handed it over.
    await writeTranscript(intermediate);
    await capture();
    await writeTranscript(completed);

    const report: StructuredHistoryCaptureReport = {};
    expect(
      await captureAntigravityTranscriptTurn(TARGET, { antigravityHome: home }, report)
    ).toBe(true);

    expect(updateMessageContent).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBeUndefined();
  });

  it('creates nothing for a candidate that has no row', async () => {
    // The anchor rule already decided the older turn is not this pass's to
    // write. The recheck repairs rows; it does not backfill them.
    const twoTurns = manyTurns(2);
    pretendSaved(10, 'x');
    await writeTranscript(twoTurns);

    expect(await capture()).toBe(true);

    expect(assistantRows()).toHaveLength(0);
    expect(rowOf(TURN)).toBeUndefined();
  });

  it('looks no further back than the newest written turns the limit allows', async () => {
    // Two turns past the bound, so the file proves both halves: the ones inside
    // it are repaired and the ones outside it are not touched at all.
    const older = 2;
    const total = ANTIGRAVITY_TURN_RECHECK_LIMIT + older;
    const transcript = manyTurns(total);
    for (let index = 0; index < total; index += 1) pretendSaved(index * 10, 'x');
    await writeTranscript(transcript);

    expect(await capture()).toBe(true);

    for (let index = 0; index < total; index += 1) {
      const step = index * 10;
      expect(rowOf(step)?.content).toBe(index < older ? 'x' : bodyOf(transcript, step));
    }
  });

  it('is bounded at three, the number claude and command-code settled on', () => {
    expect(ANTIGRAVITY_TURN_RECHECK_LIMIT).toBe(3);
  });
});

describe('the fallbacks the repair must not have disturbed', () => {
  it('still writes a turn nobody has saved, and answers true', async () => {
    await writeTranscript(completed);

    expect(await capture()).toBe(true);

    expect(assistantRows().map((message) => message.requestId)).toEqual([requestIdOf()]);
    expect(rowOf()?.content).toBe(bodyOf(completed));
  });

  it('still backfills every turn after the anchor, oldest first', async () => {
    const three = manyTurns(3);
    pretendSaved(0, bodyOf(three, 0));
    await writeTranscript(three);

    expect(await capture()).toBe(true);

    expect(assistantRows().map((message) => message.requestId)).toEqual([
      requestIdOf(10),
      requestIdOf(20),
    ]);
  });

  it('still answers false when there is no transcript to read', async () => {
    expect(await capture()).toBe(false);

    expect(updateMessageContent).not.toHaveBeenCalled();
  });

  it('still answers false when no hook has named a conversation', async () => {
    getLastAgentEvent.mockReturnValue(null);
    await writeTranscript(completed);

    expect(await capture()).toBe(false);

    expect(updateMessageContent).not.toHaveBeenCalled();
  });
});

/**
 * Saving an antigravity turn and finishing one are different facts (#2443).
 *
 * #2438 established that a row this reader wrote can be wrong — agy has no
 * record that closes a turn, so an interim report ("waiting for the worker") is
 * `PLANNER_RESPONSE` prose with no `tool_calls` exactly as a conclusion is — and
 * made the row repairable. What it left in place is everything the same `true`
 * *triggers*: the gate announces a completion from it, a relay delivers the body
 * to whoever asked agy the question, and no later `message_updated` takes that
 * back.
 *
 * So this file is about the second word the reader now returns. `report`'s
 * `completion` is `'settled'` only when agy's own `Stop` can be placed at or
 * after the turn's newest record, and `'provisional'` otherwise — with the row
 * still written, still repaired, and still followed by `step_index` once the
 * turn has fallen out of #2438's three-turn window.
 *
 * The transcripts are `tests/fixtures/antigravity-turn-completion-2443`; see
 * that directory's README for which of their properties are agy's shape, which
 * are the reported survey's timing envelope, and which are invented. The
 * 156-second gap in them is a **control**: the tests below change it and expect
 * no verdict to move.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
const getLastStopEventAt = vi.fn<(...a: unknown[]) => number | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
  getLastStopEventAt: (...a: unknown[]) => getLastStopEventAt(...a),
}));

/** A stand-in for `chat_messages`, keyed the way the real table's index is. */
const rows = new Map<string, Record<string, unknown>>();

function defaultCreateMessage(_db: unknown, message: Record<string, unknown>) {
  const saved = { id: `msg-${rows.size + 1}`, archived: false, ...message };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
}

/**
 * The write half of the table, and it really writes.
 *
 * The same decision `antigravity-turn-growth-2438.test.ts` documents: a `vi.fn`
 * that only recorded its arguments would let every assertion here pass against
 * an implementation that broadcast an update and changed nothing, and "the row
 * still holds the interim narration" is the whole defect.
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
  ANTIGRAVITY_UNSETTLED_TURN_LIMIT,
  antigravityTranscriptPath,
  captureAntigravityTranscriptTurn,
  resetAntigravityTranscriptConversations,
  resetAntigravityUnsettledTurns,
} from '@/lib/hooks/sources/antigravity/history';
import {
  antigravityTurnLastRecordAt,
  buildAntigravityTurns,
  parseAntigravityTranscript,
  renderAntigravityTurn,
  resolveAntigravityTurnCompletion,
} from '@/lib/hooks/sources/antigravity/transcript';
import { antigravityTurnRequestId } from '@/types/agent-transcript';
import type { StructuredHistoryCaptureReport } from '@/lib/polling/structured-history-gate';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/antigravity-turn-completion-2443');
const WORKTREE_ID = 'wt-2443';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const OTHER_CONVERSATION = '33333333-3333-4333-8333-333333333333';
const TARGET = {
  worktreeId: WORKTREE_ID,
  cliToolId: 'antigravity',
  instanceId: 'antigravity',
} as const;

/** The one turn all three fixtures hold. */
const TURN = 0;

/** `created_at` of `concluded.jsonl`'s last record, which is what a stop is compared to. */
const CONCLUDED_LAST_RECORD_MS = Date.parse('2026-09-09T00:04:42Z');
/** …and of `interim.jsonl`'s. */
const INTERIM_LAST_RECORD_MS = Date.parse('2026-09-09T00:00:05Z');

let interim: string;
let resumed: string;
let concluded: string;
let home: string;

async function writeTranscript(body: string, conversationId = CONVERSATION): Promise<string> {
  const path = antigravityTranscriptPath(home, conversationId);
  if (!path) throw new Error('not a conversation id');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
  return path;
}

function capture(report?: StructuredHistoryCaptureReport): Promise<boolean> {
  return captureAntigravityTranscriptTurn(TARGET, { antigravityHome: home }, report);
}

/** One capture, with the report it filled in. */
async function captureWithReport(): Promise<{
  captured: boolean;
  report: StructuredHistoryCaptureReport;
}> {
  const report: StructuredHistoryCaptureReport = {};
  const captured = await capture(report);
  return { captured, report };
}

/** What the reader would render this transcript's turn to. */
function bodyOf(text: string, stepIndex = TURN, conversationId = CONVERSATION): string {
  const turns = buildAntigravityTurns(
    parseAntigravityTranscript(text).records,
    conversationId
  ).turns;
  const turn = turns.find((candidate) => candidate.stepIndex === stepIndex);
  if (!turn) throw new Error(`no turn for step ${stepIndex}`);
  return renderAntigravityTurn(turn).body;
}

function requestIdOf(stepIndex = TURN, conversationId = CONVERSATION): string {
  return antigravityTurnRequestId(conversationId, stepIndex);
}

function rowOf(stepIndex = TURN, conversationId = CONVERSATION): Record<string, unknown> | undefined {
  return rows.get(`${WORKTREE_ID}::${requestIdOf(stepIndex, conversationId)}`);
}

/** A row this reader is to believe somebody else left behind. */
function pretendSaved(stepIndex: number, content: string, archived = false): void {
  rows.set(`${WORKTREE_ID}::${requestIdOf(stepIndex)}`, {
    id: `pre-${stepIndex}`,
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content,
    requestId: requestIdOf(stepIndex),
    timestamp: new Date('2026-09-09T00:00:05Z'),
    instanceId: 'antigravity',
    archived,
  });
}

function assistantRows(): Array<Record<string, unknown>> {
  return createMessage.mock.calls
    .map(([, message]) => message)
    .filter((message) => message.role === 'assistant');
}

/** The fixture's own lines with every `step_index` moved, so one file holds many turns. */
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

/** Concatenate whole turns, ten steps apart. Turn N opens at N*10. */
function turnsOf(...bodies: string[]): string {
  return `${bodies.map((body, index) => shiftSteps(body, index * 10)).join('\n')}\n`;
}

/** The same records with every `created_at` shifted by `deltaMs` from `fromMs` on. */
function reclock(text: string, fromMs: number, deltaMs: number): string {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = JSON.parse(line) as { created_at?: string };
      const at = record.created_at ? Date.parse(record.created_at) : NaN;
      if (!Number.isFinite(at) || at < fromMs) return JSON.stringify(record);
      return JSON.stringify({ ...record, created_at: new Date(at + deltaMs).toISOString() });
    })
    .join('\n');
}

/** agy appending one more reply after the transcript's last record. */
function appendReply(text: string, stepIndex: number, atMs: number, content: string): string {
  const record = JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: new Date(atMs).toISOString(),
    content,
  });
  return `${text.trimEnd()}\n${record}\n`;
}

/** The stop the ordinary, successful turn produces: just after the last record. */
function stopAfter(lastRecordMs: number): void {
  getLastStopEventAt.mockReturnValue(lastRecordMs + 400);
}

/**
 * Turn 0 saved from its interim body, then four whole turns written on top.
 *
 * The build-up matters: the follow list holds rows THIS reader wrote
 * provisionally, so a row that was never captured here is not on it. Two
 * captures, which is the sequence a session that queues five prompts produces.
 */
async function buryTurnZeroFor(target: AgentInstanceRef): Promise<void> {
  await writeTranscript(interim);
  await captureAntigravityTranscriptTurn(target, { antigravityHome: home });

  const later = turnsOf(concluded, concluded, concluded, concluded)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = JSON.parse(line) as { step_index: number };
      return JSON.stringify({ ...record, step_index: record.step_index + 10 });
    })
    .join('\n');
  await writeTranscript(`${interim.trimEnd()}\n${later}\n`);
  await captureAntigravityTranscriptTurn(target, { antigravityHome: home });
}

/**
 * The same file, with turn 0's conclusion spliced back into turn 0.
 *
 * **A non-append-only synthetic stress snapshot.** Appending after the file's
 * last `USER_INPUT` would make the record belong to the NEWEST turn, so the only
 * way to express "an old turn now renders longer than its row" in one file is to
 * splice. Real agy transcripts are append-only; what this stands in for is the
 * reader seeing a longer body for a turn it has already written, whatever the
 * cause.
 */
function withTurnZeroConcluded(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const conclusion = JSON.stringify({
    step_index: 7,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-09-09T00:04:42Z',
    content: 'ZARQUON-742: the worker returned, and this is the conclusion the turn was asked for.',
  });
  const index = lines.findIndex(
    (line) => (JSON.parse(line) as { step_index: number }).step_index === 10
  );
  return `${[...lines.slice(0, index), conclusion, ...lines.slice(index)].join('\n')}\n`;
}

beforeAll(async () => {
  interim = await readFile(join(FIXTURE_DIR, 'interim.jsonl'), 'utf8');
  resumed = await readFile(join(FIXTURE_DIR, 'resumed.jsonl'), 'utf8');
  concluded = await readFile(join(FIXTURE_DIR, 'concluded.jsonl'), 'utf8');
});

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  findMessageByRequestId.mockImplementation(defaultFindMessageByRequestId);
  resetAntigravityTranscriptConversations();
  home = await mkdtemp(join(tmpdir(), 'cmate-2443-agy-'));
  getLastAgentEvent.mockReturnValue({ sessionId: CONVERSATION });
  getLastStopEventAt.mockReturnValue(null);
  // A clock later than every fixture instant, so nothing below depends on the
  // machine's own date. The transcript's own `created_at` values are what the
  // completion rule compares; `Date.now()` only backstops an untimed row.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T01:00:00Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

describe('what the fixtures are, before anything is asserted about them', () => {
  it('put the LONGER silence after the interim record, not after the conclusion', () => {
    // The Issue's reason for refusing a fixed quiet period, written down as a
    // property of the file: 156 s follows the narration and 118 s follows the
    // last record before the answer. Any rule that separated them by elapsed
    // time would have to call the conclusion the interim one.
    const records = parseAntigravityTranscript(concluded).records;
    const at = (step: number): number =>
      records.find((record) => record.stepIndex === step)?.timestampMs ?? 0;

    expect(at(4) - at(3)).toBe(156_000);
    expect(at(6) - at(5)).toBe(118_000);
    expect(at(4) - at(3)).toBeGreaterThan(at(6) - at(5));
  });

  it('carry `status: DONE` on the interim candidate and the conclusion alike', () => {
    const records = parseAntigravityTranscript(concluded).records;
    const statusOf = (step: number): string | null =>
      records.find((record) => record.stepIndex === step)?.status ?? null;

    expect(statusOf(3)).toBe('DONE');
    expect(statusOf(6)).toBe('DONE');
  });

  it('are one turn each, growing, with the conclusion only in the last one', () => {
    expect(bodyOf(interim)).toContain('INTERIM_NARRATION');
    expect(bodyOf(interim)).not.toContain('ZARQUON-742');
    expect(bodyOf(resumed)).not.toContain('ZARQUON-742');
    expect(bodyOf(concluded)).toContain('ZARQUON-742');
    expect(bodyOf(resumed).length).toBeGreaterThan(bodyOf(interim).length);
    expect(bodyOf(concluded).length).toBeGreaterThan(bodyOf(resumed).length);
  });
});

describe('the evidence itself, as a pure rule', () => {
  function turnOf(text: string) {
    const [turn] = buildAntigravityTurns(
      parseAntigravityTranscript(text).records,
      CONVERSATION
    ).turns;
    return turn;
  }

  it('confirms a closed turn whose stop arrived after its newest record', () => {
    const turn = turnOf(concluded);
    const completion = resolveAntigravityTurnCompletion(turn, CONCLUDED_LAST_RECORD_MS + 400);

    expect(completion).toMatchObject({
      confirmed: true,
      reason: 'stop-after-last-record',
      lastRecordAt: CONCLUDED_LAST_RECORD_MS,
    });
  });

  it('refuses a stop that predates the newest record — the stale one', () => {
    // The stop belonging to the PREVIOUS turn, or to an earlier state of this
    // one. It says nothing about a record that did not exist when it arrived.
    const completion = resolveAntigravityTurnCompletion(
      turnOf(concluded),
      INTERIM_LAST_RECORD_MS
    );

    expect(completion).toMatchObject({ confirmed: false, reason: 'stop-before-last-record' });
  });

  it('refuses a turn with no stop at all', () => {
    expect(resolveAntigravityTurnCompletion(turnOf(concluded), null)).toMatchObject({
      confirmed: false,
      reason: 'no-stop-event',
    });
  });

  it('refuses a turn agy is still working through, however new the stop', () => {
    expect(resolveAntigravityTurnCompletion(turnOf(resumed), Date.now())).toMatchObject({
      confirmed: false,
      reason: 'turn-open',
    });
  });

  it('refuses to correlate a turn whose records carry no clock', () => {
    // Without a `created_at` there is no "before" or "after" to place the stop
    // in, so the rule declines rather than defaulting to the generous answer.
    const unclocked = concluded
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        delete record.created_at;
        return JSON.stringify(record);
      })
      .join('\n');

    expect(resolveAntigravityTurnCompletion(turnOf(unclocked), Date.now())).toMatchObject({
      confirmed: false,
      reason: 'no-timestamped-record',
    });
  });

  it('withdraws itself when agy resumed after the stop it was confirmed by', () => {
    // `./source` warns that a `Stop` can be answered with `{"decision":"continue"}`
    // and the loop goes on. Nothing here detects that word: the resumed loop's
    // records are newer than the stop, and the ordering fails again by itself.
    const stopAt = CONCLUDED_LAST_RECORD_MS + 400;
    expect(resolveAntigravityTurnCompletion(turnOf(concluded), stopAt).confirmed).toBe(true);

    const continued = appendReply(
      concluded,
      7,
      stopAt + 5_000,
      'Actually, one more thing before I finish.'
    );
    expect(resolveAntigravityTurnCompletion(turnOf(continued), stopAt)).toMatchObject({
      confirmed: false,
      reason: 'stop-before-last-record',
    });
  });

  it('reads the newest record and not the last line in file order', () => {
    // `created_at` is agy's own field and a record may carry none, so the
    // comparison walks for a maximum. Pinned because a `records.at(-1)` here
    // would confirm a turn against a record that is not its newest.
    const outOfOrder = appendReply(concluded, 7, CONCLUDED_LAST_RECORD_MS - 60_000, 'A late line.');

    expect(antigravityTurnLastRecordAt(turnOf(outOfOrder))).toBe(CONCLUDED_LAST_RECORD_MS);
  });
});

describe('the three-stage capture of one turn', () => {
  it('saves the narration but does not call the turn finished', async () => {
    await writeTranscript(interim);

    const { captured, report } = await captureWithReport();

    // The save itself is unchanged — #2436's contract and #2437's cursor both
    // depend on it — and it is the SECOND word that stops the delivery.
    expect(captured).toBe(true);
    expect(rowOf()?.content).toBe(bodyOf(interim));
    expect(report.completion).toBe('provisional');
    expect(report.completionReason).toBe('no-stop-event');
    expect(report.completionKey).toBeUndefined();
  });

  it('stays provisional while agy is back at work, 156 seconds on', async () => {
    await writeTranscript(interim);
    await capture();

    await writeTranscript(resumed);
    // The stop that would confirm the FIRST read. It is older than the records
    // agy has written since, so it confirms nothing now.
    getLastStopEventAt.mockReturnValue(INTERIM_LAST_RECORD_MS + 400);
    const { captured, report } = await captureWithReport();

    expect(captured).toBe(true);
    expect(report.completion).toBe('provisional');
    expect(report.completionReason).toBe('turn-open');
  });

  it('settles once the conclusion is written and agy says it stopped', async () => {
    await writeTranscript(interim);
    await capture();
    const first = rowOf();

    await writeTranscript(resumed);
    await capture();

    await writeTranscript(concluded);
    stopAfter(CONCLUDED_LAST_RECORD_MS);
    const { captured, report } = await captureWithReport();

    expect(captured).toBe(true);
    expect(report.completion).toBe('settled');
    expect(report.completionReason).toBe('stop-after-last-record');
    expect(report.completionKey).toBe(`${requestIdOf()}@${CONCLUDED_LAST_RECORD_MS}`);
    // One row throughout, grown in place.
    expect(assistantRows()).toHaveLength(1);
    expect(rowOf()?.content).toBe(bodyOf(concluded));
    expect(rowOf()?.content).toContain('ZARQUON-742');
    expect(rowOf()?.id).toBe(first?.id);
  });

  it('keeps the same completion key on a repeat read of the settled turn', async () => {
    // What the gate dedups the announcement on. The key names the turn AND the
    // instant of its newest record, so an unchanged file is an unchanged key.
    await writeTranscript(concluded);
    stopAfter(CONCLUDED_LAST_RECORD_MS);

    const first = await captureWithReport();
    const second = await captureWithReport();

    expect(first.report.completionKey).toBe(second.report.completionKey);
    expect(first.report.completionKey).toBeDefined();
  });

  it('mints a new key when the turn grew and was confirmed again', async () => {
    await writeTranscript(concluded);
    stopAfter(CONCLUDED_LAST_RECORD_MS);
    const first = await captureWithReport();

    const laterMs = CONCLUDED_LAST_RECORD_MS + 30_000;
    await writeTranscript(appendReply(concluded, 7, laterMs, 'A correction: ZARQUON-743.'));
    stopAfter(laterMs);
    const second = await captureWithReport();

    expect(second.report.completion).toBe('settled');
    expect(second.report.completionKey).not.toBe(first.report.completionKey);
    expect(rowOf()?.content).toContain('ZARQUON-743');
  });

  it('does not settle on a stop that is older than the conclusion', async () => {
    // The transcript is complete and the turn is closed; the only thing missing
    // is agy's word for it. A capture that promoted this would deliver an answer
    // the agent has not said it finished.
    await writeTranscript(concluded);
    getLastStopEventAt.mockReturnValue(INTERIM_LAST_RECORD_MS);

    const { captured, report } = await captureWithReport();

    expect(captured).toBe(true);
    expect(report.completion).toBe('provisional');
    expect(report.completionReason).toBe('stop-before-last-record');
  });

  it('does not settle when no hook has ever reported a stop', async () => {
    await writeTranscript(concluded);
    getLastStopEventAt.mockReturnValue(null);

    expect((await captureWithReport()).report).toMatchObject({
      completion: 'provisional',
      completionReason: 'no-stop-event',
    });
  });

  it('does not settle when the stop lookup is unavailable at all', async () => {
    // A server whose `agent-event-state` cannot be reached — the restart case,
    // and the shape a partially-stubbed module takes. Fail-closed on the
    // promotion, fail-open on the save.
    getLastStopEventAt.mockImplementation(() => {
      throw new Error('module unavailable');
    });
    await writeTranscript(concluded);

    const { captured, report } = await captureWithReport();

    expect(captured).toBe(true);
    expect(report.completion).toBe('provisional');
  });
});

describe('the verdict does not move with the wording, the language or the clock', () => {
  it('reaches the same three verdicts with the narration written in English', async () => {
    const english = (text: string): string =>
      text.replace('現在 Command Code からの返答待機中です。', 'Waiting for the worker to reply.');

    await writeTranscript(english(interim));
    expect((await captureWithReport()).report.completion).toBe('provisional');

    await writeTranscript(english(resumed));
    expect((await captureWithReport()).report.completion).toBe('provisional');

    await writeTranscript(english(concluded));
    stopAfter(CONCLUDED_LAST_RECORD_MS);
    expect((await captureWithReport()).report.completion).toBe('settled');
    expect(rowOf()?.content).toContain('Waiting for the worker to reply.');
    expect(rowOf()?.content).toContain('ZARQUON-742');
  });

  it('is unchanged when the 156-second silence becomes three seconds', async () => {
    // The gap the fixture carries is the widest one the survey reported for an
    // interim candidate. Collapsing it must change nothing, because no constant
    // separates an interim silence from a final one.
    const hurried = reclock(concluded, Date.parse('2026-09-09T00:02:41Z'), -153_000);
    const lastRecordAt = CONCLUDED_LAST_RECORD_MS - 153_000;

    await writeTranscript(hurried);
    getLastStopEventAt.mockReturnValue(null);
    expect((await captureWithReport()).report.completion).toBe('provisional');

    getLastStopEventAt.mockReturnValue(lastRecordAt + 400);
    expect((await captureWithReport()).report.completion).toBe('settled');
  });

  it('is unchanged when the wall clock runs far past the transcript', async () => {
    // Nothing here is a timeout: a turn nobody stopped is provisional an hour
    // later, and a stopped one is settled whenever it is read.
    await writeTranscript(concluded);
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));

    expect((await captureWithReport()).report.completion).toBe('provisional');

    stopAfter(CONCLUDED_LAST_RECORD_MS);
    expect((await captureWithReport()).report.completion).toBe('settled');
  });
});

describe('a provisional row is followed past the ordinary recheck window', () => {
  it('leaves turn 0 outside the three newest written turns', async () => {
    // The control the next test needs: without the follow list, turn 0 is not a
    // candidate at all. Four turns were written after it and the window is three.
    await buryTurnZeroFor(TARGET);
    const buried = await readFile(antigravityTranscriptPath(home, CONVERSATION)!, 'utf8');
    const turns = buildAntigravityTurns(
      parseAntigravityTranscript(buried).records,
      CONVERSATION
    ).turns;

    expect(turns).toHaveLength(5);
    expect(turns.slice(-ANTIGRAVITY_TURN_RECHECK_LIMIT).map((turn) => turn.stepIndex)).toEqual([
      20, 30, 40,
    ]);
  });

  it('repairs it anyway, with no new unsaved turn in the window', async () => {
    await buryTurnZeroFor(TARGET);
    const buried = await readFile(antigravityTranscriptPath(home, CONVERSATION)!, 'utf8');
    await writeTranscript(withTurnZeroConcluded(buried));

    updateMessageContent.mockClear();
    createMessage.mockClear();
    expect(await capture()).toBe(true);

    // Nothing new was written — every turn in the window already had a row — and
    // the repair still happened.
    expect(assistantRows()).toHaveLength(0);
    expect(rowOf(TURN)?.content).toContain('ZARQUON-742');
  });

  it('does not repair it once the follow list has been forgotten', async () => {
    // The control for the tracking gate: same file, same rows, same read — with
    // only the follow list emptied, turn 0 is out of reach and keeps its
    // narration. This is also the honest statement of what a restart costs.
    await buryTurnZeroFor(TARGET);
    const buried = await readFile(antigravityTranscriptPath(home, CONVERSATION)!, 'utf8');
    await writeTranscript(withTurnZeroConcluded(buried));

    resetAntigravityUnsettledTurns();
    expect(await capture()).toBe(true);

    expect(rowOf(TURN)?.content).not.toContain('ZARQUON-742');
    expect(rowOf(TURN)?.content).toContain('INTERIM_NARRATION');
  });

  it('stops following a turn once agy has vouched for it', async () => {
    // The termination condition. A confirmed row cannot grow without a record
    // newer than the stop, and such a record un-confirms it and re-enters it
    // here — so the list holds exactly the provisional rows.
    await writeTranscript(concluded);
    stopAfter(CONCLUDED_LAST_RECORD_MS);
    await capture();

    // Bury it, then take the follow list's only other reach away by asking for a
    // repair it would only make from the list.
    await buryTurnZeroFor(TARGET);
    expect(rowOf(TURN)?.content).toContain('ZARQUON-742');
  });

  it('is bounded, and says so when it drops the oldest', () => {
    expect(ANTIGRAVITY_UNSETTLED_TURN_LIMIT).toBe(16);
    expect(ANTIGRAVITY_UNSETTLED_TURN_LIMIT).toBeGreaterThan(ANTIGRAVITY_TURN_RECHECK_LIMIT);
  });

  it('follows no more turns than the limit allows', async () => {
    // Seventeen provisional rows, one more than the ceiling: the oldest is
    // evicted and keeps its body while the rest are still repaired.
    const total = ANTIGRAVITY_UNSETTLED_TURN_LIMIT + 1;
    for (let index = 0; index < total; index += 1) {
      await writeTranscript(turnsOf(...Array.from({ length: index + 1 }, () => interim)));
      await capture();
    }

    const grown = turnsOf(...Array.from({ length: total }, () => concluded));
    await writeTranscript(grown);
    expect(await capture()).toBe(true);

    expect(rowOf(0)?.content).not.toContain('ZARQUON-742');
    for (let index = 1; index < total; index += 1) {
      expect(rowOf(index * 10)?.content).toContain('ZARQUON-742');
    }
  });
});

describe('what the follow list must never do', () => {
  it('does not carry one conversation’s steps into another', async () => {
    await writeTranscript(interim);
    await capture();
    expect(rowOf(TURN)?.content).toBe(bodyOf(interim));

    // `/clear` mints a new conversation id; the same `step_index` values there
    // are different turns, and re-checking them would be reading the wrong rows.
    getLastAgentEvent.mockReturnValue({ sessionId: OTHER_CONVERSATION });
    await writeTranscript(concluded, OTHER_CONVERSATION);
    findMessageByRequestId.mockClear();
    await capture();

    const asked = findMessageByRequestId.mock.calls.map(([, , requestId]) => String(requestId));
    expect(asked.some((requestId) => requestId.includes(OTHER_CONVERSATION))).toBe(true);
    expect(asked.some((requestId) => requestId.includes(CONVERSATION))).toBe(false);
  });

  it('does not let one instance inherit another instance’s reach', async () => {
    // Rows are keyed `(worktree, conversation, step)` and not by instance, so a
    // sibling reading the same conversation legitimately sees the same rows.
    // What is per-instance is the FOLLOW LIST, and the observable difference is
    // reach: the sibling has written nothing provisionally, so a turn four turns
    // back is outside its window and stays as it was.
    await buryTurnZeroFor(TARGET);
    const buried = await readFile(antigravityTranscriptPath(home, CONVERSATION)!, 'utf8');
    await writeTranscript(withTurnZeroConcluded(buried));

    const sibling = { ...TARGET, instanceId: 'antigravity-2' } as const;
    await captureAntigravityTranscriptTurn(sibling, { antigravityHome: home });
    expect(rowOf(TURN)?.content).not.toContain('ZARQUON-742');

    // The instance that wrote the row provisionally still reaches it.
    await capture();
    expect(rowOf(TURN)?.content).toContain('ZARQUON-742');
  });

  it('stops following a step the read window no longer reaches', async () => {
    await writeTranscript(interim);
    await capture();

    // The tail slid: the file this read sees opens on a different turn, and the
    // step that was followed is not in it. Nothing must be looked up for it
    // again, because nothing can repair it.
    await writeTranscript(shiftSteps(concluded, 50));
    await capture();

    await writeTranscript(shiftSteps(concluded, 50));
    findMessageByRequestId.mockClear();
    await capture();

    const asked = findMessageByRequestId.mock.calls.map(([, , requestId]) => String(requestId));
    expect(asked).not.toContain(requestIdOf(TURN));
  });

  it('stops following a row that is no longer there', async () => {
    // History cleared for this worktree, or the key rewritten: there is nothing
    // left to repair, and asking for it on every poll forever is the failure
    // this drop exists to prevent.
    await buryTurnZeroFor(TARGET);
    rows.delete(`${WORKTREE_ID}::${requestIdOf(TURN)}`);
    await capture();

    findMessageByRequestId.mockClear();
    await capture();

    const asked = findMessageByRequestId.mock.calls.map(([, , requestId]) => String(requestId));
    expect(asked).not.toContain(requestIdOf(TURN));
  });
});

describe('the guarantees #2436, #2437 and #2438 already made', () => {
  it('still refuses to write an open newest turn, and still says why', async () => {
    // #2436's `not_yet_closed`. The completion word is beside it, never in place
    // of it: this `false` is about who writes the row at all.
    await writeTranscript(resumed);

    const { captured, report } = await captureWithReport();

    expect(captured).toBe(false);
    expect(report.outcome).toBe('not_yet_closed');
  });

  it('still answers false when there is no transcript to read', async () => {
    expect(await capture()).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('still answers false when no hook has named a conversation', async () => {
    getLastAgentEvent.mockReturnValue(null);
    await writeTranscript(concluded);

    expect(await capture()).toBe(false);
  });

  it('still answers false for a window with no prompt in it', async () => {
    // The record limit and the 4 MiB tail both produce this: a window that opens
    // mid-turn has no `USER_INPUT` and therefore no turn to key a row on.
    const headless = concluded
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(1)
      .join('\n');
    await writeTranscript(headless);
    stopAfter(CONCLUDED_LAST_RECORD_MS);

    const { captured, report } = await captureWithReport();

    expect(captured).toBe(false);
    expect(report.completion).toBeUndefined();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('still reads a file whose last line was torn by a concurrent append', async () => {
    await writeTranscript(`${concluded.trimEnd()}\n{"step_index":7,"source":"MOD`);
    stopAfter(CONCLUDED_LAST_RECORD_MS);

    const { captured, report } = await captureWithReport();

    expect(captured).toBe(true);
    expect(report.completion).toBe('settled');
    expect(rowOf()?.content).toBe(bodyOf(concluded));
  });

  it('still leaves a row alone when the re-read renders no longer', async () => {
    // #2438's rule, unchanged by #2443: equal or shorter is not growth, and
    // overwriting a full reply with a truncated one is worse than the bug. The
    // completion word does not license a replacement the length check refuses.
    pretendSaved(TURN, bodyOf(concluded));
    await writeTranscript(interim);
    stopAfter(INTERIM_LAST_RECORD_MS);

    expect(await capture()).toBe(true);

    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(rowOf()?.content).toBe(bodyOf(concluded));
  });

  it('still writes no second row when the same transcript is read again', async () => {
    // The restart case: the pointer and the follow list are gone, the file is
    // not. Idempotency is the request id, and it does not depend on either map.
    await writeTranscript(concluded);
    stopAfter(CONCLUDED_LAST_RECORD_MS);
    await capture();

    resetAntigravityTranscriptConversations();
    getLastAgentEvent.mockReturnValue({ sessionId: CONVERSATION });
    expect(await capture()).toBe(true);

    expect(assistantRows()).toHaveLength(1);
  });
});

describe('an archived row (Issue #2444 lands beside this one)', () => {
  it('is repaired without being brought back into History', async () => {
    // `updateMessageContent` names `content` and nothing else, and
    // `findMessageByRequestId` deliberately does not filter archived rows — so a
    // row that was cleared out stays cleared. Pinned here because #2444 makes
    // archived rows common enough for a regression to be noticed late.
    pretendSaved(TURN, bodyOf(interim), true);
    await writeTranscript(concluded);
    stopAfter(CONCLUDED_LAST_RECORD_MS);

    expect(await capture()).toBe(true);

    expect(rowOf()?.content).toBe(bodyOf(concluded));
    expect(rowOf()?.archived).toBe(true);
    expect(broadcastMessage).toHaveBeenCalledWith('message_updated', {
      worktreeId: WORKTREE_ID,
      message: expect.objectContaining({ archived: true, content: bodyOf(concluded) }),
    });
  });
});

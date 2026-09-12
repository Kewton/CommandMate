/**
 * A Claude turn longer than the transcript window (Issue #2470).
 *
 * The reader reads the last {@link CLAUDE_TRANSCRIPT_TAIL_BYTES} of the file,
 * and a turn only opens on a prompt record. A turn bigger than the window —
 * 1.1% of the turns measured, and every one of them a long orchestrate or UAT
 * reply — arrived as assistant records with no prompt in front of them, and the
 * reader answered "no turn". The Stop hook has no scrape to fall back on, so the
 * measured incident wrote no row at all.
 *
 * Every transcript here is built at test time in a temp directory, at the real
 * sizes — more than 4 MiB for the first window, more than 64 MiB for the widest
 * one — and never committed. The bytes are tool results, which is what made the
 * real turns big, and the assertions read what a writer put in `chat_messages`.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, open, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => {
  const mock = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  mock.withContext.mockReturnValue(mock);
  return mock;
});
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  createLogger: () => logger,
}));

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
const updateMessageContent = vi.fn();

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
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

const advanceCapturedLine = vi.fn(async () => null);
vi.mock('@/lib/assistant-response-saver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/assistant-response-saver')>()),
  advanceCapturedLineForTranscriptTurn: (...a: unknown[]) => advanceCapturedLine(...(a as [])),
}));

import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES,
  CLAUDE_TRANSCRIPT_TAIL_BYTES,
  CLAUDE_TURN_HEAD_MISSING_MARKER,
  readClaudeTurnProgress,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import {
  buildHeadlessClaudeTurn,
  claudeProjectSlug,
  MAX_CLAUDE_TURN_BLOCKS,
  parseClaudeTranscript,
} from '@/lib/hooks/sources/claude/transcript';
import type { StructuredHistoryCaptureReport } from '@/lib/polling/structured-history-gate';
import {
  claudeHeadlessTurnId,
  claudePromptRequestId,
  claudeTurnRequestId,
} from '@/types/agent-transcript';

const MiB = 1024 * 1024;
const WORKTREE_ID = 'wt-2470';
const WORKTREE_PATH = '/repos/commandmate-issue-2470';
const SESSION = '5f3a1c00-2470-4a00-9000-0000000000aa';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;

/** Generous: the widest cases write and read well over 64 MiB. */
const LARGE_TRANSCRIPT_TIMEOUT_MS = 120_000;

let home: string;
let path: string;
let clock: number;

/** The next instant on the transcript's own clock, a second after the last. */
function at(): string {
  clock += 1_000;
  return new Date(clock).toISOString();
}

function prompt(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    sessionId: SESSION,
    cwd: WORKTREE_PATH,
    isSidechain: false,
    timestamp: at(),
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });
}

function toolCall(uuid: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    sessionId: SESSION,
    isSidechain: false,
    timestamp: at(),
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: `tu-${uuid}`, name: 'Bash', input: { command: `run ${uuid}` } }],
    },
  });
}

function toolResult(uuid: string, bytes: number): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    sessionId: SESSION,
    isSidechain: false,
    timestamp: at(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tu-${uuid}`, content: 'y'.repeat(bytes) }],
    },
  });
}

function reply(uuid: string, text: string, stopReason = 'end_turn'): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    sessionId: SESSION,
    isSidechain: false,
    timestamp: at(),
    message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] },
  });
}

/** One of the records Claude appends after a turn has closed. */
function bookkeeping(): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    sessionId: SESSION,
    isSidechain: false,
    timestamp: at(),
    durationMs: 3_071_000,
  });
}

/** Append whole lines to the transcript. */
async function append(...lines: string[]): Promise<void> {
  const handle = await open(path, 'a');
  try {
    await handle.write(lines.map((line) => `${line}\n`).join(''));
  } finally {
    await handle.close();
  }
}

/**
 * Append tool calls and their results until at least `bytes` have been written.
 *
 * One call and one result per step, the result carrying `resultBytes` of output,
 * which is the shape — and the reason for the size — of the real long turns.
 */
async function appendToolSteps(label: string, bytes: number, resultBytes = MiB): Promise<void> {
  const handle = await open(path, 'a');
  try {
    let written = 0;
    for (let step = 0; written < bytes; step += 1) {
      const lines = `${toolCall(`${label}-call-${step}`)}\n${toolResult(`${label}-result-${step}`, resultBytes)}\n`;
      await handle.write(lines);
      written += Buffer.byteLength(lines);
    }
  } finally {
    await handle.close();
  }
}

async function sizeOf(): Promise<number> {
  return (await stat(path)).size;
}

function capture(report?: StructuredHistoryCaptureReport): Promise<boolean> {
  return captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home }, report);
}

function writtenOf(role: string): Array<Record<string, unknown>> {
  return createMessage.mock.calls
    .map(([, message]) => message)
    .filter((message) => message.role === role);
}

/** The fields of every log line with this event name, at this level. */
function logged(level: 'info' | 'warn' | 'debug', event: string): Array<Record<string, unknown>> {
  return logger[level].mock.calls
    .filter(([name]) => name === event)
    .map(([, fields]) => fields as Record<string, unknown>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  resetClaudeTranscriptSessions();
  clock = Date.parse('2026-09-11T08:06:00.000Z');
  home = await mkdtemp(join(tmpdir(), 'cmate-2470-'));
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(WORKTREE_PATH)), {
    recursive: true,
  });
  path = claudeTranscriptPath(home, WORKTREE_PATH, SESSION);
  await writeFile(path, '', 'utf8');
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('[#2470] a turn whose prompt is outside the first window', () => {
  it.each([
    { turnBytes: 5 * MiB, toBytes: 8 * MiB },
    { turnBytes: 13 * MiB, toBytes: 16 * MiB },
  ])(
    'writes the prompt and the reply of a $turnBytes-byte turn, reading back $toBytes bytes',
    async ({ turnBytes, toBytes }) => {
      await append(prompt('p-0', 'an earlier prompt'), reply('r-0', 'An earlier reply.'));
      const promptAt = await sizeOf();
      await append(prompt('p-long', '/uat 2456 2457 2458 2459 2460'));
      await appendToolSteps('long', turnBytes);
      await append(reply('r-long', 'UAT report: all five Issues passed.'), bookkeeping());
      const size = await sizeOf();
      expect(size - promptAt).toBeGreaterThan(CLAUDE_TRANSCRIPT_TAIL_BYTES);

      const captured = await capture();

      // Checked before the verdict so that a regression reads as what it is —
      // the reader found no turn — rather than as a bare `false`.
      expect(logged('warn', 'claude-transcript-no-turn')).toEqual([]);
      expect(captured).toBe(true);

      // The newest turn alone, as with any window that holds no anchor (#2121).
      expect(writtenOf('user').map((m) => [m.requestId, m.content])).toEqual([
        [claudePromptRequestId('p-long'), '/uat 2456 2457 2458 2459 2460'],
      ]);
      const assistant = writtenOf('assistant');
      expect(assistant.map((m) => m.requestId)).toEqual([claudeTurnRequestId('p-long')]);
      expect(String(assistant[0].content)).toContain('UAT report: all five Issues passed.');
      expect(String(assistant[0].content)).not.toContain(CLAUDE_TURN_HEAD_MISSING_MARKER);

      expect(logged('info', 'claude-transcript-window-extended')).toEqual([
        expect.objectContaining({
          fromBytes: CLAUDE_TRANSCRIPT_TAIL_BYTES,
          toBytes,
          size,
          promptOffsetFromEnd: size - promptAt,
        }),
      ]);
      expect(logged('warn', 'claude-transcript-no-turn')).toEqual([]);
    },
    LARGE_TRANSCRIPT_TIMEOUT_MS
  );

  it('still refuses the turn while it is open, and says so (#2264, #2436)', async () => {
    // Reading further back must not become a way round the open-turn gate: a
    // row written now would be frozen without its last paragraph.
    await append(prompt('p-long', '/orchestrate 2470'));
    await appendToolSteps('long', 5 * MiB);
    await append(toolCall('still-working'));

    const report: StructuredHistoryCaptureReport = {};
    expect(await capture(report)).toBe(false);

    expect(report.outcome).toBe('not_yet_closed');
    expect(writtenOf('assistant')).toEqual([]);
    expect(logged('info', 'claude-transcript-window-extended')).toHaveLength(1);
  });

  it('reads a window that holds a prompt exactly as before, orphans and all', async () => {
    // The ordinary shape of a long session: the window opens inside an earlier
    // long turn and then finds the newest prompt. Nothing about that read may
    // change, so nothing is read further back.
    await append(prompt('p-0', 'a long earlier turn'));
    await appendToolSteps('earlier', 6 * MiB);
    await append(reply('r-0', 'Earlier reply.'), prompt('p-1', 'the newest prompt'));
    await append(reply('r-1', 'The newest reply.'));

    expect(await capture()).toBe(true);

    expect(writtenOf('assistant').map((m) => m.requestId)).toEqual([claudeTurnRequestId('p-1')]);
    expect(logged('info', 'claude-transcript-window-extended')).toEqual([]);
    expect(logged('info', 'claude-transcript-partial-read')).toEqual([
      expect.objectContaining({ orphanedAssistantRecords: expect.any(Number) }),
    ]);
  }, LARGE_TRANSCRIPT_TIMEOUT_MS);

  it('leaves a whole file with no prompt record in it to the scraper', async () => {
    // Nothing was cut off here — the read reached the start of the file — so
    // this is not a turn too long to reach, it is a shape this reader does not
    // understand, and the answer stays the pre-#2470 one.
    await append(toolCall('a-1'), reply('a-2', 'A reply with no prompt anywhere.'));
    const size = await sizeOf();

    expect(await capture()).toBe(false);

    expect(createMessage).not.toHaveBeenCalled();
    expect(logged('info', 'claude-transcript-window-extended')).toEqual([]);
    expect(logged('warn', 'claude-transcript-no-turn')).toEqual([
      expect.objectContaining({ orphanedAssistantRecords: 2, readBytes: size, size }),
    ]);
  });
});

describe('[#2470] a turn longer than the widest window', () => {
  it(
    'saves the readable end behind the marker, once, with no user row',
    async () => {
      await append(prompt('p-huge', '/orchestrate 2470 2471 2472'));
      await appendToolSteps('huge', CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES + 2 * MiB);
      await append(reply('r-huge', 'Final report of the long turn.'), bookkeeping());
      const size = await sizeOf();

      expect(await capture()).toBe(true);

      expect(writtenOf('user')).toEqual([]);
      const [row, ...others] = writtenOf('assistant');
      expect(others).toEqual([]);
      expect(row.requestId).toBe(claudeTurnRequestId(claudeHeadlessTurnId(SESSION, 'r-huge')));
      expect(String(row.content).startsWith(`${CLAUDE_TURN_HEAD_MISSING_MARKER}\n\n`)).toBe(true);
      expect(String(row.content)).toContain('Final report of the long turn.');
      expect(advanceCapturedLine).toHaveBeenCalledTimes(1);

      expect(logged('info', 'claude-transcript-window-extended')).toEqual([
        expect.objectContaining({
          fromBytes: CLAUDE_TRANSCRIPT_TAIL_BYTES,
          toBytes: CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES,
          promptOffsetFromEnd: null,
        }),
      ]);
      const [noTurn] = logged('warn', 'claude-transcript-no-turn');
      expect(noTurn).toEqual(expect.objectContaining({ size }));
      expect(noTurn.readBytes).toBeGreaterThan(CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES - 2 * MiB);
      expect(noTurn.readBytes).toBeLessThanOrEqual(CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES);

      // Claude keeps appending after a turn closes, and every append moves the
      // window's head. The key does not move with it.
      await append(bookkeeping(), bookkeeping(), bookkeeping());
      createMessage.mockClear();

      expect(await capture()).toBe(true);
      expect(createMessage).not.toHaveBeenCalled();
    },
    LARGE_TRANSCRIPT_TIMEOUT_MS
  );

  it(
    'gives a second such turn in the same session a second row, and neither while open',
    async () => {
      await append(prompt('p-huge-1', 'the first long prompt'));
      await appendToolSteps('first', CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES + 2 * MiB);
      await append(toolCall('first-still-working'));

      const open: StructuredHistoryCaptureReport = {};
      expect(await capture(open)).toBe(false);
      expect(open.outcome).toBe('not_yet_closed');
      expect(createMessage).not.toHaveBeenCalled();

      await append(reply('r-huge-1', 'Report of the first long turn.'), bookkeeping());
      expect(await capture()).toBe(true);

      await append(prompt('p-huge-2', 'the second long prompt'));
      await appendToolSteps('second', CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES + 2 * MiB);
      await append(reply('r-huge-2', 'Report of the second long turn.'), bookkeeping());
      expect(await capture()).toBe(true);

      const assistant = writtenOf('assistant');
      expect(assistant.map((m) => m.requestId)).toEqual([
        claudeTurnRequestId(claudeHeadlessTurnId(SESSION, 'r-huge-1')),
        claudeTurnRequestId(claudeHeadlessTurnId(SESSION, 'r-huge-2')),
      ]);
      expect(String(assistant[0].content)).toContain('Report of the first long turn.');
      expect(String(assistant[1].content)).toContain('Report of the second long turn.');
      expect(String(assistant[1].content)).not.toContain('Report of the first long turn.');
      expect(writtenOf('user')).toEqual([]);
    },
    LARGE_TRANSCRIPT_TIMEOUT_MS
  );
});

describe('[#2470] the live read is left as it was', () => {
  it('still shows a turn bigger than the first window as the partial tail', async () => {
    // Deliberately not widened: this read runs once a second for as long as a
    // turn is generating, and the turns that would widen it are the longest
    // ones there are. The settled row replaces the bubble when the turn ends.
    await append(prompt('p-long', 'a long prompt'));
    await appendToolSteps('long', 5 * MiB);
    await append(reply('r-long', 'Still going.', 'tool_use'));

    const progress = await readClaudeTurnProgress(TARGET, {
      worktreePath: WORKTREE_PATH,
      homeDir: home,
    });

    expect(progress?.partial).toBe(true);
    expect(progress?.turnKey).toBe(claudeTurnRequestId(`partial:${SESSION}`));
    expect(logged('info', 'claude-transcript-window-extended')).toEqual([]);
  }, LARGE_TRANSCRIPT_TIMEOUT_MS);
});

describe('[#2470] buildHeadlessClaudeTurn', () => {
  function records(...lines: string[]) {
    return parseClaudeTranscript(`${lines.join('\n')}\n`).records;
  }

  it('keys the turn on the record that closed it and dates it by the last record', () => {
    const headless = buildHeadlessClaudeTurn(
      records(toolCall('a-1'), toolResult('t-1', 8), reply('a-2', 'Done.')),
      SESSION
    );

    expect(headless?.turn.promptUuid).toBe(claudeHeadlessTurnId(SESSION, 'a-2'));
    expect(headless?.turn.closed).toBe(true);
    expect(headless?.turn.promptText).toBe('');
    expect(headless?.turn.promptIsOperatorInput).toBe(false);
    expect(headless?.turn.assistantRecords).toBe(2);
    expect(headless?.lastRecordAt).toBe(clock);
  });

  it('is open when the last assistant record handed over to a tool', () => {
    const headless = buildHeadlessClaudeTurn(
      records(reply('a-1', 'Looking.'), toolCall('a-2')),
      SESSION
    );

    expect(headless?.turn.closed).toBe(false);
    expect(headless?.turn.stopReasonObserved).toBe(true);
  });

  it('keeps the end of the turn when the block cap bites', () => {
    const lines = Array.from({ length: MAX_CLAUDE_TURN_BLOCKS + 3 }, (_, index) =>
      toolCall(`a-${index}`)
    );
    const headless = buildHeadlessClaudeTurn(records(...lines), SESSION);

    expect(headless?.turn.overflowed).toBe(true);
    expect(headless?.turn.blocks).toHaveLength(MAX_CLAUDE_TURN_BLOCKS);
    expect(headless?.turn.blocks[0].toolDetail).toBe('run a-3');
    expect(headless?.turn.blocks.at(-1)?.toolDetail).toBe(`run a-${MAX_CLAUDE_TURN_BLOCKS + 2}`);
  });

  it('takes only what comes before the first prompt record', () => {
    const headless = buildHeadlessClaudeTurn(
      records(reply('a-1', 'Tail of an earlier turn.'), prompt('p-1', 'next'), reply('a-2', 'Next.')),
      SESSION
    );

    expect(headless?.turn.promptUuid).toBe(claudeHeadlessTurnId(SESSION, 'a-1'));
    expect(headless?.turn.superseded).toBe(true);
    expect(headless?.turn.assistantRecords).toBe(1);
  });

  it('answers null when there is nothing to key a row on', () => {
    expect(buildHeadlessClaudeTurn(records(prompt('p-1', 'only a prompt')), SESSION)).toBeNull();
    const unnamed = JSON.parse(reply('ignored', 'No uuid.')) as Record<string, unknown>;
    delete unnamed.uuid;
    expect(buildHeadlessClaudeTurn(records(JSON.stringify(unnamed)), SESSION)).toBeNull();
  });
});

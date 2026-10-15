/**
 * The transcript readers, the user-turn recorder, the cursor advance and the
 * Markdown log write nothing for a response-poller tick that was retired
 * before their write (Issue #3705).
 *
 * These are the writers a tick reaches THROUGH an `await` of its own: the
 * checker cannot ask on their behalf after the call returns, because by then
 * the row, the grow, the key, the cursor and the follow list are written. Each
 * now asks `mayActForPollerKey` for the instance's key after its last `await`
 * and before its first write.
 *
 * The question is asked of the real ALS: every case runs the writer inside
 * `pollerOwnerStorage.run(owner)`, as the checker does. "Stopped during the
 * read" is the owner's `stopped` flag flipping while the reader is inside — the
 * session lookup is the hook used to flip it, so the reader has already passed
 * its first awaits when the stop lands. The negative cases are the same input
 * from the chain that still owns the key, from outside any tick (the Stop hook
 * and the routes) and from a tick acting for another instance.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The instance's session as the structured events name it; a hook may stop the tick. */
const events = vi.hoisted(() => ({
  sessionId: null as string | null,
  onRead: null as null | (() => void),
}));
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: () => {
    events.onRead?.();
    return events.sessionId === null ? null : { sessionId: events.sessionId };
  },
}));

const rows = new Map<string, Record<string, unknown>>();
function defaultCreateMessage(_db: unknown, message: Record<string, unknown>) {
  const saved = { id: `msg-${rows.size + 1}`, ...message };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
}
const createMessage = vi.fn(defaultCreateMessage);
const findMessageByRequestId = vi.fn(
  (_db: unknown, worktreeId: string, requestId: string) => rows.get(`${worktreeId}::${requestId}`) ?? null
);
const updateMessageContent = vi.fn();
const setMessageRequestId = vi.fn(() => true);
const findUnkeyedUserMessages = vi.fn(() => [] as Array<Record<string, unknown>>);
const sessionLines = new Map<string, number>();
const updateSessionState = vi.fn(
  (_db: unknown, worktreeId: string, cliToolId: string, line: number, instanceId?: string) => {
    sessionLines.set(`${worktreeId}:${instanceId ?? cliToolId}`, line);
  }
);
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateMessageContent: (...a: unknown[]) => updateMessageContent(...a),
  getSessionState: (_db: unknown, worktreeId: string, instanceId: string) => ({
    lastCapturedLine: sessionLines.get(`${worktreeId}:${instanceId}`) ?? 0,
  }),
  updateSessionState: (...a: [unknown, string, string, number, string | undefined]) => updateSessionState(...a),
  getLastUserMessage: () => ({ content: 'the prompt' }),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => findUnkeyedUserMessages(),
  setMessageRequestId: () => setMessageRequestId(),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: (...a: unknown[]) => broadcastMessage(...a) }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => new Array(120).fill('pane row').join('\n')),
}));
const logDir = vi.hoisted(() => ({ path: '' }));
vi.mock('@/config/log-config', () => ({ getLogDir: () => logDir.path }));

import { pollerOwnerStorage, type PollerOwner } from '@/lib/polling/poller-owner';
import {
  captureCodexTranscriptTurn,
  codexSessionsRoot,
  resetCodexTranscriptSessions,
} from '@/lib/hooks/sources/codex/history';
import {
  antigravityTranscriptPath,
  captureAntigravityTranscriptTurn,
  resetAntigravityTranscriptConversations,
} from '@/lib/hooks/sources/antigravity/history';
import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
import {
  captureCommandCodeTranscriptTurn,
  commandCodeProjectsRoot,
  resetCommandCodeTranscriptSessions,
} from '@/lib/hooks/sources/command-code/history';
import { growTurnRowTo } from '@/lib/hooks/sources/transcript-history';
import { recordUserTurn } from '@/lib/history/user-turn-recorder';
import { advanceCapturedLineForTranscriptTurn } from '@/lib/assistant-response-saver';
import { recordClaudeConversation } from '@/lib/conversation-logger';
import { createLogger } from '@/lib/logger';
import type { ChatMessage } from '@/types/models';

const WT = 'wt-3705-reader';

let home: string;

/** A chain's ownership token for `cliToolId`'s primary instance in `WT`. */
function ownerFor(cliToolId: string, worktreeId = WT): PollerOwner {
  return { pollerKey: `${worktreeId}:${cliToolId}`, generation: 1, superseded: false, stopped: false, selfStopped: false };
}

/** Run `fn` as the tick of `owner`, stopping it while the reader is inside. */
function asTickStoppedDuringRead<T>(owner: PollerOwner, fn: () => Promise<T>): Promise<T> {
  events.onRead = () => {
    owner.stopped = true;
  };
  return pollerOwnerStorage.run(owner, fn);
}

function assistantRows(): Array<Record<string, unknown>> {
  return createMessage.mock.calls.map(([, m]) => m).filter((m) => m.role === 'assistant');
}

function userRows(): Array<Record<string, unknown>> {
  return createMessage.mock.calls.map(([, m]) => m).filter((m) => m.role === 'user');
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  sessionLines.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  findUnkeyedUserMessages.mockReturnValue([]);
  events.onRead = null;
  events.sessionId = null;
  resetCodexTranscriptSessions();
  resetAntigravityTranscriptConversations();
  resetClaudeTranscriptSessions();
  resetCommandCodeTranscriptSessions();
  home = await mkdtemp(join(tmpdir(), 'cmate-3705-readers-'));
  logDir.path = join(home, 'logs');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the four readers
// ---------------------------------------------------------------------------

const CODEX_SESSION = '01a05a82-d71b-7bc3-8901-487b0db19d40';
async function writeCodexRollout(): Promise<void> {
  const dir = join(codexSessionsRoot(home), '2026', '09', '01');
  await mkdir(dir, { recursive: true });
  const body = readFileSync(
    join(process.cwd(), 'tests/fixtures/transcripts/codex/rollout-three-turns-01510.jsonl'),
    'utf8'
  );
  await writeFile(join(dir, `rollout-2026-09-01T10-08-39-${CODEX_SESSION}.jsonl`), body, 'utf8');
  events.sessionId = CODEX_SESSION;
}
const CODEX = { worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' } as const;
const readCodex = () => captureCodexTranscriptTurn(CODEX, { codexHome: home });

const AGY_CONVERSATION = '1ce50bef-fc2a-4039-8114-5aae518678e6';
async function writeAgyTranscript(): Promise<void> {
  const path = antigravityTranscriptPath(home, AGY_CONVERSATION);
  if (!path) throw new Error('not a conversation id');
  await mkdir(dirname(path), { recursive: true });
  const body = readFileSync(
    join(process.cwd(), 'tests/fixtures/transcripts/antigravity/transcript-three-turns-1118.jsonl'),
    'utf8'
  );
  await writeFile(path, body, 'utf8');
  events.sessionId = AGY_CONVERSATION;
}
const AGY = { worktreeId: WT, cliToolId: 'antigravity', instanceId: 'antigravity' } as const;
const readAgy = () => captureAntigravityTranscriptTurn(AGY, { antigravityHome: home });

const CLAUDE_SESSION = '0572eeb1-f7f8-4b39-8be5-e71ef93958ef';
const CLAUDE_PATH = '/repos/commandmate-issue-3705';
async function writeClaudeTranscript(): Promise<void> {
  const record = (type: string, uuid: string, at: string, content: unknown) =>
    JSON.stringify({
      type,
      uuid,
      sessionId: CLAUDE_SESSION,
      cwd: CLAUDE_PATH,
      isSidechain: false,
      timestamp: at,
      message: { role: type, content },
    });
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(CLAUDE_PATH)), { recursive: true });
  await writeFile(
    claudeTranscriptPath(home, CLAUDE_PATH, CLAUDE_SESSION),
    [
      record('user', 'u-1', '2026-08-31T10:00:00.000Z', 'the prompt'),
      record('assistant', 'a-1', '2026-08-31T10:00:05.000Z', [{ type: 'text', text: 'claude reply' }]),
      '',
    ].join('\n'),
    'utf8'
  );
  events.sessionId = CLAUDE_SESSION;
}
const CLAUDE = { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' } as const;
const readClaude = () => captureClaudeTranscriptTurn(CLAUDE, { worktreePath: CLAUDE_PATH, homeDir: home });

const CC_SESSION = '33333333-3333-4333-8333-333333333333';
async function writeCommandCodeTranscript(): Promise<void> {
  const dir = join(commandCodeProjectsRoot(home), 'some-unguessable-slug');
  await mkdir(dir, { recursive: true });
  // One closed turn, in the shape of the #2252 suite's second-instance session.
  const body = [
    JSON.stringify({ type: 'session', version: 3, id: CC_SESSION, timestamp: '2026-09-03T08:00:00.000Z', cwd: '/w' }),
    JSON.stringify({
      type: 'message',
      id: 'aa11bb22',
      parentId: null,
      timestamp: '2026-09-03T08:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ping' }], meta: { source: 'user', createdAt: 1788423601000 } },
    }),
    JSON.stringify({
      type: 'message',
      id: 'cc33dd44',
      parentId: 'aa11bb22',
      timestamp: '2026-09-03T08:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'command-code reply' }],
        meta: { source: 'model', createdAt: 1788423602000 },
      },
    }),
  ].join('\n');
  await writeFile(join(dir, `${CC_SESSION}.jsonl`), body, 'utf8');
  events.sessionId = CC_SESSION;
}
const CC = { worktreeId: WT, cliToolId: 'command-code', instanceId: 'command-code' } as const;
const readCommandCode = () => captureCommandCodeTranscriptTurn(CC, { commandCodeHome: home });

const READERS = [
  { name: 'codex', tool: 'codex', write: writeCodexRollout, read: readCodex },
  { name: 'antigravity', tool: 'antigravity', write: writeAgyTranscript, read: readAgy },
  { name: 'claude', tool: 'claude', write: writeClaudeTranscript, read: readClaude },
  { name: 'command-code', tool: 'command-code', write: writeCommandCodeTranscript, read: readCommandCode },
] as const;

describe('[#3705] the four readers', () => {
  for (const reader of READERS) {
    it(`${reader.name}: a tick stopped during the read writes no reply row, no user row and no cursor, and answers false`, async () => {
      await reader.write();

      const captured = await asTickStoppedDuringRead(ownerFor(reader.tool), reader.read);

      expect(captured).toBe(false);
      expect(assistantRows()).toEqual([]);
      expect(userRows()).toEqual([]);
      expect(setMessageRequestId).not.toHaveBeenCalled();
      expect(updateSessionState).not.toHaveBeenCalled();
      expect(broadcastMessage).not.toHaveBeenCalled();
    });

    it(`negative: ${reader.name} from the chain that still owns the key writes the turn and answers true`, async () => {
      await reader.write();

      const captured = await pollerOwnerStorage.run(ownerFor(reader.tool), reader.read);

      expect(captured).toBe(true);
      expect(assistantRows().length).toBeGreaterThan(0);
    });

    it(`negative: ${reader.name} outside any tick (the Stop hook) writes the turn`, async () => {
      await reader.write();

      expect(await reader.read()).toBe(true);
      expect(assistantRows().length).toBeGreaterThan(0);
    });

    it(`negative: ${reader.name} from a stopped tick of ANOTHER instance writes the turn`, async () => {
      await reader.write();
      const other = ownerFor(reader.tool, 'wt-3705-other');
      other.stopped = true;

      expect(await pollerOwnerStorage.run(other, reader.read)).toBe(true);
      expect(assistantRows().length).toBeGreaterThan(0);
    });
  }

  it('antigravity: a tick stopped during the read leaves the follow list as it was', async () => {
    await writeAgyTranscript();
    // Write once from outside a tick: the turns agy has not vouched for are followed.
    await readAgy();
    const followed = (globalThis as { __antigravityUnsettledTurns?: Map<string, unknown> })
      .__antigravityUnsettledTurns;
    const before = JSON.stringify(Array.from(followed?.entries() ?? []));
    rows.clear();
    createMessage.mockClear();

    await asTickStoppedDuringRead(ownerFor('antigravity'), readAgy);

    expect(JSON.stringify(Array.from(followed?.entries() ?? []))).toBe(before);
    expect(assistantRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the shared writers
// ---------------------------------------------------------------------------

describe('[#3705] the shared writers', () => {
  const logger = createLogger('test-3705');
  const existing = { id: 'row-1', content: 'short', requestId: 'req-1' } as unknown as ChatMessage;
  const rendered = { sessionId: 's', body: 'a longer body', textBlocks: 1, toolBlocks: 0 };

  it('growTurnRowTo: a stopped tick does not grow the row', async () => {
    const tick = ownerFor('claude');
    tick.stopped = true;

    const grown = await pollerOwnerStorage.run(tick, () =>
      growTurnRowTo(CLAUDE, existing, rendered, '/p', logger, 'updated')
    );

    expect(grown).toBe(false);
    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it('negative: growTurnRowTo from the owning tick grows it', async () => {
    const grown = await pollerOwnerStorage.run(ownerFor('claude'), () =>
      growTurnRowTo(CLAUDE, existing, rendered, '/p', logger, 'updated')
    );

    expect(grown).toBe(true);
    expect(updateMessageContent).toHaveBeenCalledWith({}, 'row-1', 'a longer body');
  });

  it('recordUserTurn: a stopped tick neither keys a /send row nor inserts one', async () => {
    findUnkeyedUserMessages.mockReturnValue([
      { id: 'send-row', content: 'the prompt', timestamp: new Date(1_000), requestId: null },
    ]);
    const tick = ownerFor('codex');
    tick.stopped = true;

    const recorded = await pollerOwnerStorage.run(tick, () => recordUserTurn(CODEX, 'key-1', 'the prompt', 1_000));

    expect(recorded.outcome).toBe('refused');
    expect(setMessageRequestId).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('negative: recordUserTurn from the owning tick adopts the /send row', async () => {
    findUnkeyedUserMessages.mockReturnValue([
      { id: 'send-row', content: 'the prompt', timestamp: new Date(1_000), requestId: null },
    ]);

    const recorded = await pollerOwnerStorage.run(ownerFor('codex'), () =>
      recordUserTurn(CODEX, 'key-1', 'the prompt', 1_000)
    );

    expect(recorded.outcome).toBe('adopted');
  });

  it('advanceCapturedLineForTranscriptTurn: a stopped tick does not move the cursor', async () => {
    const tick = ownerFor('codex');
    tick.stopped = true;

    const moved = await pollerOwnerStorage.run(tick, () => advanceCapturedLineForTranscriptTurn(CODEX));

    expect(moved).toBeNull();
    expect(updateSessionState).not.toHaveBeenCalled();
  });

  it('negative: advanceCapturedLineForTranscriptTurn from the owning tick moves it', async () => {
    const moved = await pollerOwnerStorage.run(ownerFor('codex'), () => advanceCapturedLineForTranscriptTurn(CODEX));

    expect(moved).toBe(120);
    expect(sessionLines.get(`${WT}:codex`)).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// the Markdown log
// ---------------------------------------------------------------------------

describe('[#3705] the Markdown log', () => {
  async function logFiles(): Promise<string[]> {
    try {
      return await readdir(join(logDir.path, 'codex'));
    } catch {
      return [];
    }
  }

  it('keyed by a tick stopped while the log reads the old file: no entry is written', async () => {
    const tick = ownerFor('codex');
    // Stopped after the call starts: the log's own awaits (the directory, the
    // old file) are what it resumes from.
    const written = pollerOwnerStorage.run(tick, () =>
      recordClaudeConversation({} as never, WT, 'codex reply', 'codex', { pollerKey: `${WT}:codex` })
    );
    tick.stopped = true;
    await written;

    expect(await logFiles()).toEqual([]);
  });

  it('negative: keyed by the owning tick, the entry is written', async () => {
    await pollerOwnerStorage.run(ownerFor('codex'), () =>
      recordClaudeConversation({} as never, WT, 'codex reply', 'codex', { pollerKey: `${WT}:codex` })
    );

    const files = await logFiles();
    expect(files).toHaveLength(1);
    expect(await readFile(join(logDir.path, 'codex', files[0]), 'utf8')).toContain('codex reply');
  });

  it('negative: a held reply a stop confirms (no key) is logged even inside the stopped tick', async () => {
    const tick = ownerFor('codex');
    tick.stopped = true;

    await pollerOwnerStorage.run(tick, () => recordClaudeConversation({} as never, WT, 'held reply', 'codex'));

    expect(await logFiles()).toHaveLength(1);
  });
});

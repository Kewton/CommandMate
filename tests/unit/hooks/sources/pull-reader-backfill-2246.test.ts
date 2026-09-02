/**
 * codex and antigravity follow claude's backfill (Issue #2246).
 *
 * `./claude-history-backfill-2246.test.ts` is where the rule is argued and
 * exercised in detail; this file asserts that the two readers #2197 and #2198
 * added behave the same way, because a fix that lands on one of three
 * structurally identical readers is a fix that will be re-reported against the
 * other two.
 *
 * Both are driven against their own captured three-turn fixtures — the same
 * files `./codex-history-2197.test.ts` and `./antigravity-history-2198.test.ts`
 * use — so the turn keys below are the tools' own ids and not invented ones.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

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

import {
  captureCodexTranscriptTurn,
  codexSessionsRoot,
  resetCodexTranscriptSessions,
  resolveCodexTranscriptPath,
} from '@/lib/hooks/sources/codex/history';
import {
  antigravityTranscriptPath,
  captureAntigravityTranscriptTurn,
  resetAntigravityTranscriptConversations,
  resolveAntigravityTranscriptPath,
} from '@/lib/hooks/sources/antigravity/history';
import { antigravityTurnRequestId, codexTurnRequestId } from '@/types/agent-transcript';

const CODEX_FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/codex');
const AGY_FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/antigravity');
const CODEX_THREE_TURNS = readFileSync(
  join(CODEX_FIXTURES, 'rollout-three-turns-01510.jsonl'),
  'utf8'
);
const AGY_THREE_TURNS = readFileSync(
  join(AGY_FIXTURES, 'transcript-three-turns-1118.jsonl'),
  'utf8'
);

const WORKTREE_ID = 'wt-2246';

/** codex's own `turn_id`s for the captured session, oldest first. */
const CODEX_TURNS = [
  '01a05a83-0933-7723-8eb2-2e459b5a1ebd',
  '01a05a83-a87d-7362-80fe-027b7584e589',
  '01a05a84-76f2-7390-83f3-51ea1346a364',
] as const;
const CODEX_SESSION = '01a05a82-d71b-7bc3-8901-487b0db19d40';
const CODEX_TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'codex', instanceId: 'codex' } as const;

/** agy's own `step_index`es for the captured conversation, oldest first. */
const AGY_STEPS = [0, 2, 12] as const;
const AGY_CONVERSATION = '1ce50bef-fc2a-4039-8114-5aae518678e6';
const AGY_TARGET = {
  worktreeId: WORKTREE_ID,
  cliToolId: 'antigravity',
  instanceId: 'antigravity',
} as const;

let home: string;

function writtenKeys(): string[] {
  return createMessage.mock.calls
    .map(([, message]) => message)
    .filter((message) => message.role === 'assistant')
    .map((message) => String(message.requestId));
}

function pretendSaved(requestId: string): void {
  rows.set(`${WORKTREE_ID}::${requestId}`, { id: `pre-${requestId}` });
}

async function writeCodexRollout(): Promise<string> {
  const dir = join(codexSessionsRoot(home), '2026', '09', '01');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-01T10-08-39-${CODEX_SESSION}.jsonl`);
  await writeFile(path, CODEX_THREE_TURNS, 'utf8');
  return path;
}

async function writeAgyTranscript(): Promise<string> {
  const path = antigravityTranscriptPath(home, AGY_CONVERSATION);
  if (!path) throw new Error('not a conversation id');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, AGY_THREE_TURNS, 'utf8');
  return path;
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  resetCodexTranscriptSessions();
  resetAntigravityTranscriptConversations();
  home = await mkdtemp(join(tmpdir(), 'cmate-2246-pull-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('codex', () => {
  beforeEach(() => {
    getLastAgentEvent.mockReturnValue({ sessionId: CODEX_SESSION });
  });

  it('writes every turn after the anchor, oldest first', async () => {
    await writeCodexRollout();
    pretendSaved(codexTurnRequestId(CODEX_TURNS[0]));

    expect(await captureCodexTranscriptTurn(CODEX_TARGET, { codexHome: home })).toBe(true);

    expect(writtenKeys()).toEqual([
      codexTurnRequestId(CODEX_TURNS[1]),
      codexTurnRequestId(CODEX_TURNS[2]),
    ]);
  });

  it('writes the newest turn alone when the window holds no anchor', async () => {
    await writeCodexRollout();

    expect(await captureCodexTranscriptTurn(CODEX_TARGET, { codexHome: home })).toBe(true);

    expect(writtenKeys()).toEqual([codexTurnRequestId(CODEX_TURNS[2])]);
  });

  it('adds no rows on a second read of the same rollout', async () => {
    await writeCodexRollout();
    pretendSaved(codexTurnRequestId(CODEX_TURNS[0]));
    await captureCodexTranscriptTurn(CODEX_TARGET, { codexHome: home });

    createMessage.mockClear();
    expect(await captureCodexTranscriptTurn(CODEX_TARGET, { codexHome: home })).toBe(true);

    expect(createMessage).not.toHaveBeenCalled();
  });

  it('names the rollout without reading it', async () => {
    const path = await writeCodexRollout();

    await expect(resolveCodexTranscriptPath(CODEX_TARGET, { codexHome: home })).resolves.toBe(path);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('names nothing when no hook has pointed at a session', async () => {
    getLastAgentEvent.mockReturnValue(null);
    await writeCodexRollout();

    await expect(
      resolveCodexTranscriptPath(CODEX_TARGET, { codexHome: home })
    ).resolves.toBeNull();
  });
});

describe('antigravity', () => {
  beforeEach(() => {
    getLastAgentEvent.mockReturnValue({ sessionId: AGY_CONVERSATION });
  });

  it('writes every turn after the anchor, oldest first', async () => {
    await writeAgyTranscript();
    pretendSaved(antigravityTurnRequestId(AGY_CONVERSATION, AGY_STEPS[0]));

    expect(
      await captureAntigravityTranscriptTurn(AGY_TARGET, { antigravityHome: home })
    ).toBe(true);

    expect(writtenKeys()).toEqual([
      antigravityTurnRequestId(AGY_CONVERSATION, AGY_STEPS[1]),
      antigravityTurnRequestId(AGY_CONVERSATION, AGY_STEPS[2]),
    ]);
  });

  it('writes the newest turn alone when the window holds no anchor', async () => {
    await writeAgyTranscript();

    expect(
      await captureAntigravityTranscriptTurn(AGY_TARGET, { antigravityHome: home })
    ).toBe(true);

    expect(writtenKeys()).toEqual([
      antigravityTurnRequestId(AGY_CONVERSATION, AGY_STEPS[2]),
    ]);
  });

  it('adds no rows on a second read of the same transcript', async () => {
    await writeAgyTranscript();
    pretendSaved(antigravityTurnRequestId(AGY_CONVERSATION, AGY_STEPS[0]));
    await captureAntigravityTranscriptTurn(AGY_TARGET, { antigravityHome: home });

    createMessage.mockClear();
    expect(
      await captureAntigravityTranscriptTurn(AGY_TARGET, { antigravityHome: home })
    ).toBe(true);

    expect(createMessage).not.toHaveBeenCalled();
  });

  it('names the transcript without reading it', async () => {
    const path = await writeAgyTranscript();

    await expect(
      resolveAntigravityTranscriptPath(AGY_TARGET, { antigravityHome: home })
    ).resolves.toBe(path);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('names nothing when no hook has pointed at a conversation', async () => {
    getLastAgentEvent.mockReturnValue(null);
    await writeAgyTranscript();

    await expect(
      resolveAntigravityTranscriptPath(AGY_TARGET, { antigravityHome: home })
    ).resolves.toBeNull();
  });
});

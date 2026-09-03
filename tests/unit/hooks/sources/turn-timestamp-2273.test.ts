/**
 * A reply is dated at the END of its turn (Issue #2273).
 *
 * ## What was wrong
 *
 * The chat surface draws its rows in timestamp order, and a tool approval is
 * written the moment the dialog appears — seconds into the turn. The transcript
 * readers dated a reply by the instant the turn OPENED (#2121, #2196, #2197,
 * #2198, #2252), so the reply sorted *before* an approval the agent had asked
 * for on the way to writing it, and the column read
 *
 *     question → answer → Tool approvals · 1
 *
 * for a turn that really went question → approval → answer. Measured on
 * antigravity: prompt `04:49:50.989Z`, reply `04:49:54.000Z`, approval
 * `04:49:57.513Z`.
 *
 * ## The rule under test
 *
 * A reply is dated at its turn's **last record** — the agent's last word, which
 * is after everything the turn produced on the way — with two bounds that do not
 * move:
 *
 *  1. never before its own user row (#2196's `orphan` guard, still exact);
 *  2. never at or after the NEXT turn's user row, which for a queued prompt is a
 *     `/send` row written while THIS turn was still running.
 *
 * All four pull readers are exercised, on their own captured fixtures, because a
 * rule that lands on one of five structurally identical readers is a rule that
 * will be re-reported against the other four. opencode's push reader is covered
 * by `./opencode-turn-timestamp-2273.test.ts`, which has no transcript file to
 * read.
 *
 * ## Non-vacuity
 *
 * Every reader's case asserts the *exact* instant of the turn's last record AND
 * that it differs from `userRow + 1`, which is the rule this Issue replaced. A
 * fixture where the two coincide would let the whole file pass unchanged against
 * the old code, so the second assertion is what makes the first one mean
 * something.
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
/** Rows with no `request_id` yet — what `/send` leaves behind for adoption. */
let unkeyed: Array<{ id: string; content: string; timestamp: Date }> = [];

const createMessage = vi.fn((_db: unknown, message: Record<string, unknown>) => {
  const saved = { id: `msg-${rows.size + 1}`, ...message };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
});
const findMessageByRequestId = vi.fn(
  (_db: unknown, worktreeId: string, requestId: string) =>
    rows.get(`${worktreeId}::${requestId}`) ?? null
);
const findUnkeyedUserMessages = vi.fn(
  (_db: unknown, query: { fromMs: number; toMs: number }) =>
    unkeyed.filter(
      (row) => row.timestamp.getTime() >= query.fromMs && row.timestamp.getTime() <= query.toMs
    )
);
const setMessageRequestId = vi.fn((_db: unknown, id: string, _requestId: string) => {
  unkeyed = unkeyed.filter((row) => row.id !== id);
  return true;
});

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateMessageContent: vi.fn(),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: (...a: [unknown, { fromMs: number; toMs: number }]) =>
    findUnkeyedUserMessages(...a),
  setMessageRequestId: (...a: [unknown, string, string]) => setMessageRequestId(...a),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
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
  captureCommandCodeTranscriptTurn,
  commandCodeProjectsRoot,
  resetCommandCodeTranscriptSessions,
} from '@/lib/hooks/sources/command-code/history';
import {
  antigravityPromptRequestId,
  antigravityTurnRequestId,
  claudePromptRequestId,
  claudeTurnRequestId,
  codexPromptRequestId,
  codexTurnRequestId,
  commandCodePromptRequestId,
  commandCodeTurnRequestId,
} from '@/types/agent-transcript';

const WORKTREE_ID = 'wt-2273';

const CLAUDE_FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/claude-transcript-2246/three-turns.jsonl'),
  'utf8'
);
const CODEX_FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/transcripts/codex/rollout-three-turns-01510.jsonl'),
  'utf8'
);
const AGY_FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/transcripts/antigravity/transcript-three-turns-1118.jsonl'),
  'utf8'
);
const COMMAND_CODE_FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/transcripts/command-code/three-turns-1401.jsonl'),
  'utf8'
);

const CLAUDE_WORKTREE_PATH = '/Users/operator/repos/commandmate-issue-2196';
const CLAUDE_SESSION = '5f3a1c00-2246-4a00-9000-0000000000aa';
/** Turn B of the claude fixture: a `tool_use`, its result, then the reply. */
const CLAUDE_A = '00000000-0000-4000-8000-000000000001';
const CLAUDE_B = '00000000-0000-4000-8000-000000000005';
const CLAUDE_C = '00000000-0000-4000-8000-000000000011';

const CODEX_SESSION = '01a05a82-d71b-7bc3-8901-487b0db19d40';
/** Turn B of the codex fixture: an `AgentMessage`, a `CommandExecution`, a reply. */
const CODEX_B = '01a05a83-a87d-7362-80fe-027b7584e589';

const AGY_CONVERSATION = '1ce50bef-fc2a-4039-8114-5aae518678e6';
/** Turn B of the agy fixture: four tool-calling records over 27 seconds. */
const AGY_B = 2;

const COMMAND_CODE_SESSION = '33333333-3333-4333-8333-333333333333';
const COMMAND_CODE_A = 'cb06ab09';
/** Turn B of the Command Code fixture: a tool call, its result, then the reply. */
const COMMAND_CODE_B = 'c1c8338e';

let home: string;

/** The `timestamp` the row with this `request_id` was written with, epoch ms. */
function writtenAt(requestId: string): number {
  const call = createMessage.mock.calls.find(([, message]) => message.requestId === requestId);
  if (!call) throw new Error(`no row written for ${requestId}`);
  return (call[1].timestamp as Date).getTime();
}

/** Whether any row was written for this `request_id`. */
function wasWritten(requestId: string): boolean {
  return createMessage.mock.calls.some(([, message]) => message.requestId === requestId);
}

/** Pretend an earlier run already wrote this turn's assistant row. */
function pretendSaved(requestId: string): void {
  rows.set(`${WORKTREE_ID}::${requestId}`, { id: `pre-${requestId}`, content: 'x' });
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  unkeyed = [];
  resetClaudeTranscriptSessions();
  resetCodexTranscriptSessions();
  resetAntigravityTranscriptConversations();
  resetCommandCodeTranscriptSessions();
  home = await mkdtemp(join(tmpdir(), 'cmate-2273-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

async function writeClaudeFixture(body = CLAUDE_FIXTURE): Promise<void> {
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(CLAUDE_WORKTREE_PATH)), {
    recursive: true,
  });
  await writeFile(claudeTranscriptPath(home, CLAUDE_WORKTREE_PATH, CLAUDE_SESSION), body, 'utf8');
}

function captureClaude(): Promise<boolean> {
  getLastAgentEvent.mockReturnValue({ sessionId: CLAUDE_SESSION });
  return captureClaudeTranscriptTurn(
    { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' },
    { worktreePath: CLAUDE_WORKTREE_PATH, homeDir: home }
  );
}

describe('claude', () => {
  /** Turn B's records: prompt, `tool_use`, `tool_result`, reply. */
  const PROMPT_AT = Date.parse('2026-09-02T14:38:24.117Z');
  const TOOL_USE_AT = Date.parse('2026-09-02T14:38:31.880Z');
  const LAST_RECORD_AT = Date.parse('2026-09-02T14:39:16.203Z');

  beforeEach(async () => {
    await writeClaudeFixture();
    // Anchor on turn A so B and C are the pending ones; with no anchor the
    // reader writes the newest turn alone (#2246) and B is never reached.
    pretendSaved(claudeTurnRequestId(CLAUDE_A));
  });

  it('dates the reply at the turn’s last assistant record', async () => {
    await captureClaude();

    expect(writtenAt(claudeTurnRequestId(CLAUDE_B))).toBe(LAST_RECORD_AT);
    // Non-vacuity: the rule this replaced would have written `PROMPT_AT + 1`, so
    // the assertion above genuinely discriminates between the two.
    expect(writtenAt(claudeTurnRequestId(CLAUDE_B))).not.toBe(PROMPT_AT + 1);
  });

  it('puts the reply after an approval raised inside the turn', async () => {
    // The dialog for turn B's `tool_use` is written when it appears — 7.7 s into
    // a 52 s turn — and the chat surface orders by timestamp alone.
    await captureClaude();

    expect(writtenAt(claudeTurnRequestId(CLAUDE_B))).toBeGreaterThan(TOOL_USE_AT);
  });

  it('never puts the reply before its own user row', async () => {
    await captureClaude();

    expect(writtenAt(claudeTurnRequestId(CLAUDE_B))).toBeGreaterThan(
      writtenAt(claudePromptRequestId(CLAUDE_B))
    );
  });

  it('stays after a /send row the agent accepted late', async () => {
    // The floor is the USER ROW's instant and not the transcript's: an adopted
    // `/send` row keeps the time CommandMate wrote it, which here is AFTER every
    // record of the turn it opened. #2196's guarantee has to survive that.
    const late = LAST_RECORD_AT + 5_000;
    unkeyed = [{ id: 'send-late', content: '良いです。', timestamp: new Date(late) }];

    await captureClaude();

    // Adopted, not inserted: the `/send` row keeps its own id and its own
    // instant, so there is no `createMessage` call for the prompt at all.
    expect(wasWritten(claudePromptRequestId(CLAUDE_B))).toBe(false);
    expect(setMessageRequestId).toHaveBeenCalledWith(
      expect.anything(),
      'send-late',
      claudePromptRequestId(CLAUDE_B)
    );
    expect(writtenAt(claudeTurnRequestId(CLAUDE_B))).toBe(late + 1);
    expect(writtenAt(claudeTurnRequestId(CLAUDE_B))).toBeGreaterThan(LAST_RECORD_AT);
  });

  it('never overtakes the next turn’s queued /send row', async () => {
    // The operator typed turn C's prompt while turn B was still running, so its
    // `/send` row sits INSIDE turn B. A reply dated at B's end would sort below
    // that row and `groupMessagesIntoPairs` would hang B's answer under C's
    // question.
    const queued = Date.parse('2026-09-02T14:38:50.000Z');
    expect(queued).toBeGreaterThan(PROMPT_AT);
    expect(queued).toBeLessThan(LAST_RECORD_AT);
    unkeyed = [{ id: 'send-queued', content: '続けてください。', timestamp: new Date(queued) }];

    await captureClaude();

    expect(setMessageRequestId).toHaveBeenCalledWith(
      expect.anything(),
      'send-queued',
      claudePromptRequestId(CLAUDE_C)
    );
    expect(writtenAt(claudeTurnRequestId(CLAUDE_B))).toBe(queued - 1);
    expect(writtenAt(claudeTurnRequestId(CLAUDE_B))).toBeLessThan(queued);
  });
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

async function writeCodexFixture(): Promise<void> {
  const dir = join(codexSessionsRoot(home), '2026', '09', '01');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `rollout-2026-09-01T10-08-39-${CODEX_SESSION}.jsonl`),
    CODEX_FIXTURE,
    'utf8'
  );
}

function captureCodex(): Promise<boolean> {
  getLastAgentEvent.mockReturnValue({ sessionId: CODEX_SESSION });
  return captureCodexTranscriptTurn(
    { worktreeId: WORKTREE_ID, cliToolId: 'codex', instanceId: 'codex' },
    { codexHome: home }
  );
}

describe('codex', () => {
  const PROMPT_AT = Date.parse('2026-09-01T01:09:33.036Z');
  const COMMAND_AT = Date.parse('2026-09-01T01:09:37.145Z');
  /** `task_complete` — codex's own end of turn. */
  const LAST_RECORD_AT = Date.parse('2026-09-01T01:09:39.129Z');

  beforeEach(async () => {
    await writeCodexFixture();
    // Anchor on the first turn so turn B is written rather than skipped.
    pretendSaved(codexTurnRequestId('01a05a83-0933-7723-8eb2-2e459b5a1ebd'));
  });

  it('dates the reply at the turn’s task_complete', async () => {
    await captureCodex();

    expect(writtenAt(codexTurnRequestId(CODEX_B))).toBe(LAST_RECORD_AT);
    expect(writtenAt(codexTurnRequestId(CODEX_B))).not.toBe(PROMPT_AT + 1);
  });

  it('puts the reply after an approval raised inside the turn', async () => {
    await captureCodex();

    expect(writtenAt(codexTurnRequestId(CODEX_B))).toBeGreaterThan(COMMAND_AT);
  });

  it('never puts the reply before its own user row', async () => {
    await captureCodex();

    expect(writtenAt(codexTurnRequestId(CODEX_B))).toBeGreaterThan(
      writtenAt(codexPromptRequestId('01a05a83-a8ec-7ea3-8b7d-3e589f1fdf6a'))
    );
  });

  it('keeps the three turns in conversation order', async () => {
    // The trap the Issue names: codex folds a prompt submitted mid-turn into
    // that same turn, so several replies can carry nearby instants. Moving them
    // to their turns' ends must not let one overtake another.
    await captureCodex();

    const replies = createMessage.mock.calls
      .map(([, message]) => message)
      .filter((message) => String(message.requestId).startsWith('codex-turn:'))
      .map((message) => (message.timestamp as Date).getTime());
    expect(replies).toHaveLength(2);
    expect([...replies].sort((a, b) => a - b)).toEqual(replies);
  });
});

// ---------------------------------------------------------------------------
// antigravity
// ---------------------------------------------------------------------------

async function writeAgyFixture(): Promise<void> {
  const path = antigravityTranscriptPath(home, AGY_CONVERSATION);
  if (!path) throw new Error('not a conversation id');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, AGY_FIXTURE, 'utf8');
}

function captureAgy(): Promise<boolean> {
  getLastAgentEvent.mockReturnValue({ sessionId: AGY_CONVERSATION });
  return captureAntigravityTranscriptTurn(
    { worktreeId: WORKTREE_ID, cliToolId: 'antigravity', instanceId: 'antigravity' },
    { antigravityHome: home }
  );
}

describe('antigravity', () => {
  const PROMPT_AT = Date.parse('2026-09-01T02:13:25Z');
  const TOOL_CALL_AT = Date.parse('2026-09-01T02:13:29Z');
  const LAST_RECORD_AT = Date.parse('2026-09-01T02:13:52Z');

  beforeEach(async () => {
    await writeAgyFixture();
    pretendSaved(antigravityTurnRequestId(AGY_CONVERSATION, 0));
  });

  it('dates the reply at the turn’s last record', async () => {
    await captureAgy();

    expect(writtenAt(antigravityTurnRequestId(AGY_CONVERSATION, AGY_B))).toBe(LAST_RECORD_AT);
    expect(writtenAt(antigravityTurnRequestId(AGY_CONVERSATION, AGY_B))).not.toBe(PROMPT_AT + 1);
  });

  it('puts the reply after an approval raised inside the turn', async () => {
    // agy's `created_at` is second-resolution, which is exactly why the measured
    // incident had the reply and the prompt on the same second and the approval
    // three seconds later.
    await captureAgy();

    expect(writtenAt(antigravityTurnRequestId(AGY_CONVERSATION, AGY_B))).toBeGreaterThan(
      TOOL_CALL_AT
    );
  });

  it('never puts the reply before its own user row', async () => {
    await captureAgy();

    expect(writtenAt(antigravityTurnRequestId(AGY_CONVERSATION, AGY_B))).toBeGreaterThan(
      writtenAt(antigravityPromptRequestId(AGY_CONVERSATION, AGY_B))
    );
  });
});

// ---------------------------------------------------------------------------
// command-code
// ---------------------------------------------------------------------------

async function writeCommandCodeFixture(): Promise<void> {
  // Command Code names the project directory itself, so the reader finds the
  // file by session id rather than by a slug it could compute.
  const dir = join(commandCodeProjectsRoot(home), 'some-unguessable-slug');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${COMMAND_CODE_SESSION}.jsonl`), COMMAND_CODE_FIXTURE, 'utf8');
}

function captureCommandCode(): Promise<boolean> {
  getLastAgentEvent.mockReturnValue({ sessionId: COMMAND_CODE_SESSION });
  return captureCommandCodeTranscriptTurn(
    { worktreeId: WORKTREE_ID, cliToolId: 'command-code', instanceId: 'command-code' },
    { commandCodeHome: home }
  );
}

describe('command-code', () => {
  /** `meta.createdAt` of turn B's prompt, its tool-calling record, its reply. */
  const PROMPT_AT = 1788419735534;
  const TOOL_RECORD_AT = 1788419738546;
  const LAST_RECORD_AT = 1788419740209;

  beforeEach(async () => {
    await writeCommandCodeFixture();
    pretendSaved(commandCodeTurnRequestId(COMMAND_CODE_A));
  });

  it('dates the reply at the turn’s last assistant record', async () => {
    await captureCommandCode();

    expect(writtenAt(commandCodeTurnRequestId(COMMAND_CODE_B))).toBe(LAST_RECORD_AT);
    expect(writtenAt(commandCodeTurnRequestId(COMMAND_CODE_B))).not.toBe(PROMPT_AT + 1);
  });

  it('puts the reply after an approval raised inside the turn', async () => {
    await captureCommandCode();

    expect(writtenAt(commandCodeTurnRequestId(COMMAND_CODE_B))).toBeGreaterThan(TOOL_RECORD_AT);
  });

  it('never puts the reply before its own user row', async () => {
    await captureCommandCode();

    expect(writtenAt(commandCodeTurnRequestId(COMMAND_CODE_B))).toBeGreaterThan(
      writtenAt(commandCodePromptRequestId(COMMAND_CODE_B))
    );
  });
});

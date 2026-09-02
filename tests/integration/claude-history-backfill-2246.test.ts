/**
 * The backfill against a real database (Issue #2246).
 *
 * `tests/unit/hooks/sources/claude-history-backfill-2246.test.ts` pins the rule
 * — which turns are written, in which order, and what stops the scraper-era
 * rows being duplicated — against a stand-in for `chat_messages`. This file
 * pins what actually lands in the table, which is where the Issue's acceptance
 * criteria live:
 *
 *  - the turn the poller missed is a row, with the transcript's own text;
 *  - it sits between the turn before it and the turn after it, because
 *    `groupMessagesIntoPairs` orders by timestamp and nothing else;
 *  - the operator's `/send` row is *claimed* rather than duplicated, even when
 *    the agent accepted the prompt long after CommandMate sent it — which is the
 *    case #2196's symmetric two-minute window cannot reach and the measured
 *    incident actually was;
 *  - a second read writes nothing.
 *
 * The transcript is `tests/fixtures/claude-transcript-2246`, copied into a real
 * temporary directory in the layout Claude uses. Nothing outside that directory
 * and the in-memory database is touched.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (value: Database.Database | null) => {
      mockDb = value;
    },
  };
});

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import { groupMessagesIntoPairs, isOrphanPair } from '@/lib/conversation-grouper';
import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
import {
  claudePromptRequestId,
  claudeTurnRequestId,
  isAgentAuthoredMarkdown,
} from '@/types/agent-transcript';
import type { Worktree } from '@/types/models';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/claude-transcript-2246');
const WORKTREE_ID = 'wt-2246';
const WORKTREE_PATH = '/Users/operator/repos/commandmate-issue-2196';
const SESSION = '5f3a1c00-2246-4a00-9000-0000000000aa';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;

/** The three prompt uuids, oldest first. See the fixture README. */
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000005';
const C = '00000000-0000-4000-8000-000000000011';

/** The agent's own clock, from the fixture's prompt records. */
const A_AT = Date.parse('2026-09-02T14:20:11.004Z');
const B_AT = Date.parse('2026-09-02T14:38:24.117Z');

let threeTurns: string;
let db: Database.Database;
let home: string;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

async function writeTranscript(body: string): Promise<string> {
  const path = claudeTranscriptPath(home, WORKTREE_PATH, SESSION);
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(WORKTREE_PATH)), {
    recursive: true,
  });
  await writeFile(path, body, 'utf8');
  return path;
}

function capture(): Promise<boolean> {
  return captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });
}

/** Every row for the worktree, oldest first — the order History reads them in. */
function saved() {
  return getMessages(db, WORKTREE_ID, { limit: 200 })
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/** Turn A, as an earlier run of this reader left it. */
function seedTurnA(): void {
  createMessage(db, {
    worktreeId: WORKTREE_ID,
    role: 'user',
    content: 'リリース作業を進めてください。',
    messageType: 'normal',
    timestamp: new Date(A_AT),
    cliToolId: 'claude',
    instanceId: 'claude',
    requestId: claudePromptRequestId(A),
  });
  createMessage(db, {
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content: 'v0.30.0 のタグを作成し、CI の公開ジョブを起動しました。',
    messageType: 'normal',
    timestamp: new Date(A_AT + 1),
    cliToolId: 'claude',
    instanceId: 'claude',
    requestId: claudeTurnRequestId(A),
  });
}

beforeAll(async () => {
  threeTurns = await readFile(join(FIXTURE_DIR, 'three-turns.jsonl'), 'utf8');
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetClaudeTranscriptSessions();
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-2246',
    path: WORKTREE_PATH,
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
  home = await mkdtemp(join(tmpdir(), 'cmate-2246-int-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  await writeTranscript(threeTurns);
});

afterEach(async () => {
  await setMockDb(null);
  db.close();
  await rm(home, { recursive: true, force: true });
});

describe('the turn nobody wrote', () => {
  it('lands in chat_messages with the transcript’s own text', async () => {
    seedTurnA();

    expect(await capture()).toBe(true);

    const reply = saved().find((row) => row.requestId === claudeTurnRequestId(B));
    expect(reply?.content).toContain('GitHub Release v0.30.0 を公開しました。');
    expect(reply?.role).toBe('assistant');
    expect(isAgentAuthoredMarkdown(reply?.requestId)).toBe(true);
  });

  it('sits between the turn before it and the turn after it', async () => {
    seedTurnA();

    await capture();

    expect(saved().map((row) => row.requestId)).toEqual([
      claudePromptRequestId(A),
      claudeTurnRequestId(A),
      claudePromptRequestId(B),
      claudeTurnRequestId(B),
      claudePromptRequestId(C),
      claudeTurnRequestId(C),
    ]);
  });

  it('leaves no reply without a prompt in front of it', async () => {
    seedTurnA();

    await capture();

    const pairs = groupMessagesIntoPairs(saved());
    expect(pairs.filter(isOrphanPair)).toHaveLength(0);
    expect(pairs).toHaveLength(3);
  });

  it('writes nothing at all on a second read', async () => {
    seedTurnA();
    await capture();
    const first = saved().map((row) => row.id);

    expect(await capture()).toBe(true);

    expect(saved().map((row) => row.id)).toEqual(first);
  });
});

describe('the operator’s own /send row', () => {
  /** What `sendUserMessage` wrote when CommandMate handed the text to the pane. */
  function seedSendRow(at: number): string {
    return createMessage(db, {
      worktreeId: WORKTREE_ID,
      role: 'user',
      content: '良いです。',
      messageType: 'normal',
      timestamp: new Date(at),
      cliToolId: 'claude',
      instanceId: 'claude',
    }).id;
  }

  it('is claimed, not duplicated, when the agent accepted the prompt at once', async () => {
    seedTurnA();
    const sent = seedSendRow(B_AT - 400);

    await capture();

    const rows = saved().filter((row) => row.content === '良いです。');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sent);
    expect(rows[0].requestId).toBe(claudePromptRequestId(B));
  });

  it('is claimed even when the agent took longer than #2196’s window to accept it', async () => {
    // The measured shape: CommandMate sent the text while the previous turn was
    // still running and the agent only accepted it sixteen minutes later. #2196's
    // symmetric two-minute window cannot reach that row, so before #2246 the
    // backfill inserted a second copy of the operator's own message.
    seedTurnA();
    const sent = seedSendRow(A_AT + 109_000);
    expect(B_AT - (A_AT + 109_000)).toBeGreaterThan(120_000);

    await capture();

    const rows = saved().filter((row) => row.content === '良いです。');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sent);
    expect(rows[0].requestId).toBe(claudePromptRequestId(B));
  });

  it('is not claimed from before the previous turn opened', async () => {
    // The bound is the previous turn's own start, because a `/send` row for turn
    // N cannot have been written before turn N-1 opened — it had not been sent
    // yet. A row older than that belongs to some earlier conversation.
    seedTurnA();
    const sent = seedSendRow(A_AT - 60_000);

    await capture();

    const rows = saved().filter((row) => row.content === '良いです。');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === sent)?.requestId).toBeUndefined();
  });
});

describe('the duplicate guard, against the table the scraper wrote', () => {
  it('writes only the newest turn when this reader has written nothing here', async () => {
    // A and B are the scraper's rows: real replies, no `claude-turn:` key. A
    // Markdown row for either would show that reply twice.
    for (const [at, content] of [
      [A_AT, 'v0.30.0 のタグを作成し…'],
      [B_AT, 'GitHub Release v0.30.0 を公開しました…'],
    ] as const) {
      createMessage(db, {
        worktreeId: WORKTREE_ID,
        role: 'assistant',
        content,
        messageType: 'normal',
        timestamp: new Date(at),
        cliToolId: 'claude',
        instanceId: 'claude',
      });
    }

    expect(await capture()).toBe(true);

    const keyed = saved().filter((row) => isAgentAuthoredMarkdown(row.requestId));
    expect(keyed.map((row) => row.requestId)).toEqual([claudeTurnRequestId(C)]);
  });
});

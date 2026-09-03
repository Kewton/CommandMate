/**
 * What a slash command's turn puts in `chat_messages` (Issue #2265).
 *
 * `tests/unit/hooks/sources/claude-slash-turn-2265.test.ts` pins the rule — which
 * `<command-…>` record opens a turn and what the operator's line is rebuilt as.
 * This file pins the rows, which is where the Issue's acceptance criteria live:
 *
 *  - the `/release v0.30.1` reply is a row at all, keyed on the prompt record's
 *    own `uuid`, with the transcript's own Markdown in it;
 *  - the `user` row above it reads `/release v0.30.1` and not the XML Claude
 *    recorded;
 *  - the `/send` row CommandMate wrote for that same line is *claimed* rather
 *    than duplicated;
 *  - a built-in command — `/model`, whose whole output is a
 *    `<local-command-stdout>` record and which the agent never answers — puts
 *    nothing in the table at all.
 *
 * The transcripts are `tests/fixtures/claude-transcript-2265`, copied into a
 * real temporary directory in the layout Claude uses. Nothing outside that
 * directory and the in-memory database is touched.
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
import { claudePromptRequestId, claudeTurnRequestId } from '@/types/agent-transcript';
import type { Worktree } from '@/types/models';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/claude-transcript-2265');
const WORKTREE_ID = 'wt-2265';
const WORKTREE_PATH = '/Users/operator/repos/commandmate-issue-2196';
const SESSION = '7c4a9e20-2265-4b00-9000-0000000000aa';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;

/** The three prompt uuids, oldest first. See the fixture README. */
const A = '00000000-0000-4000-8000-000000000003';
const SLASH = '00000000-0000-4000-8000-000000000012';
const C = '00000000-0000-4000-8000-000000000024';

/** The agent's own clock, from the fixture's prompt records. */
const A_AT = Date.parse('2026-09-02T23:14:30.635Z');
const SLASH_AT = Date.parse('2026-09-02T23:20:35.205Z');

/** What the operator typed, and what `/send` wrote to `chat_messages` for it. */
const TYPED = '/release v0.30.1';

let releaseTurns: string;
let localCommandTurn: string;
let db: Database.Database;
let home: string;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

async function writeTranscript(body: string): Promise<void> {
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(WORKTREE_PATH)), {
    recursive: true,
  });
  await writeFile(claudeTranscriptPath(home, WORKTREE_PATH, SESSION), body, 'utf8');
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
    content: '対応済のissueはクローズ済ですか？',
    messageType: 'normal',
    timestamp: new Date(A_AT),
    cliToolId: 'claude',
    instanceId: 'claude',
    requestId: claudePromptRequestId(A),
  });
  createMessage(db, {
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content: 'はい、**4件すべてクローズ済み**です。',
    messageType: 'normal',
    timestamp: new Date(A_AT + 1),
    cliToolId: 'claude',
    instanceId: 'claude',
    requestId: claudeTurnRequestId(A),
  });
}

/** What `sendUserMessage` wrote when CommandMate handed `/release v0.30.1` to the pane. */
function seedSendRow(at: number): string {
  return createMessage(db, {
    worktreeId: WORKTREE_ID,
    role: 'user',
    content: TYPED,
    messageType: 'normal',
    timestamp: new Date(at),
    cliToolId: 'claude',
    instanceId: 'claude',
  }).id;
}

beforeAll(async () => {
  releaseTurns = await readFile(join(FIXTURE_DIR, 'release-slash-turn.jsonl'), 'utf8');
  localCommandTurn = await readFile(join(FIXTURE_DIR, 'local-command-turn.jsonl'), 'utf8');
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetClaudeTranscriptSessions();
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-2265',
    path: WORKTREE_PATH,
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
  home = await mkdtemp(join(tmpdir(), 'cmate-2265-int-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  await writeTranscript(releaseTurns);
});

afterEach(async () => {
  await setMockDb(null);
  db.close();
  await rm(home, { recursive: true, force: true });
});

describe('the reply to /release v0.30.1', () => {
  it('lands in chat_messages with the transcript’s own text', async () => {
    seedTurnA();

    expect(await capture()).toBe(true);

    const reply = saved().find((row) => row.requestId === claudeTurnRequestId(SLASH));
    expect(reply?.role).toBe('assistant');
    expect(reply?.content).toContain('`/release 0.30.1` を実行します。');
    expect(reply?.content).toContain('Phase 1・2 の進捗を報告します');
  });

  it('carries none of the command’s bookkeeping into the reply', async () => {
    seedTurnA();

    await capture();

    const reply = saved().find((row) => row.requestId === claudeTurnRequestId(SLASH));
    expect(reply?.content).not.toContain('<command-message>');
    expect(reply?.content).not.toContain('<command-name>');
    // The skill body the command expands to — 18 KB of instructions on its own
    // `isMeta` record, directly behind the prompt.
    expect(reply?.content).not.toContain('Base directory for this skill');
  });

  it('sits between the turn before it and the turn after it', async () => {
    seedTurnA();

    await capture();

    expect(saved().map((row) => row.requestId)).toEqual([
      claudePromptRequestId(A),
      claudeTurnRequestId(A),
      claudePromptRequestId(SLASH),
      claudeTurnRequestId(SLASH),
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

describe('the user row above it', () => {
  it('reads the line the operator typed, not the record Claude wrote', async () => {
    seedTurnA();

    await capture();

    const prompt = saved().find((row) => row.requestId === claudePromptRequestId(SLASH));
    expect(prompt?.role).toBe('user');
    expect(prompt?.content).toBe(TYPED);
  });

  it('claims the /send row instead of writing a second copy of it', async () => {
    seedTurnA();
    const sent = seedSendRow(SLASH_AT - 800);

    await capture();

    const rows = saved().filter((row) => row.content === TYPED);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sent);
    expect(rows[0].requestId).toBe(claudePromptRequestId(SLASH));
  });

  it('claims it even when the agent took longer than #2196’s window to accept it', async () => {
    // Six minutes separate turn A from the slash command in the fixture, so a
    // `/send` row written a minute after A is outside the symmetric two-minute
    // window and reachable only through #2246's `adoptionFromMs`.
    seedTurnA();
    const sent = seedSendRow(A_AT + 60_000);
    expect(SLASH_AT - (A_AT + 60_000)).toBeGreaterThan(120_000);

    await capture();

    const rows = saved().filter((row) => row.content === TYPED);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sent);
    expect(rows[0].requestId).toBe(claudePromptRequestId(SLASH));
  });
});

describe('a built-in command', () => {
  beforeEach(async () => {
    await writeTranscript(localCommandTurn);
  });

  it('puts nothing in chat_messages', async () => {
    // `/model` writes three `type: "user"` records and the agent answers none of
    // them. The only rows here are the ordinary turn in front of it.
    expect(await capture()).toBe(true);

    expect(saved().map((row) => row.requestId)).toEqual([
      claudePromptRequestId(A),
      claudeTurnRequestId(A),
    ]);
  });

  it('never shows its bookkeeping as anybody’s message', async () => {
    await capture();

    for (const row of saved()) {
      expect(row.content).not.toContain('<command-name>');
      expect(row.content).not.toContain('<local-command-stdout>');
      expect(row.content).not.toContain('<local-command-caveat>');
    }
  });
});

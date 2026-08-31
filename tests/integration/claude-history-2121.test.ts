/**
 * The Claude transcript writer against a real database (Issue #2121).
 *
 * `tests/unit/hooks/sources/claude-transcript-2121.test.ts` pins the rendering
 * and `tests/unit/hooks/sources/claude-history-2121.test.ts` pins the file
 * lookup; this file pins what actually lands in `chat_messages`, which is where
 * the Issue's own acceptance criteria live:
 *
 *  - the saved `assistant` row equals the transcript's text and not the pane's
 *    rendering of it;
 *  - **the operator's prompt is not in it.** The Issue measured 13,253 saved
 *    characters against a 3,669-character reply, the difference being the prompt
 *    the pane echoed back — so the transcript here is built to that shape, with a
 *    prompt several times the size of the answer;
 *  - the row is marked as the agent's own Markdown, which is the only thing
 *    `ConversationPairCard` reads to decide how to draw it — the component is
 *    untouched by this Issue and the assertion below uses the very predicate it
 *    calls;
 *  - a second read of the same finished turn writes nothing.
 *
 * The transcript is written to a real temporary directory in the layout Claude
 * uses — `<home>/.claude/projects/<slug>/<session-id>.jsonl` — with the record
 * shapes transcribed from live files on 2026-08-31. Nothing outside the temp
 * directory and the in-memory database is touched.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb?.close();
      mockDb = null;
    },
  };
});

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { getMessages, upsertWorktree } from '@/lib/db';
import { broadcastMessage } from '@/lib/ws-server';
import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
import { claudeTurnRequestId, isAgentAuthoredMarkdown } from '@/types/agent-transcript';
import type { Worktree } from '@/types/models';

const WORKTREE_ID = 'wt-2121';
const WORKTREE_PATH = '/repos/commandmate-issue-2121';
const SESSION = '0572eeb1-f7f8-4b39-8be5-e71ef93958ef';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;

/**
 * A prompt of the size the Issue measured leaking.
 *
 * Deliberately far longer than the reply, so that a reader that folded the two
 * together could not pass any assertion below by accident.
 */
const PROMPT = `## 実行契約\n${'ユーザーが書いた長い指示。'.repeat(400)}`;

/** The reply, in the six blocks one turn was measured to arrive in. */
const REPLY_BLOCKS = [
  "I'll start by reading the Issue and the opencode template implementation.",
  'The transcript reader groups records by the prompt they answer.',
  'The poller hands the turn over at the moment it would have saved a scrape.',
  'All gates are green.',
  '転写ファイルの本文がそのまま履歴に入るようになりました。',
] as const;

let db: Database.Database;
let home: string;

function userLine(uuid: string, content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    uuid,
    sessionId: SESSION,
    cwd: WORKTREE_PATH,
    gitBranch: 'feature/2121-tui-transcript-history',
    timestamp: '2026-08-31T10:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  });
}

function assistantLine(uuid: string, content: unknown[], at = '2026-08-31T10:00:05.000Z'): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    uuid,
    requestId: `req_${uuid}`,
    sessionId: SESSION,
    cwd: WORKTREE_PATH,
    timestamp: at,
    message: {
      model: 'claude-opus-5',
      role: 'assistant',
      content,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  });
}

/** One turn, in the shape a live transcript has it. */
function transcriptLines(): string[] {
  return [
    userLine('u-1', PROMPT),
    assistantLine('a-1', [{ type: 'text', text: REPLY_BLOCKS[0] }]),
    assistantLine('a-2', [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'gh issue view 2121' } },
    ]),
    // A tool result. `type: "user"` and not a prompt — 18 of every 19 user
    // records in the sampled session were these.
    userLine('u-tool-1', 'ignored', {
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'title: feat(history)…' }],
      },
    }),
    assistantLine('a-3', [{ type: 'text', text: REPLY_BLOCKS[1] }]),
    assistantLine('a-4', [{ type: 'thinking', thinking: '', signature: 'CAISoQ…' }]),
    assistantLine('a-5', [{ type: 'text', text: REPLY_BLOCKS[2] }]),
    assistantLine('a-6', [{ type: 'text', text: REPLY_BLOCKS[3] }]),
    assistantLine('a-7', [{ type: 'text', text: REPLY_BLOCKS[4] }]),
  ];
}

async function writeTranscript(lines: readonly string[]): Promise<string> {
  const path = claudeTranscriptPath(home, WORKTREE_PATH, SESSION);
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(WORKTREE_PATH)), {
    recursive: true,
  });
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

function capture(): Promise<boolean> {
  return captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });
}

/** The assistant rows this worktree has, oldest first. */
function savedAssistantRows() {
  return getMessages(db, WORKTREE_ID, { limit: 100 })
    .filter((message) => message.role === 'assistant')
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetClaudeTranscriptSessions();
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  home = await mkdtemp(join(tmpdir(), 'cmate-2121-int-'));

  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database) => void;
  };
  setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-2121',
    path: WORKTREE_PATH,
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
});

afterEach(async () => {
  resetClaudeTranscriptSessions();
  const { closeDbInstance } = (await import('@/lib/db/db-instance')) as unknown as {
    closeDbInstance: () => void;
  };
  closeDbInstance();
  await rm(home, { recursive: true, force: true });
});

describe('one turn, read off the transcript', () => {
  it('saves exactly one row for it', async () => {
    // The Issue counted 98 assistant records against one `chat_messages` row.
    // Nine records here; a reader keyed on anything but the prompt would save
    // nine rows.
    await writeTranscript(transcriptLines());
    expect(await capture()).toBe(true);

    const rows = savedAssistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBe(claudeTurnRequestId('u-1'));
    expect(rows[0].cliToolId).toBe('claude');
    expect(rows[0].instanceId).toBe('claude');
  });

  it('saves the transcript’s own text, block for block', async () => {
    await writeTranscript(transcriptLines());
    await capture();

    const content = savedAssistantRows()[0].content;
    for (const block of REPLY_BLOCKS) expect(content).toContain(block);
    expect(content).toContain('- `Bash` — gh issue view 2121');
  });

  it('does not put the operator’s prompt in the assistant row', async () => {
    // The defect the Issue exists for, asserted at the size it was measured at:
    // the prompt is several kilobytes and the reply is a few hundred bytes, so a
    // row that had swallowed the prompt could not possibly pass the length check
    // below.
    await writeTranscript(transcriptLines());
    await capture();

    const content = savedAssistantRows()[0].content;
    expect(PROMPT.length).toBeGreaterThan(4000);
    expect(content).not.toContain('ユーザーが書いた長い指示');
    expect(content).not.toContain('## 実行契約');
    expect(content.length).toBeLessThan(PROMPT.length);
  });

  it('does not put tool output in it either', async () => {
    await writeTranscript(transcriptLines());
    await capture();
    expect(savedAssistantRows()[0].content).not.toContain('title: feat(history)');
  });

  it('marks the row so the card renders it as Markdown', async () => {
    // `isAgentAuthoredMarkdown` is the predicate `ConversationPairCard` calls,
    // and it is the only thing the component reads to make this decision — which
    // is why the component needed no change for this Issue.
    await writeTranscript(transcriptLines());
    await capture();
    expect(isAgentAuthoredMarkdown(savedAssistantRows()[0].requestId)).toBe(true);
  });

  it('broadcasts the row so an open History pane sees it', async () => {
    await writeTranscript(transcriptLines());
    await capture();
    expect(vi.mocked(broadcastMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(broadcastMessage).mock.calls[0][0]).toBe('message');
  });
});

describe('two writers, one turn', () => {
  it('writes nothing extra when the poller reads the same finished turn again', async () => {
    await writeTranscript(transcriptLines());
    expect(await capture()).toBe(true);
    expect(await capture()).toBe(true);
    expect(await capture()).toBe(true);

    expect(savedAssistantRows()).toHaveLength(1);
    expect(vi.mocked(broadcastMessage)).toHaveBeenCalledTimes(1);
  });

  it('writes the next turn when the next turn arrives', async () => {
    await writeTranscript(transcriptLines());
    await capture();

    await writeTranscript([
      ...transcriptLines(),
      userLine('u-2', 'and now the follow-up'),
      assistantLine('b-1', [{ type: 'text', text: 'the follow-up answer' }], '2026-08-31T11:00:00.000Z'),
    ]);
    expect(await capture()).toBe(true);

    const rows = savedAssistantRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].content).toBe('the follow-up answer');
    expect(rows[1].requestId).toBe(claudeTurnRequestId('u-2'));
  });

  it('leaves the earlier turns of the session to whoever already saved them', async () => {
    // Only the newest turn is ever written. Every earlier turn already has the
    // row the scraper wrote for it, and a Markdown row alongside it would be the
    // same reply twice.
    await writeTranscript([
      userLine('u-old', 'an older prompt'),
      assistantLine('old-1', [{ type: 'text', text: 'AN OLDER ANSWER' }]),
      ...transcriptLines(),
    ]);
    await capture();

    const rows = savedAssistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).not.toContain('AN OLDER ANSWER');
  });
});

describe('reading a file that is still being written', () => {
  it('drops the half-written last line and saves the rest', async () => {
    const lines = transcriptLines();
    const damaged = [...lines, assistantLine('a-8', [{ type: 'text', text: 'never finished' }]).slice(0, 80)];
    await writeTranscript(damaged);

    expect(await capture()).toBe(true);
    const content = savedAssistantRows()[0].content;
    expect(content).toContain(REPLY_BLOCKS[4]);
    expect(content).not.toContain('never finished');
  });
});

describe('the scraper keeps the turn', () => {
  it('when there is no transcript file at all', async () => {
    expect(await capture()).toBe(false);
    expect(savedAssistantRows()).toHaveLength(0);
  });

  it('when no hook has named a session for this instance', async () => {
    await writeTranscript(transcriptLines());
    getLastAgentEvent.mockReturnValue(null);

    expect(await capture()).toBe(false);
    expect(savedAssistantRows()).toHaveLength(0);
  });

  it('when the reply has not reached the file yet', async () => {
    await writeTranscript([userLine('u-1', PROMPT)]);

    expect(await capture()).toBe(false);
    expect(savedAssistantRows()).toHaveLength(0);
  });
});

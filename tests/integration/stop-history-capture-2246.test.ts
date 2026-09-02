/**
 * The `stop` hook as the transcript reader's second trigger (Issue #2246).
 *
 * End to end, with the real gate, the real Claude reader and a real database:
 * the only things replaced are the session-pointer state (so the test names its
 * own transcript) and the WebSocket fan-out.
 *
 * What the Issue is actually about is the *combination* of two behaviours, so
 * this file drives the combination rather than either half. A poll that
 * misjudges one completion no longer loses a turn, because the agent's own stop
 * event asks for the same turn — and when both ask, the row is still one row.
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
const recordAgentStopEvent = vi.fn();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
  recordAgentStopEvent: (...a: unknown[]) => recordAgentStopEvent(...a),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { getMessages, upsertWorktree } from '@/lib/db';
import { applyAgentStopEvent } from '@/lib/hooks/agent-event-service';
import { captureTranscriptTurnOnStop } from '@/lib/hooks/stop-history-capture';
import {
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
import {
  captureStructuredHistoryTurn,
  resetStructuredHistoryCaptureQueue,
} from '@/lib/polling/structured-history-gate';
import { claudePromptRequestId, claudeTurnRequestId } from '@/types/agent-transcript';
import type { Worktree } from '@/types/models';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/claude-transcript-2246');
const WORKTREE_ID = 'wt-2246';
const WORKTREE_PATH = '/Users/operator/repos/commandmate-issue-2196';
const SESSION = '5f3a1c00-2246-4a00-9000-0000000000aa';

/** The three prompt uuids, oldest first. See the fixture README. */
const B = '00000000-0000-4000-8000-000000000005';
const C = '00000000-0000-4000-8000-000000000011';

let threeTurns: string;
let threeTurnsOpen: string;
let db: Database.Database;
let home: string;
let worktree: Worktree;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

async function writeTranscript(body: string): Promise<void> {
  const path = claudeTranscriptPath(home, WORKTREE_PATH, SESSION);
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(WORKTREE_PATH)), {
    recursive: true,
  });
  await writeFile(path, body, 'utf8');
}

function keys(): string[] {
  return getMessages(db, WORKTREE_ID, { limit: 200 })
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .map((row) => row.requestId ?? '');
}

/**
 * The hook receiver's own call, with the real home directory swapped out.
 *
 * `captureTranscriptTurnOnStop` takes no home seam — it is the production entry
 * point and reads `homedir()` — so the reader is driven through the gate here
 * with the same arguments the receiver passes plus the test's home.
 */
function stopCapture(retryDelayMs?: number): Promise<boolean> {
  return captureTranscriptTurnOnStop(
    { id: worktree.id, path: worktree.path },
    'claude',
    'claude',
    retryDelayMs === undefined ? {} : { retryDelayMs }
  );
}

beforeAll(async () => {
  threeTurns = await readFile(join(FIXTURE_DIR, 'three-turns.jsonl'), 'utf8');
  threeTurnsOpen = await readFile(join(FIXTURE_DIR, 'three-turns-open.jsonl'), 'utf8');
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetClaudeTranscriptSessions();
  resetStructuredHistoryCaptureQueue();
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);
  worktree = {
    id: WORKTREE_ID,
    name: 'issue-2246',
    path: WORKTREE_PATH,
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
  home = await mkdtemp(join(tmpdir(), 'cmate-2246-stop-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  // The reader resolves `~/.claude/projects` from the process's home; the
  // fixture is written under a temporary one.
  vi.stubEnv('HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await setMockDb(null);
  db.close();
  await rm(home, { recursive: true, force: true });
});

describe('a stop event with no poll behind it', () => {
  it('records the turn the agent just finished', async () => {
    await writeTranscript(threeTurns);

    await expect(stopCapture(0)).resolves.toBe(true);

    expect(keys()).toEqual([claudePromptRequestId(C), claudeTurnRequestId(C)]);
  });

  it('is reported by applyAgentStopEvent, for a worktree with no task at all', async () => {
    // The majority case, and the one this Issue is for: no contract, no task,
    // and the reply is the only thing that matters.
    await writeTranscript(threeTurns);

    const outcome = await applyAgentStopEvent(db, worktree, 'claude', 'claude');

    expect(outcome.taskId).toBeNull();
    expect(outcome.structuredHistoryCaptured).toBe(true);
    expect(keys()).toContain(claudeTurnRequestId(C));
  });

  it('still records the stop timestamp the rest of the system reads', async () => {
    await writeTranscript(threeTurns);

    await applyAgentStopEvent(db, worktree, 'claude', 'claude');

    expect(recordAgentStopEvent).toHaveBeenCalledWith(WORKTREE_ID, 'claude', 'claude');
  });
});

describe('the transcript the stop hook beat', () => {
  it('is read again after the delay, and written then', async () => {
    // The prompt record is in the file and the reply is not, which is what a
    // `stop` that arrives before the last append sees. The user row is written
    // on the first attempt — that is how this test knows the first attempt has
    // finished and it is safe to complete the file.
    await writeTranscript(threeTurnsOpen);

    const promise = stopCapture(400);
    await vi.waitFor(() => expect(keys()).toContain(claudePromptRequestId(C)));
    await writeTranscript(threeTurns);

    await expect(promise).resolves.toBe(true);
    expect(keys()).toContain(claudeTurnRequestId(C));
  });

  it('gives the turn back to the poller when the reply never arrives', async () => {
    await writeTranscript(threeTurnsOpen);

    await expect(stopCapture(20)).resolves.toBe(false);

    expect(keys()).not.toContain(claudeTurnRequestId(C));
  });
});

describe('fail-open', () => {
  it('answers false for a session no hook has ever named', async () => {
    // Hooks switched off. There is no session pointer, so there is no
    // transcript this reader can name, and the scraper is still the only record
    // there is — which is exactly what false tells the poller.
    getLastAgentEvent.mockReturnValue(null);
    await writeTranscript(threeTurns);

    await expect(stopCapture(20)).resolves.toBe(false);

    expect(keys()).toEqual([]);
  });

  it('answers false when the transcript file is not there', async () => {
    await expect(stopCapture(20)).resolves.toBe(false);

    expect(keys()).toEqual([]);
  });
});

describe('both triggers on one turn', () => {
  it('writes one row when the stop hook and the poller arrive together', async () => {
    // Two triggers for one turn is the ordinary state after #2246, not an edge
    // case, so the row count is asserted rather than assumed. (Which mechanism
    // keeps it at one — the adjacency of the lookup and the insert, or the
    // gate's queue in front of them — is argued in
    // `tests/unit/polling/structured-history-gate-2246.test.ts`.)
    await writeTranscript(threeTurns);

    const [fromStop, fromPoller] = await Promise.all([
      stopCapture(0),
      captureStructuredHistoryTurn(WORKTREE_ID, 'claude', 'claude', {
        worktreePath: WORKTREE_PATH,
        transcriptPathHint: null,
      }),
    ]);

    expect(fromStop).toBe(true);
    expect(fromPoller).toBe(true);
    expect(keys()).toEqual([claudePromptRequestId(C), claudeTurnRequestId(C)]);
  });

  it('backfills the turn the poller missed, once', async () => {
    // The Issue's timeline: the reader wrote turn A, the poller missed B, and C
    // has now finished. Both triggers fire and History ends with B and C — each
    // exactly once.
    await writeTranscript(threeTurns);
    await stopCapture(0);
    // Turn C's row is now the anchor; rewind by removing it, standing in for
    // the state the incident was actually in.
    db.prepare('DELETE FROM chat_messages WHERE request_id = ?').run(claudeTurnRequestId(C));
    db.prepare('DELETE FROM chat_messages WHERE request_id = ?').run(claudePromptRequestId(C));
    db.prepare(
      "INSERT INTO chat_messages (id, worktree_id, role, content, timestamp, request_id, cli_tool_id, instance_id) VALUES ('seed-a', ?, 'assistant', 'A', 1, ?, 'claude', 'claude')"
    ).run(WORKTREE_ID, claudeTurnRequestId('00000000-0000-4000-8000-000000000001'));

    await Promise.all([
      stopCapture(0),
      captureStructuredHistoryTurn(WORKTREE_ID, 'claude', 'claude', {
        worktreePath: WORKTREE_PATH,
        transcriptPathHint: null,
      }),
    ]);

    const written = keys().filter((key) => key.startsWith('claude-turn:'));
    expect(written).toEqual([
      claudeTurnRequestId('00000000-0000-4000-8000-000000000001'),
      claudeTurnRequestId(B),
      claudeTurnRequestId(C),
    ]);
  });
});

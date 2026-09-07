/**
 * A codex turn that only closes once the hook has been answered (Issue #2398).
 *
 * End to end, with the real gate, the real codex reader and a real database: the
 * only things replaced are the session-pointer state (so the test names its own
 * rollout) and the WebSocket fan-out.
 *
 * The condition being driven is the measured one, and it is a dependency rather
 * than a race. codex does not append the `task_complete` that closes a turn
 * until the Stop hook's command exits, and that command is a synchronous `curl`
 * at this receiver — so the `task_complete` line is written **after
 * `applyAgentStopEvent` has resolved** here, exactly as codex writes it 3–63 ms
 * after the receiver answers. Three days of logs, 105 codex stop events, 0
 * captured: the retries #2264 added were waiting for an append their own caller
 * was holding up.
 *
 * The fixture is the same rollout `tests/unit/hooks/sources/codex-history-2197`
 * reads, cut at its last line — which is what "the turn is still open" is, byte
 * for byte, in a codex session.
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

const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...a: unknown[]) => broadcastMessage(...a),
}));

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
const recordAgentStopEvent = vi.fn();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
  recordAgentStopEvent: (...a: unknown[]) => recordAgentStopEvent(...a),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { getMessages, upsertWorktree } from '@/lib/db';
import { applyAgentStopEvent } from '@/lib/hooks/agent-event-service';
import { resolveStopTranscriptCapture } from '@/lib/hooks/stop-history-capture';
import {
  codexSessionsRoot,
  resetCodexTranscriptSessions,
} from '@/lib/hooks/sources/codex/history';
import { resetStructuredHistoryCaptureQueue } from '@/lib/polling/structured-history-gate';
import { codexPromptRequestId, codexTurnRequestId } from '@/types/agent-transcript';
import type { Worktree } from '@/types/models';

const FIXTURE = join(
  process.cwd(),
  'tests/fixtures/transcripts/codex/rollout-three-turns-01510.jsonl'
);
const WORKTREE_ID = 'wt-2398';
const WORKTREE_PATH = '/Users/operator/repos/commandmate-issue-2398';
const SESSION = '01a05a82-d71b-7bc3-8901-487b0db19d40';
/** The newest turn in the fixture, and the reply codex ends it with. */
const LAST_TURN = '01a05a84-76f2-7390-83f3-51ea1346a364';
const LAST_PROMPT_ITEM = '01a05a84-773a-7bc1-84b3-13ab3d89aedd';
const LAST_BODY = '## Result\n\n- alpha\n- beta\n\n**Done.**';

/** The whole rollout, and the same file with its `task_complete` cut off. */
let closed: string;
let open: string;

let db: Database.Database;
let codexHome: string;
let worktree: Worktree;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

/** Put a rollout where codex would have put it. */
async function writeRollout(body: string): Promise<void> {
  const dir = join(codexSessionsRoot(codexHome), '2026', '09', '01');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-2026-09-01T10-08-39-${SESSION}.jsonl`), body, 'utf8');
}

function keys(): string[] {
  return getMessages(db, WORKTREE_ID, { limit: 200 }).map((row) => row.requestId ?? '');
}

function contentOf(requestId: string): string | undefined {
  return getMessages(db, WORKTREE_ID, { limit: 200 }).find((row) => row.requestId === requestId)
    ?.content;
}

beforeAll(async () => {
  closed = await readFile(FIXTURE, 'utf8');
  const lines = closed.trimEnd().split('\n');
  const last = lines[lines.length - 1];
  // The cut is asserted rather than assumed: a fixture whose last line stopped
  // being the `task_complete` would otherwise turn this whole file vacuous —
  // both halves would read a closed turn and every assertion would still pass.
  expect(last).toContain('"task_complete"');
  expect(last).toContain(LAST_TURN);
  open = `${lines.slice(0, -1).join('\n')}\n`;
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetCodexTranscriptSessions();
  resetStructuredHistoryCaptureQueue();
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);
  worktree = {
    id: WORKTREE_ID,
    name: 'issue-2398',
    path: WORKTREE_PATH,
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
  codexHome = await mkdtemp(join(tmpdir(), 'cmate-2398-codex-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  vi.stubEnv('CODEX_HOME', codexHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await setMockDb(null);
  db.close();
  await rm(codexHome, { recursive: true, force: true });
});

describe('the hook the transcript is waiting for', () => {
  it('answers without the turn, and says the read is only deferred', async () => {
    await writeRollout(open);

    const outcome = await applyAgentStopEvent(db, worktree, 'codex', 'codex');

    expect(outcome.structuredHistoryOutcome).toBe('deferred');
    // False, and this is the narrowing #2398 makes: not "nobody will write it"
    // but "it is not written yet". The route logs this field under the name
    // #2246 gave it, so its meaning is pinned here rather than left to drift.
    expect(outcome.structuredHistoryCaptured).toBe(false);
    expect(keys()).not.toContain(codexTurnRequestId(LAST_TURN));
    // The prompt row *is* written for an open turn (#2197 §4.3), which is how
    // this test knows the synchronous read really ran and really saw the file.
    expect(keys()).toContain(codexPromptRequestId(LAST_PROMPT_ITEM));
  });

  it('writes the reply from the read that happens after that answer', async () => {
    await writeRollout(open);

    await applyAgentStopEvent(db, worktree, 'codex', 'codex');
    // codex appends `task_complete` once the hook's `curl` has exited — which is
    // now. Before #2398 nothing read the file again, and this row never existed.
    await writeRollout(closed);

    await vi.waitFor(() => expect(keys()).toContain(codexTurnRequestId(LAST_TURN)), {
      timeout: 5_000,
      interval: 25,
    });
    expect(contentOf(codexTurnRequestId(LAST_TURN))).toContain(LAST_BODY);
    expect(broadcastMessage).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ worktreeId: WORKTREE_ID })
    );
  });

  it('writes it once, however many times the deferred reads run', async () => {
    await writeRollout(closed);

    // A turn already closed at the answer is captured synchronously, and the
    // deferred reads are never scheduled for it — so the row cannot be written
    // twice by the two paths.
    const outcome = await applyAgentStopEvent(db, worktree, 'codex', 'codex');

    expect(outcome.structuredHistoryOutcome).toBe('captured');
    expect(outcome.structuredHistoryCaptured).toBe(true);
    expect(keys().filter((key) => key === codexTurnRequestId(LAST_TURN))).toHaveLength(1);
    expect(contentOf(codexTurnRequestId(LAST_TURN))).toContain(LAST_BODY);
  });
});

describe('the turn that never closes', () => {
  it('is handed back to the scraper once the reads run out', async () => {
    await writeRollout(open);

    const outcome = await resolveStopTranscriptCapture(
      { id: worktree.id, path: worktree.path },
      'codex',
      'codex',
      { deferredDelaysMs: [10, 10] }
    );

    expect(outcome.status).toBe('deferred');
    await expect(outcome.deferred).resolves.toBe(false);
    expect(keys()).not.toContain(codexTurnRequestId(LAST_TURN));
  });
});

describe('fail-open', () => {
  it('schedules nothing for a session no hook has ever named', async () => {
    // Hooks switched off, or a server restarted mid-session: there is no
    // pointer, so there is no rollout to come back to and the scraper is the
    // only record there will be.
    getLastAgentEvent.mockReturnValue(null);
    await writeRollout(open);

    const outcome = await applyAgentStopEvent(db, worktree, 'codex', 'codex');

    expect(outcome.structuredHistoryOutcome).toBe('unavailable');
    expect(keys()).toEqual([]);
  });

  it('schedules nothing when the rollout is not on disk', async () => {
    const outcome = await applyAgentStopEvent(db, worktree, 'codex', 'codex');

    expect(outcome.structuredHistoryOutcome).toBe('unavailable');
    expect(keys()).toEqual([]);
  });
});

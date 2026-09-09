/**
 * Retiring the previous process's history when a new one starts (Issue #2444).
 *
 * `chat_messages.archived` had exactly one writer — `kill-session` — and that
 * route only ever sees the ending nobody actually gets. A tmux server that went
 * away, a CLI `/exit`ed back to its shell, a reboot: the rows stayed
 * `archived = 0` and the chat surface presented a dead session's conversation
 * as the live one. The route could not even be used to clean up afterwards; with
 * no live session left to kill it returns 404 *before* the archive call.
 *
 * These tests pin the writer this Issue adds, against a real database, because
 * every claim here is a claim about SQL scope:
 *
 *  - the scope is one `(worktreeId, instanceId)` pair, so restarting `codex`
 *    leaves `codex-2`'s conversation — same worktree, same tool — alone;
 *  - already-archived rows are not re-counted, so two calls are not two
 *    generations;
 *  - `recomputeLastUserMessage` runs, so the sidebar stops quoting a
 *    conversation the surface no longer shows;
 *  - nothing at all happens when there was nothing to archive, which is what
 *    makes the healthy-reuse path (which never calls in here) and a first-ever
 *    launch indistinguishable on the wire.
 *
 * The database is handed in explicitly. `resolveSessionArchiveDatabase` — the
 * production default — is tested separately below, and refuses to open one
 * under Vitest for the reason its own doc comment gives.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree, getWorktreeById } from '@/lib/db';
import {
  archiveSupersededSessionMessages,
  resolveSessionArchiveDatabase,
} from '@/lib/session/session-generation-archive';
import { MESSAGES_INVALIDATED_EVENT_TYPE } from '@/lib/realtime/types';
import type { Worktree } from '@/types/models';

const broadcastMessage = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ws-server', () => ({ broadcastMessage }));

const getDbInstance = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance }));

const WT = 'wt-2444';
const OTHER_WT = 'wt-2444-other';

let db: Database.Database;

function seedWorktree(id: string): void {
  const worktree: Worktree = {
    id,
    name: id,
    path: `/repo/${id}`,
    repositoryPath: '/repo',
    repositoryName: 'repo',
    cliToolId: 'codex',
  };
  upsertWorktree(db, worktree);
}

function seed(params: {
  worktreeId?: string;
  role: 'user' | 'assistant';
  content: string;
  cliToolId?: string;
  instanceId?: string;
  at?: number;
}): string {
  const row = createMessage(db, {
    worktreeId: params.worktreeId ?? WT,
    role: params.role,
    content: params.content,
    timestamp: new Date(params.at ?? Date.now()),
    messageType: 'normal',
    cliToolId: (params.cliToolId ?? 'codex') as Worktree['cliToolId'],
    instanceId: params.instanceId ?? params.cliToolId ?? 'codex',
  });
  return row.id;
}

/** Active (un-archived) rows for one instance, oldest first (`getMessages`
 * answers newest-first). */
function activeContents(worktreeId: string, instanceId: string): string[] {
  return getMessages(db, worktreeId, { instanceId })
    .map((m) => m.content)
    .reverse();
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  seedWorktree(WT);
  seedWorktree(OTHER_WT);
  broadcastMessage.mockClear();
  getDbInstance.mockReset();
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

describe('archiveSupersededSessionMessages', () => {
  it('archives the target instance and leaves a sibling instance of the same tool alone', () => {
    seed({ role: 'user', content: 'old codex question', instanceId: 'codex' });
    seed({ role: 'assistant', content: 'old codex answer', instanceId: 'codex' });
    seed({ role: 'user', content: 'codex-2 question', instanceId: 'codex-2' });

    const result = archiveSupersededSessionMessages(
      { worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' },
      db,
    );

    expect(result).toEqual({ archived: 2, instanceId: 'codex' });
    expect(activeContents(WT, 'codex')).toEqual([]);
    // The whole point of the (worktree, instance) scope: restarting codex must
    // not wipe codex-2, which shares both the worktree and the tool id.
    expect(activeContents(WT, 'codex-2')).toEqual(['codex-2 question']);
  });

  it('leaves another worktree untouched', () => {
    seed({ role: 'user', content: 'here', instanceId: 'codex' });
    seed({ worktreeId: OTHER_WT, role: 'user', content: 'elsewhere', instanceId: 'codex' });

    archiveSupersededSessionMessages({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' }, db);

    expect(activeContents(OTHER_WT, 'codex')).toEqual(['elsewhere']);
  });

  it('defaults the instance to the primary one (instanceId === cliToolId)', () => {
    seed({ role: 'user', content: 'primary', cliToolId: 'claude', instanceId: 'claude' });

    const result = archiveSupersededSessionMessages({ worktreeId: WT, cliToolId: 'claude' }, db);

    expect(result).toEqual({ archived: 1, instanceId: 'claude' });
    expect(activeContents(WT, 'claude')).toEqual([]);
  });

  it('does not re-archive rows a previous generation already retired', () => {
    seed({ role: 'user', content: 'gen 1', instanceId: 'codex' });
    expect(
      archiveSupersededSessionMessages({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' }, db)
        .archived,
    ).toBe(1);

    // Second launch, nothing new written in between.
    expect(
      archiveSupersededSessionMessages({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' }, db)
        .archived,
    ).toBe(0);
  });

  it('recomputes the sidebar last message from the rows that survived', () => {
    // Seeded so the DEAD session wrote last: `createMessage` sets
    // `last_user_message` on every user row, so the sidebar starts out quoting
    // the conversation the surface is about to stop showing. Without the
    // recompute it would keep quoting it — the assertion is vacuous the other
    // way round.
    seed({ role: 'user', content: 'live sibling question', instanceId: 'codex-2', at: 1_000 });
    seed({ role: 'user', content: 'dead session question', instanceId: 'codex', at: 2_000 });
    expect(getWorktreeById(db, WT)?.lastUserMessage).toBe('dead session question');

    archiveSupersededSessionMessages({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' }, db);

    expect(getWorktreeById(db, WT)?.lastUserMessage).toBe('live sibling question');
  });

  it('clears the sidebar last message when nothing active is left', () => {
    seed({ role: 'user', content: 'only question', instanceId: 'codex' });

    archiveSupersededSessionMessages({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' }, db);

    expect(getWorktreeById(db, WT)?.lastUserMessage).toBeUndefined();
  });

  it('publishes messages_invalidated for the resolved scope', async () => {
    seed({ role: 'user', content: 'old', instanceId: 'codex-3', cliToolId: 'codex' });

    archiveSupersededSessionMessages(
      { worktreeId: WT, cliToolId: 'codex', instanceId: 'codex-3' },
      db,
    );

    // The publish is detached behind a dynamic `import('@/lib/ws-server')`, so
    // it lands a microtask later — the same bargain `broadcastRecordedRow` in
    // current-output-builder strikes, and the reason this assertion awaits.
    await vi.waitFor(() => expect(broadcastMessage).toHaveBeenCalledTimes(1));
    expect(broadcastMessage).toHaveBeenCalledWith(MESSAGES_INVALIDATED_EVENT_TYPE, {
      worktreeId: WT,
      cliToolId: 'codex',
      instanceId: 'codex-3',
      reason: 'session_generation',
    });
  });

  it('writes and publishes nothing when the instance has no active rows', async () => {
    seed({ role: 'user', content: 'sibling only', instanceId: 'codex-2' });
    const before = getWorktreeById(db, WT)?.lastUserMessage;

    const result = archiveSupersededSessionMessages(
      { worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' },
      db,
    );

    expect(result.archived).toBe(0);
    expect(getWorktreeById(db, WT)?.lastUserMessage).toBe(before);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it('is inert when there is no database to archive through', () => {
    const result = archiveSupersededSessionMessages(
      { worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' },
      null,
    );

    expect(result).toEqual({ archived: 0, instanceId: 'codex' });
    expect(getDbInstance).not.toHaveBeenCalled();
  });

  it('propagates a database failure to its caller, which is the one that decides', () => {
    const broken = {
      prepare: () => {
        throw new Error('database is locked');
      },
    } as unknown as Database.Database;

    // `beginAgentSession` catches this and logs; the archive itself does not
    // swallow, so a caller that wants to know can.
    expect(() =>
      archiveSupersededSessionMessages(
        { worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' },
        broken,
      ),
    ).toThrow(/database is locked/);
  });
});

describe('resolveSessionArchiveDatabase', () => {
  it('refuses to open a database under Vitest', () => {
    expect(process.env.VITEST).toBeTruthy();

    expect(resolveSessionArchiveDatabase()).toBeNull();
    // The point of the guard: `getDbInstance()` CREATES the file when it is
    // missing, so a suite that mocks tmux and never touches a database would
    // otherwise fabricate `<cwd>/data/cm.db` — or, in a checkout that has one,
    // hand its fixtures the developer's real chat history to write into.
    expect(getDbInstance).not.toHaveBeenCalled();
  });

  it('resolves the shared singleton outside Vitest', () => {
    getDbInstance.mockReturnValue(db);
    vi.stubEnv('VITEST', '');

    expect(resolveSessionArchiveDatabase()).toBe(db);
    expect(getDbInstance).toHaveBeenCalledTimes(1);
  });
});

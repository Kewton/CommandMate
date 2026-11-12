/**
 * A world for the hand-off's tests (Issue #4227 G-PR2): a migrated file DB under
 * `os.tmpdir()`, one registered repository, one worktree with the primary `claude`, its
 * D1 boundary, a clock, and git answers that can be held (an await to race against).
 * Nothing here starts a server, tmux or an agent.
 */
import { mkdirSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { createRepository } from '@/lib/db/db-repository';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { deleteWorktreesByIds } from '@/lib/db/worktree-db';
import { openBoundary, readInstanceLifetime } from '@/lib/db/session-brief-db';
import { memAddItem, memWriteFromScreen, type MemServiceDeps } from '@/lib/mem/service';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import type { MemWriteResponse } from '@/types/mem';
import { handoffCreate } from '@/lib/handoff/request';
import { handoffDone, handoffPropose } from '@/lib/handoff/proposals';
import type { HandoffCreateResponse, HandoffReadResponse } from '@/lib/handoff/types';

export const SHA = '0123456789abcdef0123456789abcdef01234567';
export const WT = 'wt-h';

export interface HandoffWorld {
  db: Database.Database;
  dir: string;
  repoId: string;
  clock: { now: number };
  branch: { name: string };
  deps: () => MemServiceDeps & { now: () => number };
  /**
   * Holds a git answer (the mode's observation) until released: the next one, or the one
   * after `skip` others (a decide's own start is the first, its write's the second).
   * `reached` resolves when the hold engages.
   */
  arm: (skip?: number) => { release: () => void; reached: Promise<void> };
  makeWorktree: () => void;
  recreateWorktree: () => void;
  openLaunch: () => string;
  setMode: (mode: 'off' | 'derived' | 'on', popup?: boolean) => void;
  count: (sql: string, ...params: unknown[]) => number;
  snapshot: () => string;
  itemsSnapshot: () => string;
  addNote: (text: string) => Promise<{ id: string; version: number }>;
  humanNote: (text: string) => Promise<{ id: string; version: number }>;
  create: () => Promise<HandoffCreateResponse>;
  propose: (rid: string, body: Record<string, unknown>) => Promise<{ id: string; fingerprint: string }>;
  done: (rid: string) => Promise<void>;
  close: () => void;
}

export const screenRequest = () => ({
  headers: new Headers({ 'X-CommandMate-Client': 'screen', origin: 'http://localhost', host: 'localhost' }),
  url: 'http://localhost/api/worktrees/wt-h/mem/handoff/requests',
});
export const plainRequest = () => ({ headers: new Headers({ host: 'localhost' }), url: 'http://localhost/api/worktrees/wt-h/mem/handoff/requests' });

export function makeHandoffWorld(prefix = 'handoff-4227-'): HandoffWorld {
  const dir = makeTempDir(prefix);
  const db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  const root = path.join(dir, 'root');
  mkdirSync(root, { recursive: true });
  const repoId = createRepository(db, { name: 'repo', path: root, cloneSource: 'local' }).id;
  const clock = { now: Date.parse('2026-11-10T00:00:00Z') };
  const branch = { name: 'feature/x' };
  let hold: { wait: Promise<void>; armed: boolean; skip: number; engaged: () => void } | null = null;
  const held = async () => {
    if (!hold?.armed) return;
    if (hold.skip > 0) {
      hold.skip -= 1;
      return;
    }
    hold.armed = false;
    hold.engaged();
    await hold.wait;
  };
  const wtPath = path.join(dir, WT);
  const world: HandoffWorld = {
    db,
    dir,
    repoId,
    clock,
    branch,
    deps: () => ({
      now: () => clock.now,
      resolveCommonDir: async () => '/common/.git',
      pathExists: () => true,
      observe: async (): Promise<WorktreeHeadObservation> => {
        await held();
        return { branch: branch.name, detached: false, head: SHA, commonDir: '/common/.git', known: true };
      },
      git: { originUrl: async () => 'git@github.com:Kewton/CommandMate.git', refTip: async () => SHA },
    }),
    arm: (skip = 0) => {
      let release!: () => void;
      let engaged!: () => void;
      const wait = new Promise<void>((resolve) => (release = resolve));
      const reached = new Promise<void>((resolve) => (engaged = resolve));
      hold = { wait, armed: true, skip, engaged };
      return { release, reached };
    },
    makeWorktree: () => {
      mkdirSync(wtPath, { recursive: true });
      db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(WT, WT, wtPath, root);
    },
    recreateWorktree: () => {
      deleteWorktreesByIds(db, [WT]);
      world.makeWorktree();
      world.openLaunch();
    },
    openLaunch: () =>
      openBoundary(db, {
        worktreeId: WT,
        instanceId: 'claude',
        cliToolId: 'claude',
        lifetime: readInstanceLifetime(db, WT, 'claude'),
        kind: 'launch',
        evidence: 'launch',
        openedAt: clock.now,
      }).id,
    setMode: (mode, popup = true) => {
      const current = getMemSettings(db, repoId);
      saveMemSettings(db, repoId, {
        version: current.version,
        features: { ...current.features, popup },
        rules: [{ match: 'glob', pattern: '**', mode }],
      });
    },
    count: (sql, ...params) => (db.prepare(sql).get(...params) as { n: number }).n,
    snapshot: () =>
      JSON.stringify([
        db.prepare('SELECT * FROM mem_handoff_requests ORDER BY id').all(),
        db.prepare('SELECT * FROM mem_handoff_proposals ORDER BY id').all(),
        db.prepare('SELECT * FROM mem_items ORDER BY id').all(),
      ]),
    itemsSnapshot: () => JSON.stringify(db.prepare('SELECT * FROM mem_items ORDER BY id').all()),
    addNote: async (text) => {
      const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text }, world.deps());
      const item = (outcome.body as MemWriteResponse).item;
      return { id: item.id, version: item.version };
    },
    humanNote: async (text) => {
      const outcome = await memWriteFromScreen(
        db,
        screenRequest(),
        WT,
        { op: 'add', author: 'human', body: { instanceId: 'claude', kind: 'note', text, key: `human-${text.length}-${clock.now}`, expectBranch: branch.name } },
        world.deps()
      );
      const item = (outcome.body as MemWriteResponse).item;
      return { id: item.id, version: item.version };
    },
    create: async () => {
      const outcome = await handoffCreate(db, screenRequest(), WT, { instanceId: 'claude' }, world.deps());
      if (outcome.status !== 201) throw new Error(`create: ${outcome.status} ${JSON.stringify(outcome.body)}`);
      return outcome.body as HandoffCreateResponse;
    },
    propose: async (rid, body) => {
      const outcome = await handoffPropose(db, WT, rid, { instanceId: 'claude', ...body }, world.deps());
      if (outcome.status !== 201) throw new Error(`propose: ${outcome.status} ${JSON.stringify(outcome.body)}`);
      const proposal = (outcome.body as { proposal: { id: string; fingerprint: string } }).proposal;
      return { id: proposal.id, fingerprint: proposal.fingerprint };
    },
    done: async (rid) => {
      const outcome = await handoffDone(db, WT, rid, { instanceId: 'claude' }, world.deps());
      if (outcome.status !== 200) throw new Error(`done: ${outcome.status} ${JSON.stringify(outcome.body)}`);
    },
    close: () => {
      db.close();
      removeTempDir(dir);
    },
  };
  return world;
}

export const versionOf = (body: unknown) => (body as HandoffReadResponse).request.version;
export const codeOf = (outcome: { body: unknown }) => (outcome.body as { code?: string }).code;

/**
 * The `branch` condition against a real git repository under `os.tmpdir()` (Issue #4222,
 * design §1.4, P1-4・P2-1・2nd review ②): the ref's creation time is read from its
 * reflog entry, never a commit's time, and the reflog format is the one git writes.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { readRefTip } from '@/lib/mem/git-observe';
import { defaultMemExec } from '@/lib/mem/query-plan';
import { memCheck } from '@/lib/mem/service';
import type { MemCheckResponse, MemConditionView } from '@/types/mem';
import { MemWorld } from './mem-4222-harness';

const world = new MemWorld();
let repoDir: string;

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (args: string[], extra: Record<string, string> = {}) =>
  execFileSync('git', args, { cwd: repoDir, env: { ...env, ...extra }, encoding: 'utf8' }).trim();
const commit = (message: string, date?: string) =>
  git(['commit', '--allow-empty', '-q', '-m', message], date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {});
const createdSeconds = (name: string) => Number(/@\{(\d+)\}/.exec(git(['reflog', 'show', '--date=unix', '--format=%gd', `refs/heads/${name}`]).split('\n').pop()!)![1]);

beforeEach(() => {
  world.open('mem-git-4222-');
  repoDir = world.root;
  git(['init', '-q', '-b', 'develop']);
  commit('base');
  // The worktree is the repository itself, so the tip at create is read by real git.
  world.db
    .prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('wt-1', 'wt-1', ?, ?, 'repo')`)
    .run(repoDir, repoDir);
  world.setMode('on');
});
afterEach(() => world.close());

const deps = (now?: number) => ({
  ...world.deps(),
  git: { originUrl: async () => null, refTip: readRefTip },
  ...(now !== undefined ? { now: () => now } : {}),
  evaluation: { exec: defaultMemExec },
});

async function add(closeWhen: string, now: number) {
  const { memAddItem } = await import('@/lib/mem/service');
  const outcome = await memAddItem(world.db, 'wt-1', { instanceId: 'claude', kind: 'next', text: 'x', closeWhen }, deps(now));
  expect(outcome.status).toBe(201);
  return (outcome.body as { item: { id: string } }).item.id;
}
async function evaluate(): Promise<Record<string, MemConditionView>> {
  world.head = { ...world.head, branch: 'develop' };
  const outcome = await memCheck(world.db, { via: 'worktree', worktreeId: 'wt-1', branch: 'feature/x' }, {}, deps());
  expect(outcome.status).toBe(200);
  return Object.fromEntries((outcome.body as MemCheckResponse).results.map((entry) => [entry.itemId, entry.condition]));
}

describe('branch against real git', () => {
  it('P1-4: deleted and made again from an old commit (commit time in the past) → recreated: deleted met, merged not', async () => {
    commit('old', '2020-01-01T00:00:00Z');
    const old = git(['rev-parse', 'HEAD']);
    git(['branch', 'feature/x', old]);
    git(['checkout', '-q', '-b', 'side']);
    commit('new on side');
    const createdAt = (createdSeconds('feature/x') - 5) * 1000;
    // Items written "before" the branch existed would be refused for merged (no tip); give them a time after the
    // first creation, so they keep its tip, then re-create the branch later from the same old commit.
    const itemTime = (createdSeconds('feature/x') + 1) * 1000 + 100;
    const deleted = await add('branch:feature/x?deleted', itemTime);
    const merged = await add('branch:feature/x?merged=develop', itemTime);
    expect(createdAt).toBeLessThan(itemTime);
    // Wait into a later second than the item, delete and make the branch again from the old commit.
    while (Math.floor(Date.now() / 1000) * 1000 <= itemTime) await new Promise((resolve) => setImmediate(resolve));
    git(['branch', '-D', 'feature/x']);
    git(['branch', 'feature/x', old]);
    git(['checkout', '-q', 'develop']);
    git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/x']);
    const results = await evaluate();
    expect(results[deleted]).toMatchObject({ result: 'met', reason: 'branch-recreated' });
    expect(results[merged]).toMatchObject({ result: 'unknown', closed: false });
  });

  it('(control) a branch made before the item and left alone → same: deleted not met, merged met once merged', async () => {
    git(['branch', 'feature/x']);
    const itemTime = (createdSeconds('feature/x') + 2) * 1000;
    const deleted = await add('branch:feature/x?deleted', itemTime);
    const merged = await add('branch:feature/x?merged=develop', itemTime);
    git(['checkout', '-q', 'feature/x']);
    commit('work');
    git(['checkout', '-q', 'develop']);
    git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/x']);
    const results = await evaluate();
    expect(results[deleted]).toMatchObject({ result: 'not-met', reason: 'branch-present' });
    expect(results[merged]).toMatchObject({ result: 'met', reason: 'branch-merged', closed: true });
  });

  it('2nd review ②: an item in the same second as the branch’s creation → unknown, not same', async () => {
    git(['branch', 'feature/x']);
    const itemTime = createdSeconds('feature/x') * 1000 + 999;
    const deleted = await add('branch:feature/x?deleted', itemTime);
    const results = await evaluate();
    expect(results[deleted]).toMatchObject({ result: 'unknown', reason: 'branch-order-uncertain' });
  });

  it('P2-2-1: a deleted condition stored with an empty tip (as #4221 stored it) is not read as recreated', async () => {
    const id = await add('branch:feature/x?deleted', Date.now() - 60_000);
    world.db
      .prepare('UPDATE mem_items SET close_when = json_set(close_when, \'$.tipAtCreate\', \'\') WHERE id = ?')
      .run(id);
    git(['branch', 'feature/x']);
    const results = await evaluate();
    expect(results[id]).toMatchObject({ result: 'not-met', reason: 'branch-present-no-baseline' });
    git(['branch', '-D', 'feature/x']);
    expect((await evaluate())[id]).toMatchObject({ result: 'met', reason: 'branch-deleted' });
  });

  it('a deleted condition keeps the tip when the ref exists at the write, and stores an empty one when it does not', async () => {
    git(['branch', 'feature/x']);
    const withTip = await add('branch:feature/x?deleted', Date.now());
    const tip = git(['rev-parse', 'feature/x']);
    const noRef = await add('branch:feature/none?deleted', Date.now());
    const stored = (id: string) => JSON.parse((world.db.prepare('SELECT close_when FROM mem_items WHERE id = ?').get(id) as { close_when: string }).close_when);
    expect(stored(withTip).tipAtCreate).toBe(tip);
    expect(stored(noRef).tipAtCreate).toBe('');
    expect(path.isAbsolute(repoDir)).toBe(true);
  });
});

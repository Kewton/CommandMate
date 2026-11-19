/**
 * Issue #4480 (review-4452-3 P3-1): running server.ts's start sequence starts
 * `agy` 0 times.
 *
 * `agy-startup-4452.test.ts` loads the modules server.ts loads and calls the first
 * requests' functions, but never ran the start sequence itself: that it runs no
 * version probe rested on a static reading. This file runs the steps, in
 * server.ts's order, on the real modules:
 *
 *  - an in-memory DB (migrated) holding one worktree whose roster is an
 *    antigravity instance, so every step that looks at sessions sees one;
 *  - a private `PATH` with the fake agy / claude / codex and a fake `tmux` whose
 *    `list-sessions` answers that worktree's antigravity and claude sessions —
 *    the real tmux is not on `PATH`, so no real session or option is touched;
 *  - a private `HOME` (the install is treated as global) and `CM_DB_PATH` under the
 *    sandbox: the read-mode script, the Skill journal and the Auto-Yes shutdown
 *    record land there, if anywhere — not in the repository's working directory.
 *
 * Steps not run are listed in {@link NOT_RUN} with the reason, and the last case
 * fails when server.ts gains a dynamically imported start step this file neither
 * runs nor lists.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { installFakeAgyPath, settleBackgroundProbes, type FakeAgyPath } from '@tests/helpers/fake-agy-path';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import type { Worktree } from '@/types/models';

// The install is treated as global, so the steps that keep state under the
// config directory (the Skill operation journal and locks, the read-mode script)
// write under the private HOME, never into the repository's working directory.
// (`ensureConfigDir` calls `getConfigDir` inside its own module, so both are
// replaced, not only `isGlobalInstall`.)
vi.mock('@/cli/utils/install-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/cli/utils/install-context')>();
  const nodePath = await import('path');
  const nodeFs = await import('fs');
  const configDir = (): string => nodePath.join(process.env.HOME ?? '/nonexistent', '.commandmate');
  return {
    ...actual,
    isGlobalInstall: () => true,
    getConfigDir: configDir,
    ensureConfigDir: () => {
      nodeFs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
      return configDir();
    },
  };
});

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database | null): void;
}
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
      mockDb = db;
    },
  };
});

import { setMockDb } from '@/lib/db/db-instance';
import { hasAntigravityBeenUsed, resetAntigravityUseForTest } from '@/lib/tool-policy/version-probe-gate';
import { restoreAutoYesShutdownRecord } from '@/lib/auto-yes-shutdown-record';
import { runDotenvSelfCheck } from '@/lib/env';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';
import { initScheduleManager, stopAllSchedules } from '@/lib/schedule-manager';
import { initTimerManager, stopAllTimers } from '@/lib/timer-manager';
import { initResourceCleanup, stopResourceCleanup } from '@/lib/resource-cleanup';

const WT = 'wt-4480-startup';

const SERVER_SOURCE = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');

/** Every module server.ts loads with `await import('./src/...')`. */
const DYNAMIC_START_MODULES = [
  ...new Set([...SERVER_SOURCE.matchAll(/await import\(\s*'(\.\/src\/[^']+)'\s*\)/g)].map((m) => m[1])),
];

/** Dynamically imported start steps this file runs. */
const RUN = [
  './src/lib/skills/startup-reconcile',
  './src/lib/cli-tools/session-namespace',
  './src/lib/session/worktree-session-reconcile',
  './src/lib/session/adopt-legacy-sessions',
  './src/lib/verification/verification-reconciler',
  './src/lib/push/vapid',
  './src/lib/hooks/sources/opencode-v2/reattach',
  './src/lib/hooks/sources/opencode/reattach',
  './src/lib/tmux/read-mode',
];

/** Dynamically imported modules not run here, and why. */
const NOT_RUN: Record<string, string> = {
  './src/lib/server/localhost-self-check':
    'connects to the listening server over HTTP; no server is started in a unit test',
};

let fake: FakeAgyPath;
let db: Database.Database;
let worktree: Worktree;

beforeEach(() => {
  fake = installFakeAgyPath({
    extraBinaries: {
      tmux: [
        'case "$1" in',
        // name, windows, attached, path (the `-F` the tmux module asks for);
        // legacy (un-namespaced) names, which the adopt step takes over.
        `  list-sessions) printf 'mcbd-antigravity-${WT}\\t1\\t0\\t%s\\nmcbd-claude-${WT}\\t1\\t0\\t%s\\n' "\${0%/bin/tmux}/repo/wt" "\${0%/bin/tmux}/repo/wt" ;;`,
        '  has-session) exit 0 ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    },
  });
  resetAntigravityUseForTest();
  const home = path.join(fake.root, 'home');
  fs.mkdirSync(path.join(home, '.commandmate', 'data'), { recursive: true });
  vi.stubEnv('CM_DB_PATH', path.join(home, '.commandmate', 'data', 'cm.db'));

  db = new Database(':memory:');
  runMigrations(db);
  setMockDb(db);
  const wtPath = path.join(fake.root, 'repo', 'wt');
  fs.mkdirSync(wtPath, { recursive: true });
  worktree = {
    id: WT,
    name: 'Startup 4480',
    path: wtPath,
    repositoryPath: path.join(fake.root, 'repo'),
    repositoryName: 'repo',
    cliToolId: 'antigravity',
  };
  upsertWorktree(db, worktree);
  setAgentInstances(db, WT, [
    { id: 'antigravity', cliTool: 'antigravity', alias: 'Antigravity', order: 0 },
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 1 },
  ]);
});

afterEach(() => {
  stopAllSchedules();
  stopAllTimers();
  stopResourceCleanup();
  setMockDb(null);
  db.close();
  resetAntigravityUseForTest();
  vi.unstubAllEnvs();
  fake.restore();
});

/** server.ts's start sequence, in its order, each step fail-open as there. */
async function runStartSequence(): Promise<{ ran: string[]; results: Record<string, unknown> }> {
  const ran: string[] = [];
  const results: Record<string, unknown> = {};
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try {
      results[name] = await fn();
    } catch (error) {
      // server.ts wraps every step in its own try/catch
      results[name] = error;
    }
    ran.push(name);
  };

  await step('restoreAutoYesShutdownRecord', () => restoreAutoYesShutdownRecord());
  await step('runDotenvSelfCheck', () => runDotenvSelfCheck({ warn: () => {} }));
  await step('runVapidSelfCheck', async () =>
    (await import('@/lib/push/vapid')).runVapidSelfCheck({ warn: () => {} }));
  // initializeWorktrees()
  await step('runSkillStartupReconciliation', async () =>
    (await import('@/lib/skills/startup-reconcile')).runSkillStartupReconciliation(db));
  await step('initSessionNamespace', async () =>
    (await import('@/lib/cli-tools/session-namespace')).initSessionNamespace(db));
  await step('reconcileWorktreeSessionsFromAliases', async () =>
    (await import('@/lib/session/worktree-session-reconcile')).reconcileWorktreeSessionsFromAliases(db));
  await step('adoptLegacySessions', async () =>
    (await import('@/lib/session/adopt-legacy-sessions')).adoptLegacySessions(db));
  await step('reconcileOrphanVerificationRuns', async () =>
    (await import('@/lib/verification/verification-reconciler')).reconcileOrphanVerificationRuns(db));
  await step('syncWorktreesAndCleanup', () => syncWorktreesAndCleanup(db, [worktree]));
  // after initializeWorktrees()
  await step('reattachOpencodeV2EventStreams', async () =>
    (await import('@/lib/hooks/sources/opencode-v2/reattach')).reattachOpencodeV2EventStreams());
  await step('reattachOpencodeEventStreams', async () =>
    (await import('@/lib/hooks/sources/opencode/reattach')).reattachOpencodeEventStreams());
  await step('initReadMode', async () => (await import('@/lib/tmux/read-mode')).initReadMode());
  await step('initScheduleManager', () => initScheduleManager());
  await step('initTimerManager', () => initTimerManager());
  await step('initResourceCleanup', () => initResourceCleanup());

  await settleBackgroundProbes();
  return { ran, results };
}

describe('[#4480] server start sequence', () => {
  it('4480 (I5): running server.ts\'s start sequence (namespace, alias reconcile, legacy adopt, verification reconcile, skills, worktree sync, opencode reattach, read mode, schedule/timer/cleanup) starts agy 0 times', async () => {
    const { ran, results } = await runStartSequence();

    expect(ran).toHaveLength(15);
    expect(Object.values(results).filter((value) => value instanceof Error)).toEqual([]);
    // The sequence reached tmux (the fake) and took over the live antigravity
    // session: the steps ran against one, not against an empty machine.
    expect(fake.callsOf('tmux').length).toBeGreaterThan(0);
    expect(results.adoptLegacySessions).toMatchObject({
      adopted: expect.arrayContaining([
        expect.objectContaining({ worktreeId: WT, legacyName: `mcbd-antigravity-${WT}` }),
      ]),
    });
    expect(fake.callsOf('agy')).toEqual([]);
    expect(hasAntigravityBeenUsed()).toBe(false);
  });

  it('4480 (I5): the start sequence runs no --version of claude or codex either', async () => {
    await runStartSequence();

    expect(fake.callsOf('claude')).toEqual([]);
    expect(fake.callsOf('codex')).toEqual([]);
  });

  it('4480: every start step server.ts loads with await import() is either run here or listed with a reason', () => {
    expect(DYNAMIC_START_MODULES.length).toBeGreaterThan(5);
    const accounted = new Set([...RUN, ...Object.keys(NOT_RUN)]);
    for (const specifier of DYNAMIC_START_MODULES) {
      expect(accounted.has(specifier), `${specifier} is neither run nor listed`).toBe(true);
    }
    // And nothing listed here is gone from server.ts.
    for (const specifier of accounted) {
      expect(DYNAMIC_START_MODULES, specifier).toContain(specifier);
    }
  });
});

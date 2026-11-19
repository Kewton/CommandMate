/**
 * Issue #4480 (review-4452-3 P3-1): running server.ts's start sequence starts
 * `agy` 0 times.
 *
 * `agy-startup-4452.test.ts` loads the modules server.ts loads and calls the first
 * requests' functions, but never ran the start sequence itself: that it runs no
 * version probe rested on a static reading. This file runs the steps, in
 * server.ts's order, on the real modules:
 *
 *  - an in-memory DB (migrated, tmux namespace `abcd1234`) holding one worktree
 *    whose roster is antigravity + claude, and an alias row from its old ID;
 *  - a private `PATH` with the fake agy / claude / codex and a fake `tmux`.
 *    `list-sessions` answers the lines of `<sandbox>/sessions.txt` (written per
 *    case); `list-commands display-popup` answers a line, so read mode goes on to
 *    write its script and bind its key. The real tmux is not on `PATH`, so no
 *    real session or option is touched;
 *  - a private `HOME` (the install is treated as global) and `CM_DB_PATH` under the
 *    sandbox: the read-mode script, the Skill journal and the Auto-Yes shutdown
 *    record land there, if anywhere — not in the repository's working directory.
 *
 * {@link START_STEPS} is the start sequence as a table: every call server.ts
 * makes there (read off its source by tests/helpers/server-start-calls.ts, static
 * and dynamic imports alike), in order, each either run here or listed with the
 * reason it is not. The drift case fails when server.ts adds, drops or reorders
 * a call (review-4480 codex P2-2 / opus P3-1).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { installFakeAgyPath, settleBackgroundProbes, type FakeAgyPath } from '@tests/helpers/fake-agy-path';
import { serverStartCalls } from '@tests/helpers/server-start-calls';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { setTmuxSessionNamespace } from '@/lib/db/app-settings-db';
import { recordWorktreeAlias } from '@/lib/db/worktree-alias-db';
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

import { getDbInstance, setMockDb } from '@/lib/db/db-instance';
import { resetSessionNamespaceForTests } from '@/lib/cli-tools/session-namespace';
import { hasAntigravityBeenUsed, resetAntigravityUseForTest } from '@/lib/tool-policy/version-probe-gate';
import { restoreAutoYesShutdownRecord } from '@/lib/auto-yes-shutdown-record';
import { runDotenvSelfCheck } from '@/lib/env';
import { getAllRepositories, registerAndFilterRepositories } from '@/lib/db/db-repository';
import { getRepositoryPaths, reclaimGhostRepositories } from '@/lib/git/worktrees';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';
import { initScheduleManager, stopAllSchedules } from '@/lib/schedule-manager';
import { initTimerManager, stopAllTimers } from '@/lib/timer-manager';
import { initResourceCleanup, stopResourceCleanup } from '@/lib/resource-cleanup';

const WT = 'wt-4480-startup';
const OLD_WT = 'wt-4480-startup-old';
const NAMESPACE = 'abcd1234';

const SERVER_SOURCE = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');

interface StartContext {
  db: Database.Database;
  worktree: Worktree;
}

/**
 * One call of server.ts's start sequence. `run` runs it here; `notRun` says why
 * it is not. `notAwaited`: server.ts starts it inside `void (async () => …)()`
 * and goes on; the drift check compares the order calls START in, and this file
 * awaits each in turn (so a later step never races an earlier one here).
 */
interface StartStep {
  call: string;
  run?: (ctx: StartContext) => unknown;
  notRun?: string;
  notAwaited?: true;
}

const START_STEPS: readonly StartStep[] = [
  { call: 'stampIngress', notRun: 'stamps one request\'s headers (request handler); no request is served' },
  { call: 'stampIngress', notRun: 'stamps a WebSocket upgrade\'s headers; no listener is started' },
  { call: 'stampIngress', notRun: 'stamps a WebSocket upgrade\'s headers; no listener is started' },
  { call: 'setupWebSocket', notRun: 'attaches a WebSocket server to the HTTP listener; no listener is started' },
  { call: 'restoreAutoYesShutdownRecord', run: () => restoreAutoYesShutdownRecord() },
  { call: 'remoteServer.listen', notRun: 'opens a port; no server is started in a unit test' },
  { call: 'server.listen', notRun: 'opens a port; no server is started in a unit test' },
  { call: 'selfCheck.clearLocalhostConflict', notRun: 'assigned as the shutdown cleanup, not called at start' },
  {
    call: 'selfCheck.runLocalhostSelfCheck',
    notRun: 'connects to the listening server over HTTP; no server is started',
    notAwaited: true,
  },
  { call: 'runDotenvSelfCheck', run: () => runDotenvSelfCheck({ warn: () => {} }) },
  {
    call: 'runVapidSelfCheck',
    run: async () => (await import('@/lib/push/vapid')).runVapidSelfCheck({ warn: () => {} }),
    notAwaited: true,
  },
  // initializeWorktrees()
  { call: 'getDbInstance', run: () => getDbInstance() },
  { call: 'runMigrations', notRun: 'run in beforeEach on the in-memory DB before the fixture rows are written' },
  {
    call: 'runSkillStartupReconciliation',
    run: async ({ db }) => (await import('@/lib/skills/startup-reconcile')).runSkillStartupReconciliation(db),
  },
  {
    call: 'initSessionNamespace',
    run: async ({ db }) => (await import('@/lib/cli-tools/session-namespace')).initSessionNamespace(db),
  },
  {
    call: 'reconcileWorktreeSessionsFromAliases',
    run: async ({ db }) =>
      (await import('@/lib/session/worktree-session-reconcile')).reconcileWorktreeSessionsFromAliases(db),
  },
  {
    call: 'adoptLegacySessions',
    run: async ({ db }) => (await import('@/lib/session/adopt-legacy-sessions')).adoptLegacySessions(db),
  },
  {
    call: 'reconcileOrphanVerificationRuns',
    run: async ({ db }) =>
      (await import('@/lib/verification/verification-reconciler')).reconcileOrphanVerificationRuns(db),
  },
  { call: 'getRepositoryPaths', run: () => getRepositoryPaths() },
  // The repository list is empty here: the fixture's worktree is handed to the
  // sync as the scan's result (see scanMultipleRepositories).
  { call: 'reclaimGhostRepositories', run: ({ db }) => reclaimGhostRepositories(db, []) },
  { call: 'getAllRepositories', run: ({ db }) => getAllRepositories(db) },
  { call: 'registerAndFilterRepositories', run: ({ db }) => registerAndFilterRepositories(db, []) },
  {
    call: 'scanMultipleRepositories',
    notRun: 'runs git over the configured repositories on disk; the fixture worktree stands for its result',
  },
  { call: 'syncWorktreesAndCleanup', run: ({ db, worktree }) => syncWorktreesAndCleanup(db, [worktree]) },
  // after initializeWorktrees()
  {
    call: 'reattachOpencodeV2EventStreams',
    run: async () => (await import('@/lib/hooks/sources/opencode-v2/reattach')).reattachOpencodeV2EventStreams(),
    notAwaited: true,
  },
  {
    call: 'reattachOpencodeEventStreams',
    run: async () => (await import('@/lib/hooks/sources/opencode/reattach')).reattachOpencodeEventStreams(),
    notAwaited: true,
  },
  { call: 'initReadMode', run: async () => (await import('@/lib/tmux/read-mode')).initReadMode() },
  { call: 'initScheduleManager', run: () => initScheduleManager() },
  { call: 'initTimerManager', run: () => initTimerManager() },
  { call: 'initResourceCleanup', run: () => initResourceCleanup() },
];

let fake: FakeAgyPath;
let db: Database.Database;
let worktree: Worktree;

function writeSessions(names: string[]): void {
  fs.writeFileSync(
    path.join(fake.root, 'sessions.txt'),
    names.map((name) => `${name}\t1\t0\t${worktree.path}\n`).join(''),
  );
}

beforeEach(() => {
  fake = installFakeAgyPath({
    extraBinaries: {
      tmux: [
        'root="${0%/bin/tmux}"',
        'case "$1" in',
        // name, windows, attached, path (the `-F` the tmux module asks for)
        '  list-sessions) [ -f "$root/sessions.txt" ] && while IFS= read -r line; do printf \'%s\\n\' "$line"; done < "$root/sessions.txt" ;;',
        '  list-commands) [ "$2" = display-popup ] && echo "display-popup (popup) [-B] [-C] [-E] [-c target-client]" ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    },
  });
  resetAntigravityUseForTest();
  resetSessionNamespaceForTests();
  const home = path.join(fake.root, 'home');
  fs.mkdirSync(path.join(home, '.commandmate', 'data'), { recursive: true });
  vi.stubEnv('CM_DB_PATH', path.join(home, '.commandmate', 'data', 'cm.db'));
  vi.stubEnv('CM_READ_MODE', 'on');

  db = new Database(':memory:');
  runMigrations(db);
  setMockDb(db);
  setTmuxSessionNamespace(db, NAMESPACE);
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
  recordWorktreeAlias(db, OLD_WT, WT);
});

afterEach(() => {
  stopAllSchedules();
  stopAllTimers();
  stopResourceCleanup();
  setMockDb(null);
  db.close();
  resetAntigravityUseForTest();
  resetSessionNamespaceForTests();
  vi.unstubAllEnvs();
  fake.restore();
});

/** The runnable steps of {@link START_STEPS}, in order, each fail-open as in server.ts. */
async function runStartSequence(): Promise<{ ran: string[]; results: Record<string, unknown> }> {
  const ran: string[] = [];
  const results: Record<string, unknown> = {};
  for (const step of START_STEPS) {
    if (!step.run) continue;
    try {
      results[step.call] = await step.run({ db, worktree });
    } catch (error) {
      // server.ts wraps every step in its own try/catch
      results[step.call] = error;
    }
    ran.push(step.call);
  }
  await settleBackgroundProbes();
  return { ran, results };
}

function mutate(source: string, from: string, to: string): string {
  expect(source.split(from), `"${from}" must occur once in server.ts`).toHaveLength(2);
  return source.replace(from, to);
}

describe('[#4480] server start sequence', () => {
  it('4480 (I5): running server.ts\'s start sequence (namespace, alias reconcile, legacy adopt, verification reconcile, skills, worktree sync, opencode reattach, read mode, schedule/timer/cleanup) starts agy 0 times', async () => {
    writeSessions([`mcbd-antigravity-${WT}`, `mcbd-claude-${WT}`]);

    const { ran, results } = await runStartSequence();

    expect(ran).toEqual(START_STEPS.filter((step) => step.run).map((step) => step.call));
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

  it('4480 (I5): the alias reconcile renames a live antigravity session from the old ID (through the fake tmux) and agy still runs 0 times', async () => {
    const oldName = `mcbd-${NAMESPACE}-antigravity-${OLD_WT}`;
    writeSessions([oldName]);

    const { results } = await runStartSequence();

    expect(results.reconcileWorktreeSessionsFromAliases).toMatchObject({
      renamedSessions: expect.arrayContaining([expect.anything()]),
    });
    const renames = fake.callsOf('tmux').filter((line) => line.startsWith('tmux rename-session'));
    expect(renames.some((line) => line.includes(oldName))).toBe(true);
    expect(renames.some((line) => line.includes(`mcbd-${NAMESPACE}-antigravity-${WT}`))).toBe(true);
    expect(fake.callsOf('agy')).toEqual([]);
    expect(hasAntigravityBeenUsed()).toBe(false);
  });

  it('4480 (I5): read mode writes its script under the private HOME and binds its key on the fake tmux, and agy still runs 0 times', async () => {
    writeSessions([]);

    const { results } = await runStartSequence();

    expect(results.initReadMode).toMatchObject({ installed: true });
    const scriptPath = (results.initReadMode as { scriptPath: string }).scriptPath;
    expect(scriptPath.startsWith(path.join(fake.root, 'home'))).toBe(true);
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fake.callsOf('tmux').some((line) => line.startsWith('tmux bind-key'))).toBe(true);
    expect(fake.callsOf('agy')).toEqual([]);
  });

  it('4480 (I5): the start sequence runs no --version of claude or codex either', async () => {
    writeSessions([`mcbd-antigravity-${WT}`, `mcbd-claude-${WT}`]);

    await runStartSequence();

    expect(fake.callsOf('claude')).toEqual([]);
    expect(fake.callsOf('codex')).toEqual([]);
  });

  it('4480: every call server.ts makes at start is in the table, in order, run here or listed with a reason', () => {
    for (const step of START_STEPS) {
      expect(Boolean(step.run) !== Boolean(step.notRun), `${step.call}: run xor notRun`).toBe(true);
    }
    expect(serverStartCalls(SERVER_SOURCE)).toEqual(START_STEPS.map((step) => step.call));
  });

  it('4480: the table check turns red when server.ts adds, drops or reorders a start call (server.ts is not changed; its text is)', () => {
    const table = START_STEPS.map((step) => step.call);
    const adoptLine = '        const adoptReport = await adoptLegacySessions(db);';
    const timerLine = '    initTimerManager();';
    const scheduleLine = '    initScheduleManager();';

    const added = mutate(SERVER_SOURCE, adoptLine, `${adoptLine}\n        await adoptLegacySessions(db);`);
    const dropped = mutate(SERVER_SOURCE, timerLine, '');
    const swapped = mutate(
      mutate(SERVER_SOURCE, scheduleLine, '    __SWAP__();'),
      timerLine,
      scheduleLine,
    ).replace('    __SWAP__();', timerLine);
    // A new step through a static import (the shape review-4480 opus P3-1 names).
    const staticStep = mutate(
      mutate(
        SERVER_SOURCE,
        "import { syncWorktreesAndCleanup } from './src/lib/session-cleanup';",
        "import { syncWorktreesAndCleanup } from './src/lib/session-cleanup';\nimport { getAgentVersions } from './src/lib/updates/agent-versions';",
      ),
      timerLine,
      `${timerLine}\n    void getAgentVersions();`,
    );

    expect(serverStartCalls(SERVER_SOURCE)).toEqual(table);
    for (const [name, source] of Object.entries({ added, dropped, swapped, staticStep })) {
      expect(serverStartCalls(source), name).not.toEqual(table);
    }
  });
});

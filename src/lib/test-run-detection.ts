/**
 * Is this process a test run? The one rule, for everything that must behave
 * differently under test (Issue #4097; the rule itself is from #4086).
 *
 * It lives apart from the database on purpose: `db-instance` imports
 * `agent-session-cost-sampler`, and `session-generation-archive` is reached by
 * suites that mock `db-instance` down to a single export. This module imports
 * nothing, so all three can read it without changing either graph.
 *
 * A test that needs a production branch mocks {@link isUnderTest}. Clearing
 * `VITEST` does nothing here, and there is no flag that switches the guards off
 * in production.
 *
 * @module lib/test-run-detection
 */

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Is this code running inside a Vitest worker?
 *
 * Read off the worker state Vitest itself installs on `globalThis` (its
 * `getWorkerState()` reads the same `__vitest_worker__` global, in the forks
 * and threads pools alike), not off environment variables: the environment is
 * both inherited and editable. A test may swap `NODE_ENV` to `production`
 * mid-run (tests/unit/pwa/ServiceWorkerRegistrar.test.tsx does) and must stay
 * guarded, while a child process started outside Vitest inherits `VITEST` and
 * must not be taken for a test run.
 */
export function isInsideVitestWorker(): boolean {
  const state = (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__;
  return typeof state === 'object' && state !== null;
}

/**
 * Is this a test run?
 *
 * Inside a Vitest worker: always, whatever `NODE_ENV` says right now.
 * Outside one: only with `NODE_ENV=test` (a test's own child process, which
 * also inherits the per-process CM_DB_PATH). `VITEST` alone never counts —
 * the daemon spreads `process.env` into the server it starts
 * (src/cli/utils/daemon.ts buildChildEnv), so a `NODE_ENV=production` server
 * started from a shell where `VITEST` was left behind is a real server.
 *
 * @param env - defaults to `process.env`
 * @param inVitestWorker - defaults to {@link isInsideVitestWorker}; a test
 *   passes `false` to ask how a process outside Vitest would be judged
 */
export function isUnderTest(
  env: EnvLike = process.env,
  inVitestWorker: boolean = isInsideVitestWorker()
): boolean {
  if (inVitestWorker) return true;
  return (env.NODE_ENV ?? '').trim() === 'test';
}

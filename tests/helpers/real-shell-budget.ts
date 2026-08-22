/**
 * Issue #1950 — time budgets for unit tests that start a REAL subprocess.
 *
 * ## What was actually wrong
 *
 * 69 files under `tests/unit` run a real shell (`spawnSync` / `execFileSync` /
 * `execSync` / `/bin/sh`) inside `it()`. They are integration tests of shell
 * scripts wearing a unit test's clothes, and they were being judged by vitest's
 * DEFAULT per-test budget of 5000ms — a number chosen for pure functions.
 *
 * Measured on the development machine (28 cores) while the family ran under
 * deliberate process-creation pressure, which is what `/orchestrate` produces
 * (2-4 parallel agent sessions + a second worktree's verify + monitor polling):
 *
 *     p50 9ms   p90 1552ms   p99 4525ms   p99.9 16456ms   max 97856ms
 *
 * The default budget sat *at this family's p99*. That is the whole defect: the
 * gate was not measuring whether the code works, it was sampling the machine's
 * scheduler. 16 of 1829 tests crossed 5000ms in a single loaded run.
 *
 * ## The two symptoms were ONE cause
 *
 * Issue #1950 asked whether `Test timed out in 5000ms` and `status: 141` were
 * separate faults. Measured: they are the same fault seen from two sides.
 *
 * `141` is `128 + 13` (SIGPIPE), and it is what a `spawnSync({ timeout })` trip
 * looks like when the child traps signals. Node's `spawnSync` timeout sends
 * SIGTERM *and closes the child's stdio pipes in the same step*; monitor.sh
 * traps TERM and writes its diagnostic to a stderr that is already closed, gets
 * SIGPIPE, and its PIPE trap exits `128+13`. Reproduced deterministically:
 *
 *     spawnSync('bash', [MONITOR, ...], { timeout: 1500 })
 *     -> { status: 141, signal: null, error: { code: 'ETIMEDOUT' }, stderr: '' }
 *
 * The empty stderr is why earlier reports described "the real shell's output is
 * empty". Nothing asserted on `error`, so a timeout was reported as an
 * assertion diff about the number 141 — see `assertSubprocessCompleted`.
 *
 * ## Why the budget, and not serialization
 *
 * Serializing the family was measured before being rejected:
 *
 *     full `npm run test:unit`, unchanged .................  66s
 *     the 69 family files, file-parallel ..................  49s
 *     the 69 family files, `--no-file-parallelism` ........ 201s
 *
 * Serializing makes the verdict gate at least 3x slower, which breaks
 * `/orchestrate` in a different way. It also cannot work: the pressure comes
 * from OTHER processes on the machine, which this suite does not schedule.
 *
 * ## The shape of the fix
 *
 * A hang must still fail, and fail for a stated reason. So the guard is the
 * subprocess call's own `timeout` — deterministic, per command, and it names
 * itself — and the vitest budget is set ABOVE it so the guard is the thing that
 * fires. Before this Issue the ordering was inverted: the 5s wall-clock budget
 * pre-empted every 15s guard, so the guards were unreachable code.
 *
 * The project had already been discovering this one file at a time, after each
 * flake: `env-scripts` carries `60_000`, `compose` `300_000`, `no-home-leftovers`
 * `180_000`. Every file observed failing in #1950 was one that had NOT yet been
 * patched by hand and so still ran on the 5s default. This replaces that
 * whack-a-mole with one budget the whole family inherits.
 */

/**
 * What makes a test file a member of the family: it names a synchronous
 * subprocess starter, or the shell it starts.
 *
 * Deliberately the same expression the Issue used to count the family, so the
 * set this code acts on and the set the Issue measured cannot drift apart.
 *
 * Deliberately over-inclusive, too. A file that only *mentions* `spawnSync` in
 * a comment, or that mocks `node:child_process` and never starts anything, also
 * matches. That error is the safe one: the budget only has an effect on a test
 * that is already slow or already hanging, so a false member costs nothing,
 * while a false NON-member is exactly the flake this Issue is about.
 */
export const REAL_SHELL_MARKERS = /execFileSync|spawnSync|execSync|\/bin\/sh/;

/** True when `source` is a test that starts a real subprocess. */
export function startsRealSubprocess(source: string): boolean {
  return REAL_SHELL_MARKERS.test(source);
}

/**
 * The hang guard: the `timeout` a family subprocess call should carry.
 *
 * Sized from measurement, not taste. The family's p99.9 under deliberate load
 * was 16.5s, so 30s is a ~1.8x margin over the worst run actually observed,
 * while still being two orders of magnitude below "forever". A command that
 * exceeds it has hung, and `assertSubprocessCompleted` says so by name.
 */
export const REAL_SHELL_SUBPROCESS_TIMEOUT_MS = 30_000;

/**
 * The vitest per-test budget for the family.
 *
 * MUST stay strictly greater than REAL_SHELL_SUBPROCESS_TIMEOUT_MS, otherwise
 * the guard above becomes unreachable again and this Issue returns. The margin
 * is 3x rather than epsilon because a single `it()` may make more than one
 * guarded call in sequence. `tests/unit/tests-infra/real-shell-budget.test.ts`
 * pins the ordering.
 */
export const REAL_SHELL_TEST_TIMEOUT_MS = 90_000;

/** The subset of `spawnSync`'s result this module needs to judge a run. */
export interface SubprocessOutcome {
  error?: Error;
  status?: number | null;
  signal?: NodeJS.Signals | null;
}

/**
 * Fail with the real reason when a guarded subprocess did not finish.
 *
 * `spawnSync` reports a tripped `timeout` on `result.error` (`ETIMEDOUT`) and
 * leaves `status` holding whatever the dying child managed to return — 141 for
 * a script that traps SIGPIPE, `null` for one that does not. Asserting on
 * `status` alone therefore turns "this hung" into an unrelated-looking
 * assertion diff, which is what cost Issue #1950 four re-verifications.
 *
 * Call this BEFORE asserting on `status`, so the hang speaks first.
 */
export function assertSubprocessCompleted(outcome: SubprocessOutcome, label: string): void {
  const error = outcome.error as NodeJS.ErrnoException | undefined;
  if (!error) return;
  if (error.code === 'ETIMEDOUT') {
    throw new Error(
      `${label} did not finish within its ${REAL_SHELL_SUBPROCESS_TIMEOUT_MS}ms guard ` +
        `(status=${String(outcome.status)}, signal=${String(outcome.signal)}). ` +
        'This is a hang or a machine under load, NOT a disagreement about the exit code: ' +
        'node kills the child and closes its stdio in the same step, so a script that traps ' +
        'SIGPIPE reports 141 and an empty stderr. See tests/helpers/real-shell-budget.ts.',
    );
  }
  throw new Error(`${label} could not be started: ${error.code ?? error.message}`);
}

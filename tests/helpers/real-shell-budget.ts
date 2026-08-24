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
 * ---------------------------------------------------------------------------
 * ISSUE #1985 — how many full `npm run test:unit` runs these numbers cover
 * ---------------------------------------------------------------------------
 *
 * #1950 sized the guard below from "the family's p99.9 under load = 16.5s", and
 * never wrote down what "under load" was. It was ONE full `npm run test:unit`
 * plus deliberate process-creation pressure. #1977 then ran two full suites at
 * once on the same machine and collected 44 tripped guards, which read as a
 * defect in the guard and was not one: the guard fired exactly as designed, on
 * a condition nobody had claimed it covered.
 *
 * A budget is only a budget once the condition it holds under is stated, so the
 * condition is stated here, the measurement is per-concurrency, and
 * `scripts/measure-real-shell-budget.mjs` recomputes it from vitest JSON so the
 * next person does not have to take this comment's word for it.
 *
 * ## The declaration
 *
 * `REAL_SHELL_CONCURRENT_FULL_RUNS` full `npm run test:unit` runs, machine-wide.
 *
 * That number is not a preference, it is the ceiling the existing machinery
 * already implies. `.commandmate/verify.yaml` gives `unit` and `integration`
 * `mutex: cpu.heavy` (#1917 / #1994), so however many worktrees are verifying,
 * AT MOST ONE of them is inside `npm run test:unit` at a time. The second run is
 * the one a person types by hand. Two is therefore what the machine is built to
 * carry; a third is something nobody's design predicted.
 *
 * ## Why this is a rule and not a mechanism (#1985 asked which)
 *
 * The lock is taken in exactly one place — `gate-runner.ts`
 * (`acquireMachineLock(mutex, { timeoutMs: gate.timeoutSec * 1000 })`); nothing
 * else in the repository calls it. A hand-typed `npm run test:unit` (npm script:
 * `NODE_ENV=test vitest run tests/unit`) therefore cannot be serialized by it,
 * which is what #1985 says and what grepping the call sites confirms.
 *
 * Making the suite take that lock itself was considered and rejected on the
 * mechanism, not on effort. `vitest`'s once-per-run hook is `globalSetup`, and a
 * lock taken there would be taken a SECOND time by the very gate that already
 * holds `cpu.heavy` while running this command — the `unit` gate would wait for
 * itself. Nothing in the lock's contract (docs/design/verification-config.md
 * 9.2) is re-entrant, so the mechanism version is not a line of config; it is a
 * re-entrancy protocol whose failure mode is a deadlock in the gate that decides
 * whether a worker is finished. And a waiter that does time out does not fail —
 * it SKIPs with `reason=mutex-wait`, which is exit 99, "no verdict" (9.4). The
 * cost of the rule is that it can be broken; the cost of the mechanism is that
 * breaking it stops being visible. So: rule, plus a guard sized to survive the
 * rule being broken once — see the sizing below.
 *
 * The third option #1985 lists, "detect concurrency and relax the guard", is
 * refused outright. It makes the verdict a function of what else happened to be
 * running, which is the precise property #1917 named as disqualifying: an exit
 * code that flips with load is not a verdict.
 *
 * ## The measurement (28 cores / node 24.1.0 / vitest 4.1.2, 2026-08-24)
 *
 * One observed checkout plus N-1 load generators (standalone checkouts of the
 * same commit, seeded with `git archive HEAD`), all started together, all
 * running the full `tests/unit`. Guards were raised to 240s/600s FOR THE
 * MEASUREMENT ONLY, because a guard that kills a call censors the tail it is
 * supposed to be sized from. `ps -eo pid,command | grep vitest` was clean before
 * each condition. The machine also carried its normal orchestration load
 * throughout (load average 36-45 before the first run started), which is the
 * point: N counts full suites, not everything on the box.
 *
 * Population: the family MINUS the tests that declare their own `it()` timeout,
 * because those do not inherit these constants (`verify-run.test.ts` states
 * 180_000 and took 60s / 108s / 152s / 196s across the four conditions). At
 * every N the slowest remaining test was in a file that passes
 * REAL_SHELL_SUBPROCESS_TIMEOUT_MS to a real call, so `max` below is a duration
 * this guard actually judges.
 *
 *     N   samples   p99.9      max     peak load   observed run
 *     1      1864    6.03s    7.62s        57.3    green
 *     2      3728    9.85s   11.90s        90.0    green
 *     3      5592   14.36s   25.87s       147.7    green
 *     4      7456   20.06s   29.94s       163.8    RED
 *
 * An independent N=2 pair measured 40 minutes earlier (peak load 101.9) put
 * p99.9 at 11.14s and the max at 13.37s — 12% above the N=2 row, which is the
 * run-to-run spread of the same condition and is used below.
 *
 * ## What the measurement says that #1985's premise did not
 *
 * At the declared N=2, the OLD 30s guard was never close to tripping here:
 * 30000/11899 = 2.52x, comfortably above the 1.8x #1950 claimed. Two full runs
 * at once did not reproduce #1977 on this machine. What does reproduce it is a
 * third run: at N=3 the margin collapses to 30000/25873 = 1.16x, and at N=4 the
 * guard sits ON the slowest observed call (1.00x) — the exact shape #1950
 * diagnosed for vitest's 5000ms default.
 *
 * So the honest reading is not "30s is too small for two runs". It is "30s has
 * no margin left the moment the rule above is broken", and the rule is a rule.
 *
 * ## Why N+1 rather than N
 *
 * Because the answer to "rule or mechanism" was "rule". An unenforced rule gets
 * exceeded — #1977 is the recorded instance — and when it is, the failure lands
 * on whichever diff was unlucky. Sizing at the declared N would make the first
 * violation produce a verdict about the machine; sizing at N+1 makes it produce
 * a verdict about the diff, which is the only thing a gate is for. Beyond N+1
 * the guard stops being the binding constraint anyway: at N=4 all four runs went
 * red, and none of the failures were guard trips (`verify-run.test.ts` blew its
 * own 180s budget at 195.5s, a temp-dir sandbox lost a race, and the live tmux
 * test collided with its own siblings). No guard value fixes those.
 */

/**
 * How many full `npm run test:unit` runs this machine may carry at once.
 *
 * The operational rule, not an observation: `mutex: cpu.heavy` keeps verify's
 * copy alone, so this permits exactly one hand-run suite beside it. Everything
 * below is sized against this number; changing it without re-running
 * `scripts/measure-real-shell-budget.mjs` makes the constants below unsourced.
 */
export const REAL_SHELL_CONCURRENT_FULL_RUNS = 2;

/**
 * The margin the guard keeps over the slowest call actually observed.
 *
 * Inherited from #1950, which sized 30s as "~1.8x the worst run observed". Kept
 * rather than re-chosen so that this Issue changes the CONDITION the margin is
 * evaluated at and not the standard itself — otherwise there would be no way to
 * tell a better-sourced number from a more generous one.
 */
export const REAL_SHELL_GUARD_MARGIN_MIN = 1.8;

/**
 * The concurrency the guard is sized at: the declaration plus one overrun.
 *
 * See the "Why N+1 rather than N" note above. The declaration is enforced by
 * nothing, so the guard absorbs its first violation instead of converting it
 * into a red test somebody has to re-run to disbelieve.
 */
export const REAL_SHELL_SIZING_CONCURRENCY = REAL_SHELL_CONCURRENT_FULL_RUNS + 1;

/** One row of the concurrency sweep the guard is sized from. */
export interface RealShellLoadSample {
  /** Family tests sampled at this concurrency (all runs pooled). */
  readonly samples: number;
  /** Nearest-rank p99.9 of per-test duration — the metric #1950 used. */
  readonly p999Ms: number;
  /** The slowest single test; at every N it was one this guard judges. */
  readonly maxMs: number;
  /** Highest 1-minute load average seen while the runs were in flight. */
  readonly peakLoadAvg: number;
}

/**
 * The sweep, kept in code so the constants below can be checked against it.
 *
 * `tests/unit/guards/real-shell-test-budget.test.ts` recomputes the sizing rule
 * from this table, so a future edit that raises a guard without re-measuring, or
 * re-measures without moving the guard, fails rather than drifts. Reproduce with
 * `scripts/measure-real-shell-budget.mjs`; the full record, including the
 * failures at N=4 and why they are not guard trips, is in
 * `docs/qa/1985-real-shell-budget-concurrency.md`.
 */
export const REAL_SHELL_LOAD_SWEEP: Readonly<Record<number, RealShellLoadSample>> = {
  1: { samples: 1864, p999Ms: 6_025, maxMs: 7_618, peakLoadAvg: 57.3 },
  2: { samples: 3728, p999Ms: 9_854, maxMs: 11_899, peakLoadAvg: 90.0 },
  3: { samples: 5592, p999Ms: 14_358, maxMs: 25_873, peakLoadAvg: 147.7 },
  4: { samples: 7456, p999Ms: 20_060, maxMs: 29_937, peakLoadAvg: 163.8 },
};

/**
 * The hang guard: the `timeout` a family subprocess call should carry.
 *
 * Sized from measurement, not taste, and now from a STATED condition:
 *
 *     floor            = 1.8 x 25.873s (N=3 max)          = 46.6s
 *     50_000 clears it by                                    7.4%
 *     run-to-run spread of one condition (two N=2 pairs)     12.4%
 *     60_000 clears it by                                    28.9%
 *
 * 50s satisfies the rule on paper and loses to the noise of the very sweep that
 * produced the rule, so the number is 60s: the smallest round value whose
 * headroom exceeds the spread the measurement itself showed.
 *
 * What that buys, against the old 30s:
 *
 *     N=2 (declared)   30s -> 2.52x      60s -> 5.04x
 *     N=3 (sized at)   30s -> 1.16x      60s -> 2.32x
 *     N=4              30s -> 1.00x      60s -> 2.00x
 *
 * What it costs is stated plainly: a call that really has hung is now named 30
 * seconds later than before. That is the whole cost — the guard's job is to say
 * WHY a run stopped, and a hang is infinite, so no reachable guard value fails
 * to catch one. A command that exceeds this has hung, and
 * `assertSubprocessCompleted` says so by name.
 */
export const REAL_SHELL_SUBPROCESS_TIMEOUT_MS = 60_000;

/**
 * The vitest per-test budget for the family.
 *
 * MUST stay strictly greater than REAL_SHELL_SUBPROCESS_TIMEOUT_MS, otherwise
 * the guard above becomes unreachable again and this Issue returns. The margin
 * is 3x rather than epsilon because a single `it()` may make more than one
 * guarded call in sequence. `tests/unit/guards/real-shell-test-budget.test.ts`
 * pins the ordering.
 *
 * Issue #1985: moved with the guard, keeping the 3x relation rather than being
 * re-derived, so exactly one number in this file changed for one stated reason.
 * This is the ONLY ceiling the other 57 family files have — 12 of the 75 pass
 * the guard above to a real call, so for the rest a hang is reported here, and
 * three minutes is what that now costs.
 */
export const REAL_SHELL_TEST_TIMEOUT_MS = 180_000;

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

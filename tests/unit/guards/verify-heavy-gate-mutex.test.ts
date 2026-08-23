/**
 * Only one heavy suite runs on this machine at a time (Issue #1917 / #1994).
 *
 * ## What happened
 *
 * During a `/orchestrate` session, two workers' `wait --verify` reached
 * `npm run test:unit` at the same time. One of them came back **exit 20** on a
 * single failure — `monitor-exit-codes.test.ts`, which spawns a subprocess and
 * asserts on its exit code — in a worktree whose diff touched neither that test
 * nor anything it tests. Re-run alone: 16/16 pass. The durations tell the same
 * story: 486s and 553s alone (both green), 640s overlapped (red).
 *
 * `/orchestrate` decides a worker is finished from that exit code. A verdict
 * that flips on how busy the laptop is, is not a verdict, and the second-order
 * damage is worse than the first: once an operator learns that exit 20 might
 * just be load, real failures stop being believed too.
 *
 * ## Why a test rather than a comment
 *
 * The fix is one line of configuration — `mutex: cpu.heavy` on the gate — and
 * configuration is exactly the kind of line that gets dropped in a merge or
 * "cleaned up" by someone who reads `mutex` as an e2e-only concern. Nothing
 * else in the repository fails when it disappears; verification simply goes
 * back to being non-deterministic under parallel load, which is invisible until
 * an orchestration run misjudges a worker again.
 *
 * The properties asserted here are the whole decision:
 *
 *   1. `unit` and `integration` declare the mutex, and the file still parses
 *      with the *product* loader (a misspelled key is a config error, exit 2,
 *      not a warning — see verification-config.md section 9.5).
 *   2. The name is a **resource**, not a gate id (section 9.2). `cpu.heavy` names
 *      the thing being contended — one heavy-suite slot per machine — so a
 *      different repository's equally heavy suite can join the same slot by
 *      declaring the same name. `unit` would exclude only ourselves.
 *   3. The cheap gates stay parallel. The static guards exist to return a
 *      failure in seconds (Issue #1882); queueing them behind another worktree's
 *      500s `unit` run would delete that property. `lint` / `typecheck` are left
 *      out on measurement — see dev-reports and the comments in verify.yaml.
 *      `route-exports` (Issue #1946, 0.3s over 128 route entries) is held to the
 *      same rule: it exists to fail in under a second.
 *
 * ## What Issue #1994 added, and why the list of mutexed gates grew by one
 *
 * #1994 declared four more gates: `build-cli`, `build-server`, `build` and
 * `integration`. The mutex question was decided per gate on ONE criterion —
 * **does load move the verdict, or only the clock?**
 *
 * Reading the numbers needs one distinction first. The same declaration runs in
 * two different environments:
 *
 *   mode A — the product runner (`wait --verify` / `commandmate verify`).
 *            `gate-runner.ts` injects `CI=true`, so vitest runs SERIALLY
 *            (fileParallelism off, maxConcurrency 1) — the way CI runs it.
 *   mode B — the standalone runner (`.claude/skills/cmate-verify/scripts/
 *            verify-run.sh`). It injects no `CI`, so vitest runs in parallel.
 *
 * Measured on a 28-core machine, 2026-08-23, under three load conditions: solo;
 * "5-worker-equivalent" (one peer worktree in `unit` — i.e. holding `cpu.heavy`
 * — plus three peers cycling the non-mutexed gates, which with the `unit` mutex
 * in place is the worst load a parallel orchestration can actually produce);
 * and "extreme" (four worktrees in a full `test:unit` at once, the shape of the
 * machine before #1917, measured only to bound the timeout budgets).
 *
 *   mode A                    solo             5-worker-equiv    verdicts
 *   build-cli                 0.8-0.9s         0.9-1.2s          6/6 PASS
 *   build-server              1.9s             2.3-2.7s          6/6 PASS
 *   build (warm / cold)       28.4-29.8 / 38.0 33.4-35.1s        7/7 PASS
 *   integration               49.9-50.3s       62.4-66.4s        9/9 PASS
 *
 *   mode B                    solo         5-worker-equiv  extreme
 *   build-cli                 0.8-0.9s     1.1-2.0s        4.4-11.4s   12/12 PASS
 *   build-server              1.9-2.0s     2.8-4.5s        9.6-29.5s   11/11 PASS
 *   build (warm)              29.7-29.9s   57.0-71.8s      152-193s    15/15 PASS
 *   integration               10.2-12.0s   17.3-38.9s      29.0-67.4s  1/11 under load
 *   integration, lock held    —            11.2-13.3s      —           6/6 PASS
 *
 * The three build gates are `tsc` and `next build`: no timers, no subprocess
 * exit codes, no ports. Load can only change how long they take, so the only
 * way it reaches their verdict is by exhausting `timeoutSec` — and the answer
 * to that is a generous budget (1800 against a worst measured 215.4s), not a
 * lock. 57 runs including the extreme condition produced no load-induced red.
 *
 * `integration` is the opposite in mode B: the verdict itself moves. The
 * failures are always the same two files (`auto-yes-persistence.test.ts` /
 * `ws-auth-rejection.test.ts`), always `Test timed out in 5000ms`, always
 * unrelated to the diff (Issue #1985). 5000ms is vitest's own budget, so
 * `timeoutSec` cannot reach it; ten of eleven loaded runs were red, and holding
 * `cpu.heavy` turns that into 6/6 green.
 *
 * **Mode A never went red (9/9).** The mutex is declared anyway, because one
 * line of configuration runs in both runners and a gate whose determinism
 * depends on which runner started it is not a determinate gate — the same
 * position #1917 took for `unit`. The price, measured, is the serialized slot
 * growing from ~550s to ~615s per worker (+12%).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  GATE_MUTEX_PATTERN,
  MAX_GATE_MUTEX_LENGTH,
  loadVerifyConfig,
} from '@/lib/verification/verify-config';
import type { VerifyGate } from '@/lib/verification/verify-config';

/** The lock the heavy suites must hold. Named for the resource, not the gate. */
const HEAVY_MUTEX = 'cpu.heavy';

/**
 * The gates whose verdict — not merely whose clock — moves under parallel load.
 *
 * Declaration order, because that is the order the runner takes the lock in and
 * the order `verify.yaml` reads in.
 */
const HEAVY_GATE_IDS = ['integration', 'unit'];

/**
 * Gates that must never be serialized.
 *
 * The static guards are the #1882 fast-fail path (0.1-0.3s each). `lint` and
 * `typecheck` are here as a recorded decision rather than an accident: measured
 * two-worktree-concurrent they stay green, and a `mutex` would trade a failure
 * mode that has never occurred for one that can — a gate whose lock never frees
 * inside `timeoutSec` reaches `SKIP reason=mutex-wait`, which is exit 99, no
 * verdict at all (section 9.4).
 *
 * [Issue #1994] The three build gates join the list on the same rule and the
 * same kind of evidence: 33 runs, no load-induced red, and a failure mode
 * (`timeoutSec` exhaustion) that a budget fixes and a lock does not.
 */
const MUST_STAY_PARALLEL = [
  'token-discipline',
  'control-chars',
  'claudemd-size',
  'route-exports',
  'build-cli',
  'build-server',
  'build',
  'lint',
  'typecheck',
];

// Loaded through the product loader on purpose: `yaml.parse` would accept keys
// the runners reject, and the failure this file exists to prevent is the runner
// refusing the file, not the YAML being malformed.
const config = loadVerifyConfig(process.cwd());

const gateById = (id: string): VerifyGate => {
  const gate = config?.gates.find((candidate) => candidate.id === id);
  if (!gate) throw new Error(`.commandmate/verify.yaml declares no '${id}' gate`);
  return gate;
};

describe('.commandmate/verify.yaml', () => {
  it('loads with the product loader', () => {
    expect(config).not.toBeNull();
  });

  describe.each(HEAVY_GATE_IDS)('the %s gate', (id) => {
    it(`declares mutex: ${HEAVY_MUTEX}`, () => {
      expect(gateById(id).mutex).toBe(HEAVY_MUTEX);
    });
  });

  describe(`the ${HEAVY_MUTEX} lock`, () => {
    it('has a mutex name the runners accept', () => {
      expect(HEAVY_MUTEX).toMatch(GATE_MUTEX_PATTERN);
      expect(HEAVY_MUTEX.length).toBeLessThanOrEqual(MAX_GATE_MUTEX_LENGTH);
    });

    it('names a resource rather than a gate', () => {
      // Section 9.2: the point of a resource name is that gates in *other*
      // repositories can exclude against it. A name that is also one of our
      // gate ids is a sign the declaration was written about the gate instead.
      const gateIds = (config?.gates ?? []).map((gate) => gate.id);
      expect(gateIds).not.toContain(HEAVY_MUTEX);
    });
  });

  describe('each mutexed gate leaves room for the wait inside its own budget', () => {
    // The gate's timeoutSec is the lock-wait budget as well as the run budget
    // (gate-runner: `acquireMachineLock(mutex, { timeoutMs: timeoutSec * 1000 })`).
    //
    // [Issue #1994] With two gates on the lock, a worker takes it twice per run,
    // so the serialized total for N workers finishing together is
    // N x (slow `unit` 640s + slow `integration` 66s). At the five workers this
    // repository's orchestration runs, that is 5 x 706 = 3530s. The declared
    // budget is 5400 rather than that number: 3600 would have left 2% of slack,
    // and 5400 still covers seven workers (4942s). Overshooting is `SKIP
    // reason=mutex-wait` => exit 99 (no verdict, section 9.4) rather than exit
    // 20, so the cliff does not manufacture a red — it withholds a verdict.
    const WORKERS = 5;
    const SLOW_HEAVY_SUITE_SEC = 640 + 66;

    it.each(HEAVY_GATE_IDS)('%s covers five workers queued on the lock', (id) => {
      expect(gateById(id).timeoutSec).toBeGreaterThanOrEqual(WORKERS * SLOW_HEAVY_SUITE_SEC);
    });
  });

  describe.each(MUST_STAY_PARALLEL)('the %s gate', (id) => {
    it('declares no mutex', () => {
      expect(gateById(id).mutex).toBeUndefined();
    });
  });

  it('serializes exactly the gates whose verdict load can flip', () => {
    // Not "at most two": a third gate joining `cpu.heavy` later is a deliberate
    // act that should come with its own measurement, and a gate quietly
    // acquiring some *other* mutex would serialize verification twice over
    // without anyone deciding to.
    const mutexed = (config?.gates ?? []).filter((gate) => gate.mutex !== undefined);
    expect(mutexed.map((gate) => `${gate.id}:${gate.mutex}`)).toEqual(
      HEAVY_GATE_IDS.map((id) => `${id}:${HEAVY_MUTEX}`)
    );
  });

  it('declares every gate exactly once, in one of the two lists', () => {
    // Keeps the two lists above exhaustive: a gate added to verify.yaml without
    // a mutex decision fails here rather than silently inheriting "no mutex".
    const declared = (config?.gates ?? []).map((gate) => gate.id).sort();
    expect(declared).toEqual([...HEAVY_GATE_IDS, ...MUST_STAY_PARALLEL].sort());
  });
});

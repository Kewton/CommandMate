/**
 * Only one full test suite runs on this machine at a time (Issue #1917).
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
 * The fix is one line of configuration — `mutex: cpu.heavy` on the `unit` gate
 * — and configuration is exactly the kind of line that gets dropped in a merge
 * or "cleaned up" by someone who reads `mutex` as an e2e-only concern. Nothing
 * else in the repository fails when it disappears; verification simply goes
 * back to being non-deterministic under parallel load, which is invisible until
 * an orchestration run misjudges a worker again.
 *
 * The three properties asserted here are the whole decision:
 *
 *   1. `unit` declares the mutex, and the file still parses with the *product*
 *      loader (a misspelled key is a config error, exit 2, not a warning — see
 *      verification-config.md section 9.5).
 *   2. The name is a **resource**, not a gate id (section 9.2). `cpu.heavy` names
 *      the thing being contended — one heavy-suite slot per machine — so a
 *      different repository's equally heavy suite can join the same slot by
 *      declaring the same name. `unit` would exclude only ourselves.
 *   3. The cheap gates stay parallel. The three static guards exist to return a
 *      failure in seconds (Issue #1882); queueing them behind another worktree's
 *      500s `unit` run would delete that property. `lint` / `typecheck` are left
 *      out on measurement — see dev-reports and the comments in verify.yaml.
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

/** The lock the heavy suite must hold. Named for the resource, not the gate. */
const HEAVY_MUTEX = 'cpu.heavy';

/** The gate that actually costs minutes, and the only one that declares it. */
const HEAVY_GATE_ID = 'unit';

/**
 * Gates that must never be serialized.
 *
 * The static guards are the #1882 fast-fail path (0.1s each). `lint` and
 * `typecheck` are here as a recorded decision rather than an accident: measured
 * two-worktree-concurrent they stay green, and a `mutex` would trade a failure
 * mode that has never occurred for one that can — a gate whose lock never frees
 * inside `timeoutSec` reaches `SKIP reason=mutex-wait`, which is exit 99, no
 * verdict at all (section 9.4).
 */
const MUST_STAY_PARALLEL = [
  'token-discipline',
  'control-chars',
  'claudemd-size',
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

  describe(`the ${HEAVY_GATE_ID} gate`, () => {
    it(`declares mutex: ${HEAVY_MUTEX}`, () => {
      expect(gateById(HEAVY_GATE_ID).mutex).toBe(HEAVY_MUTEX);
    });

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

    it('leaves room for the wait inside its own budget', () => {
      // The gate's timeoutSec is the lock-wait budget as well as the run budget
      // (gate-runner: `acquireMachineLock(mutex, { timeoutMs: timeoutSec * 1000 })`).
      // Three workers finishing together means the last one waits for two runs
      // and then makes its own: the budget has to cover 3x a full suite, and a
      // slow one is ~640s.
      expect(gateById(HEAVY_GATE_ID).timeoutSec).toBeGreaterThanOrEqual(3 * 640);
    });
  });

  describe.each(MUST_STAY_PARALLEL)('the %s gate', (id) => {
    it('declares no mutex', () => {
      expect(gateById(id).mutex).toBeUndefined();
    });
  });

  it('serializes exactly one gate', () => {
    // Not "at most one": a second heavy gate joining `cpu.heavy` later is a
    // deliberate act that should come with its own measurement, and a second
    // gate quietly acquiring some *other* mutex would serialize verification
    // twice over without anyone deciding to.
    const mutexed = (config?.gates ?? []).filter((gate) => gate.mutex !== undefined);
    expect(mutexed.map((gate) => `${gate.id}:${gate.mutex}`)).toEqual([
      `${HEAVY_GATE_ID}:${HEAVY_MUTEX}`,
    ]);
  });
});

/**
 * Verification gate execution engine (Issue #1543, Phase 1-3).
 *
 * Runs the gates declared in `.commandmate/verify.yaml` inside a worktree and
 * records every verdict in `verification_runs` / `verification_gate_results`,
 * so "the agent said it was done" and "the work passes the repository's own
 * checks" stop being the same claim.
 *
 * Promoted from the Phase 0 shell runner
 * (`.claude/skills/cmate-verify/scripts/verify-run.sh`), which established the
 * two disciplines this module exists to preserve:
 *
 *   1. The verdict is the process exit code, read directly. Nothing is piped:
 *      `cmd | grep` reports grep's status, so a failing gate reads as a pass.
 *   2. A failing gate does not end the run. All gates execute so one report
 *      lists every problem instead of revealing them one round-trip at a time.
 *
 * Server-only: spawns processes and reads the filesystem.
 *
 * @module lib/verification/gate-runner
 */

import { spawn } from 'child_process';
import { realpathSync } from 'fs';
import type Database from 'better-sqlite3';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  createGateResult,
  createVerificationRun,
  finishGateResult,
  finishVerificationRun,
  getRunningVerificationRun,
  getTask,
  listTasks,
  type Task,
  type VerificationGateSource,
  type VerificationGateTerminalStatus,
  type VerificationRunTerminalStatus,
  type VerificationTrigger,
} from '@/lib/db';
// Past the barrel, as `agent-event-service` does for `getActiveTaskForInstance`:
// this selector exists for the verification runner alone and re-exporting it
// would invite the callers that must keep using `getActiveTask` (Auto-Yes,
// prompt events) to reach for the wider set by accident.
import { getVerifiableTask } from '@/lib/db/tasks-db';
import { resolveDefaultBranchName } from '@/lib/git/git-default-branch';
import { createLogger } from '@/lib/logger';
import {
  contractGateDefinitions,
  resolveContractGateIds,
  resolveRequireCommit,
  type RequireCommitDecision,
} from '@/lib/tasks/contract-message';
import type { TaskEvent } from '@/lib/tasks/task-state-machine';
import { applyTaskEvent } from '@/lib/tasks/task-transition-service';
import {
  evaluateEnvClean,
  resolveRequireEnvClean,
  type RequireEnvCleanDecision,
} from './env-clean-gate';
import { loadEnvSnapshot, type EnvSnapshot } from './env-snapshot';
import {
  acquireMachineLock,
  machineLockPath,
  resolveMachineLockRoot,
  type MachineLockResult,
} from './machine-lock';
import { resolveWorktreeIndex } from './worktree-index';
import {
  CONTRACT_DIR_PREFIX,
  evaluateScope,
  isContractPath,
  parsePorcelainEntries,
  scopeSkipDetachedContract,
} from './scope-gate';
import {
  ENV_CLEAN_GATE_ID,
  loadVerifyConfig,
  SCOPE_GATE_ID,
  VERIFY_CONFIG_RELATIVE_PATH,
  VerifyConfigError,
  WORK_EVIDENCE_GATE_ID,
  type VerifyConfig,
  type VerifyGate,
} from './verify-config';

const logger = createLogger('lib/verification/gate-runner');

/**
 * Built-in gates. Defined in verify-config (where RESERVED_GATE_IDS keeps a
 * verify.yaml from shadowing them) and re-exported here, which is where callers
 * have always imported them from.
 */
export { WORK_EVIDENCE_GATE_ID, SCOPE_GATE_ID, ENV_CLEAN_GATE_ID };

/**
 * Pseudo-gate used to carry a config-load failure into the run record.
 *
 * `verification_runs` has no message column, so without this row a run that
 * died on a missing or malformed verify.yaml would be an `error` status with
 * no stated cause — the caller would have to guess. It is only ever written on
 * the path where zero real gates run, so it cannot collide with a user gate.
 */
export const CONFIG_GATE_ID = 'config';

/**
 * What the built-in gates record in `command`.
 *
 * Neither runs a shell command, but the column is what a reader consults to see
 * what a gate did, so it names the plumbing instead of being left null.
 */
const WORK_EVIDENCE_GATE_COMMAND =
  'git merge-base / rev-list / status --porcelain (excluding contract files)';
const SCOPE_GATE_COMMAND = 'git diff --name-only / status --porcelain × contract scope';
const ENV_CLEAN_GATE_COMMAND =
  'lsof -iTCP -sTCP:LISTEN / tmux list-sessions / $HOME / ~/.commandmate × task-start snapshot';

/**
 * Concurrent runs allowed process-wide.
 *
 * Gates are whole test suites and builds; letting every worktree start one at
 * once turns a verification request into a fork bomb on a developer laptop.
 * Excess runs queue rather than fail: the run row already exists and its
 * caller has the id, so a queued run is honest about what will happen.
 */
export const MAX_CONCURRENT_VERIFICATIONS = 2;

/** Grace period between SIGTERM and SIGKILL for a gate that overran. */
const SIGKILL_GRACE_MS = 5000;

/**
 * Per-worktree environment every command gate is given (Issue #1771).
 *
 * `CM_WORKTREE_INDEX` is what lets a repository write
 * `E2E_PORT=$((60400+CM_WORKTREE_INDEX))` and stop N parallel worktrees from
 * fighting over one port — removing the collision instead of serializing around
 * it, which is the only option that keeps the parallelism. `CM_WORKTREE_ID` is
 * for everything a number cannot name: a container name, a database prefix, a
 * log directory.
 */
export const WORKTREE_ID_ENV = 'CM_WORKTREE_ID';
export const WORKTREE_INDEX_ENV = 'CM_WORKTREE_INDEX';

/**
 * Marker line carrying a mutexed gate's wait into `log_tail` (Issue #1771).
 *
 * `verification_gate_results` has no column for the wait, and it must not be
 * folded into `duration_ms`: the duration is what the gate's own command took,
 * and adding another run's queueing to it corrupts the number every timeout
 * budget and every "this gate got slower" judgement is made from. The log tail
 * is the same channel work-evidence's counts and the scope gate's evidence
 * already travel on (`src/cli/commands/verify.ts:60-99`).
 *
 * Mirrored by `MUTEX_LOG_PREFIX` in `src/cli/utils/verify-runner.ts`, which
 * cannot import this module — `tsconfig.cli.json` compiles `src/cli/**` alone.
 */
export const MUTEX_LOG_PREFIX = '[mutex]';

/**
 * First line of a gate that never ran because the lock stayed held.
 *
 * Deliberately not `timeout`: the gate's command was never started, so there is
 * nothing to say it ran long. Deliberately not `failed` either — the whole point
 * of Issue #1771 is that a resource conflict and a broken change must stop
 * reading the same. `skipped` aggregates the run to `error` (exit 99), which is
 * "no verdict was reached", not "the work is bad".
 */
export const MUTEX_WAIT_SKIP_REASON = 'reason=mutex-wait';

/**
 * Marker line carrying a retried gate's two runs into `log_tail` (Issue #1772).
 *
 * `verification_gate_results` stores one status, one exit code and one duration
 * per gate, and a DB migration was out of scope for #1772, so the second run's
 * numbers travel the same way #1771's wait does: a line-anchored, machine
 * readable first line the CLI reads back.
 *
 * Written whenever a retry actually ran — for `outcome=fail` too, not only for
 * `outcome=flaky`. A gate that failed twice is evidence *against* flakiness,
 * and a flake advisor mining history needs both halves of that ratio; a marker
 * present only on the flaky half would make every retried gate look flaky.
 *
 * Mirrored by `FLAKY_LOG_PREFIX` in `src/cli/utils/verify-runner.ts`, which
 * cannot import this module — `tsconfig.cli.json` compiles `src/cli/**` alone.
 */
export const FLAKY_LOG_PREFIX = '[flaky]';

/**
 * What a retried gate's two runs amounted to.
 *
 * `flaky` = failed then passed. `fail` = failed twice; the gate is FAIL and
 * always was, the marker only records that the second opinion agreed.
 */
export type FlakyOutcome = 'flaky' | 'fail';

/**
 * Runs a gate is allowed. Not derived from `retryOnFail` at the call site: the
 * marker states the number so a reader of stored history never has to look up
 * the verify.yaml that was in effect months ago.
 */
const RETRY_TOTAL_RUNS = 2;

/**
 * Separator between the two runs' outputs inside the composed log tail.
 *
 * Both are kept. Keeping only one makes the single question this feature exists
 * to answer — *what differed between the two runs* — unanswerable from the
 * record. `maxLogTailBytes` is applied per run, because it caps what one gate
 * command may contribute and there were two commands.
 */
function flakyRunHeader(index: number, outcome: GateOutcome): string {
  return (
    `--- ${FLAKY_LOG_PREFIX} run ${index}/${RETRY_TOTAL_RUNS}: ${outcome.status} ` +
    `exit=${formatExit(outcome.exitCode)} duration=${formatSeconds(outcome.durationMs)} ---`
  );
}

/** One decimal second, the spelling both `waited=` and `duration=` use. */
function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** `exit_code` is null for a gate killed by a signal; say so rather than lie. */
function formatExit(exitCode: number | null): string {
  return exitCode === null ? 'n/a' : String(exitCode);
}

export interface RunVerificationInput {
  worktreeId: string;
  /** Absolute path the gates execute in. */
  worktreePath: string;
  instanceId?: string;
  /**
   * Task the run belongs to. Omitted means "resolve the worktree's own task"
   * (#1545), which is what lets a caller verify against a contract without
   * knowing a task exists. Naming one is stronger than that fallback: it
   * survives the agent closing its own task mid-flight (#1620).
   */
  taskId?: string;
  trigger: VerificationTrigger;
  /**
   * Gate ids to run. Omitted falls back to the resolved task's contract
   * `verify.gates`, and then to work-evidence plus every verify.yaml gate.
   */
  gateIds?: string[];
}

/** A run is already in flight for this worktree. Surfaces as HTTP 409. */
export class VerificationConflictError extends Error {
  readonly worktreeId: string;
  readonly runningRunId: number;

  constructor(worktreeId: string, runningRunId: number) {
    super(`Verification run ${runningRunId} is already running for worktree '${worktreeId}'`);
    this.name = 'VerificationConflictError';
    this.worktreeId = worktreeId;
    this.runningRunId = runningRunId;
  }
}

interface GateOutcome {
  status: VerificationGateTerminalStatus;
  exitCode: number | null;
  /**
   * Epoch ms at which execution began (Issue #1625).
   *
   * Carried out of the evaluator rather than re-read when the row is written:
   * `durationMs` is measured from this exact clock reading, so the pair is an
   * interval. Taking a second reading at write time is what made the stored
   * timestamps describe the database write instead of the gate.
   */
  startedAt: number;
  durationMs: number;
  logTail: string | null;
}

/**
 * A gate that did not execute (Issue #1625).
 *
 * `started_at` is NOT NULL in the schema and a null `finished_at` already means
 * "still open", so there is no way to spell "no interval" — a zero-length
 * window at the instant the decision was made is recorded instead. It is also
 * the truth: nothing ran, and `duration_ms` has always said 0 for these rows.
 */
function notRun(logTail: string): GateOutcome {
  return {
    status: 'skipped',
    exitCode: null,
    startedAt: Date.now(),
    durationMs: 0,
    logTail,
  };
}

// =============================================================================
// Concurrency
// =============================================================================

let activeVerifications = 0;
const slotWaiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeVerifications < MAX_CONCURRENT_VERIFICATIONS) {
    activeVerifications += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    slotWaiters.push(resolve);
  });
}

function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) {
    // Hand the slot straight over instead of decrementing and re-incrementing:
    // a gap between the two would let a third run slip past the limit.
    next();
    return;
  }
  activeVerifications -= 1;
}

/**
 * In-flight runs, so callers (tests, and the CLI in Phase 1-4) can await a run
 * that {@link startVerification} deliberately did not wait for.
 */
const inFlight = new Map<number, Promise<VerificationRunTerminalStatus>>();

/**
 * Resolve when `runId` finishes, with its final status.
 *
 * Returns null when the run is not in flight — either it never started or it
 * already finished, in which case the database holds the answer.
 */
export function waitForVerification(
  runId: number
): Promise<VerificationRunTerminalStatus | null> {
  return inFlight.get(runId) ?? Promise.resolve(null);
}

// =============================================================================
// Command execution
// =============================================================================

/**
 * Keep exactly the last `maxBytes` of output.
 *
 * A failing suite's useful part is its tail (the summary), and log_tail is
 * stored per gate, so an unbounded buffer would put a full `npm test` log in
 * SQLite for every run.
 *
 * Evicting whole chunks is not enough: a stream that writes 4KB and then a
 * newline would leave the newline as the entire "tail". The head chunk is
 * trimmed in place instead, so what is retained never depends on where the
 * operating system happened to split the writes.
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    if (this.maxBytes <= 0 || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;

    // Drop head chunks that are entirely outside the window...
    while (this.chunks.length > 0 && this.size - this.chunks[0].length >= this.maxBytes) {
      this.size -= (this.chunks.shift() as Buffer).length;
    }
    // ...then trim the one chunk that straddles its edge.
    if (this.size > this.maxBytes) {
      const excess = this.size - this.maxBytes;
      this.chunks[0] = this.chunks[0].subarray(excess);
      this.size -= excess;
    }
  }

  toString(): string {
    return this.chunks.length === 0 ? '' : Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Run one shell command and report its exit code.
 *
 * `shell: true` so a gate can be written the way a developer would type it
 * (`npm run lint`), and `detached: true` so the timeout can signal the whole
 * process group — killing only the shell leaves the `npm`/`vitest` grandchildren
 * running and holding the worktree.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
  maxLogTailBytes: number,
  gateEnv: Record<string, string>
): Promise<GateOutcome> {
  return new Promise<GateOutcome>((resolve) => {
    const startedAt = Date.now();
    const tail = new TailBuffer(maxLogTailBytes);
    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, {
      shell: true,
      cwd,
      // CI=true matches how the same commands run in the pipeline; vitest picks
      // a different fileParallelism otherwise, and a gate that passes here but
      // fails in CI is worse than no gate. `gateEnv` carries the per-worktree
      // identity (#1771) and is code-supplied, never user input.
      env: { ...process.env, CI: 'true', ...gateEnv },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // stdout and stderr share one buffer: gate output is read as a transcript,
    // and interleaving is what makes an error attributable to the step above it.
    child.stdout?.on('data', (chunk: Buffer) => tail.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => tail.append(chunk));

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone, or this platform refused the negative pid.
        try {
          child.kill(signal);
        } catch {
          // Nothing left to signal.
        }
      }
    };

    // Only ever called from an event handler, so the killTimer binding below is
    // initialised by the time this runs.
    const finish = (outcome: Omit<GateOutcome, 'durationMs' | 'startedAt'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ ...outcome, startedAt, durationMs: Date.now() - startedAt });
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      graceTimer = setTimeout(() => signalGroup('SIGKILL'), SIGKILL_GRACE_MS);
      graceTimer.unref?.();
    }, timeoutSec * 1000);
    killTimer.unref?.();

    child.on('error', (error: Error) => {
      finish({
        status: 'error',
        exitCode: null,
        logTail: `${tail.toString()}\n[gate could not be spawned: ${error.message}]`.trim(),
      });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          status: 'timeout',
          // A timed-out gate has no verdict of its own; recording the signal's
          // exit code would look like the command decided something.
          exitCode: null,
          logTail:
            `${tail.toString()}\n[gate exceeded ${timeoutSec}s and was terminated (${signal ?? 'exited'})]`.trim(),
        });
        return;
      }
      finish({
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        logTail: tail.toString() || null,
      });
    });
  });
}

/**
 * Prefix a gate's log with what it waited for, so the wait is on the record
 * even when the command itself printed nothing.
 *
 * First line rather than last: the reader's question is "why did this gate take
 * so long", and the answer belongs before the output it is about. The GATE line
 * is built from the whole stored tail, so placement never decides whether
 * `waited=` reaches the terminal.
 */
function withMutexMarker(
  name: string,
  waitedMs: number,
  lockPath: string,
  logTail: string | null
): string {
  const marker = `${MUTEX_LOG_PREFIX} name=${name} waited=${formatSeconds(waitedMs)} lock=${lockPath}`;
  return prefixLogTail(marker, logTail);
}

/** The log of a gate whose lock never came free. */
function mutexWaitTimeoutLog(gate: VerifyGate, name: string, result: MachineLockResult): string {
  if (result.acquired) throw new Error('mutexWaitTimeoutLog called for an acquired lock');
  const held = result.heldBy ? ` (held by ${result.heldBy})` : '';
  return [
    `${MUTEX_WAIT_SKIP_REASON} waited=${formatSeconds(result.waitedMs)}`,
    `${MUTEX_LOG_PREFIX} name=${name} lock=${machineLockPathFor(name)}${held}`,
    `Gate '${gate.id}' declares mutex '${name}' and the machine-wide lock stayed held for its ` +
      `whole ${gate.timeoutSec}s budget, so the command was never started. This is a resource ` +
      'conflict, not a verdict on the work: re-run once the other run finishes, or raise ' +
      "the gate's timeoutSec.",
  ].join('\n');
}

/** Resolved separately from the acquisition so the message can name it either way. */
function machineLockPathFor(name: string): string {
  return machineLockPath(name, resolveMachineLockRoot());
}

/**
 * Run one attempt at a command gate, holding its `mutex` for the duration
 * (Issue #1771).
 *
 * The wait happens *outside* the measured interval: `startedAt`/`durationMs`
 * come from {@link runCommand} and describe the command alone, so a gate that
 * queued for 42s and then ran for 190s records 190s and reports the 42s beside
 * it. Merging them would inflate every duration by however busy the machine was.
 *
 * One *attempt*, not one gate, since #1772: a gate declaring `retryOnFail: 1`
 * calls this twice. The lock is taken and released per attempt rather than held
 * across both, so a retry never keeps a machine-wide resource out of another
 * worktree's hands for a run that has already failed once.
 */
async function runGateAttempt(
  gate: VerifyGate,
  worktreePath: string,
  maxLogTailBytes: number,
  gateEnv: Record<string, string>
): Promise<GateOutcome> {
  const mutex = gate.mutex;
  if (!mutex) {
    return runCommand(gate.command, worktreePath, gate.timeoutSec, maxLogTailBytes, gateEnv);
  }

  // The gate's own timeout is the wait budget: a gate allowed 600s of execution
  // has already declared how long this run may spend on it, and a second knob
  // would only let the two disagree.
  const lock = await acquireMachineLock(mutex, { timeoutMs: gate.timeoutSec * 1000 });
  if (!lock.acquired) {
    const recordedAt = Date.now();
    return {
      status: 'skipped',
      exitCode: null,
      startedAt: recordedAt,
      durationMs: 0,
      logTail: mutexWaitTimeoutLog(gate, mutex, lock),
    };
  }

  try {
    const outcome = await runCommand(
      gate.command,
      worktreePath,
      gate.timeoutSec,
      maxLogTailBytes,
      gateEnv
    );
    return {
      ...outcome,
      logTail: withMutexMarker(mutex, lock.waitedMs, lock.handle.path, outcome.logTail),
    };
  } finally {
    lock.handle.release();
  }
}

/**
 * Run one command gate, re-running it once when it fails and the gate asked for
 * that (Issue #1772).
 *
 * A gate that fails on the machine's luck — a random UUID that happens to
 * contain a forbidden substring, a port that was still in TIME_WAIT — is
 * indistinguishable in the record from a gate that fails on the work, and
 * "re-run the one red gate before believing it" has been tribal knowledge
 * rather than something the runner does. This makes it a declaration.
 *
 * Only a `failed` attempt is retried. A `timeout` is not: the gate already
 * spent its whole budget, and a second attempt would double the wall clock of
 * exactly the gates whose budgets are largest. A `skipped` (the mutex never
 * came free) and an `error` (the command could not be spawned) never started a
 * command, so there is no verdict to seek a second opinion on.
 */
async function runCommandGate(
  gate: VerifyGate,
  worktreePath: string,
  maxLogTailBytes: number,
  gateEnv: Record<string, string>
): Promise<GateOutcome> {
  const first = await runGateAttempt(gate, worktreePath, maxLogTailBytes, gateEnv);
  if (gate.retryOnFail !== 1 || first.status !== 'failed') return first;

  const second = await runGateAttempt(gate, worktreePath, maxLogTailBytes, gateEnv);
  if (second.status !== 'passed' && second.status !== 'failed') {
    // The retry reached no verdict of its own, so there is nothing to compare
    // the first run against. The first run's FAIL stands unchanged — reporting
    // the retry's `skipped`/`timeout` instead would turn a gate that judged the
    // work into a run with no verdict (exit 99), which is strictly weaker.
    return {
      ...first,
      logTail: prefixLogTail(
        `${FLAKY_LOG_PREFIX} retry reached no verdict (${second.status}); ` +
          "the first run's result stands. Retry log:\n" +
          (second.logTail ?? '(no output)'),
        first.logTail
      ),
    };
  }
  return composeRetriedGate(gate, first, second);
}

/**
 * Fold two runs of one gate into the single row the schema has (Issue #1772).
 *
 * `status` and `exitCode` come from the run whose verdict is being reported, so
 * the row never says `failed` beside `exit=0`: a FLAKY gate counted as a
 * failure reports the failing run, one counted as a pass reports the passing
 * one, and a gate that failed twice reports the later failure. `durationMs` is
 * the sum, because both runs were this gate's own command executing — the same
 * rule #1771 applied when it kept the lock *wait* out of the number.
 *
 * Both runs' numbers reach the terminal through the {@link FLAKY_LOG_PREFIX}
 * marker, which the CLI reads to print `GATE <id> FLAKY (exit=1,0, 45.0s,44.0s)`.
 */
function composeRetriedGate(
  gate: VerifyGate,
  first: GateOutcome,
  second: GateOutcome
): GateOutcome {
  const outcome: FlakyOutcome = second.status === 'passed' ? 'flaky' : 'fail';
  const passes = outcome === 'flaky' && gate.flakyIsPass === true;
  const reported = passes ? second : outcome === 'flaky' ? first : second;

  const marker =
    `${FLAKY_LOG_PREFIX} runs=${RETRY_TOTAL_RUNS} outcome=${outcome} ` +
    `exit=${formatExit(first.exitCode)},${formatExit(second.exitCode)} ` +
    `duration=${formatSeconds(first.durationMs)},${formatSeconds(second.durationMs)} ` +
    `verdict=${passes ? 'pass' : 'fail'}`;

  const body = [
    flakyRunHeader(1, first),
    first.logTail ?? '',
    flakyRunHeader(2, second),
    second.logTail ?? '',
  ].join('\n');

  return {
    status: passes ? 'passed' : 'failed',
    exitCode: reported.exitCode,
    // The window opens where the first run opened and closes `durationMs`
    // later, so #1625's `finished_at - started_at === duration_ms` still holds
    // and the pair still describes execution rather than the database write.
    startedAt: first.startedAt,
    durationMs: first.durationMs + second.durationMs,
    logTail: `${marker}\n${body}`,
  };
}

/** Put a machine-readable line ahead of a gate's output, keeping both. */
function prefixLogTail(marker: string, logTail: string | null): string {
  return logTail ? `${marker}\n${logTail}` : marker;
}

/** Run a git plumbing command. No shell: every argument here is code-supplied. */
function runGit(args: string[], cwd: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ code: null, stdout: '' }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

// =============================================================================
// Built-in work-evidence gate
// =============================================================================

/**
 * Decide whether the worktree contains work at all.
 *
 * Commits ahead of `baseRef` or a dirty tree both count. Neither means the
 * agent reported completion without touching anything, which the run records
 * as `not_started` rather than letting empty work collect a row of passing
 * gates — the precise failure `verify-completion.sh` was written to catch.
 *
 * Contract files are evidence of the *orchestrator*, not of the agent, so
 * neither side counts them (see {@link CONTRACT_DIR_PREFIX}).
 */
async function evaluateWorkEvidence(
  worktreePath: string,
  baseRef: string | null,
  requireCommit: RequireCommitDecision
): Promise<GateOutcome> {
  const startedAt = Date.now();
  const done = (
    status: VerificationGateTerminalStatus,
    logTail: string,
    exitCode: number | null
  ): GateOutcome => ({
    status,
    exitCode,
    startedAt,
    durationMs: Date.now() - startedAt,
    logTail,
  });

  if (!baseRef) {
    return done(
      'error',
      'work-evidence: no base ref. Set options.baseRef in ' +
        `${VERIFY_CONFIG_RELATIVE_PATH}; origin/HEAD did not resolve a default branch.`,
      null
    );
  }

  const mergeBase = await runGit(['merge-base', baseRef, 'HEAD'], worktreePath);
  if (mergeBase.code !== 0 || mergeBase.stdout.trim() === '') {
    return done(
      'error',
      `work-evidence: 'git merge-base ${baseRef} HEAD' failed; base ref is unreachable from this worktree.`,
      null
    );
  }

  const base = mergeBase.stdout.trim();
  // `:(top)` is an explicit "everything from the repository root" so the
  // pathspec is not exclusions alone, and it anchors both patterns at the root
  // rather than at cwd. A setup commit that only carries the contract must not
  // read as a commit's worth of work.
  const revList = await runGit(
    [
      'rev-list',
      '--count',
      `${base}..HEAD`,
      '--',
      ':(top)',
      `:(exclude,top)${CONTRACT_DIR_PREFIX}`,
    ],
    worktreePath
  );
  if (revList.code !== 0) {
    return done('error', `work-evidence: 'git rev-list --count ${base}..HEAD' failed.`, null);
  }
  const commitCount = Number.parseInt(revList.stdout.trim(), 10);

  // -z -uall for the same reasons scope-gate uses them: the human format
  // C-quotes paths with spaces and joins renames with ` -> `, and the default
  // untracked mode collapses a fresh `.commandmate/tasks/` to one directory
  // entry — all three make a per-path exclusion judge something that is not a
  // path. An entry counts as work when any of its paths is not a contract file,
  // so renaming a contract into real work is still a change.
  const porcelain = await runGit(
    ['status', '--porcelain', '-z', '--untracked-files=all'],
    worktreePath
  );
  if (porcelain.code !== 0) {
    return done('error', "work-evidence: 'git status --porcelain' failed.", null);
  }
  const uncommittedCount = parsePorcelainEntries(porcelain.stdout).filter((paths) =>
    paths.some((path) => !isContractPath(path))
  ).length;

  const summary =
    `work-evidence: baseRef=${baseRef} commits=${commitCount} uncommitted=${uncommittedCount}` +
    (requireCommit.required ? ' requireCommit=true' : '') +
    ' (contract files excluded)';

  if (!Number.isFinite(commitCount) || (commitCount === 0 && uncommittedCount === 0)) {
    return done('failed', `${summary}\nNo commits and no uncommitted changes: nothing to verify.`, 1);
  }
  // Issue #1628 (D-4): `commits=0 uncommitted=1` passing is what let a task
  // contract that says "未 commit の作業は未完了とみなされる" still end in
  // `RESULT passed` over work that was never committed. Opt-in, and off by
  // default so the gate keeps answering "is there work here" for everyone else.
  // Two declarations can switch it on — `options.requireCommit` per repository
  // and `success.requireCommit` per delegation (#1642) — so the reason names
  // whichever ones actually did.
  if (requireCommit.required && commitCount === 0) {
    return done(
      'failed',
      `${summary}\n${requireCommit.sources.join(' and ')} requires a commit: ` +
        'uncommitted changes are not work evidence, commit them.',
      1
    );
  }
  return done('passed', summary, 0);
}

// =============================================================================
// Run orchestration
// =============================================================================

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    // An unresolvable path cannot be proven to be the primary checkout, and the
    // gates would fail on it anyway.
    return false;
  }
}

/**
 * Resolve the ref work-evidence diffs against.
 *
 * An explicit `options.baseRef` wins. Otherwise origin/HEAD names the default
 * branch, and the remote-tracking ref is used rather than the local branch:
 * a linked worktree frequently has no local checkout of `main`.
 */
async function resolveBaseRef(config: VerifyConfig, worktreePath: string): Promise<string | null> {
  if (config.options.baseRef) return config.options.baseRef;
  const defaultBranch = await resolveDefaultBranchName(worktreePath);
  return defaultBranch ? `origin/${defaultBranch}` : null;
}

/**
 * How the scope gate got into the selection.
 *
 * The distinction only matters when the gate skips. `explicit` means the caller
 * asked for scope by name and did not get it, which is the "we declined to
 * check" case {@link aggregateRunStatus} exists to keep out of `passed`.
 * `implicit` means scope was in the default selection and no contract declared
 * one — nothing was declined, because there was nothing to judge.
 */
type ScopeRequest = 'explicit' | 'implicit' | 'off';

/** A declared gate together with where it was declared (Issue #1791). */
interface ResolvedGate extends VerifyGate {
  source: VerificationGateSource;
}

interface GateSelection {
  runWorkEvidence: boolean;
  scope: ScopeRequest;
  /**
   * Whether the env-clean gate runs (#1740).
   *
   * A plain boolean rather than a {@link ScopeRequest}: the gate has no "skip"
   * outcome to forgive. It either runs — reaching passed, failed or the UNKNOWN
   * `error` — or it was never selected and produces no row at all.
   */
  runEnvClean: boolean;
  gates: ResolvedGate[];
}

/**
 * Every gate available to this run, in execution order (Issue #1791).
 *
 * The repository's own declarations first, then the ones this delegation's
 * contract carried. Repository-wide criteria are what an Issue gate is judged
 * *against*, so running the shared ones first is what makes a report readable
 * top to bottom: "the repository's definition of passing held, and then the
 * Issue-specific check did too".
 *
 * A contract gate whose id collides with a verify.yaml gate is refused rather
 * than merged. `validateContractAgainstVerifyConfig` already rejects that at
 * send, so reaching here means the contract was stored by an older build or
 * written straight into the database — and running both would put two rows
 * under one id in the report, which is precisely the ambiguity `source` exists
 * to remove.
 */
function declaredGates(config: VerifyConfig, contractGates: VerifyGate[]): ResolvedGate[] | string {
  const fromConfig: ResolvedGate[] = config.gates.map((gate) => ({
    ...gate,
    source: 'verify.yaml',
  }));
  const configIds = new Set(fromConfig.map((gate) => gate.id));

  const collisions = contractGates.filter((gate) => configIds.has(gate.id)).map((gate) => gate.id);
  if (collisions.length > 0) {
    return (
      `Contract gate id(s) ${collisions.join(', ')} are already declared in ` +
      `${VERIFY_CONFIG_RELATIVE_PATH}. A contract may add gates, never redefine the ` +
      "repository's own."
    );
  }

  return [...fromConfig, ...contractGates.map((gate) => ({ ...gate, source: 'contract' as const }))];
}

/**
 * Resolve `gateIds` against the declared gates.
 *
 * Returns a message instead of a selection when the request names a gate that
 * does not exist, or selects nothing at all. Both would otherwise produce a run
 * with zero gate results, which {@link aggregateRunStatus} would have to call
 * `passed` — a green verdict from having checked nothing.
 *
 * @param declared verify.yaml's gates followed by the contract's (#1791); the
 *        selection preserves this order, never the order `gateIds` was typed in
 * @param requireEnvClean whether a declaration switched env-clean on. It is
 *        ORed with an explicit request rather than replacing it, so `--gates
 *        env-clean` still works with the switch off (and honestly reports
 *        UNKNOWN, because no baseline was recorded), and a delegation that
 *        declared the requirement cannot lose it by naming a narrower gate list.
 */
function selectGates(
  declared: ResolvedGate[],
  gateIds: string[] | undefined,
  requireEnvClean: boolean
): GateSelection | string {
  if (!gateIds) {
    return {
      runWorkEvidence: true,
      scope: 'implicit',
      runEnvClean: requireEnvClean,
      gates: declared,
    };
  }

  const known = new Set<string>([
    WORK_EVIDENCE_GATE_ID,
    SCOPE_GATE_ID,
    ENV_CLEAN_GATE_ID,
    ...declared.map((g) => g.id),
  ]);
  const unknown = gateIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return `Unknown gate id(s): ${unknown.join(', ')}. Declared gates: ${[...known].join(', ')}.`;
  }

  const requested = new Set(gateIds);
  const selection: GateSelection = {
    runWorkEvidence: requested.has(WORK_EVIDENCE_GATE_ID),
    scope: requested.has(SCOPE_GATE_ID) ? 'explicit' : 'off',
    runEnvClean: requested.has(ENV_CLEAN_GATE_ID) || requireEnvClean,
    gates: declared.filter((gate) => requested.has(gate.id)),
  };
  if (
    !selection.runWorkEvidence &&
    selection.scope === 'off' &&
    !selection.runEnvClean &&
    selection.gates.length === 0
  ) {
    return 'gateIds selected no gates; a run with no gates has nothing to report.';
  }
  return selection;
}

/**
 * Collapse gate verdicts into the run verdict.
 *
 * A `skipped` gate blocks `passed` on purpose. The primary-checkout guard skips
 * exactly the gates that would have judged the work, so reporting `passed`
 * would turn "we declined to check" into "we checked and it was fine" — the
 * inversion `skipped` exists to prevent.
 */
function aggregateRunStatus(
  gateStatuses: VerificationGateTerminalStatus[]
): VerificationRunTerminalStatus {
  if (gateStatuses.some((s) => s === 'failed' || s === 'timeout' || s === 'error')) return 'failed';
  if (gateStatuses.some((s) => s === 'skipped')) return 'error';
  return 'passed';
}

/** Everything the env-clean gate needs that is resolved before the run starts. */
interface EnvCleanContext {
  worktreeId: string;
  taskId: string | null;
  baseline: EnvSnapshot | null;
  decision: RequireEnvCleanDecision;
}

async function executeRun(
  db: Database.Database,
  runId: number,
  worktreeId: string,
  worktreePath: string,
  config: VerifyConfig,
  selection: GateSelection,
  baseRef: string | null,
  task: Task | null,
  detachedContract: Task | null,
  envClean: EnvCleanContext
): Promise<VerificationRunTerminalStatus> {
  const { maxLogTailBytes, skipInPrimaryCheckout } = config.options;
  const { runWorkEvidence, gates } = selection;
  // ORed with the repository-wide switch rather than replacing it (#1642): a
  // delegation may tighten the rule, never relax one the repository declared.
  const requireCommit = resolveRequireCommit(task?.contract ?? null, config);

  /**
   * The per-worktree environment, resolved on first use (#1771).
   *
   * Lazy because claiming an index writes to `~/.commandmate/worktree-index`,
   * and a run that reaches no command gate — work-evidence failed, the primary
   * checkout guard skipped everything — must leave nothing behind. It also has
   * to stay behind the env-clean gate below, which lists `~/.commandmate` and
   * would otherwise diff against a directory this very run had just created.
   */
  let gateEnvCache: Record<string, string> | null = null;
  const gateEnv = (): Record<string, string> => {
    gateEnvCache ??= {
      [WORKTREE_ID_ENV]: worktreeId,
      [WORKTREE_INDEX_ENV]: String(resolveWorktreeIndex(worktreeId)),
    };
    return gateEnvCache;
  };

  /**
   * Close an open gate row with the interval its evaluator measured.
   *
   * `finishedAt` is derived from the same clock reading `durationMs` was
   * measured against, so the stored pair is that measurement rather than a
   * second, later reading (#1625).
   */
  const close = (rowId: number, outcome: GateOutcome): GateOutcome => {
    finishGateResult(db, rowId, {
      status: outcome.status,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      logTail: outcome.logTail,
      executionWindow: {
        startedAt: outcome.startedAt,
        finishedAt: outcome.startedAt + outcome.durationMs,
      },
    });
    return outcome;
  };

  /**
   * Open the gate's row, run it, then close it.
   *
   * The row exists *before* the gate does anything, so a process that dies
   * mid-gate leaves a `running` row naming what it died in — which is what
   * {@link reconcileOrphanVerificationRuns} closes on the next start. Opening
   * and closing back to back (what this used to do) left that loop with nothing
   * to find, and an interrupted gate with no record at all.
   */
  const runGate = async (
    gateId: string,
    command: string,
    source: VerificationGateSource,
    evaluate: () => Promise<GateOutcome>
  ): Promise<GateOutcome> => {
    const row = createGateResult(db, runId, { gateId, command, source });
    return close(row.id, await evaluate());
  };

  /**
   * Record a gate that was never entered.
   *
   * Opened and closed on the spot: there is no execution to leave a `running`
   * row around, and the row carries {@link notRun}'s zero-length window.
   */
  const recordNotRun = (
    gateId: string,
    command: string,
    source: VerificationGateSource,
    reason: string
  ): GateOutcome => {
    const outcome = notRun(reason);
    const row = createGateResult(db, runId, { gateId, command, source });
    return close(row.id, outcome);
  };

  const statuses: VerificationGateTerminalStatus[] = [];

  if (runWorkEvidence) {
    const outcome = await runGate(
      WORK_EVIDENCE_GATE_ID,
      WORK_EVIDENCE_GATE_COMMAND,
      'builtin',
      () => evaluateWorkEvidence(worktreePath, baseRef, requireCommit)
    );

    if (outcome.status !== 'passed') {
      // Nothing was produced, so every command gate below would be judging the
      // base commit. Record them as skipped so the run shows what was not run.
      const reason = `skipped: the ${WORK_EVIDENCE_GATE_ID} gate did not pass.`;
      if (selection.scope !== 'off') {
        recordNotRun(SCOPE_GATE_ID, SCOPE_GATE_COMMAND, 'builtin', reason);
      }
      if (selection.runEnvClean) {
        recordNotRun(ENV_CLEAN_GATE_ID, ENV_CLEAN_GATE_COMMAND, 'builtin', reason);
      }
      for (const gate of gates) {
        recordNotRun(gate.id, gate.command, gate.source, reason);
      }
      return outcome.status === 'failed' ? 'not_started' : 'error';
    }
    statuses.push(outcome.status);
  }

  if (selection.scope !== 'off') {
    // A detached contract is decided before the gate would run, so its row is
    // recorded rather than executed.
    const outcome = detachedContract
      ? recordNotRun(
          SCOPE_GATE_ID,
          SCOPE_GATE_COMMAND,
          'builtin',
          scopeSkipDetachedContract(detachedContract.id, detachedContract.status)
        )
      : await runGate(SCOPE_GATE_ID, SCOPE_GATE_COMMAND, 'builtin', () =>
          evaluateScope(
            worktreePath,
            task?.contract.scope ?? null,
            task?.contract.success.requireScopeClean ?? false,
            baseRef,
            task?.contractPath ?? null
          )
        );
    // A skipped scope gate in the default selection is usually not a declined
    // check: no contract declared a scope, so there was no assertion to test.
    // Counting it would turn every contract-less run into `error` (see
    // aggregateRunStatus). It *is* a declined check when the caller asked for
    // scope by name, and when a contract exists that this run could not attach
    // to — that second case is how a run reported `passed` while the scope it
    // was supposed to judge went unexamined (#1620).
    const declined = selection.scope === 'explicit' || detachedContract !== null;
    if (outcome.status !== 'skipped' || declined) {
      statuses.push(outcome.status);
    }
  }

  if (selection.runEnvClean) {
    // Measured before the command gates, not after: the pair of snapshots spans
    // the agent's working window, and the gates below are the repository's own
    // declared commands. A `test:e2e` gate that starts a server would otherwise
    // be reported as the agent leaking one.
    const outcome = await runGate(ENV_CLEAN_GATE_ID, ENV_CLEAN_GATE_COMMAND, 'builtin', () =>
      evaluateEnvClean({
        worktreeId: envClean.worktreeId,
        worktreePath,
        taskId: envClean.taskId,
        baseline: envClean.baseline,
        sources: envClean.decision.sources,
      })
    );
    statuses.push(outcome.status);
  }

  const isPrimaryCheckout = skipInPrimaryCheckout && sameRealPath(worktreePath, process.cwd());

  for (const gate of gates) {
    if (isPrimaryCheckout) {
      // The server process runs out of this directory. A `build` here replaces
      // the chunks the running app is serving mid-flight and breaks the live UI
      // — observed twice before this guard existed.
      statuses.push(
        recordNotRun(
          gate.id,
          gate.command,
          gate.source,
          'skipped: worktreePath is the server process working directory and ' +
            'options.skipInPrimaryCheckout is true.'
        ).status
      );
      continue;
    }

    const outcome = await runGate(gate.id, gate.command, gate.source, () =>
      runCommandGate(gate, worktreePath, maxLogTailBytes, gateEnv())
    );
    statuses.push(outcome.status);
  }

  return aggregateRunStatus(statuses);
}

// =============================================================================
// Task contracts (#1545)
// =============================================================================

/**
 * Translate a run verdict into the event that closes the task.
 *
 * `error` maps to `verify_failed`: no verdict was reached, and a task that could
 * not be verified is not a task that passed. Leaving it in `verifying` forever
 * would be a worse lie than calling it failed — the reason is recorded in the
 * run's `config` gate log_tail.
 */
function taskEventForRunStatus(status: VerificationRunTerminalStatus): TaskEvent {
  switch (status) {
    case 'passed':
      return 'verify_passed';
    case 'not_started':
      return 'verify_not_started';
    case 'cancelled':
      return 'cancel';
    default:
      return 'verify_failed';
  }
}

/**
 * Raise a task event, tolerating a task that vanished mid-run.
 *
 * A deleted worktree takes its tasks with it; the run's own record is already
 * written by then, so failing here would lose a verdict that exists.
 *
 * Whether the event is allowed is the state machine's decision, not this
 * module's — a run against an already-`succeeded` task is refused there, and the
 * refusal is recorded in `task_events` instead of vanishing.
 */
function recordTaskTransition(
  db: Database.Database,
  taskId: string,
  event: TaskEvent,
  runId?: number
): void {
  try {
    applyTaskEvent(db, taskId, event, runId === undefined ? undefined : { runId });
  } catch (error) {
    logger.warn('task-transition-failed', {
      taskId,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Resolve the task this run belongs to.
 *
 * An explicit `taskId` wins even when the row is gone — the caller asserted the
 * attribution and the run should record it — so a missing row yields no task to
 * transition, not an error. It also wins over the task's status: naming a task
 * is the caller saying "this run is about that contract", which is what lets a
 * `wait --verify` still judge a contract whose agent already verified itself
 * and closed the task (#1620).
 */
function resolveTask(db: Database.Database, input: RunVerificationInput): Task | null {
  if (input.taskId !== undefined) {
    return getTask(db, input.taskId);
  }
  return getVerifiableTask(db, input.worktreeId);
}

/**
 * A contract this worktree has that the run could not be attached to.
 *
 * The scope gate skips whenever no task resolves, and that skip is forgiven so
 * a repository without contracts is not permanently `error`. The forgiveness
 * was load-bearing for a case it was never meant to cover: once an agent's own
 * `commandmate verify` moved its task to `succeeded`, the orchestrator's run
 * resolved nothing, skipped scope, and reported `passed` — a green verdict on a
 * declaration nothing had read (#1620).
 *
 * Reported only when the contract actually asked for a clean scope: a contract
 * with `requireScopeClean: false` would have skipped while fully attached, so
 * nothing was declined by losing it.
 *
 * @returns the closed task, or null when there is genuinely nothing to judge
 */
function findDetachedContract(
  db: Database.Database,
  input: RunVerificationInput,
  task: Task | null
): Task | null {
  // A resolved task, or a caller that named one, is an attributed run.
  if (task !== null || input.taskId !== undefined) return null;

  const [latest] = listTasks(db, input.worktreeId, 1);
  // `pending` is not detached: nothing was sent, so no run can be about it yet.
  // Anything resolvable would already have come back from resolveTask.
  if (!latest || latest.status === 'pending') return null;
  return latest.contract.success.requireScopeClean ? latest : null;
}

/**
 * Open a verification run and execute it in the background.
 *
 * Returns as soon as the run row exists, so an HTTP caller gets an id it can
 * poll instead of holding a connection open for the length of a test suite.
 * Use {@link waitForVerification} to await the verdict.
 *
 * @throws VerificationConflictError when the worktree already has an open run
 */
export async function startVerification(
  input: RunVerificationInput
): Promise<{ runId: number }> {
  const db = getDbInstance();

  const existing = getRunningVerificationRun(db, input.worktreeId);
  if (existing) {
    throw new VerificationConflictError(input.worktreeId, existing.id);
  }

  const task = resolveTask(db, input);
  // Deliberately not folded into `taskId` below: the run did not judge this
  // contract, and recording it would put a verdict-less run in that task's
  // history. It is named in the scope gate's log_tail instead.
  const detachedContract = findDetachedContract(db, input, task);
  const taskId = input.taskId ?? task?.id ?? null;
  // An explicit gateIds always wins: `verify --gates lint` must mean lint even
  // when the contract asks for more.
  const gateIds =
    input.gateIds ?? (task ? resolveContractGateIds(task.contract) ?? undefined : undefined);

  let config: VerifyConfig | null = null;
  let configFailure: string | null = null;
  try {
    config = loadVerifyConfig(input.worktreePath);
    if (!config) {
      configFailure =
        `${VERIFY_CONFIG_RELATIVE_PATH} not found in ${input.worktreePath}. ` +
        'Declare the repository verification gates there before running verification.';
    }
  } catch (error) {
    configFailure =
      error instanceof VerifyConfigError
        ? error.message
        : `Failed to read ${VERIFY_CONFIG_RELATIVE_PATH}: ${(error as Error).message}`;
  }

  // Resolved before gate selection because it can add a gate to it (#1740).
  const envCleanDecision = resolveRequireEnvClean(task?.contract ?? null, config);

  let selection: GateSelection | null = null;
  if (config && !configFailure) {
    // Contract gates come from the task this run is actually about (#1791), so
    // a detached contract contributes none — the same rule `requireCommit`
    // follows, and for the same reason: that run is not about that contract.
    const declared = declaredGates(config, task ? contractGateDefinitions(task.contract) : []);
    if (typeof declared === 'string') {
      configFailure = declared;
    } else {
      const selected = selectGates(declared, gateIds, envCleanDecision.required);
      if (typeof selected === 'string') {
        configFailure = selected;
      } else {
        selection = selected;
      }
    }
  }

  const baseRef = config ? await resolveBaseRef(config, input.worktreePath) : null;

  const run = createVerificationRun(db, {
    worktreeId: input.worktreeId,
    trigger: input.trigger,
    instanceId: input.instanceId ?? null,
    taskId,
    baseRef,
  });

  // Whether this run may move the task is the state machine's call (#1548).
  // It refuses `verify_started` from `succeeded`/`cancelled`, so an unrelated
  // manual run still cannot walk back a recorded verdict — while a `failed`
  // task, which a retry legitimately reopens, is no longer excluded by a status
  // check that could not tell the two apart.
  const trackedTask = task;

  if (!config || !selection) {
    // Closed synchronously: there is no work to schedule, and leaving the row
    // `running` would block the next request for this worktree on a run that
    // will never move.
    // Recorded, not run: this row carries a message about a config that could
    // not be loaded, so like any gate that never executed it gets a zero-length
    // window at the moment the failure was recorded (#1625).
    const recordedAt = Date.now();
    const row = createGateResult(db, run.id, {
      gateId: CONFIG_GATE_ID,
      command: VERIFY_CONFIG_RELATIVE_PATH,
      source: 'builtin',
    });
    finishGateResult(db, row.id, {
      status: 'error',
      exitCode: null,
      durationMs: 0,
      logTail: configFailure,
      executionWindow: { startedAt: recordedAt, finishedAt: recordedAt },
    });
    finishVerificationRun(db, run.id, 'error');
    logger.warn('verification-config-unusable', { runId: run.id, worktreeId: input.worktreeId });
    if (trackedTask) {
      // The run opened and immediately errored, so the task passes through
      // `verifying` the same way it would for gates that ran: an unusable config
      // means this task can never be shown to have passed, and going straight to
      // `verify_failed` would be a transition the machine has no rule for.
      recordTaskTransition(db, trackedTask.id, 'verify_started', run.id);
      recordTaskTransition(db, trackedTask.id, 'verify_failed', run.id);
    }
    return { runId: run.id };
  }

  if (trackedTask) {
    recordTaskTransition(db, trackedTask.id, 'verify_started', run.id);
  }

  const resolvedConfig = config;
  const resolvedSelection = selection;
  // Read once, up front: the baseline is a file, and a run that took minutes
  // must be judged against the snapshot the task started from, not against
  // whatever is on disk when the gate finally executes.
  const envCleanContext: EnvCleanContext = {
    worktreeId: input.worktreeId,
    taskId,
    baseline: resolvedSelection.runEnvClean && taskId ? loadEnvSnapshot(taskId) : null,
    decision: envCleanDecision,
  };
  const completion = (async (): Promise<VerificationRunTerminalStatus> => {
    await acquireSlot();
    let terminalStatus: VerificationRunTerminalStatus = 'error';
    try {
      const status = await executeRun(
        db,
        run.id,
        input.worktreeId,
        input.worktreePath,
        resolvedConfig,
        resolvedSelection,
        baseRef,
        task,
        detachedContract,
        envCleanContext
      );
      terminalStatus = status;
      finishVerificationRun(db, run.id, status);
      return status;
    } catch (error) {
      logger.error('verification-run-crashed', {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        finishVerificationRun(db, run.id, 'error');
      } catch {
        // The row is gone (worktree deleted mid-run); nothing left to close.
      }
      return 'error';
    } finally {
      if (trackedTask) {
        recordTaskTransition(db, trackedTask.id, taskEventForRunStatus(terminalStatus), run.id);
      }
      releaseSlot();
      inFlight.delete(run.id);
    }
  })();

  inFlight.set(run.id, completion);
  return { runId: run.id };
}

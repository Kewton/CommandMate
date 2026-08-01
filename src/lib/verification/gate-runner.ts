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
import { resolveContractGateIds } from '@/lib/tasks/contract-message';
import type { TaskEvent } from '@/lib/tasks/task-state-machine';
import { applyTaskEvent } from '@/lib/tasks/task-transition-service';
import {
  CONTRACT_DIR_PREFIX,
  evaluateScope,
  isContractPath,
  parsePorcelainEntries,
  scopeSkipDetachedContract,
} from './scope-gate';
import {
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
export { WORK_EVIDENCE_GATE_ID, SCOPE_GATE_ID };

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
  durationMs: number;
  logTail: string | null;
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
  maxLogTailBytes: number
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
      // fails in CI is worse than no gate.
      env: { ...process.env, CI: 'true' },
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
    const finish = (outcome: Omit<GateOutcome, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ ...outcome, durationMs: Date.now() - startedAt });
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
  baseRef: string | null
): Promise<GateOutcome> {
  const startedAt = Date.now();
  const done = (
    status: VerificationGateTerminalStatus,
    logTail: string,
    exitCode: number | null
  ): GateOutcome => ({ status, exitCode, durationMs: Date.now() - startedAt, logTail });

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
    ' (contract files excluded)';

  if (!Number.isFinite(commitCount) || (commitCount === 0 && uncommittedCount === 0)) {
    return done('failed', `${summary}\nNo commits and no uncommitted changes: nothing to verify.`, 1);
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

interface GateSelection {
  runWorkEvidence: boolean;
  scope: ScopeRequest;
  gates: VerifyGate[];
}

/**
 * Resolve `gateIds` against the config.
 *
 * Returns a message instead of a selection when the request names a gate that
 * does not exist, or selects nothing at all. Both would otherwise produce a run
 * with zero gate results, which {@link aggregateRunStatus} would have to call
 * `passed` — a green verdict from having checked nothing.
 */
function selectGates(config: VerifyConfig, gateIds: string[] | undefined): GateSelection | string {
  if (!gateIds) {
    return { runWorkEvidence: true, scope: 'implicit', gates: config.gates };
  }

  const known = new Set<string>([
    WORK_EVIDENCE_GATE_ID,
    SCOPE_GATE_ID,
    ...config.gates.map((g) => g.id),
  ]);
  const unknown = gateIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return `Unknown gate id(s): ${unknown.join(', ')}. Declared gates: ${[...known].join(', ')}.`;
  }

  const requested = new Set(gateIds);
  const selection: GateSelection = {
    runWorkEvidence: requested.has(WORK_EVIDENCE_GATE_ID),
    scope: requested.has(SCOPE_GATE_ID) ? 'explicit' : 'off',
    gates: config.gates.filter((gate) => requested.has(gate.id)),
  };
  if (!selection.runWorkEvidence && selection.scope === 'off' && selection.gates.length === 0) {
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

async function executeRun(
  db: Database.Database,
  runId: number,
  worktreePath: string,
  config: VerifyConfig,
  selection: GateSelection,
  baseRef: string | null,
  task: Task | null,
  detachedContract: Task | null
): Promise<VerificationRunTerminalStatus> {
  const { maxLogTailBytes, skipInPrimaryCheckout } = config.options;
  const { runWorkEvidence, gates } = selection;

  const record = (
    gateId: string,
    command: string,
    outcome: GateOutcome
  ): VerificationGateTerminalStatus => {
    const row = createGateResult(db, runId, { gateId, command });
    finishGateResult(db, row.id, {
      status: outcome.status,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      logTail: outcome.logTail,
    });
    return outcome.status;
  };

  const statuses: VerificationGateTerminalStatus[] = [];

  if (runWorkEvidence) {
    const outcome = await evaluateWorkEvidence(worktreePath, baseRef);
    record(WORK_EVIDENCE_GATE_ID, WORK_EVIDENCE_GATE_COMMAND, outcome);

    if (outcome.status !== 'passed') {
      // Nothing was produced, so every command gate below would be judging the
      // base commit. Record them as skipped so the run shows what was not run.
      const notRun = `skipped: the ${WORK_EVIDENCE_GATE_ID} gate did not pass.`;
      if (selection.scope !== 'off') {
        record(SCOPE_GATE_ID, SCOPE_GATE_COMMAND, {
          status: 'skipped',
          exitCode: null,
          durationMs: 0,
          logTail: notRun,
        });
      }
      for (const gate of gates) {
        record(gate.id, gate.command, {
          status: 'skipped',
          exitCode: null,
          durationMs: 0,
          logTail: notRun,
        });
      }
      return outcome.status === 'failed' ? 'not_started' : 'error';
    }
    statuses.push(outcome.status);
  }

  if (selection.scope !== 'off') {
    const outcome = detachedContract
      ? {
          status: 'skipped' as const,
          exitCode: null,
          durationMs: 0,
          logTail: scopeSkipDetachedContract(detachedContract.id, detachedContract.status),
        }
      : await evaluateScope(
          worktreePath,
          task?.contract.scope ?? null,
          task?.contract.success.requireScopeClean ?? false,
          baseRef,
          task?.contractPath ?? null
        );
    record(SCOPE_GATE_ID, SCOPE_GATE_COMMAND, outcome);
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

  const isPrimaryCheckout = skipInPrimaryCheckout && sameRealPath(worktreePath, process.cwd());

  for (const gate of gates) {
    if (isPrimaryCheckout) {
      // The server process runs out of this directory. A `build` here replaces
      // the chunks the running app is serving mid-flight and breaks the live UI
      // — observed twice before this guard existed.
      statuses.push(
        record(gate.id, gate.command, {
          status: 'skipped',
          exitCode: null,
          durationMs: 0,
          logTail:
            'skipped: worktreePath is the server process working directory and ' +
            'options.skipInPrimaryCheckout is true.',
        })
      );
      continue;
    }

    const outcome = await runCommand(gate.command, worktreePath, gate.timeoutSec, maxLogTailBytes);
    statuses.push(record(gate.id, gate.command, outcome));
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

  let selection: GateSelection | null = null;
  if (config && !configFailure) {
    const selected = selectGates(config, gateIds);
    if (typeof selected === 'string') {
      configFailure = selected;
    } else {
      selection = selected;
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
    const row = createGateResult(db, run.id, {
      gateId: CONFIG_GATE_ID,
      command: VERIFY_CONFIG_RELATIVE_PATH,
    });
    finishGateResult(db, row.id, {
      status: 'error',
      exitCode: null,
      durationMs: 0,
      logTail: configFailure,
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
  const completion = (async (): Promise<VerificationRunTerminalStatus> => {
    await acquireSlot();
    let terminalStatus: VerificationRunTerminalStatus = 'error';
    try {
      const status = await executeRun(
        db,
        run.id,
        input.worktreePath,
        resolvedConfig,
        resolvedSelection,
        baseRef,
        task,
        detachedContract
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

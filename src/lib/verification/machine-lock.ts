/**
 * Machine-wide advisory lock for verification gates (Issue #1771).
 *
 * A gate that owns a fixed resource — a hard-coded port, a local database, an
 * emulator — can only run once per machine. Two parallel worktrees running it
 * at the same time make the second one fail on the resource, and the record
 * says `GATE e2e FAIL exit=1`, which is indistinguishable from the change being
 * broken. `mutex: <name>` in verify.yaml declares that constraint, and this
 * module is what enforces it.
 *
 * Properties that decide the implementation:
 *
 *   1. **It must hold across processes.** The lock exists because CommandMate's
 *      runner and the standalone `verify-run.sh` can be started independently
 *      against the same machine, so an in-process mutex would not be a lock at
 *      all. The path convention (`~/.commandmate/locks/<name>.lock`) is part of
 *      the contract, not an implementation detail — see
 *      docs/design/verification-config.md §9.
 *   2. **It must be portable.** macOS ships no `flock(1)`, so the primitives are
 *      `mkdir` and `link`, atomic on every POSIX filesystem and expressible in
 *      both bash and Node.
 *   3. **A crashed holder must not wedge the machine.** The records name the
 *      pid and host, so a holding left behind by a process that no longer
 *      exists is ended by the next waiter.
 *   4. **Waiters are served in the order they came (Issue #4277)**: tickets
 *      (`<root>/<name>.queue/<12 digits>`); only the head of the queue takes.
 *   5. **Unknown never takes, deletes or releases (Issue #4288).**
 *   6. **One copy of the steps (Issue #4559).** The holding is the generation
 *      chain (docs/design/machine-lock-generation-4559.md): the holder is the
 *      largest `<name>.gen/g<N>` without `end`, and `<name>.lock` is the beacon
 *      for the older versions. The steps — the ticket, the generation, the
 *      beacon, the recovery, the release — are scripts/orchestrate/machine-lock-sync.mjs,
 *      imported here through its byte copy machine-lock-sync-core.generated.ts
 *      (pinned by tests/unit/verification/machine-lock-sync-core-copy-4559.test.ts).
 *      This module only waits (`await` between the core's polls), keeps the
 *      release's retry and writes the core's warnings to the logger. It has no
 *      file operation of its own.
 *
 * Server-only: reads and writes the filesystem.
 *
 * @module lib/verification/machine-lock
 */

import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '@/lib/logger';
import * as generatedCore from '@/lib/verification/machine-lock-sync-core.generated';

const logger = createLogger('lib/verification/machine-lock');

/**
 * Directory under `~/.commandmate` that holds the locks.
 *
 * Exported because `env-snapshot` has to know this name: the env-clean gate
 * lists the entries directly under `~/.commandmate` and would otherwise report
 * the runner's own bookkeeping as pollution the delegation left behind.
 */
export const MACHINE_LOCK_DIR_NAME = 'locks';

/**
 * Override for the lock root.
 *
 * Tests must never take a lock under the real `~/.commandmate/locks`: parallel
 * worktrees on a developer machine share that directory, so a suite that used
 * it would serialize against — and be failed by — unrelated live runs. Also
 * useful for isolating a CI runner from a shared home.
 */
export const MACHINE_LOCK_ROOT_ENV = 'CM_VERIFY_LOCK_ROOT';

/** How often a waiter re-tries the claim. */
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 250;

/** The convention both runners follow: `<root>/<name>.lock`. */
export function machineLockPath(name: string, root: string): string {
  return join(root, `${name}.lock`);
}

export function defaultMachineLockRoot(): string {
  return join(homedir(), '.commandmate', MACHINE_LOCK_DIR_NAME);
}

export function resolveMachineLockRoot(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env[MACHINE_LOCK_ROOT_ENV];
  return override && override.trim() !== '' ? override : defaultMachineLockRoot();
}

export interface MachineLockHandle {
  name: string;
  /** Absolute path of the lock directory, so a report can name it. */
  path: string;
  /** Idempotent; only lets go of the lock while this acquisition still holds it. */
  release(): void;
}

export type MachineLockResult =
  | { acquired: true; handle: MachineLockHandle; waitedMs: number }
  | {
      acquired: false;
      waitedMs: number;
      /** Human-readable owner (`pid 4211 on host`), or null when unreadable. */
      heldBy: string | null;
      /**
       * The waiter gave up on its own rather than running out of time
       * (Issue #2063).
       *
       * The two are different events and the caller reports them differently: a
       * timeout is a resource conflict worth naming the holder for, an
       * abandoned wait is the operator having stopped the run. Optional so
       * every existing `acquired: false` reader keeps compiling and keeps
       * meaning "timed out".
       */
      abandoned?: boolean;
      /**
       * What the last poll could not observe (Issue #4288): the observation point, the path and
       * the errno. Present only when an unknown — not a live holder — is what kept the lock out.
       */
      unknown?: MachineLockUnknown;
    };

/** An observation that answered neither yes nor no (Issue #4288 §2.8). */
export interface MachineLockUnknown {
  point: string;
  path: string;
  code: string;
}

/** The stages `onRecover` is called at (#4277; `restore-*` since #4288; `empty-owner-moved` since #4288 PR1a-f). */
export type MachineLockRecoverStage = 'before-move' | 'moved' | 'restore-mkdir' | 'restore-owner' | 'empty-owner-moved';

/** The five points of the owner's publish (#4288 PR1a-f §2.6, the same names in the three implementations). */
export type MachineLockOwnerStage = 'owner-lock-made' | 'owner-tmp-opened' | 'owner-tmp-written' | 'owner-linked' | 'owner-tmp-removed';

export interface AcquireMachineLockOptions {
  /** Total time to wait for the lock. A gate passes its `mutexWaitSec`, or else its `timeoutSec` (#4162). */
  timeoutMs: number;
  root?: string;
  pollIntervalMs?: number;
  /**
   * Give up waiting as soon as this answers true (Issue #2063).
   *
   * A gate's wait budget defaults to its whole `timeoutSec`, which `.commandmate/verify.yaml`
   * sets as high as 1800s for `build`. Without this hook a run cancelled while
   * queued behind a mutex could not be stopped: nothing had been spawned, so
   * the cancel switch had no process to signal, and the run row stayed
   * `running` — blocking every further run for that worktree — until the lock
   * came free. That is precisely the state the cancel endpoint exists to escape.
   *
   * Polled rather than an AbortSignal because the wait is already a poll loop
   * with a 250ms interval; a predicate composes with the runner's latch without
   * threading a controller through four call frames.
   */
  shouldAbandon?: () => boolean;
  /**
   * Called once, the first time the claim fails and the waiter is about to
   * sleep (Issue #3884 H-11).
   *
   * Not called when the lock is taken on the first claim. The gate runner hands
   * its verification slot back here, so a run queued behind a busy lock does
   * not also keep a third run's light gates from starting — and a lock that was
   * free costs no slot churn at all.
   */
  onWait?: () => void;
  /**
   * Test seams only (Issue #4277): replace the clock, the host name, the process
   * probes and the `link` that publishes a ticket. Production callers never pass it.
   */
  __testHooks?: MachineLockTestHooks;
}

export interface MachineLockTestHooks {
  now?: () => number;
  host?: string;
  pidAlive?: (pid: number) => boolean;
  groupAlive?: (pgid: number) => boolean;
  startOf?: (pid: number) => number | null;
  link?: (src: string, dst: string) => void;
  beforeLink?: (n: number) => void;
  /**
   * Called while a dead holder's lock is recovered: before it is moved aside and
   * right after. Lets a test put a third party's claim into the window (#4277 P1).
   */
  onRecover?(stage: MachineLockRecoverStage): void;
  /** Called at each point of the owner's publish (#4288 PR1a-f §2.6): a test pauses or kills there. */
  onOwnerStage?(stage: MachineLockOwnerStage): void;
  /** Called at each seam of the generation's steps (#4559, docs/design/machine-lock-generation-4559.md §8.1 T2). */
  onGenStage?(stage: string, n: number): void;
  /**
   * Inject a failure at an observation point (Issue #4288): answer an errno (`'EPERM'`, `'EACCES'`,
   * `'EIO'` …) for `point` / `target` and the observation fails with it, through the same
   * classification as a real failure. `count` (#4559) is how many times the point has been reached.
   */
  fault?: (point: string, target: string, count: number) => string | null | undefined;
}

// ---------------------------------------------------------------------------
// The boundary with the core (#4559 案 F): the one place its exports are typed. Every export of
// scripts/orchestrate/machine-lock-sync.mjs is named here (the copy test compares the two sets); the
// shapes of the arguments are the ones docs/design/machine-lock-generation-4559.md §7.5 asks a person to read.
// ---------------------------------------------------------------------------

type CoreWarn = (line: string, data?: Record<string, unknown>) => void;
type CoreRecord = Record<string, unknown> & { pid: number; token: string; host?: string; pgid?: number };
type CoreCodec = { parse: (text: string) => unknown; format: (record: Record<string, unknown>) => string };
type CoreHooks = MachineLockTestHooks & { kill?: (target: number, signal: number) => void };
type CoreReleaseResult = 'released' | 'deferred' | 'needs-head' | 'kept' | 'none';
interface CoreLock {
  acquired: boolean;
  waitedMs: number;
  heldBy: string | null;
  abandoned?: boolean;
  unknown?: MachineLockUnknown;
  release: () => CoreReleaseResult;
  setOwnerFields: (fields: Record<string, unknown>) => boolean;
  handOff: (pid: number, pgid: number) => { ok: boolean; token?: string; stage?: string };
  token?: string;
  gen?: number;
  path: string;
}
interface CoreAcquireOptions {
  root?: string;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => void;
  pgid?: number;
  ownerFields?: Record<string, unknown>;
  onStaleHolder?: (owner: CoreRecord) => void;
  shouldAbandon?: () => boolean;
  onWait?: () => void;
  warn?: CoreWarn;
  hooks?: CoreHooks;
  lockPath?: string;
  ownerCodec?: CoreCodec;
  ownerlessGraceMs?: number;
  token?: string;
  ownerPid?: number;
}
interface CoreHeadOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => void;
  warn?: CoreWarn;
  ownerlessGraceMs?: number;
  ownerCodec?: CoreCodec;
  hooks?: CoreHooks;
}
type CoreHeadResult = { result: string; unknown?: MachineLockUnknown; heldBy?: string | null; pending?: string };

/** The exports of the core, by name (the copy test reads these keys and compares them with the core's `export`s). */
interface MachineLockSyncCore {
  LOCK_POLL_MS: number;
  TICKET_PATTERN: RegExp;
  SAME_HOST_GRACE_MS: number;
  OTHER_HOST_GRACE_MS: number;
  PID_REUSE_SLACK_MS: number;
  EMPTY_OWNER_GRACE_MS: number;
  RESERVED_OWNER_FIELDS: readonly string[];
  OWNER_VERSION: number;
  ticketName: (n: number) => string;
  lockPathOf: (root: string, name: string) => string;
  queueDirOf: (root: string, name: string) => string;
  queueDirOfPath: (lockPath: string) => string;
  JSON_OWNER_CODEC: CoreCodec;
  HEAD_BUDGET_MS: number;
  sleepSync: (ms: number) => void;
  parseEtime: (text: string) => number | null;
  processStartMs: (pid: number, now?: number, clock?: () => number, why?: { code?: string }) => number | null;
  pidAlive: (pid: number) => boolean;
  groupAlive: (pgid: number) => boolean;
  GONE_SUFFIX_PATTERN: RegExp;
  makeObserver: (hooks?: CoreHooks & { codec?: CoreCodec }) => unknown;
  holderState: (record: unknown, env: unknown, points?: { pid: string; group: string }) => { state: 'alive' | 'gone' | 'unknown'; point?: string; code?: string };
  readOwner: (lockPath: string, codec?: CoreCodec) => CoreRecord | null;
  describeOwner: (owner: { pid: unknown; host?: unknown } | null) => string | null;
  listQueue: (queueDir: string) => { n: number; file: string; ticket: unknown }[];
  markDone: (file: string, token: string, warn?: CoreWarn) => boolean;
  holderGone: (record: unknown, env: unknown) => boolean;
  ticketRetirable: (ticket: unknown, env: unknown) => string | null;
  recoverLock: (lockPath: string, dead: CoreRecord, myToken: string, warn?: CoreWarn, onRecover?: (stage: string) => void, obs?: unknown) => string;
  GEN_PATTERN: RegExp;
  genName: (n: number) => string;
  GEN_OWNERLESS_GRACE_MS: number;
  GEN_TMP_MAX_AGE_MS: number;
  MACHINE_LOCK_ROOT_ENV: string;
  machineLockRootOf: (env?: Record<string, string | undefined>) => string;
  resolveGenDir: (lockPath: string, env?: Record<string, string | undefined>, obs?: unknown) => { genDir: string } | { unknown: MachineLockUnknown };
  genDirOf: (lockPath: string, env?: Record<string, string | undefined>) => string;
  byPathHash: (text: string) => string;
  recordGen: (record: unknown) => number | null;
  readHolder: (lockPath: string, options?: { ownerCodec?: CoreCodec }) => CoreRecord | null;
  machineLockAcquisition: (name: string, options: CoreAcquireOptions) => Generator<number, CoreLock, void>;
  acquireMachineLockSync: (name: string, options: CoreAcquireOptions) => CoreLock;
  releaseAsHead: (lockPath: string, tokens: string[], options?: CoreHeadOptions) => CoreHeadResult;
  recoverIfDead: (lockPath: string, options?: CoreHeadOptions) => CoreHeadResult;
}

const core = generatedCore as unknown as MachineLockSyncCore;

/** Ticket file names: 12 zero-padded digits, so lexical order is numeric order. */
export const MACHINE_LOCK_TICKET_PATTERN: RegExp = core.TICKET_PATTERN;
/** After its deadline a waiter never tries the mkdir; on this host others retire its ticket this much later. */
export const MACHINE_LOCK_SAME_HOST_GRACE_MS: number = core.SAME_HOST_GRACE_MS;
/** The same for a ticket from another host (clocks may differ). */
export const MACHINE_LOCK_OTHER_HOST_GRACE_MS: number = core.OTHER_HOST_GRACE_MS;
/** A live pid that started this much after the ticket was written is another process. */
export const MACHINE_LOCK_PID_REUSE_SLACK_MS: number = core.PID_REUSE_SLACK_MS;
/** An owner of 0 bytes older than this is taken out by the head (#4288 PR1a-f I4; fixed, PM decision 1). */
export const MACHINE_LOCK_EMPTY_OWNER_GRACE_MS: number = core.EMPTY_OWNER_GRACE_MS;
/** The suffix of a lock moved aside (`<lockPath>.gone-<S>`): what the three implementations write — no `.`, no `_`. */
export const MACHINE_LOCK_GONE_SUFFIX_PATTERN: RegExp = core.GONE_SUFFIX_PATTERN;
/**
 * #4558: a release that could not finish (the owner unreadable, or the delete failed) is tried again
 * this often, up to RELEASE_RETRY_LIMIT times (10 minutes — P0's bound). The holder is this live process,
 * so no head would ever recover the lock: without the retry it stayed held until the server stopped.
 */
const RELEASE_RETRY_MS = 5_000;
const RELEASE_RETRY_LIMIT = 120;

/** `<root>/<name>.queue`: the tickets of the waiters for `<name>.lock`. */
export function machineLockQueuePath(name: string, root: string): string {
  return core.queueDirOf(root, name);
}

export function machineLockTicketName(n: number): string {
  return core.ticketName(n);
}

/**
 * `ps -o etime=` (`[[dd-]hh:]mm:ss`) in milliseconds, or null. The ranges are checked (#4288 PR1a-f
 * F37: hours < 24, minutes and seconds < 60, a day field only with an hour field): a malformed answer is
 * null, never "just started".
 */
export function parseEtime(text: string): number | null {
  return core.parseEtime(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The core's warning to the logger: the event and the data the core attaches (the keys this module has
 * always logged — `code`, `lockPath`, `kept` …); a line without data is logged under its first word.
 */
function logWarning(line: string, data?: Record<string, unknown>): void {
  if (data && typeof data.event === 'string') {
    const { event, ...rest } = data;
    logger.warn(event, rest);
    return;
  }
  logger.warn(line.split(' ')[0], { line });
}

/**
 * Take the machine-wide lock named `name`, waiting up to `timeoutMs`.
 *
 * Never throws for the ordinary "someone else has it" case: the caller has to
 * report *not acquired* differently from *the gate failed*, and an exception
 * would collapse the two.
 *
 * Waiters are served in ticket order (Issue #4277); the steps are the core's
 * (machineLockAcquisition), and this waits `await`-ed between its polls.
 */
export async function acquireMachineLock(
  name: string,
  options: AcquireMachineLockOptions
): Promise<MachineLockResult> {
  const root = options.root ?? resolveMachineLockRoot();
  // The release's retries name a failure once (#4558): the lines of the later tries are not logged again.
  let retrying = false;
  const warn: CoreWarn = (line, data) => {
    if (retrying && /^machine-lock-release-(deferred|failed) /.test(line)) return;
    logWarning(line, data);
  };
  const steps = core.machineLockAcquisition(name, {
    root,
    timeoutMs: options.timeoutMs,
    pollMs: options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS,
    shouldAbandon: options.shouldAbandon,
    onWait: options.onWait,
    warn,
    hooks: options.__testHooks ?? {},
  });
  let step = steps.next();
  while (!step.done) {
    await sleep(step.value);
    step = steps.next();
  }
  const lock = step.value;
  if (!lock.acquired) {
    return {
      acquired: false,
      waitedMs: lock.waitedMs,
      heldBy: lock.heldBy,
      ...(lock.abandoned ? { abandoned: true } : {}),
      ...(lock.unknown ? { unknown: lock.unknown } : {}),
    };
  }
  // #4558: `released` is set only once the release is finished. A read of the owner that failed (EIO …)
  // or a delete that failed leaves the record of this live process, which no head recovers; it is tried
  // again every RELEASE_RETRY_MS instead of being taken as done.
  let released = false;
  let retries = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const attempt = (): boolean => {
    try {
      return lock.release() !== 'deferred';
    } catch {
      return false;
    }
  };
  const run = (): void => {
    retry = null;
    if (released) return;
    retrying = retries > 0;
    const done = attempt();
    retrying = false;
    if (done) {
      released = true;
      return;
    }
    if (retries >= RELEASE_RETRY_LIMIT) {
      released = true;
      logger.warn('machine-lock-release-abandoned', { lockPath: lock.path, tries: retries + 1 });
      return;
    }
    retries += 1;
    retry = setTimeout(run, RELEASE_RETRY_MS);
    retry.unref?.();
  };
  return {
    acquired: true,
    waitedMs: lock.waitedMs,
    handle: {
      name,
      path: lock.path,
      release: () => {
        // Once, and only while the record is still ours: a second call, or a call after the
        // lock was broken and re-taken while we ran, must not move a live holder's lock
        // (#4277, Codex review 2 finding 1). An owner that cannot be read is not known to
        // be ours, so it stays too (#4288) — and is read again later (#4558).
        if (released || retry !== null) return;
        run();
      },
    },
  };
}

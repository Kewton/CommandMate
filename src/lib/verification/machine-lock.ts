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
 * Three properties decide the implementation:
 *
 *   1. **It must hold across processes.** The lock exists because CommandMate's
 *      runner and the standalone `verify-run.sh` can be started independently
 *      against the same machine, so an in-process mutex would not be a lock at
 *      all. The path convention (`~/.commandmate/locks/<name>.lock`) is part of
 *      the contract, not an implementation detail — see
 *      docs/design/verification-config.md §9.
 *   2. **It must be portable.** macOS ships no `flock(1)`, so the primitive is
 *      `mkdir`, which is atomic on every POSIX filesystem and expressible in
 *      both bash and Node.
 *   3. **A crashed holder must not wedge the machine.** The owner record names
 *      the pid and host, so a lock left behind by a process that no longer
 *      exists is broken by the next waiter rather than blocking every future
 *      run until someone deletes a directory by hand.
 *   4. **Waiters are served in the order they came (Issue #4277).** A waiter
 *      takes a ticket (`<root>/<name>.queue/<12 digits>`, published with
 *      `link(2)`) and only the holder of the smallest live ticket tries the
 *      `mkdir`. Before, whoever polled first after a release won, and a long
 *      wait (merge-pr's precheck) was overtaken by gates that came later.
 *      scripts/orchestrate/machine-lock-sync.mjs is the synchronous copy of the
 *      same convention, and verify-run.sh (`lock_acquire`) the bash one
 *      (docs/design/merge-queue-fair-lock-4277.md §2).
 *   5. **Unknown never takes, deletes or releases (Issue #4288).** Every
 *      observation the decisions read — `kill -0`, an owner record, a directory
 *      listing, a `mkdir`, a `rename` — goes through `makeObserver` and answers
 *      in three values. "No" needs positive evidence (ESRCH, ENOENT, a listing
 *      that succeeded); EPERM, EACCES, EIO or a failed listing is unknown. A lock
 *      moved aside whose put-back failed (`<name>.lock.gone-<token>-<serial>`)
 *      is read as held while its record is alive or unreadable
 *      (docs/design/verify-lock-holder-group-4288.md §2.7 / §2.8).
 *
 * Server-only: reads and writes the filesystem.
 *
 * @module lib/verification/machine-lock
 */

import { spawnSync } from 'child_process';
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { homedir, hostname } from 'os';
import { basename, dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '@/lib/logger';

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

/** File inside the lock directory naming who holds it. */
const OWNER_FILE = 'owner';

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

interface LockOwner {
  pid: number;
  host: string;
  /** The holder's process group (merge-pr's inner process, #4277): alive while any member is. */
  pgid?: number;
  /**
   * Distinguishes this acquisition from any later one under the same name.
   *
   * Without it, a holder whose lock was broken as stale (because its pid looked
   * dead) would delete the *next* holder's directory when it eventually
   * released, handing the resource to two runs at once.
   */
  token: string;
  acquiredAt: number;
}

export interface MachineLockHandle {
  name: string;
  /** Absolute path of the lock directory, so a report can name it. */
  path: string;
  /** Idempotent; only removes the directory while this acquisition still owns it. */
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

/** The stages `onRecover` is called at (#4277; `restore-*` since #4288). */
export type MachineLockRecoverStage = 'before-move' | 'moved' | 'restore-mkdir' | 'restore-owner';

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
  /**
   * Inject a failure at an observation point (Issue #4288): answer an errno (`'EPERM'`, `'EACCES'`,
   * `'EIO'` …) for `point` / `target` and the observation fails with it, through the same
   * classification as a real failure.
   */
  fault?: (point: string, target: string) => string | null | undefined;
}

/** Ticket file names: 12 zero-padded digits, so lexical order is numeric order. */
export const MACHINE_LOCK_TICKET_PATTERN = /^\d{12}$/;
/** After its deadline a waiter never tries the mkdir; on this host others retire its ticket this much later. */
export const MACHINE_LOCK_SAME_HOST_GRACE_MS = 60_000;
/** The same for a ticket from another host (clocks may differ). */
export const MACHINE_LOCK_OTHER_HOST_GRACE_MS = 600_000;
/** A live pid that started this much after the ticket was written is another process. */
export const MACHINE_LOCK_PID_REUSE_SLACK_MS = 2_000;
const START_RECHECK_MS = 10_000;
const TEMP_MAX_AGE_MS = 3_600_000;
const LINK_TRIES_PER_POLL = 32;

/** `<root>/<name>.queue`: the tickets of the waiters for `<name>.lock`. */
export function machineLockQueuePath(name: string, root: string): string {
  return join(root, `${name}.queue`);
}

export function machineLockTicketName(n: number): string {
  return String(n).padStart(12, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readOwner(lockPath: string): LockOwner | null {
  // Either the holder has not written the record yet (it created the
  // directory microseconds ago) or the file is corrupt. Both mean "held by
  // someone we cannot identify", which is a reason to wait, never to break.
  const parsed = readJson(join(lockPath, OWNER_FILE));
  if (!parsed || typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
  return {
    pid: parsed.pid,
    host: typeof parsed.host === 'string' ? parsed.host : '',
    token: parsed.token,
    acquiredAt: typeof parsed.acquiredAt === 'number' ? parsed.acquiredAt : 0,
    ...(typeof parsed.pgid === 'number' ? { pgid: parsed.pgid } : {}),
  };
}

function describeOwner(owner: { pid: unknown; host?: unknown } | null): string | null {
  return owner ? `pid ${String(owner.pid)} on ${typeof owner.host === 'string' && owner.host ? owner.host : 'unknown host'}` : null;
}

/** `ps -o etime=` (`[[dd-]hh:]mm:ss`) in milliseconds, or null. */
export function parseEtime(text: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

function defaultStartOf(pid: number, now: number): number | null {
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const elapsed = parseEtime(r.stdout ?? '');
  return elapsed === null ? null : now - elapsed;
}

const validPgid = (pgid: unknown): pgid is number => Number.isInteger(pgid) && (pgid as number) > 1;

/**
 * A record's pgid can be judged: no `pgid` key (an older record — judged by its pid alone), or a
 * non-negative integer. Any other value (`-5`, `"x"`, `null`, `1.5`) is unknown (EINVAL), never "no
 * group": a dead runner's lock would be recovered past its live gate (#4288 Codex re-review P1).
 */
const pgidFieldOk = (record: object): boolean => {
  if (!Object.prototype.hasOwnProperty.call(record, 'pgid')) return true;
  const pgid = (record as { pgid?: unknown }).pgid;
  return Number.isInteger(pgid) && (pgid as number) >= 0;
};

/** The suffix of a lock moved aside (`<lockPath>.gone-<S>`): what the three implementations write — no `.`, no `_`. */
export const MACHINE_LOCK_GONE_SUFFIX_PATTERN = /^[A-Za-z0-9-]+$/;

const errCode = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code ? code : 'EUNKNOWN';
};

type Unknown = { state: 'unknown'; code: string };
type ProcessObs = { state: 'alive' } | { state: 'gone' } | { state: 'unknown'; point: string; code: string };
type ListObs = { state: 'listed'; names: string[] } | { state: 'absent' } | Unknown;
type LstatObs = { state: 'dir' } | { state: 'other' } | { state: 'absent' } | Unknown;
type OwnerObs = { state: 'record'; owner: LockOwner } | { state: 'missing' } | { state: 'corrupt' } | Unknown;
type MkdirObs = { state: 'created' } | { state: 'exists' } | Unknown;
type RenameObs = { state: 'moved' } | { state: 'absent' } | Unknown;
type RmdirObs = { state: 'removed' } | Unknown;
type CreateObs = { state: 'created' } | { state: 'exists' } | { state: 'unknown'; code: string; opened: boolean };

interface Observer {
  pid(point: string, pid: number): ProcessObs;
  group(point: string, pgid: number): ProcessObs;
  list(point: string, dir: string): ListObs;
  lstat(point: string, file: string): LstatObs;
  owner(point: string, dir: string): OwnerObs;
  mkdir(point: string, dir: string): MkdirObs;
  rename(point: string, from: string, to: string): RenameObs;
  rmdir(point: string, dir: string): RmdirObs;
  create(point: string, file: string, text: string): CreateObs;
}

function toOwner(parsed: unknown): LockOwner | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.pid !== 'number' || typeof p.token !== 'string') return null;
  return {
    pid: p.pid,
    host: typeof p.host === 'string' ? p.host : '',
    token: p.token,
    acquiredAt: typeof p.acquiredAt === 'number' ? p.acquiredAt : 0,
    ...(typeof p.pgid === 'number' ? { pgid: p.pgid } : {}),
  };
}

/**
 * The three-valued observations (Issue #4288 §2.8). Each takes its observation point's name first:
 * `hooks.fault(point, target)` may inject an errno there (tests only), and the classification is the
 * same for an injected and a real failure. The legacy boolean probes (`pidAlive` / `groupAlive`) are
 * read as alive / gone.
 */
function makeObserver(hooks: Pick<MachineLockTestHooks, 'fault' | 'pidAlive' | 'groupAlive'> = {}): Observer {
  const attempt = <T>(point: string, target: string, fn: () => T): T => {
    const code = hooks.fault?.(point, target);
    if (code) {
      const error: NodeJS.ErrnoException = new Error(`${code}: injected at ${point} ${target}`);
      error.code = code;
      throw error;
    }
    return fn();
  };
  const probe = (point: string, target: number, legacy: (() => boolean) | undefined): ProcessObs => {
    try {
      if (legacy) return attempt(point, String(target), () => (legacy() ? { state: 'alive' } : { state: 'gone' }));
      attempt(point, String(target), () => process.kill(target, 0));
      return { state: 'alive' };
    } catch (error) {
      return errCode(error) === 'ESRCH' ? { state: 'gone' } : { state: 'unknown', point, code: errCode(error) };
    }
  };
  const pidAliveHook = hooks.pidAlive;
  const groupAliveHook = hooks.groupAlive;
  return {
    pid: (point, pid) => probe(point, pid, pidAliveHook && (() => pidAliveHook(pid))),
    group: (point, pgid) => probe(point, -pgid, groupAliveHook && (() => groupAliveHook(pgid))),
    list(point, dir) {
      try {
        return { state: 'listed', names: attempt(point, dir, () => readdirSync(dir)) };
      } catch (error) {
        return errCode(error) === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', code: errCode(error) };
      }
    },
    lstat(point, file) {
      try {
        return { state: attempt(point, file, () => lstatSync(file)).isDirectory() ? 'dir' : 'other' };
      } catch (error) {
        return errCode(error) === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', code: errCode(error) };
      }
    },
    owner(point, dir) {
      const file = join(dir, OWNER_FILE);
      let text: string;
      try {
        text = attempt(point, file, () => readFileSync(file, 'utf8'));
      } catch (error) {
        return errCode(error) === 'ENOENT' ? { state: 'missing' } : { state: 'unknown', code: errCode(error) };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { state: 'corrupt' };
      }
      const owner = toOwner(parsed);
      if (!owner) return { state: 'corrupt' };
      // The pgid's number check is a step of this observation too (#4288 Codex re-review P1).
      return pgidFieldOk(parsed as object) ? { state: 'record', owner } : { state: 'unknown', code: 'EINVAL' };
    },
    mkdir(point, dir) {
      try {
        attempt(point, dir, () => mkdirSync(dir));
        return { state: 'created' };
      } catch (error) {
        return errCode(error) === 'EEXIST' ? { state: 'exists' } : { state: 'unknown', code: errCode(error) };
      }
    },
    rename(point, from, to) {
      try {
        attempt(point, from, () => renameSync(from, to));
        return { state: 'moved' };
      } catch (error) {
        return errCode(error) === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', code: errCode(error) };
      }
    },
    /**
     * The exclusive create of a file with `text` in it (#4288 PR1a D3, `O_CREAT|O_EXCL`): EEXIST is
     * "exists" (nothing opened); any other failure is unknown, with `opened` saying whether this call
     * made the file (only then is it the caller's to remove). The write fails at the point `owner-write`.
     */
    create(point, file, text) {
      let fd: number;
      try {
        fd = attempt(point, file, () => openSync(file, 'wx'));
      } catch (error) {
        return errCode(error) === 'EEXIST' ? { state: 'exists' } : { state: 'unknown', code: errCode(error), opened: false };
      }
      try {
        attempt('owner-write', file, () => writeSync(fd, text));
        return { state: 'created' };
      } catch (error) {
        return { state: 'unknown', code: errCode(error), opened: true };
      } finally {
        try {
          closeSync(fd);
        } catch {
          // closed or gone: nothing more to do
        }
      }
    },
    /** rmdir of an empty directory, whose failure keeps its errno (#4288 Codex re-review P2). */
    rmdir(point, dir) {
      try {
        attempt(point, dir, () => rmdirSync(dir));
        return { state: 'removed' };
      } catch (error) {
        return { state: 'unknown', code: errCode(error) };
      }
    },
  };
}

interface ProbeEnv {
  host: string;
  obs: Observer;
  startOf: (pid: number) => number | null;
  now: number;
}

/**
 * Whether the recorded holder is gone, in three values (Issue #4288 §2.8).
 *
 * Only decidable on the machine that wrote the record: a pid from another host
 * says nothing about a process here, and killing a lock on that guess would let
 * two machines sharing a network home run the gate at once. Pid reuse can make
 * a dead holder look alive, which only costs a wait — the safe direction. A
 * holder that named a process group (merge-pr, #4277; verify-run.sh's gate,
 * #4288) is alive while any process of the group is: a push its parent left
 * running still writes. Gone needs ESRCH from each probe; EPERM or any other
 * failure is unknown.
 */
function holderState(record: { pid?: unknown; host?: unknown; pgid?: unknown }, env: Pick<ProbeEnv, 'host' | 'obs'>): ProcessObs {
  if (record.host !== env.host || typeof record.pid !== 'number') return { state: 'alive' };
  const pid = env.obs.pid('pid', record.pid);
  if (pid.state !== 'gone') return pid;
  if (!pgidFieldOk(record)) return { state: 'unknown', point: 'group', code: 'EINVAL' };
  if (!validPgid(record.pgid)) return { state: 'gone' };
  return env.obs.group('group', record.pgid);
}

/** Why another waiter's ticket may be retired, or null (design §2.5) — never by age alone. */
function ticketRetirable(ticket: Record<string, unknown>, env: ProbeEnv): string | null {
  if (typeof ticket.token !== 'string') return null;
  const deadline = typeof ticket.deadline === 'number' ? ticket.deadline : null;
  if (ticket.host === env.host) {
    if (holderState(ticket, env).state === 'gone') return 'gone';
    if (typeof ticket.pid === 'number' && ticket.pid !== process.pid && typeof ticket.createdAt === 'number') {
      const start = env.startOf(ticket.pid);
      if (start !== null && start > ticket.createdAt + MACHINE_LOCK_PID_REUSE_SLACK_MS) return 'pid-reused';
    }
    if (deadline !== null && env.now > deadline + MACHINE_LOCK_SAME_HOST_GRACE_MS) return 'expired';
    return null;
  }
  if (deadline !== null && env.now > deadline + MACHINE_LOCK_OTHER_HOST_GRACE_MS) return 'expired';
  return null;
}

/**
 * Ticket numbers in the queue, ascending. With `obs` (the acquisition's own reads) a listing that
 * failed is null — unknown, never "no tickets" (#4288 §2.8); without it (garbage collection) a
 * failed listing reads as empty, which only ever leaves a ticket in place.
 */
function ticketNumbers(queueDir: string): number[];
function ticketNumbers(queueDir: string, obs: Observer): number[] | null;
function ticketNumbers(queueDir: string, obs?: Observer): number[] | null {
  let names: string[];
  if (obs) {
    const listed = obs.list('list-queue', queueDir);
    if (listed.state === 'unknown') return null;
    names = listed.state === 'listed' ? listed.names : [];
  } else {
    try {
      names = readdirSync(queueDir);
    } catch {
      return [];
    }
  }
  return names
    .filter((name) => MACHINE_LOCK_TICKET_PATTERN.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

interface QueueEntry {
  n: number;
  file: string;
  /** null: unreadable — it blocks like a live ticket and is never retired. */
  ticket: Record<string, unknown> | null;
}

/** The queue, or the unknown that kept it from being listed (never read as "no tickets"). */
function readQueue(queueDir: string, obs: Observer): { entries: QueueEntry[]; unknown?: MachineLockUnknown } {
  const numbers = ticketNumbers(queueDir, obs);
  if (numbers === null) {
    const listed = obs.list('list-queue', queueDir);
    return { entries: [], unknown: { point: 'list-queue', path: queueDir, code: listed.state === 'unknown' ? listed.code : 'EUNKNOWN' } };
  }
  return {
    entries: numbers.map((n) => {
      const file = join(queueDir, machineLockTicketName(n));
      return { n, file, ticket: readJson(file) };
    }),
  };
}

/** Mark a ticket used, if it is still `token`'s, by renaming a `{done:true}` record over it. */
function markDone(file: string, token: string): boolean {
  const current = readJson(file);
  if (!current || current.token !== token || current.done === true) return false;
  const tmp = join(dirname(file), `.d-${token}-${randomUUID()}`);
  try {
    writeFileSync(tmp, JSON.stringify({ done: true, token, doneAt: Date.now() }));
    renameSync(tmp, file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

/**
 * Publish a ticket at max+1 with `link` (refuses an existing name) and withdraw
 * it when a larger number exists — it was published late (design §2.2).
 */
function takeTicket(
  queueDir: string,
  content: Record<string, unknown> & { token: string },
  link: (src: string, dst: string) => void,
  obs: Observer,
  beforeLink?: (n: number) => void
): number | null {
  mkdirSync(queueDir, { recursive: true });
  const tmp = join(queueDir, `.t-${content.token}`);
  writeFileSync(tmp, JSON.stringify(content));
  try {
    for (let tries = 0; tries < LINK_TRIES_PER_POLL; tries++) {
      const numbers = ticketNumbers(queueDir, obs);
      if (numbers === null) return null;
      const n = (numbers.length > 0 ? numbers[numbers.length - 1] : 0) + 1;
      beforeLink?.(n);
      const file = join(queueDir, machineLockTicketName(n));
      try {
        link(tmp, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      // A listing that failed after the link cannot show the ticket is not late: withdraw it.
      const after = ticketNumbers(queueDir, obs);
      if (after === null || after.some((k) => k > n)) {
        markDone(file, content.token);
        continue;
      }
      return n;
    }
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Delete used tickets below the largest number; the largest stays so a late ticket always sees a larger one. */
function collectGarbage(queueDir: string, now: number): void {
  const numbers = ticketNumbers(queueDir);
  const max = numbers.length > 0 ? numbers[numbers.length - 1] : 0;
  for (const n of numbers) {
    if (n >= max) continue;
    const file = join(queueDir, machineLockTicketName(n));
    if (readJson(file)?.done === true) rmSync(file, { force: true });
  }
  let names: string[];
  try {
    names = readdirSync(queueDir);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.startsWith('.t-') || entry.startsWith('.d-'))) {
    const file = join(queueDir, name);
    try {
      if (now - statSync(file).mtimeMs > TEMP_MAX_AGE_MS) rmSync(file, { force: true });
    } catch {
      // gone meanwhile
    }
  }
}

/**
 * @returns true when this call created the directory and now owns it. A `mkdir` that failed for
 * another reason than EEXIST is neither a claim nor a contention: it throws, naming the errno.
 */
function claim(
  lockPath: string,
  owner: LockOwner,
  obs: Observer,
  fault?: MachineLockTestHooks['fault']
): boolean {
  const made = obs.mkdir('mkdir-lock', lockPath);
  if (made.state === 'exists') return false;
  if (made.state !== 'created') {
    const error: NodeJS.ErrnoException = new Error(`machine-lock-unknown point=mkdir-lock path=${lockPath} errno=${made.code}`);
    error.code = made.code;
    throw error;
  }
  // The owner is created exclusively and read back (#4288 PR1a D3 — the same rule as
  // machine-lock-sync.mjs's claim and verify-run.sh's lock_obs_create): a name that is there (EEXIST)
  // is never written over and nothing is removed; a record read back that is not this one is not
  // acquired and nothing is removed. An owner that could not be created, written or read back
  // (ENOSPC, EIO) is not a lock taken: the owner is removed only when this call opened it, and the
  // <lock> this mkdir made is taken out again, so no <lock> without an owner is left for every reader
  // to wait on (#4288 PM review P3-2). That error still ends the acquisition, as a mkdir that failed
  // does. Test seams (`fault`): owner-create, owner-write, owner-readback, owner-unlink, lock-rmdir.
  const file = join(lockPath, OWNER_FILE);
  const created = obs.create('owner-create', file, JSON.stringify(owner));
  if (created.state === 'exists') {
    logger.warn('machine-lock-owner-exists', { lockPath });
    return false;
  }
  let failed: { point: string; code: string; opened: boolean } | null =
    created.state === 'unknown' ? { point: 'owner-create', code: created.code, opened: created.opened } : null;
  if (!failed) {
    const back = obs.owner('owner-readback', lockPath);
    if (back.state === 'record' && back.owner.token === owner.token) return true;
    if (back.state !== 'unknown') {
      logger.warn('machine-lock-owner-not-ours', { lockPath });
      return false;
    }
    failed = { point: 'owner-readback', code: back.code, opened: true };
  }
  if (failed.opened && !fault?.('owner-unlink', file)) rmSync(file, { force: true });
  const out = fault?.('lock-rmdir', lockPath) ? false : rmdirQuiet(lockPath);
  logger.warn('machine-lock-owner-write-failed', { lockPath, code: failed.code, takenOut: out });
  const error: NodeJS.ErrnoException = new Error(`machine-lock-unknown point=${failed.point} path=${file} errno=${failed.code}`);
  error.code = failed.code;
  throw error;
}

let goneSerial = 0;

/** rmdir, which only ever removes an empty directory; a failure leaves it as it was (false). */
function rmdirQuiet(dir: string): boolean {
  try {
    rmdirSync(dir);
    return true;
  } catch {
    // not empty, gone, or not ours to remove: left as it is
    return false;
  }
}

interface GoneContext {
  root: string;
  lockPath: string;
  host: string;
  obs: Observer;
  myToken: string;
  warnOnce: (event: string, data: Record<string, unknown>) => void;
  onRecover?: (stage: MachineLockRecoverStage) => void;
}

/**
 * The locks moved aside for `ctx.lockPath` (§2.7 退避名の識別): `<name>.lock.gone-<S>` where S has no
 * `.` or `_` and the entry is a directory (not a symlink). A listing or lstat that failed is unknown.
 */
function goneCandidates(ctx: GoneContext, point: string): { list: string[]; unknown?: MachineLockUnknown } {
  const listed = ctx.obs.list(point, ctx.root);
  if (listed.state === 'absent') return { list: [] };
  if (listed.state === 'unknown') return { list: [], unknown: { point, path: ctx.root, code: listed.code } };
  const prefix = `${basename(ctx.lockPath)}.gone-`;
  const list: string[] = [];
  for (const entry of listed.names) {
    if (!entry.startsWith(prefix) || !MACHINE_LOCK_GONE_SUFFIX_PATTERN.test(entry.slice(prefix.length))) continue;
    const file = join(ctx.root, entry);
    const st = ctx.obs.lstat('gone-lstat', file);
    if (st.state === 'unknown') return { list: [], unknown: { point: 'gone-lstat', path: file, code: st.code } };
    if (st.state === 'dir') list.push(file);
  }
  return { list };
}

type HalfPutBack = { state: 'yes' | 'no' | 'absent' } | { state: 'unknown'; unknown: MachineLockUnknown };

/** `<lock>` exists with no owner and nothing in it — a put-back stopped half way (§2.7 A / B). */
function ownerlessEmptyLock(ctx: GoneContext): HalfPutBack {
  const ownerFile = join(ctx.lockPath, OWNER_FILE);
  const owner = ctx.obs.owner('lock-owner', ctx.lockPath);
  if (owner.state === 'unknown') return { state: 'unknown', unknown: { point: 'lock-owner', path: ownerFile, code: owner.code } };
  if (owner.state !== 'missing') return { state: 'no' };
  const listed = ctx.obs.list('lock-list', ctx.lockPath);
  if (listed.state === 'absent') return { state: 'absent' };
  if (listed.state === 'unknown') return { state: 'unknown', unknown: { point: 'lock-list', path: ctx.lockPath, code: listed.code } };
  return { state: listed.names.length === 0 ? 'yes' : 'no' };
}

/**
 * Move a moved-aside owner back into `<lock>` and drop the moved-aside directory. ENOENT is 'absent';
 * any other failure takes out the (empty) `<lock>` again and keeps the moved-aside directory (§2.7 B).
 */
function moveOwnerIn(ctx: GoneContext, gone: string): 'restored' | 'absent' | 'restore-failed' {
  const moved = ctx.obs.rename('restore-rename', join(gone, OWNER_FILE), join(ctx.lockPath, OWNER_FILE));
  if (moved.state === 'moved') {
    ctx.onRecover?.('restore-owner');
    rmSync(gone, { recursive: true, force: true });
    return 'restored';
  }
  if (moved.state === 'absent') return 'absent';
  rmdirQuiet(ctx.lockPath);
  logger.warn('machine-lock-restore-failed', { lockPath: ctx.lockPath, kept: gone, code: moved.code });
  return 'restore-failed';
}

/** §2.7 rows 2, 3 and 5: a moved-aside record that is alive (or not known to be gone) is put back. */
function restoreFromGone(ctx: GoneContext, gone: string): void {
  const made = ctx.obs.mkdir('restore-mkdir', ctx.lockPath);
  if (made.state === 'created') {
    ctx.onRecover?.('restore-mkdir');
    const r = moveOwnerIn(ctx, gone);
    if (r === 'absent') rmdirQuiet(ctx.lockPath);
    if (r === 'restored') logger.warn('machine-lock-restored', { lockPath: ctx.lockPath, from: gone });
    return;
  }
  if (made.state === 'exists') {
    const half = ownerlessEmptyLock(ctx).state;
    if (half === 'yes') {
      if (moveOwnerIn(ctx, gone) === 'restored') logger.warn('machine-lock-restored', { lockPath: ctx.lockPath, from: gone, completed: true });
    } else if (half === 'no') {
      ctx.warnOnce('machine-lock-restore-failed', { lockPath: ctx.lockPath, kept: gone, reason: 'the lock holds another record' });
    }
    return;
  }
  ctx.warnOnce('machine-lock-restore-failed', { lockPath: ctx.lockPath, kept: gone, code: made.code });
}

/**
 * §2.7 rows 4 and 7: a moved-aside record judged gone (or this acquisition's own) is moved to this
 * waiter's own name and deleted only when it is still the record judged. `takeBackHalf` first removes
 * a `<lock>` left empty by a put-back that stopped half way (never on release). When that cannot be
 * settled — whether `<lock>` is such a half put-back is unknown, or its rmdir failed — the moved-aside
 * record is KEPT (`kept`): it is the only trace that lets a later head take the empty `<lock>` back
 * once the fault clears (#4288 Codex 5-2b P2-1). Either way the reason — point, path, errno — goes
 * with it (a failed rmdir as `reclaim-rmdir`), so the timeout names it (#4288 Codex re-review P2).
 */
function reclaimGone(ctx: GoneContext, gone: string, token: string, takeBackHalf: boolean): { kept: boolean; unknown?: MachineLockUnknown } {
  if (takeBackHalf) {
    const half = ownerlessEmptyLock(ctx);
    if (half.state === 'unknown') return { kept: true, unknown: half.unknown };
    if (half.state === 'yes') {
      // A failed rmdir carries its reason like an unknown observation (#4288 Codex re-review P2).
      const removed = ctx.obs.rmdir('reclaim-rmdir', ctx.lockPath);
      if (removed.state === 'unknown') return { kept: true, unknown: { point: 'reclaim-rmdir', path: ctx.lockPath, code: removed.code } };
    }
  }
  const mine = `${ctx.lockPath}.gone-${ctx.myToken}-${++goneSerial}`;
  if (ctx.obs.rename('reclaim-rename', gone, mine).state !== 'moved') return { kept: false };
  const moved = ctx.obs.owner('reclaim-owner', mine);
  if (moved.state === 'record' && moved.owner.token === token) {
    rmSync(mine, { recursive: true, force: true });
    logger.warn('machine-lock-gone-recovered', { gone, pid: moved.owner.pid });
  }
  return { kept: false };
}

/** §2.7: the head's pass over the locks moved aside, before its mkdir. */
function settleGone(ctx: GoneContext): { block: boolean; pending?: string; unknown?: MachineLockUnknown } {
  const found = goneCandidates(ctx, 'list-root');
  if (found.unknown) {
    ctx.warnOnce('machine-lock-gone-unreadable', { gone: found.unknown.path, code: found.unknown.code });
    return { block: true, pending: `${found.unknown.path} unreadable`, unknown: found.unknown };
  }
  let result: { block: boolean; pending?: string; unknown?: MachineLockUnknown } = { block: false };
  const hold = (pending: string, unknown?: MachineLockUnknown): void => {
    if (!result.block) result = { block: true, pending, unknown };
    else if (unknown && !result.unknown) result.unknown = unknown;
  };
  for (const gone of found.list) {
    const read = ctx.obs.owner('gone-owner', gone);
    if (read.state === 'unknown') {
      ctx.warnOnce('machine-lock-gone-unreadable', { gone, code: read.code });
      hold(`${gone} unreadable`, { point: 'gone-owner', path: join(gone, OWNER_FILE), code: read.code });
      continue;
    }
    if (read.state === 'missing') {
      rmdirQuiet(gone);
      continue;
    }
    if (read.state === 'corrupt') continue;
    const holder = holderState(read.owner, ctx);
    if (holder.state === 'gone') {
      const reclaimed = reclaimGone(ctx, gone, read.owner.token, true);
      if (reclaimed.kept) hold(gone, reclaimed.unknown);
      continue;
    }
    hold(gone, holder.state === 'unknown' ? { point: holder.point, path: gone, code: holder.code } : undefined);
    restoreFromGone(ctx, gone);
  }
  return result;
}

/** §2.7 row 7: this acquisition's own records left in moved-aside directories go when it releases. */
function cleanupOwnGone(ctx: GoneContext, token: string): void {
  const found = goneCandidates(ctx, 'release-list');
  if (found.unknown) {
    logger.warn('machine-lock-gone-unreadable', { gone: found.unknown.path, code: found.unknown.code });
    return;
  }
  for (const gone of found.list) {
    const read = ctx.obs.owner('gone-owner', gone);
    if (read.state === 'record' && read.owner.token === token) reclaimGone(ctx, gone, token, false);
  }
}

/**
 * Recover a lock whose recorded holder is gone (design §2.4): move it aside,
 * then read what was moved. Only the very record judged dead is deleted; a lock
 * an old-version cleaner let someone take meanwhile, or a record rewritten under
 * a new token (verify-run.sh publishing its gate's group, #4288 §2.2), is put
 * back, never over a lock taken in between. A put-back that cannot finish keeps
 * the moved-aside directory, which the next head reads as held while its record
 * lives (§2.7).
 */
function breakStale(
  lockPath: string,
  owner: LockOwner,
  myToken: string,
  obs: Observer,
  onRecover?: (stage: MachineLockRecoverStage) => void
): 'recovered' | 'restored' | 'restore-failed' | 'gone' | 'unknown' {
  const gone = `${lockPath}.gone-${myToken}-${++goneSerial}`;
  onRecover?.('before-move');
  const aside = obs.rename('rename-aside', lockPath, gone);
  // Someone else broke or re-took it first (ENOENT), or the move is not known to have happened.
  if (aside.state !== 'moved') return aside.state === 'absent' ? 'gone' : 'unknown';
  onRecover?.('moved');
  const moved = obs.owner('recover-owner', gone);
  if (moved.state === 'record' && moved.owner.token === owner.token) {
    rmSync(gone, { recursive: true, force: true });
    logger.warn('machine-lock-broken-stale', { lockPath, pid: owner.pid });
    return 'recovered';
  }
  const made = obs.mkdir('restore-mkdir', lockPath);
  if (made.state !== 'created') {
    logger.warn('machine-lock-restore-failed', { lockPath, kept: gone });
    return 'restore-failed';
  }
  onRecover?.('restore-mkdir');
  const back = obs.rename('restore-rename', join(gone, OWNER_FILE), join(lockPath, OWNER_FILE));
  if (back.state === 'unknown') {
    rmdirQuiet(lockPath);
    logger.warn('machine-lock-restore-failed', { lockPath, kept: gone, code: back.code });
    return 'restore-failed';
  }
  // ENOENT: the moved lock had no owner yet — its holder writes it into the restored path.
  if (back.state === 'moved') onRecover?.('restore-owner');
  rmSync(gone, { recursive: true, force: true });
  return 'restored';
}

/**
 * Take the machine-wide lock named `name`, waiting up to `timeoutMs`.
 *
 * Never throws for the ordinary "someone else has it" case: the caller has to
 * report *not acquired* differently from *the gate failed*, and an exception
 * would collapse the two.
 *
 * Waiters are served in ticket order (Issue #4277): only the holder of the
 * smallest live ticket tries the `mkdir`, and only it recovers a dead holder's
 * lock. A waiter never tries the `mkdir` without a ticket.
 */
export async function acquireMachineLock(
  name: string,
  options: AcquireMachineLockOptions
): Promise<MachineLockResult> {
  const hooks = options.__testHooks ?? {};
  const now = hooks.now ?? (() => Date.now());
  const host = hooks.host ?? hostname();
  const root = options.root ?? resolveMachineLockRoot();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  const lockPath = machineLockPath(name, root);
  const queueDir = machineLockQueuePath(name, root);
  const startedAt = now();
  const deadline = startedAt + Math.max(0, options.timeoutMs);
  const token = randomUUID();
  const startCache = new Map<number, { start: number | null; at: number }>();
  const obs = makeObserver({ fault: hooks.fault, pidAlive: hooks.pidAlive, groupAlive: hooks.groupAlive });
  const probes = {
    host,
    obs,
    startOf: (pid: number): number | null => {
      if (hooks.startOf) return hooks.startOf(pid);
      const cached = startCache.get(pid);
      if (cached && now() - cached.at < START_RECHECK_MS) return cached.start;
      const start = defaultStartOf(pid, now());
      startCache.set(pid, { start, at: now() });
      return start;
    },
  };
  const warned = new Set<string>();
  const ctx: GoneContext = {
    root,
    lockPath,
    host,
    obs,
    myToken: token,
    onRecover: hooks.onRecover,
    warnOnce: (event, data) => {
      const key = `${event} ${JSON.stringify(data)}`;
      if (warned.has(key)) return;
      warned.add(key);
      logger.warn(event, data);
    },
  };
  const link = hooks.link ?? ((src: string, dst: string) => linkSync(src, dst));
  const ticket = { pid: process.pid, host, token, createdAt: startedAt, deadline };

  mkdirSync(root, { recursive: true });

  // A stale record is broken at most once per token, so a directory nobody can
  // remove degrades into ordinary waiting instead of a spin loop.
  const broken = new Set<string>();
  let waiting = false;
  let mine: number | null = null;
  let blocker: QueueEntry | null = null;
  let pending: string | null = null;
  let unknown: MachineLockUnknown | null = null;
  const mineFile = (): string => join(queueDir, machineLockTicketName(mine as number));
  const retire = (): void => {
    if (mine !== null) markDone(mineFile(), token);
    mine = null;
  };
  const heldBy = (): string | null => {
    const owner = readOwner(lockPath);
    // The gate's group (#4288): with verify-run.sh's runner killed, the pid is dead and the group holds.
    if (owner) return `${describeOwner(owner)}${validPgid(owner.pgid) ? ` (pgid ${owner.pgid})` : ''}`;
    if (blocker) {
      return `queue ticket ${blocker.file}${blocker.ticket ? ` (${describeOwner(blocker.ticket as { pid: unknown; host?: unknown })})` : ' (unreadable)'}`;
    }
    if (pending) return `restore pending: ${pending}`;
    if (unknown) return `unknown ${unknown.point} ${unknown.path} ${unknown.code}`;
    return null;
  };
  const gaveUp = (): { unknown?: MachineLockUnknown } => {
    if (!unknown) return {};
    logger.warn('machine-lock-unknown', { point: unknown.point, path: unknown.path, errno: unknown.code });
    return { unknown };
  };

  try {
    for (;;) {
      // Issue #2063. Checked before the claim as well as after the sleep, so a
      // caller that was already cancelled when it got here never takes a lock it
      // is only going to release.
      if (options.shouldAbandon?.()) {
        retire();
        return { acquired: false, waitedMs: now() - startedAt, heldBy: heldBy(), abandoned: true };
      }

      if (mine !== null) {
        const current = readJson(mineFile());
        if (!current || current.done === true || current.token !== token) {
          logger.warn('machine-lock-ticket-lost', { ticket: mineFile() });
          mine = null;
        }
      }
      blocker = null;
      pending = null;
      unknown = null;
      if (mine === null) {
        mine = takeTicket(queueDir, ticket, link, obs, hooks.beforeLink);
        // No ticket this poll: say so when it was the listing that failed.
        if (mine === null) unknown = readQueue(queueDir, obs).unknown ?? null;
      }

      if (mine !== null) {
        const judged: ProbeEnv = { ...probes, now: now() };
        const queue = readQueue(queueDir, obs);
        if (queue.unknown) unknown = queue.unknown;
        for (const entry of queue.entries) {
          if (entry.n >= mine) break;
          if (entry.ticket !== null && entry.ticket.done === true) continue;
          const why = entry.ticket ? ticketRetirable(entry.ticket, judged) : null;
          if (why && entry.ticket) {
            if (markDone(entry.file, entry.ticket.token as string)) {
              logger.warn('machine-lock-ticket-retired', { ticket: entry.file, why });
            }
            continue;
          }
          blocker = entry;
          break;
        }

        if (!blocker && !queue.unknown) {
          const settled = settleGone(ctx);
          if (settled.block) {
            pending = settled.pending ?? null;
            unknown = settled.unknown ?? null;
          } else {
            const owner: LockOwner = { pid: process.pid, host, token, acquiredAt: now() };
            if (claim(lockPath, owner, obs, hooks.fault)) {
              retire();
              collectGarbage(queueDir, now());
              let released = false;
              return {
                acquired: true,
                waitedMs: now() - startedAt,
                handle: {
                  name,
                  path: lockPath,
                  release: () => {
                    // Once, and only while the record is still ours: a second call, or a call after the
                    // lock was broken and re-taken while we ran, must not move a live holder's lock
                    // (#4277, Codex review 2 finding 1). An owner that cannot be read is not known to
                    // be ours, so it stays too (#4288).
                    if (released) return;
                    released = true;
                    const current = obs.owner('release-owner', lockPath);
                    if (current.state === 'unknown') {
                      logger.warn('machine-lock-release-deferred', { lockPath, point: 'release-owner', errno: current.code });
                      return;
                    }
                    if (current.state !== 'record' || current.owner.token !== token) {
                      cleanupOwnGone(ctx, token);
                      return;
                    }
                    try {
                      rmSync(lockPath, { recursive: true, force: true });
                    } catch (error) {
                      logger.warn('machine-lock-release-failed', {
                        lockPath,
                        error: error instanceof Error ? error.message : String(error),
                      });
                    }
                  },
                },
              };
            }

            const read = obs.owner('lock-owner', lockPath);
            if (read.state === 'unknown') unknown = { point: 'lock-owner', path: join(lockPath, OWNER_FILE), code: read.code };
            const holder = read.state === 'record' ? read.owner : null;
            if (holder && !broken.has(holder.token)) {
              const state = holderState(holder, probes);
              if (state.state === 'gone') {
                broken.add(holder.token);
                breakStale(lockPath, holder, token, obs, hooks.onRecover);
                continue;
              }
              if (state.state === 'unknown') unknown = { point: state.point, path: lockPath, code: state.code };
            }
          }
        }
      }

      const t = now();
      if (t >= deadline) {
        retire();
        return { acquired: false, waitedMs: t - startedAt, heldBy: heldBy(), ...gaveUp() };
      }
      if (!waiting) {
        waiting = true;
        options.onWait?.();
      }
      await sleep(Math.min(pollIntervalMs, deadline - t));
    }
  } catch (error) {
    retire();
    throw error;
  }
}

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
 *
 * Server-only: reads and writes the filesystem.
 *
 * @module lib/verification/machine-lock
 */

import { spawnSync } from 'child_process';
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir, hostname } from 'os';
import { dirname, join } from 'path';
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
    };

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
  onRecover?: (stage: 'before-move' | 'moved') => void;
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

/** EPERM is alive (another user's process); only ESRCH is gone. */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function defaultGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
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

interface ProbeEnv {
  host: string;
  pidAlive: (pid: number) => boolean;
  groupAlive: (pgid: number) => boolean;
  startOf: (pid: number) => number | null;
  now: number;
}

/**
 * Whether the recorded holder is gone.
 *
 * Only decidable on the machine that wrote the record: a pid from another host
 * says nothing about a process here, and killing a lock on that guess would let
 * two machines sharing a network home run the gate at once. Pid reuse can make
 * a dead holder look alive, which only costs a wait — the safe direction. A
 * holder that named a process group (merge-pr, #4277) is alive while any
 * process of the group is: a push its parent left running still writes.
 */
function holderGone(record: { pid?: unknown; host?: unknown; pgid?: unknown }, env: Omit<ProbeEnv, 'now' | 'startOf'>): boolean {
  if (record.host !== env.host || typeof record.pid !== 'number') return false;
  if (env.pidAlive(record.pid)) return false;
  return !validPgid(record.pgid) || !env.groupAlive(record.pgid);
}

/** Why another waiter's ticket may be retired, or null (design §2.5) — never by age alone. */
function ticketRetirable(ticket: Record<string, unknown>, env: ProbeEnv): string | null {
  if (typeof ticket.token !== 'string') return null;
  const deadline = typeof ticket.deadline === 'number' ? ticket.deadline : null;
  if (ticket.host === env.host) {
    if (holderGone(ticket, env)) return 'gone';
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

function ticketNumbers(queueDir: string): number[] {
  let names: string[];
  try {
    names = readdirSync(queueDir);
  } catch {
    return [];
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

function listQueue(queueDir: string): QueueEntry[] {
  return ticketNumbers(queueDir).map((n) => {
    const file = join(queueDir, machineLockTicketName(n));
    return { n, file, ticket: readJson(file) };
  });
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
  beforeLink?: (n: number) => void
): number | null {
  mkdirSync(queueDir, { recursive: true });
  const tmp = join(queueDir, `.t-${content.token}`);
  writeFileSync(tmp, JSON.stringify(content));
  try {
    for (let tries = 0; tries < LINK_TRIES_PER_POLL; tries++) {
      const numbers = ticketNumbers(queueDir);
      const n = (numbers.length > 0 ? numbers[numbers.length - 1] : 0) + 1;
      beforeLink?.(n);
      const file = join(queueDir, machineLockTicketName(n));
      try {
        link(tmp, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      if (ticketNumbers(queueDir).some((k) => k > n)) {
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

/** @returns true when this call created the directory and now owns it */
function claim(lockPath: string, owner: LockOwner): boolean {
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  writeFileSync(join(lockPath, OWNER_FILE), JSON.stringify(owner), { encoding: 'utf8' });
  return true;
}

let goneSerial = 0;

/**
 * Recover a lock whose recorded holder is gone (design §2.4): move it aside,
 * then read what was moved. Only the very record judged dead is deleted; a lock
 * an old-version cleaner let someone take meanwhile is put back, never over a
 * lock taken in between.
 */
function breakStale(
  lockPath: string,
  owner: LockOwner,
  myToken: string,
  onRecover?: (stage: 'before-move' | 'moved') => void
): void {
  const gone = `${lockPath}.gone-${myToken}-${++goneSerial}`;
  onRecover?.('before-move');
  try {
    renameSync(lockPath, gone);
  } catch {
    // Someone else broke or re-took it first; the next attempt sorts it out.
    return;
  }
  onRecover?.('moved');
  const moved = readOwner(gone);
  if (moved && moved.token === owner.token) {
    rmSync(gone, { recursive: true, force: true });
    logger.warn('machine-lock-broken-stale', { lockPath, pid: owner.pid });
    return;
  }
  try {
    mkdirSync(lockPath);
  } catch {
    logger.warn('machine-lock-restore-failed', { lockPath, kept: gone });
    return;
  }
  try {
    renameSync(join(gone, OWNER_FILE), join(lockPath, OWNER_FILE));
  } catch {
    // The moved lock had no owner yet: its holder writes it into the restored path.
  }
  rmSync(gone, { recursive: true, force: true });
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
  const probes = {
    host,
    pidAlive: hooks.pidAlive ?? defaultPidAlive,
    groupAlive: hooks.groupAlive ?? defaultGroupAlive,
    startOf: (pid: number): number | null => {
      if (hooks.startOf) return hooks.startOf(pid);
      const cached = startCache.get(pid);
      if (cached && now() - cached.at < START_RECHECK_MS) return cached.start;
      const start = defaultStartOf(pid, now());
      startCache.set(pid, { start, at: now() });
      return start;
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
  const mineFile = (): string => join(queueDir, machineLockTicketName(mine as number));
  const retire = (): void => {
    if (mine !== null) markDone(mineFile(), token);
    mine = null;
  };
  const heldBy = (): string | null => {
    const owner = readOwner(lockPath);
    if (owner) return describeOwner(owner);
    if (blocker) {
      return `queue ticket ${blocker.file}${blocker.ticket ? ` (${describeOwner(blocker.ticket as { pid: unknown; host?: unknown })})` : ' (unreadable)'}`;
    }
    return null;
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
      if (mine === null) mine = takeTicket(queueDir, ticket, link, hooks.beforeLink);

      blocker = null;
      if (mine !== null) {
        const judged: ProbeEnv = { ...probes, now: now() };
        for (const entry of listQueue(queueDir)) {
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

        if (!blocker) {
          const owner: LockOwner = { pid: process.pid, host, token, acquiredAt: now() };
          if (claim(lockPath, owner)) {
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
                  // Once, and only while the record is still ours: a second call, or a
                  // call after the lock was broken and re-taken while we ran, must not
                  // move a live holder's lock (#4277, Codex review 2 finding 1).
                  if (released) return;
                  released = true;
                  if (readOwner(lockPath)?.token !== token) return;
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

          const holder = readOwner(lockPath);
          if (holder && !broken.has(holder.token) && holderGone(holder, probes)) {
            broken.add(holder.token);
            breakStale(lockPath, holder, token, hooks.onRecover);
            continue;
          }
        }
      }

      const t = now();
      if (t >= deadline) {
        retire();
        return { acquired: false, waitedMs: t - startedAt, heldBy: heldBy() };
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

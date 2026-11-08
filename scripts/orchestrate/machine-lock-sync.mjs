/**
 * The machine-wide lock with first-come tickets, synchronously (Issue #4277).
 *
 * The same convention as src/lib/verification/machine-lock.ts — the two must
 * agree byte for byte on paths and record shapes, or they stop excluding each
 * other (docs/design/verification-config.md §9.2, docs/design/merge-queue-fair-lock-4277.md §2):
 *
 *   <root>/<name>.lock/owner       the lock: `mkdir` is the exclusion, `owner` names the holder
 *   <root>/<name>.queue/<12 digits> a ticket: who may try the `mkdir`, in the order taken
 *   <root>/<name>.lock.gone-<token> a lock moved aside while a dead holder's is recovered
 *
 * Before #4277 every waiter polled `mkdir` and the first to see the lock free
 * took it, so a long wait (merge-pr's precheck, 5400 s budget) was overtaken
 * again and again by a verify gate that came later (2026-11-08, 67 of 109
 * minutes). Now a waiter takes a ticket first, and only the waiter holding the
 * smallest live ticket tries the `mkdir`. A ticket is never taken twice
 * (`link(2)` refuses an existing name, the largest number is never deleted and a
 * ticket published late is withdrawn), and there is no path to the `mkdir`
 * without a ticket.
 *
 * scripts/orchestrate/*.mjs do not import src/ TypeScript, which is why this
 * is a copy: precheck.mjs (cpu.heavy) and merge-pr.mjs (the merge lock) run
 * synchronously under spawnSync.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LOCK_POLL_MS = 250;
/** Ticket file names: 12 zero-padded digits, so lexical order is numeric order (bash `ls` agrees). */
export const TICKET_PATTERN = /^\d{12}$/;
/** After its own deadline a waiter never tries the mkdir; others may retire its ticket this much later. */
export const SAME_HOST_GRACE_MS = 60_000;
/** A ticket from another host: its clock may differ, so the grace is longer. */
export const OTHER_HOST_GRACE_MS = 600_000;
/** A live pid whose process started this much after the ticket was written is another process (pid reuse). */
export const PID_REUSE_SLACK_MS = 2_000;
/** How long a `ps` answer about a pid's start is trusted before it is asked again. */
const START_RECHECK_MS = 10_000;
/** Temporary files older than this are left by a process that died mid-write. */
const TEMP_MAX_AGE_MS = 3_600_000;
/** Link attempts per poll: contention past this waits a poll instead of spinning. */
const LINK_TRIES_PER_POLL = 32;

export const ticketName = (n) => String(n).padStart(12, '0');
export const lockPathOf = (root, name) => path.join(root, `${name}.lock`);
export const queueDirOf = (root, name) => path.join(root, `${name}.queue`);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/** `ps -o etime=`: `[[dd-]hh:]mm:ss` → milliseconds, or null. */
export function parseEtime(text) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** When `pid` started (ms since epoch), from `ps -o etime=`; null when ps cannot say. */
export function processStartMs(pid, now = Date.now()) {
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const elapsed = parseEtime(r.stdout);
  return elapsed === null ? null : now - elapsed;
}

/** EPERM is alive (someone else's process); only ESRCH is gone. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

/** Whether any process is left in the group `pgid` (merge-pr's inner process and its git / gh children). */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

const validPgid = (pgid) => Number.isInteger(pgid) && pgid > 1;

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The lock's owner record, or null while it is unreadable (just created, or corrupt: wait, never break). */
export function readOwner(lockPath) {
  const owner = readJson(path.join(lockPath, 'owner'));
  return owner && typeof owner.pid === 'number' && typeof owner.token === 'string' ? owner : null;
}

export const describeOwner = (owner) => (owner ? `pid ${owner.pid} on ${owner.host || 'unknown host'}` : null);

/** Ticket numbers in the queue, ascending. */
function ticketNumbers(queueDir) {
  let names = [];
  try {
    names = fs.readdirSync(queueDir);
  } catch {
    return [];
  }
  return names.filter((name) => TICKET_PATTERN.test(name)).map(Number).sort((a, b) => a - b);
}

/** @returns {{ n: number, file: string, ticket: any }[]} ticket null = unreadable (blocks like a live one) */
export function listQueue(queueDir) {
  return ticketNumbers(queueDir).map((n) => {
    const file = path.join(queueDir, ticketName(n));
    return { n, file, ticket: readJson(file) };
  });
}

const isLive = (entry) => entry.ticket === null || entry.ticket.done !== true;

/**
 * Mark the ticket at `file` used, if it is still `token`'s: a `{done:true}` record
 * renamed over it, so readers see the old or the new content, never half.
 */
export function markDone(file, token) {
  const current = readJson(file);
  if (!current || current.token !== token || current.done === true) return false;
  const tmp = path.join(path.dirname(file), `.d-${token}-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ done: true, token, doneAt: Date.now() }));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;
  }
}

/**
 * The holder named by a lock owner or a ticket is gone: recorded on this host,
 * its pid is ESRCH, and — when it named a process group — no process is left in
 * the group. Another host's pid says nothing here.
 */
export function holderGone(record, env) {
  if (!record || record.host !== env.host) return false;
  if (env.pidAlive(record.pid)) return false;
  return !validPgid(record.pgid) || !env.groupAlive(record.pgid);
}

/**
 * Why another waiter's ticket may be retired, or null (design §2.5). Never by
 * age alone: a long `mutexWaitSec` is a legitimate long wait.
 *
 * @param {any} ticket
 * @param {{ host: string, now: number, pidAlive: (pid: number) => boolean, groupAlive: (pgid: number) => boolean, startOf: (pid: number) => number | null }} env
 */
export function ticketRetirable(ticket, env) {
  if (!ticket || typeof ticket.token !== 'string') return null;
  const deadline = typeof ticket.deadline === 'number' ? ticket.deadline : null;
  if (ticket.host === env.host) {
    if (holderGone(ticket, env)) return 'gone';
    if (ticket.pid !== process.pid && typeof ticket.createdAt === 'number') {
      const start = env.startOf(ticket.pid);
      if (start !== null && start > ticket.createdAt + PID_REUSE_SLACK_MS) return 'pid-reused';
    }
    if (deadline !== null && env.now > deadline + SAME_HOST_GRACE_MS) return 'expired';
    return null;
  }
  if (deadline !== null && env.now > deadline + OTHER_HOST_GRACE_MS) return 'expired';
  return null;
}

/**
 * Take a ticket (design §2.2): publish the content with `link` at max+1, then
 * withdraw it when a larger number exists (it was published late). Returns the
 * number, or null when every try this poll met contention.
 */
function takeTicket(queueDir, content, env) {
  fs.mkdirSync(queueDir, { recursive: true });
  const tmp = path.join(queueDir, `.t-${content.token}`);
  fs.writeFileSync(tmp, JSON.stringify(content));
  try {
    for (let tries = 0; tries < LINK_TRIES_PER_POLL; tries++) {
      const numbers = ticketNumbers(queueDir);
      const n = (numbers.length > 0 ? numbers[numbers.length - 1] : 0) + 1;
      env.beforeLink?.(n);
      const file = path.join(queueDir, ticketName(n));
      try {
        env.link(tmp, file);
      } catch (err) {
        if (err?.code === 'EEXIST') continue;
        throw err;
      }
      if (ticketNumbers(queueDir).some((k) => k > n)) {
        markDone(file, content.token);
        continue;
      }
      return n;
    }
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Delete used tickets below the largest number (the largest is kept: it is what makes a late ticket withdraw). */
function collectGarbage(queueDir, now) {
  const numbers = ticketNumbers(queueDir);
  const max = numbers.length > 0 ? numbers[numbers.length - 1] : 0;
  for (const n of numbers) {
    if (n >= max) continue;
    const file = path.join(queueDir, ticketName(n));
    if (readJson(file)?.done === true) fs.rmSync(file, { force: true });
  }
  let names = [];
  try {
    names = fs.readdirSync(queueDir);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.startsWith('.t-') || entry.startsWith('.d-'))) {
    const file = path.join(queueDir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > TEMP_MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch {
      // gone meanwhile
    }
  }
}

/** @returns {boolean} true when this call created the directory and owns it */
function claim(lockPath, owner) {
  try {
    fs.mkdirSync(lockPath);
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
  fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify(owner));
  return true;
}

let goneSerial = 0;

/**
 * Recover the lock of a dead holder (design §2.4): move it aside first, then
 * read what was moved. Only when it is the very record judged dead is it
 * deleted; anything else (a live holder an old-version cleaner let in) is put
 * back without replacing a lock taken meanwhile.
 *
 * @returns {'recovered' | 'restored' | 'restore-failed' | 'gone'}
 */
export function recoverLock(lockPath, dead, myToken, warn = () => {}) {
  const gone = `${lockPath}.gone-${myToken}-${++goneSerial}`;
  try {
    fs.renameSync(lockPath, gone);
  } catch {
    return 'gone';
  }
  const moved = readOwner(gone);
  if (moved && moved.token === dead.token) {
    fs.rmSync(gone, { recursive: true, force: true });
    warn(`machine-lock-broken-stale ${lockPath} pid=${dead.pid}`);
    return 'recovered';
  }
  try {
    fs.mkdirSync(lockPath);
  } catch {
    warn(`machine-lock-restore-failed ${lockPath}: kept ${gone}`);
    return 'restore-failed';
  }
  try {
    fs.renameSync(path.join(gone, 'owner'), path.join(lockPath, 'owner'));
  } catch {
    // the moved lock had no owner yet: its holder writes it into the restored path
  }
  fs.rmSync(gone, { recursive: true, force: true });
  return 'restored';
}

/**
 * Take the machine-wide lock `name` in ticket order, waiting up to `timeoutMs`.
 *
 * @param {string} name
 * @param {{
 *   root: string,
 *   timeoutMs: number,
 *   pollMs?: number,
 *   sleep?: (ms: number) => void,
 *   pgid?: number,
 *   ownerFields?: Record<string, unknown>,
 *   onStaleHolder?: (owner: any) => void,
 *   shouldAbandon?: () => boolean,
 *   onWait?: () => void,
 *   warn?: (line: string) => void,
 *   hooks?: { link?: (src: string, dst: string) => void, beforeLink?: (n: number) => void, startOf?: (pid: number) => number | null, now?: () => number, host?: string, pidAlive?: (pid: number) => boolean, groupAlive?: (pgid: number) => boolean },
 * }} options
 * @returns {{ acquired: boolean, waitedMs: number, heldBy: string | null, abandoned?: boolean, release: () => void, setOwnerFields: (fields: Record<string, unknown>) => boolean, path: string }}
 */
export function acquireMachineLockSync(name, options) {
  const { root, timeoutMs, pollMs = LOCK_POLL_MS, sleep = sleepSync, hooks = {} } = options;
  const warn = options.warn ?? (() => {});
  const now = hooks.now ?? (() => Date.now());
  const host = hooks.host ?? os.hostname();
  const startCache = new Map();
  const env = {
    host,
    pidAlive: hooks.pidAlive ?? pidAlive,
    groupAlive: hooks.groupAlive ?? groupAlive,
    link: hooks.link ?? ((src, dst) => fs.linkSync(src, dst)),
    beforeLink: hooks.beforeLink,
    startOf: (pid) => {
      if (hooks.startOf) return hooks.startOf(pid);
      const cached = startCache.get(pid);
      if (cached && now() - cached.at < START_RECHECK_MS) return cached.start;
      const start = processStartMs(pid, now());
      startCache.set(pid, { start, at: now() });
      return start;
    },
  };
  const lockPath = lockPathOf(root, name);
  const queueDir = queueDirOf(root, name);
  const token = crypto.randomUUID();
  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  const pgid = validPgid(options.pgid) ? options.pgid : undefined;
  const ticket = { pid: process.pid, host, token, createdAt: startedAt, deadline, ...(pgid ? { pgid } : {}) };
  fs.mkdirSync(root, { recursive: true });

  let mine = null;
  let blocker = null;
  let waiting = false;
  const broken = new Set();
  const mineFile = () => path.join(queueDir, ticketName(mine));
  const retire = () => {
    if (mine !== null) markDone(mineFile(), token);
    mine = null;
  };
  const heldBy = () => {
    const owner = readOwner(lockPath);
    if (owner) return describeOwner(owner);
    if (blocker) return `queue ticket ${blocker.file}${blocker.ticket ? ` (${describeOwner(blocker.ticket)})` : ' (unreadable)'}`;
    return null;
  };
  const noLock = () => ({ release: () => {}, setOwnerFields: () => false, path: lockPath });

  try {
    for (;;) {
      if (options.shouldAbandon?.()) {
        retire();
        return { acquired: false, waitedMs: now() - startedAt, heldBy: heldBy(), abandoned: true, ...noLock() };
      }
      if (mine !== null) {
        const current = readJson(mineFile());
        if (!current || current.done === true || current.token !== token) {
          warn(`machine-lock-ticket-lost ${mineFile()}: taking a new ticket at the end of the queue`);
          mine = null;
        }
      }
      if (mine === null) mine = takeTicket(queueDir, ticket, env);
      blocker = null;
      if (mine !== null) {
        const judged = { ...env, now: now() };
        for (const entry of listQueue(queueDir)) {
          if (entry.n >= mine) break;
          if (!isLive(entry)) continue;
          const why = entry.ticket ? ticketRetirable(entry.ticket, judged) : null;
          if (why) {
            if (markDone(entry.file, entry.ticket.token)) warn(`machine-lock-ticket-retired ${entry.file} (${why})`);
            continue;
          }
          blocker = entry;
          break;
        }
        if (!blocker) {
          const owner = { pid: process.pid, host, token, acquiredAt: now(), ...(pgid ? { pgid } : {}), ...(options.ownerFields ?? {}) };
          if (claim(lockPath, owner)) {
            retire();
            collectGarbage(queueDir, now());
            let released = false;
            return {
              acquired: true,
              waitedMs: now() - startedAt,
              heldBy: null,
              path: lockPath,
              // Never moves a lock that is not this acquisition's: a second call, or a call after the
              // lock was taken by someone else, leaves it where it is (Codex review 2, finding 1).
              release: () => {
                if (released) return;
                released = true;
                if (readOwner(lockPath)?.token !== token) return;
                fs.rmSync(lockPath, { recursive: true, force: true });
              },
              setOwnerFields: (fields) => {
                if (released) return false;
                const current = readOwner(lockPath);
                if (!current || current.token !== token) return false;
                const tmp = path.join(lockPath, `.owner-${crypto.randomUUID()}`);
                fs.writeFileSync(tmp, JSON.stringify({ ...current, ...fields, pid: current.pid, token }));
                fs.renameSync(tmp, path.join(lockPath, 'owner'));
                return true;
              },
            };
          }
          const holder = readOwner(lockPath);
          if (holder && !broken.has(holder.token) && holderGone(holder, env)) {
            broken.add(holder.token);
            // Persist what the dead holder was doing before its lock is gone (merge-pr: an unconfirmed write).
            options.onStaleHolder?.(holder);
            recoverLock(lockPath, holder, token, warn);
            continue;
          }
        }
      }
      const t = now();
      if (t >= deadline) {
        retire();
        return { acquired: false, waitedMs: t - startedAt, heldBy: heldBy(), ...noLock() };
      }
      if (!waiting) {
        waiting = true;
        options.onWait?.();
      }
      sleep(Math.min(pollMs, deadline - t));
    }
  } catch (err) {
    retire();
    throw err;
  }
}

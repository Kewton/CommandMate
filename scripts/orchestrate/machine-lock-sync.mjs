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
 * The standalone runner's bash (.claude/skills/cmate-verify/scripts/verify-run.sh
 * `lock_acquire`) is the third copy of the convention.
 *
 * Every observation a decision to take, recover or release the lock reads (a
 * `kill -0`, an owner record, a directory listing, a `mkdir`, a `rename`) goes
 * through `makeObserver` and answers in three values: yes / no / unknown
 * (Issue #4288, docs/design/verify-lock-holder-group-4288.md §2.8). "No" needs
 * positive evidence (ESRCH, ENOENT, a listing that succeeded); anything else —
 * EPERM, EACCES, EIO, a failed listing — is unknown, and unknown never takes,
 * deletes or releases. A lock moved aside whose put-back failed
 * (`<name>.lock.gone-<token>-<serial>`) is read as held while its record is
 * alive or unreadable (§2.7).
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
/**
 * The queue of tickets of a lock named by its path (#4288 PR1a D2): `<lock without .lock>.queue` —
 * the same directory `queueDirOf(root, name)` names for `<root>/<name>.lock`, and bash's
 * `machine_lock_queue_of` (scripts/lib/machine-lock.sh).
 */
export const queueDirOfPath = (lockPath) => `${lockPath.endsWith('.lock') ? lockPath.slice(0, -'.lock'.length) : lockPath}.queue`;

/** The owner record as JSON (the convention's own shape). A caller with another format passes `ownerCodec` (#4288 PR1a D1). */
export const JSON_OWNER_CODEC = { parse: (text) => JSON.parse(text), format: (record) => JSON.stringify(record) };

/** How long releaseAsHead / recoverIfDead wait to become the head by default (D5). */
export const HEAD_BUDGET_MS = 10_000;

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

/**
 * A record's pgid can be judged: no `pgid` key (an older record — judged by its pid alone), or a
 * non-negative integer. Any other value (`-5`, `"x"`, `null`, `1.5`) is unknown (EINVAL), never "no
 * group": a dead runner's lock would be recovered past its live gate (#4288 Codex re-review P1).
 */
const pgidFieldOk = (record) => !Object.prototype.hasOwnProperty.call(record, 'pgid') || (Number.isInteger(record.pgid) && record.pgid >= 0);

/** The errno of a failed call, or EUNKNOWN when it carries none. */
const errCode = (err) => (typeof err?.code === 'string' && err.code ? err.code : 'EUNKNOWN');

/** The suffix of a lock moved aside (`<lockPath>.gone-<S>`): what the three implementations write — no `.`, no `_` (§2.7). */
export const GONE_SUFFIX_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * The three-valued observations (Issue #4288 §2.8). Each takes the observation point's name first:
 * `hooks.fault(point, target)` may answer an errno to inject there (tests only), and the
 * classification below is the same for an injected and a real failure.
 *
 * `hooks.kill` (#4288 PR1a D10) stands in for `process.kill(target, 0)` and throws as it does; its
 * error goes through the same classification (ESRCH gone, EPERM and anything else unknown), so a
 * caller's injection cannot turn a failure into "dead". `hooks.codec` parses the owner record
 * (default JSON, D1).
 *
 * @param {{ fault?: (point: string, target: string) => string | null | undefined, pidAlive?: (pid: number) => boolean, groupAlive?: (pgid: number) => boolean, kill?: (target: number, signal: number) => void, codec?: { parse: (text: string) => any } }} [hooks]
 */
export function makeObserver(hooks = {}) {
  const attempt = (point, target, fn) => {
    const code = hooks.fault?.(point, String(target));
    if (code) {
      const err = new Error(`${code}: injected at ${point} ${target}`);
      err.code = code;
      throw err;
    }
    return fn();
  };
  const probe = (point, target, legacy, signalTarget) => {
    try {
      if (legacy) return attempt(point, target, () => (legacy() ? { state: 'alive' } : { state: 'gone' }));
      attempt(point, target, () => (hooks.kill ? hooks.kill(signalTarget, 0) : process.kill(signalTarget, 0)));
      return { state: 'alive' };
    } catch (err) {
      return errCode(err) === 'ESRCH' ? { state: 'gone' } : { state: 'unknown', point, code: errCode(err) };
    }
  };
  return {
    /** kill -0 <pid>: alive / gone (ESRCH) / unknown */
    pid: (point, pid) => probe(point, pid, hooks.pidAlive && (() => hooks.pidAlive(pid)), pid),
    /** kill -0 -<pgid>: alive / gone (ESRCH) / unknown */
    group: (point, pgid) => probe(point, -pgid, hooks.groupAlive && (() => hooks.groupAlive(pgid)), -pgid),
    /** readdir: listed / absent (ENOENT) / unknown */
    list(point, dir) {
      try {
        return { state: 'listed', names: attempt(point, dir, () => fs.readdirSync(dir)) };
      } catch (err) {
        return errCode(err) === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', point, code: errCode(err) };
      }
    },
    /** lstat: dir / other (a file, a symlink) / absent / unknown — with the entry's own mtimeMs */
    lstat(point, file) {
      try {
        const st = attempt(point, file, () => fs.lstatSync(file));
        return { state: st.isDirectory() ? 'dir' : 'other', mtimeMs: st.mtimeMs };
      } catch (err) {
        return errCode(err) === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', point, code: errCode(err) };
      }
    },
    /** `<dir>/owner`: record / missing (ENOENT) / corrupt (read, not a record) / unknown */
    owner(point, dir) {
      const file = path.join(dir, 'owner');
      let text;
      try {
        text = attempt(point, file, () => fs.readFileSync(file, 'utf8'));
      } catch (err) {
        return errCode(err) === 'ENOENT' ? { state: 'missing' } : { state: 'unknown', point, code: errCode(err) };
      }
      let owner;
      try {
        owner = hooks.codec ? hooks.codec.parse(text) : JSON.parse(text);
      } catch {
        return { state: 'corrupt' };
      }
      if (!owner || typeof owner !== 'object' || typeof owner.pid !== 'number' || typeof owner.token !== 'string') return { state: 'corrupt' };
      // The pgid's number check is a step of this observation too (#4288 Codex re-review P1).
      return pgidFieldOk(owner) ? { state: 'record', owner } : { state: 'unknown', point, code: 'EINVAL' };
    },
    /** mkdir: created / exists (EEXIST) / unknown */
    mkdir(point, dir) {
      try {
        attempt(point, dir, () => fs.mkdirSync(dir));
        return { state: 'created' };
      } catch (err) {
        return errCode(err) === 'EEXIST' ? { state: 'exists' } : { state: 'unknown', point, code: errCode(err) };
      }
    },
    /** rename: moved / absent (ENOENT: the source is not there) / unknown */
    rename(point, from, to) {
      try {
        attempt(point, from, () => fs.renameSync(from, to));
        return { state: 'moved' };
      } catch (err) {
        return errCode(err) === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', point, code: errCode(err) };
      }
    },
    /**
     * The exclusive create of a file with `text` in it (#4288 PR1a D3, `O_CREAT|O_EXCL`): created /
     * exists (EEXIST: nothing opened) / unknown — `opened` says whether this call made the file (only
     * then is it the caller's to remove). The write after the open fails at the point `owner-write`.
     */
    create(point, file, text) {
      let fd;
      try {
        fd = attempt(point, file, () => fs.openSync(file, 'wx'));
      } catch (err) {
        return errCode(err) === 'EEXIST' ? { state: 'exists' } : { state: 'unknown', point, code: errCode(err), opened: false };
      }
      try {
        attempt('owner-write', file, () => fs.writeSync(fd, text));
        return { state: 'created' };
      } catch (err) {
        return { state: 'unknown', point, code: errCode(err), opened: true };
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // closed or gone: nothing more to do
        }
      }
    },
    /** rmdir of an empty directory: removed / unknown — a failure keeps its errno (#4288 Codex re-review P2) */
    rmdir(point, dir) {
      try {
        attempt(point, dir, () => fs.rmdirSync(dir));
        return { state: 'removed' };
      } catch (err) {
        return { state: 'unknown', point, code: errCode(err) };
      }
    },
  };
}

/**
 * Whether a recorded holder is gone, in three values (§2.8): gone only when its pid answered ESRCH
 * and — when it named a process group — the group did too. Another host's record is alive here.
 *
 * @returns {{ state: 'alive' | 'gone' | 'unknown', point?: string, code?: string }}
 */
export function holderState(record, env) {
  if (!record || record.host !== env.host || typeof record.pid !== 'number') return { state: 'alive' };
  const pid = env.obs.pid('pid', record.pid);
  if (pid.state !== 'gone') return pid;
  if (!pgidFieldOk(record)) return { state: 'unknown', point: 'group', code: 'EINVAL' };
  if (!validPgid(record.pgid)) return { state: 'gone' };
  return env.obs.group('group', record.pgid);
}

function readJson(file, parse = JSON.parse) {
  try {
    const parsed = parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The lock's owner record, or null while it is unreadable (just created, or corrupt: wait, never break). */
export function readOwner(lockPath, codec = JSON_OWNER_CODEC) {
  const owner = readJson(path.join(lockPath, 'owner'), codec.parse);
  return owner && typeof owner.pid === 'number' && typeof owner.token === 'string' ? owner : null;
}

export const describeOwner = (owner) => (owner ? `pid ${owner.pid} on ${owner.host || 'unknown host'}` : null);

/**
 * Ticket numbers in the queue, ascending. With `obs` (the acquisition's own reads), a listing that
 * failed is null — unknown, never "no tickets" (#4288 §2.8); without it (garbage collection, the
 * exported reader) a failed listing reads as empty, which only ever leaves a ticket in place.
 */
function ticketNumbers(queueDir, obs) {
  if (obs) {
    const listed = obs.list('list-queue', queueDir);
    if (listed.state === 'unknown') return null;
    const names = listed.state === 'listed' ? listed.names : [];
    return names.filter((name) => TICKET_PATTERN.test(name)).map(Number).sort((a, b) => a - b);
  }
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
  const obs = env.obs ?? makeObserver({ pidAlive: env.pidAlive, groupAlive: env.groupAlive });
  return holderState(record, { host: env.host, obs }).state === 'gone';
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
      const numbers = ticketNumbers(queueDir, env.obs);
      if (numbers === null) return null;
      const n = (numbers.length > 0 ? numbers[numbers.length - 1] : 0) + 1;
      env.beforeLink?.(n);
      const file = path.join(queueDir, ticketName(n));
      try {
        env.link(tmp, file);
      } catch (err) {
        if (err?.code === 'EEXIST') continue;
        throw err;
      }
      // A listing that failed after the link cannot show the ticket is not late: withdraw it.
      const after = ticketNumbers(queueDir, env.obs);
      if (after === null || after.some((k) => k > n)) {
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

/**
 * @returns {boolean} true when this call created the directory and owns it. A `mkdir` that failed
 * for another reason than EEXIST is not a claim and not a contention either: it throws, naming the errno.
 *
 * The owner is created exclusively and read back (#4288 PR1a D3, the same as verify-run.sh's
 * lock_obs_create): a name that is there (EEXIST) is never written over and nothing is removed — not
 * acquired; a record read back that is not this one (another token, corrupt, missing) is not acquired
 * either and nothing is removed. An owner that could not be created, written or read back (ENOSPC,
 * EIO) is not a lock taken: the owner is removed only when this call opened it, and the <lock> this
 * mkdir made is taken out again with rmdir (it is empty then), so no <lock> without an owner is left
 * for every reader to wait on (#4288 PM review P3-2). That error still ends the acquisition, as a
 * mkdir that failed does. Test seams (`fault`): owner-create, owner-write, owner-readback (observation
 * points), owner-unlink and lock-rmdir (the undo).
 */
function claim(lockPath, owner, obs, fault = undefined, warn = () => {}, codec = JSON_OWNER_CODEC) {
  const made = obs.mkdir('mkdir-lock', lockPath);
  if (made.state === 'exists') return false;
  if (made.state !== 'created') {
    const err = new Error(`machine-lock-unknown point=mkdir-lock path=${lockPath} errno=${made.code}`);
    err.code = made.code;
    throw err;
  }
  const file = path.join(lockPath, 'owner');
  const created = obs.create('owner-create', file, codec.format(owner));
  if (created.state === 'exists') {
    warn(`machine-lock-owner-exists ${lockPath} (not acquired; nothing removed)`);
    return false;
  }
  let failed = created.state === 'created' ? null : created;
  if (!failed) {
    const back = obs.owner('owner-readback', lockPath);
    if (back.state === 'record' && back.owner.token === owner.token) return true;
    if (back.state !== 'unknown') {
      warn(`machine-lock-owner-not-ours ${lockPath} (another record read back; not acquired, nothing removed)`);
      return false;
    }
    failed = { ...back, opened: true };
  }
  if (failed.opened && !fault?.('owner-unlink', file)) fs.rmSync(file, { force: true });
  const out = fault?.('lock-rmdir', lockPath) ? false : rmdirQuiet(lockPath);
  warn(`machine-lock-owner-write-failed ${lockPath} (${failed.code}${out ? '' : '; and it could not be taken out again'})`);
  const err = new Error(`machine-lock-unknown point=${failed.point} path=${file} errno=${failed.code}`);
  err.code = failed.code;
  throw err;
}

/**
 * D3 (#4288 PR1a): an owner-less, empty <lock> older than `graceMs` is taken out by the head — its
 * maker died between the mkdir and the owner (run-lock and supervisor.lock waited 60 s for that).
 * Only the head calls this, and nobody else makes a <lock> while it is the head. The age is
 * `now - mtimeMs` in ms (D11). An unknown keeps the poll from the mkdir and is reported.
 *
 * @returns {{ state: 'none' | 'absent' | 'young' | 'removed' | 'unknown', unknown?: { point: string, path: string, code: string } }}
 */
function expireOwnerless(ctx, graceMs, now) {
  if (typeof graceMs !== 'number') return { state: 'none' };
  const half = ownerlessEmptyLock(ctx);
  if (half.state === 'unknown') return { state: 'unknown', unknown: half.unknown };
  if (half.state !== 'yes') return { state: half.state === 'absent' ? 'absent' : 'none' };
  const st = ctx.obs.lstat('ownerless-mtime', ctx.lockPath);
  if (st.state === 'absent') return { state: 'absent' };
  if (st.state === 'unknown') return { state: 'unknown', unknown: { point: 'ownerless-mtime', path: ctx.lockPath, code: st.code } };
  const age = now - st.mtimeMs;
  if (age <= graceMs) return { state: 'young' };
  const removed = ctx.obs.rmdir('ownerless-rmdir', ctx.lockPath);
  if (removed.state === 'unknown') return { state: 'unknown', unknown: { point: 'ownerless-rmdir', path: ctx.lockPath, code: removed.code } };
  ctx.warn(`machine-lock-ownerless-removed ${ctx.lockPath} (no owner for ${Math.round(age)} ms)`);
  return { state: 'removed' };
}

let goneSerial = 0;

/** rmdir, which only ever removes an empty directory; a failure leaves it as it was (false). */
function rmdirQuiet(dir) {
  try {
    fs.rmdirSync(dir);
    return true;
  } catch {
    // not empty, gone, or not ours to remove: left as it is
    return false;
  }
}

/** A queue of tickets, or the unknown that kept it from being listed (never read as "no tickets"). */
function readQueue(queueDir, obs) {
  const listed = obs.list('list-queue', queueDir);
  if (listed.state === 'unknown') return { unknown: { point: 'list-queue', path: queueDir, code: listed.code }, entries: [] };
  const names = listed.state === 'listed' ? listed.names : [];
  const entries = names
    .filter((entry) => TICKET_PATTERN.test(entry))
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => {
      const file = path.join(queueDir, ticketName(n));
      return { n, file, ticket: readJson(file) };
    });
  return { entries };
}

/**
 * The locks moved aside for `ctx.lockPath` (§2.7 退避名の識別): `<name>.lock.gone-<S>` where S has no `.` or `_`
 * and the entry is a directory (not a symlink). A listing or lstat that failed is unknown, never "none".
 */
function goneCandidates(ctx, point) {
  const listed = ctx.obs.list(point, ctx.root);
  if (listed.state === 'absent') return { list: [] };
  if (listed.state === 'unknown') return { unknown: { point, path: ctx.root, code: listed.code } };
  const prefix = `${path.basename(ctx.lockPath)}.gone-`;
  const list = [];
  for (const entry of listed.names) {
    if (!entry.startsWith(prefix) || !GONE_SUFFIX_PATTERN.test(entry.slice(prefix.length))) continue;
    const file = path.join(ctx.root, entry);
    const st = ctx.obs.lstat('gone-lstat', file);
    if (st.state === 'unknown') return { unknown: { point: 'gone-lstat', path: file, code: st.code } };
    if (st.state === 'dir') list.push(file);
  }
  return { list };
}

/**
 * `<lock>` exists with no owner and nothing in it — a put-back stopped half way (§2.7 A / B).
 *
 * @returns {{ state: 'yes' | 'no' | 'absent' } | { state: 'unknown', unknown: { point: string, path: string, code: string } }}
 */
function ownerlessEmptyLock(ctx) {
  const ownerFile = path.join(ctx.lockPath, 'owner');
  const owner = ctx.obs.owner('lock-owner', ctx.lockPath);
  if (owner.state === 'unknown') return { state: 'unknown', unknown: { point: 'lock-owner', path: ownerFile, code: owner.code } };
  if (owner.state !== 'missing') return { state: 'no' };
  const listed = ctx.obs.list('lock-list', ctx.lockPath);
  if (listed.state === 'absent') return { state: 'absent' };
  if (listed.state === 'unknown') return { state: 'unknown', unknown: { point: 'lock-list', path: ctx.lockPath, code: listed.code } };
  return { state: listed.names.length === 0 ? 'yes' : 'no' };
}

/**
 * Move a moved-aside owner back into `<lock>` and drop the moved-aside directory. ENOENT (the owner
 * is not there) is 'absent'; any other failure takes the `<lock>` this put-back made out again (it is
 * empty) and keeps the moved-aside directory, which goes on holding the lock (§2.7 B).
 */
function moveOwnerIn(ctx, gone) {
  const moved = ctx.obs.rename('restore-rename', path.join(gone, 'owner'), path.join(ctx.lockPath, 'owner'));
  if (moved.state === 'moved') {
    ctx.onRecover?.('restore-owner');
    fs.rmSync(gone, { recursive: true, force: true });
    return 'restored';
  }
  if (moved.state === 'absent') return 'absent';
  rmdirQuiet(ctx.lockPath);
  ctx.warn(`machine-lock-restore-failed ${ctx.lockPath}: kept ${gone} (${moved.code})`);
  return 'restore-failed';
}

/** §2.7 rows 2, 3 and 5: a moved-aside record that is alive (or not known to be gone) is put back. */
function restoreFromGone(ctx, gone) {
  const made = ctx.obs.mkdir('restore-mkdir', ctx.lockPath);
  if (made.state === 'created') {
    ctx.onRecover?.('restore-mkdir');
    const r = moveOwnerIn(ctx, gone);
    if (r === 'absent') rmdirQuiet(ctx.lockPath);
    if (r === 'restored') ctx.warn(`machine-lock-restored ${ctx.lockPath} from ${gone}`);
    return;
  }
  if (made.state === 'exists') {
    const half = ownerlessEmptyLock(ctx).state;
    if (half === 'yes') {
      if (moveOwnerIn(ctx, gone) === 'restored') ctx.warn(`machine-lock-restored ${ctx.lockPath} from ${gone} (completed a put-back)`);
    } else if (half === 'no') {
      ctx.warnOnce(`machine-lock-restore-failed ${ctx.lockPath}: kept ${gone} (the lock holds another record)`);
    }
    return;
  }
  ctx.warnOnce(`machine-lock-restore-failed ${ctx.lockPath}: kept ${gone} (${made.code})`);
}

/**
 * §2.7 rows 4 and 7: a moved-aside record judged gone (or this acquisition's own) is moved to this
 * waiter's own name and deleted only when it is still the record judged. `takeBackHalf` first removes
 * a `<lock>` left empty by a put-back that stopped half way (never on release: a taker may be between
 * its mkdir and its owner write). When that cannot be settled — whether `<lock>` is such a half
 * put-back is unknown, or its rmdir failed — the moved-aside record is KEPT (`kept`): it is the only
 * trace that lets a later head take the empty `<lock>` back once the fault clears (#4288 Codex 5-2b P2-1).
 * Either way the reason — point, path, errno — goes with it (a failed rmdir as `reclaim-rmdir`), so
 * the timeout names it (#4288 Codex re-review P2).
 *
 * @returns {{ kept: boolean, unknown?: { point: string, path: string, code: string } }}
 */
function reclaimGone(ctx, gone, token, takeBackHalf) {
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
    fs.rmSync(mine, { recursive: true, force: true });
    ctx.warn(`machine-lock-gone-recovered ${gone} pid=${moved.owner.pid}`);
  }
  return { kept: false };
}

/**
 * §2.7: the head's pass over the locks moved aside, before the mkdir. `block` keeps this poll from
 * the mkdir: a record alive or not known to be gone, an owner that cannot be read, a listing that failed.
 */
function settleGone(ctx) {
  const found = goneCandidates(ctx, 'list-root');
  if (found.unknown) {
    ctx.warnOnce(`machine-lock-gone-unreadable ${found.unknown.path} ${found.unknown.code}`);
    return { block: true, pending: `${found.unknown.path} unreadable`, unknown: found.unknown };
  }
  let result = { block: false };
  const hold = (pending, unknown) => {
    if (!result.block) result = { block: true, pending, unknown };
    else if (unknown && !result.unknown) result.unknown = unknown;
  };
  for (const gone of found.list) {
    const read = ctx.obs.owner('gone-owner', gone);
    if (read.state === 'unknown') {
      ctx.warnOnce(`machine-lock-gone-unreadable ${gone} ${read.code}`);
      hold(`${gone} unreadable`, { point: 'gone-owner', path: path.join(gone, 'owner'), code: read.code });
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
function cleanupOwnGone(ctx, token) {
  const found = goneCandidates(ctx, 'release-list');
  if (found.unknown) {
    ctx.warn(`machine-lock-gone-unreadable ${found.unknown.path} ${found.unknown.code}`);
    return;
  }
  for (const gone of found.list) {
    const read = ctx.obs.owner('gone-owner', gone);
    if (read.state === 'record' && read.owner.token === token) reclaimGone(ctx, gone, token, false);
  }
}

/**
 * Recover the lock of a dead holder (design §2.4): move it aside first, then
 * read what was moved. Only when it is the very record judged dead is it
 * deleted; anything else (a live holder an old-version cleaner let in, or a
 * record that was rewritten — verify-run.sh publishes its gate's group under a
 * new token, #4288 §2.2) is put back without replacing a lock taken meanwhile.
 * A put-back that cannot finish keeps the moved-aside directory, and the
 * next head reads it as held while its record lives (§2.7).
 *
 * @returns {'recovered' | 'restored' | 'restore-failed' | 'gone' | 'unknown'}
 */
export function recoverLock(lockPath, dead, myToken, warn = () => {}, onRecover = undefined, obs = makeObserver()) {
  const gone = `${lockPath}.gone-${myToken}-${++goneSerial}`;
  onRecover?.('before-move');
  const aside = obs.rename('rename-aside', lockPath, gone);
  if (aside.state !== 'moved') return aside.state === 'absent' ? 'gone' : 'unknown';
  // Test seam (#4277 P1): a third party's claim can be put into the window here.
  onRecover?.('moved');
  const moved = obs.owner('recover-owner', gone);
  if (moved.state === 'record' && moved.owner.token === dead.token) {
    fs.rmSync(gone, { recursive: true, force: true });
    warn(`machine-lock-broken-stale ${lockPath} pid=${dead.pid}`);
    return 'recovered';
  }
  const made = obs.mkdir('restore-mkdir', lockPath);
  if (made.state !== 'created') {
    warn(`machine-lock-restore-failed ${lockPath}: kept ${gone}`);
    return 'restore-failed';
  }
  onRecover?.('restore-mkdir');
  const back = obs.rename('restore-rename', path.join(gone, 'owner'), path.join(lockPath, 'owner'));
  if (back.state === 'unknown') {
    rmdirQuiet(lockPath);
    warn(`machine-lock-restore-failed ${lockPath}: kept ${gone} (${back.code})`);
    return 'restore-failed';
  }
  // ENOENT: the moved lock had no owner yet — its holder writes it into the restored path.
  if (back.state === 'moved') onRecover?.('restore-owner');
  fs.rmSync(gone, { recursive: true, force: true });
  return 'restored';
}

/**
 * Take the machine-wide lock `name` in ticket order, waiting up to `timeoutMs`.
 *
 * @param {string} name
 * @param {{
 *   root?: string,
 *   timeoutMs: number,
 *   pollMs?: number,
 *   sleep?: (ms: number) => void,
 *   pgid?: number,
 *   ownerFields?: Record<string, unknown>,
 *   onStaleHolder?: (owner: any) => void,
 *   shouldAbandon?: () => boolean,
 *   onWait?: () => void,
 *   warn?: (line: string) => void,
 *   hooks?: { onRecover?(stage: 'before-move' | 'moved' | 'restore-mkdir' | 'restore-owner' | 'hand-off-tmp'): void, link?: (src: string, dst: string) => void, beforeLink?: (n: number) => void, startOf?: (pid: number) => number | null, now?: () => number, host?: string, pidAlive?: (pid: number) => boolean, groupAlive?: (pgid: number) => boolean, kill?: (target: number, signal: number) => void, fault?: (point: string, target: string) => string | null | undefined },
 *   lockPath?: string,
 *   ownerCodec?: { parse: (text: string) => any, format: (record: Record<string, unknown>) => string },
 *   ownerlessGraceMs?: number,
 *   token?: string,
 *   ownerPid?: number,
 * }} options
 *
 * Options for run-lock and supervisor.lock (#4288 PR1a, docs/design/lock-reservation-rest-4288.md
 * §1.6); none of them is set by gate-runner, precheck or merge-pr, and each is off by default:
 * `lockPath` names the lock by its path (D2: `root` and `name` are then ignored, the queue is
 * `queueDirOfPath(lockPath)`); `ownerCodec` reads and writes the owner in another format (D1);
 * `ownerlessGraceMs` lets the head take out an owner-less, empty <lock> older than that (D3); `token`
 * is the token to acquire under; `ownerPid` the pid written to the owner (the ticket keeps
 * process.pid); `hooks.kill` stands in for process.kill (D10).
 *
 * @returns {{ acquired: boolean, waitedMs: number, heldBy: string | null, abandoned?: boolean, unknown?: { point: string, path: string, code: string }, release: () => ('released' | 'deferred' | 'needs-head' | 'kept' | 'none'), setOwnerFields: (fields: Record<string, unknown>) => boolean, handOff: (pid: number, pgid: number) => { ok: boolean, token?: string, stage?: string }, token?: string, path: string }}
 */
export function acquireMachineLockSync(name, options) {
  const { timeoutMs, pollMs = LOCK_POLL_MS, sleep = sleepSync, hooks = {} } = options;
  const root = options.lockPath ? path.dirname(options.lockPath) : options.root;
  const codec = options.ownerCodec ?? JSON_OWNER_CODEC;
  const warn = options.warn ?? (() => {});
  const warned = new Set();
  const warnOnce = (line) => {
    if (warned.has(line)) return;
    warned.add(line);
    warn(line);
  };
  const now = hooks.now ?? (() => Date.now());
  const host = hooks.host ?? os.hostname();
  const startCache = new Map();
  const obs = makeObserver({ fault: hooks.fault, pidAlive: hooks.pidAlive, groupAlive: hooks.groupAlive, kill: hooks.kill, codec });
  const env = {
    host,
    obs,
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
  const lockPath = options.lockPath ?? lockPathOf(root, name);
  const queueDir = options.lockPath ? queueDirOfPath(options.lockPath) : queueDirOf(root, name);
  const token = typeof options.token === 'string' && options.token ? options.token : crypto.randomUUID();
  const ownerPid = Number.isInteger(options.ownerPid) && options.ownerPid > 0 ? options.ownerPid : process.pid;
  const ctx = { root, lockPath, host, obs, warn, warnOnce, onRecover: hooks.onRecover, myToken: token };
  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  const pgid = validPgid(options.pgid) ? options.pgid : undefined;
  const ticket = { pid: process.pid, host, token, createdAt: startedAt, deadline, ...(pgid ? { pgid } : {}) };
  fs.mkdirSync(root, { recursive: true });

  let mine = null;
  let blocker = null;
  let pending = null;
  let unknown = null;
  let waiting = false;
  const broken = new Set();
  const mineFile = () => path.join(queueDir, ticketName(mine));
  const retire = () => {
    if (mine !== null) markDone(mineFile(), token);
    mine = null;
  };
  const heldBy = () => {
    const owner = readOwner(lockPath, codec);
    // The gate's group (#4288): with verify-run.sh's runner killed, the pid is dead and the group holds.
    // Added here, not in describeOwner: merge-pr's heldByLine appends the pgid to describeOwner itself.
    if (owner) return `${describeOwner(owner)}${validPgid(owner.pgid) ? ` (pgid ${owner.pgid})` : ''}`;
    if (blocker) return `queue ticket ${blocker.file}${blocker.ticket ? ` (${describeOwner(blocker.ticket)})` : ' (unreadable)'}`;
    if (pending) return `restore pending: ${pending}`;
    if (unknown) return `unknown ${unknown.point} ${unknown.path} ${unknown.code}`;
    return null;
  };
  const gaveUp = () => {
    if (!unknown) return {};
    warn(`machine-lock-unknown point=${unknown.point} path=${unknown.path} errno=${unknown.code}`);
    return { unknown };
  };
  const noLock = () => ({ release: () => 'none', setOwnerFields: () => false, handOff: () => ({ ok: false, stage: 'token' }), path: lockPath });

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
      blocker = null;
      pending = null;
      unknown = null;
      if (mine === null) {
        mine = takeTicket(queueDir, ticket, env);
        // No ticket this poll: say so when it was the listing that failed.
        if (mine === null) unknown = readQueue(queueDir, obs).unknown ?? null;
      }
      if (mine !== null) {
        const judged = { ...env, now: now() };
        const queue = readQueue(queueDir, obs);
        if (queue.unknown) unknown = queue.unknown;
        for (const entry of queue.entries) {
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
        if (!blocker && !queue.unknown) {
          const settled = settleGone(ctx);
          if (settled.block) {
            pending = settled.pending;
            unknown = settled.unknown ?? null;
          } else {
            const owner = { pid: ownerPid, host, token, acquiredAt: now(), ...(pgid ? { pgid } : {}), ...(options.ownerFields ?? {}) };
            // D3: the head takes out an owner-less, empty <lock> past the caller's grace first.
            const expired = expireOwnerless(ctx, options.ownerlessGraceMs, now());
            if (expired.state !== 'unknown' && claim(lockPath, owner, obs, hooks.fault, warn, codec)) {
              retire();
              collectGarbage(queueDir, now());
              let released = false;
              // D4: the token a handover published (T1 = <T0>-g<pgid>), from the moment it is tried.
              let handed = null;
              return {
                acquired: true,
                waitedMs: now() - startedAt,
                heldBy: null,
                path: lockPath,
                token,
                // Never moves a lock that is not this acquisition's: a second call, or a call after the
                // lock was taken by someone else, leaves it where it is (Codex review 2, finding 1). An
                // owner that cannot be read is not known to be ours, so it stays too (#4288).
                // D12 (#4288 PR1a-c, docs/design/lock-reservation-rest-4288.md — the invariant of the
                // three implementations, the same as bash's lock_release_held): a record of ours is
                // removed here only when its recorded pid is this process and, when it names a pgid,
                // that group is empty. A group with a member, or one that cannot be shown empty, keeps
                // it ('deferred', the release may be called again). Any other recorded pid — after a
                // handOff or the initial ownerPid alike, alive, gone or unknown — is not removed: a pid
                // read alive can die before the delete, and a head recover it and take the lock in
                // between, so the caller releases with releaseAsHead(lockPath, [token, T1]) (D5) —
                // 'needs-head', once. A pid that cannot be observed is 'deferred'. The group of a record
                // whose pid and pgid are both this process (merge-pr's pgid: process.pid) is not judged:
                // this process is a member of it by definition.
                release: () => {
                  if (released) return 'none';
                  const current = obs.owner('release-owner', lockPath);
                  const mine = current.state === 'record' && (current.owner.token === token || (handed !== null && current.owner.token === handed));
                  const ownGroup = mine && current.owner.pid === process.pid && current.owner.pgid === process.pid;
                  if (mine && validPgid(current.owner.pgid) && !ownGroup) {
                    const group = obs.group('group', current.owner.pgid);
                    if (group.state !== 'gone') {
                      warn(`machine-lock-release-deferred ${lockPath} pgid=${current.owner.pgid}`);
                      return 'deferred';
                    }
                  }
                  if (mine && current.owner.pid !== process.pid) {
                    const holder = obs.pid('pid', current.owner.pid);
                    if (holder.state === 'unknown') {
                      warn(`machine-lock-release-deferred ${lockPath} (recorded pid ${current.owner.pid} is unknown: ${holder.code})`);
                      return 'deferred';
                    }
                    released = true;
                    warn(`machine-lock-release-needs-head ${lockPath} (recorded pid ${current.owner.pid} is not this process; release as the head)`);
                    return 'needs-head';
                  }
                  released = true;
                  if (mine) {
                    fs.rmSync(lockPath, { recursive: true, force: true });
                    return 'released';
                  }
                  if (current.state === 'unknown') {
                    warn(`machine-lock-release-deferred ${lockPath} point=release-owner errno=${current.code}`);
                    return 'deferred';
                  }
                  cleanupOwnGone(ctx, token);
                  if (handed !== null) cleanupOwnGone(ctx, handed);
                  return 'kept';
                },
                setOwnerFields: (fields) => {
                  if (released) return false;
                  const current = readOwner(lockPath, codec);
                  if (!current || current.token !== token) return false;
                  const tmp = path.join(lockPath, `.owner-${crypto.randomUUID()}`);
                  fs.writeFileSync(tmp, codec.format({ ...current, ...fields, pid: current.pid, token }));
                  fs.renameSync(tmp, path.join(lockPath, 'owner'));
                  return true;
                },
                // D4 (#4288 PR1a): hand the lock, within this acquisition, to `pid` and its process group
                // `pgid` under a NEW token T1 = <T0>-g<pgid> (tmp + rename, read back). Only the live
                // holder calls it, before the process it protects starts (D9). T1 is this handle's from
                // the moment it is tried, so a release after a failure in the middle still knows it.
                handOff: (pid, pgid) => {
                  const t1 = `${token}-g${pgid}`;
                  if (released || !Number.isInteger(pid) || !validPgid(pgid)) return { ok: false, stage: 'token', token: t1 };
                  handed = t1;
                  const read = obs.owner('handoff-token', lockPath);
                  if (read.state !== 'record' || read.owner.token !== token) return { ok: false, stage: 'token', token: t1 };
                  const tmp = path.join(lockPath, `.owner-${t1}`);
                  try {
                    const code = hooks.fault?.('handoff-tmp', tmp);
                    if (code) throw Object.assign(new Error(`${code}: injected at handoff-tmp ${tmp}`), { code });
                    fs.writeFileSync(tmp, codec.format({ ...read.owner, pid, token: t1, pgid }));
                  } catch {
                    fs.rmSync(tmp, { force: true });
                    return { ok: false, stage: 'tmp', token: t1 };
                  }
                  hooks.onRecover?.('hand-off-tmp');
                  if (obs.rename('handoff-publish', tmp, path.join(lockPath, 'owner')).state !== 'moved') {
                    fs.rmSync(tmp, { force: true });
                    return { ok: false, stage: 'mv', token: t1 };
                  }
                  const back = obs.owner('handoff-verify', lockPath);
                  if (back.state !== 'record' || back.owner.token !== t1 || back.owner.pid !== pid || back.owner.pgid !== pgid) return { ok: false, stage: 'verify', token: t1 };
                  return { ok: true, token: t1 };
                },
              };
            }
            if (expired.state === 'unknown') unknown = expired.unknown;
            const read = obs.owner('lock-owner', lockPath);
            if (read.state === 'unknown' && !unknown) unknown = { point: 'lock-owner', path: path.join(lockPath, 'owner'), code: read.code };
            const holder = read.state === 'record' ? read.owner : null;
            if (holder && !broken.has(holder.token)) {
              const state = holderState(holder, ctx);
              if (state.state === 'gone') {
                broken.add(holder.token);
                // Persist what the dead holder was doing before its lock is gone (merge-pr: an unconfirmed write).
                options.onStaleHolder?.(holder);
                recoverLock(lockPath, holder, token, warn, hooks.onRecover, obs);
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
        return { acquired: false, waitedMs: t - startedAt, heldBy: heldBy(), ...gaveUp(), ...noLock() };
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

/**
 * The head of `queueDir`'s queue, for the operations that do not take the lock (#4288 PR1a D5 / D6):
 * a ticket is taken and waited on with the rules of acquireMachineLockSync (#4277: never retired by
 * age alone), and `whenHead(ctx)` runs while this caller is the head — when nobody of these
 * implementations mkdirs, recovers or rmdirs the lock. The ticket is done on every path.
 *
 * @returns {any} what `whenHead` returned, or `{ result: 'not-head', heldBy, unknown? }` when the
 * budget ran out first
 */
function asHead(lockPath, options, whenHead) {
  const { timeoutMs = HEAD_BUDGET_MS, pollMs = LOCK_POLL_MS, sleep = sleepSync, hooks = {} } = options;
  const codec = options.ownerCodec ?? JSON_OWNER_CODEC;
  const warn = options.warn ?? (() => {});
  const warned = new Set();
  const warnOnce = (line) => {
    if (warned.has(line)) return;
    warned.add(line);
    warn(line);
  };
  const now = hooks.now ?? (() => Date.now());
  const host = hooks.host ?? os.hostname();
  const obs = makeObserver({ fault: hooks.fault, pidAlive: hooks.pidAlive, groupAlive: hooks.groupAlive, kill: hooks.kill, codec });
  const env = {
    host,
    obs,
    link: hooks.link ?? ((src, dst) => fs.linkSync(src, dst)),
    beforeLink: hooks.beforeLink,
    startOf: (pid) => (hooks.startOf ? hooks.startOf(pid) : processStartMs(pid, now())),
  };
  const root = path.dirname(lockPath);
  const queueDir = queueDirOfPath(lockPath);
  const token = crypto.randomUUID();
  const ctx = { root, lockPath, host, obs, warn, warnOnce, onRecover: hooks.onRecover, myToken: token };
  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  const ticket = { pid: process.pid, host, token, createdAt: startedAt, deadline };
  let mine = null;
  try {
    for (;;) {
      if (mine !== null) {
        const current = readJson(path.join(queueDir, ticketName(mine)));
        if (!current || current.done === true || current.token !== token) mine = null;
      }
      let blocker = null;
      let unknown = null;
      if (mine === null) {
        mine = takeTicket(queueDir, ticket, env);
        if (mine === null) unknown = readQueue(queueDir, obs).unknown ?? null;
      }
      if (mine !== null) {
        const judged = { ...env, now: now() };
        const queue = readQueue(queueDir, obs);
        if (queue.unknown) unknown = queue.unknown;
        for (const entry of queue.entries) {
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
        if (!blocker && !queue.unknown) return whenHead(ctx);
      }
      const t = now();
      if (t >= deadline) {
        const heldBy = blocker ? `queue ticket ${blocker.file}${blocker.ticket ? ` (${describeOwner(blocker.ticket)})` : ' (unreadable)'}` : null;
        return { result: 'not-head', heldBy, ...(unknown ? { unknown } : {}) };
      }
      sleep(Math.min(pollMs, deadline - t));
    }
  } finally {
    if (mine !== null) markDone(path.join(queueDir, ticketName(mine)), token);
  }
}

/**
 * D5 (#4288 PR1a): the release by someone who is not the holder — UAT's `down` and the failure trap
 * after a handover, which stop the holder (the server) first. Between reading the token and the
 * delete a head could recover the dead holder's lock and take it, so this releases only as the head
 * of the queue (`options.timeoutMs`, default 10 s): one read of the owner; a record under one of
 * `tokens` whose holder (pid, and the group when it names one) is gone is removed ('released'); a
 * holder still there or unknown is left ('deferred': never under a group that did not empty); a
 * missing owner cleans only these tokens' own moved-aside records ('missing'); another token, a
 * corrupt record or an unreadable owner is left ('kept' / 'unknown'). Not the head in time:
 * 'not-head', nothing done (the holder is dead; the next head recovers it).
 *
 * @param {string} lockPath
 * @param {string[]} tokens
 * @param {{ timeoutMs?: number, pollMs?: number, sleep?: (ms: number) => void, warn?: (line: string) => void, ownerCodec?: { parse: (text: string) => any, format: (record: Record<string, unknown>) => string }, hooks?: Record<string, any> }} [options]
 * @returns {{ result: 'released' | 'missing' | 'deferred' | 'kept' | 'unknown' | 'not-head', unknown?: { point: string, path: string, code: string }, heldBy?: string | null }}
 */
export function releaseAsHead(lockPath, tokens, options = {}) {
  return asHead(lockPath, options, (ctx) => {
    ctx.onRecover?.('release-head-read');
    const read = ctx.obs.owner('release-owner', lockPath);
    if (read.state === 'unknown') {
      ctx.warn(`machine-lock-release-deferred ${lockPath} point=release-owner errno=${read.code}`);
      return { result: 'unknown', unknown: { point: 'release-owner', path: path.join(lockPath, 'owner'), code: read.code } };
    }
    if (read.state === 'missing') {
      for (const t of tokens) cleanupOwnGone(ctx, t);
      return { result: 'missing' };
    }
    if (read.state !== 'record' || !tokens.includes(read.owner.token)) return { result: 'kept' };
    const holder = holderState(read.owner, ctx);
    if (holder.state !== 'gone') {
      ctx.warn(`machine-lock-release-deferred ${lockPath} (holder pid ${read.owner.pid}${validPgid(read.owner.pgid) ? ` pgid ${read.owner.pgid}` : ''} is ${holder.state})`);
      return { result: 'deferred', ...(holder.state === 'unknown' ? { unknown: { point: holder.point, path: lockPath, code: holder.code } } : {}) };
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
    for (const t of tokens) cleanupOwnGone(ctx, t);
    return { result: 'released' };
  });
}

/**
 * D6 (#4288 PR1a): recover a dead holder's lock without taking it (the counterpart of bash's
 * lock_recover_only for supervisor.lock's deadline guard; no caller of this copy yet — it keeps the
 * three implementations' rules the same). As the head: the moved-aside records are settled (§2.7),
 * the owner read once, and a lock whose holder is gone is recovered (moved aside, its token checked,
 * put back when it differs); an owner-less, empty <lock> older than `options.ownerlessGraceMs` is
 * taken out. Never a mkdir of the lock.
 *
 * @param {string} lockPath
 * @param {{ timeoutMs?: number, pollMs?: number, sleep?: (ms: number) => void, warn?: (line: string) => void, ownerlessGraceMs?: number, ownerCodec?: { parse: (text: string) => any, format: (record: Record<string, unknown>) => string }, hooks?: Record<string, any> }} [options]
 * @returns {{ result: 'removed' | 'kept' | 'restore-failed' | 'absent' | 'not-head', unknown?: { point: string, path: string, code: string }, pending?: string }}
 */
export function recoverIfDead(lockPath, options = {}) {
  const now = options.hooks?.now ?? (() => Date.now());
  return asHead(lockPath, options, (ctx) => {
    const settled = settleGone(ctx);
    // The first unknown is the one returned, as bash's LRO_UNKNOWN (lock_note_unknown keeps the
    // first): a settle whose observation failed (list-root, gone-owner …) is not dropped by a later
    // answer such as 'absent' (Codex review-4288-pr1a P3).
    const first = settled.block && settled.unknown ? settled.unknown : null;
    const done = (result, unknown) => ({
      result,
      ...(first ?? unknown ? { unknown: first ?? unknown } : {}),
      ...(settled.block && settled.pending ? { pending: settled.pending } : {}),
    });
    const read = ctx.obs.owner('lock-owner', lockPath);
    if (read.state === 'unknown') return done('kept', { point: 'lock-owner', path: path.join(lockPath, 'owner'), code: read.code });
    if (read.state === 'corrupt') return done('kept');
    if (read.state === 'missing') {
      const expired = expireOwnerless(ctx, options.ownerlessGraceMs, now());
      if (expired.state === 'removed') return done('removed');
      if (expired.state === 'absent' || ownerlessEmptyLock(ctx).state === 'absent') return done('absent');
      return done('kept', expired.unknown);
    }
    const holder = holderState(read.owner, ctx);
    if (holder.state === 'unknown') return done('kept', { point: holder.point, path: lockPath, code: holder.code });
    if (holder.state !== 'gone') return done('kept');
    ctx.onRecover?.('recover-only-judged');
    const r = recoverLock(lockPath, read.owner, ctx.myToken, ctx.warn, ctx.onRecover, ctx.obs);
    return done(r === 'recovered' ? 'removed' : r === 'restore-failed' ? 'restore-failed' : r === 'gone' ? 'absent' : 'kept');
  });
}

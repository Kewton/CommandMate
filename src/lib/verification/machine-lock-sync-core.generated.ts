/* eslint-disable @typescript-eslint/ban-ts-comment -- byte copy of scripts/orchestrate/machine-lock-sync.mjs, pinned by tests/unit/verification/machine-lock-sync-core-copy-4559.test.ts */
// @ts-nocheck
/**
 * The machine-wide lock with first-come tickets, synchronously (Issue #4277).
 *
 * The convention src/lib/verification/machine-lock.ts runs too (through the byte
 * copy below) and verify-run.sh copies by hand (docs/design/verification-config.md
 * §9.2, docs/design/merge-queue-fair-lock-4277.md §2):
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
 * Since #4559 this file is the one copy of the steps (the generation chain,
 * docs/design/machine-lock-generation-4559.md): src/lib/verification/machine-lock.ts
 * imports its byte copy src/lib/verification/machine-lock-sync-core.generated.ts
 * (two fixed header lines, then these bytes; pinned by
 * tests/unit/verification/machine-lock-sync-core-copy-4559.test.ts) and only
 * waits between its polls. So this file imports node built-ins only, and nothing
 * of ES modules that a CommonJS build cannot carry (the copy test counts it). precheck.mjs (cpu.heavy) and merge-pr.mjs
 * (the merge lock) run it synchronously under spawnSync.
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
/**
 * An owner of 0 bytes older than this is taken out by the head (#4288 PR1a-f I4): fixed, for every head
 * (with or without ownerlessGraceMs). An older writer's `: >` / openSync and its write are microseconds
 * apart, so 10 min is far past any writer that is still writing (PM decision 1).
 */
export const EMPTY_OWNER_GRACE_MS = 600_000;
/**
 * The keys of the record the section writes itself (#4288 PR1a-f I1-c): a caller's `ownerFields` /
 * `setOwnerFields` may not carry them (an extra `pid` would make the record name another process).
 */
export const RESERVED_OWNER_FIELDS = ['pid', 'host', 'token', 'acquiredAt', 'started_at', 'pgid', 'v', 'lstart', 'done', 'g', 'tomb'];
/** The writer's version on the records this copy writes (#4288 PR1a-f I9): `v: 1` = tmp → link, the own pid, the rename undo. */
export const OWNER_VERSION = 1;
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
/** #4558: a release reads the owner this many times in one call before it answers 'deferred'. */
const RELEASE_READ_TRIES = 3;

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * `ps -o etime=`: `[[dd-]hh:]mm:ss` → milliseconds, or null. The ranges are checked (#4288 PR1a-f F37:
 * hours < 24, minutes and seconds < 60, a day field only with an hour field): a malformed answer is
 * null — never read as "just started".
 */
export function parseEtime(text) {
  const m = /^\s*(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  if (days !== undefined && hours === undefined) return null;
  const h = Number(hours ?? 0);
  const mi = Number(minutes);
  const sec = Number(seconds);
  if (h >= 24 || mi >= 60 || sec >= 60) return null;
  return (((Number(days ?? 0) * 24 + h) * 60 + mi) * 60 + sec) * 1000;
}

/**
 * When `pid` started (ms since epoch), from `ps -o etime=`; null when ps cannot say. `now` is taken
 * before ps and `clock()` again after it (#4288 PR1a-f, P1's observation window): a clock that stepped
 * back in between, or a read of 1 s or more, is null too (a step inside it cannot be told). `why.code`
 * says which null it is: ECLOCK for the clock (I3 names it so, F53), EINVAL for ps that cannot say.
 *
 * @param {{ code?: string }} [why]
 */
export function processStartMs(pid, now = Date.now(), clock = () => Date.now(), why = {}) {
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  const after = clock();
  why.code = 'EINVAL';
  if (r.error || r.status !== 0) return null;
  if (after < now || after - now >= 1000) {
    why.code = 'ECLOCK';
    return null;
  }
  const elapsed = parseEtime(r.stdout);
  if (elapsed === null) return null;
  delete why.code;
  return now - elapsed;
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
  // #4559 (T6): the fault seam is told how many times its point has been reached in this observer (1, 2, …),
  // so a test injects "EIO once" and the next poll reads again.
  const reached = new Map();
  const attempt = (point, target, fn) => {
    const count = (reached.get(point) ?? 0) + 1;
    reached.set(point, count);
    const code = hooks.fault?.(point, String(target), count);
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
    /**
     * lstat: dir / other (a file, a symlink) / absent / unknown — with the entry's own mtimeMs, size,
     * dev and ino, and `link` for a symlink (#4288 PR1a-f: the undo's inode check, the temporaries'
     * kind and age, the empty owner's size)
     */
    lstat(point, file) {
      try {
        const st = attempt(point, file, () => fs.lstatSync(file));
        return { state: st.isDirectory() ? 'dir' : 'other', mtimeMs: st.mtimeMs, size: st.size, dev: st.dev, ino: st.ino, link: st.isSymbolicLink(), file: st.isFile() };
      } catch (err) {
        return errCode(err) === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', point, code: errCode(err) };
      }
    },
    /** `<dir>/owner`: record / missing (ENOENT) / corrupt (read, not a record) / unknown */
    owner(point, dir) {
      return this.record(point, path.join(dir, 'owner'));
    },
    /** A record file (`<lock>/owner`, a generation's `owner` / `owner.h<k>`, #4559): the same four answers as `owner`. */
    record(point, file) {
      let text;
      try {
        text = attempt(point, file, () => fs.readFileSync(file, 'utf8'));
      } catch (err) {
        return errCode(err) === 'ENOENT' ? { state: 'missing' } : { state: 'unknown', point, code: errCode(err) };
      }
      let owner;
      try {
        owner = text.length === 0 ? null : hooks.codec ? hooks.codec.parse(text) : JSON.parse(text);
      } catch {
        return { state: 'corrupt' };
      }
      // An owner of 0 bytes (an older writer killed between its open and its write, or a power loss
      // after the link) is corrupt with `empty`: the head takes it out past EMPTY_OWNER_GRACE_MS (I4).
      if (text.length === 0) return { state: 'corrupt', empty: true };
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
     * The exclusive create of `tmp` (default `file`) with `text` written in whole and closed (#4288
     * PR1a D3 `O_CREAT|O_EXCL`, PR1a-f I1): created / exists (EEXIST: nothing opened) / unknown —
     * `opened` says whether this call made the file (only then is it the caller's to remove), `point`
     * where it failed: `owner-write` (the write threw), `owner-write-short` (the bytes written fall
     * short of `Buffer.byteLength(text)`), `owner-close` (closeSync threw: not known to be on disk).
     * The fault seam of `point` is called with `file` (the owner's name) before the open, so a test can
     * put a successor's owner there first. `onStage` is told `owner-tmp-opened` and `owner-tmp-written`
     * (the pauses of §2.6).
     */
    create(point, file, text, tmp = file, onStage = undefined) {
      let fd;
      try {
        fd = attempt(point, file, () => fs.openSync(tmp, 'wx'));
      } catch (err) {
        return errCode(err) === 'EEXIST' ? { state: 'exists' } : { state: 'unknown', point, code: errCode(err), opened: false };
      }
      onStage?.('owner-tmp-opened');
      const buf = Buffer.from(text);
      let failed = null;
      for (let off = 0; off < buf.length && !failed; ) {
        let wrote = 0;
        try {
          wrote = attempt('owner-write', file, () => fs.writeSync(fd, buf, off, buf.length - off));
        } catch (err) {
          failed = { point: 'owner-write', code: errCode(err) };
          break;
        }
        try {
          attempt('owner-write-short', file, () => {
            if (!(wrote > 0)) throw Object.assign(new Error(`short write: ${off} of ${buf.length} bytes`), { code: 'EIO' });
          });
        } catch (err) {
          failed = { point: 'owner-write-short', code: errCode(err) };
          break;
        }
        off += wrote;
      }
      try {
        attempt('owner-close', file, () => fs.closeSync(fd));
      } catch (err) {
        if (!failed) failed = { point: 'owner-close', code: errCode(err) };
      }
      if (failed) return { state: 'unknown', point: failed.point, code: failed.code, opened: true };
      onStage?.('owner-tmp-written');
      return { state: 'created' };
    },
    /** link(2): linked / exists (EEXIST — whatever is there: a file, a directory, a symlink) / absent (ENOENT) / unknown */
    link(point, from, to) {
      try {
        attempt(point, to, () => fs.linkSync(from, to));
        return { state: 'linked' };
      } catch (err) {
        const code = errCode(err);
        return code === 'EEXIST' ? { state: 'exists' } : code === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', point, code };
      }
    },
    /**
     * #4559: the exclusive create of a generation's tmp (`<name>.gen.tmp/<token>.<gN>.<use>.<k>`) with `text`
     * written in whole and closed: created / exists (EEXIST: nothing opened) / unknown with `opened`. The open
     * is `point` (the use's own: gen-owner-tmp, end-tmp …), the write `gen-tmp-write` (#4559 r6: a write that
     * fails after the open leaves the tmp, and the next try writes a tmp of another name — C8), the close the
     * open's point (the generation's own points, apart from the <lock>'s owner-create / owner-write …).
     */
    put(point, tmp, text) {
      let fd;
      try {
        fd = attempt(point, tmp, () => fs.openSync(tmp, 'wx'));
      } catch (err) {
        return errCode(err) === 'EEXIST' ? { state: 'exists' } : { state: 'unknown', point, code: errCode(err), opened: false };
      }
      try {
        const buf = Buffer.from(text);
        for (let off = 0; off < buf.length; ) {
          const wrote = attempt('gen-tmp-write', tmp, () => fs.writeSync(fd, buf, off, buf.length - off));
          if (!(wrote > 0)) throw Object.assign(new Error(`short write: ${off} of ${buf.length} bytes`), { code: 'EIO' });
          off += wrote;
        }
      } catch (err) {
        try {
          fs.closeSync(fd);
        } catch {
          // the write's errno is the one named
        }
        return { state: 'unknown', point: 'gen-tmp-write', code: errCode(err), opened: true };
      }
      try {
        fs.closeSync(fd);
      } catch (err) {
        return { state: 'unknown', point, code: errCode(err), opened: true };
      }
      return { state: 'created' };
    },
    /**
     * realpath (#4559 C7): resolved with the path / absent (ENOENT) / unknown — never the string given back.
     * The native realpath (#4559 r6, C7-I1): the directory's own spelling, so two spellings of one directory on a
     * filesystem that does not tell case apart answer one path (the JS realpath gives the caller's spelling back).
     */
    realpath(point, p) {
      try {
        return { state: 'resolved', path: attempt(point, p, () => fs.realpathSync.native(p)) };
      } catch (err) {
        return errCode(err) === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', point, code: errCode(err) };
      }
    },
    /** #4559 r6: the text of a file (a generation's `fields`): text / missing (ENOENT) / unknown */
    text(point, file) {
      try {
        return { state: 'text', text: attempt(point, file, () => fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        return errCode(err) === 'ENOENT' ? { state: 'missing' } : { state: 'unknown', point, code: errCode(err) };
      }
    },
    /** unlink of a file name: removed / absent (ENOENT) / unknown */
    unlink(point, file) {
      try {
        attempt(point, file, () => fs.unlinkSync(file));
        return { state: 'removed' };
      } catch (err) {
        return errCode(err) === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', point, code: errCode(err) };
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
 * The one place a clean-up delete runs (#4288 PR1a-f impl-2 / impl-3): a tmp, a used ticket, a
 * moved-aside directory, the own <lock> at release. Never throws — `force` quiets ENOENT only, so an
 * EACCES / EIO / EBUSY of the unlink is caught here — and so never writes over the caller's answer or
 * exception. With `warn`, a failure is named `machine-lock-cleanup-left <path> (<errno>; <what>)`.
 * The errno, or null when removed or gone already.
 *
 * @param {string} target
 * @param {{ recursive?: boolean, warn?: (line: string) => void, what?: string }} [o]
 */
function rmQuiet(target, o = {}) {
  try {
    fs.rmSync(target, { recursive: o.recursive === true, force: true });
    return null;
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : 'EUNKNOWN';
    o.warn?.(`machine-lock-cleanup-left ${target} (${code}; ${o.what ?? 'clean-up'}, not removed)`, { event: 'machine-lock-cleanup-left', path: target, code, what: o.what ?? 'clean-up' });
    return code;
  }
}

/**
 * Mark the ticket at `file` used, if it is still `token`'s: a `{done:true}` record
 * renamed over it, so readers see the old or the new content, never half.
 */
export function markDone(file, token, warn = () => {}) {
  const current = readJson(file);
  if (!current || current.token !== token || current.done === true) return false;
  const tmp = path.join(path.dirname(file), `.d-${token}-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ done: true, token, doneAt: Date.now() }));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    rmQuiet(tmp, { warn, what: 'the tmp of a ticket marked used' });
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
        markDone(file, content.token, env.warn);
        continue;
      }
      return n;
    }
    return null;
  } finally {
    // A failed delete is named, never thrown over the number: a published ticket has to reach `mine`.
    rmQuiet(tmp, { warn: env.warn, what: 'the tmp of a ticket' });
  }
}

/** Delete used tickets below the largest number (the largest is kept: it is what makes a late ticket withdraw). */
function collectGarbage(queueDir, now, warn = () => {}) {
  const numbers = ticketNumbers(queueDir);
  const max = numbers.length > 0 ? numbers[numbers.length - 1] : 0;
  for (const n of numbers) {
    if (n >= max) continue;
    const file = path.join(queueDir, ticketName(n));
    if (readJson(file)?.done === true) rmQuiet(file, { warn, what: 'a used ticket' });
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
      if (now - fs.statSync(file).mtimeMs > TEMP_MAX_AGE_MS) rmQuiet(file, { warn, what: 'an old ticket tmp' });
    } catch {
      // gone meanwhile
    }
  }
}

/**
 * @returns {boolean} true when this call created the directory and owns it. A `mkdir` that failed
 * for another reason than EEXIST is not a claim and not a contention either: it throws, naming the errno.
 */
function claim(lockPath, owner, obs, warn = () => {}, codec = JSON_OWNER_CODEC, onStage = undefined) {
  const made = obs.mkdir('mkdir-lock', lockPath);
  if (made.state === 'exists') return false;
  if (made.state !== 'created') {
    const err = new Error(`machine-lock-unknown point=mkdir-lock path=${lockPath} errno=${made.code}`);
    err.code = made.code;
    throw err;
  }
  onStage?.('owner-lock-made');
  return publishOwner(lockPath, owner, obs, warn, codec, onStage);
}

const unknownError = (point, target, code) => {
  const err = new Error(`machine-lock-unknown point=${point} path=${target} errno=${code}`);
  err.code = code;
  return err;
};

/**
 * The owner of a <lock> this acquisition made, published whole (#4288 PR1a-f I1, the same as
 * verify-run.sh's lock_obs_create and machine-lock.ts): written into `<lock>/.owner-<token>` (exclusive
 * create, every byte written, closed) and published with link(2) — so `<lock>/owner` is never seen
 * empty or half written, and an owner there (a file, a directory, a symlink to either) is never written
 * over or into (EEXIST). Read back, the tmp removed. What a failure removes is only this call's own
 * (I2, design §3): its tmp, the <lock> it made (rmdir: only when empty), and — when the read-back cannot
 * be judged — the owner it published, moved to its own name `.undo-<token>` first and removed only when
 * that is the tmp's inode (otherwise linked back: I2-b). Test seams: `fault` at owner-create,
 * owner-write, owner-write-short, owner-close, owner-publish, owner-readback, owner-unlink, lock-rmdir,
 * owner-undo-rename, owner-undo-lstat, owner-undo-link; `onStage` at the five pauses of §2.6.
 *
 * @returns {boolean} true when the owner read back is this one; false when another is there (not
 * acquired, nothing of anyone else removed). Throws `machine-lock-unknown point=… path=… errno=…` when
 * the owner could not be published or judged (the acquisition ends, as a failed mkdir does).
 */
function publishOwner(lockPath, owner, obs, warn, codec, onStage) {
  const file = path.join(lockPath, 'owner');
  const tmp = path.join(lockPath, `.owner-${owner.token}`);
  const dropTmp = () => obs.unlink('owner-unlink', tmp).state !== 'unknown';
  const takeOut = () => obs.rmdir('lock-rmdir', lockPath).state === 'removed';
  const again = (out) => (out ? 'taken out again; not acquired' : 'and it could not be taken out again');
  const created = obs.create('owner-create', file, codec.format(owner), tmp, onStage);
  if (created.state !== 'created') {
    if (created.state === 'exists' || !created.opened) {
      // F2 (a tmp of this token is there: not opened, not removed — the rmdir fails on it) and F3.
      const code = created.state === 'exists' ? 'EEXIST' : created.code;
      const out = takeOut();
      warn(`machine-lock-owner-create-failed ${lockPath} (${code}; ${again(out)})`, { event: 'machine-lock-owner-create-failed', lockPath, code, takenOut: out });
      throw unknownError('owner-create', file, code);
    }
    // F4-F6 (F17, F18 when the undo fails): the tmp opened by this call, and the <lock> it made.
    const out = dropTmp() && takeOut();
    warn(`machine-lock-owner-write-failed ${lockPath} (${created.code}; ${again(out)})`, { event: 'machine-lock-owner-write-failed', lockPath, code: created.code, takenOut: out });
    throw unknownError(created.point, file, created.code);
  }
  const linked = obs.link('owner-publish', tmp, file);
  if (linked.state === 'exists') {
    // F7-F10: an owner there — a file, a directory, a symlink — is left as it is; only the own tmp goes.
    dropTmp();
    warn(`machine-lock-owner-exists ${lockPath} (not acquired; nothing removed)`, { event: 'machine-lock-owner-exists', lockPath });
    return false;
  }
  if (linked.state !== 'linked') {
    dropTmp();
    if (linked.state === 'absent') {
      // F11: this <lock> or the tmp was taken out meanwhile; a <lock> there now is not shown to be ours.
      warn(`machine-lock-owner-publish-failed ${lockPath} (ENOENT; nothing else removed)`, { event: 'machine-lock-owner-publish-failed', lockPath, code: 'ENOENT', takenOut: false });
      throw unknownError('owner-publish', file, 'ENOENT');
    }
    const out = takeOut();
    warn(`machine-lock-owner-publish-failed ${lockPath} (${linked.code}; ${again(out)})`, { event: 'machine-lock-owner-publish-failed', lockPath, code: linked.code, takenOut: out });
    throw unknownError('owner-publish', file, linked.code);
  }
  onStage?.('owner-linked');
  const back = obs.owner('owner-readback', lockPath);
  if (back.state === 'record' && back.owner.token === owner.token) {
    // F16: a tmp that cannot be removed stays beside the owner; the release / the recovery takes it.
    dropTmp();
    onStage?.('owner-tmp-removed');
    return true;
  }
  if (back.state !== 'unknown') {
    dropTmp();
    warn(`machine-lock-owner-not-ours ${lockPath} (another record read back; not acquired, nothing removed)`, { event: 'machine-lock-owner-not-ours', lockPath });
    return false;
  }
  const undone = undoPublish(lockPath, owner.token, obs, warn);
  warn(`machine-lock-owner-readback-unknown ${lockPath} (${back.code}; ${undone})`, { event: 'machine-lock-owner-readback-unknown', lockPath, code: back.code, undo: undone });
  throw unknownError('owner-readback', file, back.code);
}

/**
 * I2-b (#4288 PR1a-f): the owner this call published could not be read back. It is never removed by
 * its name after a check (a successor's owner may be under that name by then): it is renamed to this
 * call's own name `.undo-<token>`, and that name is checked against the tmp (lstat of both, dev and ino;
 * not a symlink). The same inode: both names removed and the <lock> rmdir'd (F13). Anything else — another
 * inode, a symlink, no tmp to compare, an lstat that failed — is linked back to `<lock>/owner` (F14); a
 * link back that meets an owner (EEXIST, F58) or fails keeps `.undo-<token>` and says so. The rename
 * finding no owner (F59) or failing (F60) removes only the own tmp. No rmdir but in F13.
 *
 * @returns {string} what was done, for the warning
 */
function undoPublish(lockPath, token, obs, warn) {
  const file = path.join(lockPath, 'owner');
  const tmp = path.join(lockPath, `.owner-${token}`);
  const undo = path.join(lockPath, `.undo-${token}`);
  const dropTmp = () => obs.unlink('owner-unlink', tmp);
  const moved = obs.rename('owner-undo-rename', file, undo);
  if (moved.state !== 'moved') {
    dropTmp();
    return moved.state === 'absent' ? 'no owner to undo' : `the undo rename failed (${moved.code}); the owner left`;
  }
  const a = obs.lstat('owner-undo-lstat', undo);
  const b = obs.lstat('owner-undo-lstat', tmp);
  const same = a.state === 'other' && b.state === 'other' && !a.link && !b.link && a.dev === b.dev && a.ino === b.ino;
  if (same) {
    obs.unlink('owner-unlink', undo);
    dropTmp();
    return obs.rmdir('lock-rmdir', lockPath).state === 'removed' ? 'own owner undone, taken out again' : 'own owner undone; the <lock> could not be taken out again';
  }
  const restored = obs.link('owner-undo-link', undo, file);
  dropTmp();
  if (restored.state === 'linked') {
    obs.unlink('owner-unlink', undo);
    return 'not shown to be ours: linked back';
  }
  const code = restored.state === 'unknown' ? restored.code : restored.state === 'exists' ? 'EEXIST' : 'ENOENT';
  warn(`machine-lock-undo-restore-failed ${lockPath} kept=${undo} (${code})`, { event: 'machine-lock-undo-restore-failed', lockPath, kept: undo, code });
  return `not shown to be ours and not linked back: kept ${undo}`;
}

/** The temporaries an owner-less <lock> may hold (I3): the new `.owner-<token>` and an older writer's `owner.tmp.<pid>`. */
const NEW_TMP = /^\.owner-[A-Za-z0-9-]+$/;
const OLD_TMP = /^owner\.tmp\.(.*)$/;

/**
 * I3's predicate (#4288 PR1a-f), used by the clean-up (expireOwnerless) only: `<lock>` has no owner and
 * holds nothing but temporaries — `.owner-<token>` or `owner.tmp.<digits>`, each a regular file (not a
 * symlink). ownerlessEmptyLock ("no owner and nothing in it") keeps its meaning for the put-back.
 *
 * @returns {{ state: 'no' | 'absent' | 'empty' } | { state: 'temps', temps: { name: string, file: string, mtimeMs: number, pid: number | null }[] } | { state: 'stray', name: string } | { state: 'unknown', unknown: { point: string, path: string, code: string } }}
 */
function ownerlessTempsOnly(ctx) {
  const owner = ctx.obs.owner('lock-owner', ctx.lockPath);
  if (owner.state === 'unknown') return { state: 'unknown', unknown: { point: 'lock-owner', path: path.join(ctx.lockPath, 'owner'), code: owner.code } };
  if (owner.state !== 'missing') return { state: 'no' };
  const listed = ctx.obs.list('lock-list', ctx.lockPath);
  if (listed.state === 'absent') return { state: 'absent' };
  if (listed.state === 'unknown') return { state: 'unknown', unknown: { point: 'lock-list', path: ctx.lockPath, code: listed.code } };
  const temps = [];
  for (const name of [...listed.names].sort()) {
    const old = OLD_TMP.exec(name);
    if (!NEW_TMP.test(name) && !(old && /^\d+$/.test(old[1]))) return { state: 'stray', name };
    const file = path.join(ctx.lockPath, name);
    const st = ctx.obs.lstat('ownerless-tmp-lstat', file);
    if (st.state === 'unknown') return { state: 'unknown', unknown: { point: 'ownerless-tmp-lstat', path: file, code: st.code } };
    if (st.state === 'absent') continue;
    if (st.state !== 'other' || st.link || !st.file) return { state: 'stray', name }; // a FIFO, a socket … too (as bash)
    temps.push({ name, file, mtimeMs: st.mtimeMs, pid: old ? Number(old[1]) : null });
  }
  return temps.length === 0 ? { state: 'empty' } : { state: 'temps', temps };
}

/**
 * D3 (#4288 PR1a) and I3 (PR1a-f): with `graceMs`, the head takes out an owner-less <lock> that holds
 * nothing or only temporaries, when the <lock> and every temporary are older than `graceMs` and every
 * older `owner.tmp.<pid>` is shown not to be its writer's: the pid is gone (ESRCH), or alive but started
 * after the tmp's mtime + PID_REUSE_SLACK_MS (reused). Only those names are unlinked (an ENOENT is "gone
 * already"), then the <lock> rmdir'd — never the name `owner`; an owner published meanwhile makes the
 * rmdir fail (ENOTEMPTY: `published`, judged as a record). A name that is not a temporary is `stray` and
 * an older writer that may be stopped mid-way is `old-taker` (named, not taken). Only the head calls
 * this. The ages are compared in ms (D11). An unknown keeps the poll from the mkdir and is reported.
 *
 * @returns {{ state: 'none' | 'absent' | 'young' | 'removed' | 'stray' | 'old-taker' | 'published' | 'unknown', unknown?: { point: string, path: string, code: string } }}
 */
function expireOwnerless(ctx, graceMs, now) {
  if (typeof graceMs !== 'number') return { state: 'none' };
  const found = ownerlessTempsOnly(ctx);
  if (found.state === 'unknown') return found;
  if (found.state === 'no') return { state: 'none' };
  if (found.state === 'absent') return { state: 'absent' };
  if (found.state === 'stray') {
    ctx.warnOnce(`machine-lock-ownerless-stray ${ctx.lockPath} (${found.name} is not a temporary of an owner: nobody takes the <lock> out; look at it and remove it by hand)`);
    return { state: 'stray' };
  }
  const temps = found.state === 'temps' ? found.temps : [];
  for (const t of temps) if (t.pid !== null) ctx.warnOnce(`machine-lock-legacy-writer ${ctx.lockPath} pid=${t.pid}`);
  const st = ctx.obs.lstat('ownerless-mtime', ctx.lockPath);
  if (st.state === 'absent') return { state: 'absent' };
  if (st.state === 'unknown') return { state: 'unknown', unknown: { point: 'ownerless-mtime', path: ctx.lockPath, code: st.code } };
  const age = now - st.mtimeMs;
  if (age <= graceMs || temps.some((t) => now - t.mtimeMs <= graceMs)) return { state: 'young' };
  for (const t of temps) {
    if (t.pid === null) continue;
    const pid = ctx.obs.pid('owner-tmp-pid', t.pid);
    if (pid.state === 'gone') continue;
    if (pid.state === 'unknown') return { state: 'unknown', unknown: { point: 'owner-tmp-pid', path: t.file, code: pid.code } };
    const why = {};
    const start = ctx.startOf(t.pid, why);
    if (start === null) return { state: 'unknown', unknown: { point: 'etime', path: t.file, code: why.code ?? 'EINVAL' } };
    if (start > t.mtimeMs + PID_REUSE_SLACK_MS) continue;
    ctx.warnOnce(`machine-lock-ownerless-old-taker ${ctx.lockPath} pid=${t.pid} (an older writer that may be stopped before its rename: not taken out)`);
    return { state: 'old-taker' };
  }
  for (const t of temps) {
    const gone = ctx.obs.unlink('ownerless-tmp-unlink', t.file);
    if (gone.state === 'unknown') return { state: 'unknown', unknown: { point: 'ownerless-tmp-unlink', path: t.file, code: gone.code } };
  }
  const removed = ctx.obs.rmdir('ownerless-rmdir', ctx.lockPath);
  if (removed.state === 'unknown') {
    if (removed.code === 'ENOTEMPTY' || removed.code === 'EEXIST') return { state: 'published' };
    return { state: 'unknown', unknown: { point: 'ownerless-rmdir', path: ctx.lockPath, code: removed.code } };
  }
  ctx.warn(`machine-lock-ownerless-removed ${ctx.lockPath} (no owner for ${Math.round(age)} ms${temps.length ? `; ${temps.map((t) => t.name).join(' ')} removed` : ''})`);
  return { state: 'removed' };
}

/**
 * I4 (#4288 PR1a-f): an owner of 0 bytes older than EMPTY_OWNER_GRACE_MS is taken out by the head —
 * any head, with or without a grace. The <lock> is moved to this caller's own name
 * `<lock>.gone-<token>-<serial>`, and removed only when the owner moved is still of 0 bytes and old: one
 * that was written meanwhile is kept aside and judged as a record by the next pass (§2.7).
 *
 * @returns {{ state: 'none' | 'young' | 'removed' | 'kept' | 'unknown', aside?: string, unknown?: { point: string, path: string, code: string } }}
 */
function reclaimEmptyOwner(ctx, now) {
  const ownerFile = path.join(ctx.lockPath, 'owner');
  const empty = (st) => st.state === 'other' && st.file && st.size === 0;
  const st = ctx.obs.lstat('lock-owner', ownerFile);
  if (st.state === 'unknown') return { state: 'unknown', unknown: { point: 'lock-owner', path: ownerFile, code: st.code } };
  if (!empty(st)) return { state: 'none' };
  if (now - st.mtimeMs <= EMPTY_OWNER_GRACE_MS) return { state: 'young' };
  const aside = `${ctx.lockPath}.gone-${ctx.myToken}-${++goneSerial}`;
  const moved = ctx.obs.rename('empty-owner-move', ctx.lockPath, aside);
  if (moved.state === 'absent') return { state: 'none' };
  if (moved.state !== 'moved') return { state: 'unknown', unknown: { point: 'empty-owner-move', path: ctx.lockPath, code: moved.code } };
  ctx.onRecover?.('empty-owner-moved');
  const after = ctx.obs.lstat('reclaim-owner', path.join(aside, 'owner'));
  if (empty(after) && now - after.mtimeMs > EMPTY_OWNER_GRACE_MS) {
    rmQuiet(aside, { recursive: true, warn: ctx.warn, what: 'the own moved-aside <lock> of an old empty owner' });
    ctx.warn(`machine-lock-empty-owner-removed ${ctx.lockPath} (an owner of 0 bytes, ${Math.round(now - st.mtimeMs)} ms old)`, { event: 'machine-lock-empty-owner-removed', lockPath: ctx.lockPath, ageMs: Math.round(now - st.mtimeMs) });
    return { state: 'removed' };
  }
  ctx.warn(`machine-lock-empty-owner-kept ${ctx.lockPath}: kept ${aside} (no longer an old empty owner: judged as a record next)`, { event: 'machine-lock-empty-owner-kept', lockPath: ctx.lockPath, kept: aside });
  return { state: 'kept', aside };
}

/** I4: an unparsable owner is never removed; it is named (once). */
const warnCorrupt = (ctx) =>
  ctx.warnOnce(`machine-lock-owner-corrupt ${path.join(ctx.lockPath, 'owner')} unparsable (nobody removes it: look at it and remove the <lock> by hand)`, {
    event: 'machine-lock-owner-corrupt',
    owner: path.join(ctx.lockPath, 'owner'),
    why: 'unparsable; nobody removes it: look at it and remove the <lock> by hand',
  });

/** I9: a record without `v` is an older copy's; named once per process and lock (the observation §6.1 (b) reads). */
const noteLegacy = (ctx, lockPath, record) => {
  if (record && record.v === undefined) ctx.warnOnce(`machine-lock-legacy-writer ${lockPath} pid=${record.pid}`, { event: 'machine-lock-legacy-writer', lockPath, pid: record.pid });
};

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
 * Put a moved-aside owner back into `<lock>` and drop the moved-aside directory. The put-back is a
 * link(2) (#4288 PR1a-f I2-c): an owner published between the check and the put-back is never written
 * over — EEXIST keeps the moved-aside directory and the <lock> (it holds the publisher's owner) and is
 * `restore-failed`, named. ENOENT (the owner is not there) is 'absent'; any other failure takes the
 * `<lock>` this put-back made out again (it is empty) and keeps the moved-aside directory, which goes on
 * holding the lock (§2.7 B).
 */
function moveOwnerIn(ctx, gone) {
  const moved = ctx.obs.link('restore-rename', path.join(gone, 'owner'), path.join(ctx.lockPath, 'owner'));
  if (moved.state === 'linked') {
    ctx.onRecover?.('restore-owner');
    rmQuiet(gone, { recursive: true, warn: ctx.warn, what: 'the moved-aside directory after the put-back' });
    return 'restored';
  }
  if (moved.state === 'absent') return 'absent';
  if (moved.state === 'exists') {
    ctx.warn(`machine-lock-restore-failed ${ctx.lockPath}: kept ${gone} (EEXIST)`, { event: 'machine-lock-restore-failed', lockPath: ctx.lockPath, kept: gone, code: 'EEXIST' });
    return 'restore-failed';
  }
  rmdirQuiet(ctx.lockPath);
  ctx.warn(`machine-lock-restore-failed ${ctx.lockPath}: kept ${gone} (${moved.code})`, { event: 'machine-lock-restore-failed', lockPath: ctx.lockPath, kept: gone, code: moved.code });
  return 'restore-failed';
}

/** §2.7 rows 2, 3 and 5: a moved-aside record that is alive (or not known to be gone) is put back. */
function restoreFromGone(ctx, gone) {
  const made = ctx.obs.mkdir('restore-mkdir', ctx.lockPath);
  if (made.state === 'created') {
    ctx.onRecover?.('restore-mkdir');
    const r = moveOwnerIn(ctx, gone);
    if (r === 'absent') rmdirQuiet(ctx.lockPath);
    if (r === 'restored') ctx.warn(`machine-lock-restored ${ctx.lockPath} from ${gone}`, { event: 'machine-lock-restored', lockPath: ctx.lockPath, from: gone });
    return;
  }
  if (made.state === 'exists') {
    const half = ownerlessEmptyLock(ctx).state;
    if (half === 'yes') {
      if (moveOwnerIn(ctx, gone) === 'restored') ctx.warn(`machine-lock-restored ${ctx.lockPath} from ${gone} (completed a put-back)`, { event: 'machine-lock-restored', lockPath: ctx.lockPath, from: gone, completed: true });
    } else if (half === 'no') {
      ctx.warnOnce(`machine-lock-restore-failed ${ctx.lockPath}: kept ${gone} (the lock holds another record)`, { event: 'machine-lock-restore-failed', lockPath: ctx.lockPath, kept: gone, reason: 'the lock holds another record' });
    }
    return;
  }
  ctx.warnOnce(`machine-lock-restore-failed ${ctx.lockPath}: kept ${gone} (${made.code})`, { event: 'machine-lock-restore-failed', lockPath: ctx.lockPath, kept: gone, code: made.code });
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
    rmQuiet(mine, { recursive: true, warn: ctx.warn, what: 'the own moved-aside record judged gone' });
    ctx.warn(`machine-lock-gone-recovered ${gone} pid=${moved.owner.pid}`, { event: 'machine-lock-gone-recovered', gone, pid: moved.owner.pid });
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
    ctx.warnOnce(`machine-lock-gone-unreadable ${found.unknown.path} ${found.unknown.code}`, { event: 'machine-lock-gone-unreadable', gone: found.unknown.path, code: found.unknown.code });
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
      ctx.warnOnce(`machine-lock-gone-unreadable ${gone} ${read.code}`, { event: 'machine-lock-gone-unreadable', gone, code: read.code });
      hold(`${gone} unreadable`, { point: 'gone-owner', path: path.join(gone, 'owner'), code: read.code });
      continue;
    }
    if (read.state === 'missing') {
      rmdirQuiet(gone);
      continue;
    }
    if (read.state === 'corrupt') continue;
    noteLegacy(ctx, ctx.lockPath, read.owner);
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
    ctx.warn(`machine-lock-gone-unreadable ${found.unknown.path} ${found.unknown.code}`, { event: 'machine-lock-gone-unreadable', gone: found.unknown.path, code: found.unknown.code });
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
    rmQuiet(gone, { recursive: true, warn, what: 'the own moved-aside record judged gone' });
    warn(`machine-lock-broken-stale ${lockPath} pid=${dead.pid}`, { event: 'machine-lock-broken-stale', lockPath, pid: dead.pid });
    return 'recovered';
  }
  const made = obs.mkdir('restore-mkdir', lockPath);
  if (made.state !== 'created') {
    warn(`machine-lock-restore-failed ${lockPath}: kept ${gone}`, { event: 'machine-lock-restore-failed', lockPath, kept: gone });
    return 'restore-failed';
  }
  onRecover?.('restore-mkdir');
  // The put-back links (I2-c): an owner published in between is not written over.
  const back = obs.link('restore-rename', path.join(gone, 'owner'), path.join(lockPath, 'owner'));
  if (back.state === 'exists') {
    warn(`machine-lock-restore-failed ${lockPath}: kept ${gone} (EEXIST)`, { event: 'machine-lock-restore-failed', lockPath, kept: gone, code: 'EEXIST' });
    return 'restore-failed';
  }
  if (back.state === 'unknown') {
    rmdirQuiet(lockPath);
    warn(`machine-lock-restore-failed ${lockPath}: kept ${gone} (${back.code})`, { event: 'machine-lock-restore-failed', lockPath, kept: gone, code: back.code });
    return 'restore-failed';
  }
  // ENOENT: the moved lock had no owner — a new writer's temporaries only (its link then answers ENOENT).
  if (back.state === 'linked') onRecover?.('restore-owner');
  rmQuiet(gone, { recursive: true, warn, what: 'the moved-aside directory after the put-back' });
  return 'restored';
}

/**
 * #4559: recover a holder judged gone only while the record is still the one judged. Read again right
 * before recoverLock moves it: a recoverer that stopped after its judgement finds the next holder's
 * live record there and leaves it ('changed'; I3: only the record judged is moved). This narrows the
 * window; a stop after this read and before recoverLock's rename is not closed here (#4559 stays open
 * for it). recoverLock itself keeps its contract (it moves, then checks the token, and puts back).
 * A read that failed moves nothing and is 'reread-unknown' with its point, path and errno: the caller
 * does not take the holder as broken and judges again. A lock gone meanwhile is 'gone', as recoverLock's
 * own ENOENT is; when that check itself cannot observe (the owner read or the listing of an owner-less
 * <lock> fails), it is 'reread-unknown' too.
 *
 * @returns {{ result: 'recovered' | 'restored' | 'restore-failed' | 'gone' | 'unknown' | 'changed' | 'reread-unknown', unknown?: { point: string, path: string, code: string } }}
 */
function recoverJudged(ctx, dead) {
  const current = ctx.obs.owner('lock-owner', ctx.lockPath);
  if (current.state === 'unknown') return { result: 'reread-unknown', unknown: { point: 'lock-owner', path: path.join(ctx.lockPath, 'owner'), code: current.code } };
  if (current.state === 'missing') {
    const e = ownerlessEmptyLock(ctx);
    if (e.state === 'unknown') return { result: 'reread-unknown', unknown: e.unknown };
    return { result: e.state === 'absent' ? 'gone' : 'changed' };
  }
  if (current.state !== 'record' || current.owner.token !== dead.token) return { result: 'changed' };
  return { result: recoverLock(ctx.lockPath, dead, ctx.myToken, ctx.warn, ctx.onRecover, ctx.obs) };
}

// ---------------------------------------------------------------------------
// The generation chain (#4559, docs/design/machine-lock-generation-4559.md §3–§4)
//
//   <genDir>/g<12 digits>/{owner, owner.h<k>, fields, end}   one name per holding, never reused
//   <genDir>.tmp/<token>.<gN>.<use>                           the tmp of each record (C8)
//
// The holder is the largest generation without `end`. A generation is only ever added to (link(2) of a
// tmp), and only `fields` is replaced. Nothing is moved by its name after a judgement: a recoverer that
// stops after it judged writes `end` into the generation it judged, whose holders are all dead (L2, L5).
// The <lock> (`<name>.lock`) stays as the beacon for the older versions that do not read `.gen` (§6.1).
// ---------------------------------------------------------------------------

/** A generation's directory name: `g` and 12 zero-padded digits (C5); anything else is not counted. */
export const GEN_PATTERN = /^g\d{12}$/;
export const genName = (n) => `g${String(n).padStart(12, '0')}`;
/** An owner-less generation (its writer stopped or died before the owner's link) gets a tomb after this (§4.4; P0). */
export const GEN_OWNERLESS_GRACE_MS = 600_000;
/** Another writer's tmp in `<name>.gen.tmp/` older than this is removed (C8). */
export const GEN_TMP_MAX_AGE_MS = 600_000;
/** The root of the machine locks (the same resolution as machine-lock.ts `resolveMachineLockRoot`). */
export const MACHINE_LOCK_ROOT_ENV = 'CM_VERIFY_LOCK_ROOT';

export function machineLockRootOf(env = process.env) {
  const override = env[MACHINE_LOCK_ROOT_ENV];
  return override && override.trim() !== '' ? override : path.join(os.homedir(), '.commandmate', 'locks');
}

/**
 * The generation directory of the lock at `lockPath` (§3, C7), or the unknown that kept it from being
 * chosen. A lock directly under the machine-lock root (`<root>/<name>.lock`, named or by path alike) has
 * `<root>/<name>.gen`; any other lock — run-lock's `$TMPDIR/commandmate-run.lock`, a lock under another
 * root — has `<root>/by-path/<hash>.gen`, the hash made from the realpath of the lock's parent and its base
 * name, so `/var/…` and `/private/var/…` are one name. The choice depends on the path only, never on how
 * the caller named the lock: one lock, one chain (S1 and S2 are proved for the writers of one lock that all
 * see one chain). Both realpaths are observations (`gen-realpath`): a failure is unknown — no chain is
 * chosen from the string of the path (#4559 comment 7183455133). The root's realpath not resolved — unknown
 * or absent (ENOENT) alike — chooses no chain either (#4559 r6, C7-I2): a root that cannot be seen is not
 * shown to be another directory than the lock's parent. The two realpaths are compared as the native
 * realpath answers them (the directory's own spelling, C7-I1); the acquisition makes the root first, so an
 * absent root is a root removed or misspelled meanwhile.
 *
 * @returns {{ genDir: string } | { unknown: { point: string, path: string, code: string } }}
 */
export function resolveGenDir(lockPath, env = process.env, obs = makeObserver()) {
  const root = machineLockRootOf(env);
  const parent = obs.realpath('gen-realpath', path.dirname(lockPath));
  if (parent.state !== 'resolved') return { unknown: { point: 'gen-realpath', path: path.dirname(lockPath), code: parent.state === 'absent' ? 'ENOENT' : parent.code } };
  const named = entrySpelling(obs, parent.path, path.basename(lockPath));
  if (named.unknown) return { unknown: named.unknown };
  const base = named.base;
  if (base.endsWith('.lock')) {
    const realRoot = obs.realpath('gen-realpath', root);
    if (realRoot.state !== 'resolved') return { unknown: { point: 'gen-realpath', path: root, code: realRoot.state === 'absent' ? 'ENOENT' : realRoot.code } };
    if (parent.path === realRoot.path) return { genDir: path.join(root, `${base.slice(0, -'.lock'.length)}.gen`) };
  }
  return { genDir: path.join(root, 'by-path', `${byPathHash(`${parent.path}/${base}`)}.gen`) };
}

/**
 * #4559 r6 (D2, #4559 comment 7185752051, plan (i)): the base name of the lock as its parent's entry spells it.
 * The lock there (`gen-base-lstat`): the parent is read (`gen-base-list`) and the entry that is the same directory
 * (dev and ino) gives the spelling — on a filesystem that does not tell case apart `X.lock` and `x.lock` are one
 * entry, on one that does they are two entries and stay two locks (no check of the filesystem). The lock not
 * there: the name as given (nothing to read the spelling from). A read that fails is unknown: no chain (C7-I2).
 *
 * @returns {{ base: string } | { unknown: { point: string, path: string, code: string } }}
 */
function entrySpelling(obs, dir, base) {
  const file = path.join(dir, base);
  const st = obs.lstat('gen-base-lstat', file);
  if (st.state === 'absent') return { base };
  if (st.state === 'unknown') return { unknown: { point: 'gen-base-lstat', path: file, code: st.code } };
  const listed = obs.list('gen-base-list', dir);
  if (listed.state !== 'listed') return { unknown: { point: 'gen-base-list', path: dir, code: listed.state === 'absent' ? 'ENOENT' : listed.code } };
  if (listed.names.includes(base)) return { base };
  for (const name of listed.names) {
    if (name.toLowerCase() !== base.toLowerCase()) continue;
    const other = obs.lstat('gen-base-lstat', path.join(dir, name));
    if (other.state === 'unknown') return { unknown: { point: 'gen-base-lstat', path: path.join(dir, name), code: other.code } };
    if (other.state !== 'absent' && other.dev === st.dev && other.ino === st.ino) return { base: name };
  }
  // The lock is there and no entry of the listing is it (removed and made again meanwhile …): read again next poll.
  return { unknown: { point: 'gen-base-list', path: dir, code: 'ESTALE' } };
}

/**
 * resolveGenDir's directory; throws (with the errno) when the realpath cannot be observed. The machine-lock root
 * is made first, as the acquisition makes it (#4559 r6, C7-I2): the place a lock's chain is, before anyone took it.
 */
export function genDirOf(lockPath, env = process.env) {
  try {
    fs.mkdirSync(machineLockRootOf(env), { recursive: true });
  } catch {
    // seen by the realpath below
  }
  const r = resolveGenDir(lockPath, env);
  if (r.unknown) throw Object.assign(new Error(`machine-lock-unknown point=${r.unknown.point} path=${r.unknown.path} errno=${r.unknown.code}`), { code: r.unknown.code });
  return r.genDir;
}

/** C7's hash: sha256 of `<realpath of the parent>/<base name>`, the first 32 hex digits. */
export const byPathHash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The test seam of the generation's steps (T2): counted per process, `pause:<stage>#<n>` or `pause:<stage>`. */
const seamCounts = new Map();

/**
 * `CM_VERIFY_TEST_HANDOFF=pause:<stage>#<n>` (or `pause:<stage>`, every time) with
 * `CM_VERIFY_TEST_HANDOFF_DIR` — the names bash's `lock_test_pause` reads: writes `<dir>/<stage>#<n>.reached`
 * and waits for `<dir>/<stage>#<n>.go`. Unset (production), nothing happens.
 */
function testPause(stage, n) {
  const dir = process.env.CM_VERIFY_TEST_HANDOFF_DIR;
  if (!dir) return;
  const spec = `,${process.env.CM_VERIFY_TEST_HANDOFF ?? ''},`;
  const name = spec.includes(`,pause:${stage}#${n},`) ? `${stage}#${n}` : spec.includes(`,pause:${stage},`) ? stage : null;
  if (name === null) return;
  try {
    fs.writeFileSync(path.join(dir, `${name}.reached`), String(process.pid));
  } catch {
    return;
  }
  while (!fs.existsSync(path.join(dir, `${name}.go`))) sleepSync(20);
}

/** A seam: `hooks.onGenStage(stage, n)` and the pause of the same name. */
function makeSeam(hooks) {
  return (stage) => {
    const n = (seamCounts.get(stage) ?? 0) + 1;
    seamCounts.set(stage, n);
    hooks.onGenStage?.(stage, n);
    testPause(stage, n);
  };
}

const genPath = (g, n) => path.join(g.genDir, genName(n));
/** #4559 r6 (C8, S4): each try of a generation's record has a tmp of its own (`.<k>`), so a tmp left by a failed write is never met again. */
let genTmpSerial = 0;
const isTomb = (record) => record?.tomb === 1 || record?.tomb === '1' || record?.tomb === true;
/** The generation a <lock>'s record names (`"g":N` / `g=N`), or null (an older version's record). */
export const recordGen = (record) => {
  const v = record?.g;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^[0-9]+$/.test(v) && Number(v) > 0) return Number(v);
  return null;
};

/**
 * The generations of `.gen`, listed (`point`): `{ nums, max }`, `{ absent }` (no `.gen`) or `{ unknown }`.
 * C2: the listing after an acquisition is the only place readdir's promise is relied on.
 */
function listGens(g, point) {
  const listed = g.obs.list(point, g.genDir);
  if (listed.state === 'absent') return { absent: true, nums: [], max: 0 };
  if (listed.state === 'unknown') return { unknown: { point, path: g.genDir, code: listed.code } };
  const nums = listed.names.filter((name) => GEN_PATTERN.test(name)).map((name) => Number(name.slice(1))).sort((a, b) => a - b);
  return { nums, max: nums.length > 0 ? nums[nums.length - 1] : 0 };
}

/**
 * §4.5 (C1): the generations below the largest of this listing are removed (`end` is not read); the largest
 * never is. Another writer's tmp older than GEN_TMP_MAX_AGE_MS goes too (C8). A failure is named and left.
 */
function collectGens(g, listing) {
  for (const n of listing.nums) {
    if (n >= listing.max) continue;
    g.seam('gc-judged');
    g.seam('gc-rm');
    rmQuiet(genPath(g, n), { recursive: true, warn: g.warn, what: 'a generation below the largest' });
  }
  const tmps = g.obs.list('gen-tmp-list', g.genTmp);
  if (tmps.state !== 'listed') return;
  for (const name of tmps.names) {
    const file = path.join(g.genTmp, name);
    const st = g.obs.lstat('gen-tmp-lstat', file);
    if (st.state !== 'other' || g.now() - st.mtimeMs <= GEN_TMP_MAX_AGE_MS) continue;
    g.seam('gc-tmp-rm');
    rmQuiet(file, { warn: g.warn, what: 'an old tmp of a generation' });
  }
}

/**
 * The names of each record a generation is added to (C8: `<token>.<gN>.<use>` for the tmp): the tmp's
 * observation point and seam, and the link's. One row per use, so every point and seam is a literal.
 */
const GEN_WRITES = {
  owner: { use: 'owner', put: 'gen-owner-tmp', link: 'gen-owner-link', seamTmp: 'gen-owner-tmp', seamLinked: 'gen-owner-linked' },
  handoff: { use: 'h', put: 'handoff-gen-tmp', link: 'handoff-gen-link', seamTmp: 'gen-handoff-tmp', seamLinked: 'handoff-linked' },
  tomb: { use: 'tomb', put: 'tomb-tmp', link: 'tomb-link', seamTmp: 'tomb-tmp', seamLinked: 'tomb-linked' },
  end: { use: 'end', put: 'end-tmp', link: 'end-link', seamTmp: 'end-tmp', seamLinked: 'end-linked' },
};

/**
 * Add `name` to generation n (`owner`, `owner.h<k>`, `end`): a tmp of this acquisition's own
 * (`<token>.<gN>.<use>.<k>`, one per try, never reused) linked into the generation, the tmp removed. The answer is the
 * link's: linked / exists (EEXIST: another record won the name) / absent (the generation is gone) /
 * unknown (the tmp or the link failed).
 */
function linkIntoGen(g, n, w, suffix, name, text) {
  const target = path.join(genPath(g, n), name);
  g.seam('gen-tmp-mkdir');
  const made = g.obs.mkdir('gen-tmp-mkdir', g.genTmp);
  if (made.state === 'unknown') return { state: 'unknown', unknown: { point: 'gen-tmp-mkdir', path: g.genTmp, code: made.code } };
  const tmp = path.join(g.genTmp, `${g.myToken}.${genName(n)}.${w.use}${suffix}.${++genTmpSerial}`);
  const put = g.obs.put(w.put, tmp, text);
  if (put.state !== 'created') {
    // A tmp left half written (opened, then the write failed) is another writer's old tmp to the next
    // clean-up (C8: by age only): nothing is removed by its name here.
    return { state: 'unknown', unknown: { point: put.state === 'exists' ? w.put : put.point, path: tmp, code: put.state === 'exists' ? 'EEXIST' : put.code } };
  }
  g.seam(w.seamTmp);
  const linked = g.obs.link(w.link, tmp, target);
  g.seam(w.seamLinked);
  g.obs.unlink('gen-tmp-unlink', tmp);
  if (linked.state === 'unknown') return { state: 'unknown', unknown: { point: w.link, path: target, code: linked.code } };
  return { state: linked.state };
}

/** `end` of generation n: `released` / `dead` / `withdrawn` and the token of the one who wrote it (§3). */
function writeEnd(g, n, kind) {
  const r = linkIntoGen(g, n, GEN_WRITES.end, `-${kind}`, 'end', `${kind} ${g.myToken}\n`);
  if (r.state === 'unknown') g.warn(`machine-lock-gen-end-failed ${genPath(g, n)} (${r.unknown.code}; ${kind} not written)`, { event: 'machine-lock-gen-end-failed', gen: genPath(g, n), kind, code: r.unknown.code });
  return r;
}

/**
 * The records of generation n, in order (§4.3 1): `owner`, `owner.h1`, `owner.h2` … up to the first
 * ENOENT — never readdir. `ownerless` when `owner` is not there; `unknown` / `corrupt` when one cannot be
 * read as a record.
 */
function readGenRecords(g, n) {
  const dir = genPath(g, n);
  const records = [];
  for (let k = 0; ; k++) {
    const file = path.join(dir, k === 0 ? 'owner' : `owner.h${k}`);
    const r = g.obs.record('holder-read', file);
    if (r.state === 'missing') return k === 0 ? { state: 'ownerless' } : { state: 'records', records };
    if (r.state === 'unknown') return { state: 'unknown', unknown: { point: 'holder-read', path: file, code: r.code } };
    if (r.state === 'corrupt') return { state: 'corrupt', file };
    records.push(r.owner);
  }
}

/**
 * A generation's `fields` (merge-pr's phase …): `{ fields }` — {} when there are none — or `{ unknown }` when
 * they cannot be read or parsed (#4559 r6, review a P1-1: never {} then — a dead holder's unconfirmed write
 * would be read as idle; the recovery judges again at the next poll).
 */
function readGenFields(g, n) {
  const file = path.join(genPath(g, n), 'fields');
  const read = g.obs.text('gen-fields-read', file);
  if (read.state === 'missing') return { fields: {} };
  if (read.state === 'unknown') return { unknown: { point: 'gen-fields-read', path: file, code: read.code } };
  try {
    const parsed = g.codec.parse(read.text);
    if (parsed && typeof parsed === 'object') return { fields: parsed };
  } catch {
    // corrupt: named as EINVAL below
  }
  return { unknown: { point: 'gen-fields-read', path: file, code: 'EINVAL' } };
}

/**
 * The holder a generation's records name (#4559 r6, review a P1-1): the first record, then the last (the
 * hand-off's pid, token and group), then the holding's `fields` — the fields last, so the phase written while it
 * held wins over the record's own `phase: 'idle'` (the reserved keys never are fields: RESERVED_OWNER_FIELDS).
 */
const holderOfRecords = (records, fields) => ({ ...records[0], ...records[records.length - 1], ...fields });
/** holderOfRecords for a display (held by): the fields when they can be read. */
const shownHolder = (g, n, records) => holderOfRecords(records, readGenFields(g, n).fields ?? {});

/** holderState of a generation's record, observed at the generation's own points (holder-pid / holder-group). */
function genHolderState(g, record) {
  const obs = { pid: (_point, pid) => g.obs.pid('holder-pid', pid), group: (_point, pgid) => g.obs.group('holder-group', pgid) };
  const state = holderState(record, { host: g.host, obs });
  return state.state === 'unknown' && state.point === 'group' ? { ...state, point: 'holder-group' } : state;
}

/**
 * §4.3 / §4.4: judge generation m, the largest, which has no `end`. Its records all dead → `end` (dead)
 * after the re-read of the hand-off past the last judged (C3: `lstat owner.h<k+1>`). No owner past
 * GEN_OWNERLESS_GRACE_MS (from the generation's mtime) → a tomb linked to `owner`, the writer's own name
 * (L4), then `end`. A live or unknown holder is left.
 *
 * @returns {{ state: 'ended' } | { state: 'again' } | { state: 'busy', holder: any } | { state: 'young' } | { state: 'unknown', unknown: { point: string, path: string, code: string } }}
 */
function judgeGen(g, m) {
  for (let tries = 0; tries < LINK_TRIES_PER_POLL; tries++) {
    g.seam('holder-read');
    const read = readGenRecords(g, m);
    if (read.state === 'unknown') return read;
    if (read.state === 'corrupt') {
      g.warnOnce(`machine-lock-gen-owner-corrupt ${read.file} unparsable (nobody ends the generation: look at it)`, { event: 'machine-lock-gen-owner-corrupt', owner: read.file });
      return { state: 'busy', holder: null };
    }
    if (read.state === 'ownerless') {
      const st = g.obs.lstat('ownerless-gen-mtime', genPath(g, m));
      // C4 (loose): the generation is gone — read as "no end" and nothing to do here; the next listing decides.
      if (st.state === 'absent') return { state: 'again' };
      if (st.state === 'unknown') return { state: 'unknown', unknown: { point: 'ownerless-gen-mtime', path: genPath(g, m), code: st.code } };
      if (g.now() - st.mtimeMs <= GEN_OWNERLESS_GRACE_MS) return { state: 'young' };
      g.seam('ownerless-judged');
      const tomb = linkIntoGen(g, m, GEN_WRITES.tomb, '', 'owner', g.codec.format({ pid: process.pid, host: g.host, token: g.myToken, acquiredAt: g.now(), v: OWNER_VERSION, g: m, tomb: 1 }));
      if (tomb.state === 'exists') continue; // the writer published first (L4): judged as a record
      if (tomb.state === 'absent') return { state: 'again' };
      if (tomb.state === 'unknown') return tomb;
      g.warn(`machine-lock-gen-tomb ${genPath(g, m)} (no owner for ${Math.round(g.now() - st.mtimeMs)} ms)`, { event: 'machine-lock-gen-tomb', gen: genPath(g, m) });
      g.seam('tomb-end');
      const end = writeEnd(g, m, 'dead');
      return end.state === 'unknown' ? end : { state: 'ended' };
    }
    const { records } = read;
    if (!records.every(isTomb)) {
      for (const record of records) {
        if (isTomb(record)) continue;
        const holder = genHolderState(g, record);
        if (holder.state === 'alive') return { state: 'busy', holder: shownHolder(g, m, records) };
        if (holder.state === 'unknown') return { state: 'unknown', unknown: { point: holder.point, path: genPath(g, m), code: holder.code }, holder: shownHolder(g, m, records) };
      }
    }
    // The fields of the holding judged dead, read before anything is done (a P1-1): unreadable — judged again.
    const fields = readGenFields(g, m);
    if (fields.unknown) return { state: 'unknown', unknown: fields.unknown };
    g.seam('holder-judged');
    const last = holderOfRecords(records, fields.fields);
    if (!isTomb(records[0]) && !g.staleNoted.has(records[0].token)) {
      g.staleNoted.add(records[0].token);
      g.onStaleHolder?.(last);
    }
    g.seam('holder-relist');
    const next = path.join(genPath(g, m), `owner.h${records.length}`);
    const relist = g.obs.lstat('holder-relist', next);
    if (relist.state === 'unknown') return { state: 'unknown', unknown: { point: 'holder-relist', path: next, code: relist.code } };
    if (relist.state !== 'absent') continue; // a hand-off added meanwhile: judged again
    const end = writeEnd(g, m, 'dead');
    if (end.state === 'unknown') return end;
    if (end.state === 'linked') g.warn(`machine-lock-gen-recovered ${genPath(g, m)} pid=${last.pid}`, { event: 'machine-lock-gen-recovered', gen: genPath(g, m), pid: last.pid });
    return { state: 'ended' };
  }
  return { state: 'again' };
}

/**
 * §4.1: take a generation for `owner` (the record, `g` added here). One poll: list, judge the largest
 * (§4.3 / §4.4), `mkdir g<M+1>`, link the owner from a tmp, list again — a larger generation there makes
 * this one withdraw (`end` withdrawn, L3) and start over. Then the own `end` absent and the own owner read
 * back (§4.1 6).
 *
 * @returns {{ held: number } | { busy: true, holder: any, young?: boolean } | { unknown: { point: string, path: string, code: string } } | { contention: true }}
 */
function takeGeneration(g, owner) {
  for (let tries = 0; tries < LINK_TRIES_PER_POLL; tries++) {
    g.seam('gen-list');
    const listing = listGens(g, 'gen-list');
    if (listing.unknown) return { unknown: listing.unknown };
    if (listing.absent) {
      g.seam('gen-parent-mkdir');
      fs.mkdirSync(path.dirname(g.genDir), { recursive: true });
      g.seam('gen-dir-mkdir');
      const made = g.obs.mkdir('gen-dir-mkdir', g.genDir);
      if (made.state === 'unknown') return { unknown: { point: 'gen-dir-mkdir', path: g.genDir, code: made.code } };
      continue;
    }
    collectGens(g, listing);
    const m = listing.max;
    if (m > 0) {
      g.seam('gen-end-read');
      const end = g.obs.lstat('gen-end-read', path.join(genPath(g, m), 'end'));
      if (end.state === 'unknown') return { unknown: { point: 'gen-end-read', path: path.join(genPath(g, m), 'end'), code: end.code } };
      if (end.state === 'absent') {
        const j = judgeGen(g, m);
        if (j.state === 'unknown') return { unknown: j.unknown, holder: j.holder ?? null };
        if (j.state === 'busy') return { busy: true, holder: j.holder };
        if (j.state === 'young') return { busy: true, holder: null, young: genPath(g, m) };
        if (j.state === 'again') continue;
      }
    }
    const n = m + 1;
    g.seam('gen-mkdir');
    const made = g.obs.mkdir('gen-mkdir', genPath(g, n));
    if (made.state === 'exists') continue;
    if (made.state === 'unknown') return { unknown: { point: 'gen-mkdir', path: genPath(g, n), code: made.code } };
    // #4559 r6 (§4.1, review a P2-1): g<n> is this writer's from its mkdir (exclusive) — a throw or a close of the
    // steps from here on ends it (withdrawn) through `g.own`, until the own end below or the answer.
    g.own = n;
    const published = linkIntoGen(g, n, GEN_WRITES.owner, '', 'owner', g.codec.format({ ...owner, g: n }));
    if (published.state === 'unknown') {
      // #4559 (§4.4, decided in PR-2): this writer made g<n> (mkdir is exclusive) and is alive — it does not
      // leave the generation owner-less for the grace of a dead writer: its own tomb is linked to `owner`
      // (L4: if its owner did get linked, the tomb meets EEXIST and the owner is its own), then `end`.
      g.seam('gen-owner-failed');
      const tomb = linkIntoGen(g, n, GEN_WRITES.tomb, '', 'owner', g.codec.format({ pid: process.pid, host: g.host, token: owner.token, acquiredAt: g.now(), v: OWNER_VERSION, g: n, tomb: 1 }));
      if (tomb.state === 'linked' || tomb.state === 'exists') writeEnd(g, n, 'withdrawn');
      g.own = null;
      return { unknown: published.unknown };
    }
    if (published.state !== 'linked') {
      g.own = null;
      continue; // a tomb won the name (L4) or the generation was removed
    }
    g.seam('gen-postlist');
    const after = listGens(g, 'gen-postlist');
    if (after.unknown || after.absent) {
      // C6: not shown to be the largest — not taken; the own generation is ended so nobody waits on it.
      writeEnd(g, n, 'withdrawn');
      g.own = null;
      return { unknown: after.unknown ?? { point: 'gen-postlist', path: g.genDir, code: 'ENOENT' } };
    }
    if (after.max > n) {
      g.seam('gen-withdraw-end');
      writeEnd(g, n, 'withdrawn');
      g.own = null;
      continue;
    }
    const endNow = g.obs.lstat('gen-verify-end', path.join(genPath(g, n), 'end'));
    const back = g.obs.record('gen-verify-owner', path.join(genPath(g, n), 'owner'));
    if (endNow.state === 'absent' && back.state === 'record' && back.owner.token === owner.token) return { held: n };
    // §4.1 6: not shown to be this one's own live generation — ended (withdrawn) before going on; an `end`
    // already there meets EEXIST.
    writeEnd(g, n, 'withdrawn');
    g.own = null;
    const code = endNow.state === 'unknown' ? endNow.code : back.state === 'unknown' ? back.code : 'ESTALE';
    return { unknown: { point: endNow.state === 'unknown' ? 'gen-verify-end' : 'gen-verify-owner', path: genPath(g, n), code } };
  }
  return { contention: true };
}

/** Whether generation n is over (§6.1): its `end` is there, or it is gone (removed below the largest: L1). */
function genEnded(g, n) {
  const end = g.obs.lstat('beacon-gen-end', path.join(genPath(g, n), 'end'));
  if (end.state === 'unknown') return { unknown: { point: 'beacon-gen-end', path: path.join(genPath(g, n), 'end'), code: end.code } };
  if (end.state !== 'absent') return { ended: true };
  const dir = g.obs.lstat('beacon-gen-end', genPath(g, n));
  if (dir.state === 'unknown') return { unknown: { point: 'beacon-gen-end', path: genPath(g, n), code: dir.code } };
  return { ended: dir.state === 'absent' };
}

/**
 * The holder of the lock at `lockPath` now (§9, the outer readers merge-pr / merge-train / run-lock): the
 * largest generation without `end` — its records with the holding's `fields` last — else the <lock>'s owner (an
 * older version's holder). null when nobody can be read. `genOnly` (run-lock's D8, #4559 r6): the generation's
 * holder only (null when there is none or the chain cannot be chosen) — never the <lock>'s record.
 *
 * @param {string} lockPath
 * @param {{ ownerCodec?: { parse: (text: string) => any, format: (record: Record<string, unknown>) => string }, genOnly?: boolean }} [options]
 */
export function readHolder(lockPath, options = {}) {
  const codec = options.ownerCodec ?? JSON_OWNER_CODEC;
  const obs = makeObserver({ codec });
  const chosen = resolveGenDir(lockPath, process.env, obs);
  if (chosen.unknown) return options.genOnly ? null : readOwner(lockPath, codec);
  const g = { genDir: chosen.genDir, obs, codec };
  const listing = listGens(g, 'gen-list');
  if (!listing.unknown && listing.max > 0) {
    const end = g.obs.lstat('gen-end-read', path.join(genPath(g, listing.max), 'end'));
    if (end.state === 'absent') {
      const read = readGenRecords(g, listing.max);
      if (read.state === 'records' && !read.records.every(isTomb)) return shownHolder(g, listing.max, read.records);
    }
  }
  return options.genOnly ? null : readOwner(lockPath, codec);
}

/**
 * Take the machine-wide lock `name` in ticket order, waiting up to `timeoutMs`: the generator of the
 * acquisition (#4559). Each `yield` is a wait in ms between two polls; the return value is the answer.
 * acquireMachineLockSync waits with a synchronous sleep, machine-lock.ts with `await` — the steps, the
 * reads and the writes are this one copy.
 *
 * The order (§6.1, §4.7): the ticket; as the head of the queue, a generation (§4.1); then the <lock> by
 * today's convention (the beacon for the older versions), its owner naming the generation (`g`); the
 * answer only once the <lock> is taken. A give-up after the generation was taken ends it first (§4.1:
 * withdrawn; the beacon's deadline: released).
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
 *   warn?: (line: string, data?: Record<string, unknown>) => void,
 *   hooks?: { onRecover?(stage: 'before-move' | 'moved' | 'restore-mkdir' | 'restore-owner' | 'hand-off-tmp'): void, onOwnerStage?(stage: string): void, onGenStage?(stage: string, n: number): void, genDir?: string, link?: (src: string, dst: string) => void, beforeLink?: (n: number) => void, startOf?: (pid: number) => number | null, now?: () => number, host?: string, pidAlive?: (pid: number) => boolean, groupAlive?: (pgid: number) => boolean, kill?: (target: number, signal: number) => void, fault?: (point: string, target: string, count: number) => string | null | undefined },
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
 * process.pid); `hooks.kill` stands in for process.kill (D10). `hooks.genDir` (a test seam only) names the
 * generation directory; otherwise it is resolveGenDir's, observed in each poll until it can be chosen.
 *
 * #4288 PR1a-f: `ownerPid` must be this process (I1-b: the first acquisition records its own pid only;
 * another pid is the hand-off's) and `ownerFields` may not carry a key of RESERVED_OWNER_FIELDS (I1-c):
 * either is refused before the ticket and the mkdir (`unknown.point` owner-pid / owner-fields, EINVAL).
 * `ownerlessGraceMs` also takes out an owner-less <lock> of temporaries only (I3), and every head takes
 * out an owner of 0 bytes older than EMPTY_OWNER_GRACE_MS (I4). `hooks.onOwnerStage(stage)` is called at
 * the five points of the owner's publish (owner-lock-made, owner-tmp-opened, owner-tmp-written,
 * owner-linked, owner-tmp-removed; test seam); `hooks.onGenStage(stage, n)` at the generation's seams.
 *
 * @returns {Generator<number, { acquired: boolean, waitedMs: number, heldBy: string | null, abandoned?: boolean, unknown?: { point: string, path: string, code: string }, release: () => ('released' | 'deferred' | 'needs-head' | 'kept' | 'none'), setOwnerFields: (fields: Record<string, unknown>) => boolean, handOff: (pid: number, pgid: number) => { ok: boolean, token?: string, stage?: string }, token?: string, gen?: number, path: string }, void>}
 */
export function* machineLockAcquisition(name, options) {
  const { timeoutMs, pollMs = LOCK_POLL_MS, hooks = {} } = options;
  const root = options.lockPath ? path.dirname(options.lockPath) : options.root;
  const codec = options.ownerCodec ?? JSON_OWNER_CODEC;
  const warn = options.warn ?? (() => {});
  const warned = new Set();
  const warnOnce = (line, data) => {
    if (warned.has(line)) return;
    warned.add(line);
    warn(line, data);
  };
  // setOwnerFields / handOff answer false, never throw: a tmp that cannot be removed is named and left.
  const dropOwnTmp = (tmp) => {
    const code = rmQuiet(tmp);
    if (code) warn(`machine-lock-tmp-left ${tmp} (${code}; this call's own tmp, not removed)`);
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
    warn,
    startOf: (pid, why = {}) => {
      if (hooks.startOf) return hooks.startOf(pid);
      const cached = startCache.get(pid);
      if (cached && now() - cached.at < START_RECHECK_MS) {
        if (cached.code) why.code = cached.code;
        return cached.start;
      }
      const start = processStartMs(pid, now(), now, why);
      startCache.set(pid, { start, at: now(), code: why.code });
      return start;
    },
  };
  const lockPath = options.lockPath ?? lockPathOf(root, name);
  const queueDir = options.lockPath ? queueDirOfPath(options.lockPath) : queueDirOf(root, name);
  const token = typeof options.token === 'string' && options.token ? options.token : crypto.randomUUID();
  const ctx = { root, lockPath, host, obs, warn, warnOnce, onRecover: hooks.onRecover, myToken: token, startOf: env.startOf };
  const noLock = () => ({ release: () => 'none', setOwnerFields: () => false, handOff: () => ({ ok: false, stage: 'token' }), path: lockPath });
  const nameUnknown = (u) => warn(`machine-lock-unknown point=${u.point} path=${u.path} errno=${u.code}`, { event: 'machine-lock-unknown', point: u.point, path: u.path, errno: u.code });
  // I1-b / I1-c: refused before the ticket and the mkdir — nothing is made.
  // (`hooks.fault` at owner-pid / owner-fields answers the same refusal: the test seam of §2.8.)
  const refuse = (point, line, code) => {
    warn(line);
    nameUnknown({ point, path: lockPath, code });
    return { acquired: false, waitedMs: 0, heldBy: null, unknown: { point, path: lockPath, code }, ...noLock() };
  };
  const pidFault = hooks.fault?.('owner-pid', lockPath, 1);
  if (pidFault || (options.ownerPid !== undefined && options.ownerPid !== null && options.ownerPid !== process.pid)) {
    return refuse('owner-pid', `machine-lock-owner-pid-not-self ${lockPath} pid=${options.ownerPid}`, pidFault || 'EINVAL');
  }
  const fieldsFault = hooks.fault?.('owner-fields', lockPath, 1);
  const reserved = Object.keys(options.ownerFields ?? {}).find((k) => RESERVED_OWNER_FIELDS.includes(k));
  if (fieldsFault || reserved !== undefined) {
    return refuse('owner-fields', `machine-lock-owner-field-reserved ${lockPath} key=${reserved}`, fieldsFault || 'EINVAL');
  }
  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  const pgid = validPgid(options.pgid) ? options.pgid : undefined;
  const ticket = { pid: process.pid, host, token, createdAt: startedAt, deadline, ...(pgid ? { pgid } : {}) };
  fs.mkdirSync(root, { recursive: true });
  const staleNoted = new Set();
  // The generation directory (C7): chosen from the realpaths in the first poll that can observe them.
  const g = { ...ctx, codec, now, genDir: null, genTmp: null, seam: makeSeam(hooks), onStaleHolder: options.onStaleHolder, staleNoted, own: null };
  const chooseGenDir = () => {
    if (g.genDir !== null) return true;
    if (!hooks.genDir) {
      // #4559 r6 (C7-I2): the machine-lock root is made first (the by-path chains live in it, run-lock's lock is
      // outside it); a root that cannot be made is seen by its realpath below — unknown or absent, no chain.
      try {
        fs.mkdirSync(machineLockRootOf(process.env), { recursive: true });
      } catch {
        // observed below
      }
    }
    const chosen = hooks.genDir ? { genDir: hooks.genDir } : resolveGenDir(lockPath, process.env, obs);
    if (chosen.unknown) {
      unknown = chosen.unknown;
      warnOnce(`machine-lock-unknown point=${unknown.point} path=${unknown.path} errno=${unknown.code}`, { event: 'machine-lock-unknown', point: unknown.point, path: unknown.path, errno: unknown.code });
      return false;
    }
    g.genDir = chosen.genDir;
    g.genTmp = `${chosen.genDir}.tmp`;
    return true;
  };
  const onOwnerStage = (stage) => {
    hooks.onOwnerStage?.(stage);
    testPause(stage, (seamCounts.get(stage) ?? 0) + 1);
    seamCounts.set(stage, (seamCounts.get(stage) ?? 0) + 1);
  };

  let mine = null;
  let blocker = null;
  let pending = null;
  let unknown = null;
  let genHolder = null;
  let waiting = false;
  // #4559: the generation this acquisition holds (from takeGeneration until the answer), and the time of
  // its owner — the record of the holding, which the <lock>'s owner copies (with `g`).
  let gen = null;
  let owner = null;
  const broken = new Set();
  const mineFile = () => path.join(queueDir, ticketName(mine));
  const retire = () => {
    if (mine !== null) markDone(mineFile(), token, warn);
    mine = null;
  };
  // §4.1: every way out after the generation was taken and before the answer ends it — and, from its mkdir on
  // (`g.own`, #4559 r6 review a P2-1), a throw or a close of the steps before takeGeneration answered.
  const giveUpGen = (kind) => {
    const n = gen ?? g.own;
    gen = null;
    g.own = null;
    if (n !== null) writeEnd(g, n, kind);
  };
  const heldBy = () => {
    const current = readOwner(lockPath, codec);
    // The gate's group (#4288): with verify-run.sh's runner killed, the pid is dead and the group holds.
    // Added here, not in describeOwner: merge-pr's heldByLine appends the pgid to describeOwner itself.
    if (current) return `${describeOwner(current)}${validPgid(current.pgid) ? ` (pgid ${current.pgid})` : ''}`;
    if (genHolder) return `${describeOwner(genHolder)}${validPgid(genHolder.pgid) ? ` (pgid ${genHolder.pgid})` : ''}`;
    if (blocker) return `queue ticket ${blocker.file}${blocker.ticket ? ` (${describeOwner(blocker.ticket)})` : ' (unreadable)'}`;
    if (pending) return `restore pending: ${pending}`;
    if (unknown) return `unknown ${unknown.point} ${unknown.path} ${unknown.code}`;
    return null;
  };
  const gaveUp = () => {
    if (!unknown) return {};
    // Through warnOnce: a re-read's unknown named in its poll (#4559) is not named a second time.
    warnOnce(`machine-lock-unknown point=${unknown.point} path=${unknown.path} errno=${unknown.code}`, { event: 'machine-lock-unknown', point: unknown.point, path: unknown.path, errno: unknown.code });
    return { unknown };
  };
  // An empty owner taken out goes on to the mkdir in the same poll — a few times at most.
  let emptied = 0;
  // #4559 r6 (§4.1, review a P2-1): set once an answer is returned; any other way out — a throw (a hook, an
  // observation's caller), the waiter's sleep that threw (acquireMachineLockSync closes the steps), a return()
  // of the generator — ends the generation (withdrawn) and the ticket in the `finally`.
  let answered = false;

  try {
    for (;;) {
      if (options.shouldAbandon?.()) {
        giveUpGen('withdrawn');
        retire();
        answered = true;
        return { acquired: false, waitedMs: now() - startedAt, heldBy: heldBy(), abandoned: true, ...noLock() };
      }
      if (mine !== null) {
        const current = readJson(mineFile());
        if (!current || current.done === true || current.token !== token) {
          warn(`machine-lock-ticket-lost ${mineFile()}: taking a new ticket at the end of the queue`, { event: 'machine-lock-ticket-lost', ticket: mineFile() });
          mine = null;
        }
      }
      blocker = null;
      pending = null;
      unknown = null;
      genHolder = null;
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
            if (markDone(entry.file, entry.ticket.token, warn)) warn(`machine-lock-ticket-retired ${entry.file} (${why})`, { event: 'machine-lock-ticket-retired', ticket: entry.file, why });
            continue;
          }
          blocker = entry;
          break;
        }
        if (!blocker && !queue.unknown && gen === null && chooseGenDir()) {
          // The section's own keys last (I1-c: the caller's fields cannot name another pid or token).
          owner = { ...(options.ownerFields ?? {}), pid: process.pid, host, token, acquiredAt: now(), ...(pgid ? { pgid } : {}), v: OWNER_VERSION };
          const taken = takeGeneration(g, owner);
          if (taken.held !== undefined) {
            gen = taken.held;
            g.own = null;
          }
          else if (taken.unknown) {
            unknown = taken.unknown;
            genHolder = taken.holder ?? null;
            // S4 / T6: a generation's observation that failed is named in its poll (once per line).
            warnOnce(`machine-lock-unknown point=${unknown.point} path=${unknown.path} errno=${unknown.code}`, { event: 'machine-lock-unknown', point: unknown.point, path: unknown.path, errno: unknown.code });
          } else if (taken.busy) {
            genHolder = taken.holder;
            if (taken.young) pending = `an owner-less generation ${taken.young}`;
          }
        }
        if (!blocker && !queue.unknown && gen !== null) {
          const settled = settleGone(ctx);
          if (settled.block) {
            pending = settled.pending;
            unknown = settled.unknown ?? null;
          } else {
            const beacon = { ...owner, g: gen };
            // D3 / I3: the head takes out an owner-less <lock> of temporaries only past the caller's grace first.
            const expired = expireOwnerless(ctx, options.ownerlessGraceMs, now());
            if (expired.state !== 'unknown' && claim(lockPath, beacon, obs, warn, codec, onOwnerStage)) {
              retire();
              collectGarbage(queueDir, now(), warn);
              answered = true;
              return holding(gen);
            }
            if (expired.state === 'unknown') unknown = expired.unknown;
            const read = obs.owner('lock-owner', lockPath);
            if (read.state === 'unknown' && !unknown) unknown = { point: 'lock-owner', path: path.join(lockPath, 'owner'), code: read.code };
            if (read.state === 'corrupt' && !read.empty) warnCorrupt(ctx);
            if (read.state === 'corrupt' && read.empty) {
              // I4: an owner of 0 bytes past the fixed grace is the head's to take out.
              const e = reclaimEmptyOwner(ctx, now());
              if (e.state === 'removed' && emptied < 3) {
                emptied += 1;
                continue;
              }
              if (e.state === 'kept') pending = e.aside;
              if (e.state === 'unknown' && !unknown) unknown = e.unknown;
            }
            if (read.state === 'record') noteLegacy(ctx, lockPath, read.owner);
            const holder = read.state === 'record' ? read.owner : null;
            if (holder && !broken.has(holder.token)) {
              const was = recordGen(holder);
              // §6.1: a <lock> of an earlier generation is taken out only when that generation is over
              // (necessary, not sufficient) and the record is judged dead by today's rule.
              const over = was === null ? { ended: true } : was < gen ? genEnded(g, was) : { ended: false };
              if (over.unknown) {
                if (!unknown) unknown = over.unknown;
                warnOnce(`machine-lock-unknown point=${over.unknown.point} path=${over.unknown.path} errno=${over.unknown.code}`, { event: 'machine-lock-unknown', point: over.unknown.point, path: over.unknown.path, errno: over.unknown.code });
              }
              const state = over.ended ? holderState(holder, ctx) : { state: 'alive' };
              // M1 (narrowed): an older version's holder (no `g`) that is alive or unknown is named and waited for.
              if (was === null && state.state !== 'gone') warnOnce(`machine-lock-legacy-writer ${lockPath} pid=${holder.pid}`, { event: 'machine-lock-legacy-writer', lockPath, pid: holder.pid });
              if (state.state === 'gone') {
                // Persist what the dead holder was doing before its lock is gone (merge-pr: an unconfirmed write).
                // Before the re-read, as on develop and 95d507189; once per token (`staleNoted`, not `broken`):
                // a re-read that failed judges the same holder again on the next poll.
                if (!staleNoted.has(holder.token)) {
                  staleNoted.add(holder.token);
                  options.onStaleHolder?.(holder);
                }
                if (was !== null) g.seam('beacon-prev-judged');
                const j = recoverJudged(ctx, holder);
                if (j.result !== 'reread-unknown') {
                  broken.add(holder.token);
                  continue;
                }
                // #4559: a re-read that failed marks nothing broken — the next poll judges again — and is
                // named once, like the other unknowns.
                if (!unknown) unknown = j.unknown;
                warnOnce(`machine-lock-unknown point=${j.unknown.point} path=${j.unknown.path} errno=${j.unknown.code}`, { event: 'machine-lock-unknown', point: j.unknown.point, path: j.unknown.path, errno: j.unknown.code });
              }
              if (state.state === 'unknown') unknown = { point: state.point, path: lockPath, code: state.code };
            }
          }
        }
      }
      const t = now();
      if (t >= deadline) {
        // §6.1: the beacon's wait ran out — the own generation is ended (released) before busy is answered.
        giveUpGen('released');
        retire();
        answered = true;
        return { acquired: false, waitedMs: t - startedAt, heldBy: heldBy(), ...gaveUp(), ...noLock() };
      }
      if (!waiting) {
        waiting = true;
        options.onWait?.();
      }
      yield Math.min(pollMs, deadline - t);
    }
  } finally {
    if (!answered) {
      giveUpGen('withdrawn');
      retire();
    }
  }

  /** The handle of a holding: generation `n` (the <lock>'s owner is its record with `g`). */
  function holding(n) {
    let released = false;
    // #4559: the <lock> is let go before `end` (§6.1), each once; a release that did not finish tries again.
    let beaconDone = false;
    let endDone = false;
    // D4: the tokens the handovers published (T1 = <T0>-g<pgid>), each from the moment it is tried (#4559 r6:
    // a holding hands off more than once, §4.6 — every one of them is this handle's).
    const handed = [];
    let handoffs = 0;
    let fieldsSerial = 0;
    const ours = (t) => t === token || handed.includes(t);
    const finishEnd = () => {
      if (endDone) return;
      g.seam('release-end');
      for (let tries = 1; ; tries++) {
        const r = writeEnd(g, n, 'released');
        if (r.state === 'unknown') {
          throw Object.assign(new Error(`${r.unknown.code}: cannot end ${genPath(g, n)}`), { code: r.unknown.code });
        }
        if (r.state === 'absent') {
          // #4559 r6 (S4, review a P1-3): ENOENT is the tmp (cleaned by its age meanwhile, C8) or the generation.
          // Over only when the generation is (its end there, or gone below the largest: L1); else a new tmp.
          const over = genEnded(g, n);
          if (over.unknown) throw Object.assign(new Error(`${over.unknown.code}: cannot tell whether ${genPath(g, n)} is over`), { code: over.unknown.code });
          if (!over.ended) {
            if (tries < LINK_TRIES_PER_POLL) continue;
            throw Object.assign(new Error(`EAGAIN: cannot end ${genPath(g, n)}`), { code: 'EAGAIN' });
          }
        }
        endDone = true;
        return;
      }
    };
    /**
     * D12 on the records of the holding, once (§4.2): the <lock>'s record when it is this acquisition's,
     * and the generation's last record (a hand-off's). Either naming another pid → needs-head; a group
     * with a member or a pid that cannot be observed → deferred.
     */
    const judgeRecord = (record) => {
      const ownGroup = record.pid === process.pid && record.pgid === process.pid;
      if (validPgid(record.pgid) && !ownGroup) {
        const group = obs.group('group', record.pgid);
        if (group.state !== 'gone') return { result: 'deferred', line: `machine-lock-release-deferred ${lockPath} pgid=${record.pgid}`, data: { event: 'machine-lock-release-deferred', lockPath, pgid: record.pgid } };
      }
      if (record.pid !== process.pid) {
        const holder = obs.pid('pid', record.pid);
        if (holder.state === 'unknown') {
          return { result: 'deferred', line: `machine-lock-release-deferred ${lockPath} (recorded pid ${record.pid} is unknown: ${holder.code})`, data: { event: 'machine-lock-release-deferred', lockPath, pid: record.pid, errno: holder.code } };
        }
        return { result: 'needs-head', line: `machine-lock-release-needs-head ${lockPath} (recorded pid ${record.pid} is not this process; release as the head)`, data: { event: 'machine-lock-release-needs-head', lockPath, pid: record.pid } };
      }
      return { result: 'released' };
    };
    return {
      acquired: true,
      waitedMs: now() - startedAt,
      heldBy: null,
      path: lockPath,
      token,
      gen: n,
      // Never moves a lock that is not this acquisition's: a second call, or a call after the
      // lock was taken by someone else, leaves it where it is (Codex review 2, finding 1). An
      // owner that cannot be read is not known to be ours, so it stays too (#4288).
      // D12 (#4288 PR1a-c, docs/design/lock-reservation-rest-4288.md — the invariant of the
      // three implementations, the same as bash's lock_release_held): a record of ours is
      // removed here only when its recorded pid is this process and, when it names a pgid,
      // that group is empty. A group with a member, or one that cannot be shown empty, keeps
      // it ('deferred', the release may be called again). Any other recorded pid — after a
      // handOff or the initial ownerPid alike, alive, gone or unknown — is not removed: a pid
      // read alive can die before the delete, and a head recover it and take it in
      // between, so the caller releases with releaseAsHead(lockPath, [token, T1]) (D5) —
      // 'needs-head', once. A pid that cannot be observed is 'deferred'. The group of a record
      // whose pid and pgid are both this process (merge-pr's pgid: process.pid) is not judged:
      // this process is a member of it by definition.
      // #4559 (§4.2, §6.1): the judgement is made once and then the <lock> goes, then the generation's
      // `end` (released) — never `end` while a hand-off's child may live (needs-head / deferred write none).
      release: () => {
        if (released) return 'none';
        if (beaconDone) {
          finishEnd();
          released = true;
          return 'released';
        }
        // #4558: a read that failed is read again (RELEASE_READ_TRIES in this call), and a
        // release that did not finish — 'deferred' on an unreadable owner, a delete that threw —
        // is not marked done: the next call tries again instead of answering 'none' over a
        // record of this live process that no head would recover.
        let current = obs.owner('release-owner', lockPath);
        for (let i = 1; i < RELEASE_READ_TRIES && current.state === 'unknown'; i++) current = obs.owner('release-owner', lockPath);
        const mine = current.state === 'record' && ours(current.owner.token);
        const ownGroup = mine && current.owner.pid === process.pid && current.owner.pgid === process.pid;
        if (mine && validPgid(current.owner.pgid) && !ownGroup) {
          const group = obs.group('group', current.owner.pgid);
          if (group.state !== 'gone') {
            warn(`machine-lock-release-deferred ${lockPath} pgid=${current.owner.pgid}`, { event: 'machine-lock-release-deferred', lockPath, pgid: current.owner.pgid });
            return 'deferred';
          }
        }
        if (mine && current.owner.pid !== process.pid) {
          const holder = obs.pid('pid', current.owner.pid);
          if (holder.state === 'unknown') {
            warn(`machine-lock-release-deferred ${lockPath} (recorded pid ${current.owner.pid} is unknown: ${holder.code})`, { event: 'machine-lock-release-deferred', lockPath, pid: current.owner.pid, errno: holder.code });
            return 'deferred';
          }
          released = true;
          warn(`machine-lock-release-needs-head ${lockPath} (recorded pid ${current.owner.pid} is not this process; release as the head)`, { event: 'machine-lock-release-needs-head', lockPath, pid: current.owner.pid });
          return 'needs-head';
        }
        if (current.state === 'unknown') {
          warn(`machine-lock-release-deferred ${lockPath} point=release-owner errno=${current.code}`, { event: 'machine-lock-release-deferred', lockPath, point: 'release-owner', errno: current.code });
          return 'deferred';
        }
        // The same judgement, once, of every record of the generation the <lock> does not show (#4559 r6, §4.2:
        // every hand-off — the first one's group lives on after the second's ended; a hand-off whose copy to the
        // <lock> failed; a <lock> that is not this acquisition's): a child that may live keeps the holding (no
        // `end` while it can).
        const read = readGenRecords(g, n);
        if (read.state === 'unknown') {
          warn(`machine-lock-release-deferred ${lockPath} point=${read.unknown.point} errno=${read.unknown.code}`, { event: 'machine-lock-release-deferred', lockPath, point: read.unknown.point, errno: read.unknown.code });
          return 'deferred';
        }
        for (const record of read.state === 'records' ? read.records : []) {
          if (mine && record.token === current.owner.token) continue;
          const d = judgeRecord(record);
          if (d.result !== 'released') {
            warn(d.line, d.data);
            if (d.result === 'needs-head') released = true;
            return d.result;
          }
        }
        if (mine) {
          // A delete that fails (EACCES / EIO / EBUSY) is named once and thrown, as before: the
          // <lock> and its owner stay, and no 'deferred' is answered from here (#4288 PR1a-f impl-4).
          g.seam('beacon-release');
          const code = rmQuiet(lockPath, { recursive: true });
          if (code === null) {
            beaconDone = true;
            finishEnd();
            released = true;
            return 'released';
          }
          warn(`machine-lock-release-failed ${lockPath} (${code}; the record is still this acquisition's)`, { event: 'machine-lock-release-failed', lockPath, error: code });
          throw Object.assign(new Error(`${code}: cannot remove ${lockPath}`), { code });
        }
        // The <lock> holds another record (or none): it is left; the holding is still this one's to end.
        beaconDone = true;
        cleanupOwnGone(ctx, token);
        for (const t of handed) cleanupOwnGone(ctx, t);
        finishEnd();
        released = true;
        return 'kept';
      },
      // Fields added to this acquisition's own record (merge-pr's phase). false, writing nothing,
      // after the release or a handOff (the recorded pid is no longer this process: #4288 PR1a-f
      // §3.1), for a reserved key (I1-c), for a record that is not this token's, and when the
      // write or the rename fails — a <lock> moved aside meanwhile (ENOENT) included: never thrown
      // to the caller, the own tmp removed. #4559 (§3, §6.1): the generation's `fields` first (tmp →
      // rename: only the holder writes it), then the <lock>'s copy for the older readers.
      setOwnerFields: (fields) => {
        if (released || handed.length > 0) return false;
        const key = Object.keys(fields ?? {}).find((k) => RESERVED_OWNER_FIELDS.includes(k));
        if (key !== undefined) {
          warn(`machine-lock-owner-field-reserved ${lockPath} key=${key}`);
          return false;
        }
        const current = readOwner(lockPath, codec);
        if (!current || current.token !== token) return false;
        // The fields so far (a read that failed: the new ones alone — the phase written now is what a recovery needs).
        const merged = { ...(readGenFields(g, n).fields ?? {}), ...fields };
        const gtmp = path.join(g.genTmp, `${token}.${genName(n)}.fields-${++fieldsSerial}`);
        try {
          fs.writeFileSync(gtmp, codec.format(merged));
          g.seam('fields-rename');
          fs.renameSync(gtmp, path.join(genPath(g, n), 'fields'));
        } catch {
          dropOwnTmp(gtmp);
          return false;
        }
        const tmp = path.join(lockPath, `.owner-${crypto.randomUUID()}`);
        try {
          fs.writeFileSync(tmp, codec.format({ ...current, ...fields }));
          fs.renameSync(tmp, path.join(lockPath, 'owner'));
          return true;
        } catch {
          dropOwnTmp(tmp);
          return false;
        }
      },
      // D4 (#4288 PR1a): hand the lock, within this acquisition, to `pid` and its process group
      // `pgid` under a NEW token T1 = <T0>-g<pgid> (tmp + rename, read back). Only the live
      // holder calls it, before the process it protects starts (D9). T1 is this handle's from
      // the moment it is tried, so a release after a failure in the middle still knows it.
      // #4559 (§4.6, §6.1): (1) `owner.h<k>` linked into the generation, (2) the <lock> rewritten by
      // today's D4, (3) the caller's signal. A failure at (1) writes nothing to the <lock> (stage tmp).
      // #4559 r6 (review a P2-3): a holding hands off again (k = 2, 3 …): the <lock> then holds the previous
      // hand-off's token, this handle's too.
      handOff: (pid, pgid) => {
        const t1 = `${token}-g${pgid}`;
        if (released || !Number.isInteger(pid) || !validPgid(pgid)) return { ok: false, stage: 'token', token: t1 };
        if (!handed.includes(t1)) handed.push(t1);
        const read = obs.owner('handoff-token', lockPath);
        if (read.state !== 'record' || !ours(read.owner.token)) return { ok: false, stage: 'token', token: t1 };
        const record = { ...read.owner, pid, token: t1, pgid, g: n };
        const linked = linkIntoGen(g, n, GEN_WRITES.handoff, String(handoffs + 1), `owner.h${handoffs + 1}`, codec.format(record));
        if (linked.state !== 'linked') return { ok: false, stage: 'tmp', token: t1 };
        handoffs += 1;
        const tmp = path.join(lockPath, `.owner-${t1}`);
        try {
          const code = hooks.fault?.('handoff-tmp', tmp, 1);
          if (code) throw Object.assign(new Error(`${code}: injected at handoff-tmp ${tmp}`), { code });
          fs.writeFileSync(tmp, codec.format(record));
        } catch {
          dropOwnTmp(tmp);
          return { ok: false, stage: 'tmp', token: t1 };
        }
        hooks.onRecover?.('hand-off-tmp');
        if (obs.rename('handoff-publish', tmp, path.join(lockPath, 'owner')).state !== 'moved') {
          dropOwnTmp(tmp);
          return { ok: false, stage: 'mv', token: t1 };
        }
        const back = obs.owner('handoff-verify', lockPath);
        if (back.state !== 'record' || back.owner.token !== t1 || back.owner.pid !== pid || back.owner.pgid !== pgid) return { ok: false, stage: 'verify', token: t1 };
        return { ok: true, token: t1 };
      },
    };
  }
}

/** Take the machine-wide lock `name` in ticket order (machineLockAcquisition), waiting with a synchronous sleep. */
export function acquireMachineLockSync(name, options) {
  const sleep = options.sleep ?? sleepSync;
  const steps = machineLockAcquisition(name, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    try {
      sleep(step.value);
    } catch (err) {
      // #4559 r6 (§4.1): the steps are closed — their `finally` ends a generation taken and the ticket.
      steps.return(undefined);
      throw err;
    }
  }
}

/**
 * §4.2 / §4.3: as a head that does not hold the lock (D5 / D6), end the largest generation when it is
 * the holding of one of `tokens` (any, when `tokens` is null) and its records are all dead — the same
 * judgement as the recovery (judgeGen). Nothing else.
 */
const headGen = (ctx, codec, hooks, now) => ({ ...ctx, codec, now, genDir: ctx.genDir, genTmp: `${ctx.genDir}.tmp`, seam: makeSeam(hooks), staleNoted: new Set() });

/**
 * #4559 r6 (§4.2, review a P2-3): whether the holding of one of `tokens` — the largest generation without `end`
 * that holds a record of them — still has a hand-off alive: `live` when any of its hand-off records
 * (`owner.h<k>`, the <lock> shows the last one only) is alive, `unknown` when one cannot be observed, `dead` when
 * all are gone; `none` when no such holding (or no chain) is there. The first record (the acquirer, the caller's
 * own process in D5's use) is the recovery's to judge (endDeadGen), as before. Reads only.
 */
function genHoldingState(ctx, tokens, codec, hooks, now) {
  if (!ctx.genDir) return { state: 'none' };
  const g = headGen(ctx, codec, hooks, now);
  const listing = listGens(g, 'gen-list');
  if (listing.unknown) return { state: 'unknown', unknown: listing.unknown };
  if (listing.max === 0) return { state: 'none' };
  const end = g.obs.lstat('gen-end-read', path.join(genPath(g, listing.max), 'end'));
  if (end.state === 'unknown') return { state: 'unknown', unknown: { point: 'gen-end-read', path: genPath(g, listing.max), code: end.code } };
  if (end.state !== 'absent') return { state: 'none' };
  const read = readGenRecords(g, listing.max);
  if (read.state === 'unknown') return { state: 'unknown', unknown: read.unknown };
  if (read.state !== 'records' || !read.records.some((r) => tokens.includes(r.token))) return { state: 'none' };
  for (const record of read.records.slice(1)) {
    if (isTomb(record)) continue;
    const holder = genHolderState(g, record);
    if (holder.state === 'alive') return { state: 'live', pid: record.pid };
    if (holder.state === 'unknown') return { state: 'unknown', unknown: { point: holder.point, path: genPath(g, listing.max), code: holder.code } };
  }
  return { state: 'dead' };
}

function endDeadGen(ctx, tokens, codec, hooks, now) {
  // The chain could not be chosen (gen-realpath unknown): nothing is ended (the next head does it).
  if (!ctx.genDir) return {};
  const g = headGen(ctx, codec, hooks, now);
  const listing = listGens(g, 'gen-list');
  if (listing.unknown || listing.max === 0) return listing.unknown ? { unknown: listing.unknown } : {};
  const end = g.obs.lstat('gen-end-read', path.join(genPath(g, listing.max), 'end'));
  if (end.state !== 'absent') return end.state === 'unknown' ? { unknown: { point: 'gen-end-read', path: genPath(g, listing.max), code: end.code } } : {};
  if (tokens !== null) {
    const read = readGenRecords(g, listing.max);
    if (read.state !== 'records' || !read.records.some((r) => tokens.includes(r.token))) return {};
  }
  const j = judgeGen(g, listing.max);
  return j.state === 'unknown' ? { unknown: j.unknown } : { state: j.state };
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
  const warnOnce = (line, data) => {
    if (warned.has(line)) return;
    warned.add(line);
    warn(line, data);
  };
  const now = hooks.now ?? (() => Date.now());
  const host = hooks.host ?? os.hostname();
  const obs = makeObserver({ fault: hooks.fault, pidAlive: hooks.pidAlive, groupAlive: hooks.groupAlive, kill: hooks.kill, codec });
  const env = {
    host,
    obs,
    link: hooks.link ?? ((src, dst) => fs.linkSync(src, dst)),
    beforeLink: hooks.beforeLink,
    warn,
    startOf: (pid, why = {}) => (hooks.startOf ? hooks.startOf(pid) : processStartMs(pid, now(), now, why)),
  };
  const root = path.dirname(lockPath);
  const queueDir = queueDirOfPath(lockPath);
  const token = crypto.randomUUID();
  const ctx = { root, lockPath, host, obs, warn, warnOnce, onRecover: hooks.onRecover, myToken: token, startOf: env.startOf, genDir: hooks.genDir ?? (resolveGenDir(lockPath, process.env, obs).genDir ?? null), codec, hooks, now };
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
            if (markDone(entry.file, entry.ticket.token, warn)) warn(`machine-lock-ticket-retired ${entry.file} (${why})`);
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
    if (mine !== null) markDone(path.join(queueDir, ticketName(mine)), token, warn);
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
      // #4559 (§4.2): the holding of these tokens, when its records are all dead, ends by the recovery's judgement.
      endDeadGen(ctx, tokens, ctx.codec, ctx.hooks, ctx.now);
      return { result: 'missing' };
    }
    if (read.state !== 'record' || !tokens.includes(read.owner.token)) return { result: 'kept' };
    const holder = holderState(read.owner, ctx);
    if (holder.state !== 'gone') {
      ctx.warn(`machine-lock-release-deferred ${lockPath} (holder pid ${read.owner.pid}${validPgid(read.owner.pgid) ? ` pgid ${read.owner.pgid}` : ''} is ${holder.state})`);
      return { result: 'deferred', ...(holder.state === 'unknown' ? { unknown: { point: holder.point, path: lockPath, code: holder.code } } : {}) };
    }
    // #4559 r6 (§4.2, review a P2-3): the <lock> shows the last hand-off only; the holding's every record decides.
    // A member alive (an earlier hand-off's group) or one that cannot be observed keeps the <lock> and the generation.
    const holding = genHoldingState(ctx, tokens, ctx.codec, ctx.hooks, ctx.now);
    if (holding.state === 'live' || holding.state === 'unknown') {
      ctx.warn(`machine-lock-release-deferred ${lockPath} (a record of the holding is ${holding.state === 'live' ? `alive: pid ${holding.pid}` : `unknown: ${holding.unknown.point} ${holding.unknown.code}`})`);
      return { result: 'deferred', ...(holding.state === 'unknown' ? { unknown: holding.unknown } : {}) };
    }
    // Not by its name (#4288 PR1a-f §3.1, F62): moved to this caller's own name, the token checked —
    // a successor that took the lock while this stopped past its ticket is put back.
    const j = recoverJudged(ctx, read.owner);
    // A re-read that failed is named (bash's lock_recover_judged says the same); the result stays 'kept'.
    if (j.result === 'reread-unknown') ctx.warnOnce(`machine-lock-unknown point=${j.unknown.point} path=${j.unknown.path} errno=${j.unknown.code}`);
    if (j.result !== 'recovered') return { result: 'kept' };
    for (const t of tokens) cleanupOwnGone(ctx, t);
    endDeadGen(ctx, tokens, ctx.codec, ctx.hooks, ctx.now);
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
    // #4559 (§4.3): a dead holding's generation is ended first (the guard's recovery, never a take).
    endDeadGen(ctx, null, ctx.codec, ctx.hooks, ctx.now);
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
    if (read.state === 'corrupt' && read.empty) {
      const e = reclaimEmptyOwner(ctx, now());
      return e.state === 'removed' ? done('removed') : done('kept', e.unknown);
    }
    if (read.state === 'corrupt') {
      warnCorrupt(ctx);
      return done('kept');
    }
    if (read.state === 'missing') {
      // A moved-aside record that holds (alive or unknown) keeps the owner-less <lock> too: the
      // put-back is its (§2.7), not the clean-up's.
      const expired = settled.block ? { state: 'none' } : expireOwnerless(ctx, options.ownerlessGraceMs, now());
      if (expired.state === 'removed') return done('removed');
      if (expired.state === 'absent' || ownerlessEmptyLock(ctx).state === 'absent') return done('absent');
      return done('kept', expired.unknown);
    }
    noteLegacy(ctx, lockPath, read.owner);
    const holder = holderState(read.owner, ctx);
    if (holder.state === 'unknown') return done('kept', { point: holder.point, path: lockPath, code: holder.code });
    if (holder.state !== 'gone') return done('kept');
    ctx.onRecover?.('recover-only-judged');
    const j = recoverJudged(ctx, read.owner);
    // #4559: a re-read that failed is the unknown result (kept, named), not folded into a plain 'kept'.
    if (j.result === 'reread-unknown') return done('kept', j.unknown);
    const r = j.result;
    return done(r === 'recovered' ? 'removed' : r === 'restore-failed' ? 'restore-failed' : r === 'gone' ? 'absent' : 'kept');
  });
}

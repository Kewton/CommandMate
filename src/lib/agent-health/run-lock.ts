/**
 * The one lock that UAT, the daily agent-health check and a manual `run.ts`
 * share (Issue #3359). The bash side is scripts/uat/run-lock.sh; the two agree
 * on the directory and on the owner file, line for line.
 *
 * Since Issue #4288 (PR1b, docs/design/run-lock-machine-lock-4288.md) the lock
 * is the machine-wide lock of scripts/orchestrate/machine-lock-sync.mjs: a
 * waiter takes a ticket first and only the head of the queue tries the
 * `mkdir`, a dead holder's lock is recovered by the head alone (moved aside,
 * token checked, deleted), and every observation answers in three values —
 * an unknown (EPERM, EIO …) is never read as "free". The owner is key=value
 * lines (`pid=`, `host=`, `token=`, `started_at=`, `label=`, `run_dir=`,
 * `pgid=`): the same text scripts/uat/run-lock.sh writes with
 * scripts/lib/machine-lock.sh, so an older reader's `sed -n 's/^pid=//p'`
 * still reads it.
 *
 * It lives in `$CM_RUN_LOCK_DIR`, else `<os.tmpdir()>/commandmate-run.lock` —
 * not under ~/.commandmate, where the test suite works. Its queue of tickets is
 * `<lock without .lock>.queue` beside it.
 *
 * A caller started by a holder (daily.sh runs run.ts) inherits the lock: the
 * holder exports its token as `CM_RUN_LOCK_TOKEN`, and a live holder with
 * that token counts as this caller's own (D8). daily.sh exports its T1
 * (`<T0>-g<G>`, the token that names the child's process group), so the
 * inheritor is a member of the group the record names.
 *
 * This side never writes `pgid=` (only the bash daily and UAT hand a lock to a
 * process group) and refuses a pid other than its own: the record's pid is the
 * process itself, so its own release (D12) is sure to be the holder's.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  GONE_SUFFIX_PATTERN,
  acquireMachineLockSync,
  holderState,
  makeObserver,
} from '../../../scripts/orchestrate/machine-lock-sync.mjs';

export const RUN_LOCK_DIR_ENV = 'CM_RUN_LOCK_DIR';
export const RUN_LOCK_TOKEN_ENV = 'CM_RUN_LOCK_TOKEN';
const LOCK_NAME = 'commandmate-run.lock';
/** A lock directory without an owner file is still being made, up to this age. */
const OWNERLESS_GRACE_MS = 60_000;
/** Characters a token may have (I-8): the moved-aside record's name carries it, and readers accept only these. */
const TOKEN_PATTERN = /^[A-Za-z0-9-]+$/;

/** The environment variables this module reads (process.env fits). */
export type RunLockEnv = Readonly<Record<string, string | undefined>>;

export interface RunLockOwner {
  pid: number;
  startedAt: string;
  label: string;
  token: string;
  runDir?: string;
  host?: string;
  pgid?: number;
}

/** What `release()` answers (machine-lock-sync.mjs `release`; an inherited handle answers `none`). */
export type RunLockReleaseResult = 'released' | 'deferred' | 'needs-head' | 'kept' | 'none';

export type RunLockResult =
  | { ok: true; how: 'acquired' | 'inherited'; dir: string; token: string; release: () => RunLockReleaseResult }
  | { ok: false; dir: string; error: string };

export interface AcquireRunLockOptions {
  label: string;
  env?: RunLockEnv;
  /** Must be this process (the record's pid is the caller itself, I-6); anything else is refused. */
  pid?: number;
  token?: string;
  /** Test seam: stands in for `kill -0 <pid>` (true = alive). */
  isAlive?: (pid: number) => boolean;
  /** Test seam (D10): stands in for `process.kill(target, 0)`; throws as it does (ESRCH = gone, EPERM = unknown). */
  kill?: (target: number, signal: number) => void;
  /** Test seam: answers an errno to inject at an observation point (the same classification as a real failure). */
  fault?: (point: string, target: string) => string | null | undefined;
  now?: () => Date;
}

/** `$CM_RUN_LOCK_DIR`, else `<tmpdir>/commandmate-run.lock`. */
export function runLockDir(env: RunLockEnv = process.env, tmpdir: string = os.tmpdir()): string {
  const configured = env[RUN_LOCK_DIR_ENV];
  if (configured) return configured;
  return path.join(tmpdir, LOCK_NAME);
}

/** Parses an owner file; null when it is missing or has no usable pid/token. */
export function parseRunLockOwner(text: string | null): RunLockOwner | null {
  if (text === null) return null;
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0 && !fields.has(line.slice(0, at))) fields.set(line.slice(0, at), line.slice(at + 1));
  }
  const pid = Number.parseInt(fields.get('pid') ?? '', 10);
  const token = fields.get('token') ?? '';
  if (!Number.isInteger(pid) || pid <= 0 || token === '') return null;
  const pgid = fields.has('pgid') ? Number(fields.get('pgid')) : undefined;
  return {
    pid,
    startedAt: fields.get('started_at') ?? '',
    label: fields.get('label') ?? '',
    token,
    ...(fields.has('run_dir') ? { runDir: fields.get('run_dir') } : {}),
    ...(fields.has('host') ? { host: fields.get('host') } : {}),
    ...(pgid !== undefined && Number.isInteger(pgid) ? { pgid } : {}),
  };
}

export function formatRunLockOwner(owner: RunLockOwner): string {
  const lines = [`pid=${owner.pid}`];
  if (owner.host) lines.push(`host=${owner.host}`);
  lines.push(`token=${owner.token}`, `started_at=${owner.startedAt}`, `label=${owner.label}`);
  if (owner.runDir) lines.push(`run_dir=${owner.runDir}`);
  if (owner.pgid !== undefined) lines.push(`pgid=${owner.pgid}`);
  return `${lines.join('\n')}\n`;
}

export function readRunLockOwner(dir: string): RunLockOwner | null {
  try {
    return parseRunLockOwner(fs.readFileSync(path.join(dir, 'owner'), 'utf8'));
  } catch {
    return null;
  }
}

/** D1: the codec of machine-lock-sync.mjs for the key=value owner. A bad `pid=` is not a pid; a bad `pgid=` is not a number (unknown). */
const KV_CODEC = {
  parse(text: string): Record<string, unknown> {
    const fields = new Map<string, string>();
    for (const line of text.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0 && !fields.has(line.slice(0, at))) fields.set(line.slice(0, at), line.slice(at + 1));
    }
    const pidText = fields.get('pid') ?? '';
    const startedAt = Date.parse(fields.get('started_at') ?? '');
    return {
      ...(/^[0-9]+$/.test(pidText) ? { pid: Number(pidText) } : {}),
      host: fields.get('host') || os.hostname(),
      ...(fields.get('token') ? { token: fields.get('token') } : {}),
      ...(Number.isNaN(startedAt) ? {} : { acquiredAt: startedAt }),
      label: fields.get('label') ?? '',
      ...(fields.has('run_dir') ? { runDir: fields.get('run_dir') } : {}),
      ...(fields.has('lstart') ? { lstart: fields.get('lstart') } : {}),
      ...(fields.has('pgid') ? { pgid: /^[0-9]+$/.test(fields.get('pgid') ?? '') ? Number(fields.get('pgid')) : Number.NaN } : {}),
    };
  },
  format(record: Record<string, unknown>): string {
    const lines = [`pid=${record.pid}`, `host=${record.host}`, `token=${record.token}`];
    const at = typeof record.acquiredAt === 'number' ? record.acquiredAt : Date.now();
    lines.push(`started_at=${new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
    if (typeof record.label === 'string') lines.push(`label=${record.label}`);
    if (typeof record.runDir === 'string' && record.runDir) lines.push(`run_dir=${record.runDir}`);
    if (typeof record.pgid === 'number') lines.push(`pgid=${record.pgid}`);
    return `${lines.join('\n')}\n`;
  },
};

type Observer = ReturnType<typeof makeObserver>;

interface Hooks {
  pidAlive?: (pid: number) => boolean;
  kill?: (target: number, signal: number) => void;
  now: () => number;
}

/**
 * D8: a live holder under the inherited token is this caller's own. The owner is read once; the judgement is
 * the holder's (pid first, and the group only when the pid is gone), so an inheritor in the record's group
 * keeps a group-named record alive. While `<lock>` is missing, a moved-aside record of the same token that is
 * alive is inherited too (the head that moved it aside is putting it back). Gone or unknown is not inherited:
 * the ordinary acquisition recovers a gone holder's lock, and refuses an unknown one.
 */
function isInherited(dir: string, token: string, obs: Observer): boolean {
  const host = os.hostname();
  const read = obs.owner('inherit-owner', dir);
  if (read.state === 'record') return read.owner.token === token && holderState(read.owner, { host, obs }).state === 'alive';
  if (read.state !== 'missing') return false;
  const base = path.basename(dir);
  const listed = obs.list('inherit-list', path.dirname(dir));
  if (listed.state !== 'listed') return false;
  const prefix = `${base}.gone-${token}-`;
  for (const name of listed.names) {
    if (!name.startsWith(prefix) || !GONE_SUFFIX_PATTERN.test(name.slice(`${base}.gone-`.length))) continue;
    const moved = obs.owner('inherit-gone-owner', path.join(path.dirname(dir), name));
    if (moved.state === 'record' && moved.owner.token === token && holderState(moved.owner, { host, obs }).state === 'alive') return true;
  }
  return false;
}

/** `, zombie: its parent P has not reaped it` for a pid that is a zombie (kill -0 says alive for it), else ''. */
function zombieNote(pid: number): string {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!stat.startsWith('Z')) return '';
    const ppid = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return `, zombie: its parent ${ppid || '?'} has not reaped it`;
  } catch {
    return '';
  }
}

function describeHolder(dir: string, owner: RunLockOwner | null, heldBy: string | null, unknown: string | null, asides: string[]): string {
  const holder = owner
    ? `pid ${owner.pid}${owner.pgid !== undefined ? `, pgid ${owner.pgid}` : ''}, ${owner.label}, ${owner.startedAt}${owner.runDir ? `, ${owner.runDir}` : ''}${zombieNote(owner.pid)}${
        owner.host && owner.host !== os.hostname() ? `, host ${owner.host} (this host is ${os.hostname()}: remove ${dir} by hand if that is this machine)` : ''
      }`
    : null;
  // A moved-aside record that was alive is what held it up (it is back in place by now, or still aside).
  if (unknown) return `${dir}（${unknown}${asides.length > 0 ? `; a moved-aside record may be alive: ${asides.join(', ')}` : ''}${holder ? `; recorded: ${holder}` : ''}）`;
  if (asides.length > 0) return `${dir}（a moved-aside record is alive: ${asides.join(', ')}${holder ? `; ${holder}` : ''}）`;
  if (holder) return `${dir}（${holder}）`;
  if (heldBy?.startsWith('restore pending')) return `${dir}（a moved-aside record is alive: ${heldBy}）`;
  if (heldBy) return `${dir}（${heldBy}）`;
  let names: string[] | null = null;
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = null;
  }
  if (names === null || names.length === 0) return `${dir}（作成中: owner はまだ無い）`;
  if (names.includes('owner')) return `${dir}（owner に pid= か token= が無い: 確かめて手で消す）`;
  return `${dir}（owner が無く空でない: ${names.slice(0, 5).join(', ')}。確かめて手で消す）`;
}

/** The moved-aside records of `dir` right now (`<name>.gone-<S>` directories). */
function listAsides(dir: string): string[] {
  const prefix = `${path.basename(dir)}.gone-`;
  try {
    return fs.readdirSync(path.dirname(dir)).filter((name) => name.startsWith(prefix) && GONE_SUFFIX_PATTERN.test(name.slice(prefix.length)));
  } catch {
    return [];
  }
}

/**
 * Takes the run lock. `release()` removes it only while it is still ours (D12: a record under our token whose
 * pid is this process), and does nothing for an inherited lock (the parent releases it). An unknown observation
 * refuses; so do a token or a label that the readers could not read back (I-8).
 */
export function acquireRunLock(options: AcquireRunLockOptions): RunLockResult {
  const env = options.env ?? process.env;
  const dir = runLockDir(env);
  const fail = (error: string): RunLockResult => ({ ok: false, dir, error });
  if (options.pid !== undefined && options.pid !== process.pid) {
    return fail(`run-lock: pid ${options.pid} is not this process (${process.pid}): the record's pid must be the caller itself`);
  }
  const token = options.token ?? `${options.label}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  if (!TOKEN_PATTERN.test(token)) return fail(`run-lock: a token must be [A-Za-z0-9-]+: ${JSON.stringify(token)}`);
  if (options.label.includes('\n')) return fail('run-lock: a label must not contain a newline');

  const now = options.now ?? (() => new Date());
  const hooks: Hooks = {
    pidAlive: options.isAlive,
    kill: options.kill,
    now: () => now().getTime(),
  };
  const obs = makeObserver({ fault: options.fault, pidAlive: hooks.pidAlive, kill: hooks.kill, codec: KV_CODEC });

  const inherited = env[RUN_LOCK_TOKEN_ENV];
  if (inherited && TOKEN_PATTERN.test(inherited) && isInherited(dir, inherited, obs)) {
    return { ok: true, how: 'inherited', dir, token: inherited, release: () => 'none' };
  }

  const asidesBefore = listAsides(dir);
  let handle: ReturnType<typeof acquireMachineLockSync>;
  try {
    handle = acquireMachineLockSync('run', {
      lockPath: dir,
      timeoutMs: 0,
      ownerCodec: KV_CODEC,
      ownerlessGraceMs: OWNERLESS_GRACE_MS,
      token,
      ownerPid: process.pid,
      ownerFields: { label: options.label },
      hooks: { now: hooks.now, pidAlive: hooks.pidAlive, kill: hooks.kill, fault: options.fault },
    } as Parameters<typeof acquireMachineLockSync>[1]);
  } catch (error) {
    // mkdir / owner create / queue: an observation that failed is not a lock taken (F6).
    return fail(`ロックを作れない（${dir}）: ${(error as Error).message}`);
  }
  if (!handle.acquired) {
    let unknown = handle.unknown ? `cannot tell: point=${handle.unknown.point} path=${handle.unknown.path} errno=${handle.unknown.code}` : null;
    // A ticket ahead whose pid cannot be observed (EPERM) is not "held": nobody can tell whether it is alive.
    const ahead = handle.heldBy?.match(/^queue ticket .*\(pid (\d+) on /);
    if (!unknown && ahead) {
      const seen = obs.pid('pid', Number(ahead[1]));
      if (seen.state === 'unknown') unknown = `cannot tell: point=${seen.point} path=${ahead[1]} errno=${seen.code}`;
    }
    return fail(`別の実行がロックを持っている: ${describeHolder(dir, readRunLockOwner(dir), handle.heldBy, unknown, asidesBefore)}`);
  }
  return {
    ok: true,
    how: 'acquired',
    dir,
    token,
    release: () => {
      try {
        return handle.release();
      } catch {
        // rmSync failed (EACCES, EIO): nothing was claimed released; the next head recovers a dead holder's lock.
        return 'deferred';
      }
    },
  };
}

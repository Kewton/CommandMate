/**
 * The one lock that UAT, the daily agent-health check and a manual `run.ts`
 * share (Issue #3359). The bash side is scripts/uat/run-lock.sh; the two agree
 * on the directory and on the owner file, line for line.
 *
 * The lock is a directory: `mkdir` is atomic, so of two callers that race
 * exactly one gets it. Its `owner` file holds `pid=`, `started_at=`, `label=`,
 * `token=` (and `run_dir=` for a UAT run). A lock whose owner pid is dead is
 * taken over by renaming it aside first, so two callers that both judged it
 * stale cannot both end up holding it.
 *
 * It lives in `$CM_RUN_LOCK_DIR`, else `<os.tmpdir()>/commandmate-run.lock` —
 * not under ~/.commandmate, where the test suite works.
 *
 * A caller started by a holder (daily.sh runs run.ts) inherits the lock: the
 * holder exports its token as `CM_RUN_LOCK_TOKEN`, and a live holder with
 * that token counts as this caller's own.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const RUN_LOCK_DIR_ENV = 'CM_RUN_LOCK_DIR';
export const RUN_LOCK_TOKEN_ENV = 'CM_RUN_LOCK_TOKEN';
const LOCK_NAME = 'commandmate-run.lock';
/** A lock directory without an owner file is still being made, up to this age. */
const OWNERLESS_GRACE_MS = 60_000;
const MAX_ATTEMPTS = 5;

/** The environment variables this module reads (process.env fits). */
export type RunLockEnv = Readonly<Record<string, string | undefined>>;

export interface RunLockOwner {
  pid: number;
  startedAt: string;
  label: string;
  token: string;
  runDir?: string;
}

export type RunLockResult =
  | { ok: true; how: 'acquired' | 'inherited'; dir: string; token: string; release: () => void }
  | { ok: false; dir: string; error: string };

export interface AcquireRunLockOptions {
  label: string;
  env?: RunLockEnv;
  pid?: number;
  token?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}

/** `$CM_RUN_LOCK_DIR`, else `<tmpdir>/commandmate-run.lock`. */
export function runLockDir(env: RunLockEnv = process.env, tmpdir: string = os.tmpdir()): string {
  const configured = env[RUN_LOCK_DIR_ENV];
  if (configured) return configured;
  return path.join(tmpdir, LOCK_NAME);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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
  return {
    pid,
    startedAt: fields.get('started_at') ?? '',
    label: fields.get('label') ?? '',
    token,
    ...(fields.has('run_dir') ? { runDir: fields.get('run_dir') } : {}),
  };
}

export function formatRunLockOwner(owner: RunLockOwner): string {
  const lines = [`pid=${owner.pid}`, `started_at=${owner.startedAt}`, `label=${owner.label}`, `token=${owner.token}`];
  if (owner.runDir) lines.push(`run_dir=${owner.runDir}`);
  return `${lines.join('\n')}\n`;
}

export function readRunLockOwner(dir: string): RunLockOwner | null {
  try {
    return parseRunLockOwner(fs.readFileSync(path.join(dir, 'owner'), 'utf8'));
  } catch {
    return null;
  }
}

function isStale(dir: string, isAlive: (pid: number) => boolean, now: Date): boolean {
  const owner = readRunLockOwner(dir);
  if (owner) return !isAlive(owner.pid);
  try {
    return now.getTime() - fs.statSync(dir).mtimeMs > OWNERLESS_GRACE_MS;
  } catch {
    return false;
  }
}

/** Moves a stale lock aside and removes it; puts back one that changed hands meanwhile. */
function takeStale(dir: string, isAlive: (pid: number) => boolean, now: Date): void {
  const judged = readRunLockOwner(dir)?.token ?? '';
  const aside = `${dir}.stale.${process.pid}.${Math.random().toString(16).slice(2, 10)}`;
  try {
    fs.renameSync(dir, aside);
  } catch {
    return;
  }
  const moved = readRunLockOwner(aside)?.token ?? '';
  if (moved !== judged || !isStale(aside, isAlive, now)) {
    if (!fs.existsSync(dir)) {
      try {
        fs.renameSync(aside, dir);
      } catch {
        // Somebody made a fresh lock in the meantime; theirs stands.
      }
    }
    return;
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

function describeHolder(dir: string, owner: RunLockOwner | null): string {
  if (!owner) return `${dir}（作成中）`;
  return `${dir}（pid ${owner.pid}, ${owner.label}, ${owner.startedAt}${owner.runDir ? `, ${owner.runDir}` : ''}）`;
}

/**
 * Takes the run lock. `release()` removes it only while it is still ours, and
 * is a no-op for an inherited lock (the parent releases it).
 */
export function acquireRunLock(options: AcquireRunLockOptions): RunLockResult {
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const now = options.now ?? (() => new Date());
  const token = options.token ?? `${options.label}-${pid}-${Math.random().toString(16).slice(2, 10)}`;
  const dir = runLockDir(env);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, dir, error: `ロックを作れない（${dir}）: ${(error as Error).message}` };
      }
      const holder = readRunLockOwner(dir);
      const inherited = env[RUN_LOCK_TOKEN_ENV];
      if (holder && inherited && holder.token === inherited && isAlive(holder.pid)) {
        return { ok: true, how: 'inherited', dir, token: holder.token, release: () => undefined };
      }
      if (isStale(dir, isAlive, now())) {
        takeStale(dir, isAlive, now());
        continue;
      }
      return { ok: false, dir, error: `別の実行がロックを持っている: ${describeHolder(dir, holder)}` };
    }
    const staging = path.join(dir, `owner.tmp.${process.pid}`);
    fs.writeFileSync(
      staging,
      formatRunLockOwner({ pid, startedAt: now().toISOString(), label: options.label, token })
    );
    fs.renameSync(staging, path.join(dir, 'owner'));
    return {
      ok: true,
      how: 'acquired',
      dir,
      token,
      release: () => {
        if (readRunLockOwner(dir)?.token === token) fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }
  return { ok: false, dir, error: `ロックを取れなかった（${dir}、${MAX_ATTEMPTS} 回）` };
}

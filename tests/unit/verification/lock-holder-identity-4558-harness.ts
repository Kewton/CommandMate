/**
 * Shared seams of the #4558 / #4559 / #4560 tests (the lock's holder taken for another): temporary
 * roots under os.tmpdir(), records written by hand, a real dead pid, and verify-run.sh's lock section
 * driven in a bash of its own. Nothing here touches ~/.commandmate: every root is a mkdtemp.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';

export const REPO = path.resolve(__dirname, '../../..');
export const VERIFY_RUN = path.join(REPO, '.claude/skills/cmate-verify/scripts/verify-run.sh');
export const HOST = os.hostname();
/** The stall of #4559's report: longer than the recoverer's ticket deadline + 60 s, inside P0's 10 minutes. */
export const STALL_MS = 65_000;

const roots: string[] = [];

export function freshRoot(tag: string): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `lock-holder-${tag}-`));
  roots.push(r);
  return r;
}

export function cleanRoots(): void {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
}

let dead: number | null = null;
/** A pid that existed and has exited (reaped): kill -0 answers ESRCH. */
export function deadPid(): number {
  if (dead !== null) return dead;
  const r = spawnSync('sh', ['-c', 'echo $$']);
  dead = Number(String(r.stdout).trim());
  return dead;
}

export function writeOwner(lockPath: string, record: Record<string, unknown>): void {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify(record));
}

export function ownerToken(lockPath: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).token ?? null;
  } catch {
    return null;
  }
}

export function goneDirs(lockPath: string): string[] {
  const root = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.gone-`;
  return fs.readdirSync(root).filter((e) => e.startsWith(prefix));
}

/** The dead holder D: a v1 record whose pid has exited. */
export function writeDeadHolder(lockPath: string): void {
  writeOwner(lockPath, { pid: deadPid(), host: HOST, token: 'D', acquiredAt: 0, v: 1 });
}

/**
 * The next waiter U of #4559: a real acquisition (the sync JS) whose clock runs STALL_MS ahead, so the
 * stalled recoverer's ticket is past its deadline + 60 s. Every live pid it sees started long ago (its
 * startOf answers 0): the stalled recoverer's ticket is retired as expired, not as a reused pid.
 */
export function takeAsSuccessor(lockPath: string, aheadMs: number = STALL_MS): ReturnType<typeof lockSync.acquireMachineLockSync> {
  return lockSync.acquireMachineLockSync('x', {
    lockPath,
    timeoutMs: 2000,
    pollMs: 10,
    hooks: { now: () => Date.now() + aheadMs, startOf: () => 0 },
  });
}

/**
 * An older runner U2 (a bare mkdir, no ticket — the form #4277's invariant tests keep in view): it
 * takes the lock path whenever it is free. Answers true when it took it.
 */
export function bareTake(lockPath: string, token: string): boolean {
  try {
    fs.mkdirSync(lockPath);
  } catch {
    return false;
  }
  fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: process.pid, host: HOST, token, acquiredAt: Date.now(), v: 1 }));
  return true;
}

/** Run `body` after verify-run.sh's lock section is loaded (the same cut as the #4277 / #4288 tests). */
export function bashSection(body: string): string {
  return `eval "$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$1")"\n${body}`;
}

export interface PausedBash {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exited: Promise<number | null>;
  reached: (stage: string) => boolean;
  go: (stage: string) => void;
}

/** A bash running `body` with the pauses `stages` (CM_VERIFY_TEST_HANDOFF=pause:<stage>,…). */
export function startPausedBash(root: string, body: string, stages: string[], env: Record<string, string> = {}): PausedBash {
  const dir = fs.mkdtempSync(path.join(root, 'pause-'));
  let out = '';
  let err = '';
  const child = spawn('bash', ['-c', bashSection(body), 'bash', VERIFY_RUN], {
    env: {
      ...process.env,
      CM_VERIFY_LOCK_ROOT: root,
      CM_VERIFY_TEST_HANDOFF: stages.map((s) => `pause:${s}`).join(','),
      CM_VERIFY_TEST_HANDOFF_DIR: dir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => (out += String(d)));
  child.stderr?.on('data', (d) => (err += String(d)));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    out: () => out,
    err: () => err,
    exited,
    reached: (stage) => fs.existsSync(path.join(dir, `${stage}.reached`)),
    go: (stage) => fs.writeFileSync(path.join(dir, `${stage}.go`), ''),
  };
}

/** Poll `cond` every 20 ms up to `limitMs`; true when it held. */
export async function until(cond: () => boolean, limitMs = 15000): Promise<boolean> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

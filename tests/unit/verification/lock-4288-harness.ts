/**
 * Shared harness of the Issue #4288 tests: the three implementations of the machine-wide lock
 * (verify-run.sh's bash, machine-lock.ts, machine-lock-sync.mjs) behind one `take`, records written
 * by hand, real dead pids and live process groups. Every root is a directory under os.tmpdir().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { acquireMachineLock, machineLockPath } from '@/lib/verification/machine-lock';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import type { Impl } from './lock-observation-scan-4288';

export const REPO = path.resolve(__dirname, '../../..');
export const VERIFY_RUN = path.join(REPO, '.claude/skills/cmate-verify/scripts/verify-run.sh');
export const SYNC_MODULE = path.join(REPO, 'scripts/orchestrate/machine-lock-sync.mjs');
export const HOST = os.hostname();
export const IMPLS: Impl[] = ['bash', 'ts', 'sync'];

/** verify-run.sh's lock section alone, in a bash of its own (the same cut as machine-lock-invariants-4277). */
const BASH_DRIVER = `
script=$1 root=$2 name=$3 budget=$4
export CM_VERIFY_LOCK_ROOT="$root"
eval "$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$script")"
if [ -n "\${TAKE_OWNERLESS_GRACE_MS:-}" ]; then LOCK_OWNERLESS_GRACE_MS=$TAKE_OWNERLESS_GRACE_MS; fi
if lock_acquire "$name" "$budget"; then
  printf 'acquired\\n'
  if [ -n "\${PRE_RELEASE:-}" ]; then eval "$PRE_RELEASE"; fi
  if [ -n "\${NO_RELEASE:-}" ]; then exit 0; fi
  if lock_release "$LOCK_PATH" "$LOCK_TOKEN"; then printf 'released\\n'; else printf 'kept\\n'; fi
else
  printf 'not-acquired\\t%s\\n' "$LOCK_HELD_BY"
fi
`;

export interface TakeResult {
  acquired: boolean;
  heldBy: string | null;
  /** The unknown the implementation reported: `point=… path=… errno=…` (bash stderr / TS and sync `unknown`). */
  unknown: string | null;
  /** 'released' / 'kept' after the release, null when not acquired or not released. */
  release: 'released' | 'kept' | null;
  /** An error the acquisition threw (TS / sync: a mkdir that failed for another reason than EEXIST). */
  error: string | null;
  /** bash stderr, or the sync warnings. */
  log: string;
}

export interface TakeOptions {
  /** Inject `<point>=<ERRNO>` (`<point>@<substring>=<ERRNO>` matches the target too). */
  fault?: string;
  /** bash budget in whole seconds / TS and sync milliseconds (default 0: one poll). */
  budgetSec?: number;
  /** Run between the acquisition and the release (TS / sync: a function; bash: a shell snippet). */
  between?: { fn: () => void; sh: string };
  /** Do not release (the record stays for the test to look at). */
  keep?: boolean;
  /** A mutated copy of the implementation (positive controls): a bash script path or a sync module. */
  bashScript?: string;
  syncModule?: typeof lockSync;
  env?: Record<string, string>;
  /** #4288 PR1a D3: the head takes out an owner-less, empty <lock> older than this (bash and sync JS; TS has no such option). */
  ownerlessGraceMs?: number;
}

/** Options every take() of a test applies unless it passes its own (a test resets what it set). */
export const takeDefaults: Partial<TakeOptions> = {};

function faultFn(spec?: string): ((point: string, target: string) => string | undefined) | undefined {
  if (!spec) return undefined;
  const items = spec.split(/\s+/).filter(Boolean).map((item) => {
    const [key, code] = item.split('=');
    const [point, sub] = key.split('@');
    return { point, sub, code };
  });
  return (point, target) => items.find((i) => i.point === point && (!i.sub || target.includes(i.sub)))?.code;
}

export async function take(impl: Impl, root: string, name: string, given: TakeOptions = {}): Promise<TakeResult> {
  const o: TakeOptions = { ...takeDefaults, ...given };
  const budgetSec = o.budgetSec ?? 0;
  if (impl === 'bash') {
    const r = spawnSync('bash', ['-c', BASH_DRIVER, 'bash', o.bashScript ?? VERIFY_RUN, root, name, String(budgetSec)], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        CM_VERIFY_TEST_OBS_FAULT: o.fault ?? '',
        PRE_RELEASE: o.between?.sh ?? '',
        NO_RELEASE: o.keep ? '1' : '',
        TAKE_OWNERLESS_GRACE_MS: o.ownerlessGraceMs === undefined ? '' : String(o.ownerlessGraceMs),
        ...(o.env ?? {}),
      },
    });
    const lines = (r.stdout ?? '').split('\n').filter(Boolean);
    const first = lines[0] ?? '';
    const unknown = /machine-lock-unknown (point=\S+ path=.* errno=\S+)/.exec(r.stderr ?? '')?.[1] ?? null;
    return {
      acquired: first === 'acquired',
      heldBy: first.startsWith('not-acquired') ? first.split('\t')[1] || null : null,
      unknown,
      release: (lines[1] as 'released' | 'kept' | undefined) ?? null,
      error: r.error ? String(r.error) : null,
      log: r.stderr ?? '',
    };
  }
  const fault = faultFn(o.fault);
  if (impl === 'ts') {
    try {
      const r = await acquireMachineLock(name, { root, timeoutMs: budgetSec * 1000, pollIntervalMs: 20, __testHooks: fault ? { fault } : {} });
      if (!r.acquired) {
        const u = r.unknown ? `point=${r.unknown.point} path=${r.unknown.path} errno=${r.unknown.code}` : null;
        return { acquired: false, heldBy: r.heldBy, unknown: u, release: null, error: null, log: '' };
      }
      o.between?.fn();
      if (o.keep) return { acquired: true, heldBy: null, unknown: null, release: null, error: null, log: '' };
      r.handle.release();
      return { acquired: true, heldBy: null, unknown: null, release: fs.existsSync(r.handle.path) ? 'kept' : 'released', error: null, log: '' };
    } catch (error) {
      return { acquired: false, heldBy: null, unknown: null, release: null, error: (error as Error).message, log: '' };
    }
  }
  const mod = o.syncModule ?? lockSync;
  const warnings: string[] = [];
  try {
    const r = mod.acquireMachineLockSync(name, {
      root,
      timeoutMs: budgetSec * 1000,
      pollMs: 20,
      warn: (l: string) => warnings.push(l),
      hooks: fault ? { fault } : {},
      ...(o.ownerlessGraceMs === undefined ? {} : { ownerlessGraceMs: o.ownerlessGraceMs }),
    });
    if (!r.acquired) {
      const u = r.unknown ? `point=${r.unknown.point} path=${r.unknown.path} errno=${r.unknown.code}` : null;
      return { acquired: false, heldBy: r.heldBy, unknown: u, release: null, error: null, log: warnings.join('\n') };
    }
    o.between?.fn();
    if (o.keep) return { acquired: true, heldBy: null, unknown: null, release: null, error: null, log: warnings.join('\n') };
    r.release();
    return { acquired: true, heldBy: null, unknown: null, release: fs.existsSync(r.path) ? 'kept' : 'released', error: null, log: warnings.join('\n') };
  } catch (error) {
    return { acquired: false, heldBy: null, unknown: null, release: null, error: (error as Error).message, log: warnings.join('\n') };
  }
}

/** A pid that existed and has exited. */
export function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

/** Whether a process group still has a member (kill -0 -<pgid> succeeds). */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Processes a test started (each the leader of its own group), for afterEach. */
export const started: ChildProcess[] = [];

/** A live process group: `sleep 60` leading its own group. */
export function liveGroup(): number {
  const child = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
  started.push(child);
  return child.pid as number;
}

export function killStarted(): void {
  for (const child of started.splice(0)) {
    for (const target of [child.pid ? -child.pid : 0, child.pid ?? 0]) {
      try {
        if (target) process.kill(target, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
}

/** Block (synchronously) until `predicate` holds or `timeoutMs` passes. */
export function waitSync(predicate: () => boolean, timeoutMs = 10000): boolean {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return true;
}

export function writeOwner(dir: string, owner: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner'), JSON.stringify(owner));
  return dir;
}

export const lockOf = (root: string, name: string): string => machineLockPath(name, root);
export const readOwnerToken = (dir: string): string | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'owner'), 'utf8')).token ?? null;
  } catch {
    return null;
  }
};
export const goneEntries = (root: string, name: string): string[] =>
  fs.readdirSync(root).filter((e) => e.startsWith(`${name}.lock.gone-`));

/** Restore permissions under `root` and remove it. */
export function removeRoot(root: string): void {
  spawnSync('chmod', ['-R', 'u+rwx', root]);
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * A copy of verify-run.sh with `edit` applied, under `dir` — the fix taken out, for a positive
 * control. Throws when the edit changed nothing (the control would be vacuous).
 */
export function mutatedBash(dir: string, edit: (source: string) => string): string {
  const source = fs.readFileSync(VERIFY_RUN, 'utf8');
  const out = edit(source);
  if (out === source) throw new Error('the mutation changed nothing');
  const file = path.join(dir, `verify-run-mutated-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, out);
  return file;
}

/** The same for machine-lock-sync.mjs (it imports node builtins only, so a copy loads anywhere). */
export async function mutatedSync(dir: string, edit: (source: string) => string): Promise<typeof lockSync> {
  const source = fs.readFileSync(SYNC_MODULE, 'utf8');
  const out = edit(source);
  if (out === source) throw new Error('the mutation changed nothing');
  const file = path.join(dir, `machine-lock-sync-mutated-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, out);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as typeof lockSync;
}

export const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

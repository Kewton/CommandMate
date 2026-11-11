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

/**
 * The fault spec of the TS / sync drives, read as verify-run.sh's lock_test_obs_fault reads it:
 * `<point>=<ERRNO>`, `<point>@<substring of the target>=<ERRNO>`, and (#4288 PR1a-f impl-10, B3)
 * `<point>@@<the whole target>=<ERRNO>` — a pid of 3 digits no longer matches every pid containing them.
 */
export function faultFn(spec?: string): ((point: string, target: string) => string | undefined) | undefined {
  if (!spec) return undefined;
  const items = spec
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => {
      const eq = item.indexOf('=');
      const key = item.slice(0, eq);
      const code = item.slice(eq + 1);
      const exact = key.indexOf('@@');
      if (exact >= 0) return { point: key.slice(0, exact), sub: key.slice(exact + 2), exact: true, code };
      const at = key.indexOf('@');
      return at >= 0 ? { point: key.slice(0, at), sub: key.slice(at + 1), exact: false, code } : { point: key, sub: '', exact: false, code };
    });
  return (point, target) => items.find((i) => i.point === point && (i.exact ? target === i.sub : !i.sub || target.includes(i.sub)))?.code;
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
    assertWithinLimit(r, 'take (bash)', 30000);
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

/**
 * A10 (#4288 PR1a-f impl-10): a spawnSync that ran past its limit is named as such — a limit of the
 * machine (a loaded one), not a result of the row — instead of an empty output read as a wrong answer.
 */
export function assertWithinLimit(r: { error?: Error; signal?: NodeJS.Signals | null }, what: string, limitMs: number): void {
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(`LIMIT: ${what} ran past its limit of ${limitMs} ms (ETIMEDOUT) — the limit, not the row's result`);
  }
}

/**
 * Wait, yielding to the event loop (a killed child is reaped by node only between turns of the loop, and
 * until then its zombie answers kill -0). Past `timeoutMs` it throws, named as the limit (A10/A14).
 */
export async function until(predicate: () => boolean, timeoutMs = 10000, what = 'the condition'): Promise<true> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`LIMIT: ${what} did not hold within ${timeoutMs} ms — the limit, not the row's result`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/**
 * A `ps` first on PATH that answers `-o etime=` for FAKE_ETIME_PID with FAKE_ETIME, and — with CM_OBS_ETIME
 * set (an injected observation) — for every live pid with CM_OBS_ETIME, so no real etime is read. Each etime
 * query appends one byte to CM_OBS_COUNT (the injected clock counts the queries: one step per observation);
 * a query that falls through to the real ps appends to CM_OBS_REAL_LOG. Anything else is the real ps
 * (the `ps` on PATH when this one was made; a slow shim goes in front of this one, never behind it).
 */
export function psShim(dir: string): string {
  const real = (spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout ?? '').trim() || '/bin/ps';
  const bin = path.join(dir, 'shim-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'ps'),
    [
      '#!/bin/sh',
      'last=""',
      'for a in "$@"; do last=$a; done',
      'case " $* " in',
      '  *" etime= "*)',
      '    if [ -n "${CM_OBS_COUNT:-}" ]; then printf x >> "$CM_OBS_COUNT"; fi',
      '    if [ -n "${FAKE_ETIME_PID:-}" ] && [ "$last" = "$FAKE_ETIME_PID" ]; then echo "$FAKE_ETIME"; exit 0; fi',
      '    if [ -n "${CM_OBS_ETIME:-}" ] && kill -0 "$last" 2>/dev/null; then echo "$CM_OBS_ETIME"; exit 0; fi',
      '    if [ -n "${CM_OBS_REAL_LOG:-}" ]; then printf x >> "$CM_OBS_REAL_LOG"; fi',
      '    ;;',
      'esac',
      `exec ${real} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

/**
 * A `ps` that sleeps `seconds` and then runs the next `ps` on PATH (the closing condition (ii) of #4288
 * PR1a-f impl-10: a row's answer is the same with a ps of 1.2 s in front). Put its directory first on PATH.
 */
export function slowPsShim(dir: string, seconds = 1.2): string {
  const bin = path.join(dir, 'slow-ps-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'ps'),
    [
      '#!/bin/sh',
      `sleep ${seconds}`,
      `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF '${bin}' | paste -sd: -)`,
      'export PATH',
      'exec ps "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

/** What an injected observation recorded. */
export interface ObservationRecord {
  /** ps etime queries (answered by the shim, or not). */
  psQueries: number;
  /** etime queries that went to the real ps. */
  realEtimeReads: number;
  /** reads of the injected clock (bash lock_now_ms / a pinned `date +%s`, JS hooks.now). */
  clockReads: number;
  /** reads of the real clock through `date` (with the date shim on PATH; 0 without it). */
  realClockReads: number;
}

export interface PinnedObservation {
  /** Prefix PATH with this (the ps shim, the date shim, the slow ps in front when asked). */
  pathPrefix: string;
  env: Record<string, string>;
  /** bash: after the load — lock_now_ms replaced by the injected clock (empty when not pinned). */
  bashPre: string;
  /** JS: the injected clock, for hooks.now. */
  now: () => number;
  record: () => ObservationRecord;
}

/**
 * The fixed clock + ps shim of #4288 PR1a-f (impl-7 for owner-atomic, impl-10 made a harness function for
 * the other files and for PR1c's C1/C4/C5): the clock is `t0` plus `step` for every etime query so far — a
 * read before ps and the read after it differ by exactly `step` (0: a fast observation; 1500: a slow one,
 * ECLOCK) whatever the load of the machine; ps answers CM_OBS_ETIME ('00:00') for a live pid.
 *   - `date: true` also puts a `date` on PATH that answers `+%s` / `+%s%3N` from the same clock (a pinned
 *     date never moves: a wait on lock_now_sec must be driven, see drivenDrainClock) and counts every other
 *     clock read of date as a real one. Conversions (`-r`, `-j`, `-d`, `-f`) go to the real date, not counted.
 *   - `pin: false` keeps the shims as meters only (the real clock and the real etime, each read counted): the
 *     positive control of the meter — the form before the fix reads the real clock.
 *   - `slowPs: true` puts a ps that sleeps 1.2 s in front (closing condition (ii)).
 */
export function pinnedObservation(dir: string, o: { t0: number; step?: number; date?: boolean; pin?: boolean; slowPs?: boolean }): PinnedObservation {
  const pin = o.pin ?? true;
  const step = o.step ?? 0;
  const obs = fs.mkdtempSync(path.join(dir, 'obs-'));
  const count = path.join(obs, 'ps-count');
  const real = path.join(obs, 'ps-real');
  const reads = path.join(obs, 'clock-reads');
  const realClock = path.join(obs, 'clock-real');
  for (const f of [count, real, reads, realClock]) fs.writeFileSync(f, '');
  // The slow ps goes first on PATH and runs the next one — the ps shim, which runs the real ps.
  const slow = o.slowPs ? slowPsShim(obs) : null;
  const bin = psShim(obs);
  if (o.date) {
    const realDate = (spawnSync('sh', ['-c', 'command -v date'], { encoding: 'utf8' }).stdout ?? '').trim() || '/bin/date';
    fs.writeFileSync(
      path.join(bin, 'date'),
      [
        '#!/bin/sh',
        'for a in "$@"; do case "$a" in -r|-j|-d|-f|-r*|-d*) exec ' + realDate + ' "$@";; esac; done',
        'if [ -n "${CM_OBS_T0:-}" ]; then',
        '  case "$*" in',
        '    "+%s"|"+%s%3N")',
        '      printf x >> "$CM_OBS_CLOCK_READS"',
        '      n=$(wc -c < "$CM_OBS_COUNT")',
        '      ms=$(( CM_OBS_T0 + CM_OBS_STEP * n ))',
        '      if [ "$*" = "+%s" ]; then echo $(( ms / 1000 )); else echo "$ms"; fi',
        '      exit 0;;',
        '  esac',
        'fi',
        'if [ -n "${CM_OBS_REAL_CLOCK_LOG:-}" ]; then printf x >> "$CM_OBS_REAL_CLOCK_LOG"; fi',
        `exec ${realDate} "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }
  const size = (f: string): number => fs.statSync(f).size;
  const now = (): number => {
    fs.appendFileSync(reads, 'x');
    return o.t0 + step * size(count);
  };
  return {
    pathPrefix: slow ? `${slow}:${bin}` : bin,
    env: {
      CM_OBS_COUNT: count,
      CM_OBS_REAL_LOG: real,
      CM_OBS_CLOCK_READS: reads,
      CM_OBS_REAL_CLOCK_LOG: realClock,
      ...(pin ? { CM_OBS_ETIME: '00:00', CM_OBS_T0: String(o.t0), CM_OBS_STEP: String(step) } : {}),
    },
    bashPre: pin ? `lock_now_ms() { printf x >> '${reads}'; echo $(( ${o.t0} + ${step} * $(wc -c < '${count}') )); }\n` : '',
    now,
    record: () => ({ psQueries: size(count), realEtimeReads: size(real), clockReads: size(reads), realClockReads: size(realClock) }),
  };
}

/**
 * The drain's clock driven by the test (#4288 PR1a-f impl-10, A6 / D12): lock_now_sec moves 1 s per read
 * until the drain sends KILL, then stands still — the wait after KILL lasts until the group is seen empty, so
 * `drained` is decided by what the drain observes, not by how fast a loaded machine reaps. Every step of the
 * drain is written to CM_VERIFY_TEST_DRAIN_LOG (verify-run.sh's seam). Real clock reads of the drain: 0.
 */
export function drivenDrainClock(dir: string, epoch = 1_800_000_000): { bashPre: string; env: Record<string, string>; steps: () => string[]; reads: () => number } {
  const d = fs.mkdtempSync(path.join(dir, 'drain-'));
  const log = path.join(d, 'steps');
  const ticks = path.join(d, 'ticks');
  fs.writeFileSync(log, '');
  fs.writeFileSync(ticks, '');
  return {
    bashPre: `lock_now_sec() { grep -qx kill '${log}' 2>/dev/null || printf x >> '${ticks}'; echo $(( ${epoch} + $(wc -c < '${ticks}') )); }\n`,
    env: { CM_VERIFY_TEST_DRAIN_LOG: log },
    steps: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    reads: () => fs.statSync(ticks).size,
  };
}

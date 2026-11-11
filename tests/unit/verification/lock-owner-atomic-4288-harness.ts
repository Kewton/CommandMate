/**
 * The drivers of Issue #4288 PR1a-f's tables (tests/unit/verification/machine-lock-owner-atomic-4288.test.ts,
 * docs/design/machine-lock-owner-atomic-4288.md): one acquisition or D6 guard per implementation on a lock
 * set up in a form, its result read as the table's code (`acquired`, `refused:<wording>`, `removed`, `kept` …)
 * and the lock compared before / after.
 *
 *   - bash: scripts/lib/machine-lock.sh loaded under `set -u`; the graced callers and the guard with the
 *     key=value codec and LOCK_OWNERLESS_GRACE_MS=600000 (run-lock / supervisor.lock), the callers without
 *     a grace with the JSON owner (the verify gate); lock_now_ms in ms (perl), so a read around `ps` never
 *     crosses a whole second by chance (the test seam of design §4.1).
 *   - sync JS: acquireMachineLockSync / recoverIfDead with `lockPath` and `ownerlessGraceMs` 600000.
 *   - TS: acquireMachineLock (its logger is the caller's: the test file mocks it into LOGS).
 *
 * Every root is under os.tmpdir(); nothing under ~/.commandmate; no server, no tmux.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { acquireMachineLock } from '@/lib/verification/machine-lock';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { REPO, deadPid } from './lock-4288-harness';

export const LOADER = path.join(REPO, 'scripts/lib/machine-lock.sh');
export const HOST = os.hostname();
export const GRACE_MS = 600_000;
/** Old enough for both graces (10 min). */
export const OLD_MS = 700_000;

/** The TS implementation's warnings (the test file's vi.mock of @/lib/logger pushes here). */
export const LOGS: string[] = ((globalThis as { __pr1afLogs?: string[] }).__pr1afLogs ??= []);

export type Impl = 'bash' | 'sync' | 'ts';
export type Who = 'acquire-head-grace' | 'acquire-head-nograce' | 'acquire-behind' | 'guard-head' | 'guard-behind';

/** Processes a row started, killed in afterEach. */
export const children: ChildProcess[] = [];
export function killChildren(): void {
  for (const c of children.splice(0)) {
    for (const t of [c.pid ? -c.pid : 0, c.pid ?? 0]) {
      try {
        if (t) process.kill(t, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
}

/** A live process (its own group): `sleep 120`. */
export function liveSleep(): number {
  const c = spawn('sleep', ['120'], { stdio: 'ignore', detached: true });
  children.push(c);
  return c.pid as number;
}

export function lstartOf(pid: number, tz: string | null): string {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' };
  if (tz === null) delete env.TZ;
  else env.TZ = tz;
  return (spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env }).stdout ?? '').trim().replace(/\s+/g, ' ');
}

export const iso = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export function age(file: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}

/** A `ps` first on PATH that answers `-o etime=` for FAKE_ETIME_PID with FAKE_ETIME (else the real ps). */
export function psShim(dir: string): string {
  const real = (spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout ?? '').trim() || '/bin/ps';
  const bin = path.join(dir, 'shim-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'ps'),
    `#!/bin/sh\nlast=""\nfor a in "$@"; do last=$a; done\ncase " $* " in\n  *" etime= "*) if [ -n "\${FAKE_ETIME_PID:-}" ] && [ "$last" = "$FAKE_ETIME_PID" ]; then echo "$FAKE_ETIME"; exit 0; fi;;\nesac\nexec ${real} "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

export interface OwnerRecord {
  pid: number;
  token: string;
  host?: string;
  pgid?: number;
  lstart?: string;
  started_at?: string;
  v?: boolean;
}

/** The owner record in the caller's format: key=value for bash's graced callers, JSON otherwise. */
export function recordText(rec: OwnerRecord, kv: boolean): string {
  if (kv) {
    return [
      `pid=${rec.pid}`,
      `host=${rec.host ?? HOST}`,
      `token=${rec.token}`,
      ...(rec.started_at !== undefined ? [`started_at=${rec.started_at}`] : []),
      ...(rec.v ? ['v=1'] : []),
      ...(rec.lstart !== undefined ? [`lstart=${rec.lstart}`] : []),
      ...(rec.pgid !== undefined ? [`pgid=${rec.pgid}`] : []),
      '',
    ].join('\n');
  }
  return JSON.stringify({ pid: rec.pid, host: rec.host ?? HOST, token: rec.token, acquiredAt: 0, ...(rec.pgid !== undefined ? { pgid: rec.pgid } : {}), ...(rec.v ? { v: 1 } : {}) });
}

export const lockPathIn = (root: string): string => path.join(root, 'x.lock');
export const queueIn = (root: string): string => path.join(root, 'x.queue');

/** A live ticket of this process ahead in the queue (acquire-behind / guard-behind). */
export function ticketAhead(root: string): void {
  const q = queueIn(root);
  fs.mkdirSync(q, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(q, '000000000001'), JSON.stringify({ pid: process.pid, host: HOST, token: 'ahead', createdAt: now, deadline: now + 3_600_000 }));
}

/** The lock's contents, for "unchanged": the names, and the owner's text. */
export function snapshot(root: string): string {
  const lock = lockPathIn(root);
  if (!fs.existsSync(lock)) return '<absent>';
  const names = fs.readdirSync(lock).sort();
  let owner = '';
  try {
    owner = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
  } catch {
    owner = '<no owner>';
  }
  return `${names.join(',')}|${owner}`;
}

/** The lock is this acquisition's: an owner written by the new form (v=1, the tmp gone). */
export function isMine(root: string): boolean {
  const lock = lockPathIn(root);
  try {
    const text = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
    return (/"v":1/.test(text) || /^v=1$/m.test(text)) && fs.readdirSync(lock).every((n) => n === 'owner');
  } catch {
    return false;
  }
}

export interface Outcome {
  /** acquired / removed / kept / absent / restore-failed / not-head / retired …, or refused:<wording>. */
  code: string;
  log: string;
  heldBy: string | null;
  unknown: string | null;
  /** bash LHO_STAGE etc. */
  extra?: string;
}

/** The table's wording of a refusal, from what the implementation said (§2.2). */
export function wording(log: string, heldBy: string | null, unknown: string | null): string {
  // The acquisition's own create first: after a publish that met an owner, the owner read next may be corrupt too.
  if (/machine-lock-owner-exists /.test(log)) return 'owner-exists';
  if (/machine-lock-owner-not-ours /.test(log)) return 'not-ours';
  if (/machine-lock-owner-write-failed /.test(log)) return 'write-failed';
  if (/machine-lock-owner-corrupt /.test(log)) return 'corrupt';
  if (/machine-lock-ownerless-stray /.test(log)) return 'stray';
  if (/machine-lock-ownerless-old-taker /.test(log)) return 'old-taker';
  if (heldBy?.startsWith('queue ticket')) return 'queue';
  if (unknown) return 'unk';
  if (heldBy && (heldBy.startsWith('pid ') || heldBy.startsWith('restore pending'))) return 'rec';
  return 'taking';
}

export interface DriveOptions {
  /** `<point>=<ERRNO>` items (`<point>@<substring>=<ERRNO>`). */
  fault?: string;
  /** bash: lines run after the load and the codec, before the call (function overrides …). */
  bashPre?: string;
  env?: { [k: string]: string };
  /** sync / TS hooks merged into the call's. */
  hooks?: { [k: string]: unknown };
  /** sync: options merged into the call's. */
  syncOptions?: { [k: string]: unknown };
  /** bash: the reader's TZ. */
  tz?: string;
  /** Prefix PATH with this directory (a ps shim). */
  pathPrefix?: string;
  /** bash: the call itself (default: the acquisition, or the guard). */
  call?: string;
}

function faultFn(spec?: string): ((point: string, target: string) => string | undefined) | undefined {
  if (!spec) return undefined;
  const items = spec
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => {
      const [key, code] = item.split('=');
      const [point, sub] = key.split('@');
      return { point, sub, code };
    });
  return (point, target) => items.find((i) => i.point === point && (!i.sub || target.includes(i.sub)))?.code;
}

const BASH_ACQ = 'if lock_acquire_path "$LK" "$(machine_lock_queue_of "$LK")" 0; then echo acquired; else echo "refused $LOCK_HELD_BY"; fi\n';
const BASH_GUARD = 'lock_recover_only "$LK" "$(machine_lock_queue_of "$LK")" 0; echo "result $LRO_RESULT"; echo "unknown $LRO_UNKNOWN"\n';

/** The bash prelude: the loader under set -u, ms clock, codec and grace by caller. */
export function bashPrelude(who: Who): string {
  const kv = who !== 'acquire-head-nograce';
  return [
    'set -u',
    `. '${LOADER}' || { echo LOAD-FAILED; exit 3; }`,
    "lock_now_ms() { perl -MTime::HiRes=time -e 'printf(\"%d\\n\", time()*1000)'; }",
    kv ? 'machine_lock_use_kv_codec' : '',
    kv ? `LOCK_OWNERLESS_GRACE_MS=${GRACE_MS}` : '',
    '',
  ].join('\n');
}

export function bashEnv(root: string, o: DriveOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    LK: lockPathIn(root),
    CM_VERIFY_LOCK_ROOT: path.join(root, 'verify-root'),
    CM_VERIFY_TEST_OBS_FAULT: o.fault ?? '',
    CM_VERIFY_TEST_HANDOFF: '',
    CM_VERIFY_TEST_HANDOFF_DIR: '',
    MACHINE_LOCK_VERIFY_RUN: '',
    ...(o.tz ? { TZ: o.tz } : {}),
    ...(o.pathPrefix ? { PATH: `${o.pathPrefix}:${process.env.PATH}` } : {}),
    ...(o.env ?? {}),
  };
}

function bashOutcome(who: Who, out: string, err: string): Outcome {
  const lines = out.split('\n');
  if (who === 'guard-head' || who === 'guard-behind') {
    const result = lines.find((l) => l.startsWith('result '))?.slice('result '.length) ?? `?${out}`;
    const unknown = lines.find((l) => l.startsWith('unknown '))?.slice('unknown '.length) || null;
    return { code: result, log: err, heldBy: null, unknown };
  }
  const first = lines[0] ?? '';
  if (first === 'acquired') return { code: 'acquired', log: err, heldBy: null, unknown: null };
  const heldBy = first.startsWith('refused ') ? first.slice('refused '.length) || null : null;
  const unknown = /machine-lock-unknown (point=\S+ path=.* errno=\S+)/.exec(err)?.[1] ?? null;
  return { code: `refused:${wording(err, heldBy, unknown)}`, log: err, heldBy, unknown };
}

/** One call of `who` on the lock under `root`, synchronously (bash and sync) or not (TS). */
export async function drive(impl: Impl, who: Who, root: string, o: DriveOptions = {}): Promise<Outcome> {
  if (impl === 'bash') {
    const call = o.call ?? (who === 'guard-head' || who === 'guard-behind' ? BASH_GUARD : BASH_ACQ);
    const r = spawnSync('bash', ['-c', `${bashPrelude(who)}${o.bashPre ?? ''}\n${call}`], { encoding: 'utf8', timeout: 60000, env: bashEnv(root, o) });
    return bashOutcome(who, (r.stdout ?? '').trim(), r.stderr ?? '');
  }
  const fault = faultFn(o.fault);
  const lock = lockPathIn(root);
  if (impl === 'sync') {
    const warnings: string[] = [];
    const hooks = { ...(fault ? { fault } : {}), ...(o.hooks ?? {}) };
    const restore = withEnv(o);
    try {
      if (who === 'guard-head' || who === 'guard-behind') {
        const r = lockSync.recoverIfDead(lock, { timeoutMs: 0, ownerlessGraceMs: GRACE_MS, warn: (l: string) => warnings.push(l), hooks, ...(o.syncOptions ?? {}) });
        const u = r.unknown ? `point=${r.unknown.point} path=${r.unknown.path} errno=${r.unknown.code}` : null;
        return { code: r.result, log: warnings.join('\n'), heldBy: null, unknown: u };
      }
      const r = lockSync.acquireMachineLockSync('x', {
        lockPath: lock,
        timeoutMs: 0,
        pollMs: 20,
        warn: (l: string) => warnings.push(l),
        hooks,
        ...(who === 'acquire-head-nograce' ? {} : { ownerlessGraceMs: GRACE_MS }),
        ...(o.syncOptions ?? {}),
      });
      if (r.acquired) return { code: 'acquired', log: warnings.join('\n'), heldBy: null, unknown: null };
      const u = r.unknown ? `point=${r.unknown.point} path=${r.unknown.path} errno=${r.unknown.code}` : null;
      return { code: `refused:${wording(warnings.join('\n'), r.heldBy, u)}`, log: warnings.join('\n'), heldBy: r.heldBy, unknown: u };
    } catch (error) {
      const msg = (error as Error).message;
      const log = `${warnings.join('\n')}\n${msg}`;
      return { code: `refused:${wording(log, null, msg)}`, log, heldBy: null, unknown: msg };
    } finally {
      restore();
    }
  }
  LOGS.length = 0;
  const restore = withEnv(o);
  try {
    const r = await acquireMachineLock('x', { root, timeoutMs: 0, pollIntervalMs: 20, __testHooks: { ...(fault ? { fault } : {}), ...(o.hooks ?? {}) } });
    const log = LOGS.join('\n');
    if (r.acquired) return { code: 'acquired', log, heldBy: null, unknown: null };
    const u = r.unknown ? `point=${r.unknown.point} path=${r.unknown.path} errno=${r.unknown.code}` : null;
    return { code: `refused:${wording(log, r.heldBy, u)}`, log, heldBy: r.heldBy, unknown: u };
  } catch (error) {
    const msg = (error as Error).message;
    const log = `${LOGS.join('\n')}\n${msg}`;
    return { code: `refused:${wording(log, null, msg)}`, log, heldBy: null, unknown: msg };
  } finally {
    restore();
  }
}

/** The JS implementations read PATH (the ps shim) and the shim's variables from this process's env. */
function withEnv(o: DriveOptions): () => void {
  const keys = ['PATH', ...Object.keys(o.env ?? {})];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  if (o.pathPrefix) process.env.PATH = `${o.pathPrefix}:${saved.PATH}`;
  for (const [k, v] of Object.entries(o.env ?? {})) process.env[k] = v;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * bash with pauses (CM_VERIFY_TEST_HANDOFF=pause:<stage>…): at each stage reached, `at[stage]` runs and
 * the pause is let go. Resolves with the outcome when the call ends.
 */
export async function driveBashPaused(
  who: Who,
  root: string,
  at: { [stage: string]: () => void },
  o: DriveOptions = {},
): Promise<Outcome> {
  const dir = fs.mkdtempSync(path.join(root, 'pause-'));
  const call = o.call ?? (who === 'guard-head' || who === 'guard-behind' ? BASH_GUARD : BASH_ACQ);
  const child = spawn('bash', ['-c', `${bashPrelude(who)}${o.bashPre ?? ''}\n${call}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...bashEnv(root, o), CM_VERIFY_TEST_HANDOFF: Object.keys(at).map((s) => `pause:${s}`).join(','), CM_VERIFY_TEST_HANDOFF_DIR: dir },
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => (out += String(d)));
  child.stderr?.on('data', (d) => (err += String(d)));
  const done = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  const pending = new Set(Object.keys(at));
  let finished = false;
  void done.then(() => (finished = true));
  const end = Date.now() + 30000;
  while (!finished && Date.now() < end) {
    for (const stage of [...pending]) {
      if (fs.existsSync(path.join(dir, `${stage}.reached`))) {
        at[stage]();
        pending.delete(stage);
        fs.writeFileSync(path.join(dir, `${stage}.go`), '');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await done;
  return bashOutcome(who, out.trim(), err);
}

/** A pid that existed and has exited. */
export const dead = (): number => deadPid();

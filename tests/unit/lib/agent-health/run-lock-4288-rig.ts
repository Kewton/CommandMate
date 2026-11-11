/**
 * The rig behind tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts (Issue #4288 PR1b).
 *
 * One description of a record shape (design §2.1) is turned into the same files for the TS side (applied in
 * process, the caller being this process) and for the bash side (a shell snippet, the caller being `$$`). The
 * observations are real where they can be — a live process, a reaped one, a process group that leads itself —
 * and injected where they cannot: an EPERM at `kill -0` (CM_VERIFY_TEST_OBS_FAULT on the bash side, the `kill`
 * hook on the TS side), so pid and group are set apart on their own axes (design §4.8).
 *
 * Everything lives under os.tmpdir() and is removed by the caller.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(__dirname, '../../../..');
export const RUN_LOCK_SH = path.join(REPO, 'scripts/uat/run-lock.sh');

export type Obs = 'alive' | 'gone' | 'unknown';

export interface Procs {
  /** a live process that leads a group of its own (pgid = pid) */
  alive: number;
  /** a second one: its observations are injected as EPERM (unknown) */
  unknown: number;
  /** a pid (and pgid) that answers ESRCH */
  gone: number;
  stop(): void;
}

export function startProcs(): Procs {
  const children: ChildProcess[] = [];
  const leader = (): number => {
    const child = spawn('sleep', ['3600'], { detached: true, stdio: 'ignore' });
    child.unref();
    children.push(child);
    return child.pid!;
  };
  const alive = leader();
  const unknown = leader();
  const gone = spawnSync(process.execPath, ['-e', '']).pid!;
  return {
    alive,
    unknown,
    gone,
    stop() {
      for (const child of children) {
        try {
          process.kill(child.pid!, 'SIGKILL');
        } catch {
          // gone already
        }
      }
    },
  };
}

/** The caller's own pid: a number for the TS side, `$$` for the bash side. */
export type Self = number | '$$';

export type Op =
  | { op: 'owner'; dir: string; pid: number | '$$'; token: string; pgid?: number | '$$'; host?: string }
  | { op: 'raw-owner'; dir: string; text: string }
  | { op: 'mkdir'; dir: string }
  | { op: 'age'; dir: string }
  | { op: 'file'; path: string; text: string }
  | { op: 'ticket'; pid: number; token: string }
  | { op: 'rmrf'; path: string };

export interface FxCtx {
  lockDir: string;
  queueDir: string;
  procs: Procs;
  self: Self;
  /** the token a record "of the caller" carries (P shapes) */
  ownToken: string;
  /** G shapes: the caller's record carries `<ownToken>-g<pgid>` (D12 / D5 callers) instead of ownToken (inheritors) */
  g1: boolean;
  foreignToken: string;
}

export const recordHost = os.hostname();

const asideOf = (ctx: FxCtx, token: string): string => `${ctx.lockDir}.gone-${token}-1`;

/** The files that make a record shape (design §2.1) with the pid and G observations given. */
export function shapeOps(shape: string, pidObs: Obs, gObs: Obs | null, ctx: FxCtx): Op[] {
  const real = (obs: Obs): number => (obs === 'alive' ? ctx.procs.alive : obs === 'gone' ? ctx.procs.gone : ctx.procs.unknown);
  const pid = real(pidObs);
  const pgid = gObs === null ? undefined : real(gObs);
  const lock = ctx.lockDir;
  const own = ctx.ownToken;
  const ownG = pgid === undefined ? own : ctx.g1 ? `${own}-g${pgid}` : own;
  const foreign = ctx.foreignToken;
  switch (shape) {
    case 'none':
      return [];
    case 'ticket-ahead':
      return [{ op: 'ticket', pid, token: 'ahead' }];
    case 'ownerless-young':
      return [{ op: 'mkdir', dir: lock }];
    case 'ownerless-old':
      return [{ op: 'mkdir', dir: lock }, { op: 'age', dir: lock }];
    case 'ownerless-nonempty':
      return [{ op: 'mkdir', dir: lock }, { op: 'file', path: path.join(lock, 'owner.tmp.123'), text: 'pid=1\n' }, { op: 'age', dir: lock }];
    case 'unreadable':
      return [{ op: 'raw-owner', dir: lock, text: `pid=${ctx.procs.alive}\nhost=${recordHost}\ntoken=${foreign}\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\npgid=x\n` }];
    case 'corrupt':
      return [{ op: 'raw-owner', dir: lock, text: 'label=uat\nhost=' + recordHost + '\n' }];
    case 'own-self':
      return [{ op: 'owner', dir: lock, pid: ctx.self, token: own }];
    case 'own-other':
      return [{ op: 'owner', dir: lock, pid, token: own }];
    case 'foreign':
      return [{ op: 'owner', dir: lock, pid, token: foreign }];
    case 'aside-own':
      return [{ op: 'owner', dir: asideOf(ctx, own), pid, token: own }];
    case 'aside-foreign':
      return [{ op: 'owner', dir: asideOf(ctx, foreign), pid, token: foreign }];
    case 'own-self-g':
      return [{ op: 'owner', dir: lock, pid: ctx.self, token: ownG, pgid }];
    case 'own-other-g':
      return [{ op: 'owner', dir: lock, pid, token: ownG, pgid }];
    case 'foreign-g':
      return [{ op: 'owner', dir: lock, pid, token: foreign, pgid }];
    case 'aside-own-g':
      return [{ op: 'owner', dir: asideOf(ctx, ownG), pid, token: ownG, pgid }];
    case 'aside-foreign-g':
      return [{ op: 'owner', dir: asideOf(ctx, foreign), pid, token: foreign, pgid }];
    default:
      throw new Error(`no fixture for the shape ${shape}`);
  }
}

export interface Injection {
  pids: number[];
  groups: number[];
  faults: string[];
}

/** What cannot be real: an EPERM at the observation the row asks to be unknown, and the odd failures of the P shapes. */
export function injection(shape: string, pidObs: Obs, gObs: Obs | null, ctx: FxCtx): Injection {
  const inj: Injection = { pids: [], groups: [], faults: [] };
  if (pidObs === 'unknown') inj.pids.push(ctx.procs.unknown);
  if (gObs === 'unknown') inj.groups.push(ctx.procs.unknown);
  if (shape === 'none' && pidObs === 'unknown') inj.faults.push('mkdir-lock=EIO');
  if (shape === 'ownerless-old' && pidObs === 'unknown') inj.faults.push('ownerless-mtime=EIO');
  return inj;
}

/** `kill(target, 0)` for the TS side: EPERM where injected, the real answer elsewhere. */
export function killHook(inj: Injection): (target: number, signal: number) => void {
  return (target, signal) => {
    if (inj.pids.includes(target) || inj.groups.some((g) => -g === target)) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    process.kill(target, signal);
  };
}

/** `fault(point, target)` for the TS side. */
export function faultHook(inj: Injection): (point: string, target: string) => string | undefined {
  return (point) => inj.faults.map((f) => f.split('=')).find(([p]) => p === point)?.[1];
}

/** CM_VERIFY_TEST_OBS_FAULT for the bash side (`<point>@<target substring>=<errno>`). */
export function faultSpec(inj: Injection): string {
  return [...inj.pids.map((p) => `pid@${p}=EPERM`), ...inj.groups.map((g) => `group@${g}=EPERM`), ...inj.faults].join(' ');
}

const OWNER_TS = '2026-01-01T00:00:00Z';

/** The TS side applies the ops itself (self = process.pid). */
export function applyOps(ops: Op[], ctx: FxCtx): void {
  for (const op of ops) {
    switch (op.op) {
      case 'owner': {
        fs.mkdirSync(op.dir, { recursive: true });
        const lines = [`pid=${op.pid === '$$' ? process.pid : op.pid}`, `host=${op.host ?? recordHost}`, `token=${op.token}`, `started_at=${OWNER_TS}`, 'label=uat'];
        if (op.pgid !== undefined) lines.push(`pgid=${op.pgid === '$$' ? process.pid : op.pgid}`);
        fs.writeFileSync(path.join(op.dir, 'owner'), `${lines.join('\n')}\n`);
        break;
      }
      case 'raw-owner':
        fs.mkdirSync(op.dir, { recursive: true });
        fs.writeFileSync(path.join(op.dir, 'owner'), op.text);
        break;
      case 'mkdir':
        fs.mkdirSync(op.dir, { recursive: true });
        break;
      case 'age': {
        const old = new Date(Date.now() - 120_000);
        fs.utimesSync(op.dir, old, old);
        break;
      }
      case 'file':
        fs.writeFileSync(op.path, op.text);
        break;
      case 'ticket': {
        fs.mkdirSync(ctx.queueDir, { recursive: true });
        const now = Date.now();
        fs.writeFileSync(
          path.join(ctx.queueDir, '000000000001'),
          JSON.stringify({ pid: op.pid, host: recordHost, token: op.token, createdAt: now, deadline: now + 3_600_000 })
        );
        break;
      }
      case 'rmrf':
        fs.rmSync(op.path, { recursive: true, force: true });
        break;
    }
  }
}

/** The bash side: the same ops as shell lines (the caller is `$$`). */
export function opsToShell(ops: Op[], ctx: FxCtx): string {
  const lines: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'owner': {
        const pgid = op.pgid === undefined ? '' : `printf 'pgid=%s\\n' "${op.pgid === '$$' ? '$$' : op.pgid}"; `;
        lines.push(
          `mkdir -p '${op.dir}'; { printf 'pid=%s\\n' "${op.pid === '$$' ? '$$' : op.pid}"; printf 'host=%s\\n' '${op.host ?? recordHost}'; printf 'token=%s\\n' '${op.token}'; printf 'started_at=${OWNER_TS}\\nlabel=uat\\n'; ${pgid}} > '${op.dir}/owner'`
        );
        break;
      }
      case 'raw-owner':
        lines.push(`mkdir -p '${op.dir}'; printf '%s' '${op.text.replace(/'/g, `'\\''`)}' > '${op.dir}/owner'`);
        break;
      case 'mkdir':
        lines.push(`mkdir -p '${op.dir}'`);
        break;
      case 'age':
        lines.push(`touch -t 202601010000 '${op.dir}'`);
        break;
      case 'file':
        lines.push(`printf '%s' '${op.text}' > '${op.path}'`);
        break;
      case 'ticket':
        lines.push(
          `mkdir -p '${ctx.queueDir}'; printf '{"pid":%s,"host":"%s","token":"%s","createdAt":%s,"deadline":%s}\\n' '${op.pid}' '${recordHost}' '${op.token}' "$(( $(date +%s) * 1000 ))" "$(( ($(date +%s) + 3600) * 1000 ))" > '${ctx.queueDir}/000000000001'`
        );
        break;
      case 'rmrf':
        lines.push(`rm -rf '${op.path}'`);
        break;
    }
  }
  return lines.join('\n');
}

export interface Snap {
  lockExists: boolean;
  owner: string | null;
  asides: string[];
}

export function snapshot(ctx: FxCtx): Snap {
  const exists = fs.existsSync(ctx.lockDir);
  let owner: string | null = null;
  try {
    owner = fs.readFileSync(path.join(ctx.lockDir, 'owner'), 'utf8');
  } catch {
    owner = null;
  }
  const base = `${path.basename(ctx.lockDir)}.gone-`;
  const asides = fs
    .readdirSync(path.dirname(ctx.lockDir))
    .filter((name) => name.startsWith(base))
    .sort();
  return { lockExists: exists, owner, asides };
}

export interface BashResult {
  status: number | null;
  stdout: string;
  stderr: string;
  out: Record<string, string>;
}

/** Runs `script` in a fresh bash (the lock's callers must be the main shell) and reads its `OUT:key=value` lines. */
export function runBash(script: string, env: Record<string, string>): Promise<BashResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      const out: Record<string, string> = {};
      for (const line of stdout.split('\n')) {
        const match = line.match(/^OUT:([a-z0-9_-]+)=(.*)$/);
        if (match) out[match[1]] = match[2];
      }
      resolve({ status, stdout, stderr, out });
    });
  });
}

/** Runs the thunks `width` at a time (the bash rows are processes; they are independent). */
export async function pool<T>(thunks: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const results: T[] = new Array(thunks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= thunks.length) return;
      results[at] = await thunks[at]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, thunks.length) }, worker));
  return results;
}

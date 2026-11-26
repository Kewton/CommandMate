/**
 * The shared bench of the #4559 generation-chain tests (docs/design/machine-lock-generation-4559.md §8.1
 * T2–T6): fresh roots under os.tmpdir() (never ~/.commandmate), actors in their own processes
 * (tests/unit/verification/fixtures/lock-actor-4277.mjs, mode `gen`) stopped at the core's seams with
 * the counted pauses (`CM_VERIFY_TEST_HANDOFF=pause:<stage>#<n>`), and the oracles that read the actors'
 * events and the generations on disk: S1 (no two holdings at once) and S2 (no `end` on a live holder's
 * generation), counted apart.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';

export const REPO = path.resolve(__dirname, '../../..');
export const CORE = path.join(REPO, 'scripts/orchestrate/machine-lock-sync.mjs');
export const ACTOR = path.join(REPO, 'tests/unit/verification/fixtures/lock-actor-4277.mjs');
export const HOST = os.hostname();
export const LEGACY_DIR = path.join(REPO, 'tests/fixtures/machine-lock-legacy/690caa46a');

const roots: string[] = [];
const children: ChildProcess[] = [];

export function freshRoot(tag: string): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `lock-gen-${tag}-`));
  roots.push(r);
  return r;
}

export function cleanAll(): void {
  for (const c of children.splice(0)) {
    try {
      c.kill('SIGKILL');
    } catch {
      // gone already
    }
  }
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
}

/** The lock `x` of a root: its <lock>, queue and generation directory (given to every actor alike). */
export function lockOf(root: string): { root: string; lockPath: string; queue: string; genDir: string } {
  return { root, lockPath: path.join(root, 'x.lock'), queue: path.join(root, 'x.queue'), genDir: path.join(root, 'x.gen') };
}

let dead: number | null = null;
/** A pid that existed and has exited (reaped): kill -0 answers ESRCH. */
export function deadPid(): number {
  if (dead !== null) return dead;
  dead = Number(String(spawnSync('sh', ['-c', 'echo $$']).stdout).trim());
  return dead;
}

export const genDirName = (n: number): string => lockSync.genName(n);

/** Write generation n by hand: its owner (a record or none), and `end` when given. */
export function writeGen(genDir: string, n: number, o: { owner?: Record<string, unknown> | null; end?: string; mtimeAgoMs?: number; handoffs?: Record<string, unknown>[] }): string {
  const dir = path.join(genDir, lockSync.genName(n));
  fs.mkdirSync(dir, { recursive: true });
  if (o.owner) fs.writeFileSync(path.join(dir, 'owner'), JSON.stringify({ host: HOST, acquiredAt: 0, v: 1, g: n, ...o.owner }));
  (o.handoffs ?? []).forEach((h, i) => fs.writeFileSync(path.join(dir, `owner.h${i + 1}`), JSON.stringify({ host: HOST, acquiredAt: 0, v: 1, g: n, ...h })));
  if (o.end) fs.writeFileSync(path.join(dir, 'end'), `${o.end}\n`);
  if (o.mtimeAgoMs) {
    const t = new Date(Date.now() - o.mtimeAgoMs);
    fs.utimesSync(dir, t, t);
  }
  return dir;
}

/** The generations on disk: number → { records (owner, owner.h<k>), end text or null }. */
export function readGens(genDir: string): Map<number, { records: Record<string, unknown>[]; end: string | null }> {
  const out = new Map<number, { records: Record<string, unknown>[]; end: string | null }>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(genDir);
  } catch {
    return out;
  }
  for (const name of names.filter((e) => lockSync.GEN_PATTERN.test(e))) {
    const dir = path.join(genDir, name);
    const records: Record<string, unknown>[] = [];
    for (let k = 0; ; k++) {
      try {
        records.push(JSON.parse(fs.readFileSync(path.join(dir, k === 0 ? 'owner' : `owner.h${k}`), 'utf8')));
      } catch {
        break;
      }
    }
    let end: string | null = null;
    try {
      end = fs.readFileSync(path.join(dir, 'end'), 'utf8').trim();
    } catch {
      end = null;
    }
    out.set(Number(name.slice(1)), { records, end });
  }
  return out;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * S2's oracle, on disk: a generation whose `end` was written by someone other than its records' tokens
 * (a recoverer's `dead`) has no live record. Answers the generations that break it.
 */
export function s2Violations(genDir: string, isAlive: (pid: number) => boolean = alive): number[] {
  const bad: number[] = [];
  for (const [n, g] of readGens(genDir)) {
    if (!g.end) continue;
    const writer = g.end.split(' ')[1];
    const own = g.records.map((r) => r.token);
    if (own.includes(writer)) continue;
    if (g.records.some((r) => !r.tomb && typeof r.pid === 'number' && isAlive(r.pid))) bad.push(n);
  }
  return bad;
}

/**
 * #4559 r6 (review b P2-3): S2's oracle at the time of the write — a generation whose `end` was written by
 * someone other than its records' tokens, at a time (the `end` file's mtime: the tmp it was linked from, written
 * just before) inside the life of an actor whose record it holds (`span`: from its start to its `releasing`, its
 * kill or its exit). Unlike s2Violations it does not depend on who is alive when it is called: a call after every
 * actor has exited still sees an `end` written over a live holder. Answers the generations that break it.
 */
export function s2AtWrite(genDir: string, actors: Pick<Actor, 'span'>[]): number[] {
  const bad: number[] = [];
  for (const [n, g] of readGens(genDir)) {
    if (!g.end) continue;
    const writer = g.end.split(' ')[1];
    if (g.records.map((r) => r.token).includes(writer)) continue;
    const at = fs.statSync(path.join(genDir, lockSync.genName(n), 'end')).mtimeMs;
    const live = g.records.some((r) => {
      if (r.tomb) return false;
      const holder = actors.map((a) => a.span()).find((sp) => sp.pid === r.pid);
      return holder !== undefined && at >= holder.from && at < holder.to;
    });
    if (live) bad.push(n);
  }
  return bad;
}

export interface ActorEvent {
  event: string;
  t: number;
  pid: number;
  who: string;
  gen?: number | null;
  token?: string | null;
  result?: string;
}

/**
 * S1's oracle, from the events: the holdings `[acquired, released]` (an acquisition never released is open
 * to the end) never overlap. `open` names the actors still holding (paused or killed after the take).
 */
export function s1Violations(events: ActorEvent[], open: Record<string, number> = {}): string[] {
  const spans: { who: string; from: number; to: number }[] = [];
  const started = new Map<string, number>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.event === 'acquired') started.set(e.who, e.t);
    if (e.event === 'releasing' && started.has(e.who)) {
      spans.push({ who: e.who, from: started.get(e.who) as number, to: e.t });
      started.delete(e.who);
    }
  }
  for (const [who, from] of started) spans.push({ who, from, to: open[who] ?? Number.MAX_SAFE_INTEGER });
  const bad: string[] = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (a.from <= b.to && b.from <= a.to) bad.push(`${a.who}[${a.from},${a.to}] ∩ ${b.who}[${b.from},${b.to}]`);
    }
  }
  return bad;
}

export interface Actor {
  who: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  reached: (stage: string) => boolean;
  go: (stage: string) => void;
  events: () => ActorEvent[];
  /** #4559 r6: the test kills it now (the end of its life for S2's oracle, before the parent sees the exit). */
  kill: () => number;
  /** #4559 r6: when it was alive and could hold: from its start to its `releasing`, its kill or its exit. */
  span: () => { pid: number | undefined; from: number; to: number };
  /** #4559 r6: how many times it reached `stage` (the `seam` events; with `seams: true`). */
  seamCount: (stage: string) => number;
}

/**
 * An actor of the current core (or `module`, an older copy written out by legacyModule) in its own process:
 * takes `x` of `root`, holds `holdMs`, releases. `pauses` are `<stage>#<n>` names.
 */
export interface ActorOptions {
  pauses?: string[];
  holdMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  module?: string;
  handOff?: boolean;
  /** true: setOwnerFields({ phase: 'write' }); an object: that object */
  fields?: boolean | Record<string, unknown>;
  nowAheadMs?: number;
  /** #4559 r6: the record's own fields (merge-pr's `phase: 'idle'`) */
  ownerFields?: Record<string, unknown>;
  /** #4559 r6: log every seam reached (`seam` events) */
  seams?: boolean;
  /** #4559 r6: the lock's name (default `x`), and no hooks.genDir (the real entry chooses the chain) */
  name?: string;
  realChain?: boolean;
  /** #4559 r6: CM_VERIFY_LOCK_ROOT for the actor when it is not `root` (a lock outside the machine-lock root: by-path) */
  envRoot?: string;
  /** #4559 r6: a file the actor writes once its take (and fields / hand-off) are done */
  ready?: string;
}

export function startActor(root: string, who: string, o: ActorOptions = {}): Actor {
  const dir = fs.mkdtempSync(path.join(root, `actor-${who}-`));
  const events = path.join(dir, 'events.jsonl');
  const { genDir } = lockOf(root);
  const spec = { genDir: o.realChain ? undefined : genDir, handOff: o.handOff, fields: o.fields, nowAheadMs: o.nowAheadMs, ownerFields: o.ownerFields, seams: o.seams, ready: o.ready };
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [ACTOR, o.module ?? CORE, root, o.name ?? 'x', String(o.pollMs ?? 10), String(o.holdMs ?? 0), String(o.timeoutMs ?? 5000), events, 'gen', JSON.stringify(spec)],
    {
      env: { ...process.env, CM_VERIFY_LOCK_ROOT: o.envRoot ?? root, CM_VERIFY_TEST_HANDOFF: (o.pauses ?? []).map((p) => `pause:${p}`).join(','), CM_VERIFY_TEST_HANDOFF_DIR: dir },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  children.push(child);
  let exitedAt: number | null = null;
  let killedAt: number | null = null;
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      exitedAt = Date.now();
      resolve(code);
    })
  );
  const readEvents = (): ActorEvent[] => {
    let text = '';
    try {
      text = fs.readFileSync(events, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ ...(JSON.parse(l) as ActorEvent), who }));
  };
  return {
    who,
    child,
    exited,
    reached: (stage) => fs.existsSync(path.join(dir, `${stage}.reached`)),
    go: (stage) => fs.writeFileSync(path.join(dir, `${stage}.go`), ''),
    events: readEvents,
    kill: () => {
      killedAt = Date.now();
      child.kill('SIGKILL');
      return killedAt;
    },
    span: () => {
      const releasing = readEvents().find((e) => e.event === 'releasing');
      return { pid: child.pid, from: startedAt, to: releasing?.t ?? killedAt ?? exitedAt ?? Number.MAX_SAFE_INTEGER };
    },
    seamCount: (stage) => readEvents().filter((e) => e.event === 'seam' && (e as ActorEvent & { stage?: string }).stage === stage).length,
  };
}

/** Poll `cond` every 10 ms up to `limitMs`; true when it held. */
export async function until(cond: () => boolean, limitMs = 10000): Promise<boolean> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

/**
 * The develop copy of the sync JS before #4559 (tests/fixtures/machine-lock-legacy/<sha>/, kept as `.txt`
 * so lint and the type check do not read it): its sha256 checked against pin.json, written out under `root`
 * as `.mjs`, the path answered.
 */
export function legacyModule(root: string): string {
  const pin = JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, 'pin.json'), 'utf8')) as { files: Record<string, { sha256: string }> };
  const text = fs.readFileSync(path.join(LEGACY_DIR, 'machine-lock-sync.mjs.txt'));
  const sum = crypto.createHash('sha256').update(text).digest('hex');
  if (sum !== pin.files['machine-lock-sync.mjs.txt'].sha256) throw new Error(`legacy copy changed: ${sum}`);
  const dir = fs.mkdtempSync(path.join(root, 'legacy-'));
  const file = path.join(dir, 'machine-lock-sync.mjs');
  fs.writeFileSync(file, text);
  return file;
}

/** The legacy module loaded into this process (for the in-process successor U of #4559's report). */
export async function loadLegacy(root: string): Promise<typeof lockSync> {
  const file = legacyModule(root);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as typeof lockSync;
}

/**
 * #4559 r6 (review a P2-6): the develop copy of machine-lock.ts before #4559, written out as `.ts` under `root`
 * (its sha256 checked against pin.json) and loaded — the TS entry of the older version.
 */
export async function loadLegacyTs(root: string): Promise<typeof import('../../../src/lib/verification/machine-lock')> {
  const pin = JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, 'pin.json'), 'utf8')) as { files: Record<string, { sha256: string }> };
  const text = fs.readFileSync(path.join(LEGACY_DIR, 'machine-lock.ts.txt'));
  const sum = crypto.createHash('sha256').update(text).digest('hex');
  if (sum !== pin.files['machine-lock.ts.txt'].sha256) throw new Error(`legacy copy changed: ${sum}`);
  const dir = fs.mkdtempSync(path.join(root, 'legacy-ts-'));
  const file = path.join(dir, 'machine-lock.ts');
  fs.writeFileSync(file, text);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as typeof import('../../../src/lib/verification/machine-lock');
}

/**
 * T3's table (machine-lock-generation-seams-4559.test.ts): THE one source of the core's name-changing
 * operations, rendered into the design's §8.3.
 */
export interface OpRow {
  fn: string;
  op: string;
  count: number;
  /** the seam right before each of these operations, or '—' (an older step of the <lock>, kept for §6) */
  seam: string;
  /** what it does, and the model's step (design §7) where it is one */
  what: string;
  step: string;
}

/** THE table (one source). Rendered into the design's §8.3; compared with the scan of the core. */
export const OPS: OpRow[] = [
  { fn: 'makeObserver', op: 'fs.mkdirSync', count: 1, seam: '—', what: 'the observer of mkdir (every obs.mkdir)', step: '—' },
  { fn: 'makeObserver', op: 'fs.renameSync', count: 1, seam: '—', what: 'the observer of rename', step: '—' },
  { fn: 'makeObserver', op: 'fs.linkSync', count: 1, seam: '—', what: 'the observer of link', step: '—' },
  { fn: 'makeObserver', op: 'fs.unlinkSync', count: 1, seam: '—', what: 'the observer of unlink', step: '—' },
  { fn: 'makeObserver', op: 'fs.rmdirSync', count: 1, seam: '—', what: 'the observer of rmdir', step: '—' },
  { fn: 'rmQuiet', op: 'fs.rmSync', count: 1, seam: '—', what: 'the one clean-up delete', step: '—' },
  { fn: 'markDone', op: 'fs.renameSync', count: 1, seam: '—', what: 'a ticket marked used (§4.7)', step: '—' },
  { fn: 'markDone', op: 'rmQuiet', count: 1, seam: '—', what: 'its tmp', step: '—' },
  { fn: 'takeTicket', op: 'fs.mkdirSync', count: 1, seam: '—', what: 'the queue directory', step: '—' },
  { fn: 'takeTicket', op: 'rmQuiet', count: 1, seam: '—', what: 'the ticket tmp', step: '—' },
  { fn: 'collectGarbage', op: 'rmQuiet', count: 2, seam: '—', what: 'used tickets, old ticket tmps', step: '—' },
  { fn: 'claim', op: 'obs.mkdir', count: 1, seam: '—', what: 'the <lock> (beacon, §6.1)', step: '—' },
  { fn: 'publishOwner', op: 'obs.unlink', count: 1, seam: '—', what: 'the beacon owner\'s own tmp', step: '—' },
  { fn: 'publishOwner', op: 'obs.rmdir', count: 1, seam: '—', what: 'the own empty <lock>', step: '—' },
  { fn: 'publishOwner', op: 'obs.link', count: 1, seam: '—', what: 'the beacon owner', step: '—' },
  { fn: 'undoPublish', op: 'obs.unlink', count: 3, seam: '—', what: 'the undo (I2-b)', step: '—' },
  { fn: 'undoPublish', op: 'obs.rename', count: 1, seam: '—', what: 'the undo (I2-b)', step: '—' },
  { fn: 'undoPublish', op: 'obs.rmdir', count: 1, seam: '—', what: 'the undo (I2-b)', step: '—' },
  { fn: 'undoPublish', op: 'obs.link', count: 1, seam: '—', what: 'the undo (I2-b)', step: '—' },
  { fn: 'expireOwnerless', op: 'obs.unlink', count: 1, seam: '—', what: 'an owner-less <lock>\'s tmps (I3)', step: '—' },
  { fn: 'expireOwnerless', op: 'obs.rmdir', count: 1, seam: '—', what: 'an owner-less <lock> (D3)', step: '—' },
  { fn: 'reclaimEmptyOwner', op: 'obs.rename', count: 1, seam: '—', what: 'an empty owner aside (I4)', step: '—' },
  { fn: 'reclaimEmptyOwner', op: 'rmQuiet', count: 1, seam: '—', what: 'the own aside', step: '—' },
  { fn: 'rmdirQuiet', op: 'fs.rmdirSync', count: 1, seam: '—', what: 'an empty directory', step: '—' },
  { fn: 'moveOwnerIn', op: 'obs.link', count: 1, seam: '—', what: 'the put-back (§2.7)', step: '—' },
  { fn: 'moveOwnerIn', op: 'rmQuiet', count: 1, seam: '—', what: 'the aside after the put-back', step: '—' },
  { fn: 'moveOwnerIn', op: 'rmdirQuiet', count: 1, seam: '—', what: 'the put-back\'s own <lock>', step: '—' },
  { fn: 'restoreFromGone', op: 'obs.mkdir', count: 1, seam: '—', what: 'the put-back\'s <lock>', step: '—' },
  { fn: 'restoreFromGone', op: 'rmdirQuiet', count: 1, seam: '—', what: 'the put-back\'s own <lock>', step: '—' },
  { fn: 'reclaimGone', op: 'obs.rmdir', count: 1, seam: '—', what: 'a half put-back', step: '—' },
  { fn: 'reclaimGone', op: 'obs.rename', count: 1, seam: '—', what: 'an aside to the own name', step: '—' },
  { fn: 'reclaimGone', op: 'rmQuiet', count: 1, seam: '—', what: 'the own aside judged gone', step: '—' },
  { fn: 'settleGone', op: 'rmdirQuiet', count: 1, seam: '—', what: 'an empty aside', step: '—' },
  { fn: 'recoverLock', op: 'obs.rename', count: 1, seam: '—', what: 'an older holder\'s <lock> aside (P-4)', step: '—' },
  { fn: 'recoverLock', op: 'rmQuiet', count: 2, seam: '—', what: 'the own aside', step: '—' },
  { fn: 'recoverLock', op: 'obs.mkdir', count: 1, seam: '—', what: 'the put-back\'s <lock>', step: '—' },
  { fn: 'recoverLock', op: 'obs.link', count: 1, seam: '—', what: 'the put-back', step: '—' },
  { fn: 'recoverLock', op: 'rmdirQuiet', count: 1, seam: '—', what: 'the put-back\'s own <lock>', step: '—' },
  { fn: 'genDirOf', op: 'fs.mkdirSync', count: 1, seam: '—', what: 'the machine-lock root, as the acquisition makes it (C7-I2)', step: '—' },
  { fn: 'collectGens', op: 'rmQuiet', count: 2, seam: 'gc-rm・gc-tmp-rm', what: 'rm -rf g<k> (k < the largest listed, C1); an old tmp (C8)', step: 'g1' },
  { fn: 'linkIntoGen', op: 'obs.mkdir', count: 1, seam: 'gen-tmp-mkdir', what: 'the tmp directory', step: '—' },
  { fn: 'linkIntoGen', op: 'obs.link', count: 1, seam: '<use>-tmp', what: 'owner / owner.h<k> / tomb / end into g<N> (L4)', step: 'a3・h・j1・j2・r0・a4' },
  { fn: 'linkIntoGen', op: 'obs.unlink', count: 1, seam: '<use>-linked', what: 'the own tmp', step: '—' },
  { fn: 'takeGeneration', op: 'fs.mkdirSync', count: 1, seam: 'gen-parent-mkdir', what: 'the parent of .gen (by-path)', step: '—' },
  { fn: 'takeGeneration', op: 'obs.mkdir', count: 2, seam: 'gen-dir-mkdir・gen-mkdir', what: '.gen (C6); mkdir g<M+1>', step: 'a2' },
  { fn: 'machineLockAcquisition', op: 'rmQuiet', count: 2, seam: '—・beacon-release', what: 'an own tmp of setOwnerFields / handOff; the <lock> at the release (§6.1: before end)', step: 'r0' },
  { fn: 'machineLockAcquisition', op: 'fs.linkSync', count: 1, seam: '—', what: 'the ticket\'s link', step: '—' },
  { fn: 'machineLockAcquisition', op: 'fs.mkdirSync', count: 2, seam: '—', what: 'the root; the machine-lock root before the chain is chosen (C7-I2)', step: '—' },
  { fn: 'machineLockAcquisition', op: 'fs.renameSync', count: 2, seam: 'fields-rename・—', what: 'g<N>/fields; the beacon\'s copy of the fields', step: '—' },
  { fn: 'machineLockAcquisition', op: 'obs.rename', count: 1, seam: '—', what: 'the beacon\'s D4 hand-off (after owner.h<k>, §4.6)', step: '—' },
  { fn: 'asHead', op: 'fs.linkSync', count: 1, seam: '—', what: 'the ticket\'s link', step: '—' },
];

/** The table as the design's §8.3 holds it. */
export function renderOps(): string {
  const head = ['| 関数 | 操作 | 数 | 直前の継ぎ目 | 何を | 模型の歩 |', '|---|---|---|---|---|---|'];
  return [...head, ...OPS.map((r) => `| \`${r.fn}\` | \`${r.op}\` | ${r.count} | ${r.seam} | ${r.what.replace(/\|/g, '\\|')} | ${r.step} |`)].join('\n');
}


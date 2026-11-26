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
import ts from 'typescript';
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
 * just before) inside the life of an actor whose record it holds (`span`: from its start to its kill or its exit —
 * #4559 r7, review b2 P3-1: not cut at its `releasing`, for between its `releasing` and its own `end` the holder
 * lives and its generation has no `end`). Unlike s2Violations it does not depend on who is alive when it is called: a
 * call after every actor has exited still sees an `end` written over a live holder. Answers the generations that
 * break it.
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
      return holder !== undefined && at >= holder.from && at < (holder.life ?? holder.to);
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
  /** `to`: its `releasing`, kill or exit (S1's span); `life`: its kill or exit (S2's, b2 P3-1) */
  span: () => { pid: number | undefined; from: number; to: number; life?: number };
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
      return { pid: child.pid, from: startedAt, to: releasing?.t ?? killedAt ?? exitedAt ?? Number.MAX_SAFE_INTEGER, life: killedAt ?? exitedAt ?? Number.MAX_SAFE_INTEGER };
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
  { fn: 'makeRoot', op: 'obs.mkdir', count: 1, seam: '—', what: 'the machine-lock root (mkdir -p) before the chain is chosen, observed at gen-root-mkdir (C7-I2, r7)', step: '—' },
  { fn: 'collectGens', op: 'rmQuiet', count: 2, seam: 'gc-rm・gc-tmp-rm', what: 'rm -rf g<k> (k < the largest listed, C1); an old tmp (C8)', step: 'g1' },
  { fn: 'linkIntoGen', op: 'obs.mkdir', count: 1, seam: 'gen-tmp-mkdir', what: 'the tmp directory', step: '—' },
  { fn: 'linkIntoGen', op: 'obs.link', count: 1, seam: '<use>-tmp', what: 'owner / owner.h<k> / tomb / end into g<N> (L4)', step: 'a3・h・j1・j2・r0・a4' },
  { fn: 'linkIntoGen', op: 'obs.unlink', count: 1, seam: '<use>-linked', what: 'the own tmp', step: '—' },
  { fn: 'takeGeneration', op: 'obs.mkdir', count: 3, seam: 'gen-parent-mkdir・gen-dir-mkdir・gen-mkdir', what: 'the parent of .gen (by-path/, observed: r7); .gen (C6); mkdir g<M+1>', step: 'a2' },
  { fn: 'machineLockAcquisition', op: 'rmQuiet', count: 2, seam: '—・beacon-release', what: 'an own tmp of setOwnerFields / handOff; the <lock> at the release (§6.1: before end)', step: 'r0' },
  { fn: 'machineLockAcquisition', op: 'fs.linkSync', count: 1, seam: '—', what: 'the ticket\'s link', step: '—' },
  { fn: 'machineLockAcquisition', op: 'fs.mkdirSync', count: 1, seam: '—', what: 'the root of the lock', step: '—' },
  { fn: 'machineLockAcquisition', op: 'fs.renameSync', count: 2, seam: 'fields-rename・—', what: 'g<N>/fields; the beacon\'s copy of the fields', step: '—' },
  { fn: 'machineLockAcquisition', op: 'obs.rename', count: 1, seam: '—', what: 'the beacon\'s D4 hand-off (after owner.h<k>, §4.6)', step: '—' },
  { fn: 'asHead', op: 'fs.linkSync', count: 1, seam: '—', what: 'the ticket\'s link', step: '—' },
];

/** The table as the design's §8.3 holds it. */
export function renderOps(): string {
  const head = ['| 関数 | 操作 | 数 | 直前の継ぎ目 | 何を | 模型の歩 |', '|---|---|---|---|---|---|'];
  return [...head, ...OPS.map((r) => `| \`${r.fn}\` | \`${r.op}\` | ${r.count} | ${r.seam} | ${r.what.replace(/\|/g, '\\|')} | ${r.step} |`)].join('\n');
}



// ------------------------------------------------------------------ #4559 r7 §1 / r8 (2): the gate of the public functions

/**
 * #4559 r7 §1 (PM's disposition 1), made machine-decided in r8 (2) (review a3 P2-2 = b3 P2-1): the table of the
 * core's public functions × the observation points each one reaches × the reach of that point (1, 2, … in one run)
 * × the three values of an observation (resolved / absent / unknown) — never by hand:
 *
 * - the functions are read from the core's source (`coreExports` / `coreProcedures`, a parse of the source): every
 *   export in every form the language has — `export function`, `export async function`, `export function*`,
 *   `export const X = (…) =>`, `export const X = function`, `export default`, `export { … }` (an export of any other
 *   form throws: red) — that is a function whose calls reach an observation of the generation chain, and the methods
 *   of a holding's handle (`handle.<name>`)
 * - the points each function can reach are read from the same parse (`procedurePoints`): the observations of the
 *   chain's own functions (after its marker line) that its calls reach. A point of that set without a row of that
 *   function is red. The points of the #4288 functions before the marker are the observation table's
 *   (lock-observation-points-4288: every point × implementation injected); the gate checks each is a row of it
 * - a scenario of TABLE_SCENARIOS only prepares a run of its function so that the run reaches the points: the disk,
 *   and a fault that steers it into a branch (`base`). The rows are the points its resolved run reached, each reach k
 *   (1 … reached) run again with that reach alone answering ENOENT (absent) and EIO (unknown)
 *
 * The table is the one source: the gate (machine-lock-generation-seams-4559.test.ts) checks every row, and the
 * design's §8.4 is the table rendered, byte for byte.
 */

type FaultFn = (point: string, target: string, count?: number) => string | undefined;
type WarnFn = (line: string, data?: Record<string, unknown>) => void;
type Core = typeof lockSync;
export interface TableOutcome {
  outcome: string;
  /** the chain-dependent decision the function exists for was made (taken, released, removed, chosen …) */
  advanced: boolean;
}
/**
 * #4559 r9: the life of the holders a scenario names, decided by the test's seam (`hooks.pidAlive` / `hooks.groupAlive`)
 * and never by a real `kill -0` of a pid that has exited — that pid (or pgid) taken again by another process under a
 * heavy run read the holder alive, and a row's answer changed from run to run. `dead` is the pid (and pgid) the
 * scenario's dead records name: read dead (`deadReadAs: 'dead'`, the table) or alive (`'alive'`, the control that the
 * seam decides); `live` (the table's sleeper) is read alive. Any other pid / group (this process's own) is the real one.
 */
export interface Life {
  dead: number;
  pidAlive: (pid: number) => boolean;
  groupAlive: (pgid: number) => boolean;
}
export function lifeOf(live: number, dead: number, deadReadAs: 'dead' | 'alive' = 'dead'): Life {
  if (live === dead) throw new Error(`the live pid and the dead pid are one (${live})`);
  const judge = (id: number, real: (n: number) => boolean): boolean => (id === dead ? deadReadAs === 'alive' : id === live ? true : real(id));
  return { dead, pidAlive: (pid) => judge(pid, lockSync.pidAlive), groupAlive: (pgid) => judge(pgid, lockSync.groupAlive) };
}
/** The seam of a Life, as the core's hooks take it. */
const lifeHooks = (life: Life) => ({ pidAlive: life.pidAlive, groupAlive: life.groupAlive });

export interface TableScenario {
  /** r9: `dead` is the pid (and pgid) the dead records name — its life is the run's Life, not a real kill -0 */
  prepare: (root: string, live: number, dead: number) => void;
  /** `arm` turns the fault seam on (a handle's method: after its acquisition); `warn` collects the lines named; `life` (r9) the holders' life. */
  run: (m: Core, root: string, fault: FaultFn, arm: () => void, live: number, warn: WarnFn, life: Life) => TableOutcome;
  /** r8 (2): the preparation by a fault — these reaches answer `code` in every run of the scenario (a branch reached) */
  base?: { point: string; reach: number; code: string }[];
}

// ---------------------------------------------------------------- the parse of the core (r8 (2))

const MARKER = '// The generation chain (#4559';
const OBS_OPS = new Set(['pid', 'group', 'list', 'lstat', 'record', 'owner', 'text', 'realpath', 'mkdir', 'rename', 'rmdir', 'put', 'link', 'unlink', 'create']);

interface Unit {
  name: string;
  fn: ts.FunctionLikeDeclaration;
  parent: Unit | null;
  kind: 'decl' | 'handle' | 'observer';
  post: boolean;
  params: (string | null)[];
  points: Set<string>;
  paramPoints: Set<number>;
  refs: Set<Unit>;
  calls: { callee: Unit; args: (string | { param: number } | null)[] }[];
  unresolved: string[];
}
export interface CoreExport {
  name: string;
  /** the local name it exports (null: an anonymous default) */
  local: string | null;
  /** a function, as read from the source (an initializer that is not one is a value) */
  fn: boolean;
}
export interface CoreParse {
  exports: CoreExport[];
  /** the public functions (r7 §1): exported functions that reach the chain's observations, and the handle's methods */
  procedures: string[];
  /** the points each public function can reach (the chain's own functions' observations its calls reach) */
  points: Map<string, Set<string>>;
  /** the points the #4288 functions before the marker observe (the observation table's rows) */
  olderPoints: Set<string>;
  /** the observations whose point is not a literal, a parameter or GEN_WRITES' (`<function>: <argument>`) */
  unresolved: string[];
}

const unwrapExpr = (e: ts.Expression | undefined): ts.Expression | undefined => {
  let x = e;
  while (x && ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
};
const fnOf = (e: ts.Expression | undefined): ts.FunctionLikeDeclaration | null => {
  const x = unwrapExpr(e);
  return x && (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) ? x : null;
};
const hasMod = (node: ts.Node, kind: ts.SyntaxKind): boolean => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).some((m) => m.kind === kind) : false);
const isObs = (e: ts.Expression): boolean => (ts.isIdentifier(e) && e.text === 'obs') || (ts.isPropertyAccessExpression(e) && e.name.text === 'obs');
const isHooks = (e: ts.Expression): boolean => (ts.isIdentifier(e) && e.text === 'hooks') || (ts.isPropertyAccessExpression(e) && e.name.text === 'hooks');

/**
 * The parse of the core (r8 (2)): its exports, its public functions and the points each can reach. Throws when a
 * part it reads is not there or has a form it cannot read (never an empty answer).
 */
export function parseCore(source: string): CoreParse {
  const markerAt = source.indexOf(MARKER);
  if (markerAt < 0) throw new Error('the generation chain\'s marker line is not in the core');
  const sf = ts.createSourceFile('core.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const units: Unit[] = [];
  const fnNodes = new Map<ts.Node, Unit>();
  const add = (name: string, fn: ts.FunctionLikeDeclaration, parent: Unit | null, kind: Unit['kind']): Unit => {
    const u: Unit = {
      name,
      fn,
      parent,
      kind,
      post: fn.getStart(sf) > markerAt,
      params: fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null)),
      points: new Set(),
      paramPoints: new Set(),
      refs: new Set(),
      calls: [],
      unresolved: [],
    };
    units.push(u);
    fnNodes.set(fn, u);
    return u;
  };
  const visit = (node: ts.Node, parent: Unit | null): void => {
    let u: Unit | null = null;
    if (ts.isFunctionDeclaration(node) && node.body) u = add(node.name?.text ?? 'default', node, parent, 'decl');
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && fnOf(node.initializer)) u = add(node.name.text, fnOf(node.initializer) as ts.FunctionLikeDeclaration, parent, 'decl');
    else if (ts.isExportAssignment(node) && fnOf(node.expression)) u = add('default', fnOf(node.expression) as ts.FunctionLikeDeclaration, parent, 'decl');
    else if (parent?.name === 'holding' && ts.isPropertyAssignment(node) && fnOf(node.initializer) && ts.isObjectLiteralExpression(node.parent) && ts.isReturnStatement(node.parent.parent)) {
      u = add(`handle.${node.name.getText(sf)}`, fnOf(node.initializer) as ts.FunctionLikeDeclaration, parent, 'handle');
    } else if (parent?.name === 'makeObserver' && ts.isObjectLiteralExpression(node.parent) && ts.isReturnStatement(node.parent.parent)) {
      if (ts.isMethodDeclaration(node)) u = add(`obs.${node.name.getText(sf)}`, node, parent, 'observer');
      else if (ts.isPropertyAssignment(node) && fnOf(node.initializer)) u = add(`obs.${node.name.getText(sf)}`, fnOf(node.initializer) as ts.FunctionLikeDeclaration, parent, 'observer');
    }
    if (u) {
      ts.forEachChild(u.fn, (c) => visit(c, u));
      return;
    }
    ts.forEachChild(node, (c) => visit(c, parent));
  };
  visit(sf, null);
  // the scopes: a function declared in a function (or at the top) is seen there and below
  const scopes = new Map<Unit | null, Map<string, Unit>>();
  for (const u of units) {
    if (u.kind !== 'decl') continue;
    const s = scopes.get(u.parent) ?? new Map<string, Unit>();
    scopes.set(u.parent, s);
    if (s.has(u.name)) throw new Error(`two functions named ${u.name} in one scope: the parse cannot tell them apart`);
    s.set(u.name, u);
  }
  const resolve = (from: Unit, name: string): Unit | null => {
    for (let s: Unit | null = from; ; s = s.parent) {
      const hit = scopes.get(s)?.get(name);
      if (hit) return hit;
      if (s === null) return null;
    }
  };
  // GEN_WRITES: each use's put and link points
  const genWrites = new Map<string, string[]>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== 'GEN_WRITES' || !d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue;
      for (const p of d.initializer.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer)) throw new Error('a row of GEN_WRITES the parse cannot read');
        const vals: string[] = [];
        for (const q of p.initializer.properties) {
          if (ts.isPropertyAssignment(q) && ['put', 'link'].includes(q.name.getText(sf)) && ts.isStringLiteral(q.initializer)) vals.push(q.initializer.text);
        }
        if (vals.length !== 2) throw new Error(`GEN_WRITES.${p.name.getText(sf)} has no put / link the parse can read`);
        genWrites.set(p.name.getText(sf), vals);
      }
    }
  }
  if (genWrites.size === 0) throw new Error('GEN_WRITES is not in the core');
  // the observer's own points under one operation (put → gen-tmp-write, create → owner-write …)
  const opPoints = new Map<string, string[]>();
  const observerUnits = units.filter((u) => u.kind === 'observer');
  if (observerUnits.length === 0) throw new Error('the observer\'s operations (makeObserver) are not in the core');
  for (const u of observerUnits) {
    const found: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'attempt' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
      ts.forEachChild(node, walk);
    };
    walk(u.fn);
    opPoints.set(u.name.slice('obs.'.length), found);
  }
  // each unit's own body (the functions in it are units of their own)
  for (const u of units) {
    if (u.kind === 'observer' || u.name === 'makeObserver') continue;
    const argOf = (a: ts.Expression): string | { param: number } | null => (ts.isStringLiteral(a) ? a.text : ts.isIdentifier(a) && u.params.includes(a.text) ? { param: u.params.indexOf(a.text) } : null);
    const walk = (node: ts.Node): void => {
      if (node !== u.fn && fnNodes.has(node)) return;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const op = callee.name.text;
        const observes = (OBS_OPS.has(op) && isObs(callee.expression)) || (op === 'fault' && isHooks(callee.expression));
        if (observes) {
          const arg = node.arguments[0];
          const a = arg ? argOf(arg) : null;
          if (typeof a === 'string') u.points.add(a);
          else if (a) u.paramPoints.add(a.param);
          else u.unresolved.push(`${u.name}: ${arg ? arg.getText(sf) : '(none)'}`);
          for (const p of opPoints.get(op) ?? []) u.points.add(p);
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = resolve(u, node.expression.text);
        if (callee) u.calls.push({ callee, args: node.arguments.map(argOf) });
      }
      if (ts.isIdentifier(node)) {
        const p = node.parent;
        const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isMethodDeclaration(p)) && p.name === node);
        const ref = isName ? null : resolve(u, node.text);
        if (ref && ref !== u) u.refs.add(ref);
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'GEN_WRITES') {
        const vals = genWrites.get(node.name.text);
        if (!vals) throw new Error(`GEN_WRITES.${node.name.text} is not a row of GEN_WRITES`);
        for (const v of vals) u.points.add(v);
      }
      ts.forEachChild(node, walk);
    };
    walk(u.fn);
  }
  // a point given as an argument is the caller's (to a fixed point: a parameter passed on is the caller's parameter)
  for (let changed = true; changed; ) {
    changed = false;
    for (const u of units) {
      for (const { callee, args } of u.calls) {
        for (const i of callee.paramPoints) {
          const a = args[i];
          if (typeof a === 'string' && !u.points.has(a)) {
            u.points.add(a);
            changed = true;
          } else if (a && typeof a !== 'string' && !u.paramPoints.has(a.param)) {
            u.paramPoints.add(a.param);
            changed = true;
          }
        }
      }
    }
  }
  const reachOf = (start: Unit): Set<string> => {
    const seen = new Set<Unit>();
    const out = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const v = stack.pop() as Unit;
      if (seen.has(v)) continue;
      seen.add(v);
      if (v.post) for (const p of v.points) out.add(p);
      stack.push(...v.refs);
    }
    return out;
  };
  // the exports, in every form (a form not read here throws)
  const top = scopes.get(null) ?? new Map<string, Unit>();
  const exports: CoreExport[] = [];
  for (const st of sf.statements) {
    const exported = hasMod(st, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasMod(st, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(st) && exported) exports.push({ name: isDefault ? 'default' : (st.name?.text ?? 'default'), local: st.name?.text ?? 'default', fn: true });
    else if (ts.isVariableStatement(st) && exported) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) throw new Error(`an export the gate cannot read: ${st.getText(sf).split('\n')[0]}`);
        exports.push({ name: d.name.text, local: d.name.text, fn: fnOf(d.initializer) !== null });
      }
    } else if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier || !st.exportClause || !ts.isNamedExports(st.exportClause)) throw new Error(`an export the gate cannot read: ${st.getText(sf).split('\n')[0]}`);
      for (const el of st.exportClause.elements) {
        const local = (el.propertyName ?? el.name).getText(sf);
        exports.push({ name: el.name.getText(sf), local, fn: top.has(local) });
      }
    } else if (ts.isExportAssignment(st)) {
      const e = unwrapExpr(st.expression);
      const local = e && ts.isIdentifier(e) ? e.text : fnOf(e) ? 'default' : null;
      exports.push({ name: 'default', local, fn: local !== null && top.has(local) });
    } else if (exported) throw new Error(`an export the gate cannot read: ${st.getText(sf).split('\n')[0]}`);
  }
  const points = new Map<string, Set<string>>();
  for (const e of exports) {
    const u = e.fn && e.local ? top.get(e.local) : undefined;
    if (!u) continue;
    const reach = reachOf(u);
    if (reach.size > 0) points.set(e.name, reach);
  }
  const handle = units.filter((u) => u.kind === 'handle');
  if (handle.length === 0) throw new Error('the handle of a holding (function holding) is not in the core');
  for (const u of handle) points.set(u.name, reachOf(u));
  const olderPoints = new Set<string>();
  for (const u of units) if (!u.post && u.kind === 'decl') for (const p of u.points) olderPoints.add(p);
  if (points.size === 0) throw new Error('no public function reaches an observation of the chain');
  return { exports, procedures: [...points.keys()].sort(), points, olderPoints, unresolved: units.flatMap((u) => u.unresolved) };
}

/** The public functions of the core (r7 §1, r8 (2)): read from its parse (`parseCore`). */
export const coreProcedures = (source: string): string[] => parseCore(source).procedures;

/**
 * The observation points of the generation chain the core names (literal): `obs.<op>('<point>'`, the GEN_WRITES
 * table's put / link and listGens' — the points of the chain's own functions (after its marker line), apart from
 * the <lock>'s older points (#4288's), which are the observation table's rows.
 */
export function chainPoints(source: string, older: Set<string>): string[] {
  const start = source.indexOf(MARKER);
  if (start < 0) throw new Error('the generation chain\'s marker line is not in the core');
  const part = source.slice(start);
  const names = new Set<string>();
  for (const m of part.matchAll(/\bobs\.(?:pid|group|list|lstat|record|owner|text|realpath|mkdir|rename|rmdir|put|link|unlink)\('([a-z0-9-]+)'/g)) names.add(m[1]);
  for (const m of part.matchAll(/\b(?:put|link): '([a-z0-9-]+)'/g)) names.add(m[1]);
  for (const m of part.matchAll(/\blistGens\(g, '([a-z0-9-]+)'\)/g)) names.add(m[1]);
  return [...names].filter((n) => !older.has(n)).sort();
}

// ---------------------------------------------------------------- the runs

/** What is on disk for the chain of `x` in `root`: the generations (records, end) and the <lock>'s owner token. */
interface ChainState {
  gens: Map<number, { records: number; end: string | null }>;
  lock: string;
  byPath: number;
}
const KNOWN_TOKEN = /^[A-Z][A-Z0-9]*$/;
function chainState(root: string): ChainState {
  const { lockPath, genDir } = lockOf(root);
  const gens = new Map([...readGens(genDir)].map(([n, g]) => [n, { records: g.records.length, end: g.end === null ? null : g.end.split(' ')[0] }]));
  let lock = 'none';
  if (fs.existsSync(lockPath)) {
    try {
      const token = String(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).token);
      lock = KNOWN_TOKEN.test(token) ? token : 'new';
    } catch {
      // an empty <lock> (a claim before its owner, an undo's): nobody holds it
      lock = 'none';
    }
  }
  let byPath = 0;
  try {
    byPath = fs.readdirSync(path.join(root, 'by-path')).filter((e) => e.endsWith('.gen')).length;
  } catch {
    byPath = 0;
  }
  return { gens, lock, byPath };
}
/** The changes from `pre` to `now`, as names (`g1 end dead`, `new gen`, `new gen open`, `lock T gone`, `lock new put` …). */
function chainChanges(pre: ChainState, now: ChainState): string[] {
  const out = new Set<string>();
  for (const [n, g] of now.gens) {
    const was = pre.gens.get(n);
    if (!was) {
      out.add('new gen');
      if (g.end === null) out.add('new gen open');
      continue;
    }
    if (g.end !== was.end) out.add(`g${n} end ${g.end}`);
    if (g.records !== was.records) out.add(`g${n} records +${g.records - was.records}`);
  }
  for (const n of pre.gens.keys()) if (!now.gens.has(n)) out.add(`g${n} gone`);
  // the <lock>'s owner as two facts: the one there before is gone, another is put (an own claim undone is no change)
  if (now.lock !== pre.lock && pre.lock !== 'none') out.add(`lock ${pre.lock} gone`);
  if (now.lock !== pre.lock && now.lock !== 'none') out.add(`lock ${now.lock} put`);
  if (now.byPath > pre.byPath) out.add('new by-path chain');
  return [...out].sort();
}

export interface CellRun extends TableOutcome {
  hits: Map<string, number>;
  /** r8 (2): the reach `plan` names was reached (its fault answered) */
  fired: boolean;
  /** the changes on disk at each reach `<point>#<k>` (before its operation) — the resolved run's only */
  changesAt: Map<string, string[]>;
  changes: string[];
  /** r8 (4): the lines the run named (warn's line and data) and the message of what it threw */
  warns: string[];
  error: string | null;
}

/** One run of a scenario with `plan` (null: every observation resolved as the filesystem answers, past `base`). */
export function runCell(m: Core, scenario: TableScenario, live: number, plan: { point: string; k: number; code: string } | null, life: Life = lifeOf(live, deadPid())): CellRun {
  const root = freshRoot('r8-table');
  scenario.prepare(root, live, life.dead);
  let armed = false;
  let fired = false;
  let pre: ChainState = chainState(root);
  const hits = new Map<string, number>();
  const changesAt = new Map<string, string[]>();
  const warns: string[] = [];
  const fault: FaultFn = (point) => {
    if (!armed) return undefined;
    const k = (hits.get(point) ?? 0) + 1;
    hits.set(point, k);
    if (plan === null) changesAt.set(`${point}#${k}`, chainChanges(pre, chainState(root)));
    const base = scenario.base?.find((b) => b.point === point && b.reach === k);
    if (plan !== null && plan.point === point && plan.k === k) {
      fired = true;
      return plan.code;
    }
    return base?.code;
  };
  const arm = (): void => {
    pre = chainState(root);
    armed = true;
  };
  const warn: WarnFn = (line, data) => void warns.push(data ? `${line} ${JSON.stringify(data)}` : line);
  const was = process.env.CM_VERIFY_LOCK_ROOT;
  process.env.CM_VERIFY_LOCK_ROOT = root;
  let out: TableOutcome;
  let error: string | null = null;
  try {
    out = scenario.run(m, root, fault, arm, live, warn, life);
  } catch (err) {
    error = (err as Error).message ?? String(err);
    out = { outcome: `throws ${(err as NodeJS.ErrnoException).code ?? 'an error'}`, advanced: false };
  } finally {
    armed = false;
    process.env.CM_VERIFY_LOCK_ROOT = was;
  }
  return { ...out, hits, fired, changesAt, changes: chainChanges(pre, chainState(root)), warns, error };
}

const AHEAD = 11 * 60_000;
const aheadHooks = (fault: FaultFn, life: Life) => ({ fault, now: () => Date.now() + AHEAD, startOf: () => 0, ...lifeHooks(life) });
const unknownOf = (u?: { point: string; code: string }): string => (u ? ` (${u.point} ${u.code})` : '');
const takeOutcome = (r: { acquired: boolean; unknown?: { point: string; code: string } }): TableOutcome => ({
  outcome: r.acquired ? 'acquired' : `not acquired${unknownOf(r.unknown)}`,
  advanced: r.acquired,
});
function writeBeacon(lockPath: string, record: Record<string, unknown>): void {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ host: HOST, acquiredAt: 0, v: 1, ...record }));
}
const OLD = 20 * 60_000;
const PREPARE: Record<string, TableScenario['prepare']> = {
  fresh: () => {},
  'dead-holder': (root, _live, dead) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: dead, token: 'D' } });
    writeBeacon(lockPath, { pid: dead, token: 'D', g: 1 });
  },
  'ownerless-old': (root) => void writeGen(lockOf(root).genDir, 1, { owner: null, mtimeAgoMs: OLD }),
  'dead-group-holder': (root, _live, dead) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: dead, pgid: dead, token: 'D' } });
    writeBeacon(lockPath, { pid: dead, pgid: dead, token: 'D', g: 1 });
  },
  'ended-old-tmp': (root, _live, dead) => {
    const { genDir } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: dead, token: 'Y' }, end: 'released Y' });
    writeGen(genDir, 2, { owner: { pid: dead, token: 'Z' }, end: 'released Z' });
    fs.mkdirSync(`${genDir}.tmp`, { recursive: true });
    const tmp = path.join(`${genDir}.tmp`, 'W.g000000000009.owner.1');
    fs.writeFileSync(tmp, '{}');
    const t = new Date(Date.now() - OLD);
    fs.utimesSync(tmp, t, t);
  },
  // a holding whose records are all dead, its <lock> showing it (g=1)
  'dead-holding': (root, _live, dead) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: dead, token: 'T' } });
    writeBeacon(lockPath, { pid: dead, token: 'T', g: 1 });
  },
  // r8 (2): the same, its generation made long ago (an owner read as missing is past the grace: the tomb's branch)
  'dead-holding-old': (root, _live, dead) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: dead, token: 'T' }, mtimeAgoMs: OLD });
    writeBeacon(lockPath, { pid: dead, token: 'T', g: 1 });
  },
  // r8 (2): a holding whose records name a dead group (the generation's holder-group)
  'dead-group-holding': (root, _live, dead) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: dead, pgid: dead, token: 'T' } });
    writeBeacon(lockPath, { pid: dead, pgid: dead, token: 'T', g: 1 });
  },
  // a2 P2-1: A → B → C; C (the <lock>'s record) dead, B's group alive
  'live-handoff': (root, live, dead) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: dead, token: 'T' }, handoffs: [{ pid: live, pgid: live, token: 'HB' }, { pid: dead, token: 'HC' }] });
    writeBeacon(lockPath, { pid: dead, token: 'HC', g: 1 });
  },
  // a2 P2-2 / b2 P2-1: the first owner alive (another process), its hand-off dead (the <lock>'s record)
  'first-alive': (root, live, dead) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: live, token: 'T' }, handoffs: [{ pid: dead, token: 'HB' }] });
    writeBeacon(lockPath, { pid: dead, token: 'HB', g: 1 });
  },
  'by-path': (root) => fs.mkdirSync(path.join(root, 'other'), { recursive: true }),
  // r8 (4): a generation's holder (D) and a <lock> of another record (L, an older version's): which one a read names
  'gen-and-lock': (root, _live, dead) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: dead, token: 'D' } });
    writeBeacon(lockPath, { pid: dead, token: 'L' });
  },
};
const scenario = (prepare: string, run: TableScenario['run'], base?: TableScenario['base']): TableScenario => ({ prepare: PREPARE[prepare], run, ...(base ? { base } : {}) });
const take = (m: Core, root: string, fault: FaultFn, warn: WarnFn, life: Life) => m.acquireMachineLockSync('x', { root, timeoutMs: 0, pollMs: 10, warn, hooks: aheadHooks(fault, life) });
const steps = (m: Core, root: string, fault: FaultFn, warn: WarnFn, life: Life) => {
  const it = m.machineLockAcquisition('x', { root, timeoutMs: 0, pollMs: 10, warn, hooks: aheadHooks(fault, life) });
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
  }
};
/** A holding taken with the seam off, then `arm`ed for the handle's method. */
const held = (m: Core, root: string, fault: FaultFn, arm: () => void, warn: WarnFn, life: Life, before?: (r: ReturnType<Core['acquireMachineLockSync']>) => void) => {
  const r = take(m, root, fault, warn, life);
  if (!r.acquired) throw Object.assign(new Error('the scenario\'s take failed'), { code: 'SCENARIO' });
  before?.(r);
  arm();
  return r;
};
const asHeadOutcome = (r: { result: string; unknown?: { point: string; code: string } }, advancing: string): TableOutcome => ({
  outcome: `${r.result}${unknownOf(r.unknown)}`,
  advanced: r.result === advancing,
});
const genDirOutcome = (root: string, dir: string): TableOutcome => ({ outcome: `chain ${path.relative(root, dir).replace(/by-path\/[0-9a-f]{32}/, 'by-path/<hash>')}`, advanced: true });
const releaseOutcome = (result: string): TableOutcome => ({ outcome: result, advanced: result === 'released' });
const holderText = (h: { token?: string; g?: number } | null): string => (h ? `${h.token}${h.g ? ` g=${h.g}` : ''}` : 'null');
/**
 * r8 (4) (b3 P3-1): readHolder's decision is the generation's holder (D) — never named from a chain it could not read:
 * genOnly answers null then, the other read the <lock>'s owner (L).
 */
const readHolderRun = (genOnly: boolean) => (m: Core, root: string, fault: FaultFn, arm: () => void, _live: number, warn: WarnFn): TableOutcome => {
  arm();
  const read = m.readHolder as (p: string, o: unknown) => { token?: string; g?: number } | null;
  const h = read(lockOf(root).lockPath, { genOnly, warn, hooks: { fault } });
  return { outcome: `holder ${holderText(h)}`, advanced: h?.token === 'D' };
};
const D5 = (tokens: string[]) => (m: Core, root: string, fault: FaultFn, arm: () => void, _live: number, warn: WarnFn, life: Life): TableOutcome => (arm(), asHeadOutcome(m.releaseAsHead(lockOf(root).lockPath, tokens, { timeoutMs: 0, warn, hooks: { fault, ...lifeHooks(life) } }), 'released'));
const D6 = (m: Core, root: string, fault: FaultFn, arm: () => void, _live: number, warn: WarnFn, life: Life): TableOutcome => (arm(), asHeadOutcome(m.recoverIfDead(lockOf(root).lockPath, { timeoutMs: 0, warn, hooks: { fault, ...lifeHooks(life) } }), 'removed'));
const TAKE = (m: Core, root: string, fault: FaultFn, arm: () => void, _live: number, warn: WarnFn, life: Life): TableOutcome => (arm(), takeOutcome(take(m, root, fault, warn, life)));
const STEPS = (m: Core, root: string, fault: FaultFn, arm: () => void, _live: number, warn: WarnFn, life: Life): TableOutcome => (arm(), takeOutcome(steps(m, root, fault, warn, life)));
/** r8 (2): the end's link answering ENOENT once (its tmp cleaned by age meanwhile): the branch that asks whether the generation is over. */
const END_CLEANED = [{ point: 'end-link', reach: 1, code: 'ENOENT' }];
/** r8 (2): the judgement's read of the owner answering ENOENT (gone between two reads of one poll): the owner-less branch. */
const OWNER_VANISHED = (reach: number) => [{ point: 'holder-read', reach, code: 'ENOENT' }];

/** The scenarios of each public function (r7 §1, r8 (2)): keyed `<function>` → `<scenario>` — the preparations only. */
export const TABLE_SCENARIOS: Record<string, Record<string, TableScenario>> = {
  acquireMachineLockSync: {
    fresh: scenario('fresh', TAKE),
    'dead-holder': scenario('dead-holder', TAKE),
    'dead-holder end-cleaned': scenario('dead-holder', TAKE, END_CLEANED),
    'ownerless-old': scenario('ownerless-old', TAKE),
    'dead-group-holder': scenario('dead-group-holder', TAKE),
    'ended-old-tmp': scenario('ended-old-tmp', TAKE),
  },
  machineLockAcquisition: {
    fresh: scenario('fresh', STEPS),
    'dead-holder': scenario('dead-holder', STEPS),
    'dead-holder end-cleaned': scenario('dead-holder', STEPS, END_CLEANED),
    'ownerless-old': scenario('ownerless-old', STEPS),
    'dead-group-holder': scenario('dead-group-holder', STEPS),
    'ended-old-tmp': scenario('ended-old-tmp', STEPS),
  },
  'handle.release': {
    own: scenario('fresh', (m, root, fault, arm, _live, warn, life) => releaseOutcome(held(m, root, fault, arm, warn, life).release())),
    'own end-cleaned': scenario('fresh', (m, root, fault, arm, _live, warn, life) => releaseOutcome(held(m, root, fault, arm, warn, life).release()), END_CLEANED),
    // r8 (2) (b3 P2-1): handed to a live group (the <lock>'s record: its group judged)
    'handed-live': scenario('fresh', (m, root, fault, arm, live, warn, life) => releaseOutcome(held(m, root, fault, arm, warn, life, (r) => void r.handOff(live, live)).release())),
    // handed to a dead pid and group (the pid judged: needs-head)
    'handed-dead': scenario('fresh', (m, root, fault, arm, _live, warn, life) => releaseOutcome(held(m, root, fault, arm, warn, life, (r) => void r.handOff(life.dead, life.dead)).release())),
    // handed to this pid in a live group (b3 P2-1), then back to this process's own group: the generation's record the
    // <lock> does not show is judged by its group (§4.2)
    'handed-back': scenario('fresh', (m, root, fault, arm, live, warn, life) =>
      releaseOutcome(
        held(m, root, fault, arm, warn, life, (r) => {
          r.handOff(process.pid, live);
          r.handOff(process.pid, process.pid);
        }).release(),
      ),
    ),
  },
  'handle.handOff': {
    own: scenario('fresh', (m, root, fault, arm, _live, warn, life) => {
      const h = held(m, root, fault, arm, warn, life).handOff(process.pid, process.pid);
      return { outcome: h.ok ? 'ok' : `not ok (${h.stage})`, advanced: h.ok };
    }),
  },
  'handle.setOwnerFields': {
    own: scenario('fresh', (m, root, fault, arm, _live, warn, life) => {
      const ok = held(m, root, fault, arm, warn, life).setOwnerFields({ phase: 'merge' });
      return { outcome: String(ok), advanced: ok };
    }),
  },
  releaseAsHead: {
    'dead-holding': scenario('dead-holding', D5(['T'])),
    'dead-holding end-cleaned': scenario('dead-holding', D5(['T']), END_CLEANED),
    'dead-holding owner-vanished': scenario('dead-holding-old', D5(['T']), OWNER_VANISHED(5)),
    'dead-group-holding': scenario('dead-group-holding', D5(['T'])),
    'live-handoff': scenario('live-handoff', D5(['T', 'HB', 'HC'])),
    'first-alive': scenario('first-alive', D5(['T', 'HB'])),
  },
  recoverIfDead: {
    'dead-holding': scenario('dead-holding', D6),
    'dead-group-holding': scenario('dead-group-holding', D6),
    'ownerless-old': scenario('ownerless-old', D6),
    'live-handoff': scenario('live-handoff', D6),
  },
  readHolder: {
    'gen-and-lock': scenario('gen-and-lock', readHolderRun(false)),
    'gen-and-lock genOnly': scenario('gen-and-lock', readHolderRun(true)),
  },
  resolveGenDir: {
    named: scenario('fresh', (m, root, fault, arm) => {
      arm();
      const r = m.resolveGenDir(lockOf(root).lockPath, process.env, m.makeObserver({ fault }));
      return 'genDir' in r && r.genDir ? genDirOutcome(root, r.genDir) : { outcome: `unknown${unknownOf((r as { unknown: { point: string; code: string } }).unknown)}`, advanced: false };
    }),
    'by-path': scenario('by-path', (m, root, fault, arm) => {
      arm();
      const r = m.resolveGenDir(path.join(root, 'other', 'x.lock'), process.env, m.makeObserver({ fault }));
      return 'genDir' in r && r.genDir ? genDirOutcome(root, r.genDir) : { outcome: `unknown${unknownOf((r as { unknown: { point: string; code: string } }).unknown)}`, advanced: false };
    }),
  },
  genDirOf: {
    named: scenario('fresh', (m, root, fault, arm) => (arm(), genDirOutcome(root, (m.genDirOf as (p: string, e: NodeJS.ProcessEnv, o: unknown) => string)(lockOf(root).lockPath, process.env, m.makeObserver({ fault }))))),
    'by-path': scenario('by-path', (m, root, fault, arm) => (arm(), genDirOutcome(root, (m.genDirOf as (p: string, e: NodeJS.ProcessEnv, o: unknown) => string)(path.join(root, 'other', 'x.lock'), process.env, m.makeObserver({ fault }))))),
  },
};

/**
 * The rows whose unknown does not hold the decision back, and why — keyed `<function> <point>` (`*`: every
 * function). Each is checked by the gate: its unknown run answers and changes what its resolved run does (a clean-up
 * that no judgement reads). Every other row holds back (heldBack) or reads the point again (readAgain).
 */
export const NON_BLOCKING: Record<string, string> = {
  '* gen-tmp-list': 'the clean-up of the old tmps (C8): a listing that fails leaves them to the next clean-up',
  '* gen-tmp-lstat': 'the clean-up of the old tmps (C8): an entry that cannot be read is left',
  '* gen-tmp-unlink': 'the own tmp after its link (C8): left to the clean-up by its age',
  '* owner-unlink': 'the <lock>\'s owner tmp after its link (#4288): left to the clean-up',
  '* release-list': 'the own moved-aside records of the <lock> (#4288 §2.7): a listing that fails leaves them',
  'recoverIfDead list-root': 'the <lock>\'s moved-aside records (#4288 §2.7), settled before the owner is read: a listing that fails is named in the answer, and an owner read dead is recovered as before (#4288 PR1a D6) — the chain is judged apart (§4.2)',
  'handle.setOwnerFields gen-fields-read': 'the fields so far: a read that fails writes the new ones alone (merge-pr\'s phase now is what a recovery needs; the fields are not the lock\'s safety, §3)',
};
export const nonBlocking = (fn: string, point: string): string | undefined => NON_BLOCKING[`${fn} ${point}`] ?? NON_BLOCKING[`* ${point}`];

/** The points of the chain's choice (§3, C7-I2): there `absent` holds the decision back as `unknown` does. */
export const CHAIN_CHOICE_POINTS = ['gen-realpath', 'gen-root-mkdir'];

export interface TableRow {
  fn: string;
  scenario: string;
  point: string;
  /** r8 (2): which reach of the point (1 … reached) alone answers absent / unknown */
  k: number;
  reached: number;
  resolved: CellRun;
  absent: CellRun;
  unknown: CellRun;
}

/**
 * r9: the table's live holder — a sleeper of this test, killed by the caller. Never the pid the dead records name (that
 * pid's number taken again by the sleeper would make one pid both): spawned again until it is another.
 */
export function tableSleeper(): { sleeper: ChildProcess; live: number } {
  for (let i = 0; i < 5; i++) {
    const sleeper = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    if (sleeper.pid !== deadPid()) return { sleeper, live: sleeper.pid as number };
    sleeper.kill('SIGKILL');
  }
  throw new Error('the sleeper took the dead pid five times');
}

/** The table (r7 §1, r8 (2)): every scenario run resolved, and again with each reach of each point it reached absent and unknown. */
export function buildTable(m: Core, scenarios = TABLE_SCENARIOS): TableRow[] {
  const { sleeper, live } = tableSleeper();
  const life = lifeOf(live, deadPid());
  try {
    const rows: TableRow[] = [];
    for (const fn of Object.keys(scenarios).sort()) {
      for (const name of Object.keys(scenarios[fn]).sort()) {
        const s = scenarios[fn][name];
        const resolved = runCell(m, s, live, null, life);
        for (const point of [...resolved.hits.keys()].sort()) {
          const reached = resolved.hits.get(point) as number;
          for (let k = 1; k <= reached; k++) {
            rows.push({
              fn,
              scenario: name,
              point,
              k,
              reached,
              resolved,
              absent: runCell(m, s, live, { point, k, code: 'ENOENT' }, life),
              unknown: runCell(m, s, live, { point, k, code: 'EIO' }, life),
            });
          }
        }
      }
    }
    return rows;
  } finally {
    sleeper.kill('SIGKILL');
  }
}

/**
 * The rule of the gate for a run with reach k of `point` failing (C7-I3: an unknown does not advance a decision that
 * depends on it): nothing is decided past what was on disk at that reach in the resolved run — no `end`, no <lock>
 * moved, no generation made (or left open) that was not by then, the answer not the one the function exists for; and
 * the reach was reached (its fault answered). Answers what breaks it (empty: holds).
 */
export function heldBack(row: TableRow, run: CellRun): string[] {
  const bad: string[] = [];
  const allowed = new Set(row.resolved.changesAt.get(`${row.point}#${row.k}`) ?? []);
  if (run.advanced) bad.push(`advanced: ${run.outcome}`);
  if (!run.fired) bad.push(`reach ${row.k} was not reached`);
  for (const c of run.changes) if (!allowed.has(c)) bad.push(`past the point: ${c}`);
  return bad;
}

/**
 * r8 (2): a reach that failed and was read again — the point reached more often than in the resolved run, and the run
 * then answered and changed what the resolved run did (#4558's re-read of the release's owner): the decision rests on
 * the later reach, which the row of k + 1 fails in turn.
 */
export const readAgain = (row: TableRow, run: CellRun): boolean =>
  run.fired && (run.hits.get(row.point) ?? 0) > row.reached && run.outcome === row.resolved.outcome && JSON.stringify(run.changes) === JSON.stringify(row.resolved.changes);

const pointRe = (point: string): RegExp => new RegExp(`(?<![a-z0-9-])${point.replace(/[-]/g, '\\-')}(?![a-z0-9-])`);
/**
 * r8 (4) (a3 P3-2 = b3 P3-1): the answer of a run that failed at `point` (`code`) names it — the answer, a line it
 * warned (its text or data) or what it threw carries the point's name and the errno. A bare `kept` / `deferred` /
 * `not acquired` / `null` names nothing.
 */
export function namesPoint(run: CellRun, point: string, code: string): boolean {
  const text = [run.outcome, ...run.warns, run.error ?? ''].join('\n');
  return pointRe(point).test(text) && new RegExp(`\\b${code}\\b`).test(text);
}

/** r8 (1) (§4.2): an answer `released` comes with an `end` on disk (the holding's, written in that run). */
export const releasedWithoutEnd = (run: CellRun): boolean => /^released\b/.test(run.outcome) && !run.changes.some((c) => /^g\d+ end /.test(c));

/** A cell of the rendered table: the answer and what changed on disk. */
const cell = (r: CellRun): string => `${r.outcome}${r.changes.length > 0 ? `; ${r.changes.join(', ')}` : ''}`.replace(/\|/g, '\\|');

/** The table as the design's §8.4 holds it. */
export function renderTable(rows: TableRow[]): string {
  const head = ['| 関数 | 場面 | 観測点 | 回 | 届いた回数 | resolved | absent | unknown |', '|---|---|---|---|---|---|---|---|'];
  return [...head, ...rows.map((r) => `| \`${r.fn}\` | ${r.scenario} | \`${r.point}\` | ${r.k} | ${r.reached} | ${cell(r.resolved)} | ${cell(r.absent)} | ${cell(r.unknown)} |`)].join('\n');
}

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


// ------------------------------------------------------------------ #4559 r7 §1: the gate of the public functions

/**
 * #4559 r7 §1 (PM's disposition 1): the table of the core's public functions × the observation points each one
 * reaches × the three values of an observation (resolved / absent / unknown), made by machine — never by hand:
 *
 * - the functions are read from the core's source (`coreProcedures`): every exported function whose calls reach a
 *   function of the generation chain that observes, and the methods of a holding's handle (`handle.<name>`)
 * - the points of a row are the ones its run reached (the `hooks.fault` seam is told every observation), in a
 *   scenario of TABLE_SCENARIOS (a function without one is a red row of the gate)
 * - each point is run again with it answering ENOENT (absent) and EIO (unknown) at every reach
 *
 * The table is the one source: the gate (machine-lock-generation-seams-4559.test.ts) checks every row, and the
 * design's §8.4 is the table rendered, byte for byte.
 */

type FaultFn = (point: string, target: string, count?: number) => string | undefined;
type Core = typeof lockSync;
export interface TableOutcome {
  outcome: string;
  /** the chain-dependent decision the function exists for was made (taken, released, removed, chosen …) */
  advanced: boolean;
}
export interface TableScenario {
  prepare: (root: string, live: number) => void;
  /** `arm` turns the fault seam on (a handle's method: after its acquisition). */
  run: (m: Core, root: string, fault: FaultFn, arm: () => void, live: number) => TableOutcome;
}

/** The core's source without its comments (a name in a comment is not a call). */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, '$1');

const OBSERVE_RE = /\bobs\.(?:pid|group|list|lstat|record|owner|text|realpath|mkdir|rename|rmdir|put|link|unlink|create)\(/;

/**
 * The public functions of the core (r7 §1), from its source: the exported functions whose calls reach a function
 * of the generation chain (after the `// The generation chain (#4559` line) that observes, and the methods of the
 * handle `holding(n)` answers (`handle.<name>`). Throws when a part it reads is not found (never an empty list).
 */
export function coreProcedures(source: string): string[] {
  const marker = source.split('\n').findIndex((l) => l.includes('// The generation chain (#4559'));
  if (marker < 0) throw new Error('the generation chain\'s marker line is not in the core');
  const lines = stripComments(source).split('\n');
  const decls: { name: string; exported: boolean; fn: boolean; start: number; body: string }[] = [];
  lines.forEach((l, i) => {
    const m = /^(export )?(?:function\*? ([A-Za-z_$][\w$]*)\(|const ([A-Za-z_$][\w$]*) = )/.exec(l);
    if (m) decls.push({ name: m[2] ?? m[3], exported: Boolean(m[1]), fn: Boolean(m[2]), start: i, body: '' });
  });
  decls.forEach((d, i) => (d.body = lines.slice(d.start, i + 1 < decls.length ? decls[i + 1].start : lines.length).join('\n')));
  const names = new Set(decls.map((d) => d.name));
  const by = new Map(decls.map((d) => [d.name, d]));
  const calls = new Map(decls.map((d) => [d.name, [...d.body.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]).filter((n) => names.has(n) && n !== d.name)]));
  const chain = new Set(decls.filter((d) => d.start > marker && OBSERVE_RE.test(d.body)).map((d) => d.name));
  if (chain.size === 0) throw new Error('no observing function of the generation chain was found');
  const reaches = (name: string): boolean => {
    const seen = new Set<string>();
    const stack = [name];
    while (stack.length > 0) {
      const n = stack.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      if (chain.has(n)) return true;
      stack.push(...(calls.get(n) ?? []));
    }
    return false;
  };
  const exported = decls.filter((d) => d.exported && d.fn && reaches(d.name)).map((d) => d.name);
  const acq = by.get('machineLockAcquisition');
  const at = acq?.body.indexOf('function holding(') ?? -1;
  if (!acq || at < 0) throw new Error('the handle of a holding (function holding) is not in the core');
  const handle = [...acq.body.slice(at).matchAll(/^ {6}([A-Za-z_$][\w$]*): (?:\(|function)/gm)].map((m) => `handle.${m[1]}`);
  if (handle.length === 0) throw new Error('the handle of a holding has no method');
  return [...exported, ...handle].sort();
}

/**
 * The observation points of the generation chain the core names (literal): `obs.<op>('<point>'`, the GEN_WRITES
 * table's put / link and listGens' — the points of the chain's own functions (after its marker line), apart from
 * the <lock>'s older points (#4288's), which are the observation table's rows.
 */
export function chainPoints(source: string, older: Set<string>): string[] {
  const start = source.indexOf('// The generation chain (#4559');
  if (start < 0) throw new Error('the generation chain\'s marker line is not in the core');
  const part = source.slice(start);
  const names = new Set<string>();
  for (const m of part.matchAll(/\bobs\.(?:pid|group|list|lstat|record|owner|text|realpath|mkdir|rename|rmdir|put|link|unlink)\('([a-z0-9-]+)'/g)) names.add(m[1]);
  for (const m of part.matchAll(/\b(?:put|link): '([a-z0-9-]+)'/g)) names.add(m[1]);
  for (const m of part.matchAll(/\blistGens\(g, '([a-z0-9-]+)'\)/g)) names.add(m[1]);
  return [...names].filter((n) => !older.has(n)).sort();
}

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
/** The changes from `pre` to `now`, as names (`g1 end dead`, `new gen`, `new gen open`, `lock T→none` …). */
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
  if (now.lock !== pre.lock) out.add(`lock ${pre.lock}→${now.lock}`);
  if (now.byPath > pre.byPath) out.add('new by-path chain');
  return [...out].sort();
}

export interface CellRun extends TableOutcome {
  hits: Map<string, number>;
  /** the changes on disk at the first reach of each point (before its operation) */
  firstChanges: Map<string, string[]>;
  changes: string[];
}

/** One run of a scenario with `plan` (null: every observation resolved as the filesystem answers). */
export function runCell(m: Core, scenario: TableScenario, live: number, plan: { point: string; code: string } | null): CellRun {
  const root = freshRoot('r7-table');
  scenario.prepare(root, live);
  let armed = false;
  let pre: ChainState = chainState(root);
  const hits = new Map<string, number>();
  const firstChanges = new Map<string, string[]>();
  const fault: FaultFn = (point) => {
    if (!armed) return undefined;
    hits.set(point, (hits.get(point) ?? 0) + 1);
    if (!firstChanges.has(point)) firstChanges.set(point, chainChanges(pre, chainState(root)));
    return plan !== null && plan.point === point ? plan.code : undefined;
  };
  const arm = (): void => {
    pre = chainState(root);
    armed = true;
  };
  const was = process.env.CM_VERIFY_LOCK_ROOT;
  process.env.CM_VERIFY_LOCK_ROOT = root;
  let out: TableOutcome;
  try {
    out = scenario.run(m, root, fault, arm, live);
  } catch (err) {
    out = { outcome: `throws ${(err as NodeJS.ErrnoException).code ?? 'an error'}`, advanced: false };
  } finally {
    armed = false;
    process.env.CM_VERIFY_LOCK_ROOT = was;
  }
  return { ...out, hits, firstChanges, changes: chainChanges(pre, chainState(root)) };
}

const AHEAD = 11 * 60_000;
const aheadHooks = (fault: FaultFn) => ({ fault, now: () => Date.now() + AHEAD, startOf: () => 0 });
const unknownOf = (u?: { point: string; code: string }): string => (u ? ` (${u.point} ${u.code})` : '');
const takeOutcome = (r: { acquired: boolean; unknown?: { point: string; code: string } }): TableOutcome => ({
  outcome: r.acquired ? 'acquired' : `not acquired${unknownOf(r.unknown)}`,
  advanced: r.acquired,
});
function writeBeacon(lockPath: string, record: Record<string, unknown>): void {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ host: HOST, acquiredAt: 0, v: 1, ...record }));
}
const PREPARE: Record<string, (root: string, live: number) => void> = {
  fresh: () => {},
  'dead-holder': (root) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: deadPid(), token: 'D' } });
    writeBeacon(lockPath, { pid: deadPid(), token: 'D', g: 1 });
  },
  'ownerless-old': (root) => void writeGen(lockOf(root).genDir, 1, { owner: null, mtimeAgoMs: 20 * 60_000 }),
  'dead-group-holder': (root) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: deadPid(), pgid: deadPid(), token: 'D' } });
    writeBeacon(lockPath, { pid: deadPid(), pgid: deadPid(), token: 'D', g: 1 });
  },
  'ended-old-tmp': (root) => {
    const { genDir } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: deadPid(), token: 'Y' }, end: 'released Y' });
    writeGen(genDir, 2, { owner: { pid: deadPid(), token: 'Z' }, end: 'released Z' });
    fs.mkdirSync(`${genDir}.tmp`, { recursive: true });
    const tmp = path.join(`${genDir}.tmp`, 'W.g000000000009.owner.1');
    fs.writeFileSync(tmp, '{}');
    const t = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(tmp, t, t);
  },
  // a holding whose records are all dead, its <lock> showing it (g=1)
  'dead-holding': (root) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: deadPid(), token: 'T' } });
    writeBeacon(lockPath, { pid: deadPid(), token: 'T', g: 1 });
  },
  // a2 P2-1: A → B → C; C (the <lock>'s record) dead, B's group alive
  'live-handoff': (root, live) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: deadPid(), token: 'T' }, handoffs: [{ pid: live, pgid: live, token: 'HB' }, { pid: deadPid(), token: 'HC' }] });
    writeBeacon(lockPath, { pid: deadPid(), token: 'HC', g: 1 });
  },
  // a2 P2-2 / b2 P2-1: the first owner alive (another process), its hand-off dead (the <lock>'s record)
  'first-alive': (root, live) => {
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: live, token: 'T' }, handoffs: [{ pid: deadPid(), token: 'HB' }] });
    writeBeacon(lockPath, { pid: deadPid(), token: 'HB', g: 1 });
  },
  'by-path': (root) => fs.mkdirSync(path.join(root, 'other'), { recursive: true }),
};
const scenario = (prepare: string, run: TableScenario['run']): TableScenario => ({ prepare: PREPARE[prepare], run });
const take = (m: Core, root: string, fault: FaultFn) => m.acquireMachineLockSync('x', { root, timeoutMs: 0, pollMs: 10, hooks: aheadHooks(fault) });
/** A holding taken with the seam off, then `arm`ed for the handle's method. */
const held = (m: Core, root: string, fault: FaultFn, arm: () => void) => {
  const r = take(m, root, fault);
  if (!r.acquired) throw Object.assign(new Error('the scenario\'s take failed'), { code: 'SCENARIO' });
  arm();
  return r;
};
const asHeadOutcome = (r: { result: string; unknown?: { point: string; code: string } }, advancing: string): TableOutcome => ({
  outcome: `${r.result}${unknownOf(r.unknown)}`,
  advanced: r.result === advancing,
});
const genDirOutcome = (root: string, dir: string): TableOutcome => ({ outcome: `chain ${path.relative(root, dir).replace(/by-path\/[0-9a-f]{32}/, 'by-path/<hash>')}`, advanced: true });

/** The scenarios of each public function (r7 §1): keyed `<function>` → `<scenario>`. */
export const TABLE_SCENARIOS: Record<string, Record<string, TableScenario>> = {
  acquireMachineLockSync: {
    fresh: scenario('fresh', (m, root, fault, arm) => (arm(), takeOutcome(take(m, root, fault)))),
    'dead-holder': scenario('dead-holder', (m, root, fault, arm) => (arm(), takeOutcome(take(m, root, fault)))),
    'ownerless-old': scenario('ownerless-old', (m, root, fault, arm) => (arm(), takeOutcome(take(m, root, fault)))),
    'dead-group-holder': scenario('dead-group-holder', (m, root, fault, arm) => (arm(), takeOutcome(take(m, root, fault)))),
    'ended-old-tmp': scenario('ended-old-tmp', (m, root, fault, arm) => (arm(), takeOutcome(take(m, root, fault)))),
  },
  machineLockAcquisition: {
    'dead-holder': scenario('dead-holder', (m, root, fault, arm) => {
      arm();
      const steps = m.machineLockAcquisition('x', { root, timeoutMs: 0, pollMs: 10, hooks: aheadHooks(fault) });
      for (;;) {
        const step = steps.next();
        if (step.done) return takeOutcome(step.value);
      }
    }),
  },
  'handle.release': {
    own: scenario('fresh', (m, root, fault, arm) => {
      const r = held(m, root, fault, arm);
      const result = r.release();
      return { outcome: result, advanced: result === 'released' };
    }),
  },
  'handle.handOff': {
    own: scenario('fresh', (m, root, fault, arm) => {
      const r = held(m, root, fault, arm);
      const h = r.handOff(process.pid, process.pid);
      return { outcome: h.ok ? 'ok' : `not ok (${h.stage})`, advanced: h.ok };
    }),
  },
  'handle.setOwnerFields': {
    own: scenario('fresh', (m, root, fault, arm) => {
      const r = held(m, root, fault, arm);
      const ok = r.setOwnerFields({ phase: 'merge' });
      return { outcome: String(ok), advanced: ok };
    }),
  },
  releaseAsHead: {
    'dead-holding': scenario('dead-holding', (m, root, fault, arm) => (arm(), asHeadOutcome(m.releaseAsHead(lockOf(root).lockPath, ['T'], { timeoutMs: 0, hooks: { fault } }), 'released'))),
    'live-handoff': scenario('live-handoff', (m, root, fault, arm) => (arm(), asHeadOutcome(m.releaseAsHead(lockOf(root).lockPath, ['T', 'HB', 'HC'], { timeoutMs: 0, hooks: { fault } }), 'released'))),
    'first-alive': scenario('first-alive', (m, root, fault, arm) => (arm(), asHeadOutcome(m.releaseAsHead(lockOf(root).lockPath, ['T', 'HB'], { timeoutMs: 0, hooks: { fault } }), 'released'))),
  },
  recoverIfDead: {
    'dead-holding': scenario('dead-holding', (m, root, fault, arm) => (arm(), asHeadOutcome(m.recoverIfDead(lockOf(root).lockPath, { timeoutMs: 0, hooks: { fault } }), 'removed'))),
    'live-handoff': scenario('live-handoff', (m, root, fault, arm) => (arm(), asHeadOutcome(m.recoverIfDead(lockOf(root).lockPath, { timeoutMs: 0, hooks: { fault } }), 'removed'))),
  },
  readHolder: {
    'dead-holder': scenario('dead-holder', (m, root, fault, arm) => {
      arm();
      const h = m.readHolder(lockOf(root).lockPath, { hooks: { fault } } as never) as { token?: string; g?: number } | null;
      return { outcome: h ? `holder ${h.token}${h.g ? ` g=${h.g}` : ''}` : 'null', advanced: false };
    }),
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
 * that no judgement reads). Every other row holds back (heldBack).
 */
export const NON_BLOCKING: Record<string, string> = {
  '* gen-tmp-list': 'the clean-up of the old tmps (C8): a listing that fails leaves them to the next clean-up',
  '* gen-tmp-lstat': 'the clean-up of the old tmps (C8): an entry that cannot be read is left',
  '* gen-tmp-unlink': 'the own tmp after its link (C8): left to the clean-up by its age',
  '* owner-unlink': 'the <lock>\'s owner tmp after its link (#4288): left to the clean-up',
  '* release-list': 'the own moved-aside records of the <lock> (#4288 §2.7): a listing that fails leaves them',
  'handle.setOwnerFields gen-fields-read': 'the fields so far: a read that fails writes the new ones alone (merge-pr\'s phase now is what a recovery needs; the fields are not the lock\'s safety, §3)',
};
export const nonBlocking = (fn: string, point: string): string | undefined => NON_BLOCKING[`${fn} ${point}`] ?? NON_BLOCKING[`* ${point}`];

/** The points of the chain's choice (§3, C7-I2): there `absent` holds the decision back as `unknown` does. */
export const CHAIN_CHOICE_POINTS = ['gen-realpath', 'gen-root-mkdir'];

export interface TableRow {
  fn: string;
  scenario: string;
  point: string;
  reached: number;
  resolved: CellRun;
  absent: CellRun;
  unknown: CellRun;
}

/** The table (r7 §1): every scenario run resolved, and again with each point it reached absent and unknown. */
export function buildTable(m: Core, scenarios = TABLE_SCENARIOS): TableRow[] {
  const sleeper = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  const live = sleeper.pid as number;
  try {
    const rows: TableRow[] = [];
    for (const fn of Object.keys(scenarios).sort()) {
      for (const name of Object.keys(scenarios[fn]).sort()) {
        const s = scenarios[fn][name];
        const resolved = runCell(m, s, live, null);
        for (const point of [...resolved.hits.keys()].sort()) {
          rows.push({
            fn,
            scenario: name,
            point,
            reached: resolved.hits.get(point) as number,
            resolved,
            absent: runCell(m, s, live, { point, code: 'ENOENT' }),
            unknown: runCell(m, s, live, { point, code: 'EIO' }),
          });
        }
      }
    }
    return rows;
  } finally {
    sleeper.kill('SIGKILL');
  }
}

/**
 * The rule of the gate for a run with `point` failing (C7-I3: an unknown does not advance a decision that depends
 * on it): nothing is decided past what was on disk when `point` was first reached in the resolved run — no `end`, no
 * <lock> moved, no generation made (or left open) that was not by then, the answer not the one the function exists
 * for; and the point reached. Answers what breaks it (empty: holds).
 */
export function heldBack(row: TableRow, run: CellRun): string[] {
  const bad: string[] = [];
  const allowed = new Set(row.resolved.firstChanges.get(row.point) ?? []);
  if (run.advanced) bad.push(`advanced: ${run.outcome}`);
  if ((run.hits.get(row.point) ?? 0) < 1) bad.push('the point was not reached');
  for (const c of run.changes) if (!allowed.has(c)) bad.push(`past the point: ${c}`);
  return bad;
}

/** A cell of the rendered table: the answer and what changed on disk. */
const cell = (r: CellRun): string => `${r.outcome}${r.changes.length > 0 ? `; ${r.changes.join(', ')}` : ''}`.replace(/\|/g, '\\|');

/** The table as the design's §8.4 holds it. */
export function renderTable(rows: TableRow[]): string {
  const head = ['| 関数 | 場面 | 観測点 | 届いた回数 | resolved | absent | unknown |', '|---|---|---|---|---|---|---|'];
  return [...head, ...rows.map((r) => `| \`${r.fn}\` | ${r.scenario} | \`${r.point}\` | ${r.reached} | ${cell(r.resolved)} | ${cell(r.absent)} | ${cell(r.unknown)} |`)].join('\n');
}

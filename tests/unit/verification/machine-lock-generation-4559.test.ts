/**
 * Issue #4559 PR-2: the generation chain of the sync JS core (docs/design/machine-lock-generation-4559.md
 * §8.1 T2, T4, T6 — the JS rows). TS imports the same core (案 F), so it is not a row of its own here.
 *
 * T2: every seam of the core × every injection — stopped (and a second actor stopped at the same seam:
 * the crossing order A stops → B stops → A resumes → B resumes), killed (SIGKILL) — has at least one
 * row. The seams are read from the core's source (`seam('<stage>')` and the GEN_WRITES table), never a
 * hand-written list: a seam added without a row fails the coverage test. The actors run in their own
 * processes (fixtures/lock-actor-4277.mjs, mode `gen`), stopped with the counted pauses. The oracle
 * counts S1 (no two holdings overlap, from the events) and S2 (no `end` on a live holder's generation,
 * from the disk) apart.
 *
 * T6 (here, with T2's setups): an EIO once at each observation point of the generation is recovered at a
 * later poll and named; an EIO that goes on takes nothing.
 *
 * T4: #4559's report with the new version on both sides (closed), and with an older version's
 * successor (the `mixed` row P-4/P-5, kept red-by-name as a window of design §6.5).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import {
  CORE,
  HOST,
  cleanAll,
  deadPid,
  freshRoot,
  legacyModule,
  loadLegacy,
  lockOf,
  readGens,
  s1Violations,
  s2Violations,
  startActor,
  until,
  writeGen,
  type ActorEvent,
} from './lock-generation-4559-harness';
import { OBSERVATION_POINTS } from './lock-observation-points-4288';

afterEach(() => cleanAll());

/** The seams the core names: `seam('<stage>')` calls and the seams of its GEN_WRITES table. */
export function coreSeams(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\bseam\('([a-z0-9-]+)'\)/g)) names.add(m[1]);
  for (const m of source.matchAll(/\bseam(?:Tmp|Linked): '([a-z0-9-]+)'/g)) names.add(m[1]);
  return [...names].sort();
}

type Setup = 'fresh' | 'dead-group-holder' | 'ended' | 'two-ended' | 'old-tmp' | 'dead-holder' | 'ownerless-old' | 'prev-beacon' | 'handoff' | 'fields' | 'larger-later' | 'publish-fails';

/** Where each seam is reached (the state a row starts from). Every seam of the core is a key here. */
const SEAM_SETUP: Record<string, Setup> = {
  'gen-list': 'fresh',
  'gen-parent-mkdir': 'fresh',
  'gen-dir-mkdir': 'fresh',
  'gen-mkdir': 'fresh',
  'gen-tmp-mkdir': 'fresh',
  'gen-owner-tmp': 'fresh',
  'gen-owner-linked': 'fresh',
  'gen-postlist': 'fresh',
  'gen-end-read': 'ended',
  'gc-judged': 'two-ended',
  'gc-rm': 'two-ended',
  'gc-tmp-rm': 'old-tmp',
  'holder-read': 'dead-holder',
  'holder-judged': 'dead-holder',
  'holder-relist': 'dead-holder',
  'end-tmp': 'dead-holder',
  'end-linked': 'dead-holder',
  'ownerless-judged': 'ownerless-old',
  'tomb-tmp': 'ownerless-old',
  'tomb-linked': 'ownerless-old',
  'tomb-end': 'ownerless-old',
  'beacon-prev-judged': 'prev-beacon',
  'gen-handoff-tmp': 'handoff',
  'handoff-linked': 'handoff',
  'fields-rename': 'fields',
  'beacon-release': 'fresh',
  'release-end': 'fresh',
  'gen-withdraw-end': 'larger-later',
  'gen-owner-failed': 'publish-fails',
};

const OLD_MS = 20 * 60_000;

function prepare(root: string, setup: Setup): void {
  const { genDir, lockPath } = lockOf(root);
  const dead = deadPid();
  if (setup === 'ended') writeGen(genDir, 1, { owner: { pid: dead, token: 'Z' }, end: 'released Z' });
  if (setup === 'two-ended') {
    writeGen(genDir, 1, { owner: { pid: dead, token: 'Y' }, end: 'released Y' });
    writeGen(genDir, 2, { owner: { pid: dead, token: 'Z' }, end: 'released Z' });
  }
  if (setup === 'old-tmp') {
    fs.mkdirSync(`${genDir}.tmp`, { recursive: true });
    const tmp = path.join(`${genDir}.tmp`, 'W.g000000000009.owner');
    fs.writeFileSync(tmp, '{}');
    const t = new Date(Date.now() - OLD_MS);
    fs.utimesSync(tmp, t, t);
  }
  if (setup === 'dead-holder') writeGen(genDir, 1, { owner: { pid: dead, token: 'D' } });
  if (setup === 'dead-group-holder') writeGen(genDir, 1, { owner: { pid: dead, token: 'D', pgid: dead } });
  if (setup === 'ownerless-old') writeGen(genDir, 1, { owner: null, mtimeAgoMs: OLD_MS });
  if (setup === 'prev-beacon') {
    writeGen(genDir, 1, { owner: { pid: dead, token: 'D' }, end: `dead R` });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: dead, host: HOST, token: 'D', acquiredAt: 0, v: 1, g: 1 }));
  }
}

/** The state every row ends in: no live holder, every generation ended, the <lock> let go. */
function expectSettled(root: string): void {
  const { genDir, lockPath } = lockOf(root);
  const gens = readGens(genDir);
  const open = [...gens].filter(([, g]) => g.end === null).map(([n]) => n);
  expect({ open, lock: fs.existsSync(lockPath) }).toEqual({ open: [], lock: false });
}

const allEvents = (...actors: { events: () => ActorEvent[] }[]): ActorEvent[] => actors.flatMap((a) => a.events());

describe('#4559 T2: the seams are read from the core, and every one has a row', () => {
  it('the table of rows names exactly the core\'s seams (no seam without a row, no row without a seam)', () => {
    const seams = coreSeams(fs.readFileSync(CORE, 'utf8'));
    expect(seams.length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(SEAM_SETUP).sort()).toEqual(seams);
  });

  it('self-test: a seam added to a copy of the core is a difference', () => {
    const seams = coreSeams(`${fs.readFileSync(CORE, 'utf8')}\n  g.seam('new-seam');\n`);
    expect(seams).toContain('new-seam');
    expect(Object.keys(SEAM_SETUP).sort()).not.toEqual(seams);
  });
});

/** The setups that are not reached by a plain take: the actor's options, and what the test does at a pause. */
function actorOptions(setup: Setup): { handOff?: boolean; fields?: boolean } {
  return setup === 'handoff' ? { handOff: true } : setup === 'fields' ? { fields: true } : {};
}

/**
 * A row's first stop: the seam itself, except where it is reached only after the test acts at another
 * point (`larger-later`: a larger generation written while A stops at gen-postlist).
 */
async function bringTo(root: string, seam: string, setup: Setup, extraPauses: string[] = []) {
  const pre = setup === 'larger-later' ? ['gen-postlist#1'] : [];
  const a = startActor(root, 'A', { pauses: [...pre, `${seam}#1`, ...extraPauses], timeoutMs: 800, ...actorOptions(setup) });
  if (setup === 'larger-later') {
    expect(await until(() => a.reached('gen-postlist#1'))).toBe(true);
    writeGen(lockOf(root).genDir, 2, { owner: { pid: deadPid(), token: 'L' } });
    a.go('gen-postlist#1');
  }
  return a;
}

const STOP_SEAMS = Object.keys(SEAM_SETUP).filter((s) => SEAM_SETUP[s] !== 'publish-fails');

describe('#4559 T2: A stopped at each seam, B at the same seam (the crossing order)', () => {
  it.each(STOP_SEAMS)('stop at %s: S1 and S2 hold, and all settles', async (seam) => {
    const setup = SEAM_SETUP[seam];
    const root = freshRoot(`stop-${seam}`);
    prepare(root, setup);
    const a = await bringTo(root, seam, setup);
    expect(await until(() => a.reached(`${seam}#1`)), `A reaches ${seam}`).toBe(true);
    // B's clock is 70 s ahead: A's ticket is past its deadline + 60 s, so B is the head while A stops.
    const b = startActor(root, 'B', { pauses: [`${seam}#1`], timeoutMs: 400, nowAheadMs: 70_000 });
    let bExited = false;
    void b.exited.then(() => (bExited = true));
    await until(() => bExited || b.reached(`${seam}#1`), 3000);
    expect(s2Violations(lockOf(root).genDir), 'S2 while A and B stop').toEqual([]);
    a.go(`${seam}#1`);
    let aExited = false;
    void a.exited.then(() => (aExited = true));
    await until(() => aExited || bExited, 3000);
    b.go(`${seam}#1`);
    await a.exited;
    await b.exited;
    expect(s1Violations(allEvents(a, b))).toEqual([]);
    expect(s2Violations(lockOf(root).genDir)).toEqual([]);
    expectSettled(root);
  }, 20000);
});

describe('#4559 T2: A killed at each seam — the next head takes the lock (S4) and S1 / S2 hold', () => {
  it.each(STOP_SEAMS)('kill at %s', async (seam) => {
    const setup = SEAM_SETUP[seam];
    const root = freshRoot(`kill-${seam}`);
    prepare(root, setup);
    const a = await bringTo(root, seam, setup);
    expect(await until(() => a.reached(`${seam}#1`))).toBe(true);
    const killedAt = Date.now();
    a.child.kill('SIGKILL');
    await a.exited;
    // 11 minutes ahead: the owner-less generation's grace (§4.4) and A's ticket are past.
    const b = startActor(root, 'B', { timeoutMs: 2000, nowAheadMs: 11 * 60_000 });
    expect(await b.exited, `B takes after A was killed at ${seam}`).toBe(0);
    const events = allEvents(a, b);
    expect(events.filter((e) => e.who === 'B').map((e) => e.event)).toEqual(['start', 'acquired', 'releasing', 'released']);
    // A, killed, holds nothing: its span ends at its death (before B started).
    expect(s1Violations(events, { A: killedAt })).toEqual([]);
    expect(s2Violations(lockOf(root).genDir)).toEqual([]);
    expectSettled(root);
  }, 20000);
});

/** The generation's observation points the core names (literal), and the GEN_WRITES table's. */
export function genPoints(source: string): string[] {
  const start = source.indexOf('// The generation chain (#4559');
  const end = source.indexOf('export function acquireMachineLockSync');
  const part = source.slice(start, end);
  const names = new Set<string>();
  for (const m of part.matchAll(/\bobs\.(?:pid|group|list|lstat|record|realpath|mkdir|rename|rmdir|put|link|unlink)\('([a-z0-9-]+)'/g)) names.add(m[1]);
  for (const m of part.matchAll(/\b(?:put|link): '([a-z0-9-]+)'/g)) names.add(m[1]);
  for (const m of part.matchAll(/\blistGens\(g, '([a-z0-9-]+)'\)/g)) names.add(m[1]);
  // The <lock>'s points of #4288 (bash's too) are the observation table's older rows, injected there.
  const older = new Set(OBSERVATION_POINTS.filter((p) => p.impls.includes('bash')).map((p) => p.point));
  return [...names].filter((n) => !older.has(n)).sort();
}

/** Where each point is reached, and whether the take goes on after an EIO there once in the same call. */
const POINT_SETUP: Record<string, Setup> = {
  'gen-list': 'fresh',
  'gen-dir-mkdir': 'fresh',
  'gen-mkdir': 'fresh',
  'gen-tmp-mkdir': 'fresh',
  'gen-owner-tmp': 'fresh',
  'gen-owner-link': 'fresh',
  'gen-postlist': 'fresh',
  'gen-verify-end': 'fresh',
  'gen-verify-owner': 'fresh',
  'gen-end-read': 'ended',
  'gen-tmp-list': 'ended',
  'gen-tmp-lstat': 'old-tmp',
  'gen-tmp-unlink': 'fresh',
  'holder-read': 'dead-holder',
  'holder-pid': 'dead-holder',
  'holder-group': 'dead-group-holder',
  'holder-relist': 'dead-holder',
  'end-tmp': 'dead-holder',
  'end-link': 'dead-holder',
  'ownerless-gen-mtime': 'ownerless-old',
  'tomb-tmp': 'ownerless-old',
  'tomb-link': 'ownerless-old',
  'beacon-gen-end': 'prev-beacon',
  'gen-realpath': 'fresh',
  'handoff-gen-tmp': 'handoff',
  'handoff-gen-link': 'handoff',
};

/** A take in this process with `fault` and the clock 11 minutes ahead (graces past), then its release. */
function takeWith(root: string, setup: Setup, fault: (point: string, target: string, count: number) => string | undefined, timeoutMs: number, point = '') {
  const { genDir } = lockOf(root);
  const warnings: string[] = [];
  const r = lockSync.acquireMachineLockSync('x', {
    root,
    timeoutMs,
    pollMs: 10,
    warn: (l: string) => warnings.push(l),
    // the generation directory as a test seam (hooks.genDir), but for gen-realpath, whose observation it skips
    hooks: { fault, now: () => Date.now() + 11 * 60_000, startOf: () => 0, ...(point === 'gen-realpath' ? {} : { genDir }) },
  });
  let handed: unknown = null;
  if (r.acquired && setup === 'handoff') handed = r.handOff(process.pid, process.pid);
  const released = r.acquired ? r.release() : null;
  return { r, warnings, released, handed };
}

describe('#4559 T6: an EIO at each of the generation\'s observation points', () => {
  it('the table names exactly the generation\'s observation points of the core', () => {
    const points = genPoints(fs.readFileSync(CORE, 'utf8'));
    expect(points.length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(POINT_SETUP).sort()).toEqual(points);
  });

  it.each(Object.keys(POINT_SETUP))('%s: an EIO once — recovered at a later poll, named, the release done', (point) => {
    const setup = POINT_SETUP[point];
    const root = freshRoot(`eio-${point}`);
    prepare(root, setup);
    let fired = 0;
    const { r, warnings, released, handed } = takeWith(root, setup, (p, _t, count) => (p === point && count === 1 ? (fired++, 'EIO') : undefined), 1500, point);
    expect(fired, `the point ${point} is reached`).toBe(1);
    expect(r.acquired).toBe(true);
    if (setup === 'handoff') expect(handed).toMatchObject({ ok: point === 'handoff-gen-tmp' || point === 'handoff-gen-link' ? false : true });
    expect(released).toBe('released');
    // named: as an unknown of its poll, or (a clean-up's) as what was left
    if (!['gen-tmp-lstat', 'gen-tmp-list', 'gen-tmp-unlink', 'handoff-gen-tmp', 'handoff-gen-link'].includes(point)) expect(warnings.join('\n')).toContain(`point=${point}`);
    expect(s2Violations(lockOf(root).genDir)).toEqual([]);
  });

  it.each(['gen-realpath', 'gen-list', 'gen-mkdir', 'gen-postlist', 'holder-read', 'holder-pid', 'end-link', 'tomb-link', 'gen-end-read'])('%s: an EIO that goes on — not taken, and the holder\'s generation not ended', (point) => {
    const setup = POINT_SETUP[point];
    const root = freshRoot(`eio-on-${point}`);
    prepare(root, setup);
    const before = readGens(lockOf(root).genDir);
    const { r } = takeWith(root, setup, (p) => (p === point ? 'EIO' : undefined), 200, point);
    expect(r.acquired).toBe(false);
    expect(fs.existsSync(lockOf(root).lockPath)).toBe(false);
    for (const [n, g] of before) expect(readGens(lockOf(root).genDir).get(n)?.end ?? null).toBe(g.end);
  });
});

describe('#4559 T2: the seams that need a failure to be reached', () => {
  it('gen-owner-failed: the owner\'s link fails — the writer ends its own generation (tomb, withdrawn) and the next poll takes', () => {
    const root = freshRoot('owner-failed');
    const seen: string[] = [];
    const { genDir } = lockOf(root);
    const r = lockSync.acquireMachineLockSync('x', {
      root,
      timeoutMs: 1000,
      pollMs: 10,
      hooks: {
        genDir, fault: (p: string, _t: string, c: number) => (p === 'gen-owner-link' && c === 1 ? 'EIO' : undefined), onGenStage: (s: string) => seen.push(s) },
    });
    expect(r.acquired).toBe(true);
    expect(seen).toContain('gen-owner-failed');
    const g1 = readGens(genDir).get(1);
    expect({ tomb: g1?.records[0]?.tomb, end: g1?.end?.split(' ')[0] }).toEqual({ tomb: 1, end: 'withdrawn' });
    expect(r.gen).toBe(2);
    expect(r.release()).toBe('released');
  });
});

describe('#4559 T2: C7 — the by-path name is one for /var and /private/var, and a lock in the root is named', () => {
  it('genDirOf: the realpath of the parent decides; <root>/<name>.lock is <root>/<name>.gen', () => {
    const root = freshRoot('c7');
    const env = { CM_VERIFY_LOCK_ROOT: root } as unknown as NodeJS.ProcessEnv;
    const other = fs.mkdtempSync(path.join(root, 'other-'));
    const real = fs.realpathSync(other);
    const viaVar = real.startsWith('/private/') ? real.slice('/private'.length) : real;
    expect(lockSync.genDirOf(path.join(real, 'run.lock'), env)).toBe(lockSync.genDirOf(path.join(viaVar, 'run.lock'), env));
    expect(lockSync.genDirOf(path.join(real, 'run.lock'), env)).toMatch(/\/by-path\/[0-9a-f]{32}\.gen$/);
    expect(lockSync.genDirOf(path.join(root, 'cpu.heavy.lock'), env)).toBe(path.join(root, 'cpu.heavy.gen'));
    // by name and by path, the same lock has the same chain
    expect(lockSync.genDirOf(lockSync.lockPathOf(root, 'x'), env)).toBe(lockSync.genDirOf(path.join(root, 'x.lock'), env));
  });

  it('C5: only g + 12 digits are generations', () => {
    expect(['g000000000001', 'g00000000001', 'g0000000000012', 'x000000000001', 'g00000000000a'].map((n) => lockSync.GEN_PATTERN.test(n))).toEqual([true, false, false, false, false]);
    expect(lockSync.genName(42)).toBe('g000000000042');
  });

  it('C2 / L3: the listing after the take sees a larger generation and the take withdraws (end withdrawn), then takes the next', () => {
    const root = freshRoot('withdraw');
    const { genDir } = lockOf(root);
    const stages: string[] = [];
    let wrote = false;
    const r = lockSync.acquireMachineLockSync('x', {
      root,
      timeoutMs: 1000,
      pollMs: 10,
      hooks: {
        genDir,
        now: () => Date.now() + 11 * 60_000,
        onGenStage: (s: string) => {
          stages.push(s);
          if (s === 'gen-postlist' && !wrote) {
            wrote = true;
            writeGen(genDir, 2, { owner: { pid: deadPid(), token: 'L' } });
          }
        },
      },
    });
    expect(r.acquired).toBe(true);
    expect(stages).toContain('gen-withdraw-end');
    // g1 (withdrawn) is below the largest at the next listing and removed (C1); g2 (L, dead) ended; g3 is the take.
    expect(r.gen).toBe(3);
    expect(readGens(genDir).get(2)?.end?.split(' ')[0]).toBe('dead');
    expect(r.release()).toBe('released');
  });
});

describe('#4559 T4: the report of #4559 under the generation chain', () => {
  it('new × new: a recoverer stopped after judging the holder dead cannot move the next holder (closed)', async () => {
    // D (dead) holds g1. A judges it dead and stops right after (holder-judged). B — clock 70 s ahead,
    // so A's ticket is retired — takes: it judges g1 itself, ends it, takes g2 and holds. A resumes:
    // its `end` meets B's (EEXIST: the same, dead generation) and it never touches g2.
    const root = freshRoot('t4-new');
    prepare(root, 'dead-holder');
    const a = startActor(root, 'A', { pauses: ['holder-judged#1'], timeoutMs: 600 });
    expect(await until(() => a.reached('holder-judged#1'))).toBe(true);
    const b = startActor(root, 'B', { pauses: ['beacon-release#1'], timeoutMs: 2000, nowAheadMs: 70_000 });
    expect(await until(() => b.reached('beacon-release#1'))).toBe(true);
    a.go('holder-judged#1');
    expect(await a.exited).toBe(3); // not acquired: B holds
    expect(s2Violations(lockOf(root).genDir)).toEqual([]);
    b.go('beacon-release#1');
    expect(await b.exited).toBe(0);
    expect(s1Violations(allEvents(a, b))).toEqual([]);
    expectSettled(root);
  }, 20000);

  it('mixed (design §6.5 P-4): the successor is the develop copy (no generations) — the window is still there, by name', async () => {
    // The develop copy U takes the <lock> while the new recoverer N stops after judging the dead record
    // in it; N's re-read before the move sees U's record and leaves it (as on develop). The window that
    // stays is the one between that re-read and the rename (P-4): named, not closed by this PR.
    const root = freshRoot('t4-mixed');
    const { lockPath } = lockOf(root);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: deadPid(), host: HOST, token: 'D', acquiredAt: 0, v: 1 }));
    const legacy = await loadLegacy(root);
    let u: ReturnType<typeof legacy.acquireMachineLockSync> | null = null;
    const n = lockSync.acquireMachineLockSync('x', {
      lockPath,
      timeoutMs: 300,
      pollMs: 20,
      hooks: {
        genDir: lockOf(root).genDir,
        pidAlive: (pid: number) => {
          if (pid === deadPid() && u === null) u = legacy.acquireMachineLockSync('x', { lockPath, timeoutMs: 1000, pollMs: 10, hooks: { now: () => Date.now() + 65_000, startOf: () => 0 } });
          return pid !== deadPid();
        },
      },
    });
    expect(n.acquired).toBe(false);
    expect((u as { acquired: boolean } | null)?.acquired).toBe(true);
    // the older version holds the <lock>; the new one ended its generation at the beacon's deadline (released)
    expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).token).toBe((u as unknown as { token: string }).token);
    expect([...readGens(lockOf(root).genDir).values()].map((g) => g.end?.split(' ')[0])).toEqual(['released']);
    expect(legacyModule(root)).toMatch(/machine-lock-sync\.mjs$/);
  });
});

describe('#4559 P1 (#4559 comment 7183455133): the chain is chosen from the realpath, and a realpath that fails takes nothing', () => {
  // Through the real entry (no genDir): the same real directory named by its root (A) and by a path through a
  // symlinked parent (B) — the strings differ, the realpath does not. B's first realpath fails once (EIO).
  it('the failing poll takes nothing and names gen-realpath; while A holds, B makes no generation; after the retry both are one chain', () => {
    const base = freshRoot('p1');
    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    const a = lockSync.acquireMachineLockSync('x', { root: real, timeoutMs: 0 });
    expect(a.acquired).toBe(true);
    const chainA = lockSync.genDirOf(path.join(real, 'x.lock'));
    let calls = 0;
    const warnings: string[] = [];
    const b = lockSync.acquireMachineLockSync('x', {
      lockPath: path.join(link, 'x.lock'),
      timeoutMs: 300,
      pollMs: 10,
      warn: (l: string) => warnings.push(l),
      hooks: { fault: (p: string, _t: string, c: number) => (p === 'gen-realpath' && ++calls && c === 1 ? 'EIO' : undefined) },
    });
    expect(calls, 'the realpath is observed (the fault seam is reached)').toBeGreaterThanOrEqual(1);
    expect(b.acquired).toBe(false);
    expect(warnings.join('\n')).toContain('point=gen-realpath');
    // B made no generation anywhere but A's chain, and none in A's chain while A held (A's g1 is the largest, live)
    const byPath = path.join(lockSync.machineLockRootOf(), 'by-path');
    const literal = path.join(byPath, `${lockSync.byPathHash(`${link}/x.lock`)}.gen`);
    expect(fs.existsSync(literal), 'no chain from the literal path').toBe(false);
    expect([...readGens(chainA).keys()]).toEqual([a.gen]);
    expect(a.release()).toBe('released');
    // after the retry, B follows A's chain
    const b2 = lockSync.acquireMachineLockSync('x', { lockPath: path.join(link, 'x.lock'), timeoutMs: 500, pollMs: 10 });
    expect(b2.acquired).toBe(true);
    expect([...readGens(chainA).keys()].sort()).toContain(b2.gen);
    expect(b2.release()).toBe('released');
  });

  it('the generation directory is a test seam only: no caller in src/ or scripts/ passes one', () => {
    const files = ['src/lib/verification/machine-lock.ts', 'src/lib/agent-health/run-lock.ts', 'scripts/orchestrate/merge-pr.mjs', 'scripts/orchestrate/merge-train.mjs', 'scripts/orchestrate/precheck.mjs', 'scripts/flow/flow.mjs', 'src/lib/verification/gate-runner.ts'];
    // a value passed as genDir (an option or a hook): `genDir:` with a value, or the `genDir,` shorthand — a type (`genDir: string`) is not one
    const passes = /\bgenDir\s*:(?!\s*string\b)|\bgenDir\s*,/;
    expect(passes.test('acquireMachineLockSync(n, { genDir: x })')).toBe(true);
    for (const f of files) expect([f, passes.test(fs.readFileSync(path.join(path.resolve(__dirname, '../../..'), f), 'utf8'))]).toEqual([f, false]);
    // and the core reads it from the hooks (the test seams), never from the options a caller writes
    const core = fs.readFileSync(CORE, 'utf8');
    expect([...core.matchAll(/options\.genDir/g)].length).toBe(0);
    expect([...core.matchAll(/hooks\.genDir/g)].length).toBeGreaterThanOrEqual(1);
  });
});

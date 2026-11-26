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
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { main as mergePrMain, mergeLockName, readUnresolved } from '../../../scripts/orchestrate/merge-pr.mjs';
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
  s2AtWrite,
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
    // S2 at the time of each `end` (b P2-3), not who is alive now (both have exited).
    expect(s2AtWrite(lockOf(root).genDir, [a, b])).toEqual([]);
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
    const killedAt = a.kill();
    await a.exited;
    // 11 minutes ahead: the owner-less generation's grace (§4.4) and A's ticket are past.
    const b = startActor(root, 'B', { timeoutMs: 2000, nowAheadMs: 11 * 60_000 });
    expect(await b.exited, `B takes after A was killed at ${seam}`).toBe(0);
    const events = allEvents(a, b);
    expect(events.filter((e) => e.who === 'B').map((e) => e.event)).toEqual(['start', 'acquired', 'releasing', 'released']);
    // A, killed, holds nothing: its span ends at its death (before B started).
    expect(s1Violations(events, { A: killedAt })).toEqual([]);
    // S2 at the time of each `end` (b P2-3): A's life ends at its kill, B's at its release.
    expect(s2AtWrite(lockOf(root).genDir, [a, b])).toEqual([]);
    expectSettled(root);
  }, 20000);
});

/** The generation's observation points the core names (literal), and the GEN_WRITES table's. */
export function genPoints(source: string): string[] {
  const start = source.indexOf('// The generation chain (#4559');
  const end = source.indexOf('export function acquireMachineLockSync');
  const part = source.slice(start, end);
  const names = new Set<string>();
  // b P3-4: `obs.owner(` (a <lock>'s or a generation's owner) and `obs.text(` (a generation's fields) are reads too.
  for (const m of part.matchAll(/\bobs\.(?:pid|group|list|lstat|record|owner|text|realpath|mkdir|rename|rmdir|put|link|unlink)\('([a-z0-9-]+)'/g)) names.add(m[1]);
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
  'gen-fields-read': 'dead-holder',
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

// =====================================================================================================
// #4559 PR-2 r6: the review's findings, each a test first (red on 4ff5d12e2's core), then the fix.
// =====================================================================================================

/** Run `fn` with CM_VERIFY_LOCK_ROOT set to `root` (the core reads the machine-lock root from process.env). */
function withRoot<T>(root: string, fn: () => T): T {
  const was = process.env.CM_VERIFY_LOCK_ROOT;
  process.env.CM_VERIFY_LOCK_ROOT = root;
  try {
    return fn();
  } finally {
    process.env.CM_VERIFY_LOCK_ROOT = was;
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The same directory spelled with its last component's case swapped. */
const swapCase = (p: string): string => {
  const base = path.basename(p);
  return path.join(path.dirname(p), base === base.toUpperCase() ? base.toLowerCase() : base.toUpperCase());
};

/** Whether os.tmpdir() is on a filesystem that does not tell case apart (APFS's default): checked, never assumed. */
const CASE_INSENSITIVE = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gen-Case-'));
  try {
    return swapCase(d) !== d && fs.existsSync(swapCase(d));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

/** The `.gen` directories under `root` (a name's chain) and under `root/by-path` (a path's). */
const chainsOf = (root: string): { named: string[]; byPath: string[] } => {
  const named = fs.existsSync(root) ? fs.readdirSync(root).filter((e) => e.endsWith('.gen')).sort() : [];
  const bp = path.join(root, 'by-path');
  const byPath = fs.existsSync(bp) ? fs.readdirSync(bp).filter((e) => e.endsWith('.gen')).sort() : [];
  return { named, byPath };
};

describe('#4559 r6 C7-I1: one lock, one chain — the realpath compares the directory itself, not the spelling', () => {
  // On a filesystem that tells case apart the two spellings are two directories (two locks): nothing to compare.
  it.skipIf(!CASE_INSENSITIVE)('(case-insensitive FS only) A by name, B by a lockPath whose root is spelled in another case: B takes nothing, no second chain; after A, B takes on A\'s chain', () => {
    const base = freshRoot('i1');
    const locks = path.join(base, 'Locks');
    fs.mkdirSync(locks);
    const other = swapCase(locks);
    withRoot(locks, () => {
      const a = lockSync.acquireMachineLockSync('x', { root: locks, timeoutMs: 0 });
      expect(a.acquired).toBe(true);
      const b = lockSync.acquireMachineLockSync('x', { lockPath: path.join(other, 'x.lock'), timeoutMs: 200, pollMs: 10 });
      expect(b.acquired).toBe(false);
      expect(chainsOf(locks), 'only A\'s chain: no by-path made by B').toEqual({ named: ['x.gen'], byPath: [] });
      expect([...readGens(path.join(locks, 'x.gen')).keys()]).toEqual([a.gen]);
      expect(a.release()).toBe('released');
      const b2 = lockSync.acquireMachineLockSync('x', { lockPath: path.join(other, 'x.lock'), timeoutMs: 500, pollMs: 10 });
      expect(b2.acquired).toBe(true);
      expect([...readGens(path.join(locks, 'x.gen')).keys()]).toContain(b2.gen);
      expect(chainsOf(locks).byPath).toEqual([]);
      expect(b2.release()).toBe('released');
    });
  });

  it.skipIf(!CASE_INSENSITIVE)('(case-insensitive FS only) two writers whose CM_VERIFY_LOCK_ROOT differ in case only: one chain', () => {
    const base = freshRoot('i1-env');
    const locks = path.join(base, 'Locks');
    fs.mkdirSync(locks);
    const a = withRoot(locks, () => lockSync.acquireMachineLockSync('x', { root: locks, timeoutMs: 0 }));
    expect(a.acquired).toBe(true);
    const b = withRoot(swapCase(locks), () => lockSync.acquireMachineLockSync('x', { root: locks, timeoutMs: 200, pollMs: 10 }));
    expect(b.acquired).toBe(false);
    expect(chainsOf(locks)).toEqual({ named: ['x.gen'], byPath: [] });
    expect([...readGens(path.join(locks, 'x.gen')).keys()]).toEqual([a.gen]);
    expect(withRoot(locks, () => a.release())).toBe('released');
  });

  it.skipIf(!CASE_INSENSITIVE)('(case-insensitive FS only) a lock outside the root, its parent spelled other/x.lock and OTHER/x.lock: exactly one by-path chain', () => {
    const base = freshRoot('i1-other');
    const locks = path.join(base, 'locks');
    fs.mkdirSync(locks);
    const dir = path.join(base, 'other');
    fs.mkdirSync(dir);
    withRoot(locks, () => {
      const a = lockSync.acquireMachineLockSync('x', { lockPath: path.join(dir, 'x.lock'), timeoutMs: 0 });
      expect(a.acquired).toBe(true);
      const b = lockSync.acquireMachineLockSync('x', { lockPath: path.join(swapCase(dir), 'x.lock'), timeoutMs: 200, pollMs: 10 });
      expect(b.acquired).toBe(false);
      expect(chainsOf(locks).byPath).toHaveLength(1);
      expect(a.release()).toBe('released');
    });
  });
});

describe('#4559 r6 C7-I2: a root whose realpath is not resolved (unknown or absent) chooses no chain in that poll', () => {
  it.each(['ENOENT', 'EIO'])('the root\'s realpath (the 2nd gen-realpath) fails once with %s: no chain that poll, named, taken on the root\'s chain the next', (code) => {
    const root = freshRoot(`i2-${code}`);
    const warnings: string[] = [];
    let fired = 0;
    const r = withRoot(root, () =>
      lockSync.acquireMachineLockSync('x', {
        root,
        timeoutMs: 1000,
        pollMs: 10,
        warn: (l: string) => warnings.push(l),
        hooks: { fault: (p: string, t: string, c: number) => (p === 'gen-realpath' && c === 2 ? (fired++, expect(t).toBe(root), code) : undefined) },
      })
    );
    expect(fired, 'the root\'s realpath is reached').toBe(1);
    expect(r.acquired).toBe(true);
    expect(warnings.join('\n')).toContain(`machine-lock-unknown point=gen-realpath path=${root} errno=${code}`);
    expect(chainsOf(root), 'no by-path chosen while the root could not be seen').toEqual({ named: ['x.gen'], byPath: [] });
    expect([...readGens(path.join(root, 'x.gen')).keys()]).toEqual([r.gen]);
    expect(withRoot(root, () => r.release())).toBe('released');
  });

  it.skipIf(process.getuid?.() === 0)('on the real filesystem: a CM_VERIFY_LOCK_ROOT that does not exist (and cannot be made) — not taken, named, no chain made', () => {
    const base = freshRoot('i2-fs');
    const ro = path.join(base, 'ro');
    fs.mkdirSync(ro);
    const envRoot = path.join(ro, 'locks');
    const dir = path.join(base, 'here');
    fs.mkdirSync(dir);
    fs.chmodSync(ro, 0o555);
    const warnings: string[] = [];
    try {
      let r: ReturnType<typeof lockSync.acquireMachineLockSync> | null = null;
      let thrown: unknown = null;
      try {
        r = withRoot(envRoot, () => lockSync.acquireMachineLockSync('x', { lockPath: path.join(dir, 'x.lock'), timeoutMs: 100, pollMs: 10, warn: (l: string) => warnings.push(l) }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, 'an observation that failed is not thrown').toBeNull();
      expect(r?.acquired).toBe(false);
      expect(warnings.join('\n')).toContain(`machine-lock-unknown point=gen-realpath path=${envRoot} errno=ENOENT`);
      expect(fs.existsSync(envRoot)).toBe(false);
      expect(fs.readdirSync(dir).filter((e) => e.endsWith('.gen'))).toEqual([]);
    } finally {
      fs.chmodSync(ro, 0o755);
    }
  });
});

describe('#4559 r6 C7-I3: with the chain unknown, the heads that do not take end nothing and make nothing', () => {
  it.each([
    ['releaseAsHead', 1, 'EIO'],
    ['releaseAsHead', 2, 'ENOENT'],
    ['recoverIfDead', 1, 'EIO'],
    ['recoverIfDead', 2, 'ENOENT'],
  ])('%s with gen-realpath #%s failing (%s): the dead holding\'s generation gets no end, no .gen is made', (fn, at, code) => {
    const root = freshRoot('i3');
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: deadPid(), token: 'T' } });
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: deadPid(), host: HOST, token: 'T', acquiredAt: 0, v: 1, g: 1 }));
    let fired = 0;
    const hooks = { fault: (p: string, _t: string, c: number) => (p === 'gen-realpath' && c === at ? (fired++, code) : undefined) };
    withRoot(root, () => (fn === 'releaseAsHead' ? lockSync.releaseAsHead(lockPath, ['T'], { timeoutMs: 0, hooks }) : lockSync.recoverIfDead(lockPath, { timeoutMs: 0, hooks })));
    expect(fired).toBe(1);
    expect(readGens(genDir).get(1)?.end ?? null).toBeNull();
    expect(chainsOf(root)).toEqual({ named: ['x.gen'], byPath: [] });
    expect(fs.readdirSync(genDir)).toEqual([lockSync.genName(1)]);
  });
});

describe('#4559 r6 a P1-1: the holder handed to the recovery and to held-by carries the fields last', () => {
  it('merge-pr\'s holder killed after phase(merge): the next merge-pr keeps its write as unconfirmed (the stop of the next runs)', async () => {
    const base = freshRoot('p11');
    const lockRoot = path.join(base, 'locks');
    fs.mkdirSync(lockRoot);
    const runDir = path.join(base, 'runs');
    const wt = path.join(base, 'wt');
    fs.mkdirSync(wt);
    const LOCK = mergeLockName('Kewton/CommandMate', 'develop');
    const ready = path.join(base, 'ready');
    // A: merge-pr's acquisition (ownerFields phase idle), then phase('merge') (setOwnerFields), then killed.
    const a = startActor(lockRoot, 'A', {
      name: LOCK,
      realChain: true,
      holdMs: 60_000,
      timeoutMs: 3000,
      ownerFields: { phase: 'idle', repo: 'Kewton/CommandMate', base: 'develop' },
      fields: { phase: 'merge', entry: '5000', issue: 5000, pr: 5001 },
      ready,
    });
    expect(await until(() => fs.existsSync(ready))).toBe(true);
    expect(a.events().find((e) => e.event === 'fields')).toMatchObject({ ok: true });
    // held by, while A lives: the phase the fields say
    const holder = withRoot(lockRoot, () => lockSync.readHolder(lockSync.lockPathOf(lockRoot, LOCK)));
    expect(holder).toMatchObject({ phase: 'merge', pr: 5001 });
    a.kill();
    await a.exited;
    const logs: string[] = [];
    withRoot(lockRoot, () => {
      try {
        mergePrMain(['--run-dir', runDir, '--issues', '4245-5001', '--issue', '4245', '--worktree', wt, '--merge-lock-timeout', '5'], {
          run: () => {
            throw new Error('the merge itself is not this test\'s');
          },
          sleep: () => {},
          lockRoot,
          findTestsNaming: () => [],
          log: (l: string) => logs.push(l),
          error: (l: string) => logs.push(l),
        });
      } catch {
        // mergeOne's first git call throws: the lock part has run
      }
    });
    expect(logs.join('\n')).toContain('recovered the merge lock of a dead holder #5000 (pr=#5001) phase=merge — its write is unconfirmed');
    expect(readUnresolved(lockRoot, LOCK).map((u: { owner: { phase: string; pr: number } }) => [u.owner.phase, u.owner.pr])).toEqual([['merge', 5001]]);
  }, 20000);

  it('the fields read failing once (EIO): no recovery that poll (the write is not dropped as idle), recovered with the fields the next', () => {
    const root = freshRoot('p11-eio');
    const { genDir } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: deadPid(), token: 'D', phase: 'idle' } });
    fs.writeFileSync(path.join(genDir, lockSync.genName(1), 'fields'), JSON.stringify({ phase: 'merge', pr: 5001 }));
    const seen: { phase?: string }[] = [];
    let fired = 0;
    const r = withRoot(root, () =>
      lockSync.acquireMachineLockSync('x', {
        root,
        timeoutMs: 1000,
        pollMs: 10,
        onStaleHolder: (o: { phase?: string }) => seen.push(o),
        hooks: { fault: (p: string, _t: string, c: number) => (p === 'gen-fields-read' && c === 1 ? (fired++, 'EIO') : undefined) },
      })
    );
    expect(fired, 'the fields read is an observation point (gen-fields-read)').toBe(1);
    expect(r.acquired).toBe(true);
    expect(seen.map((o) => o.phase)).toEqual(['merge']);
    expect(withRoot(root, () => r.release())).toBe('released');
  });
});

describe('#4559 r6 a P1-3 (S4): the release\'s end is written even when its tmp failed once', () => {
  it('(a) a tmp of the end left by a failed write (EEXIST on the same name) does not keep the end from being written', () => {
    const root = freshRoot('p13a');
    const { genDir } = lockOf(root);
    let token = '';
    const r = lockSync.acquireMachineLockSync('x', {
      root,
      timeoutMs: 500,
      hooks: {
        genDir,
        // the tmp a write that failed after its open leaves (the name 4ff5d12e2 reuses on every try)
        onGenStage: (s: string) => {
          if (s === 'beacon-release') fs.writeFileSync(path.join(`${genDir}.tmp`, `${token}.${lockSync.genName(1)}.end-released`), 'rel');
        },
      },
    });
    token = r.token as string;
    let answer: string | null = null;
    for (let i = 0; i < 3 && answer !== 'released'; i++) {
      try {
        answer = r.release();
      } catch {
        answer = null;
      }
    }
    expect(answer).toBe('released');
    expect(readGens(genDir).get(1)?.end?.split(' ')[0]).toBe('released');
  });

  it('(a) the end tmp\'s write fails once (EIO, gen-tmp-write): the release throws, the next try writes the end', () => {
    const root = freshRoot('p13a-eio');
    const { genDir } = lockOf(root);
    let fired = 0;
    let releasing = false;
    const r = lockSync.acquireMachineLockSync('x', {
      root,
      timeoutMs: 500,
      hooks: {
        genDir,
        onGenStage: (s: string) => {
          if (s === 'beacon-release') releasing = true;
        },
        fault: (p: string) => (p === 'gen-tmp-write' && releasing && fired === 0 ? (fired++, 'EIO') : undefined),
      },
    });
    expect(r.acquired).toBe(true);
    expect(() => r.release()).toThrow(/EIO/);
    expect(fired).toBe(1);
    expect(r.release()).toBe('released');
    expect(readGens(genDir).get(1)?.end?.split(' ')[0]).toBe('released');
  });

  it('(b) stopped at end-tmp while another head cleans the tmp by its age: released only once the end is there', () => {
    const root = freshRoot('p13b');
    const { genDir } = lockOf(root);
    let cleaned: boolean | null = null;
    const r = lockSync.acquireMachineLockSync('x', {
      root,
      timeoutMs: 500,
      hooks: {
        genDir,
        onGenStage: (s: string) => {
          if (s !== 'end-tmp' || cleaned !== null) return;
          // B, 11 minutes ahead: A's tmp is past C8's age; B lists, cleans it, and finds A's generation live (busy)
          const b = lockSync.acquireMachineLockSync('x', { root, timeoutMs: 0, hooks: { genDir, now: () => Date.now() + 11 * 60_000, startOf: () => 0 } });
          cleaned = !b.acquired && fs.readdirSync(`${genDir}.tmp`).length === 0;
        },
      },
    });
    expect(r.release()).toBe('released');
    expect(cleaned, 'B removed A\'s tmp while A stopped').toBe(true);
    expect(readGens(genDir).get(1)?.end?.split(' ')[0]).toBe('released');
  });
});

describe('#4559 r6 a P2-1 (§4.1): every way out after the owner is published ends the own generation (withdrawn)', () => {
  it.each(['gen-owner-linked', 'gen-postlist'])('a hook that throws at %s: the acquisition throws, its generation is ended withdrawn', (stage) => {
    const root = freshRoot(`p21-${stage}`);
    const { genDir } = lockOf(root);
    expect(() =>
      lockSync.acquireMachineLockSync('x', {
        root,
        timeoutMs: 500,
        hooks: {
          genDir,
          onGenStage: (s: string) => {
            if (s === stage) throw new Error(`thrown at ${s}`);
          },
        },
      })
    ).toThrow(`thrown at ${stage}`);
    expect(readGens(genDir).get(1)?.end?.split(' ')[0]).toBe('withdrawn');
  });

  /** A live holder of the <lock> of an older version (no g): the acquisition takes its generation and waits (yields). */
  const liveBeacon = (lockPath: string) => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: process.pid, host: HOST, token: 'L', acquiredAt: 0, v: 1 }));
  };

  it('the sleep outside the steps throws while the generation is held and the <lock> waited for: withdrawn, the ticket done', () => {
    const root = freshRoot('p21-sleep');
    const { genDir, lockPath, queue } = lockOf(root);
    liveBeacon(lockPath);
    expect(() =>
      lockSync.acquireMachineLockSync('x', {
        root,
        timeoutMs: 1000,
        pollMs: 10,
        sleep: () => {
          throw new Error('the sleep threw');
        },
        hooks: { genDir },
      })
    ).toThrow('the sleep threw');
    expect(readGens(genDir).get(1)?.end?.split(' ')[0]).toBe('withdrawn');
    const tickets = fs.readdirSync(queue).filter((e) => lockSync.TICKET_PATTERN.test(e));
    expect(tickets.map((t) => JSON.parse(fs.readFileSync(path.join(queue, t), 'utf8')).done)).toEqual([true]);
  });

  it('the generator closed with return() at its wait: withdrawn', () => {
    const root = freshRoot('p21-return');
    const { genDir, lockPath } = lockOf(root);
    liveBeacon(lockPath);
    const steps = lockSync.machineLockAcquisition('x', { root, timeoutMs: 1000, pollMs: 10, hooks: { genDir } });
    const first = steps.next();
    expect(first.done).toBe(false);
    expect(readGens(genDir).get(1)?.end ?? null, 'the generation is held while it waits').toBeNull();
    steps.return(undefined as never);
    expect(readGens(genDir).get(1)?.end?.split(' ')[0]).toBe('withdrawn');
  });
});

describe('#4559 r6 a P2-3 (§4.6 / §4.2): a second hand-off, and a release that judges every handed group', () => {
  it('A → B → C: owner.h2 is added; C alone ends — B\'s live group keeps the holding and the <lock>; both gone — released', async () => {
    const root = freshRoot('p23');
    const { genDir, lockPath } = lockOf(root);
    const kids = [0, 1].map(() => spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }));
    const exits = kids.map((k) => new Promise<void>((resolve) => k.on('exit', () => resolve())));
    try {
      const [b, c] = kids.map((k) => k.pid as number);
      const r = withRoot(root, () => lockSync.acquireMachineLockSync('x', { root, timeoutMs: 0, hooks: { genDir } }));
      expect(r.acquired).toBe(true);
      const h1 = r.handOff(b, b);
      expect(h1).toMatchObject({ ok: true });
      const h2 = r.handOff(c, c);
      expect(h2).toMatchObject({ ok: true });
      const g = readGens(genDir).get(r.gen as number);
      expect(g?.records.map((x) => x.pid)).toEqual([process.pid, b, c]);
      const tokens = [r.token as string, (h1 as { token: string }).token, (h2 as { token: string }).token];
      expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).token).toBe(tokens[2]);
      // C ends; B lives
      kids[1].kill('SIGKILL');
      await exits[1];
      const first = r.release();
      expect(first).not.toBe('released');
      // D5 as UAT's down does it: the holder (A, this process) is stopped first — read dead here — and B, C decide.
      const aStopped = { genDir, pidAlive: (pid: number) => pid !== process.pid && isAlive(pid) };
      const asHead = withRoot(root, () => lockSync.releaseAsHead(lockPath, tokens, { timeoutMs: 0, hooks: aStopped }));
      expect(asHead.result, 'B\'s group is alive: the holding is kept').toBe('deferred');
      expect(readGens(genDir).get(r.gen as number)?.end ?? null).toBeNull();
      expect(fs.existsSync(path.join(lockPath, 'owner')), 'the <lock> stays for the older readers while B lives').toBe(true);
      // B ends too
      kids[0].kill('SIGKILL');
      await exits[0];
      const done = withRoot(root, () => lockSync.releaseAsHead(lockPath, tokens, { timeoutMs: 0, hooks: aStopped }));
      expect(done.result).toBe('released');
      expect(readGens(genDir).get(r.gen as number)?.end?.split(' ')[0]).toBe('dead');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      for (const k of kids) k.kill('SIGKILL');
    }
  }, 20000);
});

describe('#4559 r6 b P2-3: S2 is judged at the time each end was written', () => {
  it('self-test: a copy of the core whose judgement reads every holder dead ends A\'s live generation — the oracle after both exited (s2Violations) is green, s2AtWrite is red', async () => {
    const root = freshRoot('s2-self');
    const { genDir } = lockOf(root);
    const core = fs.readFileSync(CORE, 'utf8');
    const line = '        const holder = genHolderState(g, record);';
    expect(core.split(line).length - 1, 'the judgement\'s line, once').toBe(1);
    const broken = path.join(root, 'machine-lock-sync-all-dead.mjs');
    fs.writeFileSync(broken, core.replace(line, "        const holder = { state: 'gone' };"));
    const a = startActor(root, 'A', { holdMs: 1500, timeoutMs: 2000 });
    expect(await until(() => a.events().some((e) => e.event === 'acquired'))).toBe(true);
    const b = startActor(root, 'B', { module: broken, timeoutMs: 300, nowAheadMs: 70_000 });
    await a.exited;
    await b.exited;
    expect(readGens(genDir).get(1)?.end?.split(' ')[0], 'B ended A\'s generation').toBe('dead');
    expect(s2Violations(genDir), 'the oracle of who is alive now: everyone has exited').toEqual([]);
    expect(s2AtWrite(genDir, [a, b]), 'the oracle at the write').toEqual([1]);
  }, 20000);
});

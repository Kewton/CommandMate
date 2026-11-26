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
  const a = startActor(root, 'A', { pauses: [...pre, `${seam}#1`, ...extraPauses], timeoutMs: 800, seams: true, ...actorOptions(setup) });
  if (setup === 'larger-later') {
    expect(await until(() => a.reached('gen-postlist#1'))).toBe(true);
    writeGen(lockOf(root).genDir, 2, { owner: { pid: deadPid(), token: 'L' } });
    a.go('gen-postlist#1');
  }
  return a;
}

const STOP_SEAMS = Object.keys(SEAM_SETUP).filter((s) => SEAM_SETUP[s] !== 'publish-fails');

/**
 * b P2-2: for each stop row, the times A and B reached the seam and who took (`AB`: A, then B; `-`: nobody).
 * Measured, then fixed here; a row whose crossing changes is red. Where B reaches 0, why is in UNCROSSED.
 * #4559 r7 (b2 P2-3): `crossed` — B stopped at the seam while A still stopped there (A stops → B stops → A resumes),
 * from the order recorded as it happened. A crossing row whose B came after A is red.
 */
const CROSS: Record<string, { a: number; b: number; took: string; crossed: boolean }> = {
  'beacon-prev-judged': { a: 1, b: 0, took: 'B', crossed: false },
  'beacon-release': { a: 1, b: 1, took: 'AB', crossed: false },
  'end-linked': { a: 2, b: 1, took: 'AB', crossed: true },
  'end-tmp': { a: 2, b: 2, took: 'AB', crossed: true },
  'fields-rename': { a: 1, b: 1, took: 'AB', crossed: false },
  'gc-judged': { a: 1, b: 2, took: 'AB', crossed: true },
  'gc-rm': { a: 1, b: 2, took: 'AB', crossed: true },
  'gc-tmp-rm': { a: 1, b: 1, took: 'AB', crossed: true },
  'gen-dir-mkdir': { a: 1, b: 1, took: 'AB', crossed: true },
  'gen-end-read': { a: 1, b: 2, took: 'AB', crossed: true },
  'gen-handoff-tmp': { a: 1, b: 1, took: 'AB', crossed: false },
  'gen-list': { a: 2, b: 1, took: 'AB', crossed: true },
  'gen-mkdir': { a: 1, b: 2, took: 'AB', crossed: true },
  'gen-owner-linked': { a: 1, b: 1, took: 'AB', crossed: false },
  'gen-owner-tmp': { a: 1, b: 1, took: 'AB', crossed: false },
  'gen-parent-mkdir': { a: 1, b: 1, took: 'AB', crossed: true },
  'gen-postlist': { a: 1, b: 1, took: 'AB', crossed: false },
  'gen-tmp-mkdir': { a: 2, b: 2, took: 'AB', crossed: false },
  'gen-withdraw-end': { a: 1, b: 0, took: 'AB', crossed: false },
  'handoff-linked': { a: 1, b: 1, took: 'AB', crossed: false },
  'holder-judged': { a: 1, b: 1, took: 'AB', crossed: true },
  'holder-read': { a: 1, b: 1, took: 'AB', crossed: true },
  'holder-relist': { a: 1, b: 1, took: 'AB', crossed: true },
  'ownerless-judged': { a: 1, b: 1, took: 'AB', crossed: true },
  'release-end': { a: 1, b: 1, took: 'AB', crossed: false },
  'tomb-end': { a: 1, b: 0, took: 'AB', crossed: false },
  'tomb-linked': { a: 1, b: 0, took: 'AB', crossed: false },
  'tomb-tmp': { a: 1, b: 1, took: 'AB', crossed: true },
};

/** The rows where B never reaches the seam, or reaches it only after A (not crossed), and why (named, not dropped: b P2-2, b2 P2-3). */
const UNCROSSED: Record<string, string> = {
  'beacon-prev-judged': 'the earlier generation\'s <lock> is A\'s to judge; once A recovered it there is none for B (A, its ticket retired by B, waits behind B and gives up: B takes)',
  'gen-withdraw-end': 'only A meets a larger generation (written at A\'s gen-postlist by the test)',
  'tomb-linked': 'the owner-less generation is A\'s to tomb; after A, B finds it ended',
  'tomb-end': 'the owner-less generation is A\'s to tomb; after A, B finds it ended',
  // #4559 r7 (b2 P2-3): B reaches these only after A lets go — measured with the order recorded as it happened
  'gen-tmp-mkdir': 'A made its g<N> and stops before its owner is linked: B reads an owner-less generation inside its grace (young) and waits; the seam is B\'s after A',
  'gen-owner-tmp': 'A made its g<N> and stops before its owner is linked: B reads an owner-less generation inside its grace (young) and waits; the seam is B\'s after A',
  'gen-owner-linked': 'A\'s owner is linked and A lives: B waits for the live holder (S1); the seam is B\'s after A',
  'gen-postlist': 'A\'s owner is linked and A lives: B waits for the live holder (S1); the seam is B\'s after A',
  'gen-handoff-tmp': 'a seam of a holding: B reaches it only as the next holder, after A (S1)',
  'handoff-linked': 'a seam of a holding: B reaches it only as the next holder, after A (S1)',
  'fields-rename': 'a seam of a holding: B reaches it only as the next holder, after A (S1)',
  'beacon-release': 'a seam of a holding: B reaches it only as the next holder, after A (S1)',
  'release-end': 'a seam of a holding: B reaches it only as the next holder, after A (S1)',
};

describe('#4559 T2: the crossing table', () => {
  it('names every stop row, and every row where B reaches 0 is named with its reason', () => {
    expect(Object.keys(CROSS).sort()).toEqual([...STOP_SEAMS].sort());
    expect(Object.keys(CROSS).filter((s) => CROSS[s].b === 0).every((s) => s in UNCROSSED)).toBe(true);
    expect(Object.values(CROSS).every((r) => r.a >= 1 && r.took !== '-')).toBe(true);
    // b2 P2-3: the rows not crossed are exactly the ones B does not reach while A stops, each named with its reason
    expect(Object.keys(CROSS).filter((s) => !CROSS[s].crossed).sort()).toEqual(Object.keys(UNCROSSED).sort());
  });
});

describe('#4559 T2: A stopped at each seam, B at the same seam (the crossing order)', () => {
  it.each(STOP_SEAMS)('stop at %s: S1 and S2 hold, and all settles', async (seam) => {
    const setup = SEAM_SETUP[seam];
    const root = freshRoot(`stop-${seam}`);
    prepare(root, setup);
    const a = await bringTo(root, seam, setup);
    expect(await until(() => a.reached(`${seam}#1`)), `A reaches ${seam}`).toBe(true);
    // B's clock is 70 s ahead: A's ticket is past its deadline + 60 s, so B is the head while A stops.
    // B has the same options as A (hand-off, fields), so the seams of a holding are within its reach too (b P2-2).
    // B waits out A's stop (5 s): a seam B meets only as a holder is reached after A lets go.
    const b = startActor(root, 'B', { pauses: [`${seam}#1`], timeoutMs: 5000, nowAheadMs: 70_000, seams: true, ...actorOptions(setup) });
    let bExited = false;
    void b.exited.then(() => (bExited = true));
    let aExited = false;
    void a.exited.then(() => (aExited = true));
    // b2 P2-3 (#4559 comment 7185752051): the order is recorded as it happens — a crossing row waits for B to stop
    // while A still stops (long enough under load), and a run where B came after A is red, not green.
    const order: string[] = ['A stopped'];
    await until(() => bExited || b.reached(`${seam}#1`), CROSS[seam]?.crossed ? 8000 : 1000);
    if (b.reached(`${seam}#1`)) order.push('B stopped');
    if (aExited || !a.reached(`${seam}#1`)) order.push('A not stopped');
    expect(s2Violations(lockOf(root).genDir), 'S2 while A and B stop').toEqual([]);
    order.push('A resumed');
    a.go(`${seam}#1`);
    await until(() => aExited || bExited, 3000);
    b.go(`${seam}#1`);
    await a.exited;
    await b.exited;
    expect(s1Violations(allEvents(a, b))).toEqual([]);
    // b P2-2 (the rule of #4559 comment 7185752051): how many times each actor reached the seam, and who took.
    const took = (x: typeof a) => x.events().some((e) => e.event === 'acquired');
    const crossed = order.join(' → ') === 'A stopped → B stopped → A resumed';
    const observed = { a: a.seamCount(seam), b: b.seamCount(seam), took: [a, b].filter(took).map((x) => x.who).join('') || '-', crossed };
    if (process.env.CM_T2_RECORD) fs.appendFileSync(process.env.CM_T2_RECORD, `${JSON.stringify({ seam, ...observed })}\n`);
    expect(observed).toEqual(CROSS[seam]);
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
  // #4559 r7 (a2 P3-6, PM's disposition 4): the root's mkdir and the parent of .gen (by-path/) are observed
  'gen-root-mkdir': 'fresh',
  'gen-parent-mkdir': 'fresh',
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
    hooks: { fault, now: () => Date.now() + 11 * 60_000, startOf: () => 0, ...(point === 'gen-realpath' || point === 'gen-root-mkdir' ? {} : { genDir }) },
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

  it.each(['gen-realpath', 'gen-root-mkdir', 'gen-parent-mkdir', 'gen-list', 'gen-mkdir', 'gen-postlist', 'holder-read', 'holder-pid', 'end-link', 'tomb-link', 'gen-end-read'])('%s: an EIO that goes on — not taken, and the holder\'s generation not ended', (point) => {
    const setup = POINT_SETUP[point];
    const root = freshRoot(`eio-on-${point}`);
    prepare(root, setup);
    const before = readGens(lockOf(root).genDir);
    let fired = 0;
    const { r } = takeWith(root, setup, (p) => (p === point ? (fired++, 'EIO') : undefined), 200, point);
    // b2 P3-2 (the rule of #4559 comment 7185752051): the point is reached — not held back by another one
    expect(fired, `the point ${point} is reached`).toBeGreaterThanOrEqual(1);
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

describe('#4559 r6 C7-I1 / D2 (#4559 comment 7186934798): the base name is always folded to lower case', () => {
  // The human's answer: by-path's hash and the named chain take the base name in lower case — never the entry's
  // spelling, no check of the FS. A case-insensitive FS: X.lock and x.lock are one lock, one chain even before it
  // exists. A case-sensitive FS: two locks that differ in case only share one chain and wait for each other (named).
  it('genDirOf: X.lock and x.lock (neither there) are one chain, by path and by name', () => {
    const base = freshRoot('d2-fold');
    const env = { CM_VERIFY_LOCK_ROOT: path.join(base, 'locks') } as unknown as NodeJS.ProcessEnv;
    const dir = path.join(base, 'other');
    fs.mkdirSync(dir);
    expect(lockSync.genDirOf(path.join(dir, 'X.lock'), env)).toBe(lockSync.genDirOf(path.join(dir, 'x.lock'), env));
    const locks = path.join(base, 'locks');
    expect(lockSync.genDirOf(lockSync.lockPathOf(locks, 'X'), env)).toBe(path.join(locks, 'x.gen'));
  });

  it.skipIf(!CASE_INSENSITIVE)('(case-insensitive FS only) A on other/X.lock stops after publishing its generation, before the <lock> is there; B on other/x.lock chooses the same chain and takes nothing', async () => {
    const base = freshRoot('d2-ci');
    const locks = path.join(base, 'locks');
    fs.mkdirSync(locks);
    const dir = path.join(base, 'other');
    fs.mkdirSync(dir);
    const a = startActor(dir, 'A', { name: 'X', realChain: true, envRoot: locks, pauses: ['gen-owner-linked#1'], seams: true, timeoutMs: 5000 });
    expect(await until(() => a.reached('gen-owner-linked#1'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'X.lock')), 'the <lock> is not there yet').toBe(false);
    const bStages: string[] = [];
    const b = withRoot(locks, () =>
      lockSync.acquireMachineLockSync('x', { lockPath: path.join(dir, 'x.lock'), timeoutMs: 300, pollMs: 10, hooks: { now: () => Date.now() + 70_000, startOf: () => 0, onGenStage: (s: string) => bStages.push(s) } })
    );
    a.go('gen-owner-linked#1');
    expect(await a.exited).toBe(0);
    // reached and taken, per actor (#4559 comment 7185752051): A at the seam once and took; B listed the chain and took nothing
    expect({ a: a.seamCount('gen-owner-linked'), aTook: a.events().some((e) => e.event === 'acquired'), bListed: bStages.filter((s) => s === 'gen-list').length > 0, bTook: b.acquired }).toEqual({ a: 1, aTook: true, bListed: true, bTook: false });
    expect(chainsOf(locks).byPath, 'one chain for the two spellings').toHaveLength(1);
  }, 20000);

  it.skipIf(CASE_INSENSITIVE)('(case-sensitive FS only) other/x.lock and other/X.lock are two locks that share one chain: while A holds one, B waits on the other (named, the decision\'s cost)', () => {
    const base = freshRoot('d2-cs');
    const locks = path.join(base, 'locks');
    fs.mkdirSync(locks);
    const dir = path.join(base, 'other');
    fs.mkdirSync(dir);
    withRoot(locks, () => {
      const a = lockSync.acquireMachineLockSync('x', { lockPath: path.join(dir, 'x.lock'), timeoutMs: 0 });
      const b = lockSync.acquireMachineLockSync('x', { lockPath: path.join(dir, 'X.lock'), timeoutMs: 200, pollMs: 10 });
      expect([a.acquired, b.acquired]).toEqual([true, false]);
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
      // #4559 r7 (PM's disposition 4): the mkdir that failed is named by its own point, not as gen-realpath ENOENT
      expect(warnings.join('\n')).toContain(`machine-lock-unknown point=gen-root-mkdir path=${envRoot} errno=EACCES`);
      expect(warnings.join('\n')).not.toContain('point=gen-realpath');
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
    const r = withRoot(root, () => (fn === 'releaseAsHead' ? lockSync.releaseAsHead(lockPath, ['T'], { timeoutMs: 0, hooks }) : lockSync.recoverIfDead(lockPath, { timeoutMs: 0, hooks })));
    expect(fired).toBe(1);
    expect(readGens(genDir).get(1)?.end ?? null).toBeNull();
    expect(chainsOf(root)).toEqual({ named: ['x.gen'], byPath: [] });
    expect(fs.readdirSync(genDir)).toEqual([lockSync.genName(1)]);
    // #4559 r7 (a2 P2-1 = b2 P2-2): the poll whose chain is unknown answers so, named — and the <lock> stays as it was
    expect({ result: r.result, point: r.unknown?.point, code: r.unknown?.code }).toEqual({ result: fn === 'releaseAsHead' ? 'deferred' : 'kept', point: 'gen-realpath', code });
    expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).token).toBe('T');
  });

  it.each(['releaseAsHead', 'recoverIfDead'])('%s, a2\'s order (A → B → C, C dead, B alive) with gen-realpath failing (EIO): the <lock> stays while B\'s group lives', async (fn) => {
    const root = freshRoot('i3-abc');
    const { genDir, lockPath } = lockOf(root);
    const b = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      const bPid = b.pid as number;
      writeGen(genDir, 1, { owner: { pid: deadPid(), token: 'T' }, handoffs: [{ pid: bPid, pgid: bPid, token: 'HB' }, { pid: deadPid(), token: 'HC' }] });
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: deadPid(), host: HOST, token: 'HC', acquiredAt: 0, v: 1, g: 1 }));
      let fired = 0;
      const hooks = { fault: (p: string) => (p === 'gen-realpath' ? (fired++, 'EIO') : undefined) };
      const r = withRoot(root, () => (fn === 'releaseAsHead' ? lockSync.releaseAsHead(lockPath, ['T', 'HB', 'HC'], { timeoutMs: 0, hooks }) : lockSync.recoverIfDead(lockPath, { timeoutMs: 0, hooks })));
      expect(fired).toBeGreaterThanOrEqual(1);
      expect({ result: r.result, point: r.unknown?.point }).toEqual({ result: fn === 'releaseAsHead' ? 'deferred' : 'kept', point: 'gen-realpath' });
      expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).token).toBe('HC');
      expect(readGens(genDir).get(1)?.end ?? null).toBeNull();
      // the chain seen again (no fault): B is alive — still kept, by the holding's every record (§4.2, D6 too)
      const again = withRoot(root, () => (fn === 'releaseAsHead' ? lockSync.releaseAsHead(lockPath, ['T', 'HB', 'HC'], { timeoutMs: 0 }) : lockSync.recoverIfDead(lockPath, { timeoutMs: 0 })));
      expect(again.result).toBe(fn === 'releaseAsHead' ? 'deferred' : 'kept');
      expect(fs.existsSync(path.join(lockPath, 'owner'))).toBe(true);
      expect(readGens(genDir).get(1)?.end ?? null).toBeNull();
    } finally {
      b.kill('SIGKILL');
    }
  });
});

describe('#4559 r7 (a2 P2-2 = b2 P2-1, §4.2): releaseAsHead judges every record of the holding, the first owner too', () => {
  it('the first owner alive (another process), its hand-off (the <lock>\'s record) dead: deferred, the <lock> and the generation stay', () => {
    const root = freshRoot('p42-first');
    const { genDir, lockPath } = lockOf(root);
    const a = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      const aPid = a.pid as number;
      writeGen(genDir, 1, { owner: { pid: aPid, token: 'T' }, handoffs: [{ pid: deadPid(), token: 'HB' }] });
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: deadPid(), host: HOST, token: 'HB', acquiredAt: 0, v: 1, g: 1 }));
      const warnings: string[] = [];
      let pids = 0;
      const r = withRoot(root, () => lockSync.releaseAsHead(lockPath, ['T', 'HB'], { timeoutMs: 0, warn: (l: string) => warnings.push(l), hooks: { fault: (p: string) => (p === 'holder-pid' ? (pids++, undefined) : undefined) } }));
      expect(r.result).toBe('deferred');
      expect(pids, 'the first owner and the hand-off are judged').toBeGreaterThanOrEqual(1);
      expect(warnings.join('\n')).toContain(`alive: pid ${aPid}`);
      expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).token).toBe('HB');
      expect(readGens(genDir).get(1)?.end ?? null).toBeNull();
      const d6 = withRoot(root, () => lockSync.recoverIfDead(lockPath, { timeoutMs: 0 }));
      expect(d6.result).toBe('kept');
      expect(fs.existsSync(path.join(lockPath, 'owner'))).toBe(true);
    } finally {
      a.kill('SIGKILL');
    }
  });

  it('the caller itself is the first owner (D12\'s rule: its own record), its hand-off dead: released, and the end with it', () => {
    const root = freshRoot('p42-self');
    const { genDir, lockPath } = lockOf(root);
    const dead = deadPid();
    const r = withRoot(root, () => lockSync.acquireMachineLockSync('x', { root, timeoutMs: 0 }));
    expect(r.acquired).toBe(true);
    expect(r.handOff(dead, dead)).toMatchObject({ ok: true });
    expect(withRoot(root, () => r.release())).toBe('needs-head');
    const asHead = withRoot(root, () => lockSync.releaseAsHead(lockPath, [r.token as string, `${r.token}-g${dead}`], { timeoutMs: 0 }));
    expect(asHead.result).toBe('released');
    expect(fs.existsSync(lockPath)).toBe(false);
    // the <lock>'s judgement and the end's are one (§4.2): released only with its end
    expect(readGens(genDir).get(r.gen as number)?.end?.split(' ')[0]).toBe('dead');
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
      // D5 by the holder itself after its needs-head (#4559 r7, §4.2): every record of the holding is judged — the first
      // owner (A, this process) by D12's rule (its own record), B and C by their pid and group. No hook reads A dead.
      const aSelf = { genDir };
      const asHead = withRoot(root, () => lockSync.releaseAsHead(lockPath, tokens, { timeoutMs: 0, hooks: aSelf }));
      expect(asHead.result, 'B\'s group is alive: the holding is kept').toBe('deferred');
      expect(readGens(genDir).get(r.gen as number)?.end ?? null).toBeNull();
      expect(fs.existsSync(path.join(lockPath, 'owner')), 'the <lock> stays for the older readers while B lives').toBe(true);
      // B ends too
      kids[0].kill('SIGKILL');
      await exits[0];
      const done = withRoot(root, () => lockSync.releaseAsHead(lockPath, tokens, { timeoutMs: 0, hooks: aSelf }));
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

describe('#4559 r7 (a2 P3-5, PM\'s disposition 3): the base name is folded in ASCII only (A–Z → a–z)', () => {
  it('X.lock folds to x.gen; a base name with letters outside ASCII keeps them as spelled (named and by path)', () => {
    const root = freshRoot('ascii');
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    withRoot(root, () => {
      expect(path.basename(lockSync.genDirOf(path.join(root, 'X.lock')))).toBe('x.gen');
      expect(path.basename(lockSync.genDirOf(path.join(root, 'ÄB.lock')))).toBe('Äb.gen');
      expect(lockSync.genDirOf(path.join(other, 'ÄB.lock'))).toBe(path.join(root, 'by-path', `${lockSync.byPathHash(`${fs.realpathSync.native(other)}/Äb.lock`)}.gen`));
      expect(lockSync.genDirOf(path.join(other, 'ÄB.lock'))).not.toBe(lockSync.genDirOf(path.join(other, 'äb.lock')));
    });
  });
});

describe('#4559 r7 (a2 P3-6): the release\'s end that cannot be linked (ENOENT every try) is an answer, not a throw', () => {
  it('end-link absent at every try: deferred (named, EAGAIN) — the next release writes the end', () => {
    const root = freshRoot('eagain');
    const { genDir, lockPath } = lockOf(root);
    let releasing = false;
    let links = 0;
    const warnings: string[] = [];
    const r = lockSync.acquireMachineLockSync('x', {
      root,
      timeoutMs: 500,
      warn: (l: string) => warnings.push(l),
      hooks: {
        genDir,
        onGenStage: (st: string) => {
          if (st === 'beacon-release') releasing = true;
        },
        fault: (p: string) => (p === 'end-link' && releasing && links < 100 ? (links++, 'ENOENT') : undefined),
      },
    });
    expect(r.acquired).toBe(true);
    let first: string | null = null;
    expect(() => (first = r.release())).not.toThrow();
    expect(first).toBe('deferred');
    expect(links, 'every try of the poll reached end-link').toBe(32);
    expect(warnings.join('\n')).toContain(`machine-lock-release-deferred ${lockPath} point=end-link errno=EAGAIN`);
    expect(fs.existsSync(lockPath), 'the <lock> went first (§6.1)').toBe(false);
    expect(readGens(genDir).get(1)?.end ?? null).toBeNull();
    links = 100;
    expect(r.release()).toBe('released');
    expect(readGens(genDir).get(1)?.end?.split(' ')[0]).toBe('released');
  });
});

describe('#4559 r7 (b2 P3-1): S2 at the write counts another\'s end written between the holder\'s releasing and its own end', () => {
  it('self-test on a record of events: an end by B after A\'s `releasing`, while A lives, is a break of S2', () => {
    const root = freshRoot('s2-releasing');
    const { genDir } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: 4242, token: 'A' }, end: 'dead B' });
    const at = fs.statSync(path.join(genDir, lockSync.genName(1), 'end')).mtimeMs;
    // A started before, said `releasing` before B's end, and exited after it
    const a = { span: () => ({ pid: 4242, from: at - 1000, to: at - 10, life: at + 1000 }) };
    expect(s2AtWrite(genDir, [a])).toEqual([1]);
    // the same end after A exited is no break
    const gone = { span: () => ({ pid: 4242, from: at - 1000, to: at - 500, life: at - 100 }) };
    expect(s2AtWrite(genDir, [gone])).toEqual([]);
  });
});

// =====================================================================================================
// #4559 PR-2 r8: a3 / b3's findings, each a test first (red on 711f50192's core), then the fix.
// =====================================================================================================

/** A holding whose records are all dead (T), its <lock> showing it (g=1); `old`: its generation made long ago. */
function deadHolding(tag: string, old = false): { root: string; lockPath: string; genDir: string } {
  const root = freshRoot(tag);
  const { genDir, lockPath } = lockOf(root);
  writeGen(genDir, 1, { owner: { pid: deadPid(), token: 'T' }, ...(old ? { mtimeAgoMs: 20 * 60_000 } : {}) });
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: deadPid(), host: HOST, token: 'T', acquiredAt: 0, v: 1, g: 1 }));
  return { root, lockPath, genDir };
}
/** A fault seam that answers `code` at the `at`-th reach of `point` (each reach of every point counted). */
function faultAt(point: string, at: number | ((n: number) => boolean), code: string): { fault: (p: string) => string | undefined; reached: Map<string, number> } {
  const reached = new Map<string, number>();
  return {
    reached,
    fault: (p: string) => {
      const n = (reached.get(p) ?? 0) + 1;
      reached.set(p, n);
      return p === point && (typeof at === 'number' ? n === at : at(n)) ? code : undefined;
    },
  };
}
const endOf = (genDir: string, n = 1): string | null => readGens(genDir).get(n)?.end?.split(' ')[0] ?? null;

describe('#4559 r8 (1) (a3 P2-1 = b3 P2-2, §4.2): releaseAsHead answers released only once the holding\'s end is there', () => {
  it('(a) the re-read of the holding\'s records after the <lock> went fails (holder-read, the 3rd reach only, EIO): deferred, named — no end; the next call ends it', () => {
    const { root, lockPath, genDir } = deadHolding('r8-a');
    const warnings: string[] = [];
    const f = faultAt('holder-read', 3, 'EIO');
    const r = withRoot(root, () => lockSync.releaseAsHead(lockPath, ['T'], { timeoutMs: 0, warn: (l: string) => warnings.push(l), hooks: { fault: f.fault } }));
    expect(f.reached.get('holder-read'), 'the holding read (owner, owner.h1), then the re-read failed at its owner').toBe(3);
    expect(r).toMatchObject({ result: 'deferred', unknown: { point: 'holder-read', code: 'EIO' } });
    expect(warnings.join('\n')).toContain(`machine-lock-release-deferred ${lockPath} point=holder-read errno=EIO`);
    expect(fs.existsSync(lockPath), 'the <lock> went first (§6.1)').toBe(false);
    expect(endOf(genDir), 'no end: the generation stays the holding until it is ended').toBeNull();
    const next = withRoot(root, () => lockSync.releaseAsHead(lockPath, ['T'], { timeoutMs: 0 }));
    expect(next.result).toBe('missing');
    expect(endOf(genDir)).toBe('dead');
  });

  it('(b) the judgement before the end answers young (the owner read as missing in the judgement: holder-read, the 5th reach, ENOENT): deferred, named — no end', () => {
    const { root, lockPath, genDir } = deadHolding('r8-b-young');
    const warnings: string[] = [];
    const f = faultAt('holder-read', 5, 'ENOENT');
    const r = withRoot(root, () => lockSync.releaseAsHead(lockPath, ['T'], { timeoutMs: 0, warn: (l: string) => warnings.push(l), hooks: { fault: f.fault } }));
    expect(f.reached.get('holder-read')).toBe(5);
    expect(r.result).toBe('deferred');
    expect(r.unknown?.point).toBe('beacon-gen-end');
    expect(warnings.join('\n')).toContain(`machine-lock-release-deferred ${lockPath} point=beacon-gen-end errno=EAGAIN`);
    expect(endOf(genDir)).toBeNull();
  });

  it('(b) the judgement before the end answers busy (the holder read alive there — a pid in use again): deferred, named — no end', () => {
    const { root, lockPath, genDir } = deadHolding('r8-b-busy');
    let judging = false;
    let alive = 0;
    // the <lock>'s and the holding's judgements read T dead; the end's judgement (from its seam holder-read on) reads it alive
    const hooks = {
      onGenStage: (st: string) => {
        if (st === 'holder-read') judging = true;
      },
      pidAlive: () => (judging ? (alive++, true) : false),
    };
    const r = withRoot(root, () => lockSync.releaseAsHead(lockPath, ['T'], { timeoutMs: 0, hooks }));
    expect(judging, 'the end\'s judgement was reached').toBe(true);
    expect(alive, 'T read alive there, once').toBe(1);
    expect(r.result).toBe('deferred');
    expect(r.unknown?.point).toBe('beacon-gen-end');
    expect(endOf(genDir)).toBeNull();
  });

  it('(c) the end\'s link answers ENOENT once (its tmp cleaned meanwhile, the generation not over): tried again — released with the end', () => {
    const { root, lockPath, genDir } = deadHolding('r8-c-once');
    const f = faultAt('end-link', 1, 'ENOENT');
    const r = withRoot(root, () => lockSync.releaseAsHead(lockPath, ['T'], { timeoutMs: 0, hooks: { fault: f.fault } }));
    expect(f.reached.get('end-link'), 'the end linked at the second try').toBe(2);
    expect(r.result).toBe('released');
    expect(endOf(genDir)).toBe('dead');
  });

  it('(c) the end\'s link answers ENOENT at every try of the poll: deferred, named — no end', () => {
    const { root, lockPath, genDir } = deadHolding('r8-c-every');
    const warnings: string[] = [];
    const f = faultAt('end-link', () => true, 'ENOENT');
    const r = withRoot(root, () => lockSync.releaseAsHead(lockPath, ['T'], { timeoutMs: 0, warn: (l: string) => warnings.push(l), hooks: { fault: f.fault } }));
    expect(f.reached.get('end-link'), 'every try of the poll').toBe(32);
    expect(r.result).toBe('deferred');
    expect(warnings.join('\n')).toContain(`machine-lock-release-deferred ${lockPath} point=beacon-gen-end errno=EAGAIN`);
    expect(endOf(genDir)).toBeNull();
  });
});

describe('#4559 r8 (3) (a3 P3-1): D5\'s rule for the caller\'s own record needs its host too', () => {
  it('a record of this pid on another host (a shared root) is not the caller\'s: deferred — no end on its generation, the <lock> stays', () => {
    const root = freshRoot('r8-host');
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: process.pid, host: 'other-host', token: 'T' }, handoffs: [{ pid: deadPid(), token: 'HB' }] });
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: deadPid(), host: HOST, token: 'HB', acquiredAt: 0, v: 1, g: 1 }));
    const r = withRoot(root, () => lockSync.releaseAsHead(lockPath, ['T', 'HB'], { timeoutMs: 0 }));
    expect(r.result).toBe('deferred');
    expect(endOf(genDir)).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).token).toBe('HB');
  });

  it('the same record on this host is the caller\'s own (D12\'s rule): released, with the end', () => {
    const root = freshRoot('r8-host-same');
    const { genDir, lockPath } = lockOf(root);
    writeGen(genDir, 1, { owner: { pid: process.pid, token: 'T' }, handoffs: [{ pid: deadPid(), token: 'HB' }] });
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: deadPid(), host: HOST, token: 'HB', acquiredAt: 0, v: 1, g: 1 }));
    const r = withRoot(root, () => lockSync.releaseAsHead(lockPath, ['T', 'HB'], { timeoutMs: 0 }));
    expect(r.result).toBe('released');
    expect(endOf(genDir)).toBe('dead');
  });
});

describe('#4559 r8 (4) (a3 P3-2 = b3 P3-1): the answers name the point that kept them', () => {
  it('D6: the end of a dead holding that cannot be written (end-link EIO) — kept, named (never a bare kept)', () => {
    const { root, lockPath, genDir } = deadHolding('r8-d6');
    const f = faultAt('end-link', 1, 'EIO');
    const r = withRoot(root, () => lockSync.recoverIfDead(lockPath, { timeoutMs: 0, hooks: { fault: f.fault } }));
    expect(f.reached.get('end-link')).toBe(1);
    expect(r).toMatchObject({ result: 'kept', unknown: { point: 'end-link', code: 'EIO' } });
    expect(endOf(genDir)).toBeNull();
    expect(fs.existsSync(path.join(lockPath, 'owner'))).toBe(true);
  });

  it('readHolder: a chain it cannot read names no generation\'s holder (genOnly null) and names the point in a warning', () => {
    const { root, lockPath } = deadHolding('r8-read');
    for (const point of ['gen-realpath', 'gen-list', 'gen-end-read', 'holder-read']) {
      const warnings: string[] = [];
      const f = faultAt(point, 1, 'EIO');
      const read = lockSync.readHolder as (p: string, o: unknown) => { token?: string } | null;
      const h = withRoot(root, () => read(lockPath, { genOnly: true, warn: (l: string) => warnings.push(l), hooks: { fault: f.fault } }));
      expect(f.reached.get(point), point).toBe(1);
      expect(h, point).toBeNull();
      expect(warnings.join('\n'), point).toMatch(new RegExp(`point=${point} .*errno=EIO`));
    }
    expect(withRoot(root, () => lockSync.readHolder(lockPath, { genOnly: true }))?.token).toBe('T');
  });
});

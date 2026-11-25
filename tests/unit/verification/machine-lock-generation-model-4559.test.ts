/**
 * Issue #4559 T1 — the exhaustive model of design A (docs/design/machine-lock-generation-4559.md §7).
 * The model is lock-generation-model-4559.ts (ported from the leader's gen-model3.mjs v3.1; the header
 * there lists what the model leaves out and why the joined steps are safe).
 *
 * Every interleaving of the actors is explored: an actor can be delayed at any point for any length and
 * any number of times (so the safety below does not lean on P0), can die at any point, and the gc can run
 * at any time. What each name of the design is checked by:
 *   - S1 (at most one live holder; a handoff group counts as one) and S2 (no `end` on a live holder's
 *     generation): zero violations in both combinations, every mutant red on each of them
 *   - S3 (a stalled actor that resumes harms nothing): the exhaustive interleaving itself
 *   - S4 (liveness): from every state in which the others have finished, the last actor holds in
 *     finitely many steps; `c4-stuck` and `no-tomb` are its mutants
 *   - L1 / C1 (the maximum never shrinks; the gc never chooses the maximum): `gc-max` red, `GCLIVE` reached
 *   - L2 (judge only facts that stay true): `REC` and `WD` reached with zero violations
 *   - L3 (a non-maximum generation never holds): `no-postcheck` red, `REC`・`WD` reached
 *   - L4 (the tomb and the writer race for the same name): `tomb-separate` red, `TOMBWIN`・`WRITERWIN` reached;
 *     without the tomb (`no-tomb`) an ownerless generation is waited on forever (S4 red)
 *   - L5 / C3 (handoff records only from the living; re-list after "all dead"): `no-relist` red, `HOREL` reached
 *   - C4 (the loose reading of a vanished generation): the default here, `LOOSE` reached, `c4-stuck` red
 *   - not in the model, named for the implementation tests: C2 (readdir, T2), C5 (the 12-digit names, T3),
 *     C6 (`.gen` is never removed, T2), C7 (by-path realpath, T2・T3), C8 (tmp names, T2), S5 (mixed, T5)
 *
 * Every mutant the model lists is run and must be red: a blunt mutant (one that changes nothing the
 * invariants see) added to the list makes this file red, and T7 keeps the list equal to the design's.
 *
 * Budget: this file alone stays within 90 s and 1.5 GB RSS on the development machine (design §8.2).
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  LIVENESS_MUTANTS,
  REACH_KEYS,
  SAFETY_MUTANTS,
  exploreLiveness,
  exploreSafety,
  type ModelConfig,
} from './lock-generation-model-4559';

/** (i) 2 actors · 2 rounds · 1 death · gc · up to generation 3 · handoff */
const COMBO_I: ModelConfig = { actors: 2, rounds: 2, deaths: 1, gc: true, cap: 3, handoff: true };
/** (ii) 2 actors · 3 rounds · no death · gc · up to generation 4 */
const COMBO_II: ModelConfig = { actors: 2, rounds: 3, deaths: 0, gc: true, cap: 4, handoff: false };

const BIG = 120_000;
const SMALL = 30_000;

describe('T1: design A has no two-holder state in any interleaving (S1・S2)', () => {
  it('combination (i): zero violations, more than 1,800,000 states, every reach count at least 1', { timeout: BIG }, () => {
    const r = exploreSafety(COMBO_I);
    expect(r.violation).toBeNull();
    expect(r.states).toBeGreaterThan(1_800_000);
    for (const k of REACH_KEYS) expect([k, r.reach[k] > 0]).toEqual([k, true]);
  });

  it('combination (ii): zero violations, more than 2,300,000 states, every reach count but HOREL at least 1', { timeout: BIG }, () => {
    const r = exploreSafety(COMBO_II);
    expect(r.violation).toBeNull();
    expect(r.states).toBeGreaterThan(2_300_000);
    // (ii) has no handoff, so HOREL is filled by the seeded search below
    for (const k of REACH_KEYS.filter((x) => x !== 'HOREL')) expect([k, r.reach[k] > 0]).toEqual([k, true]);
    expect(r.reach.HOREL).toBe(0);
  });

  it('seeded with (ii)\'s parameters from a holder whose child is still running: zero violations and HOREL reached', { timeout: BIG }, () => {
    const r = exploreSafety(COMBO_II, {
      seed: { gens: { 1: { owner: { actor: 0, child: true } } }, actors: { 0: { pc: 'h', holder: 1, mine: 1, c: 1 } } },
    });
    expect(r.violation).toBeNull();
    expect(r.states).toBeGreaterThan(1_000_000);
    expect(r.reach.HOREL).toBeGreaterThan(0);
  });
});

/** Each mutant, the combination it is run on, and the first violation the depth-first search meets. */
const SAFETY_ROWS: Array<{ mutant: (typeof SAFETY_MUTANTS)[number]; combo: ModelConfig; first: string }> = [
  { mutant: 'gc-max', combo: COMBO_I, first: 'live holder 1 displaced' },
  { mutant: 'no-postcheck', combo: COMBO_II, first: 'live holder 1 displaced' },
  { mutant: 'tomb-separate', combo: COMBO_I, first: 'live holder 1 displaced' },
  { mutant: 'no-relist', combo: COMBO_I, first: 'live holder 0 displaced' },
  { mutant: 'release-live-child', combo: COMBO_I, first: 'live holder 1 displaced' },
];

describe('T1: every safety mutant is red (the model is not blunt)', () => {
  it('the rows are exactly the model\'s safety mutants', { timeout: SMALL }, () => {
    expect(SAFETY_ROWS.map((r) => r.mutant)).toEqual([...SAFETY_MUTANTS]);
  });

  it.each(SAFETY_ROWS)('$mutant: red, and red on S1 alone and on S2 alone', { timeout: SMALL }, ({ mutant, combo, first }) => {
    const both = exploreSafety({ ...combo, mutant }, { trace: true });
    expect(both.violation).toBe(first);
    expect(both.trace.length).toBeGreaterThan(0);
    expect(exploreSafety({ ...combo, mutant }, { check: ['S1'] }).violation).toBe('two live holders');
    expect(exploreSafety({ ...combo, mutant }, { check: ['S2'] }).violation).toMatch(/^live holder \d displaced$/);
  });
});

describe('T1: liveness S4 — the last actor left holds in finitely many steps', () => {
  it('combination (i): from every state whose other actors have finished, no cycle and no dead end before holding', { timeout: BIG }, () => {
    const r = exploreLiveness(COMBO_I);
    expect(r.failure).toBeNull();
    expect(r.starts).toBeGreaterThan(100_000);
  });

  it.each([...LIVENESS_MUTANTS])('%s: red on S4 in combination (i)', { timeout: BIG }, (mutant) => {
    const r = exploreLiveness({ ...COMBO_I, mutant });
    expect(r.failure).not.toBeNull();
  });

  it('c4-stuck is safe (S1・S2) but not live: the vanished generation is waited for forever', { timeout: BIG }, () => {
    expect(exploreSafety({ ...COMBO_I, mutant: 'c4-stuck' }).violation).toBeNull();
    const r = exploreLiveness({ ...COMBO_I, mutant: 'c4-stuck' });
    expect(r.failure).toMatchObject({ kind: 'cycle', trace: ['0:a1'] });
  });

  it('no-tomb is safe (S1・S2) but not live: the ownerless generation of a dead writer is waited on forever', { timeout: BIG }, () => {
    expect(exploreSafety({ ...COMBO_I, mutant: 'no-tomb' }).violation).toBeNull();
    const r = exploreLiveness({ ...COMBO_I, mutant: 'no-tomb' });
    expect(r.failure).toMatchObject({ kind: 'cycle' });
    expect(r.failure?.trace.at(-1)).toMatch(/^\d:j0$/);
  });
});

describe('T1 self-test: a blunt mutant in the list would be caught', () => {
  // The checks above run every listed mutant and require red. The unchanged model stands in for a blunt
  // mutant (one whose change the invariants do not see): the same checks find it green, so listing it fails.
  it('the unchanged model is green on S1・S2 and on S4 under the very checks the mutants must fail', { timeout: BIG }, () => {
    expect(exploreSafety({ ...COMBO_I, mutant: '' }, { check: ['S1'] }).violation).toBeNull();
    expect(exploreSafety({ ...COMBO_I, mutant: '' }, { check: ['S2'] }).violation).toBeNull();
    expect(exploreLiveness({ ...COMBO_I, mutant: '' }).failure).toBeNull();
  });
});

describe('T1: the model refuses a bad configuration', () => {
  const bad: Array<[string, unknown]> = [
    ['missing actors', { rounds: 1, deaths: 0, gc: true, cap: 2, handoff: false }],
    ['actors not a number', { ...COMBO_I, actors: '2' }],
    ['rounds not an integer', { ...COMBO_I, rounds: 1.5 }],
    ['cap out of range', { ...COMBO_I, cap: 0 }],
    ['gc not a boolean', { ...COMBO_I, gc: 1 }],
    ['unknown mutant', { ...COMBO_I, mutant: 'end-before-list' }],
    ['unknown C4 reading', { ...COMBO_I, c4: 'none' }],
    ['not an object', null],
  ];
  it.each(bad)('%s → throws', { timeout: SMALL }, (_name, cfg) => {
    expect(() => exploreSafety(cfg as ModelConfig)).toThrow(TypeError);
    expect(() => exploreLiveness(cfg as ModelConfig)).toThrow(TypeError);
  });
});

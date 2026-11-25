/**
 * Issue #4559 T1 — the exhaustive model of design A (docs/design/machine-lock-generation-4559.md §7).
 * The model is lock-generation-model-4559.ts (ported from the leader's gen-model3.mjs v3.1; the header
 * there lists what the model leaves out and why the joined steps are safe).
 *
 * Every interleaving of the actors is explored: an actor can be delayed at any point for any length and
 * any number of times (so the safety below does not lean on P0), can die at any point, and the gc can run
 * at any time. The design's names that T1 checks are in the describe / it titles below (T7 compares them
 * with the design's §5); the names the model does not check are the model's NOT_IN_MODEL list.
 *
 * Every mutant the model lists is run and must be red: a blunt mutant (one that changes nothing the
 * invariants see) added to the list makes this file red, and T7 keeps the list equal to the design's.
 * Each combination also asserts the reach counts of the paths it must walk (a green run that never
 * reached a path proves nothing about it) and a state-count floor a few percent under the measured count.
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
  type ReachKey,
} from './lock-generation-model-4559';

/** (i) 2 actors · 2 rounds · 1 death · gc · up to generation 3 · up to 2 handoffs per hold */
const COMBO_I: ModelConfig = { actors: 2, rounds: 2, deaths: 1, gc: true, cap: 3, handoff: true };
/** (ii) 2 actors · 3 rounds · no death · gc · up to generation 4 */
const COMBO_II: ModelConfig = { actors: 2, rounds: 3, deaths: 0, gc: true, cap: 4, handoff: false };
/** (iii) 2 actors · 1 round · 1 death · gc · up to generation 3 · up to 2 handoffs · giving up after the owner link */
const COMBO_III: ModelConfig = { actors: 2, rounds: 1, deaths: 1, gc: true, cap: 3, handoff: true, abort: true };

const BIG = 120_000;
const SMALL = 30_000;

/** The reach counts a combination cannot walk by construction (no handoff, no death, no abort). */
const reachable = (cfg: ModelConfig): ReachKey[] =>
  REACH_KEYS.filter((k) => {
    if (!cfg.handoff && (k === 'HOREL' || k === 'RELISTK')) return false;
    if (cfg.deaths === 0 && !cfg.handoff && k === 'DEADREC') return false;
    if (cfg.deaths === 0 && k === 'HOLDERDIE') return false;
    if (!cfg.abort && k === 'ABORT') return false;
    return true;
  });
const reachedAll = (reach: Record<ReachKey, number>, keys: ReachKey[]): Array<[ReachKey, boolean]> => keys.map((k) => [k, reach[k] > 0]);
const yes = (keys: ReachKey[]): Array<[ReachKey, boolean]> => keys.map((k) => [k, true]);

describe('T1: design A has no two-holder state in any interleaving (S1・S2; S3: any stall, any number of times; L2: judgments on facts that stay true)', () => {
  it('combination (i): zero violations, more than 4,300,000 states, every reachable count at least 1 — and S4 from every state whose other actors have finished', { timeout: BIG }, () => {
    // one walk checks S1・S2 on every state and S4 from every start (the liveness walk is the safety walk)
    const r = exploreLiveness(COMBO_I);
    expect(r.violation).toBeNull();
    expect(r.states).toBeGreaterThan(4_300_000);
    expect(reachedAll(r.reach, reachable(COMBO_I))).toEqual(yes(reachable(COMBO_I)));
    expect(r.failure).toBeNull();
    expect(r.starts).toBeGreaterThan(1_600_000);
  });

  it('combination (ii): zero violations, more than 2,350,000 states, every reachable count at least 1', { timeout: BIG }, () => {
    const r = exploreSafety(COMBO_II);
    expect(r.violation).toBeNull();
    expect(r.states).toBeGreaterThan(2_350_000);
    expect(reachedAll(r.reach, reachable(COMBO_II))).toEqual(yes(reachable(COMBO_II)));
  });

  it('combination (iii) with the abort step: zero violations, more than 1,050,000 states, every count at least 1 — and S4', { timeout: BIG }, () => {
    const r = exploreLiveness(COMBO_III);
    expect(r.violation).toBeNull();
    expect(r.states).toBeGreaterThan(1_050_000);
    expect(reachedAll(r.reach, [...REACH_KEYS])).toEqual(yes([...REACH_KEYS]));
    expect(r.failure).toBeNull(); // S4 too, in the same walk
    expect(r.starts).toBeGreaterThan(300_000);
  });

  it('seeded with (ii)\'s parameters from a holder whose h1 child runs: zero violations; HOREL, RELISTK and DEADREC reached', { timeout: BIG }, () => {
    const r = exploreSafety(COMBO_II, {
      seed: { gens: { 1: { owner: { actor: 0, handoffs: 1 } } }, actors: { 0: { pc: 'h', holder: 1, mine: 1, c1: 1 } } },
    });
    expect(r.violation).toBeNull();
    expect(r.states).toBeGreaterThan(1_050_000);
    expect(reachedAll(r.reach, ['HOREL', 'RELISTK', 'DEADREC'])).toEqual(yes(['HOREL', 'RELISTK', 'DEADREC']));
  });
});

/** Each mutant, the combination it is run on, and the first violation the depth-first search meets. */
const SAFETY_ROWS: Array<{ mutant: (typeof SAFETY_MUTANTS)[number]; combo: ModelConfig; first: string }> = [
  { mutant: 'gc-max', combo: COMBO_I, first: 'live holder 1 displaced' },
  { mutant: 'no-postcheck', combo: COMBO_II, first: 'live holder 1 displaced' },
  { mutant: 'tomb-separate', combo: COMBO_I, first: 'live holder 1 displaced' },
  { mutant: 'no-relist', combo: COMBO_I, first: 'live holder 1 displaced' },
  { mutant: 'relist-h1-only', combo: COMBO_I, first: 'live holder 1 displaced' },
  { mutant: 'release-live-child', combo: COMBO_I, first: 'live holder 1 displaced' },
];

describe('T1: every safety mutant is red — gc-max breaks L1・C1, no-postcheck L3, tomb-separate L4, no-relist L5・C3, relist-h1-only C3 for k ≥ 1, release-live-child the release rule', () => {
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

  it('relist-h1-only is red only through a second handoff: with one handoff per hold it is green', { timeout: BIG }, () => {
    expect(exploreSafety({ ...COMBO_I, handoffs: 1, mutant: 'relist-h1-only' }).violation).toBeNull();
  });
});

/** Each liveness mutant and the combination it is run on (abort-no-end needs the abort step). */
const LIVENESS_ROWS: Array<{ mutant: (typeof LIVENESS_MUTANTS)[number]; combo: ModelConfig; last: RegExp }> = [
  { mutant: 'c4-stuck', combo: COMBO_I, last: /^\d:a1$/ },
  { mutant: 'no-tomb', combo: COMBO_I, last: /^\d:j0$/ },
  { mutant: 'abort-no-end', combo: COMBO_III, last: /^\d:j0$/ },
];

describe('T1: liveness S4 — the last actor left holds in finitely many steps (C4: the loose reading is the default)', () => {
  // the unchanged model's S4 runs in the same walks as S1・S2 for (i) and (iii) (above): from every state
  // whose other actors have finished, no cycle and no dead end before holding

  it('the rows are exactly the model\'s liveness mutants', { timeout: SMALL }, () => {
    expect(LIVENESS_ROWS.map((r) => r.mutant)).toEqual([...LIVENESS_MUTANTS]);
  });

  it.each(LIVENESS_ROWS)('$mutant: safe on S1・S2 but red on S4 (a cycle)', { timeout: BIG }, ({ mutant, combo, last }) => {
    expect(exploreSafety({ ...combo, mutant }).violation).toBeNull();
    const r = exploreLiveness({ ...combo, mutant });
    expect(r.failure).toMatchObject({ kind: 'cycle' });
    expect(r.failure?.trace.at(-1)).toMatch(last);
  });
});

describe('T1 self-test: a blunt mutant in the list would be caught', () => {
  // The checks above run every listed mutant and require red. The unchanged model stands in for a blunt
  // mutant (one whose change the invariants do not see): under the very same calls it is green, so a blunt
  // mutant in either list fails its row. Run on the small combination (iii) — the calls, not the size, are
  // what this pins.
  it('the unchanged model is green on S1 alone, on S2 alone and on S4', { timeout: BIG }, () => {
    expect(exploreSafety({ ...COMBO_III, mutant: '' }, { check: ['S1'] }).violation).toBeNull();
    expect(exploreSafety({ ...COMBO_III, mutant: '' }, { check: ['S2'] }).violation).toBeNull();
    expect(exploreLiveness({ ...COMBO_III, mutant: '' }).failure).toBeNull();
  });
});

describe('T1: the model refuses a bad configuration', () => {
  const bad: Array<[string, unknown]> = [
    ['missing actors', { rounds: 1, deaths: 0, gc: true, cap: 2, handoff: false }],
    ['actors not a number', { ...COMBO_I, actors: '2' }],
    ['rounds not an integer', { ...COMBO_I, rounds: 1.5 }],
    ['cap out of range', { ...COMBO_I, cap: 0 }],
    ['gc not a boolean', { ...COMBO_I, gc: 1 }],
    ['handoffs out of range', { ...COMBO_I, handoffs: 3 }],
    ['abort not a boolean', { ...COMBO_I, abort: 'yes' }],
    ['unknown mutant', { ...COMBO_I, mutant: 'end-before-list' }],
    ['unknown C4 reading', { ...COMBO_I, c4: 'none' }],
    ['not an object', null],
  ];
  it.each(bad)('%s → throws', { timeout: SMALL }, (_name, cfg) => {
    expect(() => exploreSafety(cfg as ModelConfig)).toThrow(TypeError);
    expect(() => exploreLiveness(cfg as ModelConfig)).toThrow(TypeError);
  });
});

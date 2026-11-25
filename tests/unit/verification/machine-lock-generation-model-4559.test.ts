/**
 * Issue #4559 T1 — the exhaustive model of design A (docs/design/machine-lock-generation-4559.md §7).
 * The model is lock-generation-model-4559.ts (ported from the leader's gen-model3.mjs v3.1; the header
 * there lists what the model leaves out and why the joined steps are safe).
 *
 * Every interleaving of the actors is explored: an actor can be delayed at any point for any length and
 * any number of times (so the safety below does not lean on P0), can die at any point, and the gc can run
 * at any time.
 *
 * The mutant rows and their titles are made from the model's MUTANT_TABLE (the one table; the design's
 * §7.2・§7.3 are made from it too and T7 compares them). Each mutant must be red with exactly the numbers
 * its row records, its red path must pass through a step the mutant changed (a `*` label — `pick` marks it
 * and throws if a mutant branches at a step its row does not declare), its row's reach counts must be
 * walked, and its optional control must be green. Each combination asserts the reach counts it can walk
 * and a state-count floor a few percent under the measured count.
 *
 * Budget: this file alone stays within 90 s and 1.5 GB RSS on the development machine (design §8.2).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMBOS,
  MUTANT_TABLE,
  NAMES,
  NOT_IN_MODEL,
  WALK_RUNS,
  exploreLiveness,
  exploreSafety,
  runChecks,
  runReach,
  t1Checks,
  type ModelConfig,
  type MutantRow,
  type ReachKey,
} from './lock-generation-model-4559';

const BIG = 120_000;
const SMALL = 30_000;

const reachedAll = (reach: Record<ReachKey, number>, keys: readonly ReachKey[]): Array<[ReachKey, boolean]> => keys.map((k) => [k, reach[k] > 0]);
const yes = (keys: readonly ReachKey[]): Array<[ReachKey, boolean]> => keys.map((k) => [k, true]);

/** The walks with the strings their titles show (made from the model's WALK_RUNS). */
const WALKS = WALK_RUNS.map((run) => ({
  run,
  id: run.id,
  combo: run.combo,
  checks: runChecks(run).join('・'),
  floor: run.floor.toLocaleString('en-US'),
  reach: runReach(run).join('・'),
}));

describe('T1: design A has no two-holder state in any interleaving (the walks of WALK_RUNS)', () => {
  it.each(WALKS)('$id (combination $combo): checks $checks, more than $floor states, reaches $reach', { timeout: BIG }, ({ run }) => {
    // a liveness walk is the safety walk too: one walk checks S1・S2 on every state and S4 from every start
    const cfg: ModelConfig = COMBOS[run.combo];
    const r = run.liveness ? exploreLiveness(cfg) : exploreSafety(cfg, run.seed ? { seed: run.seed } : {});
    expect(r.violation).toBeNull();
    expect(r.states).toBeGreaterThan(run.floor);
    expect(reachedAll(r.reach, runReach(run))).toEqual(yes(runReach(run)));
    if (run.liveness) {
      const l = r as ReturnType<typeof exploreLiveness>;
      expect(l.failure).toBeNull();
      expect(l.starts).toBeGreaterThan(run.startsFloor ?? 0);
    }
  });
});

/** The table's rows with the strings their titles show. */
const ROWS = MUTANT_TABLE.map((r) => {
  const row = r as MutantRow;
  return { row, name: row.name, property: row.property, combo: row.combo, steps: row.steps.join('・'), breaks: row.breaks.length > 0 ? row.breaks.join('・') : '—' };
});
const SAFETY_ROWS = ROWS.filter((r) => r.row.expect.kind === 'safety');
const LIVENESS_ROWS = ROWS.filter((r) => r.row.expect.kind === 'liveness');
const starred = (labels: readonly string[]): string[] => labels.filter((l) => l.endsWith('*'));
const stepOf = (label: string): string => label.replace(/^\d+:/, '').replace(/\*$/, '').replace(/\(\d+\)$/, '').replace(/^h->release$/, 'h');

describe('T1: every mutant of the table is red through its declared step', () => {
  it('the table has safety and liveness rows, unique names, and every row\'s names are names of §5', { timeout: SMALL }, () => {
    expect(SAFETY_ROWS.length).toBeGreaterThan(0);
    expect(LIVENESS_ROWS.length).toBeGreaterThan(0);
    expect(new Set(ROWS.map((r) => r.name)).size).toBe(ROWS.length);
    for (const r of ROWS) for (const n of r.row.breaks) expect(NAMES).toContain(n);
  });

  it.each(SAFETY_ROWS)('$name ($property, combination $combo, step $steps, breaks $breaks): red with the recorded numbers, through its step, and on S1 alone and on S2 alone', { timeout: SMALL }, ({ row }) => {
    if (row.expect.kind !== 'safety') throw new Error('not a safety row');
    const cfg = { ...COMBOS[row.combo], mutant: row.name } as ModelConfig;
    const r = exploreSafety(cfg, { trace: true });
    expect({ states: r.states, first: r.violation }).toEqual({ states: row.expect.states, first: row.expect.first });
    const changed = starred(r.trace);
    expect(changed.length).toBeGreaterThan(0);
    for (const l of changed) expect(row.steps).toContain(stepOf(l));
    expect(reachedAll(r.reach, row.reach)).toEqual(yes(row.reach));
    expect(exploreSafety(cfg, { check: ['S1'] }).violation).toBe('two live holders');
    expect(exploreSafety(cfg, { check: ['S2'] }).violation).toMatch(/^live holder \d displaced$/);
  });

  it.each(LIVENESS_ROWS)('$name ($property, combination $combo, step $steps, breaks $breaks): safe on S1・S2 with the recorded states, red on S4 through its step', { timeout: BIG }, ({ row }) => {
    if (row.expect.kind !== 'liveness') throw new Error('not a liveness row');
    const cfg = { ...COMBOS[row.combo], mutant: row.name } as ModelConfig;
    const safe = exploreSafety(cfg);
    expect({ states: safe.states, violation: safe.violation }).toEqual({ states: row.expect.safeStates, violation: null });
    const r = exploreLiveness(cfg, { trace: true });
    expect(r.failure?.kind).toBe('cycle');
    const changed = starred([...(r.failure?.prefix ?? []), ...(r.failure?.trace ?? [])]);
    expect(changed.length).toBeGreaterThan(0);
    for (const l of changed) expect(row.steps).toContain(stepOf(l));
    expect(reachedAll(r.reach, row.reach)).toEqual(yes(row.reach));
  });

  it.each(ROWS.filter((r) => r.row.control !== undefined))('$name: its control is green', { timeout: BIG }, ({ row }) => {
    const cfg = { ...COMBOS[row.combo], ...row.control?.config, mutant: row.name } as ModelConfig;
    if (row.expect.kind === 'safety') expect(exploreSafety(cfg).violation).toBeNull();
    else expect(exploreLiveness(cfg).failure).toBeNull();
  });
});

describe('T1: the names of §5 are split between T1 and NOT_IN_MODEL', () => {
  it('T1\'s checks (made from the table and the walk) and NOT_IN_MODEL are disjoint and cover §5\'s names', { timeout: SMALL }, () => {
    const t1 = t1Checks().map((c) => c.name);
    const rest = Object.keys(NOT_IN_MODEL);
    expect(t1.filter((n) => rest.includes(n))).toEqual([]);
    expect([...t1, ...rest].sort()).toEqual([...NAMES].sort());
  });
});

describe('T1 self-test: a mutant that branches away from its declared step throws, a blunt one is caught', () => {
  // The model file is copied to a temporary directory and the copy is changed; the repository's files
  // are not written.
  const MODEL = path.join(__dirname, 'lock-generation-model-4559.ts');
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gen-model-4559-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  type ModelModule = typeof import('./lock-generation-model-4559');
  let copies = 0;
  const changedCopy = async (edits: Array<[string, string]>): Promise<ModelModule> => {
    let text = fs.readFileSync(MODEL, 'utf8');
    for (const [from, to] of edits) {
      if (!text.includes(from)) throw new Error(`the model has no ${from}`);
      text = text.replace(from, to);
    }
    copies++;
    const file = path.join(dir, `model-copy-${copies}.ts`); // a new name for each copy: imports are cached by path
    fs.writeFileSync(file, text);
    return (await import(file)) as ModelModule;
  };

  it('abort-no-end\'s change moved to the ownerless path (no-tomb\'s): throws at j0', { timeout: SMALL }, async () => {
    const m = await changedCopy([
      ["!this.pick('abort-no-end', true, false)", 'true'],
      ["if (o === O_NONE && this.pick('no-tomb', true, false)) break;", "if (o === O_NONE && (this.pick('no-tomb', true, false) || this.pick('abort-no-end', true, false))) break;"],
    ]);
    expect(() => m.exploreLiveness({ ...m.COMBOS['(iii)'], mutant: 'abort-no-end' })).toThrow(/abort-no-end branches at j0/);
  });

  it('tomb-separate\'s change moved to the re-list path (no-relist\'s): throws at jk', { timeout: SMALL }, async () => {
    const m = await changedCopy([
      ["this.pick('tomb-separate', PC.j2, PC.j1)", 'PC.j1'],
      ["this.pick('no-relist', PC.j2, PC.jr)", "this.pick('no-relist', PC.j2, this.pick('tomb-separate', PC.j2, PC.jr))"],
    ]);
    expect(() => m.exploreSafety({ ...m.COMBOS['(i)'], mutant: 'tomb-separate' })).toThrow(/tomb-separate branches at jk/);
  });

  it('a name added with nothing to check it (L6 in NAMES and WALK_CHECKS): the model throws when loaded', { timeout: SMALL }, async () => {
    await expect(changedCopy([
      ["'S3', 'S4', 'S5'] as const;", "'S3', 'S4', 'S5', 'L6'] as const;"],
      ["  S4: ['walk-i', 'walk-iii'],\n};", "  S4: ['walk-i', 'walk-iii'],\n  L6: ['walk-i'],\n};"],
    ])).rejects.toThrow(/WALK_CHECKS L6 keys walk-i, whose check is S1・S2・S4/);
    await expect(changedCopy([
      ["'S3', 'S4', 'S5'] as const;", "'S3', 'S4', 'S5', 'L6'] as const;"],
      ["  S4: ['walk-i', 'walk-iii'],\n};", "  S4: ['walk-i', 'walk-iii'],\n  L6: [],\n};"],
    ])).rejects.toThrow(/WALK_CHECKS L6 keys no walk/);
    await expect(changedCopy([["'S3', 'S4', 'S5'] as const;", "'S3', 'S4', 'S5', 'L6'] as const;"]])).rejects.toThrow(/L6 must be checked by T1 or listed in NOT_IN_MODEL/);
  });

  it('a mutant whose change is taken out (blunt) is green and walks no `*` step under the very calls its row must fail', { timeout: BIG }, async () => {
    const m = await changedCopy([["!this.pick('abort-no-end', true, false)", 'true']]);
    const r = m.exploreLiveness({ ...m.COMBOS['(iii)'], mutant: 'abort-no-end' }, { trace: true });
    expect(r.failure).toBeNull();
  });
});

describe('T1: the model refuses a bad configuration', () => {
  const bad: Array<[string, unknown]> = [
    ['missing actors', { rounds: 1, deaths: 0, gc: true, cap: 2, handoff: false }],
    ['actors not a number', { ...COMBOS['(i)'], actors: '2' }],
    ['rounds not an integer', { ...COMBOS['(i)'], rounds: 1.5 }],
    ['cap out of range', { ...COMBOS['(i)'], cap: 0 }],
    ['gc not a boolean', { ...COMBOS['(i)'], gc: 1 }],
    ['handoffs out of range', { ...COMBOS['(i)'], handoffs: 3 }],
    ['abort not a boolean', { ...COMBOS['(i)'], abort: 'yes' }],
    ['unknown mutant', { ...COMBOS['(i)'], mutant: 'end-before-list' }],
    ['unknown C4 reading', { ...COMBOS['(i)'], c4: 'none' }],
    ['not an object', null],
  ];
  it.each(bad)('%s → throws', { timeout: SMALL }, (_name, cfg) => {
    expect(() => exploreSafety(cfg as ModelConfig)).toThrow(TypeError);
    expect(() => exploreLiveness(cfg as ModelConfig)).toThrow(TypeError);
  });
});

/**
 * The model reads the configured mutant only in `checkConfig` and `pick`, and names a mutant only in its
 * table row and in `pick('<name>', …)` calls: a branch that bypasses `pick` is red here.
 */
function bypasses(source: string): string[] {
  const lines = source.split('\n');
  const blockOf = (start: RegExp): [number, number] => {
    const from = lines.findIndex((l) => start.test(l));
    if (from < 0) return [-1, -1];
    let depth = 0;
    for (let i = from; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth === 0 && i > from) return [from, i];
    }
    return [from, lines.length - 1];
  };
  const allowed = [blockOf(/^function checkConfig\(/), blockOf(/^ {2}pick<T>\(/)];
  const inAllowed = (i: number): boolean => allowed.some(([a, b]) => i >= a && i <= b);
  const names = MUTANT_TABLE.map((r) => r.name);
  const found: string[] = [];
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(code) || /^\s*\/\*\*/.test(code)) return; // doc comments
    if (/\.mutant\b/.test(code) && !inAllowed(i)) found.push(`${i + 1}: reads .mutant: ${line.trim()}`);
    for (const n of names) {
      for (const m of code.matchAll(new RegExp(`'${n}'`, 'g'))) {
        const before = code.slice(0, m.index);
        if (/name: $/.test(before) || /this\.pick\($/.test(before)) continue;
        found.push(`${i + 1}: names '${n}' outside its row and pick: ${line.trim()}`);
      }
    }
  });
  return found;
}

describe('T1: no branch on a mutant bypasses pick', () => {
  const MODEL_SOURCE = path.join(__dirname, 'lock-generation-model-4559.ts');
  it('the model reads the mutant only in checkConfig and pick, and names mutants only in the table and pick calls', { timeout: SMALL }, () => {
    expect(bypasses(fs.readFileSync(MODEL_SOURCE, 'utf8'))).toEqual([]);
  });

  it.each([
    ['a branch on cfg.mutant', "set(F_PC, this.recordsAlive(n, s[at(F_SNAP)]) ? PC.a0 : this.pick('no-relist', PC.j2, PC.jr));", "set(F_PC, this.recordsAlive(n, s[at(F_SNAP)]) ? PC.a0 : cfg.mutant === 'tomb-separate' ? PC.j2 : this.pick('no-relist', PC.j2, PC.jr));"],
    ['a branch on this.L.cfg.mutant', "if (o === O_NONE) set(F_PC, this.pick('tomb-separate', PC.j2, PC.j1));", "if (o === O_NONE) set(F_PC, this.L.cfg.mutant === 'no-tomb' ? PC.j2 : this.pick('tomb-separate', PC.j2, PC.j1));"],
    ['a mutant name kept in a variable', "    const R = solo >= 0 ? this.soloReach : this.reach;", "    const R = solo >= 0 ? this.soloReach : this.reach;\n    const other = 'gc-max';"],
  ])('self-test: a copy with %s is red', { timeout: SMALL }, (_what, from, to) => {
    const source = fs.readFileSync(MODEL_SOURCE, 'utf8');
    expect(source.includes(from)).toBe(true);
    expect(bypasses(source.replace(from, to))).not.toEqual([]);
  });
});

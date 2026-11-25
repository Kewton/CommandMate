/**
 * Issue #4559 — the abstract model of design A (the generation chain, docs/design/machine-lock-generation-4559.md).
 * Not repository code: it explores every interleaving of a few actors over the generation directory
 * `<name>.gen/g<N>/` and checks the invariants S1・S2 (and S4 from finished states). T1 runs it
 * (machine-lock-generation-model-4559.test.ts).
 *
 * Ported from the leader's v3.1 model (workspace lead-model-4559/gen-model3.mjs, C4_LOOSE=1 branch). Same
 * steps in the same order; the state is a small integer array instead of an object tree. Changes from the
 * port (each recorded in the design §8):
 *   - an actor whose parent has exited (only the handed-off child runs) walks only `child-exit`
 *     (gen-model3 let it keep releasing and acquiring under release-live-child, which muddled the red trace)
 *   - the loose C4 is the default (`c4: 'loose'`); no env switch
 *   - `GCLIVE` counts "the gc removed a non-maximum generation that had no `end`" (not a live holder's
 *     generation), and `HOREL` counts "a release after a handoff" (c ≠ 0 at the release; in v3 the release
 *     waits for the child, so gen-model3's "c = 1 at release" was reachable only under release-live-child)
 *   - two liveness mutants (`c4-stuck`, `no-tomb`) and the S4 check
 *
 * Steps (one atomic step each; every actor can be delayed at any point for any length and any number of
 * times — the interleaving is exhaustive — can die at any point, and any actor at a0/done can run the gc):
 *   a0  list: read the maximum M (or finish when its rounds are used up)
 *   a1  read g<M>/end: ended → a2, not ended → judge (j0), gone → loose C4: judge (j0)
 *   a2  mkdir g<M+1> (EEXIST → a0)
 *   a3  link owner into g<N> (EEXIST: a writer or a tomb won → a0)
 *   a4  post-list: a larger generation → link the withdraw `end` into g<N> and start over; none → holder
 *       (the withdraw `end` is a mark for diagnosis and the gc, not a condition of S1・S2・S4: nobody judges
 *       a non-maximum generation and the gc does not read `end` — design §4.1)
 *   h   holder: release once no live child is left / hand off (add owner.h1) / the parent exits
 *   r0  link g<N>/end (released)
 *   j0  judge g<T>: ended or gone → a0; no owner → tomb (j1); tomb → end (j2); records → check them (jk)
 *   jk  all records dead → re-list (jr, C3); any alive → a0
 *   jr  the record set unchanged and no end → j2, else a0
 *   j1  link the tomb as g<T>/owner (EEXIST: the writer won → a0)
 *   j2  link g<T>/end (dead)
 *   g1  rm -rf g<k> for the k the gc chose at a0 (k < the maximum it read)
 *
 * Where the model joins two operations into one step, and why that is the same as the split operations
 * (both facts it uses only ever become true and stay true — monotone — so a later re-read can only agree):
 *   - a4 joins the post-list (`gen-postlist`) and the withdraw `end` (`gen-withdraw-end`): "a generation
 *     larger than mine exists" stays true (L1: the maximum never shrinks), so whenever the end is linked
 *     the same withdraw is right; and the withdraw only ever touches my own generation's name.
 *   - a0 joins the list and the gc's choice of k (`gc-list`・`gc-judged`): "k < the maximum" stays true
 *     (L1), so the rm -rf at g1, however late, removes a non-maximum generation (L3: never a holder).
 *   - the handoff joins "add owner.h<k>", "start the child" and "signal": the record is complete before
 *     the child can start (V3-1's L5 basis), so no state has a running child without its record.
 *   - the post-list reads an exact listing; readdir's promise (C2) is that an entry present for the whole
 *     scan is returned, and the maximum is never removed, so the post-list never misses it.
 *
 * Not in the model (named for T2, the implementation matrix): the owner tmp → link two stages and the tmp
 * clean-up (C8), a half-done rm -rf (a generation whose `end` alone has gone, ENOTEMPTY), entries created
 * or removed during a readdir scan (C2), the beacon `<name>.lock` and the old writers (mixed), EIO, pid
 * reuse and other hosts (P1), the ticket queue, `fields`, creating `.gen`, parsing the 12-digit names (C5),
 * the by-path realpath name (C7). A non-holder's release (D5・D6・needs-head) uses only the recovery core
 * (V3-1), so the recoverer's steps j0〜j2 stand for it.
 */

export const SAFETY_MUTANTS = ['gc-max', 'no-postcheck', 'tomb-separate', 'no-relist', 'release-live-child'] as const;
export const LIVENESS_MUTANTS = ['c4-stuck', 'no-tomb'] as const;
export type Mutant = (typeof SAFETY_MUTANTS)[number] | (typeof LIVENESS_MUTANTS)[number];
const ALL_MUTANTS: readonly string[] = [...SAFETY_MUTANTS, ...LIVENESS_MUTANTS];

/** The names the model checks, by the design's lists (T7 compares them with the design document). */
export const MODEL_NAMES = {
  lemmas: ['L1', 'L2', 'L3', 'L4', 'L5'],
  conditions: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'],
  invariants: ['S1', 'S2', 'S3', 'S4', 'S5'],
} as const;

export const REACH_KEYS = ['REC', 'WD', 'GCLIVE', 'TOMBWIN', 'WRITERWIN', 'HOREL', 'LOOSE'] as const;
export type ReachKey = (typeof REACH_KEYS)[number];
export type Reach = Record<ReachKey, number>;

export interface ModelConfig {
  actors: number;
  rounds: number;
  deaths: number;
  gc: boolean;
  /** the largest generation number an actor may create */
  cap: number;
  handoff: boolean;
  mutant?: Mutant | '';
  /** C4 (V3.1-4): 'loose' reads a vanished generation as "no end" and goes to the judge; 'strict' starts over */
  c4?: 'loose' | 'strict';
}

export interface SafetyResult {
  states: number;
  violation: string | null;
  trace: string[];
  reach: Reach;
}

// program counters
const PC = { a0: 0, a1: 1, a2: 2, a3: 3, a4: 4, hh: 5, h: 6, r0: 7, j0: 8, jk: 9, jr: 10, j1: 11, j2: 12, g1: 13, done: 14 } as const;
const PC_NAME = Object.keys(PC);
// actor fields
const F_PC = 0, F_M = 1, F_MINE = 2, F_T = 3, F_SNAP = 4, F_HOLDER = 5, F_P = 6, F_C = 7, F_ROUNDS = 8, F_GN = 9, F_RET = 10;
const FIELDS = 11;
// a generation: 0 = absent, else 1 + end + 2 * owner; owner: 0 none, 1 tomb, 2 + 2i = [i p], 3 + 2i = [i p, i c]
const O_NONE = 0, O_TOMB = 1;

type State = Uint16Array;
export type Invariant = 'S1' | 'S2';
const BOTH: ReadonlySet<Invariant> = new Set<Invariant>(['S1', 'S2']);

interface Layout {
  cfg: Required<Omit<ModelConfig, 'mutant'>> & { mutant: Mutant | '' };
  slots: number; // generations 1..cap+1 live at indices 1..cap+1 (cap+1 only for the solo liveness runs)
  base: number;
  deathsAt: number;
  size: number;
}

function checkConfig(cfg: ModelConfig): Layout['cfg'] {
  if (cfg === null || typeof cfg !== 'object') throw new TypeError('model config: an object is required');
  const ints: Array<[keyof ModelConfig, number, number]> = [['actors', 1, 3], ['rounds', 0, 4], ['deaths', 0, 3], ['cap', 1, 8]];
  for (const [k, lo, hi] of ints) {
    const v = cfg[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new TypeError(`model config: ${k} must be an integer in ${lo}..${hi} (got ${String(v)})`);
  }
  for (const k of ['gc', 'handoff'] as const) {
    if (typeof cfg[k] !== 'boolean') throw new TypeError(`model config: ${k} must be a boolean (got ${String(cfg[k])})`);
  }
  const mutant = cfg.mutant ?? '';
  if (mutant !== '' && !ALL_MUTANTS.includes(mutant)) throw new TypeError(`model config: unknown mutant ${String(mutant)}`);
  const c4 = cfg.c4 ?? 'loose';
  if (c4 !== 'loose' && c4 !== 'strict') throw new TypeError(`model config: c4 must be 'loose' or 'strict' (got ${String(c4)})`);
  return { actors: cfg.actors, rounds: cfg.rounds, deaths: cfg.deaths, gc: cfg.gc, cap: cfg.cap, handoff: cfg.handoff, mutant, c4 };
}

function layoutOf(cfg: ModelConfig): Layout {
  const c = checkConfig(cfg);
  const slots = c.cap + 1;
  const base = slots + 1;
  const deathsAt = base + c.actors * FIELDS;
  return { cfg: c, slots, base, deathsAt, size: deathsAt + 1 };
}

const keyOf = (s: State): string => String.fromCharCode.apply(null, s as unknown as number[]);

class Model {
  readonly L: Layout;
  readonly reach: Reach = { REC: 0, WD: 0, GCLIVE: 0, TOMBWIN: 0, WRITERWIN: 0, HOREL: 0, LOOSE: 0 };
  constructor(cfg: ModelConfig) {
    this.L = layoutOf(cfg);
  }

  initial(): State {
    // no generations; every actor at a0 with its parent alive
    const s = new Uint16Array(this.L.size);
    for (let i = 0; i < this.L.cfg.actors; i++) s[this.at(i, F_P)] = 1;
    return s;
  }

  at(i: number, f: number): number {
    return this.L.base + i * FIELDS + f;
  }

  maxGen(s: State): number {
    for (let k = this.L.slots; k >= 1; k--) if (s[k] !== 0) return k;
    return 0;
  }

  groupAlive(s: State, i: number): boolean {
    return s[this.at(i, F_P)] === 1 || s[this.at(i, F_C)] === 1;
  }

  /** The records of an owner code are all dead (jk). */
  recordsAlive(s: State, owner: number): boolean {
    const i = (owner - 2) >> 1;
    return s[this.at(i, F_P)] === 1 || ((owner & 1) === 1 && s[this.at(i, F_C)] === 1);
  }

  violation(s: State, check: ReadonlySet<'S1' | 'S2'> = BOTH): string | null {
    let live = 0;
    for (let i = 0; i < this.L.cfg.actors; i++) {
      const holder = s[this.at(i, F_HOLDER)] === 1;
      if ((holder && this.groupAlive(s, i)) || s[this.at(i, F_C)] === 1) live++;
    }
    if (live > 1 && check.has('S1')) return 'two live holders'; // S1 (the handoff group counts as one)
    if (!check.has('S2')) return null;
    for (let i = 0; i < this.L.cfg.actors; i++) {
      if (s[this.at(i, F_HOLDER)] !== 1 || !this.groupAlive(s, i)) continue;
      const g = s[s[this.at(i, F_MINE)]];
      if (g === 0 || ((g - 1) & 1) === 1) return `live holder ${i} displaced`; // S2
    }
    return null;
  }

  /**
   * Every step from s, in gen-model3's order. `limit` is the largest generation a2 may create; `solo`
   * restricts to one actor's own steps (no deaths) for the liveness runs.
   */
  steps(s: State, limit: number, solo = -1): Array<[string, State]> {
    const { cfg } = this.L;
    const out: Array<[string, State]> = [];
    const R = this.reach;
    const mut = cfg.mutant;
    for (let i = 0; i < cfg.actors; i++) {
      if (solo >= 0 && i !== solo) continue;
      if (!this.groupAlive(s, i)) continue;
      const at = (f: number): number => this.at(i, f);
      const pc = s[at(F_PC)];
      const c = s[at(F_C)];
      if (s[at(F_P)] === 0) {
        // only the handed-off child runs: its exit is the one step
        const z = s.slice(); z[at(F_C)] = 2; out.push([`${i}:child-exit`, z]);
        continue;
      }
      if (cfg.gc && (pc === PC.a0 || pc === PC.done)) {
        const mm = this.maxGen(s);
        for (let k = 1; k <= this.L.slots; k++) {
          if (s[k] === 0 || !(mut === 'gc-max' ? k <= mm : k < mm)) continue;
          const z = s.slice(); z[at(F_GN)] = k; z[at(F_RET)] = pc + 1; z[at(F_PC)] = PC.g1;
          out.push([`${i}:gc-list(${k})`, z]);
        }
      }
      if (c === 1) { const z = s.slice(); z[at(F_C)] = 2; out.push([`${i}:child-exit`, z]); }
      if (pc === PC.done) continue;
      const n = s.slice();
      const label = `${i}:${PC_NAME[pc]}`;
      let pushed = true;
      const M = s[at(F_M)], mine = s[at(F_MINE)], T = s[at(F_T)];
      const set = (f: number, v: number): void => { n[at(f)] = v; };
      const ended = (g: number): boolean => ((g - 1) & 1) === 1;
      const ownerOf = (g: number): number => (g - 1) >> 1;
      const withEnd = (g: number): number => (ended(g) ? g : g + 1);
      const withOwner = (g: number, o: number): number => 1 + (ended(g) ? 1 : 0) + 2 * o;
      switch (pc) {
        case PC.a0:
          if (s[at(F_ROUNDS)] >= cfg.rounds) set(F_PC, PC.done);
          else { set(F_M, this.maxGen(n)); set(F_PC, PC.a1); }
          break;
        case PC.a1:
          if (M === 0) set(F_PC, PC.a2);
          else if (n[M] === 0) {
            if (mut === 'c4-stuck') { /* waits for the vanished generation forever */ }
            else if (cfg.c4 === 'loose') { R.LOOSE++; set(F_T, M); set(F_PC, PC.j0); }
            else set(F_PC, PC.a0);
          } else { set(F_PC, ended(n[M]) ? PC.a2 : PC.j0); set(F_T, M); }
          break;
        case PC.g1: {
          const k = s[at(F_GN)];
          if (n[k] !== 0 && !ended(n[k])) R.GCLIVE++;
          n[k] = 0;
          set(F_PC, s[at(F_RET)] - 1);
          break;
        }
        case PC.a2: {
          const N = M + 1;
          if (N > limit) set(F_PC, PC.done);
          else if (n[N] !== 0) set(F_PC, PC.a0);
          else { n[N] = 1; if (N < this.maxGen(n)) R.REC++; set(F_MINE, N); set(F_PC, PC.a3); }
          break;
        }
        case PC.a3: {
          const g = n[mine];
          if (g !== 0 && ownerOf(g) === O_TOMB) R.TOMBWIN++;
          if (g === 0 || ownerOf(g) !== O_NONE) set(F_PC, PC.a0);
          else { n[mine] = withOwner(g, 2 + 2 * i); set(F_PC, mut === 'no-postcheck' ? PC.hh : PC.a4); }
          break;
        }
        case PC.a4:
          if (this.maxGen(n) > mine) {
            R.WD++;
            if (n[mine] !== 0 && !ended(n[mine])) n[mine] = withEnd(n[mine]);
            set(F_PC, PC.a0);
          } else { set(F_HOLDER, 1); set(F_PC, PC.h); }
          break;
        case PC.hh:
          set(F_HOLDER, 1); set(F_PC, PC.h);
          break;
        case PC.h: {
          pushed = false;
          if (c !== 1 || mut === 'release-live-child') { set(F_PC, PC.r0); out.push([`${i}:h->release`, n]); }
          if (cfg.handoff && c === 0) {
            const z = s.slice();
            const g = z[mine];
            if (g !== 0 && ownerOf(g) >= 2) { z[mine] = withOwner(g, ownerOf(g) | 1); z[at(F_C)] = 1; out.push([`${i}:handoff`, z]); }
          }
          if (c === 1) { const z = s.slice(); z[at(F_P)] = 0; out.push([`${i}:parent-exit`, z]); }
          break;
        }
        case PC.r0:
          if (n[mine] !== 0) n[mine] = withEnd(n[mine]);
          if (c !== 0) R.HOREL++;
          set(F_HOLDER, 0); set(F_ROUNDS, s[at(F_ROUNDS)] + 1); set(F_PC, PC.a0);
          break;
        case PC.j0: {
          const g = n[T];
          if (g === 0 && mut === 'c4-stuck') break;
          if (g === 0 || ended(g)) { set(F_PC, PC.a0); break; }
          const o = ownerOf(g);
          if (o === O_NONE && mut === 'no-tomb') break; // waits on the ownerless generation forever
          if (o === O_NONE) set(F_PC, mut === 'tomb-separate' ? PC.j2 : PC.j1);
          else if (o === O_TOMB) set(F_PC, PC.j2);
          else { set(F_SNAP, o); set(F_PC, PC.jk); }
          break;
        }
        case PC.jk:
          set(F_PC, this.recordsAlive(n, s[at(F_SNAP)]) ? PC.a0 : mut === 'no-relist' ? PC.j2 : PC.jr);
          break;
        case PC.jr: {
          const g = n[T];
          if (g === 0 && mut === 'c4-stuck') break;
          set(F_PC, g === 0 || ended(g) || ownerOf(g) < 2 || ownerOf(g) !== s[at(F_SNAP)] ? PC.a0 : PC.j2);
          break;
        }
        case PC.j1: {
          const g = n[T];
          if (g !== 0 && ownerOf(g) === O_NONE) { n[T] = withOwner(g, O_TOMB); set(F_PC, PC.j2); }
          else { if (g !== 0 && ownerOf(g) >= 2) R.WRITERWIN++; set(F_PC, PC.a0); }
          break;
        }
        case PC.j2:
          if (n[T] !== 0) n[T] = withEnd(n[T]);
          set(F_PC, PC.a0);
          break;
        default:
          throw new Error(`model: unknown pc ${pc}`);
      }
      if (pushed) out.push([label, n]);
      if (solo < 0 && s[this.L.deathsAt] < cfg.deaths) {
        const d = s.slice();
        d[at(F_P)] = 0;
        if (d[at(F_C)] === 1) d[at(F_C)] = 2;
        d[this.L.deathsAt]++;
        out.push([`${i}:DIE@${PC_NAME[pc]}`, d]);
      }
    }
    return out;
  }
}

/** A hand-made start state (the "seeded" searches): generations and actor fields by name. */
export interface Seed {
  gens?: Record<number, { owner: 'none' | 'tomb' | { actor: number; child: boolean }; end?: boolean }>;
  actors?: Record<number, Partial<{ pc: keyof typeof PC; M: number; mine: number; T: number; holder: 0 | 1; p: 0 | 1; c: 0 | 1 | 2; rounds: number }>>;
}

function seeded(m: Model, seed: Seed): State {
  const s = m.initial();
  for (const [k, g] of Object.entries(seed.gens ?? {})) {
    const o = g.owner === 'none' ? O_NONE : g.owner === 'tomb' ? O_TOMB : 2 + 2 * g.owner.actor + (g.owner.child ? 1 : 0);
    s[Number(k)] = 1 + (g.end ? 1 : 0) + 2 * o;
  }
  const fieldOf = { M: F_M, mine: F_MINE, T: F_T, holder: F_HOLDER, p: F_P, c: F_C, rounds: F_ROUNDS } as const;
  for (const [i, a] of Object.entries(seed.actors ?? {})) {
    for (const [f, v] of Object.entries(a)) {
      if (f === 'pc') s[m.at(Number(i), F_PC)] = PC[v as keyof typeof PC];
      else s[m.at(Number(i), fieldOf[f as keyof typeof fieldOf])] = v as number;
    }
  }
  return s;
}

/**
 * Explore every interleaving (depth first, gen-model3's order) and stop at the first S1・S2 violation.
 * `trace` keeps parent links so the violation's path can be returned (for the small mutant runs).
 */
export function exploreSafety(cfg: ModelConfig, opts: { trace?: boolean; seed?: Seed; check?: Invariant[] } = {}): SafetyResult {
  const check = new Set<Invariant>(opts.check ?? ['S1', 'S2']);
  const m = new Model(cfg);
  const start = opts.seed ? seeded(m, opts.seed) : m.initial();
  const seen = new Set<string>([keyOf(start)]);
  const parent = opts.trace ? new Map<string, [string, string]>() : null;
  const stack: State[] = [start];
  let states = 0;
  while (stack.length > 0) {
    const s = stack.pop() as State;
    states++;
    const v = m.violation(s, check);
    if (v) {
      const trace: string[] = [];
      if (parent) for (let k = keyOf(s), p = parent.get(k); p; k = p[0], p = parent.get(k)) trace.unshift(p[1]);
      return { states, violation: v, trace, reach: m.reach };
    }
    for (const [label, n] of m.steps(s, m.L.cfg.cap)) {
      const k = keyOf(n);
      if (seen.has(k)) continue;
      seen.add(k);
      if (parent) parent.set(k, [keyOf(s), label]);
      stack.push(n);
    }
  }
  return { states, violation: null, trace: [], reach: m.reach };
}

export interface LivenessResult {
  states: number;
  /** start states checked: every other actor done or dead, the remaining actor alive, not holding, rounds left */
  starts: number;
  failure: { actor: number; kind: 'cycle' | 'stuck'; trace: string[] } | null;
}

/**
 * S4 (liveness, V3-3): from every reachable state in which every other actor has finished (done or its
 * group dead), the remaining actor alone becomes the holder on every path in finitely many steps — no
 * cycle and no dead end before it holds. The solo runs may create one generation beyond the cap (the
 * cap bounds the search, not the protocol).
 */
export function exploreLiveness(cfg: ModelConfig): LivenessResult {
  const m = new Model(cfg);
  const { actors, rounds } = m.L.cfg;
  const start = m.initial();
  const seen = new Set<string>([keyOf(start)]);
  const stack: State[] = [start];
  const memo = new Map<string, 0 | 1 | 2>(); // 0 on the path, 1 holds on every path, 2 fails
  let states = 0, starts = 0;
  const finished = (s: State, j: number): boolean => s[m.at(j, F_PC)] === PC.done || !m.groupAlive(s, j);
  const solve = (s: State, x: number, path: string[]): { kind: 'cycle' | 'stuck'; trace: string[] } | null => {
    if (s[m.at(x, F_HOLDER)] === 1) return null;
    const k = x + keyOf(s);
    const seenAs = memo.get(k);
    if (seenAs === 1) return null;
    if (seenAs === 0) return { kind: 'cycle', trace: path };
    if (seenAs === 2) return { kind: 'stuck', trace: path };
    memo.set(k, 0);
    const next = m.steps(s, m.L.cfg.cap + 1, x);
    if (next.length === 0) { memo.set(k, 2); return { kind: 'stuck', trace: path }; }
    for (const [label, n] of next) {
      const bad = solve(n, x, [...path, label]);
      if (bad) { memo.set(k, 2); return bad; }
    }
    memo.set(k, 1);
    return null;
  };
  while (stack.length > 0) {
    const s = stack.pop() as State;
    states++;
    for (let x = 0; x < actors; x++) {
      if (s[m.at(x, F_P)] !== 1 || s[m.at(x, F_C)] === 1 || s[m.at(x, F_HOLDER)] === 1) continue;
      if (s[m.at(x, F_ROUNDS)] >= rounds) continue;
      // finished (or on its way back to done from a gc step): the cap bounds the search, not the protocol
      if (s[m.at(x, F_PC)] === PC.done || (s[m.at(x, F_PC)] === PC.g1 && s[m.at(x, F_RET)] === PC.done + 1)) continue;
      let others = true;
      for (let j = 0; j < actors && others; j++) if (j !== x && !finished(s, j)) others = false;
      if (!others) continue;
      starts++;
      const bad = solve(s, x, []);
      if (bad) return { states, starts, failure: { actor: x, ...bad } };
    }
    for (const [, n] of m.steps(s, m.L.cfg.cap)) {
      const k = keyOf(n);
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(n);
    }
  }
  return { states, starts, failure: null };
}

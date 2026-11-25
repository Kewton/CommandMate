/**
 * Issue #4559 — the abstract model of design A (the generation chain, docs/design/machine-lock-generation-4559.md).
 * Not repository code: it explores every interleaving of a few actors over the generation directory
 * `<name>.gen/g<N>/` and checks the invariants S1・S2 (and S4 from finished states). T1 runs it
 * (machine-lock-generation-model-4559.test.ts).
 *
 * Ported from the leader's v3.1 model (workspace lead-model-4559/gen-model3.mjs, C4_LOOSE=1 branch). Same
 * steps in the same order; the state is a small integer array instead of an object tree. Changes from the
 * port (each recorded in the design §7):
 *   - an actor whose parent has exited (only the handed-off children run) walks only `child-exit`
 *     (gen-model3 let it keep releasing and acquiring under release-live-child, which muddled the red trace)
 *   - the loose C4 is the default (`c4: 'loose'`); no env switch
 *   - a holder may hand off twice per hold (`owner.h1`, `owner.h2`, one child each), so the re-list of C3
 *     (`lstat h<k+1>`) runs with k = 0 and k ≥ 1; a release clears the exited children of that hold
 *   - an `abort` step after the owner link (the post-list unreadable, a defence failed, an exception): the
 *     actor links `end` into its own generation and starts over (design §4.1)
 *   - reach counts: `GCLIVE` = "the gc removed a non-maximum generation that had no `end`" (not a live
 *     holder's generation); `HOREL` = "a release of a generation that holds child records"; `LSTATH2` = "the
 *     re-list lstat'd h2 or later (it had judged h1)"; `DEADREC` = "a recoverer ended a generation with owner records";
 *     `HOLDERDIE` = "a holder died while holding"; `ABORT` = "an actor gave up after its owner link"
 *   - the liveness check S4 and its mutants
 *   - the mutants are one table (MUTANT_TABLE). Every branch on a mutant goes through `pick`, which throws
 *     when called at a step the mutant's row does not declare, and marks the successor's label with `*`
 *     when the mutant's side was taken — so a mutant's red must come through its declared step. T1's rows
 *     and titles, and the design's §7.2・§7.3, are made from the table
 *
 * Steps (one atomic step each; every actor can be delayed at any point for any length and any number of
 * times — the interleaving is exhaustive — can die at any point, and any actor at a0/done can run the gc):
 *   a0  list: read the maximum M (or finish when its rounds are used up)
 *   a1  read g<M>/end: ended → a2, not ended → judge (j0), gone → loose C4: judge (j0)
 *   a2  mkdir g<M+1> (EEXIST → a0)
 *   a3  link owner into g<N> (EEXIST: a writer or a tomb won → a0)
 *   a4  post-list: a larger generation → link the withdraw `end` into g<N> and start over; none → holder
 *       (the withdraw `end` is a mark for diagnosis and the gc, not a condition of S1・S2・S4: nobody judges
 *       a non-maximum generation and the gc does not read `end` — design §4.1); or abort: link `end` into
 *       g<N> (which may be the maximum) and start over
 *   h   holder: release once no live child is left / hand off (add owner.h<k+1>, k < 2) / the parent exits
 *   r0  link g<N>/end (released)
 *   j0  judge g<T>: ended or gone → a0; no owner → tomb (j1); tomb → end (j2); records → check them (jk)
 *   jk  all records dead → re-list (jr, C3); any alive → a0
 *   jr  lstat h<k+1> after the k judged records: absent and no end → j2, else a0
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
 * the by-path realpath name (C7), the multiple defence of §4.1 step 6, the ownerless grace (zero here: the
 * safe side), the child's signal timeout, and a holder that stays alive and never releases (S4 starts from
 * states whose other actors have finished; a stuck live holder is out of its range). A non-holder's release
 * (D5・D6・needs-head) uses only the recovery core (V3-1), so the recoverer's steps j0〜j2 stand for it.
 *
 * What machines do not close (people read them, design §7.5): what each reach count means against the
 * code that counts it, and a mutant row's "変える所" text against the code at its declared step.
 */

/** The names of the design's §5, in its order. */
export const NAMES = ['L1', 'L2', 'L3', 'L4', 'L5', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;

/**
 * The design's names (§5) that the model does not check, and the implementation test that does. The
 * names T1 checks are the generated §7.3 (`t1Checks`); T7 compares both with §5.
 */
export const NOT_IN_MODEL: Readonly<Record<string, string>> = {
  C2: 'T2: readdir returns the maximum present for the whole scan (APFS)',
  C5: 'T3: the 12-digit generation names, the same format in the three implementations',
  C6: 'T2: `.gen` is never removed; an unreadable `.gen` takes nothing',
  C7: 'T2・T3: the by-path name from the realpath of the parent',
  C8: 'T2: tmp names carry the token and are never reused',
  S5: 'T5: the old writers see the generation holder as the beacon holder',
};

export const REACH_KEYS = ['REC', 'WD', 'GCLIVE', 'TOMBWIN', 'WRITERWIN', 'HOREL', 'LOOSE', 'LSTATH2', 'DEADREC', 'HOLDERDIE', 'ABORT'] as const;
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
  /** how many handoffs (owner.h1, owner.h2) one hold may make; default 2 */
  handoffs?: 1 | 2;
  /** whether an actor may give up after its owner link (the abort step); default false */
  abort?: boolean;
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

/** The combinations T1 runs (design §7.1). */
export const COMBOS = {
  '(i)': { actors: 2, rounds: 2, deaths: 1, gc: true, cap: 3, handoff: true },
  '(ii)': { actors: 2, rounds: 3, deaths: 0, gc: true, cap: 4, handoff: false },
  '(iii)': { actors: 2, rounds: 1, deaths: 1, gc: true, cap: 3, handoff: true, abort: true },
} as const satisfies Record<string, ModelConfig>;
export type ComboName = keyof typeof COMBOS;

/** The steps a mutant may branch at: the program counters, the gc's choice (`gc-list`) and the abort step. */
export type StepName = 'a1' | 'a3' | 'h' | 'j0' | 'jk' | 'jr' | 'gc-list' | 'abort';

export interface MutantRow {
  name: string;
  /** the invariants it must break */
  property: 'S1・S2' | 'S4';
  combo: ComboName;
  /** where `pick` may be called for it; anywhere else throws */
  steps: readonly StepName[];
  /** the lemmas / conditions of §5 it breaks */
  breaks: readonly string[];
  /** reach counts its red run must have walked (besides its own `*` step) */
  reach: readonly ReachKey[];
  /** what it changes (people read this against the code at `steps`, design §7.5) */
  change: string;
  /** an optional control: the same mutant with these settings is green */
  control?: { config: Partial<ModelConfig>; text: string };
  /** the red run: safety — the states walked to the first violation and that violation; liveness — the states of its (green) safety walk */
  expect: { kind: 'safety'; states: number; first: string } | { kind: 'liveness'; safeStates: number };
}

/** The mutants: the one table T1's rows and titles and the design's §7.2・§7.3 are made from. */
export const MUTANT_TABLE = [
  {
    name: 'gc-max', property: 'S1・S2', combo: '(i)', steps: ['gc-list'], breaks: ['L1', 'C1'], reach: ['GCLIVE'],
    change: '片付けが最大の世代も選ぶ',
    expect: { kind: 'safety', states: 5_596, first: 'live holder 1 displaced' },
  },
  {
    name: 'no-postcheck', property: 'S1・S2', combo: '(ii)', steps: ['a3'], breaks: ['L3'], reach: [],
    change: '取得の後の一覧を外す（`owner` を `link` したらすぐ保有者）',
    expect: { kind: 'safety', states: 100_958, first: 'live holder 1 displaced' },
  },
  {
    name: 'tomb-separate', property: 'S1・S2', combo: '(i)', steps: ['j0'], breaks: ['L4'], reach: [],
    change: '墓を `owner` と別の名前にする（主の無い世代に墓を奪い合わずに `end` を書く）',
    expect: { kind: 'safety', states: 34_622, first: 'live holder 1 displaced' },
  },
  {
    name: 'no-relist', property: 'S1・S2', combo: '(i)', steps: ['jk'], breaks: ['L5', 'C3'], reach: ['DEADREC'],
    change: '全員死の後の読み直しを外す',
    expect: { kind: 'safety', states: 21_124, first: 'live holder 1 displaced' },
  },
  {
    name: 'relist-h1-only', property: 'S1・S2', combo: '(i)', steps: ['jr'], breaks: ['C3'], reach: ['LSTATH2'],
    change: '読み直しがいつも `h1` を見る（判定した最後の `h<k>` の次ではなく）',
    control: { config: { handoffs: 1 }, text: '引渡しを 1 回までにすると緑' },
    expect: { kind: 'safety', states: 21_158, first: 'live holder 1 displaced' },
  },
  {
    name: 'release-live-child', property: 'S1・S2', combo: '(i)', steps: ['h'], breaks: [], reach: ['HOREL'],
    change: '子が走っている間に解放する（§4.2）',
    expect: { kind: 'safety', states: 18_552, first: 'live holder 1 displaced' },
  },
  {
    name: 'c4-stuck', property: 'S4', combo: '(i)', steps: ['a1', 'j0', 'jr'], breaks: ['C4'], reach: [],
    change: '消えた世代を永遠に待つ',
    expect: { kind: 'liveness', safeStates: 4_344_145 },
  },
  {
    name: 'no-tomb', property: 'S4', combo: '(i)', steps: ['j0'], breaks: [], reach: [],
    change: '主の無い世代に墓を置かず、そこで待ち続ける（§4.4）',
    expect: { kind: 'liveness', safeStates: 1_833_021 },
  },
  {
    name: 'abort-no-end', property: 'S4', combo: '(iii)', steps: ['abort'], breaks: [], reach: ['ABORT'],
    change: '`owner` を `link` した後に諦めるとき、自分の世代に `end` を書かない（§4.1）',
    expect: { kind: 'liveness', safeStates: 281_609 },
  },
] as const satisfies readonly MutantRow[];

export type Mutant = (typeof MUTANT_TABLE)[number]['name'];
const MUTANT_BY_NAME: ReadonlyMap<string, MutantRow> = new Map(MUTANT_TABLE.map((r) => [r.name, r as MutantRow]));
const ALL_MUTANTS: readonly string[] = MUTANT_TABLE.map((r) => r.name);

/** The names T1 checks by the walk itself, without a mutant (design §7.3). */
export const WALK_CHECKS: Readonly<Record<string, string>> = {
  L2: '交互の順の網羅（判定の後に任意に止まる）で S1・S2 の違反 0',
  C4: '緩めた C4 を既定にした網羅（到達の数 LOOSE）',
  S1: '(i)・(ii)・(iii) と始まりを変えた探索の網羅で違反 0',
  S2: '(i)・(ii)・(iii) と始まりを変えた探索の網羅で違反 0',
  S3: '停止の長さ・回数に上限の無い交互の順の網羅',
  S4: '(i)・(iii) で、他の者が全員終わった全ての状態から残る 1 者が保有者になる',
};

/** Each name T1 checks and how (the generated §7.3): the walk's check, then the mutants that break it. */
export function t1Checks(): Array<{ name: string; how: string }> {
  return NAMES.flatMap((name) => {
    const red = MUTANT_TABLE.filter((r) => (r.breaks as readonly string[]).includes(name) || r.property.split('・').includes(name)).map((r) => `\`${r.name}\``);
    const parts = [WALK_CHECKS[name], red.length > 0 ? `${red.join('・')} が赤（§7.2）` : undefined].filter((x): x is string => x !== undefined);
    return parts.length === 0 ? [] : [{ name, how: parts.join('。') }];
  });
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** The design's §7.2 table, made from MUTANT_TABLE. */
export function renderMutantTable(): string {
  const rows = MUTANT_TABLE.map((r) => {
    const row = r as MutantRow;
    const red = row.expect.kind === 'safety'
      ? `${fmt(row.expect.states)} 状態で最初の違反 \`${row.expect.first}\`。S1 だけ・S2 だけを見ても赤`
      : `S4 で輪（安全は ${fmt(row.expect.safeStates)} 状態で違反 0）`;
    const control = row.control ? `。対照: ${row.control.text}` : '';
    const reach = row.reach.length > 0 ? row.reach.join('・') : '—';
    const breaks = row.breaks.length > 0 ? row.breaks.join('・') : '—';
    return `| \`${row.name}\` | ${row.property} | ${row.combo} | ${row.steps.join('・')} | ${breaks} | ${reach} | ${row.change} | ${red}${control} |`;
  });
  return ['| 壊した版 | 見る性質 | 組 | 変える歩 | 崩す名前 | 届く到達の数 | 変える所 | 赤 |', '|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

/** The design's §7.3 table, made from MUTANT_TABLE and WALK_CHECKS. */
export function renderT1Checks(): string {
  return ['| 名 | T1 での確かめ |', '|---|---|', ...t1Checks().map((c) => `| ${c.name} | ${c.how} |`)].join('\n');
}

// program counters
const PC = { a0: 0, a1: 1, a2: 2, a3: 3, a4: 4, hh: 5, h: 6, r0: 7, j0: 8, jk: 9, jr: 10, j1: 11, j2: 12, g1: 13, done: 14 } as const;
const PC_NAME = Object.keys(PC);
// actor fields; C1・C2 are the children of owner.h1・owner.h2 of the current hold (0 none, 1 running, 2 exited)
const F_PC = 0, F_M = 1, F_MINE = 2, F_T = 3, F_SNAP = 4, F_HOLDER = 5, F_P = 6, F_C1 = 7, F_C2 = 8, F_ROUNDS = 9, F_GN = 10, F_RET = 11;
const FIELDS = 12;
const MAX_HANDOFFS = 2;
// a generation: 0 = absent, else 1 + end + 2 * owner
// owner: 0 none, 1 tomb, 2 + 3i + k = the records [i p, i h1 … i hk] (k = 0..2)
const O_NONE = 0, O_TOMB = 1;
const ownerCode = (i: number, k: number): number => 2 + 3 * i + k;
const ownerActor = (o: number): number => Math.floor((o - 2) / 3);
const ownerK = (o: number): number => (o - 2) % 3;

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
  const handoffs = cfg.handoffs ?? MAX_HANDOFFS;
  if (handoffs !== 1 && handoffs !== 2) throw new TypeError(`model config: handoffs must be 1 or 2 (got ${String(handoffs)})`);
  const abort = cfg.abort ?? false;
  if (typeof abort !== 'boolean') throw new TypeError(`model config: abort must be a boolean (got ${String(abort)})`);
  return { actors: cfg.actors, rounds: cfg.rounds, deaths: cfg.deaths, gc: cfg.gc, cap: cfg.cap, handoff: cfg.handoff, handoffs, abort, mutant, c4 };
}

function layoutOf(cfg: ModelConfig): Layout {
  const c = checkConfig(cfg);
  const slots = c.cap + 1;
  const base = slots + 1;
  const deathsAt = base + c.actors * FIELDS;
  return { cfg: c, slots, base, deathsAt, size: deathsAt + 1 };
}

/**
 * The set of states seen, packed 5 bits a field into a flat Uint32Array with an open-addressing index, so
 * that millions of states stay a few hundred MB (a Set of string keys took several times that). Each entry
 * also carries a byte of flags (the liveness walk's seen bit and per-actor verdicts).
 */
class StateTable {
  private readonly width: number; // 32-bit words per entry
  private data: Uint32Array;
  private flags: Uint8Array;
  private index: Int32Array; // entry number + 1, 0 = free
  private count = 0;
  private readonly scratch: Uint32Array;
  constructor(private readonly fields: number) {
    this.width = Math.ceil((fields * 5) / 32);
    this.scratch = new Uint32Array(this.width);
    this.data = new Uint32Array(this.width * 1024);
    this.flags = new Uint8Array(1024);
    this.index = new Int32Array(2048);
  }

  get size(): number {
    return this.count;
  }

  private pack(s: State): void {
    this.scratch.fill(0);
    for (let f = 0; f < this.fields; f++) {
      const v = s[f];
      if (v > 31) throw new Error(`model: field ${f} = ${v} does not fit in 5 bits`);
      const bit = f * 5, w = bit >>> 5, o = bit & 31;
      this.scratch[w] |= v << o;
      if (o > 27) this.scratch[w + 1] |= v >>> (32 - o);
    }
  }

  private hash(): number {
    let h = 0x811c9dc5;
    for (let w = 0; w < this.width; w++) h = Math.imul(h ^ this.scratch[w], 0x01000193);
    return (h ^ (h >>> 15)) >>> 0;
  }

  private slotOf(): number {
    const mask = this.index.length - 1;
    for (let i = this.hash() & mask; ; i = (i + 1) & mask) {
      const e = this.index[i];
      if (e === 0) return i;
      const base = (e - 1) * this.width;
      let same = true;
      for (let w = 0; w < this.width && same; w++) same = this.data[base + w] === this.scratch[w];
      if (same) return i;
    }
  }

  private grow(): void {
    const data = new Uint32Array(this.data.length * 2);
    data.set(this.data);
    this.data = data;
    const flags = new Uint8Array(this.flags.length * 2);
    flags.set(this.flags);
    this.flags = flags;
    this.index = new Int32Array(this.index.length * 2);
    const mask = this.index.length - 1;
    for (let e = 0; e < this.count; e++) {
      this.scratch.set(this.data.subarray(e * this.width, (e + 1) * this.width));
      let i = this.hash() & mask;
      while (this.index[i] !== 0) i = (i + 1) & mask;
      this.index[i] = e + 1;
    }
  }

  /** The entry of s, adding it (flags 0) when new. */
  entry(s: State): { id: number; added: boolean } {
    this.pack(s);
    const slot = this.slotOf();
    if (this.index[slot] !== 0) return { id: this.index[slot] - 1, added: false };
    if ((this.count + 1) * this.width > this.data.length || (this.count + 1) * 2 > this.index.length) {
      this.grow();
      this.pack(s);
      return this.entry(s);
    }
    this.data.set(this.scratch, this.count * this.width);
    this.index[slot] = this.count + 1;
    return { id: this.count++, added: true };
  }

  state(id: number, size: number): State {
    const s = new Uint16Array(size);
    const base = id * this.width;
    for (let f = 0; f < this.fields; f++) {
      const bit = f * 5, w = bit >>> 5, o = bit & 31;
      let v = this.data[base + w] >>> o;
      if (o > 27) v |= this.data[base + w + 1] << (32 - o);
      s[f] = v & 31;
    }
    return s;
  }

  flag(id: number): number {
    return this.flags[id];
  }

  setFlag(id: number, v: number): void {
    this.flags[id] = v;
  }
}

class Model {
  readonly L: Layout;
  readonly reach: Reach = { REC: 0, WD: 0, GCLIVE: 0, TOMBWIN: 0, WRITERWIN: 0, HOREL: 0, LOOSE: 0, LSTATH2: 0, DEADREC: 0, HOLDERDIE: 0, ABORT: 0 };
  // the solo liveness runs count here, so that `reach` is the walk's alone
  private readonly soloReach: Reach = { ...this.reach };
  private cur: StepName | string = '';
  private hit = false;

  /**
   * The one branch on a mutant: `mutated` when the configured mutant is `name`, else `normal`. Throws when
   * called at a step `name`'s row does not declare (whether or not `name` is the configured mutant), and
   * marks the successor (`*` on its label) when the mutant's side differs from the normal one.
   */
  pick<T>(name: Mutant, mutated: T, normal: T): T {
    const row = MUTANT_BY_NAME.get(name) as MutantRow;
    if (!(row.steps as readonly string[]).includes(this.cur)) throw new Error(`model: ${name} branches at ${this.cur}, but its row declares ${row.steps.join('・')}`);
    if (this.L.cfg.mutant !== name) return normal;
    if (mutated !== normal) this.hit = true;
    return mutated;
  }
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

  childRunning(s: State, i: number): boolean {
    return s[this.at(i, F_C1)] === 1 || s[this.at(i, F_C2)] === 1;
  }

  groupAlive(s: State, i: number): boolean {
    return s[this.at(i, F_P)] === 1 || this.childRunning(s, i);
  }

  /** Any of the records of an owner code is alive (jk judges the snapshot's records). */
  recordsAlive(s: State, owner: number): boolean {
    const i = ownerActor(owner), k = ownerK(owner);
    return s[this.at(i, F_P)] === 1 || (k >= 1 && s[this.at(i, F_C1)] === 1) || (k >= 2 && s[this.at(i, F_C2)] === 1);
  }

  violation(s: State, check: ReadonlySet<'S1' | 'S2'> = BOTH): string | null {
    let live = 0;
    for (let i = 0; i < this.L.cfg.actors; i++) {
      const holder = s[this.at(i, F_HOLDER)] === 1;
      if ((holder && this.groupAlive(s, i)) || this.childRunning(s, i)) live++;
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
   * Every step from s. `limit` is the largest generation a2 may create; `solo` restricts to one actor's
   * own steps without deaths and aborts (a transient failure stops in the end) for the liveness runs.
   */
  steps(s: State, limit: number, solo = -1): Array<[string, State]> {
    const { cfg } = this.L;
    const out: Array<[string, State]> = [];
    const R = solo >= 0 ? this.soloReach : this.reach;
    for (let i = 0; i < cfg.actors; i++) {
      if (solo >= 0 && i !== solo) continue;
      if (!this.groupAlive(s, i)) continue;
      const at = (f: number): number => this.at(i, f);
      const pc = s[at(F_PC)];
      const childExits = (): void => {
        for (const f of [F_C1, F_C2]) {
          if (s[at(f)] !== 1) continue;
          const z = s.slice(); z[at(f)] = 2; out.push([`${i}:child-exit(${f === F_C1 ? 1 : 2})`, z]);
        }
      };
      if (s[at(F_P)] === 0) {
        childExits(); // only the handed-off children run: their exits are the steps
        continue;
      }
      if (cfg.gc && (pc === PC.a0 || pc === PC.done)) {
        const mm = this.maxGen(s);
        this.cur = 'gc-list';
        for (let k = 1; k <= this.L.slots; k++) {
          this.hit = false;
          if (s[k] === 0 || !this.pick('gc-max', k <= mm, k < mm)) continue;
          const z = s.slice(); z[at(F_GN)] = k; z[at(F_RET)] = pc + 1; z[at(F_PC)] = PC.g1;
          out.push([`${i}:gc-list(${k})${this.hit ? '*' : ''}`, z]);
        }
      }
      childExits();
      if (pc === PC.done) continue;
      const n = s.slice();
      const label = `${i}:${PC_NAME[pc]}`;
      let pushed = true;
      this.cur = PC_NAME[pc];
      this.hit = false;
      const star = (): string => (this.hit ? '*' : '');
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
            if (this.pick('c4-stuck', true, false)) { /* waits for the vanished generation forever */ }
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
          else { n[mine] = withOwner(g, ownerCode(i, 0)); set(F_PC, this.pick('no-postcheck', PC.hh, PC.a4)); }
          break;
        }
        case PC.a4:
          if (this.maxGen(n) > mine) {
            R.WD++;
            if (n[mine] !== 0 && !ended(n[mine])) n[mine] = withEnd(n[mine]);
            set(F_PC, PC.a0);
          } else { set(F_HOLDER, 1); set(F_PC, PC.h); }
          if (cfg.abort && solo < 0) {
            // give up after the owner link: end my own generation (it may be the maximum) and start over
            const hitMain = this.hit;
            this.cur = 'abort';
            this.hit = false;
            const z = s.slice();
            R.ABORT++;
            if (z[mine] !== 0 && !ended(z[mine]) && !this.pick('abort-no-end', true, false)) z[mine] = withEnd(z[mine]);
            z[at(F_PC)] = PC.a0;
            out.push([`${i}:abort${star()}`, z]);
            this.cur = PC_NAME[pc];
            this.hit = hitMain;
          }
          break;
        case PC.hh:
          set(F_HOLDER, 1); set(F_PC, PC.h);
          break;
        case PC.h: {
          pushed = false;
          const running = this.childRunning(s, i);
          if (!running || this.pick('release-live-child', true, false)) { set(F_PC, PC.r0); out.push([`${i}:h->release${star()}`, n]); }
          const g = s[mine];
          if (cfg.handoff && g !== 0 && ownerOf(g) >= 2) {
            const k = ownerK(ownerOf(g));
            const slot = k === 0 ? F_C1 : F_C2;
            if (k < cfg.handoffs && s[at(slot)] === 0) {
              const z = s.slice(); z[mine] = withOwner(g, ownerOf(g) + 1); z[at(slot)] = 1;
              out.push([`${i}:handoff(h${k + 1})`, z]);
            }
          }
          if (running) { const z = s.slice(); z[at(F_P)] = 0; out.push([`${i}:parent-exit`, z]); }
          break;
        }
        case PC.r0:
          if (n[mine] !== 0) {
            if (ownerOf(n[mine]) >= 2 && ownerK(ownerOf(n[mine])) >= 1) R.HOREL++;
            n[mine] = withEnd(n[mine]);
          }
          for (const f of [F_C1, F_C2]) if (n[at(f)] === 2) set(f, 0); // the exited children of this hold
          set(F_HOLDER, 0); set(F_ROUNDS, s[at(F_ROUNDS)] + 1); set(F_PC, PC.a0);
          break;
        case PC.j0: {
          const g = n[T];
          if (g === 0 && this.pick('c4-stuck', true, false)) break;
          if (g === 0 || ended(g)) { set(F_PC, PC.a0); break; }
          const o = ownerOf(g);
          if (o === O_NONE && this.pick('no-tomb', true, false)) break; // waits on the ownerless generation forever
          if (o === O_NONE) set(F_PC, this.pick('tomb-separate', PC.j2, PC.j1));
          else if (o === O_TOMB) set(F_PC, PC.j2);
          else { set(F_SNAP, o); set(F_PC, PC.jk); }
          break;
        }
        case PC.jk:
          set(F_PC, this.recordsAlive(n, s[at(F_SNAP)]) ? PC.a0 : this.pick('no-relist', PC.j2, PC.jr));
          break;
        case PC.jr: {
          const g = n[T];
          if (g === 0 && this.pick('c4-stuck', true, false)) break;
          const snap = s[at(F_SNAP)];
          if (ownerK(snap) >= 1) R.LSTATH2++; // the lstat goes to h<k+1> with k ≥ 1
          let unchanged = g !== 0 && !ended(g) && ownerOf(g) >= 2 && ownerActor(ownerOf(g)) === ownerActor(snap);
          // lstat h<k+1> after the k judged records (records only grow, so "absent" = the same set);
          // relist-h1-only always lstats h1
          if (unchanged) unchanged = this.pick('relist-h1-only', (ownerK(ownerOf(g)) >= 1) === (ownerK(snap) >= 1), ownerK(ownerOf(g)) === ownerK(snap));
          set(F_PC, unchanged ? PC.j2 : PC.a0);
          break;
        }
        case PC.j1: {
          const g = n[T];
          if (g !== 0 && ownerOf(g) === O_NONE) { n[T] = withOwner(g, O_TOMB); set(F_PC, PC.j2); }
          else { if (g !== 0 && ownerOf(g) >= 2) R.WRITERWIN++; set(F_PC, PC.a0); }
          break;
        }
        case PC.j2:
          if (n[T] !== 0) {
            if (!ended(n[T]) && ownerOf(n[T]) >= 2) R.DEADREC++;
            n[T] = withEnd(n[T]);
          }
          set(F_PC, PC.a0);
          break;
        default:
          throw new Error(`model: unknown pc ${pc}`);
      }
      if (pushed) out.push([`${label}${star()}`, n]);
      if (solo < 0 && s[this.L.deathsAt] < cfg.deaths) {
        const d = s.slice();
        if (s[at(F_HOLDER)] === 1) R.HOLDERDIE++;
        d[at(F_P)] = 0;
        for (const f of [F_C1, F_C2]) if (d[at(f)] === 1) d[at(f)] = 2;
        d[this.L.deathsAt]++;
        out.push([`${i}:DIE@${PC_NAME[pc]}`, d]);
      }
    }
    return out;
  }
}

/** A hand-made start state (the "seeded" searches): generations and actor fields by name. */
export interface Seed {
  gens?: Record<number, { owner: 'none' | 'tomb' | { actor: number; handoffs: 0 | 1 | 2 }; end?: boolean }>;
  actors?: Record<number, Partial<{ pc: keyof typeof PC; M: number; mine: number; T: number; holder: 0 | 1; p: 0 | 1; c1: 0 | 1 | 2; c2: 0 | 1 | 2; rounds: number }>>;
}

function seeded(m: Model, seed: Seed): State {
  const s = m.initial();
  for (const [k, g] of Object.entries(seed.gens ?? {})) {
    const o = g.owner === 'none' ? O_NONE : g.owner === 'tomb' ? O_TOMB : ownerCode(g.owner.actor, g.owner.handoffs);
    s[Number(k)] = 1 + (g.end ? 1 : 0) + 2 * o;
  }
  const fieldOf = { M: F_M, mine: F_MINE, T: F_T, holder: F_HOLDER, p: F_P, c1: F_C1, c2: F_C2, rounds: F_ROUNDS } as const;
  for (const [i, a] of Object.entries(seed.actors ?? {})) {
    for (const [f, v] of Object.entries(a)) {
      if (f === 'pc') s[m.at(Number(i), F_PC)] = PC[v as keyof typeof PC];
      else s[m.at(Number(i), fieldOf[f as keyof typeof fieldOf])] = v as number;
    }
  }
  return s;
}

/**
 * Explore every interleaving (depth first, gen-model3's order for the steps it shares) and stop at the first S1・S2 violation.
 * `trace` keeps parent links so the violation's path can be returned (for the small mutant runs).
 */
export function exploreSafety(cfg: ModelConfig, opts: { trace?: boolean; seed?: Seed; check?: Invariant[] } = {}): SafetyResult {
  const check = new Set<Invariant>(opts.check ?? ['S1', 'S2']);
  const m = new Model(cfg);
  const start = opts.seed ? seeded(m, opts.seed) : m.initial();
  const seen = new StateTable(m.L.size);
  const parent = opts.trace ? new Map<number, [number, string]>() : null;
  const stack: number[] = [seen.entry(start).id];
  let states = 0;
  while (stack.length > 0) {
    const sk = stack.pop() as number;
    const s = seen.state(sk, m.L.size);
    states++;
    const v = m.violation(s, check);
    if (v) {
      const trace: string[] = [];
      if (parent) for (let k = sk, p = parent.get(k); p; k = p[0], p = parent.get(k)) trace.unshift(p[1]);
      return { states, violation: v, trace, reach: m.reach };
    }
    for (const [label, n] of m.steps(s, m.L.cfg.cap)) {
      const { id: k, added } = seen.entry(n);
      if (!added) continue;
      if (parent) parent.set(k, [sk, label]);
      stack.push(k);
    }
  }
  return { states, violation: null, trace: [], reach: m.reach };
}

export interface LivenessResult {
  states: number;
  /** the first S1・S2 violation met on the way (the walk is the same as exploreSafety's) */
  violation: string | null;
  reach: Reach;
  /** start states checked: every other actor done or dead, the remaining actor alive, not holding, rounds left */
  starts: number;
  /** `prefix`: the walk from the initial state to the start state (only with `trace`); `trace`: the solo run */
  failure: { actor: number; kind: 'cycle' | 'stuck'; trace: string[]; prefix: string[] } | null;
}

/**
 * S4 (liveness, V3-3): from every reachable state in which every other actor has finished (done or its
 * group dead), the remaining actor alone becomes the holder on every path in finitely many steps — no
 * cycle and no dead end before it holds. The solo runs may create one generation beyond the cap (the
 * cap bounds the search, not the protocol).
 */
export function exploreLiveness(cfg: ModelConfig, opts: { trace?: boolean } = {}): LivenessResult {
  const m = new Model(cfg);
  const { actors, rounds } = m.L.cfg;
  const start = m.initial();
  // one table for the walk and the solo runs: flag bit 0 = seen by the walk; bits 1 + 2x, 2 + 2x = actor
  // x's solo verdict (1 on the path, 2 holds on every path, 3 fails)
  const table = new StateTable(m.L.size);
  const first = table.entry(start).id;
  table.setFlag(first, 1);
  const verdict = (k: number, x: number): number => (table.flag(k) >> (1 + 2 * x)) & 3;
  const setVerdict = (k: number, x: number, v: number): void => {
    table.setFlag(k, (table.flag(k) & ~(3 << (1 + 2 * x))) | (v << (1 + 2 * x)));
  };
  const stack: number[] = [first];
  const parent = opts.trace ? new Map<number, [number, string]>() : null;
  const prefixOf = (id: number): string[] => {
    const out: string[] = [];
    if (parent) for (let k = id, p = parent.get(k); p; k = p[0], p = parent.get(k)) out.unshift(p[1]);
    return out;
  };
  let states = 0, starts = 0, violation: string | null = null;
  const finished = (s: State, j: number): boolean => s[m.at(j, F_PC)] === PC.done || !m.groupAlive(s, j);
  const solve = (s: State, x: number, path: string[]): { kind: 'cycle' | 'stuck'; trace: string[] } | null => {
    if (s[m.at(x, F_HOLDER)] === 1) return null;
    const k = table.entry(s).id;
    const seenAs = verdict(k, x);
    if (seenAs === 2) return null;
    if (seenAs === 1) return { kind: 'cycle', trace: path };
    if (seenAs === 3) return { kind: 'stuck', trace: path };
    setVerdict(k, x, 1);
    const next = m.steps(s, m.L.cfg.cap + 1, x);
    if (next.length === 0) { setVerdict(k, x, 3); return { kind: 'stuck', trace: path }; }
    for (const [label, n] of next) {
      const bad = solve(n, x, [...path, label]);
      if (bad) { setVerdict(k, x, 3); return bad; }
    }
    setVerdict(k, x, 2);
    return null;
  };
  while (stack.length > 0) {
    const id = stack.pop() as number;
    const s = table.state(id, m.L.size);
    states++;
    violation ??= m.violation(s);
    for (let x = 0; x < actors; x++) {
      if (s[m.at(x, F_P)] !== 1 || m.childRunning(s, x) || s[m.at(x, F_HOLDER)] === 1) continue;
      if (s[m.at(x, F_ROUNDS)] >= rounds) continue;
      // finished (or on its way back to done from a gc step): the cap bounds the search, not the protocol
      if (s[m.at(x, F_PC)] === PC.done || (s[m.at(x, F_PC)] === PC.g1 && s[m.at(x, F_RET)] === PC.done + 1)) continue;
      let others = true;
      for (let j = 0; j < actors && others; j++) if (j !== x && !finished(s, j)) others = false;
      if (!others) continue;
      starts++;
      const bad = solve(s, x, []);
      if (bad) return { states, starts, violation, reach: m.reach, failure: { actor: x, ...bad, prefix: prefixOf(id) } };
    }
    for (const [label, n] of m.steps(s, m.L.cfg.cap)) {
      const { id: k } = table.entry(n);
      if ((table.flag(k) & 1) === 1) continue;
      table.setFlag(k, table.flag(k) | 1);
      if (parent) parent.set(k, [id, label]);
      stack.push(k);
    }
  }
  return { states, starts, violation, reach: m.reach, failure: null };
}

/**
 * Issue #4604 T-g (設計書 §3.4.1・§5, v4.3): every sequence of the model's moves, up to a length, on the
 * implementation's road.
 *
 * The world, the failures, the moves and the seeds are copied from claude-2's model
 * (`s12/enabler-model-4604/model.mjs`, `MOVEOUT=keep`): keys K・K2; page P1 with composers A (it
 * switches K ↔ K2) and B (it unmounts and mounts), another tab P2 with composer C; failures none ·
 * rThrow · wAll · wShort · wBody · rmThrow; moves ret · a409s · a409u · save · storage · switch · mount
 * · unmount · sendSync · pressAwait · complete · move; 15 seeds. What is copied is the world and the
 * bookkeeping of the ghost variables (which handed-back text each mark represents, and which of them a
 * yes covered). **Every write and read of `:retarget` and every send's check is the implementation's**:
 * `writeRetarget` on an in-memory store with the failure, and `decideRetarget` over `readRetargetStore`.
 *
 * After each move: INV-G (a draft holding a handed-back text no yes covered asks — 案 A': a yes covers
 * only the ids and generations its question saw), INV-S1 (at each single write: a stored text no yes
 * covered is represented by the stored mark or a page's mark), INV-WB (after a write-back the tags the
 * composer held are in the store — as a list, an "unknown", junk — or in its page's mark).
 *
 * Always run: the numbers of new states for lengths 0〜2 (15 / 545 / 19,350, the model's) with no
 * violation, and each broken version red on its shortest sequence of length ≤ 2. With
 * `CM_RETARGET_MODEL_FULL=1` only: length 3 (554,971 new states) and the narrowed length 4 (the
 * awaited-send race moves: 3 / 91 / 2,681 / 49,269 / 708,480), and N7R red there.
 *
 * The model's limits (what this does not check): length 4 only with the race moves, nothing longer;
 * the To never changes or comes back (every tag's original differs from the To — the worst case; one
 * sequence below brings the To back, outside the model); the person's "no" is the move that does
 * nothing; no reload, no page closing between two writes (observed below, not required), no store
 * recovering for other keys; reading the text failing (the composer is left empty) is not here
 * (`MessageInput-draft-keyed-4604`); `appendToStoredDraft`, #4503's mark and #4606's stop are outside
 * it; the model was written from the design's words — this test is the implementation's road on it.
 */
import { describe, it, expect } from 'vitest';
import {
  decideRetarget,
  getRetargetTagKey,
  nextRetarget,
  readRetargetStore,
  writeRetarget,
  type RetargetOp,
  type RetargetTag,
  type RetargetWriteResult,
} from '@/lib/drafts/message-draft';
import { MemoryRetargetStorage, type ModelFail } from '@tests/helpers/draft-store-fault-4604';

// ---------- the world (copied from the model) ----------
type Rt = { t: 'absent' } | { t: 'list'; ids: string[] } | { t: 'unk'; g: number; ids: string[] } | { t: 'junk' } | { t: 'throws' };
interface Comp {
  page: 'P1' | 'P2';
  key: 'K' | 'K2' | null;
  body: string[];
  ref: { key: 'K' | 'K2' | null; ids: string[] };
  pend: { key: 'K' | 'K2'; ids: string[]; seen: number[] | null; body: string[] } | null;
}
interface Handed {
  rep: string[];
  covered: boolean;
  x4?: string[];
}
interface State {
  store: Record<'K' | 'K2', { body: string[]; rt: Rt }>;
  map: Record<'P1' | 'P2', Record<'K' | 'K2', number | null>>;
  comps: Record<'A' | 'B' | 'C', Comp>;
  handed: Record<string, Handed>;
  gen: number;
  hc: number;
}
type Key = 'K' | 'K2';
type Page = 'P1' | 'P2';
type CompName = 'A' | 'B' | 'C';

/** Broken versions, each put into the road the test calls (the fake road) or into the move that uses it. */
interface Mut {
  N7: boolean;
  N9: boolean;
  N10: boolean;
  NOFALLBACK: boolean;
  N1: boolean;
  N7R: boolean;
  /** v4.2's `moveOut`: the `from` side's marks and page mark go too. */
  MOVEOUT_DROP: boolean;
}
const NO_MUT: Mut = { N7: false, N9: false, N10: false, NOFALLBACK: false, N1: false, N7R: false, MOVEOUT_DROP: false };
let MUT: Mut = NO_MUT;

const MAX_NEW_TEXTS = 2;
const FAILS: ModelFail[] = ['none', 'rThrow', 'wAll', 'wShort', 'wBody', 'rmThrow'];
const KEYS: Key[] = ['K', 'K2'];
const PAGES: Page[] = ['P1', 'P2'];
/** Every tag's original target — never the To (the worst case). */
const ORIGINAL = { instanceId: 'codex-2', cliToolId: 'codex' };
const TO = { instanceId: 'claude-2', cliToolId: 'claude' };
const DRAFT: Record<Key, string> = { K: 'commandmate:draft-message:wt-tg:instance:K', K2: 'commandmate:draft-message:wt-tg:instance:K2' };

const uniq = (a: string[]) => [...new Set(a)].sort();
const clone = <T,>(s: T): T => JSON.parse(JSON.stringify(s));
const tagOf = (h: string) => 't' + h;
function R(rt: Rt): string[] {
  if (rt.t === 'list') return rt.ids;
  if (rt.t === 'unk') return [...rt.ids, 'g' + rt.g];
  if (rt.t === 'junk') return ['J'];
  return [];
}
const inter = (a: string[], b: string[]) => a.some((x) => b.includes(x));
const handedTexts = (s: State) => Object.keys(s.handed);
const coveredOf = (s: State, h: string) => s.handed[h]?.covered === true;
const newGen = (s: State) => ++s.gen;

class Violation extends Error {
  constructor(readonly kind: string, msg: string) {
    super(msg);
  }
}
function fail(kind: string, msg: string): never {
  throw new Violation(kind, msg);
}

// ---------- the store's bookkeeping (the model's setRt / setMap, driven by the road's writes) ----------
let CURRENT_N: string[] = [];
function transferStore(s: State, before: Rt, after: Rt) {
  if (after.t !== 'unk') return;
  for (const h of handedTexts(s)) {
    const rep = s.handed[h].rep;
    if ((inter(rep, R(before)) || CURRENT_N.includes(tagOf(h))) && !inter(rep, R(after))) rep.push('g' + after.g);
  }
}
function applyRt(s: State, key: Key, next: Rt, trace: string) {
  const before = s.store[key].rt;
  s.store[key].rt = next;
  transferStore(s, before, next);
  checkS1(s, trace + ` rt(${key})`);
}
function setMap(s: State, page: Page, key: Key, gen: number | null, trace: string) {
  const old = s.map[page][key];
  s.map[page][key] = gen;
  if (old != null && gen != null) for (const h of handedTexts(s)) if (s.handed[h].rep.includes('g' + old)) s.handed[h].rep.push('g' + gen);
  checkS1(s, trace + ` map(${page},${key})=${gen}`);
}
function setBody(s: State, key: Key, body: string[], f: ModelFail, trace: string): boolean {
  if (body.length === 0) {
    if (f === 'rmThrow' || f === 'wAll') return false;
  } else if (f === 'wAll' || f === 'wShort' || f === 'wBody') return false;
  s.store[key].body = uniq(body);
  checkS1(s, trace + ` body(${key})`);
  return true;
}

// ---------- the implementation's road, on an in-memory store built from the state ----------
const genStr = (n: number) => `G${n}`;
const genNum = (g: string) => Number(g.slice(1));
const tagsFor = (ids: string[]): RetargetTag[] => ids.map((id) => ({ id, original: ORIGINAL }));

function storageOf(s: State, f: ModelFail): MemoryRetargetStorage {
  const storage = new MemoryRetargetStorage();
  for (const key of KEYS) {
    const rt = s.store[key].rt;
    const tagKey = getRetargetTagKey(DRAFT[key]);
    if (rt.t === 'list') storage.data.set(tagKey, JSON.stringify(tagsFor(rt.ids)));
    else if (rt.t === 'unk') storage.data.set(tagKey, JSON.stringify({ unknown: genStr(rt.g), tags: tagsFor(rt.ids) }));
    else if (rt.t === 'junk') storage.data.set(tagKey, '{junk');
  }
  storage.fail = f;
  return storage;
}
function decodeRt(value: string | null): Rt {
  if (value === null) return { t: 'absent' };
  const parsed = JSON.parse(value);
  if (Array.isArray(parsed)) return { t: 'list', ids: uniq(parsed.map((tag: RetargetTag) => tag.id)) };
  return { t: 'unk', g: genNum(parsed.unknown), ids: uniq(parsed.tags.map((tag: RetargetTag) => tag.id)) };
}
const keyOf = (draftKey: string): Key => (draftKey === DRAFT.K ? 'K' : 'K2');

type Book = 'add' | 'release' | { move: string[] };

/**
 * Call the implementation's road for (`page`, `key`) and keep the ghost variables as the model does:
 * each write that went in, and each change of the page's mark, in the road's own order.
 */
function road(s: State, page: Page, key: Key, op: RetargetOp, f: ModelFail, trace: string, book: Book): RetargetWriteResult | 'nowrite' {
  const storage = storageOf(s, f);
  let attempt = 0;
  storage.onRetargetWrite = (tagKey, value) => {
    const k = keyOf(tagKey.slice(0, -':retarget'.length));
    const next = decodeRt(value);
    const isShort = attempt > 0;
    applyRt(s, k, next, trace);
    if (book === 'add' && isShort && next.t === 'unk') {
      for (const h of handedTexts(s)) if (CURRENT_N.includes(tagOf(h))) s.handed[h].rep.push('g' + next.g);
      checkS1(s, trace + ' (short)');
    }
    if (typeof book === 'object' && next.t === 'unk' && isShort) {
      for (const h of book.move) s.handed[h].rep.push('g' + next.g);
    }
  };
  const realSet = storage.setItem.bind(storage);
  const realRemove = storage.removeItem.bind(storage);
  storage.setItem = (k, v) => {
    try {
      realSet(k, v);
    } finally {
      attempt += 1;
    }
  };
  storage.removeItem = (k) => {
    try {
      realRemove(k);
    } finally {
      attempt += 1;
    }
  };
  const marks = s.map[page];
  class PageMarks extends Map<string, string> {
    set(k: string, g: string) {
      super.set(k, g);
      if (bookkeeping) {
        const n = genNum(g);
        if (book === 'add') for (const h of handedTexts(s)) if (CURRENT_N.includes(tagOf(h))) s.handed[h].rep.push('g' + n);
        if (typeof book === 'object') for (const h of book.move) s.handed[h].rep.push('g' + n);
        setMap(s, page, keyOf(k), n, trace);
      }
      return this;
    }
    delete(k: string) {
      const had = super.delete(k);
      if (bookkeeping && had) setMap(s, page, keyOf(k), null, trace);
      return had;
    }
  }
  let bookkeeping = false;
  const unstorable = new PageMarks();
  for (const k of KEYS) if (marks[k] != null) unstorable.set(DRAFT[k], genStr(marks[k]!));
  bookkeeping = true;
  const env = { storage, unstorable, newGeneration: () => genStr(newGen(s)) };
  // The model's CURRENT_N: the tags this write puts in (a move-in as a list is the model's `add(fs)`).
  CURRENT_N =
    op.kind === 'add' || op.kind === 'writeBack'
      ? op.tags.map((t) => t.id)
      : op.kind === 'moveIn' && book === 'add' && op.from.kind === 'list'
        ? op.from.tags.map((t) => t.id)
        : [];
  try {
    const result = fakeRoad(DRAFT[key], op, env);
    if (typeof book === 'object' && result === 'unknown-stored') {
      const rt = s.store.K2.rt;
      // The model's move: a full write of the new "unknown" — its generation represents the moved texts.
      if (attempt === 1 && rt.t === 'unk') for (const h of book.move) s.handed[h].rep.push('g' + rt.g);
    }
    return result;
  } finally {
    CURRENT_N = [];
  }
}

/** The implementation's road, or a broken version of it (each named for the design's N-x). */
function fakeRoad(draftKey: string, op: RetargetOp, env: { storage: MemoryRetargetStorage; unstorable: Map<string, string>; newGeneration: () => string }): RetargetWriteResult | 'nowrite' {
  const prev = readRetargetStore(draftKey, env);
  const m = env.unstorable.get(draftKey) ?? null;
  if (op.kind === 'release' && op.seen !== null && (MUT.N7 || (MUT.N7R && op.seen.length > 0))) {
    // N7 / N7R: a yes lets every generation go, seen or not.
    const all = [...(prev.kind === 'unknown' ? [prev.generation] : []), ...(m !== null ? [m] : [])];
    return writeRetarget(draftKey, { ...op, seen: all }, env);
  }
  if (MUT.N10 && op.kind === 'writeBack' && (prev.kind === 'junk' || prev.kind === 'throws')) return 'nowrite';
  if (MUT.N1 && m !== null && (op.kind === 'add' || op.kind === 'writeBack') && op.tags.length > 0) {
    // N1: the page mark goes once a list write went in.
    const ids = [...(prev.kind === 'list' || prev.kind === 'unknown' ? prev.tags : []), ...op.tags];
    try {
      env.storage.setItem(getRetargetTagKey(draftKey), JSON.stringify(ids.filter((t, i) => ids.findIndex((x) => x.id === t.id) === i)));
      env.unstorable.delete(draftKey);
      return 'stored';
    } catch {
      /* falls to the road's fallbacks below */
    }
  }
  if (MUT.NOFALLBACK) {
    // develop's shape: a write that throws leaves nothing.
    const t = nextRetarget(prev, op, m, env.newGeneration);
    if (t.next === null) {
      if (t.clearUnstorable) env.unstorable.delete(draftKey);
      return 'nowrite';
    }
    try {
      if (t.next.kind === 'absent') env.storage.removeItem(getRetargetTagKey(draftKey));
      else env.storage.setItem(getRetargetTagKey(draftKey), t.next.kind === 'list' ? JSON.stringify(t.next.tags) : JSON.stringify({ unknown: t.next.generation, tags: t.next.tags }));
      if (t.clearUnstorable) env.unstorable.delete(draftKey);
      return t.next.kind === 'unknown' ? 'unknown-stored' : 'stored';
    } catch {
      return 'unstored';
    }
  }
  return writeRetarget(draftKey, op, env);
}

// ---------- the send's check: the implementation's ----------
function askInfo(s: State, page: Page, key: Key, refIds: string[], f: ModelFail) {
  const storage = storageOf(s, f);
  const mark = s.map[page][key];
  const d = decideRetarget(readRetargetStore(DRAFT[key], { storage }), tagsFor(refIds), mark === null ? null : genStr(mark), TO);
  const seen = d.seen.map(genNum);
  return { ask: d.ask, visible: [...d.ids, ...seen.map((g) => 'g' + g)], seen };
}
const refIdsOf = (c: Comp) => (c.ref && c.ref.key === c.key ? c.ref.ids : []);

// ---------- the invariants (copied from the model) ----------
function markX4(s: State) {
  const places: Array<[Key, string[]]> = [];
  for (const key of KEYS) places.push([key, s.store[key].body]);
  for (const c of Object.values(s.comps)) if (c.key) places.push([c.key, c.body]);
  for (const [key, body] of places) for (const h of body) {
    const t = s.handed[h];
    if (!t || inter(t.rep, R(s.store[key].rt))) continue;
    for (const p of PAGES) for (const k of KEYS) {
      const g = s.map[p][k];
      if (g != null && t.rep.includes('g' + g)) t.x4 = uniq([...(t.x4 ?? []), p]);
    }
  }
}
function excludedBy4(s: State, page: Page, texts: string[]) {
  markX4(s);
  return texts.every((h) => (s.handed[h].x4 ?? []).some((p) => p !== page));
}
function checkG(s: State, where: string) {
  const pages: Record<Page, Array<{ name: string; page: Page; key: Key; body: string[]; ref: string[] }>> = { P1: [], P2: [] };
  for (const [name, c] of Object.entries(s.comps)) if (c.key) pages[c.page].push({ name, page: c.page, key: c.key, body: c.body, ref: refIdsOf(c) });
  for (const page of PAGES) for (const key of KEYS) pages[page].push({ name: `fresh(${page},${key})`, page, key, body: s.store[key].body, ref: [] });
  for (const list of Object.values(pages)) {
    for (const c of list) {
      const unc = c.body.filter((h) => s.handed[h] && !coveredOf(s, h));
      if (unc.length === 0) continue;
      if (askInfo(s, c.page, c.key, c.ref, 'none').ask) continue;
      if (excludedBy4(s, c.page, unc)) continue;
      fail('INV-G', `${where}: ${c.name} sends ${c.key}'s uncovered [${unc}] without asking`);
    }
  }
}
function checkS1(s: State, where: string) {
  markX4(s);
  for (const key of KEYS) {
    const rt = s.store[key].rt;
    for (const h of s.store[key].body) {
      if (!s.handed[h] || coveredOf(s, h) || (s.handed[h].x4 ?? []).length) continue;
      const rep = s.handed[h].rep;
      if (inter(rep, R(rt))) continue;
      if (PAGES.some((p) => KEYS.some((k) => s.map[p][k] != null && rep.includes('g' + s.map[p][k])))) continue;
      fail('INV-S1', `${where}: stored ${key}'s text ${h} has no mark, no "unknown", no page mark`);
    }
  }
}

// ---------- the moves (copied from the model; the road and the check are the implementation's) ----------
function newText(s: State): string | null {
  if (s.hc >= MAX_NEW_TEXTS) return null;
  const h = 'h' + (++s.hc + 1);
  s.handed[h] = { rep: [tagOf(h)], covered: false };
  return h;
}
const listenersOf = (s: State, page: Page, key: Key) => Object.values(s.comps).filter((c) => c.page === page && c.key === key);

function writeBackChecked(s: State, c: Comp, key: Key, held: string[], f: ModelFail, tr: string) {
  road(s, c.page, key, { kind: 'writeBack', tags: tagsFor(held) }, f, tr, 'add');
  const rt = s.store[key].rt;
  const ok = held.every((t) => (rt.t === 'list' && rt.ids.includes(t)) || rt.t === 'unk' || rt.t === 'junk' || s.map[c.page][key] != null);
  if (!ok) fail('INV-WB', `${tr}: after the write-back the held [${held}] are neither in ${key}'s store nor in a page mark`);
}
function load(s: State, c: Comp, key: Key, f: ModelFail) {
  c.key = key;
  c.body = [...s.store[key].body];
  // The composer's restore: `readRetargetTags` (a list only; "unknown" reads as no tags).
  const storage = storageOf(s, f);
  const read = readRetargetStore(DRAFT[key], { storage });
  c.ref = { key, ids: read.kind === 'list' ? read.tags.map((t) => t.id).sort() : [] };
}
function press(s: State, cn: CompName, f: ModelFail, tr: string): boolean {
  const c = s.comps[cn];
  if (!c.key || c.pend || c.body.length === 0) return false;
  checkG(s, tr + ' before the press');
  const info = askInfo(s, c.page, c.key, refIdsOf(c), f);
  if (!info.ask) {
    const unc = c.body.filter((h) => s.handed[h] && !coveredOf(s, h));
    if (unc.length && !excludedBy4(s, c.page, unc)) fail('INV-V2c4', `${tr}: ${cn} POSTs uncovered [${unc}] without asking`);
  } else {
    // 案 A': the yes covers what its question saw.
    for (const h of handedTexts(s)) if (inter(s.handed[h].rep, info.visible)) s.handed[h].covered = true;
  }
  c.pend = { key: c.key, ids: [...refIdsOf(c)], seen: info.ask ? info.seen : null, body: [...c.body] };
  return true;
}
function complete(s: State, cn: CompName, f: ModelFail, tr: string) {
  const c = s.comps[cn];
  const p = c.pend!;
  c.pend = null;
  if (c.key === p.key) c.body = [];
  // INV-S1: the text goes first; its marks only once it went.
  if (setBody(s, p.key, [], f, tr)) {
    if (p.ids.length || p.seen) road(s, c.page, p.key, { kind: 'release', ids: p.ids, seen: p.seen === null ? null : p.seen.map(genStr) }, f, tr, 'release');
    if (c.ref.key === p.key) c.ref.ids = c.ref.ids.filter((x) => !p.ids.includes(x));
  }
}

const OPS = {
  ret(s: State, page: Page, f: ModelFail, tr: string): boolean {
    const h = newText(s);
    if (!h) return false;
    const key: Key = 'K';
    const prevRaw = clone(s.store[key].rt);
    const r = road(s, page, key, { kind: 'add', tags: tagsFor([tagOf(h)]) }, f, tr, 'add');
    if (r === 'unstored') {
      delete s.handed[h];
      return true;
    }
    const ok = setBody(s, key, [...s.store[key].body, h], f, tr);
    const ls = listenersOf(s, page, key);
    if (!ok && ls.length === 0) {
      if (MUT.N9) {
        // N9: the roll-back of v4.1 (the store as it was before the hand-back).
        applyRt(s, key, prevRaw, tr + ' rollback');
      }
      delete s.handed[h];
      return true;
    }
    for (const c of ls) {
      c.body = uniq([...c.body, h]);
      if (c.ref.key === key) c.ref.ids = uniq([...c.ref.ids, tagOf(h)]);
    }
    return true;
  },
  a409(s: State, cn: CompName, inStore: boolean, f: ModelFail, tr: string): boolean {
    const c = s.comps[cn];
    if (!inStore && c.key !== 'K') return false;
    const h = newText(s);
    if (!h) return false;
    if (c.key === 'K') {
      c.body = uniq([...c.body, h]);
      if (c.ref.key === 'K') c.ref.ids = uniq([...c.ref.ids, tagOf(h)]);
    }
    if (inStore) s.store.K.body = uniq([...s.store.K.body, h]);
    road(s, c.page, 'K', { kind: 'add', tags: tagsFor([tagOf(h)]) }, f, tr, 'add');
    return true;
  },
  save(s: State, cn: CompName, f: ModelFail, tr: string): boolean {
    const c = s.comps[cn];
    if (!c.key) return false;
    const held = refIdsOf(c);
    if (held.length) writeBackChecked(s, c, c.key, held, f, tr);
    setBody(s, c.key, c.body, f, tr);
    return true;
  },
  storage(s: State, cn: CompName, f: ModelFail, tr: string): boolean {
    const c = s.comps[cn];
    if (!c.key) return false;
    const held = refIdsOf(c);
    if (!held.length) return false;
    const storage = storageOf(s, f);
    const v = readRetargetStore(DRAFT[c.key], { storage });
    const stored = v.kind === 'list' || v.kind === 'unknown' ? v.tags.map((t) => t.id) : [];
    if (held.every((x) => stored.includes(x))) return false;
    writeBackChecked(s, c, c.key, held, f, tr);
    return true;
  },
  switch(s: State, cn: CompName, f: ModelFail, tr: string): boolean {
    const c = s.comps[cn];
    if (!c.key) return false;
    const from = c.key;
    const to: Key = from === 'K' ? 'K2' : 'K';
    const held = refIdsOf(c);
    if (held.length) writeBackChecked(s, c, from, held, f, tr);
    setBody(s, from, c.body, f, tr);
    load(s, c, to, f);
    return true;
  },
  unmount(s: State, cn: CompName): boolean {
    const c = s.comps[cn];
    if (!c.key) return false;
    c.key = null;
    c.body = [];
    c.ref = { key: null, ids: [] };
    return true;
  },
  mount(s: State, cn: CompName, f: ModelFail): boolean {
    const c = s.comps[cn];
    if (c.key) return false;
    load(s, c, 'K', f);
    return true;
  },
  sendSync(s: State, cn: CompName, f: ModelFail, tr: string): boolean {
    if (!press(s, cn, f, tr)) return false;
    complete(s, cn, f, tr);
    return true;
  },
  pressAwait(s: State, cn: CompName, f: ModelFail, tr: string): boolean {
    return press(s, cn, f, tr);
  },
  complete(s: State, cn: CompName, f: ModelFail, tr: string): boolean {
    if (!s.comps[cn].pend) return false;
    complete(s, cn, f, tr);
    return true;
  },
  // Q2's move K → K2 (page P1): `moveIn` on K2 through the road, then the text, then `moveOut`.
  move(s: State, f: ModelFail, tr: string): boolean {
    if (s.store.K.body.length === 0) return false;
    const page: Page = 'P1';
    const storage = storageOf(s, f);
    const from = readRetargetStore(DRAFT.K, { storage });
    const mapFrom = s.map[page].K;
    const asList = from.kind === 'list' && mapFrom == null;
    const moving = s.store.K.body.filter((h) => s.handed[h]);
    const r = road(s, page, 'K2', { kind: 'moveIn', from, fromUnstorable: mapFrom === null ? null : genStr(mapFrom) }, f, tr, asList ? 'add' : { move: moving });
    if (r === 'unstored') return true; // nothing moves
    const moved = s.store.K.body;
    if (!setBody(s, 'K2', [...s.store.K2.body, ...moved], f, tr)) return true;
    for (const c of listenersOf(s, page, 'K2')) c.body = uniq([...c.body, ...moved]);
    if (!setBody(s, 'K', [], f, tr)) return true;
    if (MUT.MOVEOUT_DROP) {
      // v4.2's moveOut: the `from` side's marks go too.
      if (f !== 'rmThrow' && f !== 'wAll') applyRt(s, 'K', { t: 'absent' }, tr);
      if (s.store.K.rt.t === 'absent' && s.map[page].K != null) setMap(s, page, 'K', null, tr);
    }
    return true;
  },
};

// ---------- the seeds (copied) ----------
function base(): State {
  const comp = (page: Page, key: Key, body: string[]): Comp => ({ page, key, body, ref: { key, ids: [] }, pend: null });
  return {
    store: { K: { body: ['p'], rt: { t: 'absent' } }, K2: { body: [], rt: { t: 'absent' } } },
    map: { P1: { K: null, K2: null }, P2: { K: null, K2: null } },
    comps: { A: comp('P1', 'K', ['p']), B: comp('P1', 'K', ['p']), C: comp('P2', 'K', ['p']) },
    handed: {},
    gen: 0,
    hc: 0,
  };
}
function withH1(s: State, rt: Rt, rep: string[], refs: boolean): State {
  s.handed.h1 = { rep, covered: false };
  s.store.K.body = ['h1', 'p'];
  s.store.K.rt = rt;
  for (const c of Object.values(s.comps)) {
    c.body = ['h1', 'p'];
    c.ref = { key: 'K', ids: refs ? ['th1'] : [] };
  }
  return s;
}
function seeds(): Record<string, State> {
  const out: Record<string, State> = {};
  out.S0 = base();
  out.S1_list = withH1(base(), { t: 'list', ids: ['th1'] }, ['th1'], true);
  {
    const s = withH1(base(), { t: 'unk', g: 1, ids: [] }, ['th1', 'g1'], false);
    s.gen = 1;
    out.S2_unk = s;
  }
  out.S3_junk = withH1(base(), { t: 'junk' }, ['th1', 'J'], false);
  {
    const s = withH1(base(), { t: 'absent' }, ['th1', 'g1'], false);
    s.gen = 1;
    s.map.P1.K = 1;
    s.comps.C.body = ['h1', 'p'];
    out.S4_map = s;
  }
  for (const [name, s0] of Object.entries({ ...out })) {
    const a = clone(s0);
    a.comps.A = { page: 'P1', key: 'K2', body: [], ref: { key: 'K2', ids: [] }, pend: null };
    out[name + '+A@K2'] = a;
    const b = clone(a);
    b.comps.B = { page: 'P1', key: null, body: [], ref: { key: null, ids: [] }, pend: null };
    out[name + '+A@K2+Bout'] = b;
  }
  return out;
}

// ---------- the search ----------
type Move = [string, (s: State, tr: string) => boolean];
function moves(): Move[] {
  const out: Move[] = [];
  for (const f of FAILS) {
    out.push([`ret(P1,${f})`, (t, tr) => OPS.ret(t, 'P1', f, tr)]);
    out.push([`ret(P2,${f})`, (t, tr) => OPS.ret(t, 'P2', f, tr)]);
    for (const cn of ['A', 'B', 'C'] as CompName[]) {
      out.push([`a409s(${cn},${f})`, (t, tr) => OPS.a409(t, cn, true, f, tr)]);
      out.push([`a409u(${cn},${f})`, (t, tr) => OPS.a409(t, cn, false, f, tr)]);
      out.push([`save(${cn},${f})`, (t, tr) => OPS.save(t, cn, f, tr)]);
      out.push([`storage(${cn},${f})`, (t, tr) => OPS.storage(t, cn, f, tr)]);
      out.push([`sendSync(${cn},${f})`, (t, tr) => OPS.sendSync(t, cn, f, tr)]);
      out.push([`complete(${cn},${f})`, (t, tr) => OPS.complete(t, cn, f, tr)]);
    }
    out.push([`switch(A,${f})`, (t, tr) => OPS.switch(t, 'A', f, tr)]);
    out.push([`move(${f})`, (t, tr) => OPS.move(t, f, tr)]);
  }
  for (const f of ['none', 'rThrow'] as ModelFail[]) {
    for (const cn of ['A', 'B', 'C'] as CompName[]) out.push([`pressAwait(${cn},${f})`, (t, tr) => OPS.pressAwait(t, cn, f, tr)]);
    for (const cn of ['B', 'C'] as CompName[]) out.push([`mount(${cn},${f})`, (t) => OPS.mount(t, cn, f)]);
  }
  for (const cn of ['B', 'C'] as CompName[]) out.push([`unmount(${cn})`, (t) => OPS.unmount(t, cn)]);
  return out;
}

interface SearchResult {
  perLen: number[];
  violations: number[];
  first: { kind: string; path: string; msg: string } | null;
}
function search(depth: number, filter: RegExp | null = null, seedNames: string[] | null = null): SearchResult {
  const all = Object.fromEntries(Object.entries(seeds()).filter(([name]) => !seedNames || seedNames.includes(name)));
  const list = moves().filter(([n]) => !filter || filter.test(n));
  const visited = new Set<string>();
  let frontier: Array<{ s: State; path: string[] }> = [];
  for (const [name, s] of Object.entries(all)) {
    checkG(s, 'seed');
    checkS1(s, 'seed');
    const h = JSON.stringify(s);
    if (!visited.has(h)) {
      visited.add(h);
      frontier.push({ s, path: [name] });
    }
  }
  const perLen = [frontier.length];
  const violations = [0];
  let first: SearchResult['first'] = null;
  for (let d = 1; d <= depth; d++) {
    const next: typeof frontier = [];
    let v = 0;
    for (const { s, path } of frontier) {
      for (const [name, fn] of list) {
        const t = clone(s);
        const tr = [...path, name].join(' → ');
        let changed: boolean;
        try {
          changed = fn(t, tr);
          if (changed) checkG(t, tr);
        } catch (e) {
          if (!(e instanceof Violation)) throw e;
          v++;
          if (!first) first = { kind: e.kind, path: tr, msg: e.message };
          continue;
        }
        if (!changed) continue;
        const h = JSON.stringify(t);
        if (visited.has(h)) continue;
        visited.add(h);
        next.push({ s: t, path: [...path, name] });
      }
    }
    perLen.push(next.length);
    violations.push(v);
    frontier = next;
  }
  return { perLen, violations, first };
}

/** Run one sequence from a seed; returns the violation's kind, or null. */
function runPath(path: string): string | null {
  const [seedName, ...names] = path.split(' → ');
  const s = seeds()[seedName];
  const table = new Map(moves());
  try {
    // As the search does: the seed is checked first (which marks the texts §4 leaves open).
    checkG(s, 'seed');
    checkS1(s, 'seed');
    const trace = [seedName];
    for (const name of names) {
      trace.push(name);
      const fn = table.get(name);
      if (!fn) throw new Error(`no move ${name}`);
      if (fn(s, trace.join(' → '))) checkG(s, trace.join(' → '));
    }
  } catch (e) {
    if (e instanceof Violation) return e.kind;
    throw e;
  }
  return null;
}

function withMut<T>(mut: Partial<Mut>, f: () => T): T {
  MUT = { ...NO_MUT, ...mut };
  try {
    return f();
  } finally {
    MUT = NO_MUT;
  }
}

describe('[#4604 T-g] the model\'s sequences on the implementation\'s road (always run: lengths 0〜2)', () => {
  it('the numbers of new states are the model\'s (15 / 545 / 19,350) and nothing is violated', () => {
    const r = search(2);
    expect(r.first).toBeNull();
    expect(r.perLen).toEqual([15, 545, 19350]);
    expect(r.violations).toEqual([0, 0, 0]);
  }, 120_000);

  // Each broken version on the model's shortest sequence (and a second shape where it has one).
  it.each<[string, Partial<Mut>, string, string]>([
    ['N9 (the roll-back)', { N9: true }, 'S4_map+A@K2+Bout → ret(P1,wBody)', 'INV-G'],
    ['N7 (no generations)', { N7: true }, 'S2_unk → pressAwait(A,rThrow) → complete(A,none)', 'INV-G'],
    ['N10 (a write-back over what cannot be read writes nothing)', { N10: true }, 'S1_list → sendSync(A,none) → save(B,rThrow)', 'INV-WB'],
    ['N10 (storage)', { N10: true }, 'S1_list → sendSync(A,none) → storage(B,rThrow)', 'INV-WB'],
    ['N10 (switch)', { N10: true }, 'S1_list → sendSync(B,none) → switch(A,rThrow)', 'INV-WB'],
    ['v41 (N7 + N9 + N10)', { N7: true, N9: true, N10: true }, 'S4_map+A@K2+Bout → ret(P1,wBody)', 'INV-G'],
    ['v41 (its N7 shape)', { N7: true, N9: true, N10: true }, 'S2_unk → pressAwait(A,rThrow) → complete(A,none)', 'INV-G'],
    ['NOFALLBACK (develop: a write that throws leaves nothing)', { NOFALLBACK: true }, 'S0 → a409s(A,wAll)', 'INV-G'],
    ['NOFALLBACK (write-back)', { NOFALLBACK: true }, 'S0 → a409u(A,wAll) → save(A,wAll)', 'INV-WB'],
    ['N1 (the page mark goes with a list write)', { N1: true }, 'S1_list → ret(P1,wAll) → ret(P1,rThrow)', 'INV-S1'],
    ['N1 (its INV-G shape)', { N1: true }, 'S4_map → a409s(A,none) → sendSync(A,none)', 'INV-G'],
    ['v4.2 moveOut (the marks of `from` go)', { MOVEOUT_DROP: true }, 'S2_unk → move(none)', 'INV-G'],
  ])('%s: red on %s', (_name, mut, path, kind) => {
    expect(withMut(mut, () => runPath(path))).toBe(kind);
    // The same sequence on the implementation's road holds.
    expect(runPath(path)).toBeNull();
  });

  it('(negative control) the broken versions are green on a sequence that does not reach them', () => {
    expect(withMut({ N7: true, N9: true, N10: true, NOFALLBACK: true, N1: true }, () => runPath('S0 → save(A,none) → sendSync(A,none)'))).toBeNull();
  });
});

describe('[#4604 T-g] outside the model', () => {
  it('(4) the To comes back to the tag\'s original: no question, and the POST is (i) — the tag names it', () => {
    const storage = new MemoryRetargetStorage();
    const unstorable = new Map<string, string>();
    const key = DRAFT.K;
    const toolA = { instanceId: 'i1', cliToolId: 'codex' };
    const toolB = { instanceId: 'i1', cliToolId: 'claude' };
    const T: RetargetTag = { id: 't', original: toolA };
    writeRetarget(key, { kind: 'add', tags: [T] }, { storage, unstorable });
    // The To changes: asked. The person says no (nothing happens).
    expect(decideRetarget(readRetargetStore(key, { storage }), [T], null, toolB).ask).toBe(true);
    // The To comes back: no question — and the POST's To is T's original (the oracle's (i)).
    const back = decideRetarget(readRetargetStore(key, { storage }), [T], null, toolA);
    expect(back.ask).toBe(false);
    // Another tab writes a new "unknown" after the To came back: asked again.
    storage.data.set(getRetargetTagKey(key), JSON.stringify({ unknown: 'G99', tags: [T] }));
    expect(decideRetarget(readRetargetStore(key, { storage }), [T], null, toolA)).toMatchObject({ ask: true, unknown: true, seen: ['G99'] });
  });

  it('(3) observed: the page closes between the two writes of a save (marks first, then the text) — no stored text loses its mark', () => {
    // From each seed: A's save writes its marks, then the page closes before the text is written; on
    // reload every page reads the store afresh. The marks-first order leaves no stored text without its
    // mark (the text-first order is not required — see the design's §3.2「順番」).
    let violations = 0;
    for (const [name, s0] of Object.entries(seeds())) {
      const s = clone(s0);
      const c = s.comps.A;
      if (!c.key) continue;
      try {
        const held = refIdsOf(c);
        if (held.length) writeBackChecked(s, c, c.key, held, 'none', `${name} → save(A) (closed)`);
        checkS1(s, `${name} closed`);
      } catch (e) {
        if (e instanceof Violation) violations++;
        else throw e;
      }
    }
    expect(violations).toBe(0);
  });
});

const FULL = process.env.CM_RETARGET_MODEL_FULL === '1';
const RACE = /^(pressAwait|complete|a409s|a409u|mount|unmount|save|storage)\(/;
/** The model's three seeds for the narrowed length 4 (its numbers are these seeds'). */
const RACE_SEEDS = ['S1_list', 'S2_unk', 'S2_unk+A@K2'];

describe.runIf(FULL)('[#4604 T-g FULL] length 3 and the narrowed length 4 (CM_RETARGET_MODEL_FULL=1 only)', () => {
  it('length 3: 554,971 new states, nothing violated', () => {
    const r = search(3);
    expect(r.first).toBeNull();
    expect(r.perLen).toEqual([15, 545, 19350, 554971]);
  }, 600_000);

  it('length 4 with the race moves (seeds S1_list · S2_unk · S2_unk+A@K2): 3 / 91 / 2,681 / 49,269 / 708,480, nothing violated', () => {
    const r = search(4, RACE, RACE_SEEDS);
    expect(r.first).toBeNull();
    expect(r.perLen).toEqual([3, 91, 2681, 49269, 708480]);
  }, 600_000);

  it('N7R is red at length 3 of the race moves', () => {
    expect(withMut({ N7R: true }, () => runPath('S2_unk → a409s(A,wAll) → pressAwait(A,rThrow) → complete(A,none)'))).toBe('INV-G');
    expect(runPath('S2_unk → a409s(A,wAll) → pressAwait(A,rThrow) → complete(A,none)')).toBeNull();
  }, 600_000);
});

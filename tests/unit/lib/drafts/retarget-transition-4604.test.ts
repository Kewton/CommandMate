/**
 * Issue #4604 T-f (設計書 §3.4.1, the table): `nextRetarget`, every combination — the value before
 * (absent · list · unknown · junk · throws) × the op (add · writeBack · release(ids, seen) · moveIn ·
 * moveOut) × this page's mark (none · the same generation · another). The design's table is copied
 * below (`expected`, written from the table's rows, not from the code) and each combination is
 * compared with it.
 *
 * Then the one property: "ask" turns into "do not ask" only on the ★ rows — a release whose question
 * saw what it lets go. Any other row that does so is red. The road (`writeRetarget`) is run on the
 * same combinations with the store's failures (none · the read throws · every write throws · only the
 * short value goes in): the property holds there too, and the unwritten readings M-2〜M-7 each have
 * a row.
 *
 * In this table every tag's original target differs from the To (the worst case): a list with a tag
 * asks.
 */
import { describe, it, expect } from 'vitest';
import {
  getRetargetTagKey,
  nextRetarget,
  readRetargetStore,
  writeRetarget,
  type RetargetOp,
  type RetargetStoreRead,
  type RetargetStoreValue,
  type RetargetTag,
} from '@/lib/drafts/message-draft';
import { MemoryRetargetStorage, type ModelFail } from '@tests/helpers/draft-store-fault-4604';

const X = { instanceId: 'codex-2', cliToolId: 'codex' };
const tag = (id: string): RetargetTag => ({ id, original: X });
const A = tag('a');
const N = tag('n');
const F = tag('f');

const PREVS: Record<string, RetargetStoreRead> = {
  absent: { kind: 'absent' },
  list: { kind: 'list', tags: [A] },
  unknown: { kind: 'unknown', generation: 'g1', tags: [A] },
  junk: { kind: 'junk' },
  throws: { kind: 'throws' },
};
const MARKS: Array<string | null> = [null, 'g1', 'm9'];

function ops(): Array<[string, RetargetOp]> {
  const out: Array<[string, RetargetOp]> = [
    ['add([n])', { kind: 'add', tags: [N] }],
    ['writeBack([n])', { kind: 'writeBack', tags: [N] }],
    ['add([])', { kind: 'add', tags: [] }],
    ['writeBack([a])', { kind: 'writeBack', tags: [A] }],
    ['moveOut', { kind: 'moveOut' }],
  ];
  for (const ids of [[], ['a']]) {
    for (const seen of [null, [], ['g1'], ['m9'], ['g1', 'm9'], ['old']]) {
      out.push([`release(${JSON.stringify(ids)}, ${JSON.stringify(seen)})`, { kind: 'release', ids, seen }]);
    }
  }
  const froms: Record<string, RetargetStoreRead> = {
    absent: { kind: 'absent' },
    'list[f]': { kind: 'list', tags: [F] },
    'unknown(h,[f])': { kind: 'unknown', generation: 'h', tags: [F] },
    junk: { kind: 'junk' },
    throws: { kind: 'throws' },
  };
  for (const [name, from] of Object.entries(froms)) {
    for (const fromUnstorable of [null, 'f1']) out.push([`moveIn(${name}, ${fromUnstorable})`, { kind: 'moveIn', from, fromUnstorable }]);
  }
  return out;
}

const ids = (tags: readonly RetargetTag[]) => tags.map((t) => t.id);
const union = (a: readonly RetargetTag[], b: readonly RetargetTag[]) => [...a, ...b.filter((t) => !ids(a).includes(t.id))];
const tagsOf = (v: RetargetStoreRead) => (v.kind === 'list' || v.kind === 'unknown' ? v.tags : []);

/** The design's table (設計書 §3.4.1), row by row. New generations are 'n1', 'n2', … in order. */
function expected(prev: RetargetStoreRead, op: RetargetOp, m: string | null, gen: () => string): { next: RetargetStoreValue | null; clear: boolean } {
  if (op.kind === 'add' || op.kind === 'writeBack') {
    if (op.tags.length === 0) return { next: null, clear: false };
    if (prev.kind === 'absent' || prev.kind === 'list') {
      const tags = union(tagsOf(prev), op.tags);
      return m === null ? { next: { kind: 'list', tags }, clear: false } : { next: { kind: 'unknown', generation: m, tags }, clear: true };
    }
    if (prev.kind === 'unknown') {
      const tags = union(prev.tags, op.tags);
      if (m !== null && m !== prev.generation) return { next: { kind: 'unknown', generation: gen(), tags }, clear: false };
      return { next: { kind: 'unknown', generation: prev.generation, tags }, clear: m === prev.generation };
    }
    return { next: { kind: 'unknown', generation: gen(), tags: [...op.tags] }, clear: false };
  }
  if (op.kind === 'release') {
    const sawMark = m !== null && op.seen !== null && op.seen.includes(m);
    const left = (t: readonly RetargetTag[]) => t.filter((x) => !op.ids.includes(x.id));
    const listOrAbsent = (t: RetargetTag[]): RetargetStoreValue => (t.length ? { kind: 'list', tags: t } : { kind: 'absent' });
    if (prev.kind === 'list') return { next: listOrAbsent(left(prev.tags)), clear: sawMark };
    if (prev.kind === 'unknown') {
      if (op.seen !== null && op.seen.includes(prev.generation)) return { next: listOrAbsent(left(prev.tags)), clear: sawMark };
      return { next: { kind: 'unknown', generation: prev.generation, tags: left(prev.tags) }, clear: sawMark };
    }
    if (prev.kind === 'absent') return { next: null, clear: sawMark };
    return { next: null, clear: false };
  }
  if (op.kind === 'moveIn') {
    if (op.from.kind === 'list' && op.fromUnstorable === null) return expected(prev, { kind: 'add', tags: op.from.tags }, m, gen);
    return { next: { kind: 'unknown', generation: gen(), tags: union(tagsOf(prev), tagsOf(op.from)) }, clear: false };
  }
  return { next: null, clear: false };
}

/** Whether a send of this draft asks: unreadable, "unknown", the page's mark, or a tag (all differ from the To). */
function asks(v: RetargetStoreRead, m: string | null): boolean {
  return v.kind === 'junk' || v.kind === 'throws' || v.kind === 'unknown' || m !== null || (v.kind === 'list' && v.tags.length > 0);
}

/** The ★ rows: a release whose question saw what made the draft ask. */
function isStarRow(op: RetargetOp): boolean {
  return op.kind === 'release' && (op.ids.length > 0 || (op.seen !== null && op.seen.length > 0));
}

const counter = () => {
  let n = 0;
  return () => `n${++n}`;
};

const COMBOS: Array<[string, RetargetStoreRead, RetargetOp, string | null]> = [];
for (const [pname, prev] of Object.entries(PREVS)) for (const [oname, op] of ops()) for (const m of MARKS) COMBOS.push([`${pname} × ${oname} × mark ${m}`, prev, op, m]);

describe('[#4604 T-f] nextRetarget: every combination against the table', () => {
  it(`covers ${COMBOS.length} combinations`, () => {
    expect(COMBOS.length).toBe(5 * ops().length * 3);
  });

  it.each(COMBOS)('%s', (_name, prev, op, m) => {
    const got = nextRetarget(prev, op, m, counter());
    const want = expected(prev, op, m, counter());
    expect({ next: got.next, clear: got.clearUnstorable }).toEqual(want);
    // The property: ask → do not ask only on a ★ row.
    const after: RetargetStoreRead = got.next ?? prev;
    const markAfter = got.clearUnstorable ? null : m;
    if (asks(prev, m) && !asks(after, markAfter)) expect({ row: _name, star: isStarRow(op) }).toEqual({ row: _name, star: true });
  });

  it('a release and a move\'s `from` side never take the fail-closed steps; the rest do', () => {
    for (const [, prev, op, m] of COMBOS) {
      const t = nextRetarget(prev, op, m, counter());
      if (t.next === null) continue;
      expect(t.failClosed).toBe(op.kind !== 'release' && op.kind !== 'moveOut');
    }
  });
});

/** Put `value` into a memory store as the road writes it. */
function seed(storage: MemoryRetargetStorage, key: string, value: RetargetStoreRead) {
  const tagKey = getRetargetTagKey(key);
  if (value.kind === 'list') storage.data.set(tagKey, JSON.stringify(value.tags));
  else if (value.kind === 'unknown') storage.data.set(tagKey, JSON.stringify({ unknown: value.generation, tags: value.tags }));
  else if (value.kind === 'junk' || value.kind === 'throws') storage.data.set(tagKey, '{junk');
}

const FAILS: ModelFail[] = ['none', 'rThrow', 'wAll', 'wShort'];
const KEY = 'commandmate:draft-message:wt-4604-tf:0';

describe('[#4604 T-f] the road on the same combinations × the store\'s failures', () => {
  const rows: Array<[string, RetargetStoreRead, RetargetOp, string | null, ModelFail]> = [];
  for (const [name, prev, op, m] of COMBOS) {
    if (prev.kind === 'throws') continue; // the read throwing is the `rThrow` failure below
    for (const fail of FAILS) rows.push([`${name} × ${fail}`, prev, op, m, fail]);
  }

  it.each(rows)('%s', (_name, prev, op, m, fail) => {
    const storage = new MemoryRetargetStorage();
    seed(storage, KEY, prev);
    const unstorable = new Map<string, string>();
    if (m !== null) unstorable.set(KEY, m);
    const before = fail === 'rThrow' ? ({ kind: 'throws' } as RetargetStoreRead) : prev;
    const askedBefore = asks(before, m);
    storage.fail = fail;
    writeRetarget(KEY, op, { storage, unstorable, newGeneration: counter() });
    storage.fail = fail === 'rThrow' ? 'rThrow' : 'none';
    const after = readRetargetStore(KEY, { storage });
    const markAfter = unstorable.get(KEY) ?? null;
    if (askedBefore && !asks(after, markAfter)) expect({ row: _name, star: isStarRow(op) }).toEqual({ row: _name, star: true });
    // "Ask" is always left somewhere for an add / write-back / move-in with tags.
    if ((op.kind === 'add' || op.kind === 'writeBack') && op.tags.length > 0) expect(asks(after, markAfter)).toBe(true);
  });
});

describe('[#4604 T-f] the readings the table does not write out (M-2〜M-7)', () => {
  const run = (prev: RetargetStoreRead, op: RetargetOp, m: string | null, fail: ModelFail) => {
    const storage = new MemoryRetargetStorage();
    seed(storage, KEY, prev);
    const unstorable = new Map<string, string>();
    if (m !== null) unstorable.set(KEY, m);
    storage.fail = fail;
    const result = writeRetarget(KEY, op, { storage, unstorable, newGeneration: counter() });
    storage.fail = 'none';
    return { result, after: readRetargetStore(KEY, { storage }), mark: unstorable.get(KEY) ?? null };
  };

  it('M-2: nothing goes in while the page already has a mark — a new generation replaces it', () => {
    const r = run({ kind: 'absent' }, { kind: 'add', tags: [N] }, 'm9', 'wAll');
    expect(r).toEqual({ result: 'unstored', after: { kind: 'absent' }, mark: 'n2' });
  });

  it('M-3: a list release that saw the page mark lets it go', () => {
    expect(run({ kind: 'list', tags: [A] }, { kind: 'release', ids: ['a'], seen: ['m9'] }, 'm9', 'none')).toEqual({ result: 'stored', after: { kind: 'absent' }, mark: null });
  });

  it('M-4: a release that throws keeps the mark (and the store)', () => {
    expect(run({ kind: 'list', tags: [A] }, { kind: 'release', ids: ['a'], seen: ['m9'] }, 'm9', 'wAll')).toEqual({ result: 'unstored', after: { kind: 'list', tags: [A] }, mark: 'm9' });
  });

  it('M-5: junk with a page mark — a new generation\'s "unknown", the mark stays', () => {
    const r = run({ kind: 'junk' }, { kind: 'writeBack', tags: [N] }, 'm9', 'none');
    expect(r).toEqual({ result: 'unknown-stored', after: { kind: 'unknown', generation: 'n1', tags: [N] }, mark: 'm9' });
  });

  it('M-6: a press whose read threw saw no generation — its yes lets none go', () => {
    const r = run({ kind: 'unknown', generation: 'g1', tags: [] }, { kind: 'release', ids: [], seen: [] }, 'm9', 'none');
    expect(r.after).toEqual({ kind: 'unknown', generation: 'g1', tags: [] });
    expect(r.mark).toBe('m9');
  });

  it('M-7: a move-in that cannot be written takes the short "unknown", then the page mark', () => {
    const from: RetargetStoreRead = { kind: 'unknown', generation: 'h', tags: [F] };
    const short = run({ kind: 'absent' }, { kind: 'moveIn', from, fromUnstorable: null }, null, 'wShort');
    expect(short).toEqual({ result: 'unknown-stored', after: { kind: 'unknown', generation: 'n2', tags: [] }, mark: null });
    const none = run({ kind: 'absent' }, { kind: 'moveIn', from, fromUnstorable: null }, null, 'wAll');
    expect(none).toEqual({ result: 'unstored', after: { kind: 'absent' }, mark: 'n3' });
  });
});

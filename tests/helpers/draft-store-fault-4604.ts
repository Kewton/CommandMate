/**
 * Issue #4604 (設計書 §3.4.1): the store's faults, another tab, and the POST oracle — shared by the
 * #4604 tests.
 *
 * - {@link installStoreFaults}: `localStorage`'s `getItem` / `setItem` / `removeItem` throw for the keys
 *   a rule picks (the draft's value key `<K>:value` — Issue #4604 S13 —, the keys of before, any),
 *   always, from the n-th call, for n calls only, or only for a value longer than N bytes (a full store
 *   that still takes a short value: {@link shortValueLength}).
 * - {@link otherTabWrites}: another tab — the store alone is written (never a second render in this
 *   document) and a `StorageEvent` is dispatched, as a browser does in the other documents.
 *   {@link otherTabWritesDraft}: another tab writes a draft's one value (S13).
 * - {@link MemoryRetargetStorage}: an in-memory store for the road's pure tests, with the model's
 *   failures (`none` · `rThrow` · `wAll` · `wShort` · `wBody` · `rmThrow`). S13: it keeps a draft's marks
 *   in the shape of before (`<K>:retarget`, a list or `{"unknown":…,"tags":[…]}`) and shows them to the
 *   road as the draft's value (`<K>:value`), so the pure tests read and seed the marks as they did.
 * - {@link createPostOracle}: every POST is judged by one rule (案 A'): (i) the text's tag names the
 *   POST's To, or (ii) the POST's To is the To the question the person last said yes to named, and
 *   the yes covered what the text was (the ids and generations its question saw).
 */
import { vi } from 'vitest';
import * as draftModule from '@/lib/drafts/message-draft';
import { getDraftValueKey, readDraft, type RetargetTag } from '@/lib/drafts/message-draft';

export type StoreMethod = 'getItem' | 'setItem' | 'removeItem';

export interface StoreFaultRule {
  /** Which method throws. */
  method: StoreMethod;
  /** Which keys it throws for (default: every key). */
  key?: (key: string) => boolean;
  /** 'always' (default) · from the n-th matching call on · for the first n matching calls only. */
  when?: 'always' | { from: number } | { times: number };
  /** `setItem` only: throw only when the value is longer than this many characters. */
  overBytes?: number;
  /** Issue #4604 S13: `setItem` only — throw only for a value this is true of (e.g. {@link carriesMark}). */
  value?: (value: string) => boolean;
}

export const isRetargetKey = (key: string): boolean => key.endsWith(':retarget');
export const isDraftTextKey = (key: string): boolean =>
  key.startsWith('commandmate:draft-message:') && !key.endsWith(':retarget') && !key.endsWith(':send-unknown');
/** Issue #4604 S13: a draft's one value (`<K>:value`) — its text and its marks. */
export const isDraftValueKey = (key: string): boolean => key.startsWith('commandmate:draft-message:') && key.endsWith(':value');

/** The longest generation the lib makes (`g-<time>-<seq>-<8>`), for {@link shortValueLength}. */
const LONGEST_GENERATION = `g-${'z'.repeat(9)}-${'z'.repeat(6)}-${'z'.repeat(8)}`;

/**
 * Issue #4604 S13 (§1.10 決め 3): how long the short value of a draft holding `text` is (no tag, "unknown",
 * the #4503 mark kept) — a full store refusing values longer than this takes the short value and the
 * draft's text alone, and refuses the value with a tag (a tag is longer than a generation).
 */
export function shortValueLength(text: string, sendMark: { text: string; target: string } | null = null): number {
  return JSON.stringify({ v: 1, text, tags: [], unknown: LONGEST_GENERATION, sendMark }).length;
}

/** Issue #4604 S13: a draft's one value, as the lib writes it. */
export function draftValue(value: { text?: string; tags?: readonly RetargetTag[]; unknown?: string | null; sendMark?: { text: string; target: string } | null }): string {
  return JSON.stringify({ v: 1, text: value.text ?? '', tags: value.tags ?? [], unknown: value.unknown ?? null, sendMark: value.sendMark ?? null });
}

/** Issue #4604 S13: what the store holds for a draft, read by the lib's public read (its text, marks, #4503 mark). */
export function storedDraft(draftKey: string) {
  return readDraft(draftKey);
}

/**
 * Issue #4604 S13: whether a draft's value carries a mark (a tag or "unknown") — a fault that refuses these
 * is the shape of before's "`:retarget` setItem throws" (the text alone still goes in).
 */
export function carriesMark(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { tags?: unknown[]; unknown?: unknown };
    return (Array.isArray(parsed.tags) && parsed.tags.length > 0) || (parsed.unknown !== null && parsed.unknown !== undefined);
  } catch {
    return false;
  }
}

/**
 * Issue #4604 S13: what the store holds for a draft, past every fault (the real `getItem`): its one value,
 * or — while none is stored — its keys of before, read the same way the lib's read does.
 */
export function rawDraft(draftKey: string): { text: string; marks: ReturnType<typeof readDraft>['marks'] } {
  const raw = rawStore();
  return readDraft(draftKey, { storage: { getItem: raw.get, setItem: raw.set, removeItem: raw.remove } });
}

export interface StoreFaults {
  /** Replace the rules (none: the store works). */
  set(rules: StoreFaultRule[]): void;
  /** How many calls of each method threw. */
  thrown: Record<StoreMethod, number>;
  /** Restore the real methods. */
  restore(): void;
}

/** Make `localStorage` throw by `rules` (spies on `Storage.prototype`; `restore()` or `vi.restoreAllMocks()`). */
export function installStoreFaults(rules: StoreFaultRule[] = []): StoreFaults {
  let active = rules;
  const seen = new Map<StoreFaultRule, number>();
  const thrown: Record<StoreMethod, number> = { getItem: 0, setItem: 0, removeItem: 0 };
  const realGet = Storage.prototype.getItem;
  const realSet = Storage.prototype.setItem;
  const realRemove = Storage.prototype.removeItem;
  const fires = (method: StoreMethod, key: string, value?: string): boolean => {
    for (const rule of active) {
      if (rule.method !== method) continue;
      if (rule.key && !rule.key(key)) continue;
      if (rule.overBytes !== undefined && (value ?? '').length <= rule.overBytes) continue;
      if (rule.value !== undefined && !rule.value(value ?? '')) continue;
      const n = (seen.get(rule) ?? 0) + 1;
      seen.set(rule, n);
      const when = rule.when ?? 'always';
      if (when === 'always' || ('from' in when && n >= when.from) || ('times' in when && n <= when.times)) {
        thrown[method] += 1;
        return true;
      }
    }
    return false;
  };
  const spies = [
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (fires('getItem', key)) throw new DOMException('denied', 'SecurityError');
      return realGet.call(this, key);
    }),
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (fires('setItem', key, value)) throw new DOMException('full', 'QuotaExceededError');
      return realSet.call(this, key, value);
    }),
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (fires('removeItem', key)) throw new DOMException('denied', 'SecurityError');
      return realRemove.call(this, key);
    }),
  ];
  return {
    set(next) {
      active = next;
      seen.clear();
    },
    thrown,
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

// The real methods, taken when this module loads (before any test's spy).
const REAL_GET = typeof Storage !== 'undefined' ? Storage.prototype.getItem : null;
const REAL_SET = typeof Storage !== 'undefined' ? Storage.prototype.setItem : null;
const REAL_REMOVE = typeof Storage !== 'undefined' ? Storage.prototype.removeItem : null;

/** The real `getItem` / `setItem` / `removeItem`, whatever the faults (another tab's writes are not this page's). */
export function rawStore() {
  const storage = window.localStorage;
  return {
    get: (key: string): string | null => REAL_GET!.call(storage, key),
    set: (key: string, value: string): void => REAL_SET!.call(storage, key, value),
    remove: (key: string): void => REAL_REMOVE!.call(storage, key),
  };
}

function rawWrite(key: string, value: string | null): string | null {
  const raw = rawStore();
  const previous = raw.get(key);
  if (value === null) raw.remove(key);
  else raw.set(key, value);
  return previous;
}

/**
 * Another tab writes `key` (null removes it) — the store alone — and this document hears the
 * `StorageEvent` a browser dispatches to the other documents.
 */
export function otherTabWrites(key: string, value: string | null): void {
  const oldValue = rawWrite(key, value);
  window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: value, storageArea: window.localStorage }));
}

/** Another tab let the tags of `draftKey` go (it sent that draft — S13: its value goes with the text). */
export function otherTabReleases(draftKey: string): void {
  otherTabWrites(getDraftValueKey(draftKey), null);
}

/**
 * Issue #4604 S13: another tab writes the draft `draftKey`'s one value (null removes it) — the store
 * alone, and this document hears its `StorageEvent`.
 */
export function otherTabWritesDraft(
  draftKey: string,
  value: { text?: string; tags?: readonly RetargetTag[]; unknown?: string | null; sendMark?: { text: string; target: string } | null } | null,
): void {
  otherTabWrites(getDraftValueKey(draftKey), value === null ? null : draftValue(value));
}

/** The model's failures of the store, for the road's pure tests (T-f · T-g). */
export type ModelFail = 'none' | 'rThrow' | 'wAll' | 'wShort' | 'wBody' | 'rmThrow';

/** The longest `:retarget` value `wShort` still takes: the short "unknown" (no tags) fits, a tag does not. */
export const SHORT_VALUE_LIMIT = 60;

const VALUE_SUFFIX = ':value';
const RETARGET_SUFFIX = ':retarget';

/** The draft key of a `<K>:value` or `<K>:retarget` key (null: neither). */
function draftOfKey(key: string): { draft: string; value: boolean } | null {
  if (key.endsWith(VALUE_SUFFIX)) return { draft: key.slice(0, -VALUE_SUFFIX.length), value: true };
  if (key.endsWith(RETARGET_SUFFIX)) return { draft: key.slice(0, -RETARGET_SUFFIX.length), value: false };
  return null;
}

/**
 * An in-memory store with the model's failures: `rThrow` — reading `:retarget` throws; `wAll` —
 * every write throws; `wShort` — a `:retarget` value longer than {@link SHORT_VALUE_LIMIT} and every
 * text write throw; `wBody` — text writes throw; `rmThrow` — every remove throws.
 *
 * Issue #4604 S13: the road reads and writes a draft's one value (`<K>:value`). This store keeps the marks
 * of a value with no text and no #4503 mark under `<K>:retarget` in the shape of before (a list, or
 * `{"unknown":…,"tags":[…]}`), and shows them to the road as `<K>:value` — so a test seeds and reads
 * `:retarget` as it did, and the failures above judge the marks by the shape of before. A value with a
 * text (or a #4503 mark) is kept as it is under `<K>:value` (a text write: `wShort`・`wBody` refuse it).
 */
export class MemoryRetargetStorage {
  readonly data = new Map<string, string>();
  fail: ModelFail = 'none';
  /** Each write tried on a `:retarget` key, in order, and whether it went in. */
  readonly attempts: Array<{ key: string; value: string | null; ok: boolean }> = [];
  /** Called after each `:retarget` write that went in. */
  onRetargetWrite: ((key: string, value: string | null) => void) | null = null;

  getItem(key: string): string | null {
    const of = draftOfKey(key);
    // `rThrow`: the marks cannot be read. A value with no text of its own is shown as one the road cannot
    // read as a value (junk — the road's table reads it as it reads a throw), so the road still knows there
    // is no text (it writes the marks as "unknown", as it did over a `:retarget` that threw).
    if (this.fail === 'rThrow' && of !== null && of.value && !this.data.has(key)) return '{"rThrow"';
    if (this.fail === 'rThrow' && of !== null) throw new Error('getItem');
    if (of !== null && of.value) {
      const stored = this.data.get(key);
      if (stored !== undefined) return stored;
      const marks = this.data.get(of.draft + RETARGET_SUFFIX);
      return marks === undefined ? null : MemoryRetargetStorage.asValue(marks);
    }
    if (of !== null && this.data.has(of.draft + VALUE_SUFFIX)) return null;
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    const of = draftOfKey(key);
    if (of !== null && of.value) {
      const marks = MemoryRetargetStorage.asMarks(value);
      if (marks !== undefined) {
        this.writeMarks(of.draft, marks, () => this.data.delete(key));
        return;
      }
      // A value with a text: a text write.
      if (this.fail === 'wAll' || this.fail === 'wShort' || this.fail === 'wBody') throw new Error('setItem');
      this.data.set(key, value);
      this.data.delete(of.draft + RETARGET_SUFFIX);
      return;
    }
    if (of !== null) {
      this.writeMarks(of.draft, value, () => undefined);
      return;
    }
    if (this.fail === 'wAll' || this.fail === 'wShort' || this.fail === 'wBody') throw new Error('setItem');
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    const of = draftOfKey(key);
    if (of !== null && !of.value && this.data.has(of.draft + VALUE_SUFFIX)) {
      // The road's migration lets the key of before go once the value is in: nothing of it is here.
      if (this.fail === 'rmThrow' || this.fail === 'wAll') throw new Error('removeItem');
      return;
    }
    if (of !== null) {
      this.writeMarks(of.draft, null, () => this.data.delete(of.draft + VALUE_SUFFIX));
      return;
    }
    if (this.fail === 'rmThrow' || this.fail === 'wAll') throw new Error('removeItem');
    this.data.delete(key);
  }

  /** The marks of `draft` written in the shape of before (null: removed). */
  private writeMarks(draft: string, marks: string | null, also: () => void): void {
    const tagKey = draft + RETARGET_SUFFIX;
    const refuse =
      marks === null
        ? this.fail === 'rmThrow' || this.fail === 'wAll'
        : this.fail === 'wAll' || (this.fail === 'wShort' && marks.length > SHORT_VALUE_LIMIT);
    this.attempts.push({ key: tagKey, value: marks, ok: !refuse });
    if (refuse) throw new Error(marks === null ? 'removeItem' : 'setItem');
    if (marks === null) this.data.delete(tagKey);
    else this.data.set(tagKey, marks);
    also();
    this.onRetargetWrite?.(tagKey, marks);
  }

  /** The marks of before shown as a value with no text (junk stays junk). */
  private static asValue(marks: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(marks);
    } catch {
      return marks;
    }
    if (Array.isArray(parsed)) return JSON.stringify({ v: 1, text: '', tags: parsed, unknown: null, sendMark: null });
    if (typeof parsed === 'object' && parsed !== null) {
      const { unknown, tags } = parsed as { unknown?: unknown; tags?: unknown };
      if (typeof unknown === 'string' && Array.isArray(tags)) return JSON.stringify({ v: 1, text: '', tags, unknown, sendMark: null });
    }
    return marks;
  }

  /** A value with no text and no #4503 mark as the marks of before (null: no marks; undefined: it has a text). */
  private static asMarks(value: string): string | null | undefined {
    const parsed = JSON.parse(value) as { text: string; tags: unknown[]; unknown: string | null; sendMark: unknown };
    if (parsed.text !== '' || parsed.sendMark !== null) return undefined;
    if (parsed.unknown !== null) return JSON.stringify({ unknown: parsed.unknown, tags: parsed.tags });
    return parsed.tags.length > 0 ? JSON.stringify(parsed.tags) : null;
  }
}

/** A To: an instance and its tool. */
export interface OracleTarget {
  instanceId: string;
  cliToolId: string;
}

/** One POST, as the oracle saw it. */
export interface OraclePost {
  to: OracleTarget;
  /** What the text was: its tags' originals (empty: a plain text), and whether its tags were not known. */
  original: OracleTarget | null;
  unknown: boolean;
  lastYes: OracleTarget | null;
}

const sameTarget = (a: OracleTarget | null, b: OracleTarget | null): boolean =>
  a !== null && b !== null && a.instanceId === b.instanceId && a.cliToolId === b.cliToolId;

/**
 * T-b (案 A'): a POST of a handed-back text (or of a draft whose tags are not known) holds when
 * (i) its tag's original is the POST's To (known), or (ii) the POST's To is the To of the question the
 * person last said yes to. A plain text (no tag, known) always holds.
 */
export function createPostOracle() {
  const oracle = {
    lastYes: null as OracleTarget | null,
    posts: [] as OraclePost[],
    yes(to: OracleTarget | null) {
      oracle.lastYes = to;
    },
    record(post: OraclePost) {
      oracle.posts.push(post);
    },
    violations(): OraclePost[] {
      return oracle.posts.filter((post) => {
        if (post.original === null && !post.unknown) return false;
        if (!post.unknown && sameTarget(post.original, post.to)) return false;
        return !sameTarget(post.lastYes, post.to);
      });
    },
    reset() {
      oracle.lastYes = null;
      oracle.posts = [];
    },
  };
  return oracle;
}

/** The source without its comments (strings and templates kept as they are). */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * This page's unstorable marks are module state: let them go between cases (a release that saw each),
 * so cases do not leak into each other. A no-op where the road does not exist (develop, before #4604:
 * the cases then fail on what they check, not on the clean-up).
 */
export function releasePageMarks(keys: readonly string[]): void {
  const road = draftModule as unknown as Record<string, unknown>;
  if (typeof road.readRetargetUnstorable !== 'function' || typeof road.writeRetarget !== 'function') return;
  for (const key of keys) {
    const generation = draftModule.readRetargetUnstorable(key);
    if (generation !== null) draftModule.writeRetarget(key, { kind: 'release', ids: [], seen: [generation] });
  }
}

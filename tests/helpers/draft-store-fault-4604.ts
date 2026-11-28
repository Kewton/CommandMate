/**
 * Issue #4604 (設計書 §3.4.1): the store's faults, another tab, and the POST oracle — shared by the
 * #4604 tests.
 *
 * - {@link installStoreFaults}: `localStorage`'s `getItem` / `setItem` / `removeItem` throw for the keys
 *   a rule picks (the draft's `:retarget` key, its text key, any), always, from the n-th call, for n
 *   calls only, or only for a value longer than N bytes (a full store that still takes a short value).
 * - {@link otherTabWrites}: another tab — the store alone is written (never a second render in this
 *   document) and a `StorageEvent` is dispatched, as a browser does in the other documents.
 * - {@link MemoryRetargetStorage}: an in-memory store for the road's pure tests, with the model's
 *   failures (`none` · `rThrow` · `wAll` · `wShort` · `wBody` · `rmThrow`).
 * - {@link createPostOracle}: every POST is judged by one rule (案 A'): (i) the text's tag names the
 *   POST's To, or (ii) the POST's To is the To the question the person last said yes to named, and
 *   the yes covered what the text was (the ids and generations its question saw).
 */
import { vi } from 'vitest';
import * as draftModule from '@/lib/drafts/message-draft';
import { getRetargetTagKey } from '@/lib/drafts/message-draft';

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
}

export const isRetargetKey = (key: string): boolean => key.endsWith(':retarget');
export const isDraftTextKey = (key: string): boolean =>
  key.startsWith('commandmate:draft-message:') && !key.endsWith(':retarget') && !key.endsWith(':send-unknown');

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

/** Another tab let the tags of `draftKey` go (it sent that draft). */
export function otherTabReleases(draftKey: string): void {
  otherTabWrites(getRetargetTagKey(draftKey), null);
}

/** The model's failures of the store, for the road's pure tests (T-f · T-g). */
export type ModelFail = 'none' | 'rThrow' | 'wAll' | 'wShort' | 'wBody' | 'rmThrow';

/** The longest `:retarget` value `wShort` still takes: the short "unknown" (no tags) fits, a tag does not. */
export const SHORT_VALUE_LIMIT = 60;

/**
 * An in-memory store with the model's failures: `rThrow` — reading `:retarget` throws; `wAll` —
 * every write throws; `wShort` — a `:retarget` value longer than {@link SHORT_VALUE_LIMIT} and every
 * text write throw; `wBody` — text writes throw; `rmThrow` — every remove throws.
 */
export class MemoryRetargetStorage {
  readonly data = new Map<string, string>();
  fail: ModelFail = 'none';
  /** Each write tried on a `:retarget` key, in order, and whether it went in. */
  readonly attempts: Array<{ key: string; value: string | null; ok: boolean }> = [];
  /** Called after each `:retarget` write that went in. */
  onRetargetWrite: ((key: string, value: string | null) => void) | null = null;

  getItem(key: string): string | null {
    if (this.fail === 'rThrow' && isRetargetKey(key)) throw new Error('getItem');
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    const retarget = isRetargetKey(key);
    const refuse =
      this.fail === 'wAll' ||
      (this.fail === 'wShort' && (!retarget || value.length > SHORT_VALUE_LIMIT)) ||
      (this.fail === 'wBody' && !retarget);
    if (retarget) this.attempts.push({ key, value, ok: !refuse });
    if (refuse) throw new Error('setItem');
    this.data.set(key, value);
    if (retarget) this.onRetargetWrite?.(key, value);
  }

  removeItem(key: string): void {
    const retarget = isRetargetKey(key);
    const refuse = this.fail === 'rmThrow' || this.fail === 'wAll';
    if (retarget) this.attempts.push({ key, value: null, ok: !refuse });
    if (refuse) throw new Error('removeItem');
    this.data.delete(key);
    if (retarget) this.onRetargetWrite?.(key, null);
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

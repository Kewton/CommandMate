/**
 * Issue #4604 S13 (構造の直し: 1 つの下書きを 1 つの鍵の 1 つの値に): the ledger of a draft's store,
 * written so that it does not depend on the shape of the stored value.
 *
 * - {@link belongsTo}: the keys of a draft `K` are `K` itself and every `K:<suffix>` (today `K`,
 *   `K:retarget`, `K:send-unknown`; after the fix the one value lives under one `K:<suffix>`).
 * - {@link readDraftPair}: what the store says about a draft — its text and whether it carries a mark
 *   (a tag, or "unknown") — read from every key of the draft, in today's three-key shape and in the one
 *   value's shape (`{ text, tags, unknown, … }` under a `K:<suffix>` key). A value that cannot be read
 *   counts as "unknown" (every reader asks).
 * - {@link installDraftLedger}: `localStorage`'s `setItem` / `removeItem` / `getItem` are counted per
 *   draft and per actor (G1), each write to a watched draft is followed by the check I2 (G3: a stored
 *   text the scenario says carries a mark has its mark, or "unknown", in the store), a write can be
 *   refused (a full store), one actor's whole operation can be run between two writes of another's
 *   (G2: the orders of two tabs' writes), the `storage` events reach the other tab only (a bridge:
 *   listeners are held per tab, a write is delivered to the other tabs' listeners), and the composers'
 *   debounced saves are held until a test fires them (so a save runs exactly where an order puts it).
 * - {@link perTab}: the in-page channels (`subscribeRetargetedText`, `subscribeDraftAppend`) reach the
 *   composers of the tab that calls them only — two tabs are two documents.
 *
 * Invariants (s12/enabler-return-4604-rootcause-c8.md §3, s13/brief-4604-s13.md):
 * - I1: every operation changes one draft's store with one `setItem` / `removeItem` on one key.
 * - I2: in every state of the store, a text has its mark (or "unknown") in the same value.
 * - I3: whatever the store holds, a composer opened afresh sends to a changed To only after a question.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

export type Tab = string;

/** Whether `key` is one of the keys of the draft `draftKey` (the draft's text key, or `draftKey:…`). */
export const belongsTo = (draftKey: string, key: string): boolean => key === draftKey || key.startsWith(`${draftKey}:`);

// The real methods, taken when this module loads (before any test's spy).
const REAL_GET = typeof Storage !== 'undefined' ? Storage.prototype.getItem : null;
const REAL_SET = typeof Storage !== 'undefined' ? Storage.prototype.setItem : null;
const REAL_REMOVE = typeof Storage !== 'undefined' ? Storage.prototype.removeItem : null;
const REAL_KEY = typeof Storage !== 'undefined' ? Storage.prototype.key : null;
const REAL_SET_TIMEOUT = globalThis.setTimeout;
const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout;

/** The store as it is, past every spy. */
export const raw = {
  get: (key: string): string | null => REAL_GET!.call(window.localStorage, key),
  set: (key: string, value: string): void => REAL_SET!.call(window.localStorage, key, value),
  remove: (key: string): void => REAL_REMOVE!.call(window.localStorage, key),
  keys: (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = REAL_KEY!.call(window.localStorage, i);
      if (key !== null) out.push(key);
    }
    return out.sort();
  },
};

/** The keys of `draftKey` in the store now. */
export function draftKeysInStore(draftKey: string): string[] {
  return raw.keys().filter((key) => belongsTo(draftKey, key));
}

/** What the store says about one draft. */
export interface DraftPair {
  /** The draft's text ('' when none). */
  text: string;
  /** The ids of the tags stored with it. */
  tagIds: string[];
  /** Whether the store says "unknown" for it (or holds a value that cannot be read: every reader asks). */
  unknown: boolean;
  /** The draft's keys in the store. */
  keys: string[];
}

function tagIdsOf(value: unknown): { ids: string[]; junk: boolean } {
  if (!Array.isArray(value)) return { ids: [], junk: true };
  const ids: string[] = [];
  let junk = false;
  for (const tag of value) {
    if (tag !== null && typeof tag === 'object' && typeof (tag as { id?: unknown }).id === 'string') ids.push((tag as { id: string }).id);
    else junk = true;
  }
  return { ids, junk };
}

/**
 * The text and the marks of `draftKey`, from every key of the draft. Today's shape: `K` the text,
 * `K:retarget` the list of tags or `{"unknown":…,"tags":[…]}`, `K:send-unknown` (#4503, not a mark of
 * the text's target). The one value's shape: an object under a `K:<suffix>` key with `text` (string),
 * `tags` (a list of `{ id, … }`) and `unknown` (present and not null/false: "unknown"). Both may be in
 * the store at once (a migration not done yet): the one value's text is the text then.
 */
export function readDraftPair(draftKey: string): DraftPair {
  const keys = draftKeysInStore(draftKey);
  let legacyText: string | null = null;
  let valueText: string | null = null;
  const tagIds: string[] = [];
  let unknown = false;
  for (const key of keys) {
    const value = raw.get(key);
    if (value === null) continue;
    if (key === draftKey) {
      legacyText = value;
      continue;
    }
    const suffix = key.slice(draftKey.length + 1);
    if (suffix === 'send-unknown') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      unknown = true;
      continue;
    }
    if (suffix === 'retarget') {
      if (Array.isArray(parsed)) {
        const { ids, junk } = tagIdsOf(parsed);
        tagIds.push(...ids);
        if (junk) unknown = true;
      } else {
        // The "unknown" shape (or junk): every reader asks. Its tags count as well.
        unknown = true;
        if (parsed !== null && typeof parsed === 'object') tagIds.push(...tagIdsOf((parsed as { tags?: unknown }).tags).ids);
      }
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      unknown = true;
      continue;
    }
    const one = parsed as { text?: unknown; tags?: unknown; unknown?: unknown };
    if (typeof one.text === 'string') valueText = one.text;
    if (one.tags !== undefined) {
      const { ids, junk } = tagIdsOf(one.tags);
      tagIds.push(...ids);
      if (junk) unknown = true;
    }
    if (one.unknown !== undefined && one.unknown !== null && one.unknown !== false) unknown = true;
  }
  return { text: valueText ?? legacyText ?? '', tagIds, unknown, keys };
}

/** Whether the store holds a mark (a tag or "unknown") for the draft's text. */
export const isMarked = (pair: DraftPair): boolean => pair.unknown || pair.tagIds.length > 0;

/** One `setItem` / `removeItem` the ledger saw. */
export interface LedgerWrite {
  index: number;
  actor: Tab | null;
  method: 'setItem' | 'removeItem';
  key: string;
  value: string | null;
  /** The value before (null: no key). */
  oldValue: string | null;
  /** A full store refused it (it threw; nothing changed). */
  refused: boolean;
}

export interface DraftLedgerOptions {
  /** The drafts watched (their keys: {@link belongsTo}). */
  drafts: readonly string[];
  /** I2: a stored text for which this is true must have its mark in the store. Default: never checked. */
  tagged?: (text: string) => boolean;
  /** A full store: a `setItem` of a draft's key for which this is true throws (`QuotaExceededError`). */
  refuse?: (key: string, value: string) => boolean;
  /** The tabs the bridge delivers `storage` events to (another document each). */
  tabs?: readonly Tab[];
  /** The composer's debounced save delay (the timers held for the test to fire). */
  saveDelayMs?: number;
}

/** G2: run another actor's whole operation just before the `at`-th write (0-based) of `outer`. */
export interface LedgerNest {
  outer: Tab;
  at: number;
  inner: Tab;
  run: () => void;
  done: boolean;
  /** The ledger's write count when the nest was set (the outer's writes are counted from there). */
  base: number;
}

export interface DraftLedger {
  /** Who acts now (a write, a listener, a timer is theirs). */
  actor: Tab | null;
  readonly writes: LedgerWrite[];
  readonly reads: Array<{ actor: Tab | null; key: string }>;
  /** I2 violations seen after a write (G3). */
  readonly violations: string[];
  /**
   * Whether I2 is checked: armed the first time the store holds a text `tagged` says is marked together
   * with its mark (before that, the text is a plain draft — the fence has not stopped it yet).
   */
  armed: boolean;
  /** Whether a write is queued for the other tabs (a `StorageEvent`). */
  bridge: boolean;
  nest: LedgerNest | null;
  /** Run `fn` as `tab` (sync). */
  as<T>(tab: Tab | null, fn: () => T): T;
  /** The writes to `draftKey`'s keys since `from` (an index into {@link writes}), by `actor` when given. */
  writesOf(draftKey: string, from?: number, actor?: Tab): LedgerWrite[];
  /** Deliver the queued writes to the other tabs (their answers too), up to `bound` deliveries. */
  deliver(bound?: number): Promise<{ quiet: boolean; delivered: number }>;
  /** Forget the queued writes (they never reach the other tabs). */
  dropQueue(): void;
  /** The debounced saves `tab` holds now. */
  pendingSaves(tab: Tab): number;
  /** Fire `tab`'s held saves now (sync, no `act`: a save sets no state). Returns how many ran. */
  fireSaves(tab: Tab): number;
  /** Forget every held save (the composers went). */
  dropSaves(): void;
  /** Check I2 for every watched draft now (`label` names the moment). */
  checkI2(label: string): void;
  restore(): void;
}

let current: DraftLedger | null = null;

/**
 * The in-page channels reach the composers of the calling tab only (two tabs are two documents).
 * Wraps a `subscribe(key, listener)`: the listener is called only while the actor is the tab that
 * subscribed (or no ledger is installed, or the subscriber had no tab).
 */
export function perTab<A extends unknown[]>(subscribe: (key: string, listener: (...args: A) => void) => () => void) {
  return (key: string, listener: (...args: A) => void): (() => void) => {
    const tab = current?.actor ?? null;
    return subscribe(key, (...args: A) => {
      if (current === null || tab === null || current.actor === tab) listener(...args);
    });
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  REAL_SET_TIMEOUT(resolve, ms);
});

export function installDraftLedger(options: DraftLedgerOptions): DraftLedger {
  const saveDelay = options.saveDelayMs ?? 500;
  const tabs = new Set(options.tabs ?? []);
  const listeners: Array<{ tab: Tab | null; listener: EventListenerOrEventListenerObject }> = [];
  const queue: Array<{ writer: Tab | null; key: string; oldValue: string | null; newValue: string | null }> = [];
  const timers = new Map<object, { actor: Tab | null; fn: () => void }>();
  let timerSeq = 0;

  const draftOf = (key: string): string | undefined => options.drafts.find((draft) => belongsTo(draft, key));

  const ledger: DraftLedger = {
    actor: null,
    writes: [],
    reads: [],
    violations: [],
    armed: false,
    bridge: true,
    nest: null,
    as<T>(tab: Tab | null, fn: () => T): T {
      const prev = ledger.actor;
      ledger.actor = tab;
      try {
        return fn();
      } finally {
        ledger.actor = prev;
      }
    },
    writesOf(draftKey, from = 0, actor) {
      return ledger.writes.slice(from).filter((w) => belongsTo(draftKey, w.key) && (actor === undefined || w.actor === actor));
    },
    async deliver(bound = 40) {
      let delivered = 0;
      while (queue.length > 0) {
        const write = queue.shift()!;
        for (const slot of [...listeners]) {
          if (slot.tab === null || slot.tab === write.writer || !tabs.has(slot.tab)) continue;
          if (!listeners.includes(slot)) continue;
          delivered += 1;
          if (delivered > bound) {
            queue.length = 0;
            return { quiet: false, delivered };
          }
          const event = new StorageEvent('storage', { key: write.key, oldValue: write.oldValue, newValue: write.newValue, storageArea: window.localStorage });
          ledger.as(slot.tab, () => {
            act(() => {
              if (typeof slot.listener === 'function') slot.listener(event);
              else slot.listener.handleEvent(event);
            });
          });
        }
        await act(async () => {
          await sleep(5);
        });
      }
      return { quiet: true, delivered };
    },
    dropQueue() {
      queue.length = 0;
    },
    pendingSaves(tab) {
      return [...timers.values()].filter((t) => t.actor === tab).length;
    },
    fireSaves(tab) {
      let n = 0;
      for (const [id, timer] of [...timers]) {
        if (timer.actor !== tab) continue;
        timers.delete(id);
        ledger.as(tab, timer.fn);
        n += 1;
      }
      return n;
    },
    dropSaves() {
      timers.clear();
    },
    checkI2(label) {
      if (!options.tagged) return;
      for (const draft of options.drafts) {
        const pair = readDraftPair(draft);
        if (pair.text === '' || !options.tagged(pair.text)) continue;
        if (isMarked(pair)) {
          ledger.armed = true;
          continue;
        }
        if (ledger.armed) {
          ledger.violations.push(`${label}: ${draft} holds ${JSON.stringify(pair.text)} without its mark (keys ${pair.keys.map((k) => (k === draft ? 'K' : `K${k.slice(draft.length)}`)).join(',') || '-'})`);
        }
      }
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
      if (current === ledger) current = null;
    },
  };

  const label = (w: LedgerWrite, draft: string) => `#${w.index} ${w.actor ?? '?'} ${w.method} ${w.key === draft ? 'K' : `K${w.key.slice(draft.length)}`}`;

  function write(storage: Storage, method: 'setItem' | 'removeItem', key: string, value: string | null) {
    const draft = draftOf(key);
    const nest = ledger.nest;
    if (draft !== undefined && nest !== null && !nest.done && ledger.actor === nest.outer) {
      const outerWrites = ledger.writes.slice(nest.base).filter((w) => w.actor === nest.outer && draftOf(w.key) !== undefined).length;
      if (outerWrites === nest.at) {
        nest.done = true;
        ledger.as(nest.inner, nest.run);
      }
    }
    const oldValue = REAL_GET!.call(storage, key);
    const entry: LedgerWrite = { index: ledger.writes.length, actor: ledger.actor, method, key, value, oldValue, refused: false };
    if (draft !== undefined && method === 'setItem' && value !== null && options.refuse?.(key, value)) {
      entry.refused = true;
      ledger.writes.push(entry);
      throw new DOMException('full', 'QuotaExceededError');
    }
    if (method === 'setItem') REAL_SET!.call(storage, key, value as string);
    else REAL_REMOVE!.call(storage, key);
    ledger.writes.push(entry);
    const newValue = method === 'setItem' ? value : null;
    if (ledger.bridge && oldValue !== newValue) queue.push({ writer: ledger.actor, key, oldValue, newValue });
    if (draft !== undefined) ledger.checkI2(label(entry, draft));
  }

  const realAdd = window.addEventListener.bind(window);
  const realRemoveListener = window.removeEventListener.bind(window);
  const spies = [
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      write(this, 'setItem', key, String(value));
    }),
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      write(this, 'removeItem', key, null);
    }),
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (draftOf(key) !== undefined) ledger.reads.push({ actor: ledger.actor, key });
      return REAL_GET!.call(this, key);
    }),
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
      if (type !== 'storage') return listener === null ? undefined : realAdd(type, listener, opts);
      if (listener !== null) listeners.push({ tab: ledger.actor, listener });
    }) as typeof window.addEventListener),
    vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => {
      if (type !== 'storage') return listener === null ? undefined : realRemoveListener(type, listener, opts);
      const at = listeners.findIndex((slot) => slot.listener === listener);
      if (at >= 0) listeners.splice(at, 1);
    }) as typeof window.removeEventListener),
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: unknown, ms?: number, ...args: unknown[]) => {
      if (ms === saveDelay && typeof fn === 'function') {
        timerSeq += 1;
        const id = { heldSave: timerSeq };
        timers.set(id, { actor: ledger.actor, fn: () => (fn as (...a: unknown[]) => void)(...args) });
        return id;
      }
      return (REAL_SET_TIMEOUT as (...a: unknown[]) => unknown)(fn, ms, ...args);
    }) as unknown as typeof setTimeout),
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: unknown) => {
      if (id !== null && typeof id === 'object' && timers.has(id)) {
        timers.delete(id);
        return;
      }
      (REAL_CLEAR_TIMEOUT as (i: unknown) => void)(id);
    }) as unknown as typeof clearTimeout),
  ];

  current = ledger;
  return ledger;
}

/** n choose k (the orders of two sequences of n and k writes: C(n+k, k)). */
export function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Every order of `n` writes of X and `m` writes of Y that keeps each one's own order ('X' | 'Y' per write). */
export function interleavings(n: number, m: number): Array<Array<'X' | 'Y'>> {
  if (n === 0) return [Array.from({ length: m }, () => 'Y' as const)];
  if (m === 0) return [Array.from({ length: n }, () => 'X' as const)];
  return [
    ...interleavings(n - 1, m).map((rest) => ['X' as const, ...rest]),
    ...interleavings(n, m - 1).map((rest) => ['Y' as const, ...rest]),
  ];
}

/** Where `who`'s writes sit in `order`: contiguous (and after how many of the other's), or split. */
export function contiguousAt(order: ReadonlyArray<'X' | 'Y'>, who: 'X' | 'Y'): number | null {
  const first = order.indexOf(who);
  if (first < 0) return 0;
  const last = order.lastIndexOf(who);
  for (let i = first; i <= last; i += 1) if (order[i] !== who) return null;
  return first;
}

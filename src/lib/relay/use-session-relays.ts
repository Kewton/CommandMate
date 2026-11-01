'use client';

/**
 * What a worktree's relays look like to the browser (Issue #2377).
 *
 * The badges and the chat strip need the same three facts — who owes whom, how
 * many, and whether anybody is stuck on a dialog — so they read them through one
 * hook rather than each growing a fetch. Two components asking the same endpoint
 * on two intervals is how one of them ends up a poll behind the other while
 * showing the same row.
 *
 * ## Why polling and not a socket frame
 *
 * A relay's own state changes are already accompanied by a `message` frame: the
 * system line and the delivered body are both `chat_messages` rows, which the
 * open panes receive and render without this hook's help. What is left for the
 * hook is the BADGE — a count, refreshed on a human timescale — and adding a
 * frame type for it would mean threading a new event through
 * `parseRealtimeEvent`, the room subscription and every listener for a number
 * that changes a few times an hour.
 *
 * Zero requests when there is no worktree to ask about, and the last answer is
 * kept on screen through a failed read: a badge blanking on a transient 500
 * reads as "the delegation finished", which is the one thing it must not say by
 * accident.
 *
 * ## Held deliveries (Issue #4082)
 *
 * Every read — the first, the poll and an explicit `refresh` — also keeps the
 * answer's `held`, narrowed to `uncertain` (an `attempting` payload is still
 * on its way and stays an ordinary pending relay). A relay held that way is
 * taken OUT of `owedBy` / `awaitedBy`, so no surface counts it twice, and is
 * read through `heldFor` (the requester's row — the payload was going to it)
 * or `heldUnplaced` (a requester the roster no longer has). Closed relays'
 * holds are included: closing a relay does not settle what may be in A's
 * composer.
 *
 * Answers are applied in the order their reads were issued: a slow answer
 * from before a resolve that lands after the answer from after it is dropped,
 * so a settled hold does not come back.
 *
 * @module lib/relay/use-session-relays
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import {
  emptyRelayCounts,
  type RelayCounts,
  type SessionRelay,
} from '@/lib/relay/types';

/** How often the badges re-read. Slow: a relay changes a few times an hour. */
export const RELAY_POLL_INTERVAL_MS = 20_000;

/** The shape `GET /api/relays` answers with. */
interface RelayListPayload {
  owed?: SessionRelay[];
  awaiting?: SessionRelay[];
  open?: SessionRelay[];
  /** Issue #4064: relays in scope, open or closed, under a delivery hold. */
  held?: SessionRelay[];
  counts?: RelayCounts;
}

/** What {@link useSessionRelays} hands back. */
export interface SessionRelaysView {
  /** Every open relay with this worktree at either end. */
  open: SessionRelay[];
  /**
   * Issue #4082: every relay with this worktree at either end whose payload
   * is held as `uncertain` — open or closed.
   */
  held: SessionRelay[];
  counts: RelayCounts;
  /** Open relays this instance must answer (it is the `to` end); held ones excluded. */
  owedBy: (instanceId: string) => SessionRelay[];
  /** Open relays this instance is waiting on (it is the `from` end); held ones excluded. */
  awaitedBy: (instanceId: string) => SessionRelay[];
  /** Issue #4082: held payloads that were going to this instance (it is the `from` end). */
  heldFor: (instanceId: string) => SessionRelay[];
  /**
   * Issue #4082: held payloads going to an instance of this worktree that is
   * not in `rosterIds` (deleted from the roster, say), so they still show.
   */
  heldUnplaced: (rosterIds: readonly string[]) => SessionRelay[];
  /** Re-read now. For a surface that just caused a change. */
  refresh: () => void;
}

/** The view a caller gets before the first read lands, and when there is none. */
const EMPTY_RELAYS: SessionRelay[] = [];

/** Whether the relay's payload is held as `uncertain` (Issue #4082). */
export function isRelayDeliveryUncertain(relay: SessionRelay): boolean {
  return relay.deliveryHold?.state === 'uncertain';
}

/** One worktree's shared answer, and the poll that keeps it fresh. */
interface RelayStore {
  snapshot: { open: SessionRelay[]; held: SessionRelay[]; counts: RelayCounts };
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  /** How many mounted hooks are using it. */
  refs: number;
  /** Issue #4082: sequence of the last read issued, and of the last answer applied. */
  issued: number;
  applied: number;
}

/**
 * One poll per worktree, however many surfaces are asking.
 *
 * The chat surface, the PC roster pane and the phone's roster sheet can all be
 * mounted at once, and three independent intervals would be three requests for
 * one answer AND three answers that disagree by up to a poll — which on a badge
 * reads as the roster and the strip contradicting each other. Reference-counted
 * so the interval stops when the last consumer unmounts.
 *
 * Module-scoped rather than a context: every consumer is in a different subtree
 * (a settings sheet, a split pane, a phone tab) and threading a provider through
 * all of them would touch far more of the screen than a badge is worth.
 */
const stores = new Map<string, RelayStore>();

/** Test seam: forget every shared poll. */
export function resetSessionRelayStores(): void {
  for (const store of stores.values()) {
    if (store.timer) clearInterval(store.timer);
  }
  stores.clear();
}

function emptySnapshot(): RelayStore['snapshot'] {
  return { open: EMPTY_RELAYS, held: EMPTY_RELAYS, counts: emptyRelayCounts() };
}

async function readInto(worktreeId: string, store: RelayStore): Promise<void> {
  // Issue #4082: numbered when issued, so an older answer never overwrites a newer one.
  store.issued += 1;
  const sequence = store.issued;
  try {
    const response = await fetch(`/api/relays?worktree=${encodeURIComponent(worktreeId)}`);
    if (!response.ok) return;
    const body: RelayListPayload = await response.json();
    if (stores.get(worktreeId) !== store) return;
    if (sequence < store.applied) return;
    store.applied = sequence;
    store.snapshot = {
      open: Array.isArray(body.open) ? body.open : EMPTY_RELAYS,
      // An older server answers without `held`: nothing is shown as held.
      held: Array.isArray(body.held) ? body.held.filter(isRelayDeliveryUncertain) : EMPTY_RELAYS,
      counts: body.counts ?? emptyRelayCounts(),
    };
    for (const listener of store.listeners) listener();
  } catch {
    // Keep the last answer: see the module comment.
  }
}

function acquireStore(worktreeId: string): RelayStore {
  let store = stores.get(worktreeId);
  if (!store) {
    store = { snapshot: emptySnapshot(), listeners: new Set(), timer: null, refs: 0, issued: 0, applied: 0 };
    stores.set(worktreeId, store);
  }
  store.refs += 1;
  if (store.timer === null) {
    void readInto(worktreeId, store);
    store.timer = setInterval(() => void readInto(worktreeId, store), RELAY_POLL_INTERVAL_MS);
  }
  return store;
}

function releaseStore(worktreeId: string): void {
  const store = stores.get(worktreeId);
  if (!store) return;
  store.refs -= 1;
  if (store.refs > 0) return;
  if (store.timer) clearInterval(store.timer);
  stores.delete(worktreeId);
}

/**
 * Read the open relays of one worktree.
 *
 * @param worktreeId - The worktree, or null/undefined to read nothing
 */
export function useSessionRelays(worktreeId: string | null | undefined): SessionRelaysView {
  const [fallback] = useState(emptySnapshot);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!worktreeId) return () => {};
      const store = acquireStore(worktreeId);
      store.listeners.add(onChange);
      return () => {
        store.listeners.delete(onChange);
        releaseStore(worktreeId);
      };
    },
    [worktreeId]
  );

  const getSnapshot = useCallback(
    () => (worktreeId ? (stores.get(worktreeId)?.snapshot ?? fallback) : fallback),
    [worktreeId, fallback]
  );

  const { open, held, counts } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(() => {
    const store = worktreeId ? stores.get(worktreeId) : undefined;
    if (worktreeId && store) void readInto(worktreeId, store);
  }, [worktreeId]);

  return useMemo(() => {
    // Issue #4082: a held relay is shown as held, never also as pending or prompt.
    const heldIds = new Set(held.map((relay) => relay.id));
    const live = (relay: SessionRelay): boolean =>
      !heldIds.has(relay.id) && !isRelayDeliveryUncertain(relay);
    const isRequester = (relay: SessionRelay): boolean => relay.from.worktreeId === worktreeId;
    return {
      open,
      held,
      counts,
      owedBy: (instanceId: string) =>
        open.filter(
          (relay) =>
            live(relay) && relay.to.worktreeId === worktreeId && relay.to.instanceId === instanceId
        ),
      awaitedBy: (instanceId: string) =>
        open.filter(
          (relay) => live(relay) && isRequester(relay) && relay.from.instanceId === instanceId
        ),
      heldFor: (instanceId: string) =>
        held.filter((relay) => isRequester(relay) && relay.from.instanceId === instanceId),
      heldUnplaced: (rosterIds: readonly string[]) =>
        held.filter((relay) => isRequester(relay) && !rosterIds.includes(relay.from.instanceId)),
      refresh,
    };
  }, [open, held, counts, worktreeId, refresh]);
}

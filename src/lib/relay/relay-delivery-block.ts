/**
 * Why the last delivery attempt of a relay payload stopped (Issue #4105).
 *
 * While the requester A shows a confirmation dialog, every pump tick refuses
 * the delivery (`prompt_waiting`) and nothing in the ledger said so: the relay
 * read the same as one that was simply queued. This module keeps, in the
 * server process, the reason the LAST attempt stopped for — tied to the
 * payload it was for and the time it was observed — and attaches it to the
 * relay APIs' answers as `lastDeliveryBlock`.
 *
 * ## Rules
 *
 *  - **One writer.** Only `deliverOne` (via the single-flight pump) records or
 *    clears an entry, so every entry point that ends in a pump — a turn
 *    completion, a prompt notice, the maintenance tick, a resolve — follows the
 *    same rule.
 *  - **Tied to the payload.** An entry is shown only while the slot still
 *    carries the same payload (kind, id, body) and no delivery hold. A payload
 *    replaced, delivered, cancelled, expired, held or taken answers `null`, and
 *    the stale entry is dropped.
 *  - **An observation, not a state.** `observedAt` is the attempt's time; the
 *    next attempt replaces or clears it. `null` means "no observation", never
 *    "deliverable" (a restart forgets every entry on purpose).
 *  - **Never in the database**, and never in `held` / `heldCount` /
 *    `holdReason` / `deliveryHold`.
 *  - **Never throws.** A failure here costs the label, never the delivery or
 *    the API answer that carries it.
 *
 * @module lib/relay/relay-delivery-block
 */

import type Database from 'better-sqlite3';
import { getRelayPendingPayload, listClosedRelaysWithPendingPayload } from '@/lib/db/relay-db';
import { createLogger } from '@/lib/logger';
import type {
  RelayDeliveryBlockReason,
  RelayEndpoint,
  RelayLastDeliveryBlock,
  RelayPendingKind,
  SessionRelay,
} from '@/lib/relay/types';
import { getOrInitGlobal } from '../global-state';

const logger = createLogger('relay-delivery-block');

/** What one attempt observed, with the body it was for (never exposed). */
export interface RelayDeliveryBlockEntry {
  reason: RelayDeliveryBlockReason;
  kind: RelayPendingKind;
  payloadId: string | null;
  body: string;
  observedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __relayLastDeliveryBlocks: Map<string, RelayDeliveryBlockEntry> | undefined;
}

/** On `globalThis` for the reason the pump's own sets are (#1736). */
const blocks = getOrInitGlobal(
  '__relayLastDeliveryBlocks',
  () => new Map<string, RelayDeliveryBlockEntry>()
);

/** Forget every observation (what a restart does). Test seam. */
export function resetRelayDeliveryBlocks(): void {
  blocks.clear();
}

/**
 * Record what the last attempt of `relayId` observed, or clear it (`null`:
 * the attempt did not stop for one of the reasons — delivered, uncertain,
 * superseded, failed for another reason).
 */
export function noteRelayDeliveryAttempt(
  relayId: string,
  entry: RelayDeliveryBlockEntry | null
): void {
  try {
    if (entry === null) blocks.delete(relayId);
    else blocks.set(relayId, entry);
  } catch (error) {
    logger.warn('relay-delivery-block-note-failed', {
      relayId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Drop the entries of relays the pump no longer lists (closed, held, emptied). */
export function pruneRelayDeliveryBlocks(listed: ReadonlySet<string>): void {
  try {
    for (const relayId of [...blocks.keys()]) {
      if (!listed.has(relayId)) blocks.delete(relayId);
    }
  } catch {
    // Best-effort: an entry left behind is still checked against the payload.
  }
}

/**
 * The observation for the payload `relay` carries now, or `null`.
 *
 * Re-reads the slot rather than trusting the row the caller has: the entry
 * must describe THIS payload. A mismatch drops the entry.
 */
export function readRelayLastDeliveryBlock(
  db: Database.Database,
  relay: SessionRelay
): RelayLastDeliveryBlock | null {
  try {
    const entry = blocks.get(relay.id);
    if (!entry) return null;
    const current = getRelayPendingPayload(db, relay.id);
    if (
      !current ||
      current.kind !== entry.kind ||
      current.payloadId !== entry.payloadId ||
      current.body !== entry.body
    ) {
      blocks.delete(relay.id);
      return null;
    }
    // Under a delivery hold (`attempting` / `uncertain`) the hold is what
    // describes the payload; the entry is kept in case the attempt is queued
    // again, but not shown.
    if (current.relay.deliveryHold !== null) return null;
    return {
      reason: entry.reason,
      kind: entry.kind,
      payloadId: entry.payloadId,
      observedAt: entry.observedAt,
    };
  } catch (error) {
    logger.warn('relay-delivery-block-read-failed', {
      relayId: relay.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** `relay` with its {@link readRelayLastDeliveryBlock} attached. */
export function withLastDeliveryBlock(db: Database.Database, relay: SessionRelay): SessionRelay {
  return { ...relay, lastDeliveryBlock: readRelayLastDeliveryBlock(db, relay) };
}

/** {@link withLastDeliveryBlock} over a list. */
export function withLastDeliveryBlocks(
  db: Database.Database,
  relays: readonly SessionRelay[]
): SessionRelay[] {
  return relays.map((relay) => withLastDeliveryBlock(db, relay));
}

/**
 * Closed relays whose undelivered payload's last attempt stopped (Issue #4193).
 *
 * An expired relay keeps its expiry notice in the slot until it reaches the
 * requester, and the pump records why that delivery stopped like any other —
 * but the list's `open` / `awaiting` (rightly) leave closed relays out, so the
 * reason was readable through `relays --id` only. This is the list of those
 * relays, each with its `lastDeliveryBlock`; one that carries no observation
 * (nothing stopped it, or this process has not tried) is not listed. Never
 * counted in `counts` / `heldCount`, never added to `open` / `awaiting`, and
 * never throws (an empty list costs the label only).
 */
export function listClosedBlockedRelays(
  db: Database.Database,
  scope: { worktreeId?: string; requester?: RelayEndpoint } = {}
): SessionRelay[] {
  try {
    return withLastDeliveryBlocks(db, listClosedRelaysWithPendingPayload(db, scope)).filter(
      (relay) => relay.lastDeliveryBlock != null
    );
  } catch (error) {
    logger.warn('relay-closed-blocked-list-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Relays whose payload is being typed into the requester's composer right now
 * (Issue #3732).
 *
 * A claim is taken by `relay-delivery` immediately before `sendUserMessage`, in
 * the same synchronous stretch that re-read the row and found it still open, and
 * released once the attempt is over (delivered, held or failed). While it is
 * held, `withdrawRelay` answers `delivering` instead of cancelling: a cancel
 * that reported success would be a lie once the send is already under way, and
 * the send cannot be taken back.
 *
 * A module of its own, rather than an export of `relay-delivery`, so that
 * `relay-service` (and the cancel route behind it) can consult it without
 * importing the send path.
 *
 * On `globalThis` for the reason the in-flight set is (#1736): the poller's and
 * the API's bundles must see the same set under `next dev`. Being in memory is
 * enough — a claim only lives for the duration of one send in this process, so
 * there is nothing to migrate and nothing to recover after a restart.
 *
 * @module lib/relay/relay-delivery-claims
 */

import { getOrInitGlobal } from '../global-state';

declare global {
  // eslint-disable-next-line no-var
  var __relayDeliveryClaims: Set<string> | undefined;
}

const claims = getOrInitGlobal('__relayDeliveryClaims', () => new Set<string>());

/** Mark a relay as being delivered. */
export function claimRelayDelivery(relayId: string): void {
  claims.add(relayId);
}

/** The attempt is over, whatever its outcome. */
export function releaseRelayDelivery(relayId: string): void {
  claims.delete(relayId);
}

/** Whether a send for this relay is under way right now. */
export function isRelayDeliveryClaimed(relayId: string): boolean {
  return claims.has(relayId);
}

/** Forget every claim. Test seam. */
export function resetRelayDeliveryClaims(): void {
  claims.clear();
}

/**
 * Who observed a relay's send, and when (Issue #3957).
 *
 * A bound relay records the server boot that reserved it and the session
 * generation its input was observed in. Both live in memory — the turn record
 * a reply is judged against is in memory too — so a row written by a previous
 * boot, or against a session that has since been relaunched, describes a
 * process that no longer exists and must not be matched with a reply from the
 * one that does.
 *
 * On `globalThis` for the reason every shared value of this subsystem is
 * (#1736): the send route's bundle and the poller's bundle must agree on one
 * boot id, or every send would look like it came from another server.
 *
 * @module lib/relay/relay-boot
 */

import { randomUUID } from 'crypto';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { currentGeneration } from '@/lib/session/agent-event-turn';
import { getOrInitGlobal } from '../global-state';

declare global {
  // eslint-disable-next-line no-var
  var __relayServerBootId: string | undefined;
}

/** This server process's boot id. Stable for the life of the process. */
export function relayServerBootId(): string {
  return getOrInitGlobal('__relayServerBootId', () => randomUUID());
}

/** Forget the boot id, so the next read mints a new one. Test seam: a "restart". */
export function resetRelayServerBootId(): void {
  globalThis.__relayServerBootId = undefined;
}

/**
 * `<boot id>#<generation>` for one session — what `obs_source` stores.
 *
 * `-` for a session that has no generation yet (none was ever launched by this
 * process), which is itself a fact a later read must match.
 */
export function relayObservationSource(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined
): string {
  const generation = currentGeneration(buildCompositeKey(worktreeId, cliToolId, instanceId));
  return `${relayServerBootId()}#${generation ?? '-'}`;
}

/** The boot part of an `obs_source`, or null for a malformed one. */
export function bootOfObservationSource(source: string | null): string | null {
  if (source === null) return null;
  const at = source.lastIndexOf('#');
  return at <= 0 ? null : source.slice(0, at);
}

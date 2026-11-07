/**
 * Which enabling of Auto-Yes a state is (Issue #4132).
 *
 * `setAutoYesEnabled` makes a new state object for every enable, so the object already
 * is the identity; this gives it a name a client can hand back. Kept beside the state
 * rather than in it, and in memory, as the grant itself is: no grant outlives the
 * process. Should an id be lost, the condition fails on the safe side and the grant stays.
 */
import { randomUUID } from 'crypto';
import type { AutoYesState } from '@/lib/polling/auto-yes-manager';
import { getOrInitGlobal } from '@/lib/global-state';

declare global {
  // eslint-disable-next-line no-var
  var __autoYesGrantIds: WeakMap<AutoYesState, string> | undefined;
}

/** Stays on `globalThis` for the same reason the states do (Issue #153: hot reload). */
const grantIds = getOrInitGlobal('__autoYesGrantIds', () => new WeakMap<AutoYesState, string>());

/** The name of this enabling. The same state always answers the same name. */
export function autoYesGrantIdOf(state: AutoYesState): string {
  let id = grantIds.get(state);
  if (id === undefined) {
    id = randomUUID();
    grantIds.set(state, id);
  }
  return id;
}

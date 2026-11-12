/**
 * This server process's boot id for mem's notices (Issue #4222, design §3.5).
 *
 * A notice attempt reserved by another boot is stale: the brief that was to carry
 * it belonged to a process that is gone. Read when asked; nothing runs at start-up.
 * Kept apart from relay's boot id (`lib/relay/relay-boot.ts`, the same shape).
 *
 * @module lib/mem/process-boot
 */

import { randomUUID } from 'crypto';
import { getOrInitGlobal } from '../global-state';

declare global {
  // eslint-disable-next-line no-var
  var __memServerBootId: string | undefined;
}

export function memServerBootId(): string {
  return getOrInitGlobal('__memServerBootId', () => randomUUID());
}

/** Forget the boot id, so the next read mints a new one. Test seam: a "restart". */
export function resetMemServerBootId(): void {
  globalThis.__memServerBootId = undefined;
}

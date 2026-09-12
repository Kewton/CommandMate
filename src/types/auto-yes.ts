/**
 * Shared auto-yes types (Issue #314, relocated in Issue #756).
 *
 * `AutoYesToggleParams` originally lived in `AutoYesToggle.tsx` (a TSX file).
 * It is moved here — a plain `.ts` module — so non-TSX consumers compiled under
 * `tsconfig.server.json` (which includes the `src/types` tree but does not set
 * `--jsx`) can import it without triggering TS6142. `AutoYesToggle.tsx`
 * re-exports it for backward compatibility, so existing import sites that pull
 * `AutoYesToggleParams` from the component keep working unchanged.
 */

import type { AutoYesDuration } from '@/config/auto-yes-config';

/** Parameters for auto-yes toggle callback (Issue #314) */
export interface AutoYesToggleParams {
  enabled: boolean;
  duration?: AutoYesDuration;
  stopPattern?: string;
}

/**
 * One instance's Auto-Yes state as the worktree list carries it (Issue #2512).
 *
 * The same `{ enabled, expiresAt }` pair `GET /api/worktrees/:id/auto-yes`
 * answers per instance, so a surface reading the list and one reading the
 * single-worktree route cannot disagree about the shape. `expiresAt` is null
 * whenever `enabled` is false.
 */
export interface AutoYesInstanceSummary {
  enabled: boolean;
  /** Epoch ms the state expires at, or null when not enabled. */
  expiresAt: number | null;
}

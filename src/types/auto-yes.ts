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

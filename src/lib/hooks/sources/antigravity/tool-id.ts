/**
 * Antigravity's {@link CLIToolType} id, as a constant.
 *
 * The id is `antigravity`; **the binary is `agy`**. There is no executable
 * called `antigravity` on any machine (#1757 §1), so the two names are not
 * interchangeable and the split is deliberate: this constant is CommandMate's
 * tool id — the thing that keys the registry, the receiver's `tool` field and
 * the instance triple — while `src/lib/cli-tools/antigravity.ts` owns the
 * command that actually runs.
 *
 * @module lib/hooks/sources/antigravity/tool-id
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

export const ANTIGRAVITY_CLI_TOOL_ID: CLIToolType = 'antigravity';

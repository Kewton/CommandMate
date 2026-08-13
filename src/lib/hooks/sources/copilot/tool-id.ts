/**
 * GitHub Copilot CLI's {@link CLIToolType}, on its own so that anything needing
 * only the id does not pull in the source (Issue #1761).
 *
 * The same split Claude has, and for the same reason: `hook-settings-generator`
 * imports `CLAUDE_CLI_TOOL_ID` while `claude/source.ts` imports
 * `hook-settings-generator`, so a single module would be a cycle.
 *
 * @module lib/hooks/sources/copilot/tool-id
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/** `copilot`, as `CLI_TOOL_IDS` spells it. */
export const COPILOT_CLI_TOOL_ID: CLIToolType = 'copilot';

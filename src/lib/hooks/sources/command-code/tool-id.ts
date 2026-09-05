/**
 * Command Code's {@link CLIToolType} id, as a constant (Issue #2251).
 *
 * The same one-line module claude and gemini have, for the same reason: the
 * literal `'command-code'` appears once under `src/lib/hooks/`, and the module
 * that writes Command Code's config imports the constant rather than restating
 * it.
 *
 * Separate from `./source` because the hooks generator needs the id and the
 * source imports the generator; importing it back out of `./source` would close
 * a cycle.
 *
 * @module lib/hooks/sources/command-code/tool-id
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

export const COMMAND_CODE_CLI_TOOL_ID: CLIToolType = 'command-code';

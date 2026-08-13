/**
 * Gemini CLI's {@link CLIToolType} id, as a constant.
 *
 * The same one-line module Claude has, for the same reason: the literal
 * `'gemini'` appears once under `src/lib/hooks/`, and the modules that write
 * gemini's config import the constant rather than restating it.
 *
 * Separate from `./source` because the settings generator needs the id and the
 * source imports the generator; importing it back out of `./source` would close
 * a cycle.
 *
 * @module lib/hooks/sources/gemini/tool-id
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

export const GEMINI_CLI_TOOL_ID: CLIToolType = 'gemini';

/**
 * Claude Code's {@link CLIToolType} id, as a constant.
 *
 * A one-line module so that the literal `'claude'` appears in exactly one place
 * under `src/lib/hooks/`. `hook-settings-generator` defaults its target to this
 * tool, which is correct — it generates Claude's `--settings` file and nothing
 * else — but a bare literal there reads as "this layer knows about Claude",
 * which after Issue #1759 it must not.
 *
 * Separate from `./source` because that module imports the settings generator;
 * importing the constant back out of it would close a cycle.
 *
 * @module lib/hooks/sources/claude/tool-id
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

export const CLAUDE_CLI_TOOL_ID: CLIToolType = 'claude';

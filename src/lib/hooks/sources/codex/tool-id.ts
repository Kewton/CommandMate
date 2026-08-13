/**
 * codex's {@link CLIToolType} id, on its own so nothing has to import the
 * source to name the tool (Issue #1760).
 *
 * Mirrors `../claude/tool-id`: `hook-settings-generator` needs Claude's id
 * without pulling in Claude's source, and `cli-tools/codex` needs codex's id
 * without pulling in codex's.
 *
 * @module lib/hooks/sources/codex/tool-id
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/** The registry key and the `tool` parameter codex's hooks post under. */
export const CODEX_CLI_TOOL_ID: CLIToolType = 'codex';

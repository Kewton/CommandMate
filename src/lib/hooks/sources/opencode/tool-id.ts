/**
 * opencode's {@link CLIToolType}, on its own so the id can be imported without
 * pulling in the source (Issue #1763).
 *
 * Same shape as `../claude/tool-id`: the registry, the launcher and the tests
 * all need the literal, and only the registry needs the implementation.
 *
 * @module lib/hooks/sources/opencode/tool-id
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/** The tool id every opencode module keys off. */
export const OPENCODE_CLI_TOOL_ID: CLIToolType = 'opencode';

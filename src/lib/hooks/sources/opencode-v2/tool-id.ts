/**
 * OpenCode V2's {@link CLIToolType}, on its own so the id can be imported
 * without pulling in the source (Issue #2934).
 *
 * The same one-line module `../opencode/tool-id` is. OpenCode V2 (`opencode2`)
 * is a separate tool id rather than a version branch of `opencode` (Epic #2370,
 * decision 1): its server, its event vocabulary and its screen all differ, and
 * v1 keeps every behaviour it had.
 *
 * @module lib/hooks/sources/opencode-v2/tool-id
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/** The tool id every OpenCode V2 module keys off. */
export const OPENCODE_V2_CLI_TOOL_ID: CLIToolType = 'opencode-v2';

/** The executable OpenCode V2 installs (npm `@opencode/cli`). */
export const OPENCODE_V2_COMMAND = 'opencode2';

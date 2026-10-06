/**
 * Every tool's live-region declaration, by tool (Issue #3183).
 *
 * A table of its own rather than a lookup through the detector registry:
 * `normalizeFrame` reads it, and the detector modules import `normalizeFrame`,
 * so going through `registry.ts` would close an import cycle. Each detector
 * declares the same object as its `ToolDetectorSpec.liveRegion`, and
 * `live-region-markers.test.ts` holds the two to identity.
 *
 * `gemini` and `vibe-local` have no measured frames and no declaration: their
 * frames carry the whole-frame region, which is the pre-#3183 reading.
 */

import { ANTIGRAVITY_LIVE_REGION } from './antigravity/live-region';
import { CLAUDE_LIVE_REGION } from './claude/live-region';
import { CODEX_LIVE_REGION } from './codex/live-region';
import { COMMAND_CODE_LIVE_REGION } from './command-code/live-region';
import { COPILOT_LIVE_REGION } from './copilot/live-region';
import { OPENCODE_LIVE_REGION } from './opencode/live-region';
import { OPENCODE_V2_LIVE_REGION } from './opencode-v2/live-region';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { LiveRegionSpec } from './types';

export const LIVE_REGION_SPECS: Readonly<Partial<Record<CLIToolType, LiveRegionSpec>>> = {
  claude: CLAUDE_LIVE_REGION,
  codex: CODEX_LIVE_REGION,
  antigravity: ANTIGRAVITY_LIVE_REGION,
  'command-code': COMMAND_CODE_LIVE_REGION,
  copilot: COPILOT_LIVE_REGION,
  opencode: OPENCODE_LIVE_REGION,
  'opencode-v2': OPENCODE_V2_LIVE_REGION,
};

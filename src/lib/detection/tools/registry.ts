/**
 * The tool → detector lookup (Issue #1927, 方針書 §4 D2).
 *
 * Every CLI resolves to a detector, including the ones with no branches of their
 * own: `gemini` and `vibe-local` get {@link createGenericStatusDetector}, which
 * is the shared chain with no tool steps and no idle rule. Returning a real
 * detector for them rather than `null` is what keeps the caller free of a
 * "does this tool have a module?" branch — the shape §4 D2 asks for.
 */

import { antigravityStatusDetector } from './antigravity/detect';
import { claudeStatusDetector } from './claude/detect';
import { codexStatusDetector } from './codex/detect';
import { commandCodeStatusDetector } from './command-code/detect';
import { copilotStatusDetector } from './copilot/detect';
import { opencodeStatusDetector } from './opencode/detect';
import { createToolStatusDetector } from './run-detection';
import { UNMEASURED_VERIFIED_AGAINST } from './verified-against';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { ToolStatusDetector } from './types';

/**
 * A tool whose frames nobody has measured yet.
 *
 * The shared chain and nothing else: prompt detection, the thinking window, the
 * generic composer check, the two heuristics. No `readIdleEvidence`, so its
 * `input_prompt` keeps the pre-#1927 reading (DR2-002), and no
 * `unreadableReason`, so its floor stays the generic `default`.
 */
export function createGenericStatusDetector(tool: CLIToolType): ToolStatusDetector {
  return createToolStatusDetector({
    tool,
    verifiedAgainst: UNMEASURED_VERIFIED_AGAINST,
  });
}

const geminiStatusDetector = createGenericStatusDetector('gemini');
const vibeLocalStatusDetector = createGenericStatusDetector('vibe-local');

const DETECTORS: Readonly<Record<CLIToolType, ToolStatusDetector>> = {
  claude: claudeStatusDetector,
  codex: codexStatusDetector,
  copilot: copilotStatusDetector,
  opencode: opencodeStatusDetector,
  antigravity: antigravityStatusDetector,
  'command-code': commandCodeStatusDetector,
  gemini: geminiStatusDetector,
  'vibe-local': vibeLocalStatusDetector,
};

/**
 * The detector for one CLI.
 *
 * Falls back to a generic detector for an id outside {@link CLIToolType} —
 * callers reach this from route params and CLI flags, and a crash there would be
 * a worse answer than "no tool-specific rules apply".
 */
export function getToolStatusDetector(cliToolId: CLIToolType): ToolStatusDetector {
  return DETECTORS[cliToolId] ?? createGenericStatusDetector(cliToolId);
}

/** Every detector, for the fixture sweep in `tests/unit/detection/tools/`. */
export const TOOL_STATUS_DETECTORS: readonly ToolStatusDetector[] = Object.values(DETECTORS);

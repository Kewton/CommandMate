/**
 * Command Code status detector (Issue #2250, 方針書 §4 D2).
 *
 * Command Code renders inline and pins a claude-shaped composer block to the
 * bottom of the pane, so the shared chain does most of the work: the permission
 * dialog is a numbered list with a `❯` cursor, which step 1's `detectPrompt`
 * already reads, and the status row carries a spinner + `…` and `esc to
 * interrupt`, which step 2's `detectThinking` already reads.
 *
 * What this module adds is `afterThinking`, and it exists because the generic
 * composer check at step 3 would otherwise answer `ready` for a frame in which
 * the composer is drawn and a turn is still in flight. That is not hypothetical
 * on Command Code: the composer block stays on screen for the whole turn (see
 * `turn-thinking.txt`, where `❯ Ask your question...` sits three rows under
 * ` ⌘ Planning…  esc to interrupt`). Step 2's window is
 * `THINKING_TAIL_LINE_COUNT` = 5 lines, and the status row is 4 rows above the
 * last content row on that frame, so it fits today — but a wrapped composer adds
 * rows between them and pushes it out, which is exactly the #805 failure claude
 * had to add a wider footer window for. Re-checking thinking here, against the
 * 15-line `lastLines` window, is that wider window.
 *
 * No `readIdleEvidence`: per §4 D1 決定 1's tool-by-tool rollout (DR2-002) a rule
 * has to be read off the tool's OWN frames before it can gate anything, and the
 * five frames captured for this Issue cover launch / thinking / done / dialog /
 * tool-use rather than the awkward idle states (after a `/clear`, after an Esc
 * interrupt) a completion rule has to survive. `detection-evidence-config` ships
 * `legacy` to match.
 *
 * No `detectDialog` either: Epic #2249 決定 3 keeps Auto-Yes on the legacy
 * numbered-response path, because Command Code fires `PreToolUse` AFTER the
 * dialog is answered, so a hook-driven permission decision cannot dismiss it.
 */

import { detectThinking, getCliToolPatterns } from '../../cli-patterns';
import { STATUS_REASON } from '../../status-reason';
import { createToolStatusDetector } from '../run-detection';
import { COMMAND_CODE_VERIFIED_AGAINST } from '../verified-against';
import type { ToolStatusVerdict } from '../types';

/** Command Code build these rules were read off (value in ../verified-against). */
export const VERIFIED_AGAINST = COMMAND_CODE_VERIFIED_AGAINST;

export const commandCodeStatusDetector = createToolStatusDetector({
  tool: 'command-code',
  verifiedAgainst: VERIFIED_AGAINST,

  afterThinking(frame): ToolStatusVerdict | null {
    // The composer is drawn throughout a turn, so "running" has to be resolved
    // before the generic composer check can say "ready". Widened window; see the
    // module docblock.
    if (detectThinking('command-code', frame.lastLines)) {
      return {
        status: 'running',
        confidence: 'high',
        reason: STATUS_REASON.THINKING_INDICATOR,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    // Idle: the composer row is on screen and nothing is in flight. Same verdict
    // the generic step 3 would reach, resolved here so the two cannot disagree
    // about which window they read.
    const { promptPattern } = getCliToolPatterns('command-code');
    if (promptPattern.test(frame.lastLines)) {
      return {
        status: 'ready',
        confidence: 'high',
        reason: STATUS_REASON.INPUT_PROMPT,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }
    return null;
  },
});

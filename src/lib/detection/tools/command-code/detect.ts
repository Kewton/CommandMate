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
 *
 * `afterPrompt` arrived with Issue #2297, for the one screen the shared chain
 * genuinely could not read: the picker `/model` opens. It is a provider-grouped
 * list of model NAMES — no option numbers — over a `› Type to search models...`
 * row, closed by `type to search · ↑/↓ navigate · shift+↑/↓ jump provider ·
 * enter to select · esc to cancel`. None of `detectPrompt`, `detectThinking` or
 * the composer check matches any of that, so the frame reached the `default`
 * floor and the chat surface offered it the answer characters — into the search
 * box. Measured live on v1.40.1 at the production 200x1000 geometry; the capture
 * is `tests/fixtures/chat-dialog-card-2254/command-code-model-1-40-1.txt`.
 */

import { detectThinking, getCliToolPatterns } from '../../cli-patterns';
import { COMMAND_CODE_SELECTION_LIST_FOOTER } from '../../selection-shape';
import { STATUS_REASON } from '../../status-reason';
import { createToolStatusDetector } from '../run-detection';
import { COMMAND_CODE_VERIFIED_AGAINST } from '../verified-against';
import type { ToolStatusVerdict } from '../types';

/** Command Code build these rules were read off (value in ../verified-against). */
export const VERIFIED_AGAINST = COMMAND_CODE_VERIFIED_AGAINST;

export const commandCodeStatusDetector = createToolStatusDetector({
  tool: 'command-code',
  verifiedAgainst: VERIFIED_AGAINST,

  afterPrompt(frame): ToolStatusVerdict | null {
    // Issue #2297. Command Code's pickers (`/model` measured live on v1.40.1 at
    // 200x1000) are arrow-driven overlays with a search box and a lower-case
    // hint-bar footer. Nothing in the shared chain reads that footer, so before
    // this branch the frame fell through to the `default` floor — which the chat
    // surface renders as `unclassified`, i.e. with the `1`-`9` / `y` / `n`
    // answer keys, and every one of those characters is typed into the picker's
    // `Type to search models...` box rather than selecting anything.
    //
    // `waiting` + `positive`, exactly as claude's selection-list branch reports:
    // a human has to move the highlight and press enter, and the frame says so
    // in as many words.
    if (COMMAND_CODE_SELECTION_LIST_FOOTER.test(frame.lastLines)) {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }
    return null;
  },

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

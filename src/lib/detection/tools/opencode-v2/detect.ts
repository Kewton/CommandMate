/**
 * OpenCode V2 screen detector — the fallback reader (Issue #2934, Phase 1).
 *
 * OpenCode V2's state comes from its server's SSE stream
 * (`@/lib/hooks/sources/opencode-v2`); this module is what decides when that
 * stream is not there (a pane launched `--standalone`, a subscription that has
 * not reattached yet). Phase 1 reads two things only:
 *
 *  - the footer's `esc interrupt` hint → `running`;
 *  - the gutter-anchored empty composer (`┃  Ask anything…`) → `ready`;
 *  - otherwise the footer without that hint (`… 8.6K (1%)  ctrl+p commands`,
 *    the frame after a turn, whose composer is a bare gutter) → `ready`.
 *
 * The approval dialog (`△ Permission required` / `Allow once   Always allow
 * Reject` — the reverse word order of v1's `Allow always`), the completion row
 * and the session tabs are Phase 3's. v1's opencode detector is deliberately
 * not reused: its dialog rule keys on v1's wording and would misread v2.
 *
 * @module lib/detection/tools/opencode-v2/detect
 */

import {
  detectThinking,
  OPENCODE_V2_FOOTER_PATTERN,
  OPENCODE_V2_IDLE_COMPOSER_PATTERN,
  stripAnsi,
} from '../../cli-patterns';
import { STATUS_REASON } from '../../status-reason';
import { createToolStatusDetector } from '../run-detection';
import { OPENCODE_V2_VERIFIED_AGAINST } from '../verified-against';
import type { ToolStatusVerdict } from '../types';

export const VERIFIED_AGAINST = OPENCODE_V2_VERIFIED_AGAINST;

export const opencodeV2StatusDetector = createToolStatusDetector({
  tool: 'opencode-v2',
  verifiedAgainst: VERIFIED_AGAINST,

  afterThinking(frame): ToolStatusVerdict | null {
    if (detectThinking('opencode-v2', frame.lastLines)) {
      return {
        status: 'running',
        confidence: 'high',
        reason: STATUS_REASON.THINKING_INDICATOR,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    // The placeholder against the ANSI-stripped frame with its box drawing
    // intact (the pattern anchors on the `┃` gutter). The footer is on every
    // frame, and the running hint was ruled out just above.
    if (
      OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(stripAnsi(frame.raw)) ||
      OPENCODE_V2_FOOTER_PATTERN.test(frame.lastLines)
    ) {
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

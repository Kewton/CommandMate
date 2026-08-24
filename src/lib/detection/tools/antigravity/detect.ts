/**
 * Antigravity (agy) status detector (Issue #1927, 方針書 §4 D2).
 *
 * A verbatim lift of the `cliToolId === 'antigravity'` blocks (priorities 0.9
 * and 2.8) out of `detectSessionStatus`.
 *
 * No `readIdleEvidence`: agy's idle branch reads the same always-visible `> `
 * input box that #1885 showed is not evidence on its own, and this repository
 * holds no live agy capture to measure a better rule from. Per §4 D1 決定 1's
 * tool-by-tool rollout (DR2-002) a tool without a measured rule keeps the
 * pre-#1927 reading, and its rule must be read off ITS OWN frames rather than
 * inferred from another tool's — which is exactly the mistake #1979 corrected.
 */

import { detectThinking, getCliToolPatterns, ANTIGRAVITY_SELECTION_LIST_PATTERN } from '../../cli-patterns';
import { STATUS_REASON } from '../../status-reason';
import { createToolStatusDetector } from '../run-detection';
import { ANTIGRAVITY_VERIFIED_AGAINST } from '../verified-against';
import type { ToolStatusVerdict } from '../types';

/** agy build these rules were read off (Issue #988 / #995; value in ../verified-against, #1929). */
export const VERIFIED_AGAINST = ANTIGRAVITY_VERIFIED_AGAINST;

export const antigravityStatusDetector = createToolStatusDetector({
  tool: 'antigravity',
  verifiedAgainst: VERIFIED_AGAINST,

  beforePrompt(frame): ToolStatusVerdict | null {
    // 0.9. Antigravity: selection list detection BEFORE thinking detection (Issue #995)
    // agy's "Switch Model" (and other) selection TUIs render an "esc to cancel"
    // footer that ANTIGRAVITY_THINKING_PATTERN also matches, so the generic thinking
    // check (and the footer branch below) would otherwise misreport the selection
    // screen as "generating" and NavigationButtons would never be shown. Detecting the
    // selection list here — ahead of thinking — is the fix. Mirrors the Copilot /
    // Codex early-detection pattern.
    if (ANTIGRAVITY_SELECTION_LIST_PATTERN.test(frame.lastLines)) {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.ANTIGRAVITY_SELECTION_LIST,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }
    return null;
  },

  afterThinking(frame): ToolStatusVerdict | null {
    // 2.8. Antigravity (agy) footer-based detection (Issue #988)
    // agy renders inline (scrollback retained), with the status bar as the last
    // non-empty line and a bare "> " input box always visible just above it — even
    // while generating. So the always-visible "> " would make the generic composer
    // check report ready during generation. The footer is the source of
    // truth: "esc to cancel" + braille spinner / "Generating..." while running,
    // "? for shortcuts" when idle. Resolve running explicitly here first, then idle.
    if (detectThinking('antigravity', frame.lastLines)) {
      return {
        status: 'running',
        confidence: 'high',
        reason: STATUS_REASON.THINKING_INDICATOR,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }
    // Idle: bare "> " input prompt visible and the response has completed.
    const { promptPattern } = getCliToolPatterns('antigravity');
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

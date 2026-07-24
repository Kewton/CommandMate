/**
 * Issue #1497: a static, unclassified `/help` overlay must keep the
 * detection-independent nav hatch (#1017/#1494) gated open even after it
 * degrades to ready/no_recent_output — and a true idle prompt must NOT.
 *
 * This exercises the detector (detectSessionStatus) DIRECTLY against a real
 * Claude Code v2.1.218 `/help` capture (see fixture), complementing the
 * buildCurrentOutput integration test. It also pins the invariant the fix in
 * current-output-builder relies on: the `no_recent_output` fallback only fires
 * for a frame with no positive classification and no `❯` input line, so a real
 * idle prompt is classified as input_prompt BEFORE the time heuristic.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { buildClaudeHelpOverlayFrame } from '../fixtures/claude-help-overlay';

const HELP_FRAME = buildClaudeHelpOverlayFrame();
// Stamped by the Auto-Yes poller (auto-yes-poller.ts); older than the 5s
// STALE_OUTPUT_THRESHOLD_MS so the time-based heuristic fires.
const STALE_TS = new Date(Date.now() - 60_000);

describe('Issue #1497: real /help overlay classification (detectSessionStatus)', () => {
  it('with no lastOutputTimestamp: running/default (unclassified — hatch gate open)', () => {
    const st = detectSessionStatus(HELP_FRAME, 'claude');
    expect(st.status).toBe('running');
    expect(st.reason).toBe('default');
    expect(st.hasActivePrompt).toBe(false);
  });

  it('with a stale lastOutputTimestamp: degrades to ready/no_recent_output (the frame that hid the hatch)', () => {
    const st = detectSessionStatus(HELP_FRAME, 'claude', STALE_TS);
    expect(st.status).toBe('ready');
    expect(st.reason).toBe('no_recent_output');
    expect(st.hasActivePrompt).toBe(false);
  });

  it('the /help footer "Esc to cancel" is NOT misread as a selection list or a prompt', () => {
    // Neither a stale nor a fresh timestamp should ever turn /help into a
    // waiting/prompt frame — it has no numbered options and no selection footer.
    expect(detectSessionStatus(HELP_FRAME, 'claude').status).not.toBe('waiting');
    expect(detectSessionStatus(HELP_FRAME, 'claude', STALE_TS).status).not.toBe('waiting');
  });

  it('non-regression: a true idle input prompt is classified input_prompt BEFORE the time heuristic', () => {
    // The invariant the #1497 fix depends on: even with a stale timestamp, a
    // visible `❯` idle prompt stays ready/input_prompt (never no_recent_output),
    // so widening isUnclassifiedActive to no_recent_output cannot leak the hatch
    // to a real idle prompt.
    const idleFrame = 'Some earlier output\n────────────\n❯\n';
    const st = detectSessionStatus(idleFrame, 'claude', STALE_TS);
    expect(st.status).toBe('ready');
    expect(st.reason).toBe('input_prompt');
  });
});

/**
 * Issues #3021 / #3022: the frames the daily agent-health probe judged on
 * opencode 1.18.33.
 *
 * The probe failed `screen-running` and `screen-quoted-dialog` because every
 * turn ended in the model provider's error ("No models loaded") — the isolated
 * `XDG_STATE_HOME` of #2953 lost the user's model pick. Nothing in the TUI had
 * changed: with the model pick seeded back, the same build's running and
 * finished frames read exactly as the detector expects, and that is pinned
 * here together with the error frames.
 *
 * The error frames stay `unknown_frame` / `evidence: 'none'` on purpose: the
 * `▣ Build · <model>` row has no duration (the #1893 rule — an open or aborted
 * step is not a completion), there is no `esc interrupt` footer and no idle
 * composer placeholder. Design rule D1 declares nothing without positive
 * evidence.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';

const DIR = fileURLToPath(new URL('../../../../fixtures/opencode-agent-health-3021/', import.meta.url));

function verdict(name: string) {
  const result = detectSessionStatus(readFileSync(`${DIR}${name}.txt`, 'utf8'), 'opencode');
  return {
    status: result.status,
    reason: result.reason,
    hasActivePrompt: result.hasActivePrompt,
    evidence: result.evidence,
  };
}

describe('[#3021] opencode 1.18.33 running turn', () => {
  it.each(['running-turn-submitted', 'running-turn-sleep'])('%s is running on positive evidence', (name) => {
    expect(verdict(name)).toEqual({
      status: 'running',
      reason: STATUS_REASON.OPENCODE_PROCESSING_INDICATOR,
      hasActivePrompt: false,
      evidence: 'positive',
    });
  });

  it('the fixtures are raw captures (SGR kept)', () => {
    expect(readFileSync(`${DIR}running-turn-sleep.txt`, 'utf8')).toContain('\u001b[');
  });
});

describe('[#3022] opencode 1.18.33 reply quoting the permission dialog', () => {
  it('is a finished turn, not a pending decision', () => {
    expect(verdict('quoted-dialog-reply-done')).toEqual({
      status: 'ready',
      reason: STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
      hasActivePrompt: false,
      evidence: 'positive',
    });
  });
});

describe('[#3021/#3022] a turn the model provider answered with an error', () => {
  it.each(['model-error-running-turn', 'model-error-quoted-turn'])(
    '%s carries no positive evidence (the frames the daily run failed on)',
    (name) => {
      expect(verdict(name)).toEqual({
        status: 'running',
        reason: STATUS_REASON.UNKNOWN_FRAME,
        hasActivePrompt: false,
        evidence: 'none',
      });
    }
  );
});

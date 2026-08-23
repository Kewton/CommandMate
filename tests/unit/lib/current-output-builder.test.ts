/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { getLastServerResponseTimestamp } from '@/lib/polling/auto-yes-manager';
import {
  recordPolicySuppression,
  clearPolicySuppressions,
} from '@/lib/polling/auto-yes-suppression-state';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { IDLE_EVIDENCE_ENV_VAR } from '@/config/detection-evidence-config';
import { buildClaudeIdleComposerFrame } from '../../fixtures/claude-idle-composer';
import { buildClaudeHelpOverlayFrame } from '../../fixtures/claude-help-overlay';

describe('buildCurrentOutput Issue #1167 frame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
  });

  it('surfaces prompt data and never exposes the unclassified fallback', async () => {
    const payload = await buildCurrentOutput(
      {} as Database.Database,
      'wt-1',
      'claude',
      'claude-2',
    );

    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData?.type).toBe('multiple_choice');
    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe('prompt_detected');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});

describe('buildCurrentOutput Issue #1684 policy suppression visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPolicySuppressions();
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
  });

  it('publishes the last policy suppression for the requested instance', async () => {
    recordPolicySuppression(
      'wt-1',
      'claude',
      'claude-2',
      { reason: 'type-not-allowed', mode: 'safe', promptType: 'multiple_choice' },
      1_000
    );

    const payload = await buildCurrentOutput({} as Database.Database, 'wt-1', 'claude', 'claude-2');

    expect(payload.autoYes?.lastSuppression).toEqual({
      reason: 'type-not-allowed',
      mode: 'safe',
      promptType: 'multiple_choice',
      at: 1_000,
    });
  });

  it('publishes null when the policy never withheld an answer', async () => {
    const payload = await buildCurrentOutput({} as Database.Database, 'wt-1', 'claude', 'claude-2');

    expect(payload.autoYes?.lastSuppression).toBeNull();
  });

  it("does not leak another instance's suppression", async () => {
    recordPolicySuppression(
      'wt-1',
      'claude',
      'claude-3',
      { reason: 'type-not-allowed', mode: 'safe', promptType: 'multiple_choice' },
      1_000
    );

    const payload = await buildCurrentOutput({} as Database.Database, 'wt-1', 'claude', 'claude-2');

    expect(payload.autoYes?.lastSuppression).toBeNull();
  });
});

describe('buildCurrentOutput Issue #1497 no_recent_output degrade', () => {
  // The stale timestamp is the value the Auto-Yes poller stamps into
  // lastServerResponseTimestamp (auto-yes-poller.ts). Older than
  // STALE_OUTPUT_THRESHOLD_MS (5s) so the time-based heuristic fires.
  const staleTimestamp = Date.now() - 60_000;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[IDLE_EVIDENCE_ENV_VAR];
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(staleTimestamp);
  });

  afterEach(() => {
    delete process.env[IDLE_EVIDENCE_ENV_VAR];
  });

  it('keeps the nav hatch gated open for a static /help overlay that stopped changing', async () => {
    // A real unclassified TUI overlay that stopped changing: detection falls
    // through to the time heuristic — the frame that used to hide the nav hatch
    // (#1017).
    //
    // Issue #1927 (§4 D1 決定 3) changed the wire status this publishes from
    // `ready` to `running`: five seconds without a repaint is the absence of a
    // completion, not one. The reason code and — the point of #1497 — the open
    // hatch are unchanged.
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaudeHelpOverlayFrame());

    const payload = await buildCurrentOutput(
      {} as Database.Database,
      'wt-1',
      'claude',
      'claude-2',
    );

    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe('no_recent_output');
    // The fix: the timed-out unclassified frame still gates the hatch open.
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('does NOT gate the hatch open at a true idle input prompt even with a stale timestamp (non-regression)', async () => {
    // A genuine idle prompt is classified as input_prompt before the time
    // heuristic — so it must stay ready/input_prompt and the hatch must remain
    // hidden (Enter/`q` can never reach the composer).
    //
    // Issue #1927 made the frame here a realistic one. The old three-character
    // `───` rule was not an input box Claude ever draws, and the bare `❯` it
    // fenced is drawn during generation too — which is precisely the evidence
    // §4 D1 stopped accepting. What keeps the hatch shut now is Claude's
    // measured completion marker, which the builder below includes.
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaudeIdleComposerFrame());

    const payload = await buildCurrentOutput(
      {} as Database.Database,
      'wt-1',
      'claude',
      'claude-2',
    );

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('input_prompt');
    expect(payload.statusEvidence).toBe('positive');
    expect(payload.isUnclassifiedActive).toBe(false);
  });

  it('drops the evidence but NOT the classification when no completion marker is on the frame', async () => {
    // The other half of the rollout, and the reason the assertion above is not
    // vacuous: the SAME frame with its completion marker reworded still reads
    // `ready`/`input_prompt` on the wire (DR3-002 — nothing downstream has to
    // learn a new status), and now says so with no evidence.
    //
    // Issue #2011: what that must NOT do is open the hatch. `evidence: 'none'`
    // here means "no rule vouched that this pane is idle"; the frame itself was
    // read perfectly well, and the composer row it was read from is one a human
    // can type into. Gating the nav hatch and `wait`'s completion rule on this
    // is what stalled every idle Claude pane on develop.
    //
    // The rule is asked for explicitly because #2011 put claude back to
    // `observe` — see the rollout suite. Under the shipped default this frame
    // publishes `'positive'`, and the flag is `false` either way, which is the
    // separation being pinned.
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=enforce';
    vi.mocked(captureSessionOutput).mockResolvedValue(
      buildClaudeIdleComposerFrame('  it wrote some prose and stopped'),
    );

    const payload = await buildCurrentOutput(
      {} as Database.Database,
      'wt-1',
      'claude',
      'claude-2',
    );

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('input_prompt');
    expect(payload.statusEvidence).toBe('none');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});

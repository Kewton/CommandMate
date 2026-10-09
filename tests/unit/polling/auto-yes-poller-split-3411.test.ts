/**
 * Issue #3411: the parts moved out of `src/lib/auto-yes-poller.ts`, tested from
 * their new modules directly (not through the poller).
 *
 * - `src/lib/polling/auto-yes-poller-state.ts`: `AutoYesPollerState`,
 *   `promptFrameKey`, `warnOncePerFrame`
 * - `src/lib/polling/auto-yes-prompt-suppression.ts`: `suppressAndWarnOnce`,
 *   `suppressIfNotOursToAnswer`, `suppressUnclassifiedFrame`
 *
 * Positive control: before the split these modules did not exist, so every
 * import below fails. Negative control: the moved functions behave as the
 * poller's copies did (WARN once per frame, the same records and verdicts).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
const debug = vi.fn();

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const self: Record<string, unknown> = {
      debug: (...args: unknown[]) => debug(...args),
      info: vi.fn(),
      warn: (...args: unknown[]) => warn(...args),
      error: vi.fn(),
    };
    self.withContext = () => self;
    return self;
  },
}));

const getCodexLifecycleDialog = vi.fn();
vi.mock('@/lib/detection/cli-patterns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/cli-patterns')>()),
  getCodexLifecycleDialog: (...args: unknown[]) => getCodexLifecycleDialog(...args),
}));

const isCodexModelPickerFrame = vi.fn();
vi.mock('@/lib/detection/tools/codex/detect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/tools/codex/detect')>()),
  isCodexModelPickerFrame: (...args: unknown[]) => isCodexModelPickerFrame(...args),
}));

const evaluateAutoYesDialogGate = vi.fn();
vi.mock('@/lib/polling/auto-yes-dialog-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/auto-yes-dialog-gate')>()),
  evaluateAutoYesDialogGate: (...args: unknown[]) => evaluateAutoYesDialogGate(...args),
}));

import {
  promptFrameKey,
  warnOncePerFrame,
  type AutoYesPollerState,
} from '@/lib/polling/auto-yes-poller-state';
import {
  suppressAndWarnOnce,
  suppressIfNotOursToAnswer,
  suppressUnclassifiedFrame,
  type JudgedPrompt,
} from '@/lib/polling/auto-yes-prompt-suppression';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import type { AutoYesDialogGateVerdict } from '@/lib/polling/auto-yes-dialog-gate';
import type { NormalizedFrame } from '@/lib/detection/tools/types';
import type { PromptData } from '@/types/models';

const ROOT = path.resolve(__dirname, '../../..');

function newState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'codex',
    instanceId: 'codex',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: 0,
  };
}

const PROMPT: PromptData = {
  type: 'multiple_choice',
  question: 'Pick one',
  options: [
    { number: 1, label: 'Yes', isDefault: true },
    { number: 2, label: 'No', isDefault: false },
  ],
  status: 'pending',
} as PromptData;

function judged(overrides: Partial<JudgedPrompt> = {}): JudgedPrompt {
  return {
    worktreeId: 'wt-3411',
    cliToolId: 'codex',
    instanceId: undefined,
    compositeKey: 'wt-3411:codex',
    pollerState: newState(),
    promptData: PROMPT,
    promptKey: 'k',
    frameKey: promptFrameKey(PROMPT),
    ...overrides,
  };
}

const FRAME = {} as NormalizedFrame;

beforeEach(() => {
  warn.mockReset();
  debug.mockReset();
  getCodexLifecycleDialog.mockReset().mockReturnValue(null);
  isCodexModelPickerFrame.mockReset().mockReturnValue(false);
  evaluateAutoYesDialogGate.mockReset().mockReturnValue({ allowed: true, dialog: null, mode: 'legacy', gated: false });
  clearPolicySuppressions();
});

afterEach(() => {
  clearPolicySuppressions();
});

describe('auto-yes-poller-state (Issue #3411)', () => {
  it('promptFrameKey separates prompts by their option rows and cursor', () => {
    const moved: PromptData = {
      ...PROMPT,
      options: [
        { number: 1, label: 'Yes', isDefault: false },
        { number: 2, label: 'No', isDefault: true },
      ],
    } as PromptData;
    expect(promptFrameKey(PROMPT)).toBe(promptFrameKey({ ...PROMPT } as PromptData));
    expect(promptFrameKey(moved)).not.toBe(promptFrameKey(PROMPT));
  });

  it('warnOncePerFrame warns once per frame, then drops repeats to debug', () => {
    const state = newState();
    warnOncePerFrame(state, 'f1', 'ev', { a: 1 });
    warnOncePerFrame(state, 'f1', 'ev', { a: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('ev', { a: 1 });
    expect(debug).toHaveBeenCalledWith('ev', { a: 1, repeated: true });

    warnOncePerFrame(state, 'f2', 'ev', { a: 2 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(state.lastSkipWarnKey).toBe('ev\u0000f2');
  });
});

describe('auto-yes-prompt-suppression (Issue #3411)', () => {
  it('suppressAndWarnOnce records the suppression and WARNs once with the ids first', () => {
    const prompt = judged();
    suppressAndWarnOnce(prompt, { reason: 'unclassified-frame', mode: null, promptType: 'multiple_choice' }, 'fk', 'ev', { x: 1 });
    suppressAndWarnOnce(prompt, { reason: 'unclassified-frame', mode: null, promptType: 'multiple_choice' }, 'fk', 'ev', { x: 1 });
    expect(getLastPolicySuppression('wt-3411', 'codex')).toMatchObject({ reason: 'unclassified-frame', mode: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('ev', { worktreeId: 'wt-3411', cliToolId: 'codex', instanceId: undefined, x: 1 });
  });

  it('suppressIfNotOursToAnswer leaves codex launch dialogs alone', () => {
    getCodexLifecycleDialog.mockReturnValue('update');
    expect(suppressIfNotOursToAnswer(judged(), FRAME)).toEqual({ kind: 'left-alone' });
    expect(getLastPolicySuppression('wt-3411', 'codex')?.reason).toBe('agent-launch-dialog');
    expect(warn.mock.calls[0][0]).toBe('poller:auto-yes-skipped-launch-dialog');
    expect(evaluateAutoYesDialogGate).not.toHaveBeenCalled();
  });

  it('suppressIfNotOursToAnswer leaves the codex /model picker alone', () => {
    isCodexModelPickerFrame.mockReturnValue(true);
    expect(suppressIfNotOursToAnswer(judged(), FRAME)).toEqual({ kind: 'left-alone' });
    expect(warn.mock.calls[0][0]).toBe('poller:auto-yes-skipped-model-picker');
  });

  it('suppressIfNotOursToAnswer hands a gate refusal back without recording it', () => {
    const verdict: AutoYesDialogGateVerdict = { allowed: false, dialog: null, mode: 'enforce', gated: true } as AutoYesDialogGateVerdict;
    evaluateAutoYesDialogGate.mockReturnValue(verdict);
    expect(suppressIfNotOursToAnswer(judged(), FRAME)).toEqual({ kind: 'dialog-gate-refused', dialogGate: verdict });
    expect(getLastPolicySuppression('wt-3411', 'codex')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('suppressIfNotOursToAnswer answers a frame nothing refuses', () => {
    expect(suppressIfNotOursToAnswer(judged({ cliToolId: 'claude', compositeKey: 'wt-3411:claude' }), FRAME)).toEqual({ kind: 'ours' });
    expect(getCodexLifecycleDialog).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('suppressUnclassifiedFrame records unclassified-frame with the gate fields', () => {
    const verdict = { allowed: false, dialog: null, mode: 'enforce', gated: true } as AutoYesDialogGateVerdict;
    suppressUnclassifiedFrame(judged(), verdict);
    expect(getLastPolicySuppression('wt-3411', 'codex')?.reason).toBe('unclassified-frame');
    expect(warn).toHaveBeenCalledWith('poller:auto-yes-skipped-unclassified-frame', {
      worktreeId: 'wt-3411',
      cliToolId: 'codex',
      instanceId: undefined,
      promptType: 'multiple_choice',
      dialogKind: null,
      answerMode: null,
      gateMode: 'enforce',
    });
  });
});

describe('split constraints (Issue #3411)', () => {
  it.each(['src/lib/polling/auto-yes-poller-state.ts', 'src/lib/polling/auto-yes-prompt-suppression.ts'])(
    '%s imports neither the poller (cycle) nor tmux (allowlist)',
    (rel) => {
      const text = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(text).not.toMatch(/from '[^']*auto-yes-poller'/);
      expect(text).not.toMatch(/from '[^']*tmux\/tmux'/);
    },
  );
});

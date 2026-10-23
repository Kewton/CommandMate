/**
 * Issue #3822: the prompt observation tells the base rules' withholding from
 * the contract's.
 *
 * `allow-once-unidentified` (a permission dialog with no single "allow this
 * call once" row) is returned by the resolver before the contract is read.
 * `autoYes.contractEvaluation` published it as `policy-withholds` — a contract
 * verdict — even with no contract at all. It is `base-withholds` now, with or
 * without a contract; a contract's own verdict stays `policy-withholds` (the
 * controls).
 *
 * The options are agy's live `Run this command?` rows
 * (`strict-respond-3812/permission-run-command.txt`), with and without its
 * allow-once row.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildPromptObservation, type ObservationInput, type ObservationPayload } from '@/lib/prompt-observation/observe';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import type { PromptData } from '@/types/models';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const PERMISSION = readFileSync(path.join(FIXTURES, 'antigravity-live-2364/dialog-bash-oneline.txt'), 'utf8');
const NOW = 1_800_000_000_000;

/** agy's live rows (strict-respond-3812/permission-run-command.txt). */
const ONCE = 'Yes, run command';
const IN_CONVERSATION = "Yes, and always allow in this conversation for commands that start with 'pwd'";
const PERSISTED = "Yes, and always allow for commands that start with 'pwd' (Persist to settings.json)";
const DENY = 'No, cancel';

function prompt(labels: string[]): PromptData {
  return {
    type: 'multiple_choice',
    question: 'Run this command?',
    options: labels.map((label, index) => ({ number: index + 1, label, isDefault: index === 0 })),
    status: 'pending',
  };
}

function payload(promptData: PromptData): ObservationPayload {
  return {
    isRunning: true,
    sessionName: 'mcbd-antigravity-wt-1',
    sessionStatus: 'waiting',
    sessionStatusReason: STATUS_REASON.PROMPT_DETECTED,
    fullOutput: PERMISSION,
    isPromptWaiting: true,
    promptData,
    promptView: null,
    isSelectionListActive: false,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    startingSince: null,
    autoYes: { enabled: true, expiresAt: null, lastSuppression: null, lastEnterFallback: null },
    serverPollerActive: true,
  };
}

function observe(promptData: PromptData, policy: AutoYesPolicy | null) {
  const input: ObservationInput = {
    worktreeId: 'wt-1',
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    resolvedBy: 'explicit',
    payload: payload(promptData),
    sessionGeneration: NOW - 60_000,
    contract: { policy, taskId: policy ? 'task-1' : null },
    appearance: { note: () => NOW - 5_000, forget: () => {} },
    now: NOW,
  };
  return buildPromptObservation(input).autoYes.contractEvaluation;
}

const NO_ALLOW_ONCE = prompt([IN_CONVERSATION, PERSISTED, DENY]);
const LIVE = prompt([ONCE, IN_CONVERSATION, PERSISTED, DENY]);
const OFF: AutoYesPolicy = { mode: 'off', allowPromptTypes: [], denyPatterns: [] };
const DENY_PWD: AutoYesPolicy = { mode: null, allowPromptTypes: [], denyPatterns: ['pwd'] };

describe('[#3822] the base rules withholding is not a contract verdict', () => {
  it('no contract: base-withholds, not policy-withholds', () => {
    expect(observe(NO_ALLOW_ONCE, null)).toEqual({
      state: 'base-withholds',
      reason: 'allow-once-unidentified',
      contract: null,
    });
  });

  it("with a contract (mode: 'off'): still base-withholds — the contract is not what stopped it", () => {
    expect(observe(NO_ALLOW_ONCE, OFF)).toEqual({
      state: 'base-withholds',
      reason: 'allow-once-unidentified',
      contract: { taskId: 'task-1', mode: 'off' },
    });
  });

  it('control (no contract): the live dialog with its allow-once row is policy-permits', () => {
    expect(observe(LIVE, null)).toEqual({ state: 'policy-permits', contract: null });
  });

  it("control: the contract's own verdicts stay policy-withholds", () => {
    expect(observe(LIVE, OFF)).toEqual({
      state: 'policy-withholds',
      reason: 'mode-off',
      contract: { taskId: 'task-1', mode: 'off' },
    });
    expect(observe(LIVE, DENY_PWD)).toEqual({
      state: 'policy-withholds',
      reason: 'deny-pattern',
      pattern: 'pwd',
      contract: { taskId: 'task-1', mode: null },
    });
  });
});

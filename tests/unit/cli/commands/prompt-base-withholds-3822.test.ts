/**
 * Issue #3822: `commandmate prompt` (without `--json`) prints the reason of a
 * `base-withholds` re-evaluation.
 *
 * `allow-once-unidentified` (a permission dialog with no single "allow this
 * call once" row) is reported as `base-withholds` with a reason. The human
 * lines printed the reason for `policy-withholds` only, so `prompt` showed a
 * bare `base-withholds` and the reason survived in `--json` and in `wait`'s
 * observation only. The observation here is built by the server's
 * `buildPromptObservation` with no poller record, as on a dialog that was
 * already open when Auto-Yes was turned on.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';
import { buildPromptObservation, type ObservationPayload } from '@/lib/prompt-observation/observe';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import type { PromptObservation } from '@/lib/prompt-observation/types';
import type { PromptData } from '@/types/models';
import { createPromptCommand, formatPromptObservation } from '../../../../src/cli/commands/prompt';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
});

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

function observe(promptData: PromptData, policy: AutoYesPolicy | null): PromptObservation {
  return buildPromptObservation({
    worktreeId: 'wt-1',
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    resolvedBy: 'explicit',
    payload: payload(promptData),
    sessionGeneration: NOW - 60_000,
    contract: { policy, taskId: policy ? 'task-1' : null },
    appearance: { note: () => NOW - 5_000, forget: () => {} },
    now: NOW,
  });
}

const NO_ALLOW_ONCE = prompt([IN_CONVERSATION, PERSISTED, DENY]);
const LIVE = prompt([ONCE, IN_CONVERSATION, PERSISTED, DENY]);
const DENY_PWD: AutoYesPolicy = { mode: null, allowPromptTypes: [], denyPatterns: ['pwd'] };

function frame(promptObservation: PromptObservation): Record<string, unknown> {
  return {
    isRunning: true,
    isPromptWaiting: true,
    content: '',
    fullOutput: '',
    realtimeSnippet: '',
    lineCount: 1,
    lastCapturedLine: 1,
    promptData: null,
    thinking: false,
    cliToolId: 'antigravity',
    sessionStatus: 'waiting',
    sessionStatusReason: STATUS_REASON.PROMPT_DETECTED,
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: true,
    promptObservation,
  };
}

describe('[#3822] prompt prints the reason of base-withholds', () => {
  it('the observation has no poller record and a base-withholds evaluation (precondition)', () => {
    const observation = observe(NO_ALLOW_ONCE, null);
    expect(observation.autoYes.pollerRecord).toBeNull();
    expect(observation.autoYes.contractEvaluation).toEqual({
      state: 'base-withholds',
      reason: 'allow-once-unidentified',
      contract: null,
    });
  });

  it('formatPromptObservation names the reason', () => {
    const text = formatPromptObservation(observe(NO_ALLOW_ONCE, null), NOW);
    expect(text).toContain('a missing record does not mean Auto-Yes can answer');
    expect(text).toContain('contract re-evaluation: base-withholds reason=allow-once-unidentified (no contract)');
  });

  it('commandmate prompt (no --json) prints the reason, exit 0', async () => {
    mockFetchSequence([{ data: frame(observe(NO_ALLOW_ONCE, null)) }]);
    await createPromptCommand().parseAsync(['node', 'prompt', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(String(mockConsoleLog.mock.calls[0][0])).toContain(
      'contract re-evaluation: base-withholds reason=allow-once-unidentified (no contract)',
    );
  });

  it('control: a policy-withholds line is unchanged', () => {
    expect(formatPromptObservation(observe(LIVE, DENY_PWD), NOW)).toContain(
      'contract re-evaluation: policy-withholds reason=deny-pattern pattern="pwd" (task task-1, mode=none)',
    );
  });

  it('control: policy-permits prints the state alone', () => {
    const text = formatPromptObservation(observe(LIVE, null), NOW);
    expect(text).toContain('contract re-evaluation: policy-permits (no contract)');
    expect(text).not.toContain('reason=');
  });
});

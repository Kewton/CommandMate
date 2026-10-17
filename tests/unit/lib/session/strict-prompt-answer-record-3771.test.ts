/**
 * Issue #3771 (item 3): a strict answer cut short after a key was sent leaves
 * a `prompt_answered_human` row, and the row carries `answeredBy` and `option`
 * as their own payload fields next to the reason text.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { StrictRespondResult } from '@/lib/prompt-observation/types';

const applyEventToActiveTask = vi.fn();
vi.mock('@/lib/tasks/task-transition-service', () => ({
  applyEventToActiveTask: (...args: unknown[]) => applyEventToActiveTask(...args),
}));

import { recordStrictAnswer, type StrictAnswerTarget } from '@/lib/session/strict-prompt-answer-io';

const db = {} as Database.Database;
const target: StrictAnswerTarget = {
  worktreeId: 'wt-1',
  cliToolId: 'antigravity',
  instanceId: undefined,
  sessionName: 'mcbd-antigravity-wt-1',
  resolvedBy: null,
};

function resultWith(overrides: Partial<StrictRespondResult>): StrictRespondResult {
  return {
    strictRespond: 1,
    code: 0,
    delivery: 'delivered',
    reason: null,
    message: '',
    expectedKind: 'trust',
    observedKind: 'trust',
    expectedTarget: null,
    observedTarget: '/repo',
    operationId: 'op-1',
    answer: { position: 1, label: 'Yes, I trust this folder' },
    keysSent: 1,
    outcome: 'resolved',
    replayed: false,
    ...overrides,
  } as StrictRespondResult;
}

describe('[#3771] recordStrictAnswer', () => {
  beforeEach(() => {
    applyEventToActiveTask.mockReset();
  });

  it('records answeredBy and option as payload fields with the reason text', () => {
    recordStrictAnswer(db, target, resultWith({}), 'cli');
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
    const [, , , instanceId, event, payload] = applyEventToActiveTask.mock.calls[0];
    expect(instanceId).toBe('antigravity');
    expect(event).toBe('prompt_answered_human');
    expect(payload).toMatchObject({
      promptType: 'trust',
      answeredBy: 'cli',
      option: '1. Yes, I trust this folder',
    });
    expect(payload.reason).toContain('strict respond by cli');
  });

  it('records a 41 cut short after a key was sent', () => {
    recordStrictAnswer(
      db,
      target,
      resultWith({ code: 41, delivery: 'indeterminate', reason: 'outcome_indeterminate', keysSent: 1, outcome: null }),
      'agent:wt-2/claude'
    );
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
    const payload = applyEventToActiveTask.mock.calls[0][5];
    expect(payload).toMatchObject({ answeredBy: 'agent:wt-2/claude' });
    expect(payload.reason).toContain('stopped: outcome_indeterminate, 1 key(s) sent');
  });

  it('leaves out option when no option was resolved', () => {
    recordStrictAnswer(db, target, resultWith({ code: 41, reason: 'outcome_indeterminate', answer: null }), 'cli');
    expect(applyEventToActiveTask.mock.calls[0][5]).not.toHaveProperty('option');
  });

  it('negative control: no row when no key was sent, or for a refusal', () => {
    recordStrictAnswer(db, target, resultWith({ code: 41, reason: 'operation_in_progress', keysSent: 0 }), 'cli');
    recordStrictAnswer(db, target, resultWith({ code: 40, reason: 'kind_mismatch', keysSent: 0 }), 'cli');
    expect(applyEventToActiveTask).not.toHaveBeenCalled();
  });
});

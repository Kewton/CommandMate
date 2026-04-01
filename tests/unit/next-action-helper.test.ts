/**
 * Unit tests for next-action-helper
 * Issue #600: UX refresh - getNextAction() and getReviewStatus()
 */

import { describe, it, expect } from 'vitest';
import {
  getNextAction,
  getReviewStatus,
  type ReviewStatus,
} from '@/lib/session/next-action-helper';
import type { SessionStatus } from '@/lib/detection/status-detector';
import type { PromptType } from '@/types/models';

describe('getNextAction()', () => {
  it('should return "Start" when status is null', () => {
    expect(getNextAction(null, null, false)).toBe('Start');
  });

  it('should return "Start" when status is idle', () => {
    expect(getNextAction('idle', null, false)).toBe('Start');
  });

  it('should return "Send message" when status is ready', () => {
    expect(getNextAction('ready', null, false)).toBe('Send message');
  });

  it('should return "Approve / Reject" when waiting with approval prompt', () => {
    expect(getNextAction('waiting', 'approval', false)).toBe('Approve / Reject');
  });

  it('should return "Reply to prompt" when waiting with non-approval prompt', () => {
    const nonApprovalTypes: PromptType[] = ['yes_no', 'multiple_choice', 'choice', 'input', 'continue'];
    for (const type of nonApprovalTypes) {
      expect(getNextAction('waiting', type, false)).toBe('Reply to prompt');
    }
  });

  it('should return "Reply to prompt" when waiting with null prompt type', () => {
    expect(getNextAction('waiting', null, false)).toBe('Reply to prompt');
  });

  it('should return "Check stalled" when running and stalled', () => {
    expect(getNextAction('running', null, true)).toBe('Check stalled');
  });

  it('should return "Running..." when running and not stalled', () => {
    expect(getNextAction('running', null, false)).toBe('Running...');
  });

  it('should handle all SessionStatus values exhaustively', () => {
    const allStatuses: SessionStatus[] = ['idle', 'ready', 'running', 'waiting'];
    for (const status of allStatuses) {
      // Should not throw for any known status
      expect(() => getNextAction(status, null, false)).not.toThrow();
    }
  });

  it('should prioritize approval over stalled when waiting', () => {
    // Even if isStalled is true, waiting+approval should show "Approve / Reject"
    expect(getNextAction('waiting', 'approval', true)).toBe('Approve / Reject');
  });

  it('should ignore stalled flag for idle status', () => {
    expect(getNextAction('idle', null, true)).toBe('Start');
  });

  it('should ignore stalled flag for ready status', () => {
    expect(getNextAction('ready', null, true)).toBe('Send message');
  });
});

describe('getReviewStatus()', () => {
  it('should return "done" when worktreeStatus is done', () => {
    expect(getReviewStatus('done', null, null, false)).toBe('done');
  });

  it('should return "done" regardless of session status when worktreeStatus is done', () => {
    expect(getReviewStatus('done', 'running', 'approval', true)).toBe('done');
  });

  it('should return "approval" when session is waiting with approval prompt', () => {
    expect(getReviewStatus('doing', 'waiting', 'approval', false)).toBe('approval');
  });

  it('should return "approval" when worktreeStatus is null and session waiting with approval', () => {
    expect(getReviewStatus(null, 'waiting', 'approval', false)).toBe('approval');
  });

  it('should return "stalled" when session is running and stalled', () => {
    expect(getReviewStatus('doing', 'running', null, true)).toBe('stalled');
  });

  it('should return "stalled" when worktreeStatus is null and running+stalled', () => {
    expect(getReviewStatus(null, 'running', null, true)).toBe('stalled');
  });

  it('should return null when no review condition is met', () => {
    expect(getReviewStatus('todo', 'running', null, false)).toBeNull();
    expect(getReviewStatus('doing', 'ready', null, false)).toBeNull();
    expect(getReviewStatus(null, 'idle', null, false)).toBeNull();
    expect(getReviewStatus(null, null, null, false)).toBeNull();
  });

  it('should return null when waiting but not approval prompt', () => {
    expect(getReviewStatus('doing', 'waiting', 'yes_no', false)).toBeNull();
    expect(getReviewStatus('doing', 'waiting', 'multiple_choice', false)).toBeNull();
  });

  it('should prioritize done over approval', () => {
    expect(getReviewStatus('done', 'waiting', 'approval', false)).toBe('done');
  });

  it('should prioritize done over stalled', () => {
    expect(getReviewStatus('done', 'running', null, true)).toBe('done');
  });

  it('should prioritize approval over stalled when both conditions met', () => {
    // waiting + approval + stalled: approval wins
    expect(getReviewStatus('doing', 'waiting', 'approval', true)).toBe('approval');
  });

  it('should handle all worktreeStatus values', () => {
    const statuses: Array<'todo' | 'doing' | 'done' | null> = ['todo', 'doing', 'done', null];
    for (const ws of statuses) {
      // Should not throw
      const result = getReviewStatus(ws, 'idle', null, false);
      if (ws === 'done') {
        expect(result).toBe('done');
      } else {
        expect(result).toBeNull();
      }
    }
  });
});

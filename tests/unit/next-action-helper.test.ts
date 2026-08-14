/**
 * Unit tests for next-action-helper
 * Issue #600: UX refresh - getNextAction() and getReviewStatus()
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  getNextAction,
  getReviewStatus,
  isNextActionKey,
  NEXT_ACTION_KEYS,
  type ReviewStatus,
} from '@/lib/session/next-action-helper';
import type { SessionStatus } from '@/lib/detection/status-detector';
import type { PromptType } from '@/types/models';

describe('getNextAction()', () => {
  it('should return the start key when status is null', () => {
    expect(getNextAction(null, null, false)).toBe(NEXT_ACTION_KEYS.start);
  });

  it('should return the start key when status is idle', () => {
    expect(getNextAction('idle', null, false)).toBe(NEXT_ACTION_KEYS.start);
  });

  it('should return the sendMessage key when status is ready', () => {
    expect(getNextAction('ready', null, false)).toBe(NEXT_ACTION_KEYS.sendMessage);
  });

  it('should return the approveReject key when waiting with approval prompt', () => {
    expect(getNextAction('waiting', 'approval', false)).toBe(NEXT_ACTION_KEYS.approveReject);
  });

  it('should return "Reply to prompt" when waiting with non-approval prompt', () => {
    const nonApprovalTypes: PromptType[] = ['yes_no', 'multiple_choice', 'choice', 'input', 'continue'];
    for (const type of nonApprovalTypes) {
      expect(getNextAction('waiting', type, false)).toBe(NEXT_ACTION_KEYS.replyToPrompt);
    }
  });

  it('should return the replyToPrompt key when waiting with null prompt type', () => {
    expect(getNextAction('waiting', null, false)).toBe(NEXT_ACTION_KEYS.replyToPrompt);
  });

  it('should return the checkStalled key when running and stalled', () => {
    expect(getNextAction('running', null, true)).toBe(NEXT_ACTION_KEYS.checkStalled);
  });

  it('should return the running key when running and not stalled', () => {
    expect(getNextAction('running', null, false)).toBe(NEXT_ACTION_KEYS.running);
  });

  it('should handle all SessionStatus values exhaustively', () => {
    const allStatuses: SessionStatus[] = ['idle', 'ready', 'running', 'waiting'];
    for (const status of allStatuses) {
      // Should not throw for any known status
      expect(() => getNextAction(status, null, false)).not.toThrow();
    }
  });

  it('should prioritize approval over stalled when waiting', () => {
    // Even if isStalled is true, waiting+approval should show approve/reject
    expect(getNextAction('waiting', 'approval', true)).toBe(NEXT_ACTION_KEYS.approveReject);
  });

  it('should ignore stalled flag for idle status', () => {
    expect(getNextAction('idle', null, true)).toBe(NEXT_ACTION_KEYS.start);
  });

  it('should ignore stalled flag for ready status', () => {
    expect(getNextAction('ready', null, true)).toBe(NEXT_ACTION_KEYS.sendMessage);
  });
});

// ============================================================================
// Issue #1787: keys, not English literals
// ============================================================================

describe('getNextAction() i18n keys (Issue #1787)', () => {
  const LOCALES_DIR = path.resolve(__dirname, '../../locales');

  function loadWorktreeDictionary(locale: string): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8')
    ) as Record<string, unknown>;
  }

  it('never returns a bare English sentence', () => {
    const inputs: Array<[SessionStatus | null, PromptType | null, boolean]> = [
      [null, null, false],
      ['idle', null, false],
      ['ready', null, false],
      ['waiting', 'approval', false],
      ['waiting', 'yes_no', false],
      ['running', null, true],
      ['running', null, false],
    ];
    for (const [status, promptType, stalled] of inputs) {
      expect(getNextAction(status, promptType, stalled)).toMatch(/^nextAction\./);
    }
  });

  // Guards the actual regression this Issue is about: `t()` renders a missing
  // key as its own path, so an untranslated key ships `worktree.nextAction.foo`
  // to the screen. Both dictionaries must carry every key the helper can emit.
  it.each(['en', 'ja'])('resolves every emitted key in the %s dictionary', (locale) => {
    const dictionary = loadWorktreeDictionary(locale);
    for (const key of Object.values(NEXT_ACTION_KEYS)) {
      const [namespace, leaf] = key.split('.');
      const group = dictionary[namespace] as Record<string, string> | undefined;
      expect(group, `${locale}: missing "${namespace}" group`).toBeDefined();
      expect(typeof group?.[leaf], `${locale}: missing "${key}"`).toBe('string');
      expect(group?.[leaf]).not.toBe('');
    }
  });

  it('en and ja translate the keys differently (ja is not an English copy)', () => {
    const en = loadWorktreeDictionary('en').nextAction as Record<string, string>;
    const ja = loadWorktreeDictionary('ja').nextAction as Record<string, string>;
    expect(ja.approveReject).not.toBe(en.approveReject);
    expect(ja.replyToPrompt).not.toBe(en.replyToPrompt);
  });

  describe('isNextActionKey', () => {
    it('accepts every key the helper can return', () => {
      for (const key of Object.values(NEXT_ACTION_KEYS)) {
        expect(isNextActionKey(key)).toBe(true);
      }
    });

    // Back-compat: a server that predates #1787 still sends the old literals,
    // and those must be rendered verbatim rather than fed to `t()`.
    it.each(['Approve / Reject', 'Running...', 'Start', '', 'nextAction.bogus'])(
      'rejects the legacy/unknown value %j',
      (value) => {
        expect(isNextActionKey(value)).toBe(false);
      }
    );
  });
});

describe('getReviewStatus()', () => {
  it('should return "done" when worktreeStatus is in_review', () => {
    expect(getReviewStatus('in_review', null, null, false)).toBe('done');
  });

  it('should return "done" regardless of session status when worktreeStatus is in_review', () => {
    expect(getReviewStatus('in_review', 'running', 'approval', true)).toBe('done');
  });

  it('should return "approval" when session is waiting with approval prompt', () => {
    expect(getReviewStatus('in_progress', 'waiting', 'approval', false)).toBe('approval');
  });

  it('should return "approval" when worktreeStatus is null and session waiting with approval', () => {
    expect(getReviewStatus(null, 'waiting', 'approval', false)).toBe('approval');
  });

  it('should return "stalled" when session is running and stalled', () => {
    expect(getReviewStatus('in_progress', 'running', null, true)).toBe('stalled');
  });

  it('should return "stalled" when worktreeStatus is null and running+stalled', () => {
    expect(getReviewStatus(null, 'running', null, true)).toBe('stalled');
  });

  it('should return null when no review condition is met', () => {
    expect(getReviewStatus('ready', 'running', null, false)).toBeNull();
    expect(getReviewStatus('in_progress', 'ready', null, false)).toBeNull();
    expect(getReviewStatus(null, 'idle', null, false)).toBeNull();
    expect(getReviewStatus(null, null, null, false)).toBeNull();
  });

  it('should return null when waiting but not approval prompt', () => {
    expect(getReviewStatus('in_progress', 'waiting', 'yes_no', false)).toBeNull();
    expect(getReviewStatus('in_progress', 'waiting', 'multiple_choice', false)).toBeNull();
  });

  it('should prioritize in_review over approval', () => {
    expect(getReviewStatus('in_review', 'waiting', 'approval', false)).toBe('done');
  });

  it('should prioritize in_review over stalled', () => {
    expect(getReviewStatus('in_review', 'running', null, true)).toBe('done');
  });

  it('should prioritize approval over stalled when both conditions met', () => {
    // waiting + approval + stalled: approval wins
    expect(getReviewStatus('in_progress', 'waiting', 'approval', true)).toBe('approval');
  });

  it('should handle all worktreeStatus values', () => {
    const statuses: Array<'ready' | 'in_progress' | 'in_review' | 'done' | null> = ['ready', 'in_progress', 'in_review', 'done', null];
    for (const ws of statuses) {
      // Should not throw
      const result = getReviewStatus(ws, 'idle', null, false);
      if (ws === 'in_review') {
        expect(result).toBe('done');
      } else {
        expect(result).toBeNull();
      }
    }
  });
});

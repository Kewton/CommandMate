/**
 * Issue #3374 — `response-checker-dialog-gate`, the agy receipt gate and the
 * numbered-dialog vouching gate, split out of `response-checker.ts`.
 *
 * Both collaborators are replaced, so what is pinned is the decision this
 * module makes on their answers.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasRecentAntigravityPermissionReceipt, evaluateDialogPresence } = vi.hoisted(() => ({
  hasRecentAntigravityPermissionReceipt: vi.fn(),
  evaluateDialogPresence: vi.fn(),
}));

vi.mock('@/lib/polling/antigravity-permission-receipts', () => ({
  hasRecentAntigravityPermissionReceipt,
}));
vi.mock('@/lib/polling/auto-yes-dialog-gate', () => ({
  evaluateDialogPresence,
}));

import {
  isWithheldForWantOfReceipt,
  isNumberedDialogVouched,
} from '@/lib/polling/response-checker-dialog-gate';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';

const candidate = {
  isPrompt: true,
  cleanContent: 'Pick one',
  promptData: { type: 'multiple_choice' },
} as unknown as PromptDetectionResult;

describe('[#3374] response-checker-dialog-gate', () => {
  beforeEach(() => {
    hasRecentAntigravityPermissionReceipt.mockReset();
    evaluateDialogPresence.mockReset();
  });

  describe('isWithheldForWantOfReceipt', () => {
    it('does not withhold when there is no scope, and asks nothing', () => {
      expect(isWithheldForWantOfReceipt(undefined)).toBe(false);
      expect(hasRecentAntigravityPermissionReceipt).not.toHaveBeenCalled();
    });

    it('does not withhold when agy asked lately', () => {
      hasRecentAntigravityPermissionReceipt.mockReturnValue(true);
      expect(isWithheldForWantOfReceipt({ worktreeId: 'wt-1', instanceId: 'agy-2' })).toBe(false);
      expect(hasRecentAntigravityPermissionReceipt).toHaveBeenCalledWith('wt-1', 'antigravity', 'agy-2');
    });

    it('withholds when agy asked nothing lately', () => {
      hasRecentAntigravityPermissionReceipt.mockReturnValue(false);
      expect(isWithheldForWantOfReceipt({ worktreeId: 'wt-1' })).toBe(true);
      expect(hasRecentAntigravityPermissionReceipt).toHaveBeenCalledWith('wt-1', 'antigravity', undefined);
    });
  });

  describe('isNumberedDialogVouched', () => {
    it('vouches when the tool reports the dialog present, on the frame as captured', () => {
      evaluateDialogPresence.mockReturnValue({ present: true, mode: 'enforce' });
      expect(isNumberedDialogVouched('claude', candidate, 'frame')).toBe(true);
      expect(evaluateDialogPresence).toHaveBeenCalledWith('claude', 'multiple_choice', 'frame');
    });

    it('does not vouch when the tool reports no dialog', () => {
      evaluateDialogPresence.mockReturnValue({ present: false, mode: 'enforce' });
      expect(isNumberedDialogVouched('codex', candidate, 'frame')).toBe(false);
    });
  });
});

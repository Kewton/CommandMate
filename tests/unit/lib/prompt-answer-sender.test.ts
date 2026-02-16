/**
 * Tests for sendPromptAnswer() shared module
 *
 * Issue #287 Bug2: Extract duplicated cursor-key sending logic from
 * route.ts and auto-yes-manager.ts into a shared function.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tmux before importing the module under test
vi.mock('@/lib/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));

import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { sendKeys, sendSpecialKeys } from '@/lib/tmux';
import type { PromptData } from '@/types/models';

describe('sendPromptAnswer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. Claude + multiple_choice promptData -> cursor keys
  // =========================================================================
  describe('Claude + multiple_choice promptData', () => {
    it('should use cursor-key navigation when promptData.type=multiple_choice and answer is numeric', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'Option A', isDefault: true },
          { number: 2, label: 'Option B', isDefault: false },
        ],
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '2',
        cliToolId: 'claude',
        promptData,
      });

      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Down', 'Enter']);
      expect(sendKeys).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Claude + yes_no promptData + fallbackPromptType=multiple_choice -> cursor keys
  // =========================================================================
  describe('Claude + yes_no promptData + fallbackPromptType=multiple_choice', () => {
    it('should use cursor-key navigation via fallback when promptData is yes_no but fallbackPromptType is multiple_choice', async () => {
      const promptData: PromptData = {
        type: 'yes_no',
        question: 'Continue?',
        options: ['yes', 'no'],
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '2',
        cliToolId: 'claude',
        promptData,
        fallbackPromptType: 'multiple_choice',
        fallbackDefaultOptionNumber: 1,
      });

      // Should use cursor keys because fallbackPromptType is multiple_choice
      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Down', 'Enter']);
      expect(sendKeys).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Claude + undefined promptData + fallbackPromptType=multiple_choice -> cursor keys
  // =========================================================================
  describe('Claude + undefined promptData + fallbackPromptType=multiple_choice', () => {
    it('should use cursor-key navigation via fallback when promptData is undefined', async () => {
      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '3',
        cliToolId: 'claude',
        promptData: undefined,
        fallbackPromptType: 'multiple_choice',
        fallbackDefaultOptionNumber: 1,
      });

      // offset = 3 - 1 = 2 -> 2 Down + Enter
      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Down', 'Down', 'Enter']);
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('should default to defaultOptionNumber=1 when fallbackDefaultOptionNumber is undefined', async () => {
      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '3',
        cliToolId: 'claude',
        promptData: undefined,
        fallbackPromptType: 'multiple_choice',
        // fallbackDefaultOptionNumber intentionally omitted
      });

      // offset = 3 - 1 (fallback) = 2 -> 2 Down + Enter
      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Down', 'Down', 'Enter']);
      expect(sendKeys).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Claude + undefined promptData + no fallback -> text send
  // =========================================================================
  describe('Claude + undefined promptData + no fallback', () => {
    it('should use text send when neither promptData nor fallback indicates multiple_choice', async () => {
      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '1',
        cliToolId: 'claude',
        promptData: undefined,
      });

      expect(sendKeys).toHaveBeenCalled();
      expect(sendSpecialKeys).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Non-claude cliToolId -> always text send
  // =========================================================================
  describe('Non-claude cliToolId', () => {
    it('should use text send for codex even with multiple_choice promptData', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'Option A', isDefault: true },
          { number: 2, label: 'Option B', isDefault: false },
        ],
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'codex-test',
        answer: '2',
        cliToolId: 'codex',
        promptData,
      });

      expect(sendKeys).toHaveBeenCalled();
      expect(sendSpecialKeys).not.toHaveBeenCalled();
    });

    it('should use text send for gemini even with fallbackPromptType=multiple_choice', async () => {
      await sendPromptAnswer({
        sessionName: 'gemini-test',
        answer: '1',
        cliToolId: 'gemini',
        promptData: undefined,
        fallbackPromptType: 'multiple_choice',
      });

      expect(sendKeys).toHaveBeenCalled();
      expect(sendSpecialKeys).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 6. Multi-select checkbox -> Space + navigate to Next + Enter
  // =========================================================================
  describe('Multi-select checkbox prompts', () => {
    it('should use Space+Down+Enter for multi-select checkbox prompts', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Select tools:',
        options: [
          { number: 1, label: '[ ] Option A', isDefault: true },
          { number: 2, label: '[ ] Option B', isDefault: false },
          { number: 3, label: '[ ] Option C', isDefault: false },
        ],
        status: 'pending',
      };

      // Select option 2: offset=2-1=1 Down, Space, then 3-2+1=2 Downs to "Next", Enter
      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '2',
        cliToolId: 'claude',
        promptData,
      });

      expect(sendSpecialKeys).toHaveBeenCalledWith(
        'claude-test',
        ['Down', 'Space', 'Down', 'Down', 'Enter']
      );
    });

    it('should navigate Up for multi-select when target is above default', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Select:',
        options: [
          { number: 1, label: '[x] A', isDefault: false },
          { number: 2, label: '[ ] B', isDefault: false },
          { number: 3, label: '[ ] C', isDefault: true },
        ],
        status: 'pending',
      };

      // Select option 1: offset=1-3=-2 -> 2 Up, Space, then 3-1+1=3 Downs, Enter
      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '1',
        cliToolId: 'claude',
        promptData,
      });

      expect(sendSpecialKeys).toHaveBeenCalledWith(
        'claude-test',
        ['Up', 'Up', 'Space', 'Down', 'Down', 'Down', 'Enter']
      );
    });

    it('should handle selecting the default option in multi-select (offset=0)', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Pick:',
        options: [
          { number: 1, label: '[ ] Alpha', isDefault: true },
          { number: 2, label: '[ ] Beta', isDefault: false },
        ],
        status: 'pending',
      };

      // Select option 1 (default): offset=0 -> no navigation, Space, 2-1+1=2 Downs, Enter
      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '1',
        cliToolId: 'claude',
        promptData,
      });

      expect(sendSpecialKeys).toHaveBeenCalledWith(
        'claude-test',
        ['Space', 'Down', 'Down', 'Enter']
      );
    });
  });

  // =========================================================================
  // 7. Default option (offset=0) -> just Enter
  // =========================================================================
  describe('Default option (offset=0) for single-select', () => {
    it('should send just Enter when selecting the default option', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'Yes', isDefault: true },
          { number: 2, label: 'No', isDefault: false },
        ],
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '1',
        cliToolId: 'claude',
        promptData,
      });

      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Enter']);
    });
  });

  // =========================================================================
  // 8. Offset > 0 -> Down + Enter
  // =========================================================================
  describe('Offset > 0 (navigate Down)', () => {
    it('should send Down keys + Enter when offset is positive', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'A', isDefault: true },
          { number: 2, label: 'B', isDefault: false },
          { number: 3, label: 'C', isDefault: false },
        ],
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '3',
        cliToolId: 'claude',
        promptData,
      });

      // offset = 3 - 1 = 2 -> 2 Down + Enter
      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Down', 'Down', 'Enter']);
    });
  });

  // =========================================================================
  // 9. Offset < 0 -> Up + Enter
  // =========================================================================
  describe('Offset < 0 (navigate Up)', () => {
    it('should send Up keys + Enter when offset is negative', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'A', isDefault: false },
          { number: 2, label: 'B', isDefault: false },
          { number: 3, label: 'C', isDefault: true },
        ],
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '1',
        cliToolId: 'claude',
        promptData,
      });

      // offset = 1 - 3 = -2 -> 2 Up + Enter
      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Up', 'Up', 'Enter']);
    });
  });

  // =========================================================================
  // Text send behavior
  // =========================================================================
  describe('Text send (non-multi-choice)', () => {
    it('should send text + Enter for yes_no prompts', async () => {
      const promptData: PromptData = {
        type: 'yes_no',
        question: 'Continue?',
        options: ['yes', 'no'],
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: 'y',
        cliToolId: 'claude',
        promptData,
      });

      // First call: send text
      expect(sendKeys).toHaveBeenCalledWith('claude-test', 'y', false);
      // Second call: send Enter
      expect(sendKeys).toHaveBeenCalledWith('claude-test', '', true);
      expect(sendSpecialKeys).not.toHaveBeenCalled();
    });

    it('should send text + Enter when answer is non-numeric for claude multi-choice', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'A', isDefault: true },
          { number: 2, label: 'B', isDefault: false },
        ],
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: 'custom text',
        cliToolId: 'claude',
        promptData,
      });

      // Non-numeric answer should fall through to text send
      expect(sendKeys).toHaveBeenCalled();
      expect(sendSpecialKeys).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge case: promptData.type=multiple_choice takes priority over fallback
  // =========================================================================
  describe('promptData priority over fallback', () => {
    it('should use promptData default option when both promptData and fallback are available', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'A', isDefault: false },
          { number: 2, label: 'B', isDefault: true },
        ],
        status: 'pending',
      };

      // Body says defaultOptionNumber=1 (stale), but promptData says default=2
      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '1',
        cliToolId: 'claude',
        promptData,
        fallbackPromptType: 'multiple_choice',
        fallbackDefaultOptionNumber: 1,
      });

      // Should use promptData's default (2), not fallback's (1): offset = 1 - 2 = -1 -> 1 Up + Enter
      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Up', 'Enter']);
    });
  });
});

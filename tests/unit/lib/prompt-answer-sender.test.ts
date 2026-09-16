/**
 * Tests for sendPromptAnswer() shared module
 *
 * Issue #287 Bug2: Extract duplicated cursor-key sending logic from
 * route.ts and auto-yes-manager.ts into a shared function.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tmux before importing the module under test
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  sendPromptAnswer,
  FreeTextAnswerRejectedError,
  FREE_TEXT_AT_MENU_ROW_REASON,
} from '@/lib/prompt-answer-sender';
import { sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { isTypedTextFieldOption } from '@/lib/detection/prompt-detect-multiple-choice';
import { detectPromptWithOptions } from '@/lib/polling/response-checker';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { MultipleChoicePromptData, PromptData } from '@/types/models';

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
  // Issue #807: AskUserQuestion picker (isAskUserQuestion) cursor engagement
  // =========================================================================
  describe('Issue #807: AskUserQuestion picker cursor engagement', () => {
    it('engages the cursor with Down+Up before Enter when selecting the default (offset=0)', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Phase 5 に進んでよいですか？',
        options: [
          { number: 1, label: '実装に進む (pm-auto-dev)', isDefault: true },
          { number: 2, label: '設計/計画を先に確認したい', isDefault: false },
          { number: 3, label: 'ここで一旦停止', isDefault: false },
          { number: 4, label: 'Type something.', isDefault: false },
          { number: 5, label: 'Chat about this', isDefault: false },
        ],
        status: 'pending',
        isAskUserQuestion: true,
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '1',
        cliToolId: 'claude',
        promptData,
      });

      // Net-zero Down+Up nudge engages the picker cursor, then Enter confirms.
      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Down', 'Up', 'Enter']);
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('does NOT add the nudge for non-default targets (offset != 0 already engages cursor)', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'A', isDefault: true },
          { number: 2, label: 'B', isDefault: false },
          { number: 3, label: 'C', isDefault: false },
        ],
        status: 'pending',
        isAskUserQuestion: true,
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '3',
        cliToolId: 'claude',
        promptData,
      });

      // offset = 3 - 1 = 2 -> the navigation itself engages the cursor.
      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Down', 'Down', 'Enter']);
    });

    it('keeps bare Enter for the default option when isAskUserQuestion is NOT set (legacy unchanged)', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Do you want to proceed?',
        options: [
          { number: 1, label: 'Yes', isDefault: true },
          { number: 2, label: 'No', isDefault: false },
        ],
        status: 'pending',
        // isAskUserQuestion intentionally omitted (legacy numbered confirmation)
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '1',
        cliToolId: 'claude',
        promptData,
      });

      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Enter']);
    });

    it('does not apply the nudge to multi-select pickers (checkbox flow takes priority)', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Select tools:',
        options: [
          { number: 1, label: '[ ] Option A', isDefault: true },
          { number: 2, label: '[ ] Option B', isDefault: false },
        ],
        status: 'pending',
        isAskUserQuestion: true,
      };

      await sendPromptAnswer({
        sessionName: 'claude-test',
        answer: '1',
        cliToolId: 'claude',
        promptData,
      });

      // Multi-select: Space toggle + navigate to "Next" + Enter (unchanged path).
      expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Space', 'Down', 'Down', 'Enter']);
    });
  });

  // =========================================================================
  // Issue #999: Antigravity (agy) permission menus are arrow-key-navigated,
  // like Claude Code. detectPrompt yields options with NO isDefault flag
  // (ASCII ">" is not an ❯/●/› indicator), so defaultNum falls back to 1.
  // Auto-answering "Yes" (option 1) => offset 0 => a bare Enter. A typed
  // option number would be ignored by agy's arrow-nav TUI, so sendKeys must
  // not be used.
  // =========================================================================
  describe('Issue #999: Antigravity multiple_choice uses cursor navigation', () => {
    // Options exactly as detectPrompt produces them for the real agy menu:
    // no option carries isDefault (the ">" highlight is not a default indicator).
    const agyMenuOptions = [
      { number: 1, label: 'Yes' },
      { number: 2, label: "Yes, and always allow in this conversation for commands that start with 'git status'" },
      { number: 3, label: "Yes, and always allow for commands that start with 'git status' (Persist to settings.json)" },
      { number: 4, label: 'No' },
    ];

    it('sends a bare Enter (cursor nav, offset 0) when auto-answering "Yes" (option 1)', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Do you want to proceed?',
        options: agyMenuOptions,
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'agy-test',
        answer: '1',
        cliToolId: 'antigravity',
        promptData,
      });

      // defaultNum falls back to 1 (no isDefault), targetNum 1 => offset 0 => Enter.
      expect(sendSpecialKeys).toHaveBeenCalledWith('agy-test', ['Enter']);
      // A typed "1" would be ignored by agy's arrow-nav TUI, so no text send.
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('navigates Down to reach a non-default option ("No" = option 4)', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Do you want to proceed?',
        options: agyMenuOptions,
        status: 'pending',
      };

      await sendPromptAnswer({
        sessionName: 'agy-test',
        answer: '4',
        cliToolId: 'antigravity',
        promptData,
      });

      // offset = 4 - 1 = 3 => three Downs then Enter.
      expect(sendSpecialKeys).toHaveBeenCalledWith('agy-test', ['Down', 'Down', 'Down', 'Enter']);
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('uses cursor nav via fallbackPromptType when promptData is undefined', async () => {
      await sendPromptAnswer({
        sessionName: 'agy-test',
        answer: '1',
        cliToolId: 'antigravity',
        promptData: undefined,
        fallbackPromptType: 'multiple_choice',
      });

      // fallbackDefaultOptionNumber defaults to 1 => offset 0 => Enter.
      expect(sendSpecialKeys).toHaveBeenCalledWith('agy-test', ['Enter']);
      expect(sendKeys).not.toHaveBeenCalled();
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
  // Issue #616: submitMode handling
  // =========================================================================
  describe('Issue #616: submitMode handling', () => {
    it('should NOT send Enter when submitMode=answer_only + multiple_choice + numeric answer', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Reasoning level',
        options: [
          { number: 1, label: 'low', isDefault: true },
          { number: 2, label: 'medium', isDefault: false },
          { number: 3, label: 'high', isDefault: false },
        ],
        status: 'pending',
        submitMode: 'answer_only',
      };

      await sendPromptAnswer({
        sessionName: 'codex-test',
        answer: '2',
        cliToolId: 'codex',
        promptData,
      });

      // submitMode=answer_only: send text only, NO Enter
      expect(sendKeys).toHaveBeenCalledWith('codex-test', '2', false);
      // Should NOT have been called with Enter (second call)
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(sendSpecialKeys).not.toHaveBeenCalled();
    });

    it('should send Enter when submitMode=answer_then_enter', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Select option:',
        options: [
          { number: 1, label: 'A', isDefault: true },
          { number: 2, label: 'B', isDefault: false },
        ],
        status: 'pending',
        submitMode: 'answer_then_enter',
      };

      await sendPromptAnswer({
        sessionName: 'codex-test',
        answer: '2',
        cliToolId: 'codex',
        promptData,
      });

      // submitMode=answer_then_enter: send text + Enter (standard behavior)
      expect(sendKeys).toHaveBeenCalledWith('codex-test', '2', false);
      expect(sendKeys).toHaveBeenCalledWith('codex-test', '', true);
      expect(sendKeys).toHaveBeenCalledTimes(2);
    });

    it('should default to answer_then_enter when submitMode is undefined', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'X', isDefault: true },
          { number: 2, label: 'Y', isDefault: false },
        ],
        status: 'pending',
        // submitMode intentionally omitted
      };

      await sendPromptAnswer({
        sessionName: 'codex-test',
        answer: '1',
        cliToolId: 'codex',
        promptData,
      });

      // undefined submitMode -> answer_then_enter fallback -> Enter should be sent
      expect(sendKeys).toHaveBeenCalledWith('codex-test', '1', false);
      expect(sendKeys).toHaveBeenCalledWith('codex-test', '', true);
      expect(sendKeys).toHaveBeenCalledTimes(2);
    });

    it('should use fallbackSubmitMode=answer_only when promptData has no submitMode', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'A', isDefault: true },
          { number: 2, label: 'B', isDefault: false },
        ],
        status: 'pending',
        // submitMode intentionally omitted
      };

      await sendPromptAnswer({
        sessionName: 'codex-test',
        answer: '1',
        cliToolId: 'codex',
        promptData,
        fallbackSubmitMode: 'answer_only',
      });

      // fallbackSubmitMode=answer_only: send text only, NO Enter
      expect(sendKeys).toHaveBeenCalledWith('codex-test', '1', false);
      expect(sendKeys).toHaveBeenCalledTimes(1);
    });

    it('should fallback to answer_then_enter for invalid submitMode values', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'A', isDefault: true },
          { number: 2, label: 'B', isDefault: false },
        ],
        status: 'pending',
        // Using type assertion to simulate invalid value
        submitMode: 'invalid' as 'answer_only',
      };

      await sendPromptAnswer({
        sessionName: 'codex-test',
        answer: '1',
        cliToolId: 'codex',
        promptData,
      });

      // Invalid submitMode -> answer_then_enter fallback -> Enter should be sent
      expect(sendKeys).toHaveBeenCalledWith('codex-test', '1', false);
      expect(sendKeys).toHaveBeenCalledWith('codex-test', '', true);
      expect(sendKeys).toHaveBeenCalledTimes(2);
    });

    it('should NOT skip Enter when submitMode=answer_only but answer is non-numeric', async () => {
      const promptData: PromptData = {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'A', isDefault: true },
          { number: 2, label: 'B', isDefault: false },
        ],
        status: 'pending',
        submitMode: 'answer_only',
      };

      await sendPromptAnswer({
        sessionName: 'codex-test',
        answer: 'custom text',
        cliToolId: 'codex',
        promptData,
      });

      // Non-numeric answer: even with submitMode=answer_only, Enter is sent
      expect(sendKeys).toHaveBeenCalledWith('codex-test', 'custom text', false);
      expect(sendKeys).toHaveBeenCalledWith('codex-test', '', true);
      expect(sendKeys).toHaveBeenCalledTimes(2);
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

// ===========================================================================
// Issue #2573: free text aimed at a menu row
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** A live capture, raw, as tmux emitted it. */
function liveFrame(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * The prompt the product reads off a live capture — the same shared entry the
 * response poller and `/current-output` use — so the rows under test are the
 * rows the answer panels were actually handed, not a hand-written copy.
 */
function livePrompt(cliToolId: CLIToolType, frame: string): MultipleChoicePromptData {
  const promptData = detectPromptWithOptions(frame, cliToolId).promptData;
  if (promptData?.type !== 'multiple_choice') {
    throw new Error(`fixture did not parse as multiple_choice for ${cliToolId}`);
  }
  return promptData;
}

/** The reason the Issue measured on Command Code 1.53.1: it ran the `mkdir` anyway. */
const REASON = 'この操作はしないでください';

describe('Issue #2573: free text aimed at a menu row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each([
    ['command-code', 'tests/fixtures/command-code-live-2250/dialog-shell-command.txt', 'No, tell Command Code what to do differently'],
    ['command-code', 'tests/fixtures/command-code-live-2250/dialog-create-file.txt', 'No, tell Command Code what to do differently'],
    ['codex', 'tests/unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt', 'No, and tell Codex what to do differently (esc)'],
    ['copilot', 'tests/unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt', 'No, and tell Copilot what to do differently (Esc to stop)'],
  ] as Array<[CLIToolType, string, string]>)('%s permission dialog (%s)', (cliToolId, fixture, menuRowLabel) => {
    const frame = liveFrame(fixture);
    const promptData = livePrompt(cliToolId, frame);
    const sessionName = `${cliToolId}-test`;

    it('is the screen the Issue is about: option 3 reads as taking text, and is a menu row', () => {
      const row = promptData.options.find((option) => option.number === 3);
      expect(row).toMatchObject({ label: menuRowLabel, requiresTextInput: true, isDefault: false });
      expect(isTypedTextFieldOption(row!)).toBe(false);
      expect(promptData.options.find((option) => option.isDefault)?.number).toBe(1);
    });

    it('refuses free text before a single key is sent', async () => {
      const sent = sendPromptAnswer({ sessionName, answer: REASON, cliToolId, promptData, frame });

      await expect(sent).rejects.toBeInstanceOf(FreeTextAnswerRejectedError);
      await expect(sent).rejects.toMatchObject({
        reason: FREE_TEXT_AT_MENU_ROW_REASON,
        optionNumbers: [3],
      });
      // No key at all: not the text, and above all not the Enter that would have
      // confirmed the highlighted `1. Yes`.
      expect(sendKeys).not.toHaveBeenCalled();
      expect(sendSpecialKeys).not.toHaveBeenCalled();
    });

    it('still sends the option number for the same row (non-vacuity)', async () => {
      await sendPromptAnswer({ sessionName, answer: '3', cliToolId, promptData, frame });

      expect(sendKeys).toHaveBeenCalledWith(sessionName, '3', false);
      expect(sendSpecialKeys).not.toHaveBeenCalled();
    });
  });

  it('refuses a text-bearing row whose words only sit inside a quoted command', async () => {
    // `/custom/` and `/enter\s+/` in TEXT_INPUT_PATTERNS match inside the command
    // an approval row quotes. The row is an APPROVAL; free text sent at it would
    // be confirmed by the Enter just the same.
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Do you want to proceed?',
      options: [
        { number: 1, label: 'Yes', isDefault: true, requiresTextInput: false },
        {
          number: 2,
          label: "Yes, and always allow for commands that start with 'npm run custom'",
          isDefault: false,
          requiresTextInput: true,
        },
        { number: 3, label: 'No', isDefault: false, requiresTextInput: false },
      ],
      status: 'pending',
    };

    await expect(
      sendPromptAnswer({ sessionName: 'antigravity-test', answer: 'stop', cliToolId: 'antigravity', promptData }),
    ).rejects.toMatchObject({ optionNumbers: [2] });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('never quotes the answer back in the refusal (SEC-003)', async () => {
    const frame = liveFrame('tests/fixtures/command-code-live-2250/dialog-shell-command.txt');
    const promptData = livePrompt('command-code', frame);

    await expect(
      sendPromptAnswer({
        sessionName: 'command-code-test',
        answer: '<script>alert(1)</script>',
        cliToolId: 'command-code',
        promptData,
        frame,
      }),
    ).rejects.toSatisfy((error: Error) => !error.message.includes('script'));
  });

  describe('the free-text field next door (Issue #2522) is untouched', () => {
    // Only the capture whose `❯` rests ON the field. This describe used to run
    // `question-description-on-last-option.txt` too — a screen whose cursor is on
    // option 1 — and so pinned the #2584 defect as correct; that capture is now
    // asserted the other way round below.
    it('types the text into Command Code’s `Type something...` field', async () => {
      const frame = liveFrame(
        'tests/fixtures/command-code-askuserquestion-2522/question-default-on-free-text.txt',
      );
      const promptData = livePrompt('command-code', frame);
      expect(promptData.options.some(isTypedTextFieldOption)).toBe(true);

      await sendPromptAnswer({
        sessionName: 'command-code-test',
        answer: 'Fix the flaky test first',
        cliToolId: 'command-code',
        promptData,
        frame,
      });

      expect(vi.mocked(sendKeys).mock.calls).toEqual([
        ['command-code-test', 'Fix the flaky test first', false],
        ['command-code-test', '', true],
      ]);
    });
  });

  it('does not judge a prompt with no text-bearing option (pre-#2573 behaviour, #1726)', async () => {
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Choose:',
      options: [
        { number: 1, label: 'A', isDefault: true, requiresTextInput: false },
        { number: 2, label: 'B', isDefault: false, requiresTextInput: false },
      ],
      status: 'pending',
    };

    await sendPromptAnswer({ sessionName: 'codex-test', answer: 'custom text', cliToolId: 'codex', promptData });

    expect(sendKeys).toHaveBeenCalledWith('codex-test', 'custom text', false);
  });

  it('does not judge a call with no promptData', async () => {
    await sendPromptAnswer({
      sessionName: 'codex-test',
      answer: 'custom text',
      cliToolId: 'codex',
      fallbackPromptType: 'multiple_choice',
    });

    expect(sendKeys).toHaveBeenCalledWith('codex-test', 'custom text', false);
  });
});

// ===========================================================================
// Issue #2584: free text while the cursor is on another row
// ===========================================================================

/** The two live `AskUserQuestion` captures whose field is NOT the cursor row. */
const CURSOR_ELSEWHERE_FIXTURES: Array<[string, number]> = [
  // [capture, the option number `Type something...` is on]
  ['question-flat-short.txt', 4],
  ['question-description-on-last-option.txt', 3],
];

describe('Issue #2584: free text while the cursor is on another row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each(CURSOR_ELSEWHERE_FIXTURES)(
    'Command Code AskUserQuestion (%s)',
    (name, fieldNumber) => {
      const frame = liveFrame(`tests/fixtures/command-code-askuserquestion-2522/${name}`);
      const promptData = livePrompt('command-code', frame);
      const sessionName = 'command-code-test';

      it('is the screen the Issue is about: a real field, and the cursor elsewhere', () => {
        const field = promptData.options.find((option) => option.number === fieldNumber);
        expect(field).toMatchObject({ requiresTextInput: true });
        expect(isTypedTextFieldOption(field!)).toBe(true);
        // The `❯` is on option 1, so #2573's guard has nothing to say here: its
        // question is whether ANY text-bearing row is a field, and this one is.
        expect(promptData.options.find((option) => option.isDefault)?.number).toBe(1);
        expect(promptData.options.some(isTypedTextFieldOption)).toBe(true);
      });

      it('refuses the free text before a single key is sent', async () => {
        const sent = sendPromptAnswer({
          sessionName,
          answer: 'UAT-FREETEXT-KIWI',
          cliToolId: 'command-code',
          promptData,
          frame,
        });

        await expect(sent).rejects.toBeInstanceOf(FreeTextAnswerRejectedError);
        await expect(sent).rejects.toMatchObject({
          reason: FREE_TEXT_AT_MENU_ROW_REASON,
          kind: 'cursor_elsewhere',
          optionNumbers: [fieldNumber],
          cursorOptionNumber: 1,
        });
        // The measured failure, and the whole point: option 1 is NOT confirmed.
        expect(sendKeys).not.toHaveBeenCalled();
        expect(sendSpecialKeys).not.toHaveBeenCalled();
      });

      it('names the field and the row the Enter would have confirmed', async () => {
        const sent = sendPromptAnswer({
          sessionName,
          answer: 'UAT-FREETEXT-KIWI',
          cliToolId: 'command-code',
          promptData,
          frame,
        });

        await expect(sent).rejects.toSatisfy((error: Error) =>
          error.message.includes(`option ${fieldNumber} is the text field`)
          && error.message.includes('the cursor is on option 1')
          && error.message.includes('Nothing was sent.'));
      });

      it('never quotes the answer back in the refusal (SEC-003)', async () => {
        const sent = sendPromptAnswer({
          sessionName,
          answer: '<script>alert(1)</script>',
          cliToolId: 'command-code',
          promptData,
          frame,
        });

        await expect(sent).rejects.toSatisfy(
          (error: Error) => !error.message.includes('script'),
        );
      });

      it('still answers the ordinary options on the same screen (non-vacuity)', async () => {
        await sendPromptAnswer({
          sessionName,
          answer: '2',
          cliToolId: 'command-code',
          promptData,
          frame,
        });

        expect(sendKeys).toHaveBeenCalledWith(sessionName, '2', false);
        expect(sendSpecialKeys).not.toHaveBeenCalled();
      });
    },
  );

  it('sends the text once the cursor IS on the field', async () => {
    // The same request, the same screen shape, the `❯` one row down: this is the
    // half #2522 measured and the reason the guard is keyed on the cursor rather
    // than on the tool or on the row type.
    const frame = liveFrame(
      'tests/fixtures/command-code-askuserquestion-2522/question-default-on-free-text.txt',
    );
    const promptData = livePrompt('command-code', frame);
    expect(promptData.options.find((option) => option.isDefault)?.number).toBe(3);

    await sendPromptAnswer({
      sessionName: 'command-code-test',
      answer: 'UAT-FREETEXT-KIWI',
      cliToolId: 'command-code',
      promptData,
      frame,
    });

    expect(vi.mocked(sendKeys).mock.calls).toEqual([
      ['command-code-test', 'UAT-FREETEXT-KIWI', false],
      ['command-code-test', '', true],
    ]);
  });

  it('does not judge a screen whose cursor no option carries (#999)', async () => {
    // agy's picker publishes its highlight without `isDefault`. There is nothing
    // to compare the field against, so the text goes as it did before #2584.
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Which branch?',
      options: [
        { number: 1, label: 'develop', requiresTextInput: false },
        { number: 2, label: 'Type something...', requiresTextInput: true },
      ],
      status: 'pending',
    };

    await sendPromptAnswer({
      sessionName: 'antigravity-test',
      answer: 'feature/x',
      cliToolId: 'antigravity',
      promptData,
    });

    expect(sendKeys).toHaveBeenCalledWith('antigravity-test', 'feature/x', false);
  });

  it('leaves #2573 to report a screen with no field at all', async () => {
    // Disjoint by construction: every text-bearing row here is a menu row, so
    // the #2584 guard returns before it looks at the cursor and the refusal that
    // comes out is still `menu_row`.
    const frame = liveFrame('tests/fixtures/command-code-live-2250/dialog-shell-command.txt');
    const promptData = livePrompt('command-code', frame);
    expect(promptData.options.some(isTypedTextFieldOption)).toBe(false);

    const sent = sendPromptAnswer({
      sessionName: 'command-code-test',
      answer: REASON,
      cliToolId: 'command-code',
      promptData,
      frame,
    });

    await expect(sent).rejects.toMatchObject({ kind: 'menu_row', cursorOptionNumber: null });
  });
});

describe('isTypedTextFieldOption (Issue #2573)', () => {
  it.each([
    ['Type something...', true],
    ['Type something... Give me a branch name and I will check it out before dispatching.', true],
    ['  type something', true],
  ])('%s with requiresTextInput is a text field', (label, expected) => {
    expect(isTypedTextFieldOption({ label, requiresTextInput: true })).toBe(expected);
  });

  it.each([
    'No, tell Command Code what to do differently',
    'No, and tell Codex what to do differently (esc)',
    'No, and tell Claude what to do differently (esc)',
    'Tell me differently',
    'Enter custom value',
    'Type here to explain',
    "Yes, and always allow for commands that start with 'npm run custom'",
    'Something to type something',
  ])('%s is a menu row even with requiresTextInput', (label) => {
    expect(isTypedTextFieldOption({ label, requiresTextInput: true })).toBe(false);
  });

  it('needs requiresTextInput: a picker label alone is not a field', () => {
    // Claude's AskUserQuestion appends `Type something.`, which the generic
    // patterns do not flag; this module does not re-classify what they left alone.
    expect(isTypedTextFieldOption({ label: 'Type something.', requiresTextInput: false })).toBe(false);
    expect(isTypedTextFieldOption({ label: 'Type something.' })).toBe(false);
  });
});

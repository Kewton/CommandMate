/**
 * Issue #1495: Auto-Yes must not auto-answer Claude's `/model` local-settings
 * overlay (which would silently change the user's default model).
 *
 * Root cause (verified on Claude Code v2.1.218, see fixture): the `/model`
 * overlay renders a ❯-marked numbered model list under a "Select model" header,
 * which detectMultipleChoicePrompt() mis-detected as a real multiple_choice
 * prompt. Auto-Yes (detectAndRespondToPrompt) calls detectPrompt() directly and
 * would resolve + Enter-confirm the default option.
 *
 * Fix:
 *   A) detectMultipleChoicePrompt() bails out when the overlay-unique footer
 *      "Enter to set as default …" is present → detectPrompt returns isPrompt=false
 *      → Auto-Yes skips, and the false `prompt_detected` status is gone.
 *   B) status-detector classifies the overlay as a Claude selection list
 *      (reason=claude_selection_list, hasActivePrompt=false) so NavigationButtons /
 *      ESC hatch are available and the sidebar no longer shows a fake prompt.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { resolveAutoAnswer } from '@/lib/polling/auto-yes-resolver';
import {
  buildDetectPromptOptions,
  CLAUDE_SELECTION_LIST_FOOTER,
  CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN,
} from '@/lib/detection/cli-patterns';
import { isMultipleChoicePrompt } from '../helpers/prompt-type-guards';
import { CLAUDE_MODEL_OVERLAY_V2_1_218 } from '../fixtures/claude-model-overlay';

// Genuine Claude confirm-footer multiple_choice prompt (question adjacent to the
// numbered options). MUST remain detected — its footer ("Enter to confirm · Esc
// to cancel") shares the word "Enter"/"confirm"/"Esc" with the overlay footer but
// NOT the "set as default" signature, so the guard must not exclude it.
const CLAUDE_CONFIRM_FOOTER_PROMPT = [
  ' Is this a project you trust?',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

// Genuine Claude permission prompt (Bash tool confirmation footer). MUST remain
// a detected multiple_choice prompt so Auto-Yes still answers it.
const CLAUDE_PERMISSION_PROMPT = [
  '⏺ Bash(git status)',
  '─'.repeat(45),
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for git in <path>",
  '  3. No',
  '',
  '  Esc to cancel · Tab to amend →',
].join('\n');

describe('Issue #1495: Claude /model overlay must not be auto-answered', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  describe('cli-patterns: model-overlay footer signature', () => {
    it('CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN matches the real /model footer', () => {
      expect(
        CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN.test(
          'Enter to set as default · s to use this session only · Esc to cancel',
        ),
      ).toBe(true);
    });

    it('CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN does NOT match genuine prompt footers', () => {
      // Trust dialog / generic confirm
      expect(CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN.test('Enter to confirm · Esc to cancel')).toBe(false);
      // Bash-tool permission footer
      expect(CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN.test('Esc to cancel · Tab to amend →')).toBe(false);
      // AskUserQuestion footer
      expect(
        CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN.test('Enter to select · ↑/↓ to navigate · Esc to cancel'),
      ).toBe(false);
      // /config footer
      expect(CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN.test('Type to filter · Enter/↓ to select · Esc to clear')).toBe(false);
    });

    it('CLAUDE_SELECTION_LIST_FOOTER matches the real /model footer (change B)', () => {
      expect(
        CLAUDE_SELECTION_LIST_FOOTER.test(
          'Enter to set as default · s to use this session only · Esc to cancel',
        ),
      ).toBe(true);
    });
  });

  describe('change A: detectPrompt does not treat /model as an answerable prompt', () => {
    it('returns isPrompt=false for the real /model overlay (claude options)', () => {
      const result = detectPrompt(CLAUDE_MODEL_OVERLAY_V2_1_218, buildDetectPromptOptions('claude'));
      expect(result.isPrompt).toBe(false);
      expect(result.promptData).toBeUndefined();
    });

    it('Auto-Yes cannot resolve an answer for the /model overlay', () => {
      const result = detectPrompt(CLAUDE_MODEL_OVERLAY_V2_1_218, buildDetectPromptOptions('claude'));
      // detectAndRespondToPrompt returns 'no_prompt' at the !promptData guard,
      // so resolveAutoAnswer is never reached. Assert the precondition directly.
      expect(result.promptData).toBeUndefined();
      // And defensively: even if a caller forced resolution, there is nothing to resolve.
      if (result.promptData) {
        expect(resolveAutoAnswer(result.promptData)).toBeNull();
      }
    });
  });

  describe('change B: status-detector classifies /model as a selection list', () => {
    it('returns waiting/claude_selection_list with hasActivePrompt=false', () => {
      const st = detectSessionStatus(CLAUDE_MODEL_OVERLAY_V2_1_218, 'claude');
      expect(st.status).toBe('waiting');
      expect(st.reason).toBe(STATUS_REASON.CLAUDE_SELECTION_LIST);
      expect(st.hasActivePrompt).toBe(false);
    });

    it('does NOT report prompt_detected for /model (acceptance criterion 3)', () => {
      const st = detectSessionStatus(CLAUDE_MODEL_OVERLAY_V2_1_218, 'claude');
      expect(st.reason).not.toBe(STATUS_REASON.PROMPT_DETECTED);
    });
  });

  describe('non-regression: genuine Claude multiple_choice prompts still auto-answerable', () => {
    it('confirm-footer prompt ("Enter to confirm · Esc to cancel") is still detected', () => {
      const result = detectPrompt(CLAUDE_CONFIRM_FOOTER_PROMPT, buildDetectPromptOptions('claude'));
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBeGreaterThanOrEqual(2);
        expect(resolveAutoAnswer(result.promptData)).toBe('1');
      }
    });

    it('Bash permission prompt is still detected and resolves to Yes', () => {
      const result = detectPrompt(CLAUDE_PERMISSION_PROMPT, buildDetectPromptOptions('claude'));
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        const def = result.promptData.options.find(o => o.isDefault);
        expect(def?.label).toBe('Yes');
        expect(resolveAutoAnswer(result.promptData)).toBe('1');
      }
    });

    it('status-detector still reports prompt_detected for a genuine permission prompt', () => {
      const st = detectSessionStatus(CLAUDE_PERMISSION_PROMPT, 'claude');
      expect(st.status).toBe('waiting');
      expect(st.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
      expect(st.hasActivePrompt).toBe(true);
    });
  });

  describe('non-regression: Gemini /model dialog (different footer) still detected', () => {
    it('Gemini Select Model dialog remains a multiple_choice prompt', () => {
      const output = [
        '> /model',
        '',
        '',
        'Select Model',
        '',
        '● 1. Auto (Gemini 3)',
        '     Let Gemini CLI decide the best model for the task: gemini-3.1-pro, gemini-3-flash',
        '  2. Auto (Gemini 2.5)',
        '     Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-2.5-flash',
        '  3. Manual',
        '     Manually select a model',
        '',
        '(Press Esc to close)',
      ].join('\n');
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });
});

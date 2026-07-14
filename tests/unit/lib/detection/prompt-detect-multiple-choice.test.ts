/**
 * [Issue #807] Regression tests for the Claude Code v2.x AskUserQuestion picker.
 *
 * The new AskUserQuestion picker differs from the legacy numbered confirmation:
 *   - each option is rendered across TWO lines (title + indented description)
 *   - it includes meta options ("4. Type something." / "5. Chat about this")
 *   - a `─` divider separates the meta options
 *   - it ends with a "Enter to select · ↑/↓ to navigate · Esc to cancel" footer
 *   - while /pm-auto-dev runs, a task panel ("6 tasks (4 done, 2 open)" etc.) is
 *     overlaid BELOW that footer.
 *
 * Before the fix, the trailing task panel poisoned option collection: the
 * "6 tasks ..." line was parsed as option 6 and the reverse scan stopped at the
 * footer, so the real 1./2./3. options were never collected and detection
 * returned no_prompt. Auto-yes therefore went silent whenever the panel was
 * rendered (the reported 30+ minute stall). These tests pin the corrected
 * behavior and guard the legacy format from regressing.
 *
 * Captures reproduced from the Issue #807 body (anvil-feature-issue-921 PC UAT).
 */

import { describe, it, expect } from 'vitest';
import {
  detectMultipleChoicePrompt,
  buildMultipleChoiceResult,
} from '@/lib/detection/prompt-detect-multiple-choice';
import type { DetectPromptOptions } from '@/lib/detection/types';
import type { MultipleChoicePromptData } from '@/types/models';
import { buildClaude1000RowPermissionFrame } from '../../../fixtures/claude-1000-row-prompt';

/** Identity truncation: the unit under test only needs a passthrough. */
const truncate = (s: string) => s;

/** Claude is detected with requireDefaultIndicator: false (buildDetectPromptOptions). */
const CLAUDE_OPTS: DetectPromptOptions = { requireDefaultIndicator: false };

function asMultipleChoice(
  output: string,
  opts: DetectPromptOptions = CLAUDE_OPTS,
): MultipleChoicePromptData | null {
  const result = detectMultipleChoicePrompt(output, opts, truncate);
  if (result.promptData?.type === 'multiple_choice') {
    return result.promptData;
  }
  return null;
}

// The picker exactly as rendered by Claude Code v2.x (no trailing panel yet).
const PICKER_CLEAN = [
  'Phase 5 (TDD 実装) に進んでよいですか？設計は opus×2 + Codex×2 でレビュー済み、作業計画も確定しています。',
  '',
  '❯ 1. 実装に進む (pm-auto-dev)',
  '     /pm-auto-dev 921 を起動し、TDD (Red-Green-Refactor) で assess_structured_data SSOT + 両ゲート OR-tolerant 化 + テスト一式を実装。完了後 Phase 6 検証まで自動進行。',
  '  2. 設計/計画を先に確認したい',
  '     実装の前に設計方針書(181行)または作業計画をあなたが確認・修正。承認後に Phase 5 へ。',
  '  3. ここで一旦停止',
  '     Phase 1-4 の成果物(issue v5・設計方針書・作業計画)で区切り、実装は別途あなたの判断で開始。',
  '  4. Type something.',
  '─────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

// The exact failure case: the /pm-auto-dev task panel overlaid below the footer.
const PICKER_WITH_TASK_PANEL = [
  PICKER_CLEAN,
  '',
  '  6 tasks (4 done, 2 open)',
  '  ⏺ assess_structured_data SSOT',
  '  ◯ 両ゲート OR-tolerant 化',
].join('\n');

describe('detectMultipleChoicePrompt - Issue #807 AskUserQuestion picker', () => {
  describe('Issue #1167 1000-row frame', () => {
    it('finds the prompt above internal padding and excludes the task panel', () => {
      const promptData = asMultipleChoice(buildClaude1000RowPermissionFrame());

      expect(promptData).not.toBeNull();
      expect(promptData?.question).toContain('Do you want to make this edit');
      expect(promptData?.options.map(option => option.number)).toEqual([1, 2, 3]);
      expect(promptData?.options.some(option => option.label.includes('tasks'))).toBe(false);
      expect(promptData?.options.some(option => option.label.includes('pending'))).toBe(false);
    });
  });

  describe('clean picker (no trailing task panel)', () => {
    it('detects all 5 options including the divider-separated meta options', () => {
      const promptData = asMultipleChoice(PICKER_CLEAN);

      expect(promptData).not.toBeNull();
      expect(promptData!.options).toHaveLength(5);
      expect(promptData!.options.map(o => o.number)).toEqual([1, 2, 3, 4, 5]);
    });

    it('returns option 1 (the ❯ line) as the default', () => {
      const promptData = asMultipleChoice(PICKER_CLEAN)!;
      const defaultOption = promptData.options.find(o => o.isDefault);

      expect(defaultOption?.number).toBe(1);
      expect(defaultOption?.label).toBe('実装に進む (pm-auto-dev)');
    });

    it('does not misparse the indented description lines as options', () => {
      const promptData = asMultipleChoice(PICKER_CLEAN)!;

      // Description lines like "/pm-auto-dev 921 を起動し…" must not be collected.
      expect(promptData.options.map(o => o.label)).toEqual([
        '実装に進む (pm-auto-dev)',
        '設計/計画を先に確認したい',
        'ここで一旦停止',
        'Type something.',
        'Chat about this',
      ]);
    });

    it('flags the prompt as an AskUserQuestion picker', () => {
      const promptData = asMultipleChoice(PICKER_CLEAN)!;
      expect(promptData.isAskUserQuestion).toBe(true);
    });

    it('extracts the question text from above the options', () => {
      const promptData = asMultipleChoice(PICKER_CLEAN)!;
      expect(promptData.question).toContain('Phase 5 (TDD 実装) に進んでよいですか？');
    });
  });

  describe('picker WITH the /pm-auto-dev task panel overlay (the reported bug)', () => {
    // Before the fix this returned isPrompt: false (the panel poisoned the scan),
    // so auto-yes never sent a response — the 30+ minute silence in the issue.
    it('still detects the prompt instead of silently failing', () => {
      const result = detectMultipleChoicePrompt(PICKER_WITH_TASK_PANEL, CLAUDE_OPTS, truncate);
      expect(result.isPrompt).toBe(true);
    });

    it('detects the same 5 options as the clean capture (panel excluded)', () => {
      const promptData = asMultipleChoice(PICKER_WITH_TASK_PANEL)!;

      expect(promptData.options).toHaveLength(5);
      expect(promptData.options.map(o => o.number)).toEqual([1, 2, 3, 4, 5]);
      // The "6 tasks (4 done, 2 open)" panel line must NOT appear as an option.
      expect(promptData.options.some(o => o.label.includes('tasks'))).toBe(false);
    });

    it('returns option 1 as the default so auto-yes resolves to "1"', () => {
      const promptData = asMultipleChoice(PICKER_WITH_TASK_PANEL)!;
      expect(promptData.options.find(o => o.isDefault)?.number).toBe(1);
    });

    it('flags the prompt as an AskUserQuestion picker even with the panel present', () => {
      const promptData = asMultipleChoice(PICKER_WITH_TASK_PANEL)!;
      expect(promptData.isAskUserQuestion).toBe(true);
    });
  });

  describe('alternate footer wording', () => {
    it('handles "Tab/Arrow keys to navigate" footer wording', () => {
      const output = [
        'どの方式でコピーしますか？',
        '',
        '❯ 1. ユーザー入力のみ',
        '  2. レスポンスのみ',
        '  3. 両方個別に',
        '',
        'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
        '',
        '  3 tasks (1 done, 2 open)',
      ].join('\n');

      const promptData = asMultipleChoice(output);
      expect(promptData).not.toBeNull();
      expect(promptData!.options).toHaveLength(3);
      expect(promptData!.options.find(o => o.isDefault)?.number).toBe(1);
      expect(promptData!.isAskUserQuestion).toBe(true);
    });
  });

  describe('legacy numbered confirmation format is unchanged (no regression)', () => {
    it('does NOT flag the legacy "Do you want to proceed?" prompt as a picker', () => {
      const output = [
        'Do you want to proceed?',
        '❯ 1. Yes',
        '  2. No',
        '  3. Cancel',
      ].join('\n');

      const promptData = asMultipleChoice(output);
      expect(promptData).not.toBeNull();
      expect(promptData!.options).toHaveLength(3);
      expect(promptData!.options.find(o => o.isDefault)?.number).toBe(1);
      // Legacy format has no AskUserQuestion footer -> flag stays unset.
      expect(promptData!.isAskUserQuestion).toBeUndefined();
    });

    it('legacy prompt with the "Esc to cancel · Tab to amend" footer stays a non-picker', () => {
      const output = [
        'Do you want to proceed?',
        '❯ 1. Yes',
        '  2. No',
        'Esc to cancel · Tab to amend · ctrl+e to explain',
      ].join('\n');

      const promptData = asMultipleChoice(output);
      expect(promptData).not.toBeNull();
      expect(promptData!.options).toHaveLength(2);
      expect(promptData!.isAskUserQuestion).toBeUndefined();
    });
  });

  describe('buildMultipleChoiceResult isAskUserQuestion flag', () => {
    it('omits the flag when isAskUserQuestion is not passed', () => {
      const result = buildMultipleChoiceResult(
        'Choose:',
        [{ number: 1, label: 'A', isDefault: true }, { number: 2, label: 'B', isDefault: false }],
        undefined,
        'Choose:',
        truncate,
      );
      expect(result.promptData?.type).toBe('multiple_choice');
      if (result.promptData?.type === 'multiple_choice') {
        expect(result.promptData.isAskUserQuestion).toBeUndefined();
      }
    });

    it('sets the flag when isAskUserQuestion is true', () => {
      const result = buildMultipleChoiceResult(
        'Choose:',
        [{ number: 1, label: 'A', isDefault: true }, { number: 2, label: 'B', isDefault: false }],
        undefined,
        'Choose:',
        truncate,
        undefined,
        true,
      );
      if (result.promptData?.type === 'multiple_choice') {
        expect(result.promptData.isAskUserQuestion).toBe(true);
      }
    });
  });
});

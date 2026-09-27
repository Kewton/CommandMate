/**
 * `assessPromptAnswerability` — the one reading `/prompt-response` re-verifies
 * with and the status API publishes as `promptAnswerable` (Issue #2870).
 *
 * #2868's Send did nothing because the status API published a prompt the route
 * then refused: two readings of one frame. The claims here are the route's:
 *
 *  1. the dialogs each tool's own rule vouches for (the fixtures
 *     `tests/unit/detection/tools/dialogs.test.ts` uses) are answerable —
 *     except opencode's button strip, which neither surface answers by number;
 *  2. a Claude reply written as a Markdown `1. / 2. / 3.` list (#2457) is a
 *     parser candidate and is refused as `prompt_no_longer_active`;
 *  3. a Command Code question that is up and unreadable (#2522 確定仕様 B) is
 *     refused as `unsupported_dialog_layout` with the route's own message, and
 *     never reaches the generic parser.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi, stripBoxDrawing, buildDetectPromptOptions } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import {
  assessPromptAnswerability,
  COMMAND_CODE_UNSUPPORTED_QUESTION_MESSAGE,
  PROMPT_NO_LONGER_ACTIVE_REASON,
  UNSUPPORTED_DIALOG_LAYOUT_REASON,
} from '@/lib/polling/auto-yes-dialog-gate';
import type { CLIToolType } from '@/lib/cli-tools/types';

const DETECTION_FIXTURES = path.resolve(__dirname, '../lib/detection/fixtures');
const FIXTURES = path.resolve(__dirname, '../../fixtures');

function detectionFrame(dir: string, name: string): string {
  return readFileSync(path.join(DETECTION_FIXTURES, dir, `${name}.txt`), 'utf8');
}

function fixture(dir: string, name: string): string {
  return readFileSync(path.join(FIXTURES, dir, `${name}.txt`), 'utf8');
}

describe('[#2870] assessPromptAnswerability', () => {
  const ANSWERABLE: ReadonlyArray<readonly [CLIToolType, string, string]> = [
    ['claude', 'claude-live-1708', 'bash-approval-taskpanel'],
    ['claude', 'claude-live-1708', 'askuserquestion-submit-taskpanel'],
    ['codex', 'codex-live-1628', 'approval-run-command'],
    ['codex', 'codex-live-1628', 'approval-apply-patch'],
    ['codex', 'codex-live-1628', 'model-picker-step1'],
    ['codex', 'codex-live-1628', 'model-picker-step2'],
    ['copilot', 'copilot-live-1885', 'permission-dialog'],
  ];

  it.each(ANSWERABLE)('%s %s/%s is answerable', (tool, dir, name) => {
    const result = assessPromptAnswerability(tool, detectionFrame(dir, name));

    expect(result.promptCheck.isPrompt).toBe(true);
    expect(result.presence.present).toBe(true);
    expect(result.refusal).toBeNull();
    expect(result.isCommandCodeQuestion).toBe(false);
  });

  it.each(['permission-bash', 'permission-edit'])(
    'opencode %s is not a number-answerable prompt, on either surface',
    (name) => {
      // opencode's permission strip is a button row, answered by `decisionId`
      // through the structured layer (#2031), never by a digit: the status API
      // publishes no scraper prompt for it (so `promptAnswerable` is absent)
      // and `/prompt-response` refuses a number aimed at it — the two agree.
      const raw = detectionFrame('opencode-live-1893', name);

      expect(detectSessionStatus(raw, 'opencode').hasActivePrompt).toBe(false);
      expect(assessPromptAnswerability('opencode', raw).refusal).toEqual({
        reason: PROMPT_NO_LONGER_ACTIVE_REASON,
      });
    },
  );

  // The #2457 frames whose WHOLE pane the generic parser reads as a
  // `multiple_choice` (the fixture README's `frame` column) — the ones that
  // reach the route's re-verification as a candidate at all.
  const REPLIES = [
    'reply-numbered-list-repaint',
    'reply-numbered-list-generating-repaint',
  ] as const;

  it.each(REPLIES)('a #2457 reply (%s) is refused as prompt_no_longer_active', (name) => {
    const raw = fixture('claude-idle-numbered-list-2457', name);
    // Non-vacuous: the generic parser alone would have answered this frame.
    expect(
      detectPrompt(stripBoxDrawing(stripAnsi(raw)), buildDetectPromptOptions('claude')).isPrompt,
    ).toBe(true);

    const result = assessPromptAnswerability('claude', raw);

    expect(result.refusal).toEqual({ reason: PROMPT_NO_LONGER_ACTIVE_REASON });
    expect(result.presence.present).toBe(false);
  });

  it('refuses an unreadable Command Code question as unsupported_dialog_layout', () => {
    const raw = fixture('command-code-askuserquestion-2522', 'unsupported-multi-select-checkboxes');
    // The generic parser would read a partial list off this frame.
    expect(detectPrompt(stripBoxDrawing(stripAnsi(raw))).isPrompt).toBe(true);

    const result = assessPromptAnswerability('command-code', raw);

    expect(result.refusal).toEqual({
      reason: UNSUPPORTED_DIALOG_LAYOUT_REASON,
      message: COMMAND_CODE_UNSUPPORTED_QUESTION_MESSAGE,
    });
    expect(result.promptCheck.isPrompt).toBe(false);
    expect(result.isCommandCodeQuestion).toBe(false);
    expect(result.presence.present).toBe(false);
  });

  it('reads a readable Command Code question with its own reader', () => {
    const raw = fixture('command-code-askuserquestion-2522', 'question-flat-short');

    const result = assessPromptAnswerability('command-code', raw);

    expect(result.isCommandCodeQuestion).toBe(true);
    expect(result.promptCheck.isPrompt).toBe(true);
    expect(result.refusal).toBeNull();
  });
});

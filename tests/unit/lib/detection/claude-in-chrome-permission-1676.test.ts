/**
 * [Issue #1676] Claude in Chrome permission dialogs (and other declarative /
 * imperative headers) must be detected as multiple_choice prompts.
 *
 * The dialog is a declarative sentence ("Claude in Chrome wants to run
 * JavaScript on localhost:8787") over a ❯-marked option block — no "?" and no
 * QUESTION_KEYWORD_PATTERN keyword anywhere. Layer 5 (SEC-001) therefore
 * rejected the frame for claude (requireDefaultIndicator: false), silencing the
 * whole shared pipeline at once: Auto-Yes, PromptPanel, Web Push / message
 * history, `commandmate wait` exit 10, and even manual `respond` (the
 * prompt-response route re-validates before sending).
 *
 * Fix under test: frames where a ❯/●/› default indicator was actually collected
 * are exempt from Layer 5 — the same semantics codex/gemini get via
 * requireDefaultIndicator: true. Indicator-less frames (#193 capture artifacts)
 * still require a question line, which this file pins as well.
 *
 * Fixtures are CONSTRUCTED (not raw tmux captures): they reproduce the pane
 * shape measured live in the Issue #1676 body, with ANSI colors mirroring real
 * Claude Code frames. Every test feeds them through the real pipeline —
 * stripBoxDrawing(stripAnsi(pane)) → detectPrompt(buildDetectPromptOptions())
 * at the detector level, and detectSessionStatus(pane, 'claude') (which strips
 * internally) at the status level.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { resolveAutoAnswer } from '@/lib/polling/auto-yes-resolver';
import {
  buildDetectPromptOptions,
  stripAnsi,
  stripBoxDrawing,
} from '@/lib/detection/cli-patterns';
import { isMultipleChoicePrompt } from '../../../helpers/prompt-type-guards';
import { CLAUDE_MODEL_OVERLAY_V2_1_218 } from '../../../fixtures/claude-model-overlay';

const ESC = '\u001b';
const CLAUDE_OPTS = buildDetectPromptOptions('claude');

/** The real claude pipeline: status-detector / auto-yes-poller both strip like this. */
function detectAsClaude(pane: string) {
  return detectPrompt(stripBoxDrawing(stripAnsi(pane)), CLAUDE_OPTS);
}

/**
 * Claude in Chrome permission dialog, in the exact shape measured in the Issue
 * #1676 body (2-space indented tool line / header / URL, ❯ on option 1).
 */
function chromePermissionPane(header: string): string {
  return [
    `  ${ESC}[38;5;114m⏺${ESC}[39m Calling claude-in-chrome…`,
    '',
    `  ${header}`,
    '',
    '  http://localhost:8787/',
    '',
    `  ${ESC}[38;5;246m❯${ESC}[39m 1. Allow`,
    '    2. Allow all actions on localhost:8787 for this session',
    '    3. Deny (esc)',
    '',
  ].join('\n');
}

/**
 * The 6 header wordings measured as MISS in Issue #1676 (8 operations, 6 MISS —
 * only "type"/"select" passed by accidentally containing a question keyword).
 * None of these contains a "?" or a QUESTION_KEYWORD_PATTERN keyword; the
 * indicator-less counter-tests below fail if that invariant is ever broken.
 */
const MISSED_CHROME_HEADERS = [
  'Claude in Chrome wants to run JavaScript on localhost:8787',
  'Claude in Chrome wants to navigate to https://example.com/login',
  'Claude in Chrome wants to click on "Submit" on localhost:8787',
  'Claude in Chrome wants to take a screenshot of localhost:8787',
  'Claude in Chrome wants to read the page on localhost:8787',
  'Claude in Chrome wants to fill a form on localhost:8787',
];

/**
 * Imperative Japanese AskUserQuestion header — no "？" and no English keyword,
 * in the two-line-per-option picker shape of Issue #807 (footer included).
 */
const JP_IMPERATIVE_ASK_USER_QUESTION_PANE = [
  '実装方針を選んでください',
  '',
  `${ESC}[38;5;246m❯${ESC}[39m 1. 案A: 既存モジュールを直す`,
  '     いまの実装に最小の変更で対応する。',
  '  2. 案B: 新しいモジュールを足す',
  '     既存経路には触れず、隣に実装する。',
  '  3. 案C: ここで一旦停止',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

describe('Issue #1676: ❯-marked frames are exempt from Layer 5 (SEC-001)', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  describe('detector level: Claude in Chrome permission dialogs', () => {
    it.each(MISSED_CHROME_HEADERS)('detects "%s"', (header) => {
      const result = detectAsClaude(chromePermissionPane(header));

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(3);
        expect(result.promptData.options[0]).toMatchObject({
          number: 1,
          label: 'Allow',
          isDefault: true,
        });
        // Auto-Yes answers the default option: "1. Allow".
        expect(resolveAutoAnswer(result.promptData)).toBe('1');
      }
    });
  });

  describe('detector level: imperative AskUserQuestion headers', () => {
    it('detects 「実装方針を選んでください」 (no ？, no keyword)', () => {
      const result = detectAsClaude(JP_IMPERATIVE_ASK_USER_QUESTION_PANE);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(3);
        expect(result.promptData.options[0].isDefault).toBe(true);
        // The #807 picker footer must still flag the AskUserQuestion cursor flow.
        expect(result.promptData.isAskUserQuestion).toBe(true);
        expect(resolveAutoAnswer(result.promptData)).toBe('1');
      }
    });

    it('detects a keyword-less English header ("Next step for the rollout")', () => {
      const pane = [
        'Next step for the rollout',
        '',
        `${ESC}[38;5;246m❯${ESC}[39m 1. 案A: canary deploy`,
        '  2. 案B: full deploy',
        '',
        'Enter to select · ↑/↓ to navigate · Esc to cancel',
      ].join('\n');

      const result = detectAsClaude(pane);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });

  describe('detectSessionStatus level (the shared-pipeline consumers)', () => {
    it('reports waiting / prompt_detected / hasActivePrompt=true for the chrome dialog', () => {
      const status = detectSessionStatus(
        chromePermissionPane(MISSED_CHROME_HEADERS[0]),
        'claude',
      );

      expect(status.status).toBe('waiting');
      expect(status.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
      expect(status.hasActivePrompt).toBe(true);
      expect(status.promptDetection.isPrompt).toBe(true);
      expect(status.promptDetection.promptData?.type).toBe('multiple_choice');
    });

    it('reports an active prompt (not claude_selection_list) for the imperative picker', () => {
      // Before the fix this frame fell through to priority 1.5 (footer match) and
      // surfaced as a NavigationButtons-only selection list with hasActivePrompt=false.
      const status = detectSessionStatus(JP_IMPERATIVE_ASK_USER_QUESTION_PANE, 'claude');

      expect(status.status).toBe('waiting');
      expect(status.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
      expect(status.hasActivePrompt).toBe(true);
    });
  });

  describe('counter path: indicator-less frames still require a question line', () => {
    // Also guards fixture quality: if a header ever gains an accidental
    // QUESTION_KEYWORD_PATTERN keyword, the ❯-less frame becomes detectable via
    // the question-line path and these expectations fail.
    it.each(MISSED_CHROME_HEADERS)('rejects the ❯-less variant of "%s"', (header) => {
      const pane = chromePermissionPane(header).replace(
        `  ${ESC}[38;5;246m❯${ESC}[39m 1. Allow`,
        '    1. Allow',
      );

      expect(pane).not.toContain('❯');
      expect(detectAsClaude(pane).isPrompt).toBe(false);
    });

    it('still detects a ❯-less frame when a real question line is present (#193 semantics)', () => {
      const pane = chromePermissionPane('Do you want to proceed?').replace(
        `  ${ESC}[38;5;246m❯${ESC}[39m 1. Allow`,
        '    1. Allow',
      );

      const result = detectAsClaude(pane);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });

  describe('false-positive guards stay intact', () => {
    it('rejects a prose numbered list (no ❯, no question line)', () => {
      const pane = [
        'Recommendations:',
        '1. Add regression fixtures',
        '2. Update the mutation test',
        '3. Run the full unit suite',
      ].join('\n');

      expect(detectAsClaude(pane).isPrompt).toBe(false);
    });

    it('rejects the #1495 /model overlay even though it carries ❯-marked options', () => {
      // The overlay guard runs before option collection, so the Layer 5
      // exemption must never resurrect it.
      const result = detectAsClaude(CLAUDE_MODEL_OVERLAY_V2_1_218);
      expect(result.isPrompt).toBe(false);

      const status = detectSessionStatus(CLAUDE_MODEL_OVERLAY_V2_1_218, 'claude');
      expect(status.hasActivePrompt).toBe(false);
      expect(status.reason).toBe(STATUS_REASON.CLAUDE_SELECTION_LIST);
    });

    it('rejects a scrollback numbered list behind the composer ❯ barrier', () => {
      // A quoted/planned list above an idle composer must not become a prompt:
      // the reverse scan hits the bare composer ❯ first and bails out.
      const pane = [
        `${ESC}[38;5;114m⏺${ESC}[39m 次の手順で進めます:`,
        '',
        '  1. fixture を追加する',
        '  2. detector を直す',
        '  3. テストを更新する',
        '',
        `${ESC}[38;5;244m${'─'.repeat(120)}${ESC}[39m`,
        `${ESC}[38;5;246m❯ ${ESC}[39m`,
        `${ESC}[38;5;244m${'─'.repeat(120)}${ESC}[39m`,
        '  ⏸ manual mode on · ? for shortcuts · ← for agents',
      ].join('\n');

      const result = detectAsClaude(pane);
      expect(result.isPrompt).toBe(false);

      const status = detectSessionStatus(pane, 'claude');
      expect(status.status).not.toBe('waiting');
      expect(status.hasActivePrompt).toBe(false);
    });
  });
});

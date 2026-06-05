/**
 * Unit tests for schedule-ai-prompt-templates (Issue #827).
 *
 * These are the SSOT prompt builders for the ScheduleEditDialog "Ask AI"
 * buttons. They are pure functions, so we assert the exact ja wording / context
 * interpolation here and let the component tests assert only that the right
 * builder is wired.
 */

import { describe, it, expect } from 'vitest';
import { cronPrompt, messageDraftPrompt } from '@/lib/schedule-ai-prompt-templates';

describe('schedule-ai-prompt-templates', () => {
  describe('cronPrompt', () => {
    it('asks for cron candidates with a worked example when the input is empty', () => {
      const out = cronPrompt('');
      expect(out).toContain('cron 式');
      expect(out).toContain('候補をいくつか提案してください');
      expect(out).toContain('`0 9 * * 1`');
      // No "current input" clause when there is nothing to refine.
      expect(out).not.toContain('現在の入力は');
    });

    it('echoes the current cron input so the AI refines rather than restarts', () => {
      const out = cronPrompt('0 9 * * *');
      expect(out).toContain('現在の入力は `0 9 * * *` です。');
      expect(out).toContain('候補をいくつか提案してください');
    });

    it('trims whitespace around the current input', () => {
      const out = cronPrompt('   0 0 * * 0   ');
      expect(out).toContain('現在の入力は `0 0 * * 0` です。');
    });
  });

  describe('messageDraftPrompt', () => {
    it('names the schedule when provided', () => {
      const out = messageDraftPrompt('daily-review');
      expect(out).toContain('スケジュール `daily-review` で');
      expect(out).toContain('message（指示プロンプト）を作成');
      expect(out).toContain('まず用途を私に聞き取り');
    });

    it('falls back to a generic phrasing when the name is empty', () => {
      const out = messageDraftPrompt('   ');
      expect(out).toContain('このスケジュールで');
      expect(out).not.toContain('``');
    });
  });
});

/**
 * Unit tests for schedule-ai-prompt-templates (Issue #827, localized by #1307).
 *
 * Same contract as git-ai-prompt-templates.test.ts: the builders take the
 * caller's `t`, so they run here against a REAL next-intl translator over the
 * REAL dictionary. See that file's header for why `createTranslator` rather
 * than tests/helpers/real-intl.ts.
 */

import { describe, it, expect, vi } from 'vitest';

// tests/setup.ts mocks next-intl globally (and does not export createTranslator).
vi.mock('next-intl', async (importOriginal) =>
  await importOriginal<typeof import('next-intl')>()
);

import { createTranslator } from 'next-intl';
import {
  cronPrompt,
  messageDraftPrompt,
  type SchedulePromptTranslator,
} from '@/lib/schedule-ai-prompt-templates';
import enSchedule from '../../../locales/en/schedule.json';
import jaSchedule from '../../../locales/ja/schedule.json';

/** Real ICU translator bound the way ScheduleEditDialog binds it: t('schedule'). */
function makeT(locale: 'en' | 'ja'): SchedulePromptTranslator {
  return createTranslator({
    locale,
    messages: { schedule: locale === 'en' ? enSchedule : jaSchedule },
    namespace: 'schedule',
    onError: (error) => {
      throw error;
    },
  }) as unknown as SchedulePromptTranslator;
}

const ja = makeT('ja');
const en = makeT('en');

const CJK = /[぀-ヿ一-龯]/;

describe('schedule-ai-prompt-templates', () => {
  /**
   * Issue #1307: pinned to the pre-migration literals as emitted by the builders
   * at 3fad6d9c, not to the dictionary this change authored.
   */
  describe('ja output is byte-identical to the pre-migration hardcoded prompts', () => {
    it('cronPrompt', () => {
      expect(cronPrompt(ja, '')).toBe(
        'スケジュール実行のタイミングを cron 式で表現したいです。' +
          '自然言語の要望（例: 「毎週月曜 9 時」）を cron 式に変換し、候補をいくつか提案してください' +
          '（例: 「毎週月曜 9 時」→ `0 9 * * 1`）。'
      );
      expect(cronPrompt(ja, '0 9 * * *')).toBe(
        'スケジュール実行のタイミングを cron 式で表現したいです。現在の入力は `0 9 * * *` です。これを踏まえて、' +
          '自然言語の要望（例: 「毎週月曜 9 時」）を cron 式に変換し、候補をいくつか提案してください' +
          '（例: 「毎週月曜 9 時」→ `0 9 * * 1`）。'
      );
      expect(cronPrompt(ja, '   0 0 * * 0   ')).toBe(
        'スケジュール実行のタイミングを cron 式で表現したいです。現在の入力は `0 0 * * 0` です。これを踏まえて、' +
          '自然言語の要望（例: 「毎週月曜 9 時」）を cron 式に変換し、候補をいくつか提案してください' +
          '（例: 「毎週月曜 9 時」→ `0 9 * * 1`）。'
      );
    });

    it('messageDraftPrompt', () => {
      expect(messageDraftPrompt(ja, 'daily-review')).toBe(
        'スケジュール `daily-review` で CLI ツールに定期実行させる message（指示プロンプト）を作成したいです。' +
          'まず用途を私に聞き取り、それを踏まえた message の内容を提案してください。'
      );
      expect(messageDraftPrompt(ja, '   ')).toBe(
        'このスケジュールで CLI ツールに定期実行させる message（指示プロンプト）を作成したいです。' +
          'まず用途を私に聞き取り、それを踏まえた message の内容を提案してください。'
      );
    });
  });

  describe('en renders an English draft with the context interpolated', () => {
    it('cronPrompt asks for candidates with a worked example when the input is empty', () => {
      const out = cronPrompt(en, '');
      expect(out).toContain('cron expression');
      expect(out).toContain('suggest a few candidates');
      expect(out).toContain('`0 9 * * 1`');
      expect(out).not.toContain('The current input is');
    });

    it('cronPrompt echoes the current input so the AI refines rather than restarts', () => {
      expect(cronPrompt(en, '0 9 * * *')).toContain('The current input is `0 9 * * *`.');
      expect(cronPrompt(en, '   0 0 * * 0   ')).toContain('The current input is `0 0 * * 0`.');
    });

    it('messageDraftPrompt names the schedule when provided', () => {
      const out = messageDraftPrompt(en, 'daily-review');
      expect(out).toContain('For the schedule `daily-review`');
      expect(out).toContain('instruction prompt');
    });

    it('messageDraftPrompt falls back to a generic phrasing when the name is empty', () => {
      const out = messageDraftPrompt(en, '   ');
      expect(out).toContain('For this schedule');
      expect(out).not.toContain('``');
    });

    it('no en prompt leaks Japanese or an unresolved placeholder', () => {
      const outputs = [
        cronPrompt(en, ''),
        cronPrompt(en, '0 9 * * *'),
        messageDraftPrompt(en, 'daily-review'),
        messageDraftPrompt(en, ''),
      ];
      for (const out of outputs) {
        expect(CJK.test(out), `en prompt carries CJK: ${out}`).toBe(false);
        expect(out).not.toContain('aiPrompts');
      }
    });
  });
});

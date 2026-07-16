/**
 * Real-dictionary i18n guard for the worktree session / message surface (Issue #1276).
 *
 * The global next-intl mock in tests/setup.ts echoes `namespace.key` back, so a
 * component test renders `worktree.history.title` and still passes with the key
 * missing from the dictionary. Only a real-dictionary assert like this one stops
 * a raw key string from reaching the UI — the blind spot #1197 and #1273 both hit.
 *
 * Scope: the keys HistoryPane / HistorySearchBar / ConversationPairCard /
 * MessageList / MessageInput / SlashCommand* / InterruptButton resolve at runtime.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, `${namespace}.json`), 'utf-8')
  );
}

function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return leafKeys(value as Record<string, unknown>, full);
    }
    return [full];
  });
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

/** Keys each migrated component resolves at runtime. */
const REQUIRED: Record<string, string[]> = {
  worktree: [
    // HistoryPane
    'history.title',
    'history.regionLabel',
    'history.loading',
    'history.empty',
    'history.show',
    'history.displayLimit',
    'history.showArchived',
    'history.showUserOnly',
    'history.showAllMessages',
    'history.openSearch',
    'history.closeSearch',
    'history.copied',
    'history.copyFailed',
    // HistorySearchBar
    'history.search.regionLabel',
    'history.search.placeholder',
    'history.search.keywordLabel',
    'history.search.prev',
    'history.search.next',
    'history.search.close',
    'history.search.countAtMax',
    // ConversationPairCard
    'conversation.waitingForResponse',
    'conversation.you',
    'conversation.assistant',
    'conversation.sending',
    'conversation.failedToSend',
    'conversation.retrySending',
    'conversation.discard',
    'conversation.discardMessage',
    'conversation.insertToMessage',
    'conversation.copy',
    'conversation.copyMessage',
    'conversation.collapse',
    'conversation.expand',
    'conversation.collapseMessage',
    'conversation.expandMessage',
    'conversation.systemMessage',
    'conversation.systemMessageLabel',
    'conversation.openFile',
    'conversation.conversationLabel',
    // MessageList
    'messages.loading',
    'messages.empty',
    'messages.you',
    'messages.copy',
    'messages.copyMessage',
    'messages.viewLogFile',
    // MessageInput
    'composer.removeAttachment',
    'composer.showSlashCommands',
    'composer.attachImage',
    'composer.sendMessage',
    // SlashCommandSelector / SlashCommandList
    'slashCommands.title',
    'slashCommands.searchPlaceholder',
    'slashCommands.enterCustomCommand',
    'slashCommands.selectHint',
    'slashCommands.closeHint',
    'slashCommands.empty',
    // InterruptButton
    'interrupt.stopProcessing',
  ],
  prompt: ['yesNoGroupLabel', 'selectAnOption', 'customValueInput'],
  autoYes: ['label', 'toggleLabel', 'targetLabel', 'timeRemaining'],
};

describe('worktree session/message i18n keys (Issue #1276)', () => {
  describe.each(Object.entries(REQUIRED))('%s namespace', (namespace, keys) => {
    it.each(LOCALES)('%s resolves every required key to a non-empty string', (locale) => {
      const dict = load(locale, namespace);
      for (const key of keys) {
        const value = resolve(dict, key);
        expect(typeof value, `${locale}/${namespace}.json: ${key}`).toBe('string');
        expect(value, `${locale}/${namespace}.json: ${key}`).not.toBe('');
      }
    });

    it('en and ja expose the identical set of keys (parity)', () => {
      expect(leafKeys(load('en', namespace)).sort()).toEqual(
        leafKeys(load('ja', namespace)).sort()
      );
    });
  });

  /**
   * A key echoed verbatim (`worktree.history.title`) is exactly what the global
   * mock produces, so a value that merely repeats its own key path would satisfy
   * a naive presence check while rendering as gibberish.
   */
  it('no value is a verbatim echo of its own key path', () => {
    for (const locale of LOCALES) {
      for (const [namespace, keys] of Object.entries(REQUIRED)) {
        const dict = load(locale, namespace);
        for (const key of keys) {
          const value = resolve(dict, key);
          expect(value, `${locale}/${namespace}: ${key}`).not.toBe(key);
          expect(value, `${locale}/${namespace}: ${key}`).not.toBe(`${namespace}.${key}`);
        }
      }
    }
  });

  /**
   * Interpolated keys must keep their ICU placeholders in every locale — dropping
   * `{path}` silently renders a label with no file name in it.
   */
  it.each([
    ['worktree', 'conversation.openFile', ['{path}']],
    ['worktree', 'conversation.conversationLabel', ['{preview}']],
    ['worktree', 'history.search.countAtMax', ['{current}', '{max}']],
  ])('%s.%s keeps its placeholders in every locale', (namespace, key, placeholders) => {
    for (const locale of LOCALES) {
      const value = resolve(load(locale, namespace), key) as string;
      for (const ph of placeholders) {
        expect(value, `${locale}/${namespace}: ${key} lost ${ph}`).toContain(ph);
      }
    }
  });

  /**
   * Issue #1276: HistorySearchBar shipped hardcoded Japanese in *both* locales.
   * These asserts pin the JA wording to the pre-migration literals (no user-visible
   * change for ja) and prove en is no longer serving Japanese.
   */
  it('history.search preserves the pre-migration Japanese wording in ja', () => {
    const ja = load('ja', 'worktree');
    expect(resolve(ja, 'history.search.regionLabel')).toBe('履歴内テキスト検索');
    expect(resolve(ja, 'history.search.placeholder')).toBe('検索...');
    expect(resolve(ja, 'history.search.keywordLabel')).toBe('検索キーワード');
    expect(resolve(ja, 'history.search.prev')).toBe('前の結果 (prev)');
    expect(resolve(ja, 'history.search.next')).toBe('次の結果 (next)');
    expect(resolve(ja, 'history.search.close')).toBe('検索を閉じる (close)');
  });

  it('en/worktree.json carries no CJK text', () => {
    const en = load('en', 'worktree');
    for (const key of leafKeys(en)) {
      const value = resolve(en, key);
      if (typeof value !== 'string') continue;
      expect(
        /[぀-ヿ一-龯]/.test(value),
        `en/worktree.json: ${key} = ${value}`
      ).toBe(false);
    }
  });
});

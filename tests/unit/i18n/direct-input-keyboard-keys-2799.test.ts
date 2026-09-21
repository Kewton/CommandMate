/**
 * Real-dictionary i18n guard for the phone's direct-input keyboard (Issue #2799).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so a component test stays green with every key missing from `locales/`, and
 * in production a missing key renders as the literal key — as the
 * `aria-label` of `↑` or `×`, which is the ONLY thing naming those buttons.
 * Same shape as `surface-mode-keys-2193.test.ts`.
 *
 * It also pins that PC's six `directInput.*` keys (`DirectInputBar`, #2766)
 * were left exactly as they were: the phone got its own section.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SPECIAL_KEY_ROWS } from '@/config/mobile-keyboard-layout';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'));
}

/** Every `directInputKeyboard.*` key the sheet row and the keyboard request. */
const KEYBOARD_KEYS = [
  'menuItem',
  'unavailableTab',
  'unavailableChat',
  'unavailableSession',
  'groupLabel',
  'confirmRowLabel',
  'specialKeysLabel',
  'charKeysLabel',
  'stagedLabel',
  'stagedCount',
  'chipRepeat',
  'send',
  'sendAria',
  'undo',
  'undoAria',
  'clearAll',
  'close',
  'closeAria',
  'showChars',
  'hideChars',
  'full',
  'sendFailed',
  'acknowledge',
];

/** `aria-label`s of the keys: every special key id, plus the space bar and the two page keys. */
const KEY_LABEL_KEYS = [
  ...SPECIAL_KEY_ROWS.flat().map((def) => def.id),
  'space',
  'toSymbols',
  'toAlpha',
];

const PLACEHOLDERS: Record<string, string[]> = {
  stagedCount: ['{count}'],
  chipRepeat: ['{key}', '{count}'],
  send: ['{count}'],
  sendAria: ['{count}'],
  full: ['{max}'],
};

/** PC's `DirectInputBar` strings (#2766). Unchanged by #2799. */
const PC_DIRECT_INPUT = {
  en: {
    toggle: 'Direct input',
    toggleAria: 'Send keystrokes straight to the terminal',
    notice: "Direct input is on. Every key you type here goes straight to the agent's terminal.",
    placeholder: 'Type here…',
    close: 'Exit direct input',
    error: 'Could not send. Check the session and try again.',
  },
  ja: {
    toggle: '直接入力',
    toggleAria: 'キー入力をそのままターミナルへ送る',
    notice: '直接入力中です。ここで打ったキーは、そのままエージェントのターミナルへ送られます。',
    placeholder: 'ここに入力…',
    close: '直接入力を終了',
    error: '送信できませんでした。セッションの状態を確認してください。',
  },
} as const;

describe('[#2799] worktree.directInputKeyboard i18n', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every key the sheet row and the keyboard request`, () => {
      const section = load(locale).directInputKeyboard as Record<string, unknown> | undefined;
      expect(section, `${locale}: worktree.directInputKeyboard`).toBeTypeOf('object');
      for (const key of KEYBOARD_KEYS) {
        const value = section?.[key];
        expect(value, `${locale}: directInputKeyboard.${key}`).toBeTypeOf('string');
        expect(String(value).trim().length, `${locale}: directInputKeyboard.${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} names every key with a symbol face`, () => {
      const keys = (load(locale).directInputKeyboard as Record<string, unknown>).keys as Record<string, unknown>;
      for (const key of KEY_LABEL_KEYS) {
        expect(keys?.[key], `${locale}: directInputKeyboard.keys.${key}`).toBeTypeOf('string');
      }
    });

    it(`${locale} keeps the interpolation placeholders`, () => {
      const section = load(locale).directInputKeyboard as Record<string, string>;
      for (const [key, tokens] of Object.entries(PLACEHOLDERS)) {
        for (const token of tokens) expect(section[key], `${locale}: ${key}`).toContain(token);
      }
    });

    it(`${locale} leaves PC's six directInput keys exactly as they were`, () => {
      expect(load(locale).directInput).toEqual(PC_DIRECT_INPUT[locale]);
    });
  }

  it('ja reads as Japanese and en does not', () => {
    const ja = load('ja').directInputKeyboard as Record<string, string>;
    const en = load('en').directInputKeyboard as Record<string, string>;
    expect(/[぀-ヿ一-龯]/.test(ja.sendFailed)).toBe(true);
    expect(/[぀-ヿ一-龯]/.test(en.sendFailed)).toBe(false);
    // The Issue's own words for the two lines a user must not misread.
    expect(ja.sendFailed).toContain('途中まで届いている場合があります');
    expect(ja.full.replace('{max}', '32')).toBe('32 件までです。送信するか取り消してください');
    expect(ja.send.replace('{count}', '3')).toBe('送信 (3)');
    expect(ja.undo).toBe('取消');
    expect(ja.close).toBe('閉じる');
  });

  it('en and ja declare exactly the same keys', () => {
    const shape = (locale: string): string[] => {
      const section = load(locale).directInputKeyboard as Record<string, unknown>;
      return [
        ...Object.keys(section),
        ...Object.keys(section.keys as object).map((key) => `keys.${key}`),
      ].sort();
    };
    expect(shape('ja')).toEqual(shape('en'));
  });
});

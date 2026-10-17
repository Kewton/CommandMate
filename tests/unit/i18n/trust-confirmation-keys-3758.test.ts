/**
 * 信頼の確認の文言が ja・en の辞書にある（Issue #3758）
 *
 * `tests/setup.ts` の next-intl のモックはキーをそのまま返すので、部品の suite は辞書に
 * キーが無くても緑になる。本番では `chatSurface.reasonTrustConfirmation` という文字列が
 * そのまま帯に出る。それを止めるのがこのファイル。
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'));
}

describe('[#3758] 信頼の確認の文言', () => {
  for (const locale of LOCALES) {
    it(`${locale}: 帯（chatSurface）とターミナル面の注意（trustConfirmation）の両方がある`, () => {
      const dict = load(locale);
      for (const [section, key] of [
        ['chatSurface', 'reasonTrustConfirmation'],
        ['trustConfirmation', 'notice'],
      ] as const) {
        const value = dict[section]?.[key];
        expect(value, `${locale}: ${section}.${key}`).toBeTypeOf('string');
        expect(String(value).trim().length, `${locale}: ${section}.${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale}: 帯は「選択リスト」の文と違う（どの画面かを言う）`, () => {
      const chat = load(locale).chatSurface;
      expect(chat.reasonTrustConfirmation).not.toBe(chat.reasonSelectionList);
    });
  }

  it('ja は「端末で操作が必要」と「信頼の確認」を言う', () => {
    const dict = load('ja');
    for (const value of [dict.chatSurface.reasonTrustConfirmation, dict.trustConfirmation.notice]) {
      expect(value).toContain('端末で操作が必要');
      expect(value).toContain('信頼の確認');
    }
  });
});

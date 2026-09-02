/**
 * Real-dictionary i18n guard for the chat transcript (Issue #2232).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so every component test of `ChatTranscript` stays green with the whole section
 * missing from `locales/`. `src/i18n.ts` has no `onError` and no
 * `getMessageFallback`, so in production a missing key renders as the literal
 * `chatTranscript.empty` — in the middle of an empty conversation, which is the
 * one moment the surface has nothing else to say. This file stands between those
 * two facts.
 *
 * `emptyHint` moved here from `worktree.chatSurface` in the same Issue: the chat
 * surface used to draw its own empty-state line on top of the transcript's, and
 * folding the duplicate into one place is why the key changed namespace. The
 * companion guard on the section it left is `chat-surface-keys-2194.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function loadWorktree(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'));
}

function loadChatTranscript(locale: string): Record<string, string> {
  return loadWorktree(locale).chatTranscript as Record<string, string>;
}

/** Every `chatTranscript.*` key the component requests at runtime. */
const CHAT_TRANSCRIPT_KEYS = ['regionLabel', 'loading', 'empty', 'emptyHint', 'openSearch'];

describe('[#2232] worktree.chatTranscript i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every chatTranscript key the transcript requests`, () => {
      const section = loadChatTranscript(locale);
      expect(section, `${locale}: worktree.chatTranscript`).toBeTypeOf('object');
      for (const key of CHAT_TRANSCRIPT_KEYS) {
        expect(section?.[key], `${locale}: chatTranscript.${key}`).toBeTypeOf('string');
        expect(
          String(section?.[key]).trim().length,
          `${locale}: chatTranscript.${key}`,
        ).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps the empty state and its hint saying different things`, () => {
      const section = loadChatTranscript(locale);
      expect(section.empty).not.toBe(section.emptyHint);
    });

    it(`${locale} no longer carries the duplicate chatSurface.emptyHint`, () => {
      // Two empty states on one surface was the defect; leaving the old key in
      // place would let a later edit quietly re-add the second one.
      expect(loadWorktree(locale).chatSurface).not.toHaveProperty('emptyHint');
    });
  }

  it('leaves no English string in the ja dictionary (or vice versa)', () => {
    const isJapanese = (value: string) => /[぀-ヿ一-龯]/.test(value);
    expect(isJapanese(loadChatTranscript('ja').openSearch)).toBe(true);
    expect(isJapanese(loadChatTranscript('en').openSearch)).toBe(false);
  });

  it('en and ja declare exactly the same chatTranscript keys', () => {
    expect(Object.keys(loadChatTranscript('ja')).sort()).toEqual(
      Object.keys(loadChatTranscript('en')).sort(),
    );
  });
});

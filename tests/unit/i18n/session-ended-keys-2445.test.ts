/**
 * Real-dictionary i18n guard for the ended-session vocabulary (Issue #2445).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so every component test of `TerminalDisplay` and `ChatTranscript` stays green
 * with the whole section missing from `locales/`. `src/i18n.ts` has no
 * `onError` and no `getMessageFallback`, so in production a missing key renders
 * as the literal `terminal.sessionEnded` — in the one place a reader is being
 * told why the pane is empty. This file stands between those two facts.
 *
 * ## The shared key is the point
 *
 * `terminal.sessionEnded` is requested by BOTH output surfaces: it is
 * `TerminalDisplay`'s #842 ended placeholder and the first line of the chat
 * surface's ended banner. Two keys would let the terminal and the chat describe
 * the same dead session differently, which is the drift this Issue folded away
 * — so the sentence being one string is asserted here, not just its presence.
 *
 * The chat-only supplement ("you can view the previous conversation in
 * History") is deliberately a SEPARATE key: the terminal has no History column
 * to point at.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

type Section = Record<string, unknown>;

function loadWorktree(locale: string): Section {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'));
}

function terminal(locale: string): Record<string, string> {
  return loadWorktree(locale).terminal as Record<string, string>;
}

function previousSession(locale: string): Record<string, string> {
  return (loadWorktree(locale).chatTranscript as Section).previousSession as Record<string, string>;
}

/** Every `terminal.*` key Issue #2445 moved out of `TerminalDisplay.tsx`. */
const TERMINAL_KEYS = ['loading', 'sessionEnded'];

/** Every `chatTranscript.previousSession.*` key the fold and its banner request. */
const PREVIOUS_SESSION_KEYS = ['summary', 'expand', 'collapse', 'hint'];

describe('[#2445] worktree.terminal placeholders are in the dictionary', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every key the terminal placeholders request`, () => {
      const section = terminal(locale);
      for (const key of TERMINAL_KEYS) {
        expect(section?.[key], `${locale}: terminal.${key}`).toBeTypeOf('string');
        expect(String(section?.[key]).trim().length, `${locale}: terminal.${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps loading and sessionEnded saying different things`, () => {
      expect(terminal(locale).loading).not.toBe(terminal(locale).sessionEnded);
    });
  }

  it('leaves no English string in the ja dictionary (or vice versa)', () => {
    const isJapanese = (value: string) => /[぀-ヿ一-龯]/.test(value);
    expect(isJapanese(terminal('ja').sessionEnded)).toBe(true);
    expect(isJapanese(terminal('en').sessionEnded)).toBe(false);
  });

  it('no longer carries the sentence as a literal in the component', () => {
    // The mutation this catches is the obvious one: adding the keys and leaving
    // the hardcoded Japanese in place, which no rendering test would notice
    // (the global next-intl mock echoes keys, so both would "work").
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/components/worktree/TerminalDisplay.tsx'),
      'utf-8',
    );
    expect(source).not.toContain('読込中');
    expect(source).not.toContain('セッションは終了しました');
    expect(source).toContain("t('terminal.loading')");
    expect(source).toContain("t('terminal.sessionEnded')");
  });
});

describe('[#2445] the ended sentence is ONE string for both surfaces', () => {
  it('is requested by the terminal placeholder and the chat banner alike', () => {
    const terminalSource = fs.readFileSync(
      path.resolve(__dirname, '../../../src/components/worktree/TerminalDisplay.tsx'),
      'utf-8',
    );
    const chatSource = fs.readFileSync(
      path.resolve(__dirname, '../../../src/components/worktree/ChatTranscript.tsx'),
      'utf-8',
    );
    expect(terminalSource).toContain("t('terminal.sessionEnded')");
    expect(chatSource).toContain("t('terminal.sessionEnded')");
  });
});

describe('[#2445] worktree.chatTranscript.previousSession i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every previousSession key the fold requests`, () => {
      const section = previousSession(locale);
      expect(section, `${locale}: chatTranscript.previousSession`).toBeTypeOf('object');
      for (const key of PREVIOUS_SESSION_KEYS) {
        expect(section?.[key], `${locale}: previousSession.${key}`).toBeTypeOf('string');
        expect(
          String(section?.[key]).trim().length,
          `${locale}: previousSession.${key}`,
        ).toBeGreaterThan(0);
      }
    });

    it(`${locale} interpolates {count} in the fold's summary`, () => {
      // The count is the whole information the closed fold carries; a locale
      // that dropped the placeholder would render a label with no number.
      expect(previousSession(locale).summary).toContain('{count}');
    });

    it(`${locale} keeps expand and collapse distinguishable`, () => {
      expect(previousSession(locale).expand).not.toBe(previousSession(locale).collapse);
    });
  }

  it('en and ja declare exactly the same previousSession keys', () => {
    expect(Object.keys(previousSession('ja')).sort()).toEqual(
      Object.keys(previousSession('en')).sort(),
    );
  });

  it('en and ja declare exactly the same terminal keys', () => {
    expect(Object.keys(terminal('ja')).sort()).toEqual(Object.keys(terminal('en')).sort());
  });
});

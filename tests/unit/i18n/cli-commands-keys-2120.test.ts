/**
 * Real-dictionary i18n guard for the `worktree.cliCommands.*` keys
 * (Issue #2120).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so the panel's component test stays green with every key of this Issue
 * missing from `locales/`. `src/i18n.ts` has no `onError` and no
 * `getMessageFallback`, so in production a missing key renders as the literal
 * string `cliCommands.noteRespondNumber` — and the three notes this panel is
 * required to carry ARE the safeguard: they are what stops an operator from
 * pasting `respond … "yes"` and selecting whatever the default option happened
 * to be.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

type Dict = Record<string, unknown>;

function loadCliCommands(locale: string): Dict {
  const worktree = JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'),
  ) as Dict;
  return worktree.cliCommands as Dict;
}

/** Read `a.b.c` out of the nested block, as next-intl would. */
function at(dict: Dict, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (node, part) => (node as Dict | undefined)?.[part],
    dict,
  );
}

/** Every key the panel requests at runtime. */
const KEYS = [
  'open',
  'title',
  'loading',
  'loadError',
  'retry',
  'messagePlaceholder',
  'target',
  'resolvedBy.explicit',
  'resolvedBy.roster',
  'resolvedBy.primary',
  'resolvedBy.worktree-default',
  'resolvedBy.fallback',
  'resolvedBy.client-fallback',
  'conflict',
  'commandLabel.send',
  'commandLabel.wait',
  'commandLabel.capture',
  'commandLabel.respond',
  'commandDescription.send',
  'commandDescription.wait',
  'commandDescription.capture',
  'commandDescription.respond',
  'copy',
  'copied',
  'copyFailed',
  'portHint',
  'notesTitle',
  'noteInstanceFlag',
  'noteWaitOnPrompt',
  'noteRespondNumber',
];

/** Keys whose message MUST carry an interpolation placeholder. */
const PLACEHOLDERS: Record<string, string[]> = {
  title: ['{alias}'],
  target: ['{instance}', '{tool}', '{stage}'],
  conflict: ['{instance}', '{roster}', '{requested}'],
  portHint: ['{port}'],
};

/**
 * The three notes are acceptance criteria, not decoration. Each must actually
 * name the flag or the failure it is about — a note translated into a vague
 * sentence that drops `--on-prompt human` teaches nothing.
 */
const NOTE_SUBSTRINGS: Record<string, string[]> = {
  noteInstanceFlag: ['--instance', '--agent', 'wait'],
  noteWaitOnPrompt: ['--on-prompt human', '10'],
  noteRespondNumber: ['respond', 'yes'],
};

describe('[#2120] worktree.cliCommands i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every key the panel requests`, () => {
      const dict = loadCliCommands(locale);
      for (const key of KEYS) {
        const value = at(dict, key);
        expect(value, `${locale}: ${key}`).toBeTypeOf('string');
        expect((value as string).length, `${locale}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps the interpolation placeholders the panel passes`, () => {
      const dict = loadCliCommands(locale);
      for (const [key, tokens] of Object.entries(PLACEHOLDERS)) {
        const value = at(dict, key) as string;
        for (const token of tokens) {
          expect(value, `${locale}: ${key}`).toContain(token);
        }
      }
    });

    it(`${locale} keeps each note about the thing it is a note about`, () => {
      const dict = loadCliCommands(locale);
      for (const [key, tokens] of Object.entries(NOTE_SUBSTRINGS)) {
        const value = at(dict, key) as string;
        for (const token of tokens) {
          expect(value, `${locale}: ${key}`).toContain(token);
        }
      }
    });
  }

  it('has the same cliCommands key set in both locales', () => {
    const flatten = (dict: Dict, prefix = ''): string[] =>
      Object.entries(dict).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null
          ? flatten(value as Dict, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      );
    const en = flatten(loadCliCommands('en')).sort();
    const ja = flatten(loadCliCommands('ja')).sort();
    expect(ja).toEqual(en);
    // No key in the dictionary that the panel never asks for, and none the
    // panel asks for that the dictionary does not have.
    expect(en).toEqual([...KEYS].sort());
  });

  it('does not translate `message` in a way that breaks the send example', () => {
    // The placeholder is rendered inside double quotes in a shell line, so a
    // translation containing a double quote would end the argument early and
    // hand the rest to the shell as flags.
    for (const locale of LOCALES) {
      const placeholder = at(loadCliCommands(locale), 'messagePlaceholder') as string;
      expect(placeholder, locale).not.toContain('"');
    }
  });
});

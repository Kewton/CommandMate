/**
 * Locale dictionary helpers (Issue #1704).
 *
 * Extracted from scripts/refresh-slash-command-catalog.ts so the write side and
 * the read side can be checked against each other. Behavior is unchanged from
 * the runner's inline version; what is new is that a key can now be one level
 * deeper than the command name, which is where the string-to-object transition
 * below actually happens.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  applyLocaleAdditions,
  lookupNestedValue,
  setNestedValue,
  type LocaleDictionary,
} from '@/lib/slash-command-reconcile/locale';

describe('setNestedValue', () => {
  it('creates missing intermediate objects', () => {
    const dict: LocaleDictionary = {};
    setNestedValue(dict, 'slashCommands.descriptions.loop', 'Run a prompt repeatedly');
    expect(dict).toEqual({
      slashCommands: { descriptions: { loop: 'Run a prompt repeatedly' } },
    });
  });

  it('leaves sibling keys alone', () => {
    const dict: LocaleDictionary = {
      slashCommands: { descriptions: { clear: 'Clear the conversation' } },
    };
    setNestedValue(dict, 'slashCommands.descriptions.loop', 'Run a prompt repeatedly');
    expect(dict).toEqual({
      slashCommands: {
        descriptions: { clear: 'Clear the conversation', loop: 'Run a prompt repeatedly' },
      },
    });
  });

  // The upgrade path for a command that turns out to be contested: the flat
  // string a previous release shipped has to become an object, because JSON
  // cannot hold `descriptions.btw` as a string and `descriptions.btw.codex` at
  // the same time. The old value is intentionally dropped — a split rewrites
  // both sides, so nothing is left pointing at it.
  it('replaces a flat string with the object a tool-scoped key needs', () => {
    const dict: LocaleDictionary = {
      slashCommands: { descriptions: { btw: 'the shared sentence' } },
    };
    setNestedValue(dict, 'slashCommands.descriptions.btw.claude', 'claude sentence');
    setNestedValue(dict, 'slashCommands.descriptions.btw.codex', 'codex sentence');
    expect(dict).toEqual({
      slashCommands: {
        descriptions: { btw: { claude: 'claude sentence', codex: 'codex sentence' } },
      },
    });
  });
});

describe('lookupNestedValue', () => {
  const dict = {
    slashCommands: { descriptions: { clear: 'Clear', btw: { codex: 'codex sentence' } } },
  };

  it('resolves flat and tool-scoped keys alike', () => {
    expect(lookupNestedValue(dict, 'slashCommands.descriptions.clear')).toBe('Clear');
    expect(lookupNestedValue(dict, 'slashCommands.descriptions.btw.codex')).toBe('codex sentence');
  });

  it('returns undefined for a missing path or a non-string node', () => {
    expect(lookupNestedValue(dict, 'slashCommands.descriptions.nope')).toBeUndefined();
    expect(lookupNestedValue(dict, 'slashCommands.descriptions.clear.codex')).toBeUndefined();
    // A key that lands on the object itself is not a description.
    expect(lookupNestedValue(dict, 'slashCommands.descriptions.btw')).toBeUndefined();
    expect(lookupNestedValue(undefined, 'a.b')).toBeUndefined();
  });
});

describe('applyLocaleAdditions', () => {
  it('writes the picked language for every addition', () => {
    const additions = [
      { key: 'slashCommands.descriptions.a', en: 'A', ja: 'あ' },
      { key: 'slashCommands.descriptions.b', en: 'B', ja: 'い' },
    ];
    expect(applyLocaleAdditions({}, additions, (a) => a.ja)).toEqual({
      slashCommands: { descriptions: { a: 'あ', b: 'い' } },
    });
  });

  it('is a no-op for an empty addition list', () => {
    const dict: LocaleDictionary = { slashCommands: { descriptions: { a: 'A' } } };
    expect(applyLocaleAdditions(dict, [], (a) => a.en)).toEqual({
      slashCommands: { descriptions: { a: 'A' } },
    });
  });
});

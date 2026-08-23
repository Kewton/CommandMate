/**
 * Env Manager — parser / serializer (Issue #1968).
 *
 * The parser is what the whole feature stands on: the Key-Value view, the
 * masking of the Raw view and the validation messages are all derived from its
 * output. Two properties matter most here and are asserted directly rather than
 * inferred:
 *
 *   1. ROUND-TRIP — `parse(serialize(x))` gives back `x`. Without it a save
 *      would quietly rewrite values (a trailing space, a `#`, a newline).
 *   2. COMMENT PRESERVATION — `applyEnvRows` writes an edit back over the line
 *      it came from, so comments and blank lines survive a Key-Value edit.
 */

import { describe, it, expect } from 'vitest';
import {
  applyEnvRows,
  formatEnvValue,
  isValidEnvKey,
  needsQuoting,
  parseEnvContent,
  serializeEnvEntries,
} from '@/lib/env-manager/env-parser';

describe('parseEnvContent', () => {
  it('parses plain assignments with their line numbers', () => {
    const { entries, issues } = parseEnvContent('A=1\nB=two\n');
    expect(issues).toEqual([]);
    expect(entries).toEqual([
      { key: 'A', value: '1', line: 1, endLine: 1, exported: false, quote: null },
      { key: 'B', value: 'two', line: 2, endLine: 2, exported: false, quote: null },
    ]);
  });

  it('skips comments and blank lines without reporting them', () => {
    const { entries, issues } = parseEnvContent('# a comment\n\n   \nA=1\n');
    expect(issues).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].line).toBe(4);
  });

  it('honours an `export ` prefix', () => {
    const { entries } = parseEnvContent('export TOKEN=abc\n');
    expect(entries[0]).toMatchObject({ key: 'TOKEN', value: 'abc', exported: true });
  });

  it('strips an inline comment from an unquoted value', () => {
    const { entries } = parseEnvContent('A=value # trailing note\n');
    expect(entries[0].value).toBe('value');
  });

  it('keeps a `#` that is not preceded by whitespace', () => {
    const { entries } = parseEnvContent('COLOR=#ff0000\n');
    expect(entries[0].value).toBe('#ff0000');
  });

  it('resolves escapes inside a double-quoted value', () => {
    const { entries } = parseEnvContent('A="line1\\nline2\\ttab \\"quoted\\" back\\\\slash"\n');
    expect(entries[0].value).toBe('line1\nline2\ttab "quoted" back\\slash');
    expect(entries[0].quote).toBe('"');
  });

  it('treats a single-quoted value as literal', () => {
    const { entries } = parseEnvContent("A='no \\n escape # nor comment'\n");
    expect(entries[0].value).toBe('no \\n escape # nor comment');
    expect(entries[0].quote).toBe("'");
  });

  it('carries a quoted value across physical lines and records endLine', () => {
    const raw = 'KEY="-----BEGIN-----\nmiddle\n-----END-----"\nAFTER=1\n';
    const { entries, issues } = parseEnvContent(raw);
    expect(issues).toEqual([]);
    expect(entries[0]).toMatchObject({
      key: 'KEY',
      value: '-----BEGIN-----\nmiddle\n-----END-----',
      line: 1,
      endLine: 3,
    });
    expect(entries[1]).toMatchObject({ key: 'AFTER', line: 4 });
  });

  it('handles CRLF input', () => {
    const { entries } = parseEnvContent('A=1\r\nB=2\r\n');
    expect(entries.map((e) => [e.key, e.value, e.line])).toEqual([
      ['A', '1', 1],
      ['B', '2', 2],
    ]);
  });

  describe('issues (never carry a value)', () => {
    it('reports a line with no `=` as invalid syntax', () => {
      const { issues } = parseEnvContent('JUST_A_WORD\n');
      expect(issues).toEqual([{ line: 1, code: 'invalid-syntax', severity: 'error' }]);
    });

    it('reports an invalid variable name', () => {
      const { issues, entries } = parseEnvContent('1BAD=x\n');
      expect(entries).toHaveLength(0);
      expect(issues[0]).toMatchObject({ line: 1, code: 'invalid-key', severity: 'error' });
    });

    it('reports an unterminated quote', () => {
      const { issues } = parseEnvContent('A="never closed\n');
      expect(issues[0]).toMatchObject({ code: 'unterminated-quote', severity: 'error', key: 'A' });
    });

    it('reports a duplicate key as a warning, keeping both entries', () => {
      const { issues, entries } = parseEnvContent('A=1\nA=2\n');
      expect(entries).toHaveLength(2);
      expect(issues).toEqual([{ line: 2, code: 'duplicate-key', severity: 'warning', key: 'A' }]);
    });

    it('never puts a value into an issue', () => {
      const secret = 'super-secret-token-value';
      const { issues } = parseEnvContent(`1BAD=${secret}\nA="unclosed ${secret}\n`);
      expect(issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(issues)).not.toContain(secret);
    });
  });
});

describe('isValidEnvKey', () => {
  it.each(['A', '_A', 'API_KEY', 'a1'])('accepts %s', (key) => {
    expect(isValidEnvKey(key)).toBe(true);
  });
  it.each(['1A', 'A-B', 'A B', '', 'A.B', 'A=B'])('rejects %j', (key) => {
    expect(isValidEnvKey(key)).toBe(false);
  });
});

describe('formatEnvValue / needsQuoting', () => {
  it('leaves a simple value unquoted', () => {
    expect(needsQuoting('abc123')).toBe(false);
    expect(formatEnvValue('abc123')).toBe('abc123');
  });

  it.each([' leading', 'trailing ', 'with space', 'has#hash', "has'quote", 'has"quote', 'has$dollar', 'back\\slash', 'multi\nline'])(
    'quotes %j',
    (value) => {
      expect(needsQuoting(value)).toBe(true);
      expect(formatEnvValue(value).startsWith('"')).toBe(true);
    },
  );

  it('escapes what it wraps', () => {
    expect(formatEnvValue('a"b')).toBe('"a\\"b"');
    expect(formatEnvValue('a\\b')).toBe('"a\\\\b"');
    expect(formatEnvValue('a\nb')).toBe('"a\\nb"');
  });
});

describe('serializeEnvEntries round-trip', () => {
  const VALUES = [
    'simple',
    '',
    'with space',
    ' leading and trailing ',
    'hash # inside',
    'quote " inside',
    "apostrophe ' inside",
    'back\\slash',
    'dollar $HOME',
    'multi\nline\nvalue',
    'tab\tseparated',
  ];

  it('preserves every value exactly', () => {
    const entries = VALUES.map((value, index) => ({ key: `K${index}`, value }));
    const text = serializeEnvEntries(entries);
    const reparsed = parseEnvContent(text);
    expect(reparsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(reparsed.entries.map((e) => ({ key: e.key, value: e.value }))).toEqual(entries);
  });

  it('keeps an `export ` prefix', () => {
    expect(serializeEnvEntries([{ key: 'A', value: '1', exported: true }])).toBe('export A=1\n');
  });

  it('returns the empty string for no entries', () => {
    expect(serializeEnvEntries([])).toBe('');
  });
});

describe('applyEnvRows', () => {
  const RAW = [
    '# Database settings',
    'DB_HOST=localhost',
    '',
    '# Secrets below',
    'API_KEY=old-secret',
    '',
  ].join('\n');

  function rowsOf(raw: string) {
    const { entries } = parseEnvContent(raw);
    return {
      entries,
      rows: entries.map((entry) => ({
        key: entry.key,
        value: entry.value,
        sourceLine: entry.line,
      })),
    };
  }

  it('is a no-op when nothing changed', () => {
    const { entries, rows } = rowsOf(RAW);
    expect(applyEnvRows(RAW, entries, rows)).toBe(RAW);
  });

  it('preserves comments and blank lines while changing one value', () => {
    const { entries, rows } = rowsOf(RAW);
    rows[1] = { ...rows[1], value: 'new-secret' };
    const result = applyEnvRows(RAW, entries, rows);

    expect(result).toContain('# Database settings');
    expect(result).toContain('# Secrets below');
    expect(result).toContain('API_KEY=new-secret');
    expect(result).not.toContain('old-secret');
    // The blank line between the two blocks survives.
    expect(result.split('\n')[2]).toBe('');
  });

  it('renames a key in place', () => {
    const { entries, rows } = rowsOf(RAW);
    rows[0] = { ...rows[0], key: 'DATABASE_HOST' };
    const result = applyEnvRows(RAW, entries, rows);
    expect(result).toContain('DATABASE_HOST=localhost');
    expect(result).not.toContain('DB_HOST=');
  });

  it('deletes the line of a row that was removed', () => {
    const { entries, rows } = rowsOf(RAW);
    const result = applyEnvRows(RAW, entries, [rows[0]]);
    expect(result).not.toContain('API_KEY');
    expect(result).toContain('# Secrets below');
  });

  it('appends a brand-new row at the end', () => {
    const { entries, rows } = rowsOf(RAW);
    const result = applyEnvRows(RAW, entries, [
      ...rows,
      { key: 'NEW_KEY', value: 'new value', sourceLine: null },
    ]);
    expect(result.trimEnd().split('\n').at(-1)).toBe('NEW_KEY="new value"');
  });

  it('replaces a multi-line quoted value with a single line', () => {
    const raw = 'BEFORE=1\nPEM="-----BEGIN-----\nbody\n-----END-----"\nAFTER=2\n';
    const { entries, rows } = rowsOf(raw);
    rows[1] = { ...rows[1], value: 'short' };
    const result = applyEnvRows(raw, entries, rows);
    expect(result).toBe('BEFORE=1\nPEM=short\nAFTER=2\n');
  });

  it('starts from nothing when the file is empty', () => {
    expect(applyEnvRows('', [], [{ key: 'A', value: '1', sourceLine: null }])).toBe('A=1\n');
  });
});

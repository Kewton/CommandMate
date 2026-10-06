/**
 * Issue #3300: the guides' `capture --json` field table names the three fields
 * the response carried and no guide mentioned.
 *
 * `agentMode` (#2592) and `composerText` / `composerState` (#1879) were added to
 * the server's payload for `capture --json` readers, in PRs that touched neither
 * `src/cli/` nor the guides. The copy of the type is now held to the server by
 * `tests/unit/cli/types/current-output-mirror-3300.test.ts`; this holds the
 * half a user reads, in both languages.
 *
 * Narrow on purpose. It pins the three rows this Issue adds and the one
 * sentence that must not be lost from them — `unknown` is not the default mode —
 * and does not claim the table is complete.
 *
 * It also holds one consequence of what the guides now say. A session that is
 * not running is answered with no `realtimeSnippet` key, and the guides used to
 * tell a reader to judge an empty screen by calling `.trim()` on it — an
 * expression that throws on exactly that response. The advice is free to be
 * reworded; what must not come back is the unguarded read.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const GUIDES = [
  {
    language: 'ja',
    file: 'docs/user-guide/cli-operations-guide.md',
    unknownIsNotDefault: '`unknown` は「既定のモード」ではなく',
    absentWhenStopped: 'キーごと出ません**',
  },
  {
    language: 'en',
    file: 'docs/en/user-guide/cli-operations-guide.md',
    unknownIsNotDefault: '`unknown` does not mean "the default mode"',
    absentWhenStopped: 'absent keys**',
  },
] as const;

const FIELDS = ['agentMode', 'composerText', 'composerState'] as const;

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** The one table row documenting `field`: a line that opens with the field's own cell. */
function fieldRow(guide: string, field: string): string {
  const rows = guide.split('\n').filter((line) => line.startsWith(`| \`${field}\` |`));
  if (rows.length !== 1) {
    throw new Error(`expected exactly 1 table row for ${field}, found ${rows.length}`);
  }
  return rows[0];
}

/**
 * `.trim()` called on `realtimeSnippet` itself: `realtimeSnippet.trim(`,
 * `data.realtimeSnippet.trim(`. A read that survives an absent key has
 * something between the two — `?.`, or a default closed off by a parenthesis.
 */
const UNGUARDED_SNIPPET_TRIM = /\brealtimeSnippet\s*\.\s*trim\s*\(/;

/** The lines of `text` that read `realtimeSnippet` without allowing for its absence. */
function unguardedSnippetReads(text: string): string[] {
  return text.split('\n').filter((line) => UNGUARDED_SNIPPET_TRIM.test(line));
}

describe('[#3300] the guides never read realtimeSnippet as if it were always there', () => {
  // Controls for the detector, both ways: it has to catch the advice as it
  // stood, and it must not fire on the forms the advice is allowed to take.
  it('the detector catches an unguarded read', () => {
    for (const unguarded of [
      "画面が空かどうかは `realtimeSnippet.trim() === ''` と `lineCount` で見る。",
      "read `realtimeSnippet.trim() === ''` together with `lineCount`.",
      'if (data.realtimeSnippet.trim() === "") {',
      'realtimeSnippet . trim ()',
    ]) {
      expect(unguardedSnippetReads(unguarded)).toEqual([unguarded]);
    }
  });

  it('the detector leaves guarded reads and plain mentions alone', () => {
    for (const guarded of [
      "isRunning && (realtimeSnippet ?? '').trim() === ''",
      "realtimeSnippet?.trim() === ''",
      "(data.realtimeSnippet || '').trim()",
      '`realtimeSnippet` に直接 `.trim()` を呼ぶと例外になる',
      'Calling `.trim()` on `realtimeSnippet` directly throws',
      '| `realtimeSnippet` | pane 末尾 100 行 |',
    ]) {
      expect(unguardedSnippetReads(guarded)).toEqual([]);
    }
  });

  it.each(GUIDES)('$language: no unguarded read anywhere in the guide', ({ file }) => {
    expect(unguardedSnippetReads(read(file))).toEqual([]);
  });
});

describe('[#3300] capture --json field table', () => {
  // Positive control for the reader: it finds a row that has been there since
  // the table was written, and refuses a field the table does not have.
  it.each(GUIDES)('$language: the row reader finds real rows and throws on absent ones', ({ file }) => {
    const guide = read(file);
    expect(fieldRow(guide, 'lineCount')).toContain('lineCount');
    expect(() => fieldRow(guide, 'noSuchField3300')).toThrow(/found 0/);
  });

  describe.each(GUIDES)('$language', ({ file, unknownIsNotDefault, absentWhenStopped }) => {
    const guide = read(file);

    it.each(FIELDS)('documents %s', (field) => {
      expect(fieldRow(guide, field).length).toBeGreaterThan(`| \`${field}\` |`.length);
    });

    it('says agentMode `unknown` is not the default mode', () => {
      expect(fieldRow(guide, 'agentMode')).toContain(unknownIsNotDefault);
    });

    it('names every composer state', () => {
      const row = fieldRow(guide, 'composerState');
      for (const state of ['content', 'ghost', 'empty', 'unsupported_tool', 'no_composer']) {
        expect(row).toContain(`\`${state}\``);
      }
    });

    it('says a stopped session is answered without the frame fields', () => {
      expect(guide).toContain(absentWhenStopped);
      expect(guide).toContain('Issue #3300');
    });
  });
});

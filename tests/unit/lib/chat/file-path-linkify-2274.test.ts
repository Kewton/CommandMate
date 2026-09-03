/**
 * Which characters of a message body become a file link (Issue #2274).
 *
 * ## The defect these fixtures are shaped around
 *
 * A reply containing `commandmate-skills/docs/uat/harness-pack-uat-report-
 * template.md` rendered that ONE path in two colors: `commandmate-skills` stayed
 * prose and `/docs/uat/harness-pack-uat-report-template.md` became a button. The
 * pattern was `/(\/[^\s\n<>"']+\.[a-zA-Z0-9]+)/g`, which has no left boundary,
 * so it starts a match at any `/` — including the separators INSIDE a relative
 * path. The button then named a file this worktree does not have, so clicking it
 * could only fail.
 *
 * So the property under test is not "paths are linkified". It is *where a link
 * is allowed to START*: at the beginning of the body, or right after whitespace,
 * a backtick, a quote or an opening bracket. Nowhere else.
 *
 * ## Why the mutation block at the bottom exists
 *
 * Every assertion above it is satisfied by a splitter that links nothing at all,
 * and most of them by one that links everything. `describe('mutation injection')`
 * reads the REAL regex out of `chat-transcript-view.ts`, deletes the boundary
 * group from it, and shows the Issue's own fixture splitting in two under the
 * mutant — i.e. that these fixtures discriminate, and that the thing making them
 * pass is the boundary and not an accident of the rest of the pattern.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { splitFilePathParts, type ChatContentPart } from '@/lib/chat/chat-transcript-view';

const SOURCE_PATH = path.resolve(__dirname, '../../../../src/lib/chat/chat-transcript-view.ts');

/** The path from the Issue, which belongs to a different repository entirely. */
const OTHER_REPO_PATH = 'commandmate-skills/docs/uat/harness-pack-uat-report-template.md';

/** Every part's `content`, concatenated. Must always rebuild the input exactly. */
function rejoin(parts: ChatContentPart[]): string {
  return parts.map((part) => part.content).join('');
}

function pathsIn(content: string): string[] {
  return splitFilePathParts(content)
    .filter((part) => part.type === 'path')
    .map((part) => part.content);
}

describe('[#2274] splitFilePathParts does not start a link mid-path', () => {
  it('leaves a relative path from another repository as one unbroken text run', () => {
    // The Issue verbatim: not "the whole thing is a link" and not "part of it
    // is" — one text part, so the reader sees one path in one color.
    const body = `report template: ${OTHER_REPO_PATH}`;
    expect(splitFilePathParts(body)).toEqual([{ type: 'text', content: body }]);
  });

  it('leaves a bare relative path alone even when it stands on its own', () => {
    expect(splitFilePathParts(OTHER_REPO_PATH)).toEqual([
      { type: 'text', content: OTHER_REPO_PATH },
    ]);
  });

  it.each([
    ['docs/uat/x.md', 'a worktree-relative path'],
    ['./docs/uat/x.md', 'an explicitly relative path'],
    ['../sibling/x.md', 'a parent-relative path'],
    ['node_modules/pkg/index.js', 'a package-relative path'],
  ])('%s stays plain text (%s)', (body) => {
    expect(pathsIn(body)).toEqual([]);
  });

  it('does not carve a fictional file out of a URL', () => {
    // `:` and `/` are deliberately absent from the boundary class, so neither
    // slash of `//` opens a match. Before this Issue, `//example.com/a/b.js`
    // was a button.
    expect(pathsIn('published at https://example.com/a/b.js today')).toEqual([]);
  });
});

describe('[#2274] splitFilePathParts still links what it always did', () => {
  it('links an absolute path', () => {
    expect(splitFilePathParts('/Users/a/b.ts')).toEqual([
      { type: 'path', content: '/Users/a/b.ts' },
    ]);
  });

  it('links a backticked path and keeps the backticks as text', () => {
    expect(splitFilePathParts('edit `/src/x.ts` now')).toEqual([
      { type: 'text', content: 'edit `' },
      { type: 'path', content: '/src/x.ts' },
      { type: 'text', content: '` now' },
    ]);
  });

  it('links a parenthesised path without swallowing the parentheses', () => {
    expect(splitFilePathParts('(/src/x.ts)')).toEqual([
      { type: 'text', content: '(' },
      { type: 'path', content: '/src/x.ts' },
      { type: 'text', content: ')' },
    ]);
  });

  it.each([
    ['see /a/b.ts now', '/a/b.ts', 'after a space'],
    ['first line\n/a/b.ts', '/a/b.ts', 'after a newline'],
    ['"/a/b.ts"', '/a/b.ts', 'inside double quotes'],
    ["'/a/b.ts'", '/a/b.ts', 'inside single quotes'],
    ['（/a/b.ts）', '/a/b.ts', 'inside full-width parentheses'],
    ['「/a/b.ts」', '/a/b.ts', 'inside a Japanese quote'],
    ['[/a/b.ts]', '/a/b.ts', 'inside square brackets'],
    ['</a/b.ts>', '/a/b.ts', 'inside an autolink'],
  ])('%s links %s (%s)', (body, expected) => {
    expect(pathsIn(body)).toEqual([expected]);
  });

  it('links every path in a body, not just the first', () => {
    // Consuming the boundary character cannot hide the next path: a run always
    // ends on an alphanumeric, so the character that terminates one path is
    // never the character the next one needs in front of it.
    expect(pathsIn('a /x.ts /y.ts (/z.ts)')).toEqual(['/x.ts', '/y.ts', '/z.ts']);
  });

  it('places a repeated path at both of its own offsets', () => {
    // The pre-#2274 loop re-FOUND each match with `indexOf`, which is a second
    // guess at a position the engine already knew. `matchAll` reports it.
    expect(splitFilePathParts('/a.ts then /a.ts')).toEqual([
      { type: 'path', content: '/a.ts' },
      { type: 'text', content: ' then ' },
      { type: 'path', content: '/a.ts' },
    ]);
  });

  it.each([
    'report template: ' + OTHER_REPO_PATH,
    'edit `/src/x.ts` now',
    '(/src/x.ts)',
    'a /x.ts /y.ts (/z.ts)',
    '/a.ts then /a.ts',
    'published at https://example.com/a/b.js today',
    'first line\n/a/b.ts and trailing text',
  ])('reassembles %j exactly', (body) => {
    expect(rejoin(splitFilePathParts(body))).toBe(body);
  });
});

describe('[#2274] splitFilePathParts keeps its defensive contract', () => {
  it('renders a body with nothing to link as a single text part', () => {
    expect(splitFilePathParts('nothing here')).toEqual([
      { type: 'text', content: 'nothing here' },
    ]);
  });

  it('renders a non-string body as empty rather than throwing', () => {
    expect(splitFilePathParts(undefined as unknown as string)).toEqual([
      { type: 'text', content: '' },
    ]);
    expect(splitFilePathParts('')).toEqual([{ type: 'text', content: '' }]);
  });
});

// ---------------------------------------------------------------------------
// Mutation injection
// ---------------------------------------------------------------------------

describe('[#2274] the boundary is what makes the fixtures above pass', () => {
  /** The live pattern's source text, read out of the module under test. */
  function readLivePatternSource(): string {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const declaration = /const FILE_PATH_REGEX = \/(.*)\/g;/.exec(source);
    if (!declaration) {
      throw new Error(
        `no \`const FILE_PATH_REGEX = /…/g;\` declaration in ${SOURCE_PATH}; this mutation ` +
          'test reads the real pattern and must not silently pass when it cannot find it',
      );
    }
    return declaration[1];
  }

  /** `splitFilePathParts`' loop, run against an arbitrary two-group pattern. */
  function splitWith(pattern: RegExp, content: string): ChatContentPart[] {
    const parts: ChatContentPart[] = [];
    let lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const boundary = match[1] ?? '';
      const filePath = match[2];
      if (!filePath) continue;
      const index = (match.index ?? 0) + boundary.length;
      if (index > lastIndex) {
        parts.push({ type: 'text', content: content.slice(lastIndex, index) });
      }
      parts.push({ type: 'path', content: filePath });
      lastIndex = index + filePath.length;
    }
    if (parts.length === 0) return [{ type: 'text', content }];
    if (lastIndex < content.length) {
      parts.push({ type: 'text', content: content.slice(lastIndex) });
    }
    return parts;
  }

  it('reproduces production behaviour from the pattern in the source file', () => {
    // Positive control for the two assertions below: the local loop is the same
    // loop, so a difference between the mutant and the original is the pattern.
    const live = new RegExp(readLivePatternSource(), 'g');
    for (const body of ['edit `/src/x.ts` now', `see ${OTHER_REPO_PATH} please`, '/a.ts x /a.ts']) {
      expect(splitWith(live, body)).toEqual(splitFilePathParts(body));
    }
  });

  it('states, in the source, that the pattern opens with a boundary group', () => {
    expect(readLivePatternSource()).toMatch(/^\(\^\|\[/);
  });

  it('splits the Issue’s path in two once the boundary group is removed', () => {
    const mutated = readLivePatternSource().replace(/^\(\^\|\[[^\]]*\]\)/, '()');
    expect(mutated).not.toBe(readLivePatternSource());

    const body = `report template: ${OTHER_REPO_PATH}`;
    const underMutant = splitWith(new RegExp(mutated, 'g'), body);

    // The defect, verbatim: the tail of a relative path becomes a link.
    expect(underMutant).toEqual([
      { type: 'text', content: 'report template: commandmate-skills' },
      { type: 'path', content: '/docs/uat/harness-pack-uat-report-template.md' },
    ]);
    // ...and the shipped splitter does not do that.
    expect(splitFilePathParts(body)).toEqual([{ type: 'text', content: body }]);
  });

  it('turns a URL into a fictional file once the boundary group is removed', () => {
    const mutated = readLivePatternSource().replace(/^\(\^\|\[[^\]]*\]\)/, '()');
    const body = 'published at https://example.com/a/b.js today';

    expect(
      splitWith(new RegExp(mutated, 'g'), body)
        .filter((part) => part.type === 'path')
        .map((part) => part.content),
    ).toEqual(['//example.com/a/b.js']);
    expect(pathsIn(body)).toEqual([]);
  });
});

/**
 * The EN user guides must keep the same section skeleton as their JA originals.
 *
 * The JA files are the source of truth; the EN ones are translations that drift
 * silently — a section added to JA simply never appears in EN, and nothing goes
 * red. Counting `##` headings is a cheap invariant that catches exactly that:
 * a new (or deleted) JA section changes the count on one side only.
 *
 * Two failure modes this test is deliberately built against:
 *
 * 1. **The vacuous 0 == 0 pass.** If a JA file were renamed or deleted, reading
 *    a missing file as "" would make both sides 0 and the assertion would pass
 *    while the pair no longer exists. So each side's existence is asserted
 *    before the counts are, and the count itself must be greater than zero.
 * 2. **Headings inside fenced code blocks.** `commandmate task` documents the
 *    contract preamble, which `composeContractMessage()` emits with literal
 *    `## 実行契約` / `## タスク` lines. Those live in a code fence in both
 *    languages, and they are counted in both — stripping fences would only add
 *    a way for the two sides to disagree about what counts.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** JA original -> EN translation. Both paths are repo-relative. */
const PAIRS: ReadonlyArray<{ name: string; ja: string; en: string }> = [
  {
    name: 'cli-operations-guide',
    ja: 'docs/user-guide/cli-operations-guide.md',
    en: 'docs/en/user-guide/cli-operations-guide.md',
  },
  {
    name: 'skills',
    ja: 'docs/user-guide/skills.md',
    en: 'docs/en/user-guide/skills.md',
  },
  {
    name: 'agent-event-hooks',
    ja: 'docs/user-guide/agent-event-hooks.md',
    en: 'docs/en/user-guide/agent-event-hooks.md',
  },
  {
    name: 'tutorial',
    ja: 'docs/user-guide/tutorial.md',
    en: 'docs/en/user-guide/tutorial.md',
  },
  {
    // Issue #2211: the pair that this test did not cover while Epic #2192 added
    // two output-surface sections to the JA guide, so the EN side fell two
    // sections behind with nothing going red.
    name: 'webapp-guide',
    ja: 'docs/user-guide/webapp-guide.md',
    en: 'docs/en/user-guide/webapp-guide.md',
  },
];

/** Placeholders a translation must never ship with. */
const PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /\[要レビュー\]/,
  /\[要確認\]/,
  /\[未訳\]/,
  /\bTODO:\s*translate\b/i,
  /\bTBD\b/,
];

function abs(relative: string): string {
  return path.join(REPO_ROOT, relative);
}

function countH2(relative: string): number {
  const content = fs.readFileSync(abs(relative), 'utf8');
  return content.split('\n').filter((line) => line.startsWith('## ')).length;
}

describe('ja/en user guide heading parity', () => {
  it.each(PAIRS)('$name: both sides of the pair exist', ({ ja, en }) => {
    // Asserted before any count, so a deleted file can never pass as 0 == 0.
    expect(fs.existsSync(abs(ja))).toBe(true);
    expect(fs.existsSync(abs(en))).toBe(true);
  });

  it.each(PAIRS)('$name: the JA original has sections to match', ({ ja }) => {
    expect(countH2(ja)).toBeGreaterThan(0);
  });

  it.each(PAIRS)('$name: en has the same number of `##` headings as ja', ({ ja, en }) => {
    expect(countH2(en)).toBe(countH2(ja));
  });

  it.each(PAIRS)('$name: the EN translation carries no placeholder', ({ en }) => {
    const content = fs.readFileSync(abs(en), 'utf8');
    for (const pattern of PLACEHOLDER_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });
});

describe('en user guide reachability', () => {
  it('the EN tutorial links Skills to the EN skills guide, not the JA one', () => {
    const tutorial = fs.readFileSync(abs('docs/en/user-guide/tutorial.md'), 'utf8');
    expect(tutorial).toMatch(/\]\(\.\/skills\.md\)/);
    expect(tutorial).not.toMatch(/\]\(\.\.\/\.\.\/user-guide\/skills\.md\)/);
  });

  it('the EN CLI operations guide reaches the new EN guides', () => {
    const guide = fs.readFileSync(abs('docs/en/user-guide/cli-operations-guide.md'), 'utf8');
    expect(guide).toMatch(/\]\(\.\/skills\.md\)/);
    expect(guide).toMatch(/\]\(\.\/agent-event-hooks\.md\)/);
  });

  it('the EN README documentation table reaches the CLI operations guide', () => {
    const readme = fs.readFileSync(abs('README.md'), 'utf8');
    expect(readme).toMatch(/\]\(\.\/docs\/en\/user-guide\/cli-operations-guide\.md\)/);
  });
});

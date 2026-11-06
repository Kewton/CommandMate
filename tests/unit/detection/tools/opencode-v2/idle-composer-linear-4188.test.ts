/**
 * Issue #4188 (review): OpenCode V2's empty-composer reader is linear in the rows.
 *
 * The multi-line regular expression it replaced (`OLD_IDLE_COMPOSER` below, the
 * rule fb1e97e78 wrote) retried from every gutter row, so a pane of
 * `┃  Ask anything…` rows with no border under them took time quadratic in the
 * rows. `OPENCODE_V2_IDLE_COMPOSER_PATTERN` is now a `RegExp` whose `exec` is one
 * pass over the rows (`findOpencodeV2IdleComposer`), shared by the send path's
 * composer check, the `ready` branch and liveness.
 *
 * Positive and negative controls on the measured frames under
 * `tests/fixtures/opencode-v2*`: every frame gets the same answer, at the same
 * offset, as the regular expression it replaced.
 *
 * @vitest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCliToolPatterns, stripAnsi } from '@/lib/detection/cli-patterns';
import {
  findOpencodeV2IdleComposer,
  isOpencodeV2ComposerVisible,
  OPENCODE_V2_IDLE_COMPOSER_PATTERN,
} from '@/lib/detection/tools/opencode-v2/patterns';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';

const FIXTURES = resolve(__dirname, '../../../../fixtures');

/** The rule fb1e97e78 wrote, as a multi-line regular expression. */
const OLD_IDLE_COMPOSER =
  /^[^\S\n]*[│┃][^\S\n]*Ask anything(?:\.\.\.|…)[^\n]*\n(?:[^\S\n]*[│┃][^\n]*\n)*[^\S\n]*╹▀{4,}/m;

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return path.endsWith('.txt') ? [path] : [];
  });
}

const V2_FRAMES = readdirSync(FIXTURES)
  .filter((name) => name.startsWith('opencode-v2'))
  .flatMap((name) => textFiles(join(FIXTURES, name)))
  .map((path) => [path.slice(FIXTURES.length + 1), stripAnsi(readFileSync(path, 'utf8'))] as const);

const BOOT = V2_FRAMES.find(([name]) => name === 'opencode-v2-live-2934/boot-idle.txt')?.[1] ?? '';

const ROW = '   ┃  Ask anything… "Fix broken tests"';
const rowsOf = (n: number): string => Array.from({ length: n }, () => ROW).join('\n');

/** Best of several runs, in ms. */
function timeOf(text: string): number {
  let best = Infinity;
  for (let run = 0; run < 7; run++) {
    const started = performance.now();
    for (let i = 0; i < 5; i++) OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(text);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('the same answer as the regular expression it replaced', () => {
  it('spells the same rule in `source` and `flags`', () => {
    // The transform may spell `\u2502` as the glyph, so compare what the source
    // compiles to rather than its characters.
    const spelled = new RegExp(OPENCODE_V2_IDLE_COMPOSER_PATTERN.source, OPENCODE_V2_IDLE_COMPOSER_PATTERN.flags);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.flags).toBe(OLD_IDLE_COMPOSER.flags);
    for (const [name, text] of V2_FRAMES) {
      expect(spelled.exec(text)?.index, name).toBe(OLD_IDLE_COMPOSER.exec(text)?.index);
    }
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN).toBeInstanceOf(RegExp);
  });

  it('agrees on every measured V2 frame, with positives and negatives among them', () => {
    expect(V2_FRAMES.length).toBeGreaterThan(20);
    let positives = 0;
    for (const [name, text] of V2_FRAMES) {
      const before = OLD_IDLE_COMPOSER.exec(text);
      const after = OPENCODE_V2_IDLE_COMPOSER_PATTERN.exec(text);
      expect(after?.index, name).toBe(before?.index);
      expect(after?.[0], name).toBe(before?.[0]);
      expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(text), name).toBe(before !== null);
      expect(findOpencodeV2IdleComposer(text) !== null, name).toBe(before !== null);
      if (before) positives++;
    }
    expect(positives).toBeGreaterThan(0);
    expect(positives).toBeLessThan(V2_FRAMES.length);
  });

  it('the measured composer is read by every reader (positive)', () => {
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(BOOT)).toBe(true);
    expect(isOpencodeV2ComposerVisible(BOOT)).toBe(true);
    expect(getCliToolPatterns('opencode-v2').promptPattern.test(BOOT)).toBe(true);
    expect(resolveLivenessSpec('opencode-v2').alivePatterns).toContain(OPENCODE_V2_IDLE_COMPOSER_PATTERN);
    expect(BOOT.match(OPENCODE_V2_IDLE_COMPOSER_PATTERN)?.[0]).toMatch(/^ *┃ *Ask anything/);
  });

  it('placeholder rows over a border match; without the border they do not', () => {
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(`${rowsOf(3)}\n   ┃\n   ╹▀▀▀▀▀▀`)).toBe(true);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(`${rowsOf(3)}\n\n   ╹▀▀▀▀▀▀`)).toBe(false);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(rowsOf(3))).toBe(false);
  });
});

describe('linear in the rows', () => {
  it('thousands of placeholder gutter rows with no border: false, in time proportional to the rows', () => {
    const small = rowsOf(2000);
    const large = rowsOf(4000);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(small)).toBe(false);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(large)).toBe(false);
    expect(isOpencodeV2ComposerVisible(large)).toBe(false);
    timeOf(small); // warm up
    const ratio = timeOf(large) / timeOf(small);
    expect(ratio).toBeLessThan(3);
  });
});

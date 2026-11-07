/**
 * Issue #4209 item 4: what the idle-composer `RegExp` subclasses guarantee.
 *
 * `OPENCODE_V2_IDLE_COMPOSER_PATTERN` (#4188) and, since #4209, V1's
 * `OPENCODE_IDLE_COMPOSER_PATTERN` are `RegExp` subclasses whose `exec` is the
 * one-pass reader (`findOpencodeV2IdleComposer` / `findOpenCodeIdleComposer`). Kept
 * a `RegExp` because `getCliToolPatterns().promptPattern` and liveness's
 * `alivePatterns` take regular expressions. Pinned here:
 *
 * - guaranteed: `test`, `exec`, and `String.prototype.match` / `search` / `replace`
 *   (they go through `exec`); rows split on LF only;
 * - not guaranteed: a copy built from `source` and `flags` (native `^` under `m`
 *   also starts a line after U+2028 / U+2029 / CR), and `split` (it constructs
 *   `Symbol.species`, the native `RegExp`).
 *
 * The contrasts below are where the copy's answer differs from the reader's.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  findOpencodeV2IdleComposer,
  OPENCODE_V2_IDLE_COMPOSER_PATTERN,
} from '@/lib/detection/tools/opencode-v2/patterns';
import {
  findOpenCodeIdleComposer,
  OPENCODE_IDLE_COMPOSER_PATTERN,
} from '@/lib/detection/tools/opencode/patterns';

const fixtures = (rel: string): string =>
  stripAnsi(readFileSync(resolve(__dirname, '../../../../fixtures', rel), 'utf8'));

const PATTERNS: Array<[string, RegExp, (text: string) => { start: number; end: number } | null, string]> = [
  ['V2', OPENCODE_V2_IDLE_COMPOSER_PATTERN, findOpencodeV2IdleComposer, 'Ask anything…'],
  ['V1', OPENCODE_IDLE_COMPOSER_PATTERN, findOpenCodeIdleComposer, 'Ask anything...'],
];

/** A composer box: the placeholder row, a blank gutter row, the model row and the border. */
const box = (phrase: string, lead = ''): string =>
  `${lead}   ┃  ${phrase}\n   ┃\n   ┃  Build · m\n   ╹▀▀▀▀▀▀▀▀\n   footer`;

/** Rows separated by a terminator native `^` (m flag) starts a line after, but LF splitting does not. */
const TERMINATORS: Array<[string, string]> = [
  ['U+2028', '\u2028'],
  ['U+2029', '\u2029'],
  ['CR', '\r'],
];

describe.each(PATTERNS)('%s idle composer pattern: guaranteed operations', (_v, pattern, find, phrase) => {
  const texts = [box(phrase), `transcript\n${box(phrase)}`, `   ┃  ${phrase}\n   reply`, 'nothing'];

  it.each(texts.map((t) => [JSON.stringify(t).slice(0, 40), t] as const))('%s: test/exec/match/search/replace agree with the reader', (_n, text) => {
    const found = find(text);
    expect(pattern.test(text)).toBe(found !== null);
    const exec = pattern.exec(text);
    expect(exec?.index ?? null).toBe(found?.start ?? null);
    expect(exec?.[0] ?? null).toBe(found ? text.slice(found.start, found.end) : null);
    expect(text.match(pattern)?.index ?? null).toBe(found?.start ?? null);
    expect(text.search(pattern)).toBe(found?.start ?? -1);
    expect(text.replace(pattern, '<C>')).toBe(
      found ? text.slice(0, found.start) + '<C>' + text.slice(found.end) : text,
    );
  });

  it('is still a RegExp with the rule in its source, multi-line', () => {
    expect(pattern).toBeInstanceOf(RegExp);
    expect(pattern.flags).toBe('m');
    expect(pattern.source).toContain('Ask anything');
  });

  it.each(TERMINATORS)('a row break by %s is not a row: the reader and the copy differ', (_n, sep) => {
    // `x<sep>┃  Ask anything…` is one row for the reader (it does not open with the
    // gutter); the copy's `^` starts a line after the terminator.
    const text = box(phrase, `x${sep}`);
    const copy = new RegExp(pattern.source, pattern.flags);
    expect(find(text)).toBeNull();
    expect(pattern.test(text)).toBe(false);
    expect(copy.test(text)).toBe(true);
  });

  it('on LF-only text the copy answers as the reader does (measured frames and boxes)', () => {
    const copy = new RegExp(pattern.source, pattern.flags);
    for (const text of texts) expect(copy.test(text), text).toBe(pattern.test(text));
  });

  it.each(TERMINATORS)('split (Symbol.species, the native RegExp) does not go through the reader (%s)', (_n, sep) => {
    const text = box(phrase, `x${sep}`);
    expect(pattern.test(text)).toBe(false);
    // The native split found a match the reader does not.
    expect(text.split(pattern).length).toBe(2);
    expect(text.split(pattern)).toEqual(text.split(new RegExp(pattern.source, pattern.flags)));
  });
});

describe('the measured frames: the copy and the reader agree on LF-only captures', () => {
  const FRAMES = [
    'opencode-v2-live-2934/boot-idle.txt',
    'opencode-v2-live-2934/turn-done.txt',
    'opencode-live-2047/w200/boot-idle.txt',
    'opencode-live-2047/w200/sidebar-title-phrase.txt',
  ];

  it.each(FRAMES)('%s', (rel) => {
    const text = fixtures(rel);
    expect(text).not.toMatch(/[\u2028\u2029\r]/);
    for (const [, pattern] of PATTERNS) {
      expect(new RegExp(pattern.source, pattern.flags).test(text)).toBe(pattern.test(text));
    }
  });
});

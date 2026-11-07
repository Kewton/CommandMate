/**
 * Issue #4188, item 3: OpenCode V2's placeholder (`┃  Ask anything…`) is read by
 * position — inside the box over the composer's bottom border — not on any gutter
 * row. The transcript echoes each sent message in the same `┃` box, so a message
 * that began with `Ask anything…` put an empty input box on the pane.
 *
 * Each reader of the pattern gets a positive control on a measured frame
 * (`tests/fixtures/opencode-v2-live-2934/boot-idle.txt`, 2.0.18, 80x200), also with
 * its footer row taken out so the placeholder alone decides, and a negative
 * control: a measured frame whose echo row is replaced by one starting with the
 * phrase, in memory, with the rule the code had before written out beside it.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { opencodeV2StatusDetector } from '@/lib/detection/tools/opencode-v2/detect';
import {
  isOpencodeV2ComposerVisible,
  isOpencodeV2FooterRowAt,
  OPENCODE_V2_IDLE_COMPOSER_PATTERN,
} from '@/lib/detection/tools/opencode-v2/patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { judgeToolLiveness } from '@/lib/detection/tool-liveness';

const fixture = (rel: string): string =>
  stripAnsi(readFileSync(resolve(__dirname, '../../../../fixtures', rel), 'utf8'));

const BOOT = fixture('opencode-v2-live-2934/boot-idle.txt');
const TURN_DONE = fixture('opencode-v2-live-2934/turn-done.txt');
const PERMISSION = fixture('opencode-v2-live-2945/permission-required.txt');
const TRANSCRIPT_ONLY = fixture('opencode-v2-agent-mode-3038/completion-row-only.txt');

/** The rule before Issue #4188: the placeholder on any gutter row. */
const OLD_IDLE_COMPOSER = /^[^\S\n]*[│┃][^\S\n]*Ask anything(?:\.\.\.|…)/m;

const ECHO_TEXT = 'Ask anything… "Fix broken tests" is what the input box shows';

/** `text` with the first echo row (the first gutter row with text) saying `ECHO_TEXT`. */
function withEcho(text: string): string {
  const rows = text.split('\n');
  const at = rows.findIndex((row) => /^[^\S\n]*┃[^\S\n]*\S/.test(row));
  expect(at).toBeGreaterThanOrEqual(0);
  rows[at] = rows[at].replace(/(┃[^\S\n]*)\S.*$/, `$1${ECHO_TEXT}`);
  return rows.join('\n');
}

/** `text` without its footer (the row under the composer border). */
function withoutFooter(text: string): string {
  const rows = text.split('\n');
  return rows.filter((_row, i) => !isOpencodeV2FooterRowAt(rows, i)).join('\n');
}

/** The measured echo block of a turn, as a new turn just sent, with `ECHO_TEXT`. */
const ECHO_BLOCK = withEcho(TURN_DONE)
  .split('\n')
  .filter((row) => /^[^\S\n]*┃/.test(row))
  .slice(0, 4);

const verdict = (text: string) => opencodeV2StatusDetector.detect(normalizeFrame(text, 'opencode-v2'));

describe('the measured frames', () => {
  it('the boot frame draws the placeholder in the box over the border', () => {
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(BOOT)).toBe(true);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(withoutFooter(BOOT))).toBe(true);
    expect(withoutFooter(BOOT).split('\n').length).toBe(BOOT.split('\n').length - 1);
  });

  it('the echo control holds the phrase on a gutter row, as the old rule read it', () => {
    expect(ECHO_BLOCK.some((row) => row.includes(ECHO_TEXT))).toBe(true);
    expect(OLD_IDLE_COMPOSER.test(withEcho(PERMISSION))).toBe(true);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(withEcho(PERMISSION))).toBe(false);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(withEcho(TURN_DONE))).toBe(false);
  });
});

describe('input box (isOpencodeV2ComposerVisible)', () => {
  it('the boot frame, with and without its footer: visible', () => {
    expect(isOpencodeV2ComposerVisible(BOOT)).toBe(true);
    expect(isOpencodeV2ComposerVisible(withoutFooter(BOOT))).toBe(true);
  });

  it('the approval dialog under an echo starting with the phrase: no composer', () => {
    const text = withEcho(PERMISSION);
    expect(OLD_IDLE_COMPOSER.test(text)).toBe(true);
    expect(isOpencodeV2ComposerVisible(text)).toBe(false);
  });
});

describe('ready (the status detector)', () => {
  it('the boot frame, with and without its footer: ready on the input prompt', () => {
    for (const text of [BOOT, withoutFooter(BOOT)]) {
      expect(verdict(text).status).toBe('ready');
      expect(verdict(text).reason).toBe(STATUS_REASON.INPUT_PROMPT);
    }
  });

  it('a just-sent echo starting with the phrase, with no footer captured: not ready', () => {
    const text = `${TRANSCRIPT_ONLY.trimEnd()}\n\n${ECHO_BLOCK.join('\n')}\n`;
    expect(OLD_IDLE_COMPOSER.test(text)).toBe(true);
    expect(verdict(text).status).not.toBe('ready');
  });
});

describe('liveness', () => {
  const spec = resolveLivenessSpec('opencode-v2');

  it('the boot frame, with and without its footer: alive', () => {
    expect(judgeToolLiveness(BOOT, spec).alive).toBe(true);
    expect(judgeToolLiveness(withoutFooter(BOOT), spec).alive).toBe(true);
  });

  it('a shell that printed an echo starting with the phrase is not the TUI', () => {
    const shell = ['dev@host repo % cat transcript.txt', ...ECHO_BLOCK, 'dev@host repo % '].join('\n');
    expect(OLD_IDLE_COMPOSER.test(shell)).toBe(true);
    expect(judgeToolLiveness(shell, spec).alive).toBe(false);
  });
});

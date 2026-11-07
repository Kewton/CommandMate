/**
 * Issue #4209, the rest of OpenCode V1's position rules after #4188:
 *
 * 1. the status detector reads `Thinking:` as the poller's save does — the
 *    progress row under the composer's bottom border, whole
 *    (`isOpenCodeProgressBelowComposer`) — plus, on a turn that is still open, a
 *    `Thinking:` row at the end of the turn region. The extraction and the status
 *    are pinned in pairs on the same frames.
 * 2. the idle composer (`Ask anything...`) is the placeholder in the box over the
 *    border (`findOpenCodeIdleComposer`), not any guttered row.
 * 3. a reply's row opening with "Build " or quoting the footer's status cell is
 *    kept when the chrome was located (the chrome's rows still go).
 *
 * Every frame is measured (`tests/fixtures/opencode*`,
 * `tests/unit/lib/detection/fixtures/opencode-live-*`); the negative controls edit
 * it in memory, and the rule the code had before is written out beside each so the
 * control is not vacuous.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  findOpenCodeChromeStart,
  findOpenCodeIdleComposer,
  isOpenCodeProgressBelowComposer,
  OPENCODE_IDLE_COMPOSER_PATTERN,
  OPENCODE_MODEL_ROW_PATTERN,
  OPENCODE_FOOTER_STATUS_PATTERN,
  OPENCODE_SKIP_PATTERNS,
  OPENCODE_TRANSCRIPT_SKIP_PATTERNS,
} from '@/lib/detection/tools/opencode/patterns';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { readIdleEvidence } from '@/lib/detection/tools/opencode/detect';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { extractResponse } from '@/lib/polling/response-checker';
import { cleanOpenCodeResponse } from '@/lib/response-cleaner';

const fixtures = (rel: string): string => readFileSync(resolve(__dirname, '../../../../fixtures', rel), 'utf8');
const detectionFixtures = (rel: string): string =>
  readFileSync(resolve(__dirname, '../../../lib/detection/fixtures', rel), 'utf8');

const DONE = fixtures('opencode-live-4134/turn-done-subsecond.txt');
const DONE_2047 = fixtures('opencode-live-2047/w80/turn-complete.txt');
const DONE_FRAMES: Array<[string, string]> = [
  ['opencode-live-4134/turn-done-subsecond', DONE],
  ['opencode-live-2047/w80/turn-complete', DONE_2047],
];
const ESC_AGAIN_AFTER_MARKER = detectionFixtures('opencode-live-1894/esc-again-after-marker.txt');
const RUNNING: Array<[string, string]> = [
  ['opencode-live-1894/esc-again-after-marker', ESC_AGAIN_AFTER_MARKER],
  ['opencode-live-2047/w80/turn-running', fixtures('opencode-live-2047/w80/turn-running.txt')],
  ['opencode-live-2047/w200/turn-running', fixtures('opencode-live-2047/w200/turn-running.txt')],
];

const extract = (text: string) => extractResponse(text, text.split('\n').length, 'opencode');
const status = (text: string) => detectSessionStatus(text, 'opencode');
const save = (response: string): string => cleanOpenCodeResponse(response, OPENCODE_TRANSCRIPT_SKIP_PATTERNS);

/** The thinking step before #4209: the word in the last five content rows. */
const oldThinkingStep = (text: string): boolean => /Thinking:/.test(normalizeFrame(text).thinkingLines);

/** The index of the composer's bottom border, from the bottom. */
function borderOf(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[^\S\n]*╹▀{4,}/.test(lines[i])) return i;
  }
  return -1;
}

/** `raw` with the leading path of the `nth` non-empty row under the border replaced by `path`. */
function withCwdRow(raw: string, nth: number, path: string): string {
  const lines = stripAnsi(raw).split('\n');
  const border = borderOf(lines);
  expect(border).toBeGreaterThan(0);
  const rows = lines.map((line, i) => (i > border && line.trim() ? i : -1)).filter((i) => i >= 0);
  const at = rows[nth];
  expect(at).toBeDefined();
  lines[at] = lines[at].replace(/^(\s+)\S+/, `$1${path}`);
  return lines.join('\n');
}

/** The measured finished frame with `row` as a row of its reply, under `MOCK_OK`. */
function doneWith(row: string): string {
  const lines = stripAnsi(DONE).split('\n');
  const at = lines.findIndex((line) => line.trim() === 'MOCK_OK');
  expect(at).toBeGreaterThan(0);
  return [...lines.slice(0, at + 1), row, ...lines.slice(at + 1)].join('\n');
}

/** The measured finished frame with `row` added right under the composer's border. */
function doneWithBelowBorder(row: string): string {
  const lines = stripAnsi(DONE).split('\n');
  const border = borderOf(lines);
  return [...lines.slice(0, border + 1), row, ...lines.slice(border + 1)].join('\n');
}

describe('item 1: the save and the status read `Thinking:` by the same rule', () => {
  const CWDS: Array<[string, number, string]> = [
    ['a cwd of /tmp/Thinking:demo', 0, '/tmp/Thinking:demo'],
    ['a wrapped cwd row opening with Thinking:', 1, 'Thinking:demo/repo'],
  ];
  const CASES = DONE_FRAMES.flatMap(([frame, raw]) =>
    CWDS.map(([cwd, nth, path]) => [`${frame}, ${cwd}`, raw, nth, path] as const));

  it.each(CASES)('%s: saved, and ready (the old step read running)', (_name, raw, nth, path) => {
    const frame = withCwdRow(raw, nth, path);
    // Positive control: the thinking step before #4209 read the cwd as a running turn.
    expect(oldThinkingStep(frame)).toBe(true);

    const result = extract(frame);
    expect(result?.isComplete).toBe(true);
    expect(save(result?.response ?? '').length).toBeGreaterThan(0);

    const verdict = status(frame);
    expect(verdict.status).toBe('ready');
    expect(verdict.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
  });

  const QUOTING: Array<[string, string]> = [
    ['the progress row alone', '     Thinking: is the progress row'],
    ['with the spinner', '     ⠦ Thinking: Crafting an essay'],
    ['mid-sentence', '     The row reads Thinking: while a turn runs'],
  ];

  it.each(QUOTING)('a finished reply quoting %s: saved, and ready (the old branch B read running)', (_name, row) => {
    const frame = doneWith(row);
    // Positive control: before #4209 the status read `running` / thinking_indicator here.
    const lines = frame.split('\n');
    const contentAboveChrome = lines.slice(0, findOpenCodeChromeStart(lines)).filter((l) => l.trim());
    expect(/Thinking:/.test(contentAboveChrome.slice(-5).join('\n'))).toBe(true);

    const result = extract(frame);
    expect(result?.isComplete).toBe(true);
    expect(save(result?.response ?? '')).toContain(row.trim());

    const verdict = status(frame);
    expect(verdict.status).toBe('ready');
    expect(verdict.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
  });

  it.each(DONE_FRAMES)('%s as measured: saved, and ready', (_name, raw) => {
    expect(extract(stripAnsi(raw))?.isComplete).toBe(true);
    expect(status(raw).status).toBe('ready');
  });

  it.each(RUNNING)('%s (measured, running): not saved, and running', (_name, raw) => {
    expect(extract(stripAnsi(raw))?.isComplete ?? false).toBe(false);
    expect(status(raw).status).toBe('running');
  });

  it('the measured `⠦ Thinking:` row of an open turn is still read with the busy hint gone', () => {
    // The frame's only busy evidence besides the hint is the transcript's progress row.
    const lines = stripAnsi(ESC_AGAIN_AFTER_MARKER).split('\n');
    const border = borderOf(lines);
    const withoutHint = lines.slice(0, border + 1).join('\n');
    const verdict = status(withoutHint);
    expect(verdict.status).toBe('running');
    expect(verdict.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
  });

  const BELOW: Array<[string, string]> = [
    ['the braille spinner', '   ⠦ Thinking: Crafting an essay'],
    ['the busy footer\'s spinner run', '   ⬝⬝⬝⬝■■■■ Thinking:'],
  ];

  it.each(BELOW)('a progress row with %s under the border: not saved, and running', (_name, row) => {
    const frame = doneWithBelowBorder(row);
    expect(isOpenCodeProgressBelowComposer(frame.split('\n'))).toBe(true);
    expect(extract(frame)?.isComplete).toBe(false);
    const verdict = status(frame);
    expect(verdict.status).toBe('running');
    expect(verdict.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
  });

  it('isOpenCodeProgressBelowComposer: false on the measured finished frames, true on the running ones', () => {
    for (const [, raw] of DONE_FRAMES) {
      expect(isOpenCodeProgressBelowComposer(stripAnsi(raw).split('\n'))).toBe(false);
    }
    for (const [name, raw] of RUNNING) {
      expect(isOpenCodeProgressBelowComposer(stripAnsi(raw).split('\n')), name).toBe(true);
    }
  });
});

describe('item 2: the V1 idle composer is the placeholder in the box over the border', () => {
  const ECHO_FRAMES = [
    'opencode-live-2047/w200/phrase-in-response.txt',
    'opencode-live-2047/w200/numbered-answer.txt',
    'opencode-live-2047/w200/sidebar-title-phrase.txt',
  ];
  const IDLE_FRAMES: Array<[string, string]> = [
    ['canary/opencode-idle.raw', fixtures('canary/opencode-idle.raw.txt')],
    ['opencode-live-2046/w80/home-idle', fixtures('opencode-live-2046/w80/home-idle.txt')],
    ['opencode-live-2047/w80/boot-idle', fixtures('opencode-live-2047/w80/boot-idle.txt')],
    ['opencode-live-2047/w120/boot-idle', fixtures('opencode-live-2047/w120/boot-idle.txt')],
    ['opencode-live-2047/w200/boot-idle', fixtures('opencode-live-2047/w200/boot-idle.txt')],
    ['opencode-live-2049/boot-idle-11822', fixtures('opencode-live-2049/boot-idle-11822.txt')],
    ['tool-liveness-2070/opencode-ready-11823', fixtures('tool-liveness-2070/opencode-ready-11823.txt')],
    ['opencode-live-1883/boot-idle', detectionFixtures('opencode-live-1883/boot-idle.txt')],
  ];
  /** The rule before #4209: a guttered row opening with the placeholder, anywhere. */
  const OLD_RULE = /^[^\S\n]*[│┃][^\S\n]*Ask anything(?:\.\.\.|…)/m;
  const livenessComposer = resolveLivenessSpec('opencode').alivePatterns.find(
    (pattern) => pattern === OPENCODE_IDLE_COMPOSER_PATTERN,
  );

  /** `raw` with every finished-turn marker row taken out (so branch D does not answer first). */
  const withoutMarkers = (raw: string): string =>
    stripAnsi(raw).split('\n').filter((line) => !/▣/.test(line)).join('\n');

  it.each(ECHO_FRAMES)('%s: the echo\'s gutter row with the sidebar title is not the composer', (rel) => {
    const text = stripAnsi(fixtures(rel));
    expect(OLD_RULE.test(text)).toBe(true);
    expect(findOpenCodeIdleComposer(text)).toBeNull();
    // Each reader: the pattern liveness reads, and the status detector's branch E.
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.test(text)).toBe(false);
    expect(livenessComposer?.test(text)).toBe(false);
    const unmarked = withoutMarkers(fixtures(rel));
    expect(OLD_RULE.test(unmarked)).toBe(true);
    expect(status(unmarked).reason).not.toBe(STATUS_REASON.INPUT_PROMPT);
    expect(readIdleEvidence(normalizeFrame(unmarked, 'opencode'))).toBe('none');
  });

  it.each(IDLE_FRAMES)('%s: the real composer still is', (_name, raw) => {
    const text = stripAnsi(raw);
    expect(findOpenCodeIdleComposer(text)).not.toBeNull();
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.test(text)).toBe(true);
    expect(livenessComposer?.test(text)).toBe(true);
    expect(status(raw).status).not.toBe('running');
  });

  it('the boot frame is ready on the composer', () => {
    const verdict = status(detectionFixtures('opencode-live-1883/boot-idle.txt'));
    expect(verdict.status).toBe('ready');
    expect(verdict.reason).toBe(STATUS_REASON.INPUT_PROMPT);
  });

  it('the match spans the placeholder row to the end of the border', () => {
    const text = '  ┃  Ask anything...\n  ┃\n  ┃  Build · m\n  ╹▀▀▀▀▀\n  footer';
    const found = findOpenCodeIdleComposer(text);
    expect(found).not.toBeNull();
    expect(text.slice(found!.start, found!.end)).toBe('  ┃  Ask anything...\n  ┃\n  ┃  Build · m\n  ╹▀▀▀▀▀');
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.exec(text)?.index).toBe(0);
  });

  it('linear on a pane of placeholder rows with no border under them', () => {
    const text = Array.from({ length: 20000 }, () => '  ┃  Ask anything...').join('\n');
    const started = performance.now();
    expect(findOpenCodeIdleComposer(text)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('item 3: a reply\'s "Build " row and footer-status row are kept above the chrome', () => {
  const REPLY_ROWS: Array<[string, string]> = [
    ['a row opening with "Build "', '     Build the project with npm run build'],
    ['a row quoting the footer status cell', '     The footer shows 8.5K (1%) · $0.00 spent'],
  ];

  it.each(REPLY_ROWS)('%s: extracted and saved', (_name, row) => {
    const text = row.trim();
    // Positive control: the per-row list drops it, and the transcript list did too before #4209.
    expect(OPENCODE_SKIP_PATTERNS.some((p) => p.test(text))).toBe(true);
    expect([OPENCODE_MODEL_ROW_PATTERN, OPENCODE_FOOTER_STATUS_PATTERN].some((p) => p.test(text))).toBe(true);
    expect(OPENCODE_TRANSCRIPT_SKIP_PATTERNS.some((p) => p.test(text))).toBe(false);

    const frame = doneWith(row);
    const result = extract(frame);
    expect(result?.isComplete).toBe(true);
    const saved = save(result?.response ?? '');
    expect(saved).toContain(text);
    expect(saved).toContain('MOCK_OK');
  });

  it.each(DONE_FRAMES)('%s: the chrome\'s model row and footer cell are still not saved', (_name, raw) => {
    const result = extract(stripAnsi(raw));
    expect(result?.isComplete).toBe(true);
    const saved = save(result?.response ?? '');
    expect(saved.split('\n').some((line) => OPENCODE_MODEL_ROW_PATTERN.test(line))).toBe(false);
    expect(OPENCODE_FOOTER_STATUS_PATTERN.test(saved)).toBe(false);
    expect(saved).not.toContain('ctrl+p');
  });

  it.each(REPLY_ROWS)('%s, with no position (the per-row default list): still dropped', (_name, row) => {
    expect(cleanOpenCodeResponse(`MOCK_OK\n${row}`)).toBe('MOCK_OK');
  });
});

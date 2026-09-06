/**
 * Issue #2358: the model (and, where the pane prints one, the reasoning effort)
 * of a Command Code session, read off its startup banner.
 *
 * Command Code's hooks carry no model, so the `# models:` row of the banner is
 * the only source. Three sets of frames are read here:
 *
 *  - `tests/fixtures/chat-dialog-card-2254/command-code-model-1-4{0,7}-1*.txt`
 *    — 1.40.1 and the four 1.47.1 picker frames (#2254 / #2297 / #2326),
 *  - `tests/fixtures/command-code-live-2250/*.txt` — the six 1.40.1 frames
 *    (#2250) and the seven 1.49.0 frames (#2304), every one of which still
 *    carries the banner,
 *  - `tests/fixtures/chat-dialog-card-2254/command-code-model-1-49-0-*.txt` —
 *    four 1.49.0 frames captured live for THIS Issue, because the Issue's
 *    premise ("no effort, banner fixed until restart") did not survive a
 *    `/model` switch. That directory's README says what was measured and why
 *    the frames are there rather than beside the other model-info corpora.
 *
 * The banner-less case is the Issue's second acceptance criterion. No committed
 * frame under `command-code-live-2250/` lacks the banner — `turn-thinking-1490`,
 * the example the Issue names, has it on row 10 — so it is pinned two ways: a
 * live frame whose transcript pushed the banner out of the captured window
 * (`…-switch-banner-scrolled.txt`), and every banner-bearing frame cut below
 * its `# models:` row.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  COMMAND_CODE_BANNER_MODELS_PATTERN,
  extractModelInfo,
  mergeModelInfo,
} from '@/lib/detection/model-info-extractor';
import {
  clearAgentStopEvents,
  getLastCapturedModelInfo,
  getResolvedAgentModelInfo,
  recordCapturedModelInfo,
} from '@/lib/session/agent-event-state';

const UNKNOWN = { model: null, effort: null };
const LAUNCH_MODEL = { model: 'deepseek-v4-flash-(latest)', effort: null };

const REPO_FIXTURES = path.resolve(__dirname, '../../../fixtures');
const CARD_DIR = 'chat-dialog-card-2254';

const repoFrame = (rel: string): string => fs.readFileSync(path.join(REPO_FIXTURES, rel), 'utf8');
/** One of the four frames captured for this Issue (1.49.0, after `/model`). */
const liveFrame = (state: string): string =>
  repoFrame(`${CARD_DIR}/command-code-model-1-49-0-${state}.txt`);

/** The four frames captured for this Issue, by state. */
const LIVE_2358_STATES = ['boot-effort-max', 'switch-pro-high', 'switch-kimi-low', 'switch-banner-scrolled'] as const;

/** The frame from the row after its `# models:` row down — the banner scrolled off. */
function belowBanner(raw: string): string {
  const rows = raw.split('\n');
  const banner = rows.findIndex((row) => /# models:/.test(row));
  if (banner < 0) throw new Error('fixture has no banner row — the cut would be vacuous');
  return rows.slice(banner + 1).join('\n');
}

/** Every banner-bearing frame the Issue names, by repo-relative path (bare `<model> · taste-1` form). */
const BANNER_FRAMES: readonly string[] = [
  'chat-dialog-card-2254/command-code-model-1-40-1.txt',
  'chat-dialog-card-2254/command-code-model-1-47-1-closed.txt',
  'chat-dialog-card-2254/command-code-model-1-47-1-open.txt',
  'chat-dialog-card-2254/command-code-model-1-47-1-middle.txt',
  'chat-dialog-card-2254/command-code-model-1-47-1-bottom.txt',
  'command-code-live-2250/boot-idle.txt',
  'command-code-live-2250/turn-thinking.txt',
  'command-code-live-2250/turn-version.txt',
  'command-code-live-2250/dialog-create-file.txt',
  'command-code-live-2250/dialog-shell-command.txt',
  'command-code-live-2250/turn-tool-write.txt',
  'command-code-live-2250/boot-idle-1490.txt',
  'command-code-live-2250/turn-thinking-1490.txt',
  'command-code-live-2250/turn-done-1490.txt',
  'command-code-live-2250/turn-shell-running-1490.txt',
  'command-code-live-2250/dialog-shell-1490.txt',
  'command-code-live-2250/dialog-kill-task-1490.txt',
  'command-code-live-2250/idle-after-interrupt-1490.txt',
];

// =============================================================================
// The banner, bare form — the 18 frames that predate this Issue
// =============================================================================

describe('extractModelInfo: command-code banner (Issue #2358)', () => {
  it('names every command-code frame in the two repo corpora, so the sweeps below are not partial', () => {
    const onDisk = [
      ...fs
        .readdirSync(path.join(REPO_FIXTURES, CARD_DIR))
        .filter((f) => f.startsWith('command-code-') && f.endsWith('.txt'))
        .map((f) => `${CARD_DIR}/${f}`),
      ...fs
        .readdirSync(path.join(REPO_FIXTURES, 'command-code-live-2250'))
        .filter((f) => f.endsWith('.txt'))
        .map((f) => `command-code-live-2250/${f}`),
    ].sort();
    const named = [
      ...BANNER_FRAMES,
      ...LIVE_2358_STATES.map((state) => `${CARD_DIR}/command-code-model-1-49-0-${state}.txt`),
    ].sort();
    expect(named).toEqual(onDisk);
  });

  it.each(BANNER_FRAMES)('reads the launch model off %s', (rel) => {
    expect(extractModelInfo('command-code', repoFrame(rel))).toEqual(LAUNCH_MODEL);
  });

  it('keeps the `(latest)` suffix — it is how the /model picker spells the id', () => {
    // The open picker frame shows the same model as `DeepSeek V4 Flash (latest)`;
    // the id on the banner is the picker's spelling with the `(latest)` intact.
    const open = repoFrame('chat-dialog-card-2254/command-code-model-1-47-1-open.txt');
    expect(open).toContain('DeepSeek V4 Flash (latest)');
    expect(extractModelInfo('command-code', open).model).toBe('deepseek-v4-flash-(latest)');
  });

  it('does not read the picker rows as a model when the banner is cut away', () => {
    // The three open-picker frames list ~70 model NAMES below the banner.
    // Without the banner none of them is chrome this reader accepts.
    for (const name of ['open', 'middle', 'bottom']) {
      const raw = repoFrame(`chat-dialog-card-2254/command-code-model-1-47-1-${name}.txt`);
      expect(extractModelInfo('command-code', belowBanner(raw)), name).toEqual(UNKNOWN);
    }
  });

  it('reads the ANSI-bearing row as captured, on both SGR renderings', () => {
    // 1.40.1 / 1.47.1 colour the row with a truecolor SGR, 1.49.0 with a
    // 256-colour one. Both are matched after stripAnsi; a pattern applied to
    // the raw bytes would match neither.
    const truecolor = '\x1b[38;2;138;148;168m# models: deepseek-v4-flash-(latest) · taste-1\x1b[39m';
    const indexed = '\x1b[38;5;145m# models: deepseek-v4-flash-(latest) · taste-1\x1b[39m';
    expect(extractModelInfo('command-code', truecolor)).toEqual(LAUNCH_MODEL);
    expect(extractModelInfo('command-code', indexed)).toEqual(LAUNCH_MODEL);
    expect(COMMAND_CODE_BANNER_MODELS_PATTERN.test(truecolor)).toBe(false);
  });
});

// =============================================================================
// The banner after a /model switch — measured live on 1.49.0 for this Issue
// =============================================================================

describe('extractModelInfo: command-code banner after /model (Issue #2358, 1.49.0)', () => {
  it('reads `<model> with <effort> effort` when the effort is in the shared vocabulary', () => {
    expect(extractModelInfo('command-code', liveFrame('switch-pro-high'))).toEqual({
      model: 'deepseek-v4-pro-(latest)',
      effort: 'high',
    });
    expect(extractModelInfo('command-code', liveFrame('switch-kimi-low'))).toEqual({
      model: 'kimi-k3',
      effort: 'low',
    });
  });

  it('publishes the model and no effort for `max`, which is not a ReasoningEffort', () => {
    // `max` is a Command Code level with no counterpart in
    // REASONING_EFFORT_LEVELS. The model half is delimited by the literal
    // ` with … effort` frame, so it is read whole; the effort answers null.
    expect(extractModelInfo('command-code', liveFrame('boot-effort-max'))).toEqual({
      model: 'deepseek-v4-flash-(latest)',
      effort: null,
    });
  });

  it('answers unknown for the live frame whose banner scrolled out of the captured window', () => {
    const raw = liveFrame('switch-banner-scrolled');
    expect(raw).not.toContain('# models:');
    expect(extractModelInfo('command-code', raw)).toEqual(UNKNOWN);
  });

  it('is unknown, not a wrong value, on every banner-bearing frame cut below its banner', () => {
    for (const rel of BANNER_FRAMES) {
      expect(extractModelInfo('command-code', belowBanner(repoFrame(rel))), rel).toEqual(UNKNOWN);
    }
  });

  it('holds the four live frames at the production 200x1000 geometry, raw', () => {
    for (const name of LIVE_2358_STATES) {
      const raw = liveFrame(name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      const rows = raw.split('\n');
      if (rows[rows.length - 1] === '') rows.pop();
      expect(rows.length, `${name} rows`).toBe(1000);
      const widest = Math.max(
        ...rows.map((row) => row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r$/, '').length)
      );
      expect(widest, `${name} columns`).toBe(200);
    }
  });
});

// =============================================================================
// The pattern itself
// =============================================================================

describe('COMMAND_CODE_BANNER_MODELS_PATTERN', () => {
  it.each([
    ['# models: deepseek-v4-flash-(latest) · taste-1', 'deepseek-v4-flash-(latest)', null],
    ['# models: deepseek-v4-pro-(latest) with high effort · taste-1', 'deepseek-v4-pro-(latest)', 'high'],
    ['# models: kimi-k3 with low effort · taste-1', 'kimi-k3', 'low'],
    ['# models: minimax-m3 · taste-1', 'minimax-m3', null],
    // No taste suffix at all: the dot is optional.
    ['# models: deepseek-v4-flash-(latest)', 'deepseek-v4-flash-(latest)', null],
    ['# models: kimi-k3 with high effort', 'kimi-k3', 'high'],
    // Leading indent and a different taste value change nothing.
    ['   # models: gpt-5.5 · taste-2', 'gpt-5.5', null],
  ])('reads %s', (line, model, effort) => {
    expect(extractModelInfo('command-code', line)).toEqual({ model, effort });
  });

  it('answers null effort for a level outside the shared vocabulary, model intact', () => {
    expect(extractModelInfo('command-code', '# models: deepseek-v4-flash-(latest) with max effort · taste-1'))
      .toEqual({ model: 'deepseek-v4-flash-(latest)', effort: null });
  });

  it.each([
    // The sibling banner rows.
    '# Command Code v1.49.0',
    '# /private/tmp/cc2358-probe/work',
    // A user prompt echo and a picker row carrying the picker's spelling.
    '❯ # models: deepseek-v4-flash-(latest) · taste-1',
    'DeepSeek V4 Flash (latest) (default)  fast hybrid-attention reasoning',
    // The effort screen names the model but is not the banner.
    'Select reasoning effort for DeepSeek V4 Flash (latest)',
    // Keyword present, value absent or implausible.
    '# models:',
    '# models: · taste-1',
    '# models: ▣ · taste-1',
    '# models: ? · taste-1',
  ])('does not read %s', (line) => {
    expect(extractModelInfo('command-code', line)).toEqual(UNKNOWN);
  });

  it('rejects a runaway value longer than a model id can be', () => {
    expect(extractModelInfo('command-code', `# models: ${'x'.repeat(65)} · taste-1`)).toEqual(UNKNOWN);
  });

  it('scans bottom-up, so the lowest banner on the pane wins', () => {
    // A relaunch in the same pane leaves the old banner in scrollback above
    // the new one; a /model switch rewrites the one row in place. Either way
    // the row nearest the composer is the live one.
    const capture = [
      '# models: minimax-m3 · taste-1',
      '',
      '# Command Code v1.49.0',
      '# models: kimi-k3 with low effort · taste-1',
      '❯ Ask your question...',
    ].join('\n');
    expect(extractModelInfo('command-code', capture)).toEqual({ model: 'kimi-k3', effort: 'low' });
  });

  it('carries no /g flag and no nested quantifier, and returns promptly on a hostile line', () => {
    expect(COMMAND_CODE_BANNER_MODELS_PATTERN.global).toBe(false);
    expect(COMMAND_CODE_BANNER_MODELS_PATTERN.source).not.toMatch(/[+*?}]\s*\)\s*[+*{]/);
    for (const hostile of [
      `${' '.repeat(400)}${'·'.repeat(200)}${'a '.repeat(400)}`,
      `# models: ${'a '.repeat(2000)}with`,
      `# models: ${'with '.repeat(2000)}effort`,
    ]) {
      const started = Date.now();
      COMMAND_CODE_BANNER_MODELS_PATTERN.test(hostile);
      expect(Date.now() - started).toBeLessThan(200);
    }
  });
});

// =============================================================================
// The latch — agent-event-state's existing rule, exercised end to end
// =============================================================================

describe('command-code model info survives the banner scrolling off (Issue #2358)', () => {
  const WT = 'wt-2358';

  beforeEach(() => clearAgentStopEvents());
  afterEach(() => clearAgentStopEvents());

  /** What the status poll does: capture → extract → latch. */
  const poll = (capture: string): void =>
    recordCapturedModelInfo(WT, 'command-code', 'command-code', extractModelInfo('command-code', capture));

  it('keeps the last banner value once the banner has left the captured window', () => {
    poll(repoFrame('command-code-live-2250/boot-idle-1490.txt'));
    expect(getLastCapturedModelInfo(WT, 'command-code', 'command-code')).toEqual(LAUNCH_MODEL);

    poll(liveFrame('switch-banner-scrolled'));
    expect(getLastCapturedModelInfo(WT, 'command-code', 'command-code')).toEqual(LAUNCH_MODEL);
    // No hook ever names a model for this tool, so the resolved value IS the latch.
    expect(getResolvedAgentModelInfo(WT, 'command-code', 'command-code')).toEqual(LAUNCH_MODEL);
  });

  it('takes a /model switch that the rewritten banner shows, effort included', () => {
    poll(repoFrame('command-code-live-2250/boot-idle-1490.txt'));
    poll(liveFrame('switch-pro-high'));
    expect(getResolvedAgentModelInfo(WT, 'command-code', 'command-code')).toEqual({
      model: 'deepseek-v4-pro-(latest)',
      effort: 'high',
    });
  });

  it('merges with no hook model: the screen is the only source for this tool', () => {
    expect(mergeModelInfo('command-code', null, { model: 'kimi-k3', effort: 'low' })).toEqual({
      model: 'kimi-k3',
      effort: 'low',
    });
    expect(mergeModelInfo('command-code', null, UNKNOWN)).toEqual(UNKNOWN);
  });
});

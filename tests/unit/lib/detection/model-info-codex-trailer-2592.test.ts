/**
 * codex's model / effort, read off a status bar that does not end in the path
 * (Issue #2592, UAT F3).
 *
 * codex 0.154.0 appends a thread-title segment and, in Plan mode, a
 * right-aligned badge after the path:
 *
 *   `  gpt-6-astra medium · ~/uat3-20260916/sandbox-repo · Reply with one word    …    Plan mode (shift+tab to cycle)`
 *
 * `CODEX_STATUS_BAR_PATTERN` requires the row to END in the path, so the
 * extractor answered null on every such frame and the effort latched from the
 * one bar codex draws before its first turn (`xhigh`) stayed on the UI for the
 * rest of the session. Plan mode moves codex to `medium`; the UAT saw the pane
 * say so and the UI keep saying `xhigh` for 12 s and beyond.
 *
 * The fix is a second, extractor-local reading. `CODEX_STATUS_BAR_PATTERN` is the
 * footer boundary codex's running/idle rules are windowed on (#1150) and is
 * deliberately NOT widened — the last block here pins that the status verdicts
 * on these frames are what they were before this change.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CODEX_STATUS_BAR_WITH_TRAILER_PATTERN,
  extractModelInfo,
} from '@/lib/detection/model-info-extractor';
import { CODEX_STATUS_BAR_PATTERN } from '@/lib/detection/cli-patterns';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import {
  clearAgentStopEvents,
  getResolvedAgentModelInfo,
  recordCapturedModelInfo,
} from '@/lib/session/agent-event-state';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/agent-mode-2592');
const frame = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
/** Row 40 of the codex fixtures is the status bar. */
const bar = (name: string): string => frame(name).split('\n')[39];

describe('[#2592 F3] the trailer-bearing bar yields model and effort', () => {
  it.each([
    // Live capture, Plan mode, thread titled.
    ['codex-plan.txt', { model: 'gpt-6-astra', effort: 'medium' }],
    // Default mode after the cycle came back — the UAT log's step 2 bar.
    ['codex-default-thread-title.txt', { model: 'gpt-6-astra', effort: 'xhigh' }],
    // The badge with no thread title yet: the column-gap trailer.
    ['codex-plan-no-thread-title.txt', { model: 'gpt-6-astra', effort: 'medium' }],
  ] as const)('%s', (name, expected) => {
    expect(extractModelInfo('codex', frame(name))).toEqual(expected);
  });

  it('still reads the pre-0.154 bar that ends in the path', () => {
    // The shape #1784 was written for — unchanged. The bar reads
    // `gpt-5.6-sol default`: codex's `None` effort, which names no level, so the
    // effort is null and — since Issue #2835 — flagged as shown-but-unreadable,
    // which is what stops the latch keeping an older effort beside it.
    expect(extractModelInfo('codex', frame('codex-default.txt'))).toEqual({
      model: 'gpt-5.6-sol',
      effort: null,
      effortUnreadable: true,
    });
  });

  it('prefers the live bar to the transcript’s older banner', () => {
    // The live frame also carries the launch box
    // (`│ model:     gpt-6-astra xhigh   /model to change │`) — the value the UI
    // was stuck on. The bar is the bottom-most match and wins.
    const text = frame('codex-plan.txt');
    expect(text).toContain('gpt-6-astra xhigh   /model to change');
    expect(extractModelInfo('codex', text).effort).toBe('medium');
  });
});

describe('[#2592 F3] the latch follows the mode now', () => {
  const WT = 'wt-2592-codex';
  beforeEach(() => clearAgentStopEvents());
  afterEach(() => clearAgentStopEvents());

  /** What the status poll does: capture → extract → latch. */
  const poll = (name: string): void =>
    recordCapturedModelInfo(WT, 'codex', 'codex', extractModelInfo('codex', frame(name)));

  it('moves xhigh -> medium -> xhigh across a Default/Plan/Default cycle', () => {
    // The UAT's exact complaint: before the fix only the first sighting ever
    // latched, so every later poll left `xhigh` in place.
    poll('codex-default-thread-title.txt');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex').effort).toBe('xhigh');

    poll('codex-plan.txt');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex')).toEqual({
      model: 'gpt-6-astra',
      effort: 'medium',
    });

    poll('codex-default-thread-title.txt');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex').effort).toBe('xhigh');
  });
});

describe('[#2592 F3] the trailer reading stays narrow', () => {
  it('needs a `·` segment or a column gap after the path', () => {
    // A path followed by ONE space and more words is prose about a file, not a
    // bar with a trailer.
    expect(CODEX_STATUS_BAR_WITH_TRAILER_PATTERN.test('  gpt-6 high · ~/repo then some prose')).toBe(false);
    expect(CODEX_STATUS_BAR_WITH_TRAILER_PATTERN.test('  gpt-6 high · ~/repo · title')).toBe(true);
    expect(CODEX_STATUS_BAR_WITH_TRAILER_PATTERN.test('  gpt-6 high · ~/repo      Plan mode (x)')).toBe(true);
  });

  it('still refuses a sentence with no version number and no effort', () => {
    // The digit-or-effort guard in `readCodexFooter` applies to both readings;
    // a value read here LATCHES, so prose must not get through.
    expect(extractModelInfo('codex', '  Updated the README · /docs/readme.md · done')).toEqual({
      model: null,
      effort: null,
    });
  });

  it('is not a global pattern', () => {
    expect(CODEX_STATUS_BAR_WITH_TRAILER_PATTERN.global).toBe(false);
  });
});

describe('[#2592 F3] the detection boundary was not moved', () => {
  it('CODEX_STATUS_BAR_PATTERN still declines the 0.154 trailer bars', () => {
    // If this starts matching, somebody widened the boundary the codex
    // running/idle rules are windowed on (#1150) — which is a detection change
    // and needs its own measurement, not a side effect of a model reader.
    for (const name of ['codex-plan.txt', 'codex-default-thread-title.txt', 'codex-plan-no-thread-title.txt']) {
      expect(CODEX_STATUS_BAR_PATTERN.test(bar(name)), name).toBe(false);
    }
    expect(CODEX_STATUS_BAR_PATTERN.test('  gpt-5.6-sol xhigh · ~/share/work/repo')).toBe(true);
  });

  it.each(['codex-plan.txt', 'codex-default-thread-title.txt', 'codex-plan-no-thread-title.txt'])(
    '%s is read as a resting pane, as the UAT observed',
    (name) => {
      const result = detectSessionStatus(frame(name), 'codex');
      expect(result.status).toBe('ready');
      expect(result.reason).toBe('input_prompt');
    },
  );
});

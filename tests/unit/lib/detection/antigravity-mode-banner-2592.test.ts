/**
 * agy's permission-mode banner is an EMPTY input box, not an unknown screen
 * (Issue #2592, UAT F2).
 *
 * agy 1.2.4 paints a banner into its empty composer while accept-edits or plan
 * is on, in place of the bare `>` it shows in default:
 *
 *   `> Accept-edits mode: file edits auto-approved (shift+tab to cycle)`
 *   `> Plan mode: research & plan only (shift+tab to cycle)`
 *
 * The idle rule only knew the bare glyph, so a RESTING pane in either mode fell
 * to the detector's `default` floor. The UAT measured every consequence of that:
 * `/current-output` published `isUnclassifiedActive: true`, `commandmate ls`
 * showed the agent as running, `wait` never completed, and the #2592 mode button
 * — which refuses unclassified frames on purpose — could switch INTO
 * accept-edits once and never back out.
 *
 * The same frames also answered `false` from `isAntigravityReady`, the gate
 * `sendMessage` waits on — so a send in either mode would have timed out too. The
 * UAT did not reach that path; this suite pins it anyway, because the fix is one
 * pattern and all of its consumers ask the same question.
 *
 * Every frame here is a live capture from the UAT
 * (`tests/fixtures/agent-mode-2592/README.md`, provenance A).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import {
  ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN,
  ANTIGRAVITY_PROMPT_PATTERN,
} from '@/lib/detection/cli-patterns';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';
import { isAntigravityReady } from '@/lib/cli-tools/antigravity';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { detectAgentMode } from '@/lib/detection/agent-mode';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/agent-mode-2592');
const frame = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const MODES = ['default', 'accept-edits', 'plan'] as const;

/** One row of a frame, 1-indexed, as the fixture README cites it. */
const row = (text: string, n: number): string => text.split('\n')[n - 1];

describe('[#2592 F2] a resting agy pane is ready in every mode', () => {
  it.each(MODES)('%s: ready / input_prompt, not unclassified', (mode) => {
    const result = detectSessionStatus(frame(`antigravity-${mode}.txt`), 'antigravity');

    expect(result.status).toBe('ready');
    expect(result.reason).toBe('input_prompt');
    // The published `isUnclassifiedActive` is exactly this predicate
    // (`current-output-builder` calls it), so this is the flag the UAT saw.
    expect(isUnclassifiedFrame(result.status, result.reason)).toBe(false);
  });

  it.each(MODES)('%s: the send gate opens', (mode) => {
    expect(isAntigravityReady(frame(`antigravity-${mode}.txt`))).toBe(true);
  });

  it.each(MODES)('%s: the mode button’s read-back agrees with the footer', (mode) => {
    // The two halves of F1 and F2 on one frame: the chip reads the mode, AND the
    // frame is at rest, so the button that would change it is enabled.
    const expected = mode === 'default' ? 'unknown' : mode;
    expect(detectAgentMode('antigravity', frame(`antigravity-${mode}.txt`))).toBe(expected);
  });
});

describe('[#2592 F2] the banner does not hide a turn in flight', () => {
  it.each(['accept-edits', 'plan'] as const)(
    '%s: a generating footer still reads running',
    (mode) => {
      // agy replaces `? for shortcuts` with `esc to cancel` while it generates
      // (#988). The thinking check runs BEFORE the idle rule, so accepting the
      // banner as an empty box must not turn a busy pane into a ready one.
      // Constructed: the live row 20 with its hint swapped for the busy one.
      const live = frame(`antigravity-${mode}.txt`).split('\n');
      live[19] = live[19].replace('? for shortcuts', 'esc to cancel  ');
      const result = detectSessionStatus(live.join('\n'), 'antigravity');

      expect(result.status).toBe('running');
      expect(isAntigravityReady(live.join('\n'))).toBe(false);
    },
  );
});

describe('[#2592 F2] the banner pattern', () => {
  it('matches both measured banners, verbatim from the live frames', () => {
    const acceptEdits = row(frame('antigravity-accept-edits.txt'), 18);
    const plan = row(frame('antigravity-plan.txt'), 18);

    expect(acceptEdits).toBe('> Accept-edits mode: file edits auto-approved (shift+tab to cycle)');
    expect(plan).toBe('> Plan mode: research & plan only (shift+tab to cycle)');
    expect(ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN.test(acceptEdits)).toBe(true);
    expect(ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN.test(plan)).toBe(true);
  });

  it('is folded into the prompt pattern, which still accepts the bare box', () => {
    expect(ANTIGRAVITY_PROMPT_PATTERN.test('>')).toBe(true);
    expect(ANTIGRAVITY_PROMPT_PATTERN.test('> ')).toBe(true);
    expect(ANTIGRAVITY_PROMPT_PATTERN.test(row(frame('antigravity-plan.txt'), 18))).toBe(true);
  });

  it('does not accept a box with text typed into it', () => {
    // Typed text is what the trailing key hint rules out: nobody types
    // `(shift+tab to cycle)`. A box holding the user's words is not empty, in
    // any mode, and was never read as one.
    for (const typed of ['> hello', '> Plan mode: my own words', '> plan mode: x (shift+tab to cycle) and more']) {
      expect(ANTIGRAVITY_PROMPT_PATTERN.test(typed), typed).toBe(false);
    }
  });

  it('is not a global pattern', () => {
    // Shared, module-level, and `.test()`-ed from four consumers.
    expect(ANTIGRAVITY_PROMPT_PATTERN.global).toBe(false);
    expect(ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN.global).toBe(false);
  });

  it('keeps the liveness probe’s alive set in step', () => {
    // `liveness-spec` reads the same constant, so a pane sitting in plan mode is
    // agy's own drawing and never a candidate for "the tool exited".
    const { alivePatterns } = resolveLivenessSpec('antigravity');
    const planBanner = row(frame('antigravity-plan.txt'), 18);
    expect(alivePatterns.some((pattern) => pattern.test(planBanner))).toBe(true);
  });
});

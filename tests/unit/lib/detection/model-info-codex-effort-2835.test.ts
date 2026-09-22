/**
 * codex's reasoning effort above `xhigh`, and the effort a frame shows but
 * cannot name (Issue #2835).
 *
 * codex 0.155.1 defines `max` / `ultra` / `persistent` above `xhigh`
 * (`ReasoningEffort`, `codex-rs/protocol/src/openai_models.rs`, tag
 * `rust-v0.155.1`) and draws each verbatim in the status bar
 * (`status_line_reasoning_effort_label`): `  gpt-5.6-terra max · ~/…`. The
 * shared vocabulary stopped at `xhigh`, so the bar's effort answered null and
 * both JSON surfaces (`ls --json` omitted the key, `instances --json` said
 * null) could not confirm a session the pane showed running at `max`.
 *
 * The second half is the latch. It keeps the last effort a frame proved when a
 * later frame does not show one — right for a banner that scrolled away, wrong
 * for a codex bar that shows a DIFFERENT effort it cannot name: a session moved
 * from `xhigh` to `max` kept publishing `xhigh`, a wrong value rather than an
 * unknown one. A bar with a word where the effort goes now drops the latched
 * effort instead.
 *
 * The `max` frames here are the recorded 0.147 capture with the pair replaced
 * (asserted below, so a fixture edit cannot silently turn them into no-ops);
 * `codex-default.txt` is a live 0.154 capture whose bar reads `default`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CODEX_FOOTER_EFFORT_SLOT_PATTERN,
  REASONING_EFFORT_LEVELS,
  extractModelInfo,
  resolveEffortToken,
} from '@/lib/detection/model-info-extractor';
import { CODEX_STATUS_BAR_PATTERN } from '@/lib/detection/cli-patterns';
import {
  clearAgentStopEvents,
  getResolvedAgentModelInfo,
  recordCapturedModelInfo,
} from '@/lib/session/agent-event-state';
import {
  CODEX_FOOTER_CAPTURE_V0_147,
  CODEX_FOOTER_CAPTURE_V0_147_ANSI,
} from '../../../fixtures/model-info-captures';

const DEFAULT_EFFORT_FRAME = fs.readFileSync(
  path.join(process.cwd(), 'tests/fixtures/agent-mode-2592/codex-default.txt'),
  'utf8',
);

/** The recorded 0.147 frame, re-pointed at the model and effort of the Issue. */
function terraMax(capture: string): string {
  const replaced = capture.split('gpt-5.6-sol xhigh').join('gpt-5.6-terra max');
  expect(replaced).not.toBe(capture);
  return replaced;
}

describe('[#2835] the levels above xhigh are read off the codex bar', () => {
  it('reads `max` off the recorded frame', () => {
    expect(extractModelInfo('codex', terraMax(CODEX_FOOTER_CAPTURE_V0_147))).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'max',
    });
  });

  it('reads `max` with the SGR sequences intact', () => {
    expect(extractModelInfo('codex', terraMax(CODEX_FOOTER_CAPTURE_V0_147_ANSI))).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'max',
    });
  });

  it('reads `max` off the 0.154+ bar with a thread title and a Plan-mode badge', () => {
    expect(
      extractModelInfo('codex', '  gpt-5.6-terra max · ~/repo · Reply with one word          Plan mode (shift+tab to cycle)'),
    ).toEqual({ model: 'gpt-5.6-terra', effort: 'max' });
  });

  it.each(REASONING_EFFORT_LEVELS)('reads every shared level off a bar: %s', (level) => {
    // Pins CODEX_FOOTER_MODEL_PATTERN's literal alternation to the list, so a
    // level added to one and not the other fails here.
    expect(extractModelInfo('codex', `  gpt-5.6-terra ${level} · ~/share/work/repo`)).toEqual({
      model: 'gpt-5.6-terra',
      effort: level,
    });
  });

  it('keeps `default` out of the vocabulary: it is codex\'s None, not a level', () => {
    expect(resolveEffortToken('default')).toBeNull();
    expect(resolveEffortToken('max')).toBe('max');
    expect(resolveEffortToken('ULTRA')).toBe('ultra');
    expect(resolveEffortToken('persistent')).toBe('persistent');
  });

  it('does not move the detection boundary', () => {
    // The status verdicts are windowed on this pattern (#1150); it never listed
    // effort words, and a `max` bar is a bar to it exactly as `xhigh` was.
    expect(CODEX_STATUS_BAR_PATTERN.test('  gpt-5.6-terra max · ~/share/work/repo')).toBe(true);
  });
});

describe('[#2835] a bar that shows an effort it cannot name', () => {
  it('flags the live `default` bar', () => {
    expect(extractModelInfo('codex', DEFAULT_EFFORT_FRAME)).toEqual({
      model: 'gpt-5.6-sol',
      effort: null,
      effortUnreadable: true,
    });
  });

  it('flags a model-defined value codex draws verbatim', () => {
    expect(extractModelInfo('codex', '  gpt-5.6-terra turbo · ~/share/work/repo')).toEqual({
      model: 'gpt-5.6-terra',
      effort: null,
      effortUnreadable: true,
    });
  });

  it.each([
    // Legacy o4-mini: the second token is the quota, not an effort slot.
    ['  o4-mini            50% left · /a/b', { model: 'o4-mini', effort: null }],
    // A status line configured to show the model alone.
    ['  gpt-5.6-terra · ~/share/work/repo', { model: 'gpt-5.6-terra', effort: null }],
  ] as const)('does not flag a bar with no effort slot: %s', (line, expected) => {
    expect(extractModelInfo('codex', line)).toEqual(expected);
  });

  it('still refuses prose: no version number and no effort', () => {
    expect(extractModelInfo('codex', '  Updated the README · /docs/readme.md')).toEqual({
      model: null,
      effort: null,
    });
  });

  it('is a plain, non-global pattern', () => {
    expect(CODEX_FOOTER_EFFORT_SLOT_PATTERN.global).toBe(false);
    expect(CODEX_FOOTER_EFFORT_SLOT_PATTERN.test('  gpt-5.6-terra default ')).toBe(true);
    expect(CODEX_FOOTER_EFFORT_SLOT_PATTERN.test('  o4-mini            50% left ')).toBe(false);
  });
});

describe('[#2835] the latch follows the effort the bar shows', () => {
  const WT = 'wt-2835-codex';
  beforeEach(() => clearAgentStopEvents());
  afterEach(() => clearAgentStopEvents());

  /** What the status poll does: capture → extract → latch. */
  const poll = (capture: string, instanceId = 'codex-2'): void =>
    recordCapturedModelInfo(WT, 'codex', instanceId, extractModelInfo('codex', capture));

  it('publishes `max` for the Issue\'s session', () => {
    poll(terraMax(CODEX_FOOTER_CAPTURE_V0_147_ANSI));
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex-2')).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'max',
    });
  });

  it('moves xhigh -> max in one session', () => {
    poll('  gpt-5.6-terra xhigh · ~/share/work/repo');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex-2').effort).toBe('xhigh');
    poll('  gpt-5.6-terra max · ~/share/work/repo');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex-2').effort).toBe('max');
  });

  it('drops a latched effort when the bar shows one it cannot name', () => {
    // Before the fix this answered `xhigh` — the value the session had left.
    poll('  gpt-5.6-terra xhigh · ~/share/work/repo');
    poll('  gpt-5.6-terra turbo · ~/share/work/repo');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex-2')).toEqual({
      model: 'gpt-5.6-terra',
      effort: null,
    });
    poll(DEFAULT_EFFORT_FRAME);
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex-2')).toEqual({
      model: 'gpt-5.6-sol',
      effort: null,
    });
  });

  it('still keeps it for a frame that shows no effort at all', () => {
    // The rule #1784 set, for the frames it was written for: no bar on screen
    // (a picker drawn over it), or a bar with no effort slot.
    poll('  gpt-5.6-terra max · ~/share/work/repo');
    poll('no chrome here');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex-2').effort).toBe('max');
    poll('  gpt-5.6-terra · ~/share/work/repo');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex-2').effort).toBe('max');
  });

  it('keeps each instance to itself', () => {
    poll('  gpt-5.6-terra max · ~/share/work/repo', 'codex-2');
    poll('  gpt-6-astra xhigh · ~/share/work/repo', 'codex');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex-2').effort).toBe('max');
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex').effort).toBe('xhigh');
  });
});

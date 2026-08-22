/**
 * The `ToolStatusDetector` contract (Issue #1927, 方針書 §4 D2).
 *
 * Three things this file is for, none of which any single tool's suite can
 * answer:
 *
 *  1. **The registry is total.** Every `CLIToolType` resolves to a detector,
 *     including the ones with no rules of their own, so no caller needs a "does
 *     this tool have a module?" branch.
 *  2. **`detectDialog` is a seam, not an implementation.** #1927 lands the口
 *     and nothing behind it; Issue #1928 fills it with the per-tool dialog rules
 *     and wires `response-checker` to them (§4 D1 決定 4). If this file ever
 *     asserts a non-null verdict, check that #1928 has actually landed and this
 *     is not a rule that leaked in early.
 *  3. **`unknown_frame` is defined AND used.** A reason constant nobody produces
 *     is the "empty green" §13.1 warns about — `grep` finds it, and it means
 *     nothing.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import {
  getToolStatusDetector,
  TOOL_STATUS_DETECTORS,
} from '@/lib/detection/tools/registry';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import {
  GENERATING_REASONS,
  isGeneratingStatus,
  SELECTION_LIST_REASONS,
  STATUS_REASON,
} from '@/lib/detection/status-detector';
import type { CLIToolType } from '@/lib/cli-tools/types';

describe('[#1927] the registry answers for every tool', () => {
  it.each(CLI_TOOL_IDS)('%s resolves to a detector that names itself', id => {
    const detector = getToolStatusDetector(id as CLIToolType);

    expect(detector.tool).toBe(id);
    expect(typeof detector.detect).toBe('function');
    expect(typeof detector.detectDialog).toBe('function');
  });

  it('records what each detector was measured against', () => {
    // Not decoration: every rule in a tool module was read off a capture of one
    // build at one pane geometry, and recording which one is what lets a later
    // reader tell "this rule is wrong" from "this rule was right for 1.0.80".
    for (const detector of TOOL_STATUS_DETECTORS) {
      expect(detector.verifiedAgainst.version, detector.tool).toBeTruthy();
      expect(detector.verifiedAgainst.capturedAt, detector.tool).toBeTruthy();
      expect(detector.verifiedAgainst.paneGeometry, detector.tool).toBeTruthy();
    }
  });

  it('falls back rather than throwing for an id from outside the union', () => {
    // Callers reach this from route params and CLI flags. "No tool-specific
    // rules apply" is a better answer there than a crash in the status poller.
    const detector = getToolStatusDetector('not-a-tool' as CLIToolType);

    expect(detector.tool).toBe('not-a-tool');
    expect(detector.detect(normalizeFrame('nothing in particular')).evidence).toBe('none');
  });
});

describe('[#1927] detectDialog is the seam Issue #1928 fills', () => {
  it.each(TOOL_STATUS_DETECTORS.map(d => [d.tool, d] as const))(
    '%s answers null for every frame today',
    (_tool, detector) => {
      // The口 exists so #1928 has somewhere to put the per-tool dialog rules and
      // Auto-Yes has something to read (D1 決定 4: Auto-Yes may fire only on a
      // POSITIVELY detected tool dialog, never on the generic numbered-list
      // inference). Implementing it here would leave that Issue with nothing.
      for (const frame of ['', '❯ ', '1. Yes\n2. No\npress enter to confirm']) {
        expect(detector.detectDialog(normalizeFrame(frame))).toBeNull();
      }
    },
  );
});

describe('[#1927] unknown_frame is defined and produced', () => {
  it('is the floor for the tools whose own rules are the only rules', () => {
    // copilot and opencode opt out of the generic composer check, so nothing
    // else can speak for them; `unknown_frame` says "this tool's measured rules
    // looked and found nothing", which names an action (capture a fixture).
    for (const tool of ['copilot', 'opencode'] as const) {
      const verdict = getToolStatusDetector(tool).detect(
        normalizeFrame('a pane in a state nobody has measured'),
      );
      expect(verdict.reason).toBe(STATUS_REASON.UNKNOWN_FRAME);
      expect(verdict.status).toBe('running');
      expect(verdict.evidence).toBe('none');
    }
  });

  it('is NOT the floor for a tool the generic composer check still serves', () => {
    // Claude reaches the floor only when there was no composer row to read
    // either — the generic "nothing matched anywhere" case `default` names.
    for (const tool of ['claude', 'codex', 'gemini'] as const) {
      const verdict = getToolStatusDetector(tool).detect(
        normalizeFrame('a pane in a state nobody has measured'),
      );
      expect(verdict.reason, tool).toBe(STATUS_REASON.DEFAULT);
      expect(verdict.evidence, tool).toBe('none');
    }
  });

  it('keeps `unknown_frame` out of the reason sets that drive UI affordances', () => {
    // It is a `running` floor, not a selection list and not a generation
    // indicator. Putting it in either set would light a spinner or render
    // NavigationButtons for a frame nobody could read.
    expect(STATUS_REASON.UNKNOWN_FRAME).toBe('unknown_frame');
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.UNKNOWN_FRAME)).toBe(false);
    expect(GENERATING_REASONS.has(STATUS_REASON.UNKNOWN_FRAME)).toBe(false);
    expect(
      isGeneratingStatus({ status: 'running', reason: STATUS_REASON.UNKNOWN_FRAME }),
    ).toBe(false);
  });
});

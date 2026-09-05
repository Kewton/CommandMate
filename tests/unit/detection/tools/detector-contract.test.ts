/**
 * The `ToolStatusDetector` contract (Issue #1927, 方針書 §4 D2).
 *
 * Three things this file is for, none of which any single tool's suite can
 * answer:
 *
 *  1. **The registry is total.** Every `CLIToolType` resolves to a detector,
 *     including the ones with no rules of their own, so no caller needs a "does
 *     this tool have a module?" branch.
 *  2. **`detectDialog` is a seam with a rollout.** #1927 landed the口; Issue
 *     #1928 filled it per tool and wired the Auto-Yes poller to it (§4 D1 決定
 *     4). What this file owns is the boundary: WHICH tools declared rules, and
 *     that `hasDialogRules` — not the presence of the function, which the
 *     factory always supplies — is how a caller tells "nobody has measured this
 *     tool" from "this frame is not my dialog". The per-tool rules themselves
 *     are pinned against live captures in `tools/dialogs.test.ts`.
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

describe('[#1928] detectDialog is the seam Auto-Yes reads', () => {
  /**
   * The rollout, as a table rather than as a property of whichever modules
   * happen to import a `prompt.ts`.
   *
   * `true` means the tool's dialogs were measured from its own live captures and
   * the Auto-Yes gate may therefore hold it to them (D1 決定 4: Auto-Yes fires
   * only on a POSITIVELY detected tool dialog, never on the generic
   * numbered-list inference). `false` means nobody has measured that tool, and
   * gating it would silence its Auto-Yes rather than sharpen it.
   */
  const DIALOG_RULES_BY_TOOL: Readonly<Record<string, boolean>> = {
    claude: true,
    codex: true,
    copilot: true,
    opencode: true,
    gemini: false,
    antigravity: false,
    'vibe-local': false,
    // Issue #2250 / Epic #2249 決定 3: Command Code fires `PreToolUse` AFTER its
    // permission dialog is answered, so a hook-driven decision cannot dismiss
    // the dialog and Auto-Yes stays on the numbered-response path.
    'command-code': false,
  };

  it('declares which tools have measured dialog rules', () => {
    // Pinned by equality: adding a tool to the gate has to be a visible diff to
    // this line, for the same reason the idle-evidence table is pinned that way.
    expect(
      Object.fromEntries(TOOL_STATUS_DETECTORS.map(d => [d.tool, d.hasDialogRules])),
    ).toEqual(DIALOG_RULES_BY_TOOL);
  });

  it.each(TOOL_STATUS_DETECTORS.map(d => [d.tool, d] as const))(
    '%s reads a frame with no dialog on it as null',
    (_tool, detector) => {
      for (const frame of ['', '❯ ', 'nothing interactive here']) {
        expect(detector.detectDialog(normalizeFrame(frame))).toBeNull();
      }
    },
  );

  it.each(TOOL_STATUS_DETECTORS.filter(d => !d.hasDialogRules).map(d => [d.tool, d] as const))(
    '%s has no rules, so it answers null even for a frame that looks like a dialog',
    (_tool, detector) => {
      // The substitute `createToolStatusDetector` installs. `hasDialogRules` is
      // what tells the gate this null means "nobody looked" rather than "this is
      // not my dialog" — the two must not lead to the same action.
      expect(
        detector.detectDialog(normalizeFrame('❯ 1. Yes\n  2. No\npress enter to confirm')),
      ).toBeNull();
    },
  );

  it('answers a positively recognised dialog with its options and answer mode', () => {
    // codex's own shape, and the narrowest possible statement that the seam is
    // filled: the footer is what vouches for the block (Issue #1628), so the
    // same rows without it must answer null.
    const withFooter = '  Run this?\n› 1. Yes\n  2. No\n\n  Press enter to confirm or esc to cancel';
    const withoutFooter = '  Run this?\n› 1. Yes\n  2. No';

    expect(getToolStatusDetector('codex').detectDialog(normalizeFrame(withFooter))).toEqual({
      kind: 'permission',
      options: ['Yes', 'No'],
      answerMode: 'numbered',
    });
    expect(getToolStatusDetector('codex').detectDialog(normalizeFrame(withoutFooter))).toBeNull();
  });
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

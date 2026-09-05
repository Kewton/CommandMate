/**
 * GitHub Copilot CLI's detection fixtures (Issue #1927, 方針書 §11 / §4 D2).
 *
 * The captures themselves landed with Issue #1885 and stay where that suite
 * reads them (`tests/unit/lib/detection/fixtures/copilot-live-1885/`) — copying
 * 200x1000 frames to a second directory would give the repository two answers to
 * "what did copilot 1.0.80 draw". What #1927 adds is the sweep §11 requires
 * over them: the full verdict INCLUDING `evidence`, and the mutation case.
 *
 * copilot needed no new rule. #1885 had already put it in the §4 D1 shape — the
 * bottom status bar is read in both directions (`◉ Working … esc interrupt` /
 * key hints) and the generic composer check is opted out — which is why copilot
 * ships with `enforce` in `detection-evidence-config.ts` rather than waiting for
 * a rule of its own.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { copilotStatusDetector } from '@/lib/detection/tools/copilot/detect';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { rewordBottomRow, runToolFixtureSuite } from '../fixture-sweep';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../lib/detection/fixtures/copilot-live-1885/', import.meta.url),
);

describe('[#1927] copilot detection fixtures', () => {
  runToolFixtureSuite({
    tool: 'copilot',
    fixtureDir: FIXTURE_DIR,
    paneRows: 1000,
    busyWord: 'interrupt',
    rewordedBusyWord: 'dismissal',
    idleFrames: ['boot-idle', 'turn-complete', 'status-vocabulary-in-response'],
    mutationFrames: ['turn-running-thinking', 'turn-running-early'],
    expectations: [
      {
        frame: 'boot-idle',
        status: 'ready',
        reason: STATUS_REASON.INPUT_PROMPT,
        evidence: 'positive',
      },
      // A `/model` picker: copilot draws it INSTEAD of its bottom chrome, so
      // `isCopilotSelectionFrame` recognises it positionally (#1895).
      {
        frame: 'model-picker',
        status: 'waiting',
        reason: STATUS_REASON.COPILOT_SELECTION_LIST,
        evidence: 'positive',
      },
      {
        frame: 'permission-dialog',
        status: 'waiting',
        reason: STATUS_REASON.PROMPT_DETECTED,
        evidence: 'positive',
      },
      // The frame that forbids a windowed read of the busy vocabulary: copilot
      // printed ` ● Working esc interrupt` as BODY TEXT here, with the idle
      // status bar still on the bottom row. A window match would pin this
      // finished session to `running` forever.
      {
        frame: 'status-vocabulary-in-response',
        status: 'ready',
        reason: STATUS_REASON.INPUT_PROMPT,
        evidence: 'positive',
      },
      {
        frame: 'turn-complete',
        status: 'ready',
        reason: STATUS_REASON.INPUT_PROMPT,
        evidence: 'positive',
      },
      {
        frame: 'turn-running-early',
        status: 'running',
        reason: STATUS_REASON.THINKING_INDICATOR,
        evidence: 'positive',
      },
      {
        frame: 'turn-running-thinking',
        status: 'running',
        reason: STATUS_REASON.THINKING_INDICATOR,
        evidence: 'positive',
      },
    ],
  });

  it('answers unknown_frame — not default — when its own rules cannot read the pane', () => {
    // copilot opts out of the generic composer check, so branches 0 / 0.5 / 2.9
    // are the only rules that run for it. A frame they all decline is a frame
    // THEY could not read, which is a different statement from "no pattern
    // matched anywhere" and names an action: capture it as a fixture.
    const mutated = rewordBottomRow(
      readFileSync(`${FIXTURE_DIR}turn-running-thinking.txt`, 'utf8'),
      'interrupt',
      'dismissal',
    );

    const result = detectSessionStatus(mutated, 'copilot');
    expect(result.status).toBe('running');
    expect(result.reason).toBe(STATUS_REASON.UNKNOWN_FRAME);
    expect(result.evidence).toBe('none');
  });

  it('records the build it was measured against', () => {
    // Issue #2269 re-captured copilot at 1.0.82 and changed rules for it — the
    // composer's fence, the composer glyph, the transcript's dividers and the
    // tool rows' markers all moved. The frames are
    // `tests/unit/lib/detection/fixtures/copilot-live-2269/`; the 1.0.80 frames
    // this suite sweeps stay where they are, and the assertions above are the
    // proof that the rules still answer for both builds.
    expect(copilotStatusDetector.verifiedAgainst).toEqual({
      version: '1.0.82',
      capturedAt: '2026-09-04',
      paneGeometry: '200x1000',
    });
  });
});

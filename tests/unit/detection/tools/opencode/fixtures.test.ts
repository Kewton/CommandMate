/**
 * opencode's detection fixtures (Issue #1927, 方針書 §11 / §4 D2).
 *
 * As with copilot, the captures stay where the Issues that took them put them
 * (`opencode-live-1883/` and `opencode-live-1896/`). What #1927 adds is the
 * sweep §11 requires: the full verdict INCLUDING `evidence`, and the mutation
 * case.
 *
 * opencode is the only tool with a completion marker of its own — `▣ <Action> ·
 * <model> · <duration>`, with the duration made mandatory by #1893 — and since
 * #1883 it also has a gutter-anchored idle-composer rule. Both are §4 D1 決定 1
 * evidence, which is why it ships with `enforce`.
 *
 * ## Why the mutation frame comes from the 1896 directory
 *
 * `opencode-live-1883/turn-running.txt` looks like the obvious candidate and is
 * the wrong one: reword its busy row and the frame still publishes `ready`,
 * because a genuinely finished earlier step's `▣ … · 2.3s` marker is still in
 * the content window. That is not a D1 violation — the marker IS positive
 * evidence — but it means the frame cannot demonstrate the absence of any. The
 * frames below have no such marker above them, so removing the busy row leaves
 * the pane with nothing to say.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { opencodeStatusDetector } from '@/lib/detection/tools/opencode/detect';
import { rewordBottomRow, runToolFixtureSuite } from '../fixture-sweep';

const IDLE_DIR = fileURLToPath(
  new URL('../../../lib/detection/fixtures/opencode-live-1883/', import.meta.url),
);
const NUMBERED_DIR = fileURLToPath(
  new URL('../../../lib/detection/fixtures/opencode-live-1896/', import.meta.url),
);

describe('[#1927] opencode detection fixtures', () => {
  runToolFixtureSuite({
    tool: 'opencode',
    fixtureDir: IDLE_DIR,
    // 80x200 is the geometry `OPENCODE_PANE_HEIGHT` makes production capture.
    paneRows: 200,
    busyWord: 'interrupt',
    rewordedBusyWord: 'dismissal',
    idleFrames: ['boot-idle', 'turn-complete', 'phrase-in-response'],
    // See the header for why the mutation frame is not in this directory.
    mutationDir: NUMBERED_DIR,
    mutationFrames: ['numbered-answer-running'],
    expectations: [
      // The gutter-anchored idle composer (#1883): `Ask anything...` INSIDE the
      // input box, which opencode paints only while the buffer is empty.
      {
        frame: 'boot-idle',
        status: 'ready',
        reason: STATUS_REASON.INPUT_PROMPT,
        evidence: 'positive',
      },
      // Residual text in the composer, no marker, no busy row: nothing on the
      // pane says anything, which is exactly what `unknown_frame` reports.
      {
        frame: 'composer-residual',
        status: 'running',
        reason: STATUS_REASON.UNKNOWN_FRAME,
        evidence: 'none',
      },
      // The bare phrase inside a RESPONSE body. It is not a composer, and the
      // completion marker above it is what makes this frame `ready` (#1883).
      {
        frame: 'phrase-in-response',
        status: 'ready',
        reason: STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
        evidence: 'positive',
      },
      {
        frame: 'turn-complete',
        status: 'ready',
        reason: STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
        evidence: 'positive',
      },
      {
        frame: 'turn-running',
        status: 'running',
        reason: STATUS_REASON.OPENCODE_PROCESSING_INDICATOR,
        evidence: 'positive',
      },
    ],
  });

  describe('the busy row is load-bearing', () => {
    it('names unknown_frame, not default, once the busy row is reworded', () => {
      // The reason code the sweep's mutation case leaves behind, spelled out:
      // opencode opts out of the generic composer check, so branches A0-E are
      // the only rules that run and a frame they all decline is a frame THEY
      // could not read. The numbered list on this pane is a RESPONSE, not a
      // dialog (#1896), which is why nothing else picks it up.
      const raw = readFileSync(`${NUMBERED_DIR}numbered-answer-running.txt`, 'utf8');
      const after = detectSessionStatus(rewordBottomRow(raw, 'interrupt', 'dismissal'), 'opencode');

      expect(after.status).toBe('running');
      expect(after.reason).toBe(STATUS_REASON.UNKNOWN_FRAME);
      expect(after.evidence).toBe('none');
    });

    it('keeps a duration-less completion row from standing in for the missing busy row', () => {
      // #1893's rule, restated as evidence: `▣ <Action> · <model>` with no
      // duration is a step that is still OPEN, and matching it was the reported
      // false `ready`. The frame carries no other marker, so it has no evidence.
      const raw = readFileSync(
        fileURLToPath(
          new URL(
            '../../../lib/detection/fixtures/opencode-live-1893/turn-aborted-no-duration.txt',
            import.meta.url,
          ),
        ),
        'utf8',
      );
      const result = detectSessionStatus(raw, 'opencode');
      expect(result.status).toBe('running');
      expect(result.reason).toBe(STATUS_REASON.UNKNOWN_FRAME);
      expect(result.evidence).toBe('none');
    });
  });

  it('records the build it was measured against', () => {
    expect(opencodeStatusDetector.verifiedAgainst).toEqual({
      version: '1.18.21',
      capturedAt: '2026-08-21',
      paneGeometry: '80x200',
    });
  });
});

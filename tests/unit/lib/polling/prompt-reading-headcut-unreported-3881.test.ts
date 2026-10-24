/**
 * Issue #3881 (the second half, review item (5b)): `headCut` not reported
 * (`undefined`) is not `false`.
 *
 * `captureTopOf` read an alternate-screen capture off the screen — blank first
 * and last rows → `screen-start` — whenever the window was at least the pane
 * height and the capture layer had not said otherwise. At a window of exactly
 * TUI_PANE_HEIGHT (1000) rows that cannot be told: a whole 1000-row screen and
 * a taller pane cut to its last 1000 rows come back the same size, and the cut
 * one can show blank rows at both ends too. Now a capture that filled its
 * window is `clipped` unless the capture layer said `headCut === false`.
 *
 * Positive control (fails before): the full 1000-row screen at the 1000-row
 * window with `headCut` unreported is `clipped`, and a top-unknown target on
 * it withholds under a deny contract. Negative controls: `headCut === false`
 * keeps the screen reading; a capture that did not fill its window, and the
 * wider FULL window, read as before; a scrollback pane is unchanged.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { captureTopOf, withCaptureTopCompleteness } from '@/lib/polling/prompt-screen-reading';
import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';
import { FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES } from '@/config/auto-yes-config';
import { resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import type { PromptDetectionResult } from '@/lib/detection/types';

/** An alternate screen of `rows` rows: blank first row, content, blank to the bottom; tmux-terminated. */
function screen(rows: number): string {
  const content = ['', ' Bash command', '   ls', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
  return [...content, ...Array.from({ length: rows - content.length }, () => '')].join('\n') + '\n';
}

describe('[#3881 (5b)] premises', () => {
  it('the REDUCED window is the pane height, and FULL is wider', () => {
    expect(REDUCED_CAPTURE_LINES).toBe(TUI_PANE_HEIGHT);
    expect(FULL_CAPTURE_LINES).toBeGreaterThan(TUI_PANE_HEIGHT);
  });
});

describe('[#3881 (5b)] an unreported cut at a full 1000-row window is clipped (positive)', () => {
  it('blank edges do not stand in for the capture layer\'s word', () => {
    expect(captureTopOf(screen(TUI_PANE_HEIGHT), REDUCED_CAPTURE_LINES, 'claude')).toBe('clipped');
    expect(captureTopOf(screen(TUI_PANE_HEIGHT), REDUCED_CAPTURE_LINES, 'claude', undefined)).toBe('clipped');
  });

  it('and a top-unknown target read on it withholds under a deny contract', () => {
    const detection: PromptDetectionResult = {
      isPrompt: true,
      promptData: {
        type: 'multiple_choice',
        question: 'Do you want to proceed?',
        options: [
          { number: 1, label: 'Yes', isDefault: true },
          { number: 2, label: 'No', isDefault: false },
        ],
        status: 'pending',
        approvalTarget: 'Bash command\n  ls',
      },
      cleanContent: '',
      approvalContext: { startRow: 0, endRow: 4, completeness: 'top-unknown' },
    };
    const top = captureTopOf(screen(TUI_PANE_HEIGHT), REDUCED_CAPTURE_LINES, 'claude');
    const promptData = withCaptureTopCompleteness(detection, top).promptData!;
    expect(promptData.approvalTargetCompleteness).toBe('top-unknown');
    expect(
      resolveAutoAnswerWithPolicy(promptData, { mode: null, allowPromptTypes: [], denyPatterns: ['rm -rf'] }, 'claude'),
    ).toMatchObject({ answer: null, suppressedBy: 'deny-pattern-unusable' });
  });
});

describe('[#3881 (5b)] what does not change (negative)', () => {
  it('reported whole (`false`): read off the screen', () => {
    expect(captureTopOf(screen(TUI_PANE_HEIGHT), REDUCED_CAPTURE_LINES, 'claude', false)).toBe('screen-start');
  });

  it('reported cut (`true`): clipped', () => {
    expect(captureTopOf(screen(TUI_PANE_HEIGHT), REDUCED_CAPTURE_LINES, 'claude', true)).toBe('clipped');
  });

  it('a capture that did not fill its window, or the wider window: read off the screen', () => {
    expect(captureTopOf(screen(TUI_PANE_HEIGHT - 1), REDUCED_CAPTURE_LINES, 'claude')).toBe('screen-start');
    expect(captureTopOf(screen(TUI_PANE_HEIGHT), FULL_CAPTURE_LINES, 'claude')).toBe('screen-start');
  });

  it('a scrollback pane is read by its row count, as before', () => {
    expect(captureTopOf(screen(TUI_PANE_HEIGHT), REDUCED_CAPTURE_LINES, 'codex')).toBe('clipped');
    expect(captureTopOf(screen(TUI_PANE_HEIGHT), REDUCED_CAPTURE_LINES, 'codex', false)).toBe('history-start');
    expect(captureTopOf(screen(TUI_PANE_HEIGHT - 1), REDUCED_CAPTURE_LINES, 'codex')).toBe('history-start');
  });
});

/** @vitest-environment node */

/**
 * Issue #2468: Claude Code 2.1.267's session-diff HUD row made an open dialog
 * unanswerable.
 *
 * `askuserquestion-submit-files-edited-panel.txt` is a verbatim
 * `tmux capture-pane -p -e` of a live claude-cli 2.1.267 pane, stopped on the
 * AskUserQuestion confirmation screen — `Ready to submit your answers?` /
 * `❯ 1. Submit answers` / `2. Cancel`, the one Claude dialog that draws no
 * footer. Its bottom row is the HUD, right-aligned after ~110 columns of
 * padding: `+28 files edited before this session (show)`. The `.control-no-panel`
 * file is the same capture with the HUD rows blanked and nothing else touched.
 *
 * What was broken: `findClaudeTranscriptTail` did not know the row, so it was
 * the transcript tail; `detectClaudeDialog` then read it as the footer under the
 * options, it matched none of Claude's footers, and the dialog was refused.
 * Every path that re-verifies through `evaluateDialogPresence` — Auto-Yes, the
 * UI's answer via `/prompt-response`, `commandmate respond` — got
 * `prompt_no_longer_active` while the dialog stayed on screen.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { findClaudeTaskPanelLines } from '@/lib/detection/prompt-detect-multiple-choice';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { findClaudeTranscriptTail } from '@/lib/detection/tools/claude/detect';
import { detectClaudeDialog } from '@/lib/detection/tools/claude/prompt';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { evaluateAutoYesDialogGate, evaluateDialogPresence } from '@/lib/polling/auto-yes-dialog-gate';

const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/claude-live-2468/', import.meta.url));
const LIVE = 'askuserquestion-submit-files-edited-panel';
const CONTROL = 'askuserquestion-submit-files-edited-panel.control-no-panel';
const HUD = '+28 files edited before this session (show)';

function frame(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}.txt`, 'utf8');
}

/** The live capture with the bottom HUD row's text swapped; every other byte kept. */
function withHud(text: string): string {
  const raw = frame(LIVE);
  if (!raw.includes(HUD)) throw new Error('the live capture no longer carries the HUD row');
  return raw.replace(HUD, text);
}

/** Insert `text` as a new row directly under the first row matching `rowMatch`. */
function insertBelow(raw: string, rowMatch: RegExp, text: string): string {
  const rows = raw.split('\n');
  const index = rows.findIndex(row => rowMatch.test(stripAnsi(row)));
  if (index < 0) throw new Error(`no row matched ${rowMatch}`);
  rows.splice(index + 1, 0, text);
  return rows.join('\n');
}

/** The row Claude's transcript-tail walk lands on, trimmed. */
function tailRow(raw: string): string {
  const { contentLines } = normalizeFrame(raw);
  const tail = findClaudeTranscriptTail(contentLines);
  return tail < 0 ? '' : contentLines[tail].trim();
}

/** `detectClaudeDialog` as the claude detector calls it. */
function dialogOf(raw: string) {
  const normalized = normalizeFrame(raw);
  return detectClaudeDialog(normalized, {
    transcriptTail: findClaudeTranscriptTail(normalized.contentLines),
  });
}

/** `detectClaudeDialog` handed the tail the pre-#2468 walk produced: the HUD row itself. */
function dialogWithTailOnHud(raw: string) {
  const normalized = normalizeFrame(raw);
  const hudRow = normalized.contentLines.findIndex(row => row.trim() === HUD);
  if (hudRow < 0) throw new Error('no HUD row in the frame');
  return detectClaudeDialog(normalized, { transcriptTail: hudRow });
}

/** The option labels the generic parser reads, fed the way status-detector feeds it. */
function labels(raw: string): string[] {
  const { promptData } = detectPrompt(stripBoxDrawing(stripAnsi(raw)), buildDetectPromptOptions('claude'));
  return promptData?.type === 'multiple_choice' ? promptData.options.map(option => option.label) : [];
}

describe('Issue #2468: the capture', () => {
  it('carries the HUD right-aligned under a dialog that draws no footer', () => {
    const rows = stripAnsi(frame(LIVE)).split('\n');
    const hudRow = rows.find(row => row.includes(HUD));

    // Right-aligned: the left of the row is padding, which is why every reader
    // matches the TRIMMED row — a slice from the left sees only blanks.
    expect(hudRow).toBeDefined();
    expect(hudRow!.slice(0, 100).trim()).toBe('');
    expect(hudRow!.trim()).toBe(HUD);

    // The footer-less screen. Were Claude to draw a footer here, the footer
    // guard would pass for a reason that has nothing to do with #2468.
    expect(rows.some(row => row.trim() === 'Ready to submit your answers?')).toBe(true);
    expect(rows.join('\n')).not.toMatch(/esc\s+to\s+cancel|enter\s+to\s+(?:select|confirm)/i);
  });

  it('differs from the control in the two HUD rows and nothing else', () => {
    const live = frame(LIVE).split('\n');
    const control = frame(CONTROL).split('\n');
    expect(control).toHaveLength(live.length);

    const differing = live.flatMap((row, i) => (row === control[i] ? [] : [i]));
    expect(differing.map(i => stripAnsi(live[i]).trim())).toEqual(['No changes this session', HUD]);
    expect(differing.map(i => control[i])).toEqual(['', '']);
  });
});

describe('Issue #2468: the confirmation screen under the HUD is a dialog', () => {
  it('findClaudeTranscriptTail steps over the HUD to the last option', () => {
    expect(tailRow(frame(LIVE))).toBe('2. Cancel');
  });

  it('detectClaudeDialog vouches for it as an AskUserQuestion screen', () => {
    expect(dialogOf(frame(LIVE))).toEqual({
      kind: 'ask_user',
      options: ['Submit answers', 'Cancel'],
      answerMode: 'numbered',
    });
  });

  it('evaluateDialogPresence finds it on the capture, as /prompt-response reads it', () => {
    const presence = evaluateDialogPresence('claude', 'multiple_choice', frame(LIVE));
    expect(presence.gated).toBe(true);
    expect(presence.present).toBe(true);
  });

  it('Auto-Yes may answer it on the spelling Auto-Yes reads', () => {
    // `captureAndCleanOutput` hands the gate ANSI- and box-stripped text. The
    // explicit env keeps an operator's CM_AUTOYES_DIALOG_GATE out of the verdict.
    const verdict = evaluateAutoYesDialogGate(
      'claude',
      'multiple_choice',
      stripBoxDrawing(stripAnsi(frame(LIVE))),
      { NODE_ENV: 'test' },
    );
    expect(verdict.gated).toBe(true);
    expect(verdict.allowed).toBe(true);
  });

  it('reads exactly as the control does — the HUD was the only variable', () => {
    const control = frame(CONTROL);
    expect(tailRow(control)).toBe('2. Cancel');
    expect(dialogOf(control)).toEqual(dialogOf(frame(LIVE)));
    expect(evaluateDialogPresence('claude', 'multiple_choice', control).present).toBe(true);
  });
});

describe('Issue #2468: both HUD spellings, at any count', () => {
  it.each([
    'No changes this session',
    '+1 file edited before this session (show)',
    '+2 files edited before this session (show)',
    HUD,
  ])('%s', text => {
    const raw = withHud(text);
    expect(tailRow(raw)).toBe('2. Cancel');
    expect(evaluateDialogPresence('claude', 'multiple_choice', raw).present).toBe(true);
    // Pass 2 reads the same row set. Unskipped, `+1 …` / `+2 …` parse as option
    // 1 / 2 and the generic parser loses the real options above them — #1708's
    // poisoning — so `/prompt-response` would refuse before the gate was asked.
    expect(labels(raw)).toEqual(['Submit answers', 'Cancel']);
  });
});

describe('Issue #2468: the footer guard reads panels out of the footer', () => {
  it('treats a footer made only of the HUD as no footer', () => {
    // The tail the pre-#2468 walk produced. Independently of the walk, the guard
    // itself must not refuse an open dialog over a row of chrome.
    expect(dialogWithTailOnHud(frame(LIVE))).toMatchObject({ kind: 'ask_user' });
  });

  it('still refuses finished output under the options, HUD or no HUD', () => {
    // #2457's shape: a completion marker directly under a `❯`-bearing block.
    // Reading the HUD out of the footer must not read this out with it.
    const finished = insertBelow(frame(LIVE), /^\s*2\. Cancel\s*$/, '✻ Brewed for 3s');
    expect(dialogOf(finished)).toBeNull();
    expect(dialogWithTailOnHud(finished)).toBeNull();
    expect(evaluateDialogPresence('claude', 'multiple_choice', finished).present).toBe(false);
  });
});

describe('Issue #2468: findClaudeTaskPanelLines claims the HUD row and nothing like it', () => {
  it('claims the row in either spelling, however far it is padded', () => {
    const pad = ' '.repeat(111);
    const lines = ['❯ 1. Submit answers', '  2. Cancel', '', `${pad}${HUD}`, `${pad}No changes this session`, HUD];
    expect([...findClaudeTaskPanelLines(lines, 0, lines.length)]).toEqual([3, 4, 5]);
  });

  it('does not claim an option or a sentence that merely carries the words', () => {
    // An allowlist of rows seen on a pane, not of their vocabulary: anchored at
    // both ends, and the `(show)`-less form was never measured.
    const lines = [
      '  2. No changes this session',
      'No changes this session yet — want me to start?',
      'I saw +3 files edited before this session (show) in the log',
      '+3 files edited before this session',
    ];
    expect([...findClaudeTaskPanelLines(lines, 0, lines.length)]).toEqual([]);
  });
});

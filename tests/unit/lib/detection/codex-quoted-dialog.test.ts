/**
 * Issue #2841 — codex dialog chrome quoted in the conversation is not a dialog.
 *
 * codex hides the composer while a dialog is open, so a pane whose bottom is the
 * composer has no dialog, whatever the transcript above it quotes.
 * `isCodexComposerAtBottom` answers that once, and every dialog reading in
 * `tools/codex/detect.ts` takes it as a veto: branch 0.6 (ahead of the pager,
 * lifecycle, selection-list and structural branches), `isStalePrompt` (the
 * shared prompt step) and `detectDialog` (Auto-Yes and `respond`).
 *
 * What this file pins, on both spellings the detector is handed (as captured,
 * and `stripAnsi`'d as Auto-Yes sees it):
 *  - every quoted-chrome frame reads `ready` / `input_prompt` with no active
 *    prompt, and `detectDialog` returns null;
 *  - the measured live dialogs still read `waiting` and still vouch — the veto
 *    must never fire on a real dialog.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectSessionStatus } from '@/lib/detection/status-detector';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { isCodexComposerAtBottom } from '@/lib/detection/tools/codex/cli-patterns';
import {
  IDLE_AFTER_QUOTED_APPROVAL,
  IDLE_AFTER_QUOTED_APPROVAL_AT_TAIL,
  IDLE_AFTER_QUOTED_MODEL_PICKER,
  IDLE_AFTER_QUOTED_PAGER_FOOTER,
  IDLE_AFTER_QUOTED_HOOKS_FOOTER,
} from '../../../fixtures/codex-quoted-dialog/frames';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const QUOTED: ReadonlyArray<readonly [string, string]> = [
  ['quoted approval with prose below', IDLE_AFTER_QUOTED_APPROVAL],
  ['quoted approval at the tail', IDLE_AFTER_QUOTED_APPROVAL_AT_TAIL],
  ['quoted /model picker', IDLE_AFTER_QUOTED_MODEL_PICKER],
  ['quoted pager footer', IDLE_AFTER_QUOTED_PAGER_FOOTER],
  ['quoted hooks-review footer', IDLE_AFTER_QUOTED_HOOKS_FOOTER],
];

/** Live dialogs that must keep reading as dialogs (status, reason). */
const LIVE_DIALOGS: ReadonlyArray<readonly [string, string]> = [
  ['codex-dialogs-0155/dialog-approval-run-command.txt', 'prompt_detected'],
  ['codex-dialogs-0155/dialog-model-picker.txt', 'codex_selection_list'],
  ['codex-dialogs-0155/dialog-trust-directory.txt', 'prompt_detected'],
  ['codex-live-2310/dialog-permissions-picker.txt', 'codex_selection_list'],
  ['codex-browser-use-2609/approval-form-browser-use.txt', 'prompt_detected'],
  ['../unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt', 'prompt_detected'],
  ['../unit/lib/detection/fixtures/codex-live-1628/model-picker-step1.txt', 'codex_selection_list'],
];

const spellings = (raw: string): ReadonlyArray<readonly [string, string]> => [
  ['as captured', raw],
  ['stripAnsi', stripAnsi(raw)],
];

const codex = () => getToolStatusDetector('codex');

describe('Issue #2841: quoted dialog chrome above the composer', () => {
  describe.each(QUOTED)('%s', (_name, frame) => {
    it.each(spellings(frame))('%s: reads ready, no active prompt, no dialog', (_s, input) => {
      const result = detectSessionStatus(input, 'codex');
      expect(result.status).toBe('ready');
      expect(result.reason).toBe('input_prompt');
      expect(result.hasActivePrompt).toBe(false);
      expect(result.promptDetection.isPrompt).toBe(false);
      expect(codex().detectDialog(normalizeFrame(input))).toBeNull();
    });

    it('the composer is the bottom of the pane', () => {
      const f = normalizeFrame(frame);
      expect(isCodexComposerAtBottom(f.raw, f.contentLines, f.contentLines.length)).toBe(true);
    });
  });
});

describe('Issue #2841: live dialogs are not vetoed', () => {
  describe.each(LIVE_DIALOGS)('%s', (rel, reason) => {
    it.each(spellings(read(rel)))('%s: still waiting', (_s, input) => {
      const result = detectSessionStatus(input, 'codex');
      expect(result.status).toBe('waiting');
      expect(result.reason).toBe(reason);
    });

    it('the composer is not the bottom of the pane', () => {
      const f = normalizeFrame(read(rel));
      expect(isCodexComposerAtBottom(f.raw, f.contentLines, f.contentLines.length)).toBe(false);
    });
  });

  it('an approval dialog still vouches to detectDialog', () => {
    const raw = read('codex-dialogs-0155/dialog-approval-run-command.txt');
    for (const [, input] of spellings(raw)) {
      expect(codex().detectDialog(normalizeFrame(input))?.kind).toBe('permission');
    }
  });
});

describe('isCodexComposerAtBottom: the stripped reading', () => {
  it('a numbered `›` row at the bottom is not the composer', () => {
    const lines = ['Pick one', '› 1. Yes', '  2. No'];
    expect(isCodexComposerAtBottom(lines.join('\n'), lines, lines.length)).toBe(false);
  });

  it('a bare `›` row at the bottom is the composer', () => {
    const lines = ['• done', '', '› Ask Codex to do anything'];
    expect(isCodexComposerAtBottom(lines.join('\n'), lines, lines.length)).toBe(true);
  });

  it('a frame with no `›` row is not shown to be the composer', () => {
    const lines = ['• Working (3s • esc to interrupt)'];
    expect(isCodexComposerAtBottom(lines.join('\n'), lines, lines.length)).toBe(false);
  });
});

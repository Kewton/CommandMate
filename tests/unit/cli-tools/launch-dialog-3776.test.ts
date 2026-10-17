/**
 * Issue #3776: the shared reading of a startup confirmation — press only while
 * the cursor is on the declared safe row; leave it, and say why, otherwise.
 *
 * Frames: `tests/fixtures/gemini-live-3776/` (gemini v0.62.0 measured in a
 * private HOME, see its README) and agy's `antigravity-live-2364/trust-dialog.txt`.
 * Positive control: before #3776 the module did not exist, and the launch
 * answered every frame with the question on it — `Don't trust` included.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_TRUST_LAUNCH_DIALOG,
  GEMINI_TRUST_LAUNCH_DIALOG,
  decideLaunchDialog,
  isLaunchDialogOpen,
} from '@/lib/cli-tools/launch-dialog';

const GEMINI = resolve(__dirname, '../../fixtures/gemini-live-3776');
const AGY = resolve(__dirname, '../../fixtures/antigravity-live-2364');
const gemini = (name: string): string => readFileSync(resolve(GEMINI, `${name}.txt`), 'utf8');

const AGY_TRUST = readFileSync(resolve(AGY, 'trust-dialog.txt'), 'utf8');
/** The same screen with the cursor moved to `No, exit` (one ↓). */
const AGY_TRUST_ON_NO = AGY_TRUST
  .replace('> Yes, I trust this folder', '  Yes, I trust this folder')
  .replace('  \u001b[90mNo, exit', '\u001b[94m> No, exit');

describe('[#3776] gemini folder trust (measured v0.62.0 frames)', () => {
  it('positive: the cursor on `1. Trust folder` is pressed with Enter', () => {
    expect(decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, gemini('trust-dialog'))).toEqual({
      action: 'press',
      key: 'Enter',
    });
  });

  it('negative: the cursor on `3. Don\'t trust` is held, not pressed', () => {
    expect(decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, gemini('trust-dialog-cursor-dont-trust'))).toEqual({
      action: 'hold',
      reason: 'cursor-off-safe-row',
      cursorLabel: "3. Don't trust",
    });
  });

  it('negative: the cursor on `2. Trust parent folder` is held (it trusts every sibling)', () => {
    const onParent = gemini('trust-dialog')
      .replace('● 1. Trust folder', '  1. Trust folder')
      .replace('  2. Trust parent folder', '● 2. Trust parent folder');
    expect(decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, onParent)).toMatchObject({
      action: 'hold',
      cursorLabel: '2. Trust parent folder (T)',
    });
  });

  it('the screens after the Enter are not the dialog: the stale rows above the auth picker are history', () => {
    expect(decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, gemini('after-enter-auth'))).toEqual({ action: 'absent' });
    expect(isLaunchDialogOpen(GEMINI_TRUST_LAUNCH_DIALOG, gemini('after-enter-auth'))).toBe(false);
    expect(isLaunchDialogOpen(GEMINI_TRUST_LAUNCH_DIALOG, gemini('after-enter-restarting'))).toBe(false);
  });

  it('a changed wording is unrecognized, not pressed', () => {
    const reworded = gemini('trust-dialog').replace('Do you trust the files in this folder?', 'Trust this workspace?');
    expect(decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, reworded)).toEqual({
      action: 'unrecognized',
      reason: 'question-not-found',
    });
  });

  it('a question with no cursor row, or two, is unrecognized', () => {
    const noCursor = gemini('trust-dialog').replace('● 1. Trust folder', '  1. Trust folder');
    expect(decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, noCursor)).toEqual({
      action: 'unrecognized',
      reason: 'cursor-not-found',
    });
    const twoCursors = gemini('trust-dialog').replace('  3. Don\'t trust', '● 3. Don\'t trust');
    expect(decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, twoCursors)).toEqual({
      action: 'unrecognized',
      reason: 'multiple-cursors',
    });
  });

  it('negative control: the authentication picker and a ready prompt are absent', () => {
    expect(decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, '> Type your message or @path/to/file')).toEqual({
      action: 'absent',
    });
  });
});

describe('[#3776] agy folder trust', () => {
  it('positive: `> Yes, I trust this folder` is pressed', () => {
    expect(decideLaunchDialog(ANTIGRAVITY_TRUST_LAUNCH_DIALOG, AGY_TRUST)).toEqual({ action: 'press', key: 'Enter' });
    expect(isLaunchDialogOpen(ANTIGRAVITY_TRUST_LAUNCH_DIALOG, AGY_TRUST)).toBe(true);
  });

  it('negative: `> No, exit` is held', () => {
    expect(AGY_TRUST_ON_NO).toContain('> No, exit');
    expect(decideLaunchDialog(ANTIGRAVITY_TRUST_LAUNCH_DIALOG, AGY_TRUST_ON_NO)).toEqual({
      action: 'hold',
      reason: 'cursor-off-safe-row',
      cursorLabel: 'No, exit',
    });
  });

  it('a changed question over the same rows is unrecognized', () => {
    const reworded = AGY_TRUST.replace('Do you trust the contents of this project?', 'Trust this workspace?');
    expect(decideLaunchDialog(ANTIGRAVITY_TRUST_LAUNCH_DIALOG, reworded)).toEqual({
      action: 'unrecognized',
      reason: 'question-not-found',
    });
  });
});

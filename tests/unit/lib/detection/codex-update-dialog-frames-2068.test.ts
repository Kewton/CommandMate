/**
 * Issue #2068 — codex's update dialog, over the REAL panes it draws.
 *
 * Three frames captured live from codex-cli 0.149.1 on a private tmux socket at
 * the production 200x1000 geometry, with `HOME` / `CODEX_HOME` /
 * `NPM_CONFIG_PREFIX` all isolated (see the fixture README). They pin the three
 * things the policy is built on:
 *
 *  1. **the dialog is classified, and by the classifiers that already existed.**
 *     `getCodexActiveDialog` and `getCodexLifecycleDialog` both name it
 *     `update`. Nothing new recognises this screen — the Issue is about which
 *     key is sent, not about finding the dialog.
 *  2. **the human can answer it.** `detectPrompt` reports a three-option
 *     `multiple_choice`, which is what makes the `ask` policy work: the pane is
 *     left alone and PromptPanel offers all three choices.
 *  3. **the pane codex leaves behind after `1` reads as ALIVE to the shared
 *     rule of Issue #2070**, and that is not a bug in either place — it is why
 *     `waitForReady` asks `findShellPromptTail` instead. Asserted from both
 *     sides so a future widening of `judgeToolLiveness` fails here loudly
 *     rather than changing behaviour quietly.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  getCodexActiveDialog,
  getCodexLifecycleDialog,
  isCodexPromptReady,
  buildDetectPromptOptions,
} from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { judgeToolLiveness, findShellPromptTail } from '@/lib/detection/tool-liveness';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import { CODEX_UPDATE_DIALOG_KEYS } from '@/config/codex-update-dialog-config';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/codex-update-dialog-2068');
const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, `${name}-01491.txt`), 'utf-8');

const UPDATE_DIALOG = frame('update-dialog');
const UPDATING = frame('updating');
const UPDATED_SHELL = frame('updated-shell');

describe('[#2068] the live update dialog is classified by the existing classifiers', () => {
  it('is the bottom-most ACTIVE dialog', () => {
    expect(getCodexActiveDialog(UPDATE_DIALOG)).toBe('update');
  });

  it('is a launch screen the Auto-Yes poller must keep its hands off (#1829)', () => {
    // The guard in `auto-yes-poller` is `getCodexLifecycleDialog(...) !== null`.
    // This assertion is the regression the Issue explicitly forbids breaking:
    // whatever policy `waitForReady` acts on, Auto-Yes may not send "1".
    expect(getCodexLifecycleDialog(UPDATE_DIALOG)).toBe('update');
  });

  it('resolves to "1" by the base rules — which is exactly why the guard exists', () => {
    const detection = detectPrompt(UPDATE_DIALOG, buildDetectPromptOptions('codex'));
    expect(detection.isPrompt).toBe(true);
    expect(resolveAutoAnswerWithPolicy(detection.promptData!).answer).toBe(
      CODEX_UPDATE_DIALOG_KEYS.update
    );
  });

  it('is not a ready prompt: the option row must never be typed into', () => {
    expect(isCodexPromptReady(UPDATE_DIALOG)).toBe(false);
  });
});

describe('[#2068] the `ask` policy has something to show the human', () => {
  it('surfaces as an active prompt, not a navigable selection list', () => {
    const status = detectSessionStatus(UPDATE_DIALOG, 'codex');
    expect(status.status).toBe('waiting');
    expect(status.hasActivePrompt).toBe(true);
  });

  it('carries all three of codex’s own options, in codex’s own order', () => {
    const detection = detectPrompt(UPDATE_DIALOG, buildDetectPromptOptions('codex'));
    expect(detection.promptData?.type).toBe('multiple_choice');
    const options =
      detection.promptData?.type === 'multiple_choice' ? detection.promptData.options : [];
    expect(options.map((o) => o.number)).toEqual([1, 2, 3]);
    expect(options[0].label).toContain('Update now');
    expect(options[1].label).toBe('Skip');
    expect(options[2].label).toBe('Skip until next version');
    // codex pre-selects "Update now", so the default is the destructive one.
    // That is the whole reason `ask` exists rather than "let Auto-Yes have it".
    expect(options[0].isDefault).toBe(true);
  });
});

describe('[#2068] the pane `1. Update now` leaves behind', () => {
  const spec = resolveLivenessSpec('codex');

  it('is still running the install one second in — nothing may relaunch yet', () => {
    // `Updating Codex via …` and a braille spinner. The last row is the spinner,
    // which is neither a shell prompt nor long enough to be vetoed by the
    // length gate — it simply is not a prompt.
    expect(findShellPromptTail(UPDATING, spec)).toBeNull();
    expect(judgeToolLiveness(UPDATING, spec)).toEqual({ alive: true });
  });

  it('ends at a live shell prompt once the install returns', () => {
    const tail = findShellPromptTail(UPDATED_SHELL, spec);
    expect(tail).not.toBeNull();
    expect(tail?.line).toMatch(/%$/);
    expect(tail?.via).toBe('pattern');
  });

  it('is nevertheless ALIVE to the shared #2070 rule, and that is the measurement', () => {
    // `npm install` prints three rows, so the dead `› 1. Update now` option row
    // is seven content rows above the prompt — inside LIVENESS_ALIVE_TAIL_LINES,
    // where CODEX_PROMPT_PATTERN matches it. This is why `waitForReady` does not
    // ask `isToolLive` after answering the update dialog.
    expect(judgeToolLiveness(UPDATED_SHELL, spec)).toEqual({ alive: true });
  });

  it('keeps the dead option row inside the alive window, which is the reason why', () => {
    const rows = UPDATED_SHELL.split('\n').filter((l) => l.trim() !== '');
    // The BOTTOM-most one: this capture holds two launches' worth of scrollback,
    // and it is the last option row — the one the operator just answered — that
    // sits inside the window.
    const optionRow = rows.map((l) => /^›\s*1\.\s*Update now/.test(l)).lastIndexOf(true);
    expect(optionRow).toBeGreaterThanOrEqual(0);
    // Distance from the bottom, counted in content rows.
    expect(rows.length - 1 - optionRow).toBeLessThan(12);
  });
});

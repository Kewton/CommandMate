/**
 * codex-cli 0.148.0's three hooks screens, as the detection layer sees them
 * (Issue #1829).
 *
 * Two things are pinned here:
 *
 *  - **the classifier is position-based.** `getCodexLifecycleDialog` decides
 *    from the region BELOW the bottom-most genuine prompt line, so a dialog
 *    left in scrollback above a live prompt is not a dialog any more (Issue
 *    #892). The auto-answer guard is built on this, and a whole-frame version
 *    of it would switch Auto-Yes off for codex permanently once any launch
 *    dialog had scrolled past.
 *  - **the stuck screens stop reporting `running`.** Screens 2 and 3 were
 *    measured as `running` / `hasActivePrompt: false`, so a session parked on
 *    them looked busy to the UI and to `cmate wait` — the reason the two live
 *    sessions in the Issue sat there unnoticed.
 *
 * Deliberately NOT changed, and asserted so: `detectPrompt` still reports the
 * launch dialog as a prompt. Suppressing it here would take the screen away
 * from the human too, which is the one thing Issue #1829 rules out.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  getCodexLifecycleDialog,
  getCodexActiveDialog,
  isCodexPromptReady,
  buildDetectPromptOptions,
} from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import {
  detectSessionStatus,
  STATUS_REASON,
  SELECTION_LIST_REASONS,
} from '@/lib/detection/status-detector';
import { resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import {
  CODEX_APPROVAL_PANE,
  CODEX_HOOKS_DETAIL_PANE,
  CODEX_HOOKS_LIST_PANE,
  CODEX_HOOKS_RESIDUAL_PLUS_PROMPT,
  CODEX_HOOKS_REVIEW_PANE,
  CODEX_HOOKS_STUCK_PANE,
  CODEX_READY_PANE,
  CODEX_TRUST_DIALOG_PANE,
  CODEX_UPDATE_DIALOG_PANE,
} from '../../../fixtures/codex-hooks-review-0148';

describe('getCodexLifecycleDialog classifies every codex launch screen', () => {
  it('names each of the three 0.148.0 hooks screens', () => {
    expect(getCodexLifecycleDialog(CODEX_HOOKS_REVIEW_PANE)).toBe('hooks-review');
    expect(getCodexLifecycleDialog(CODEX_HOOKS_LIST_PANE)).toBe('hooks-list');
    expect(getCodexLifecycleDialog(CODEX_HOOKS_DETAIL_PANE)).toBe('hooks-detail');
  });

  it('names the update and trust dialogs the same way', () => {
    expect(getCodexLifecycleDialog(CODEX_UPDATE_DIALOG_PANE)).toBe('update');
    expect(getCodexLifecycleDialog(CODEX_TRUST_DIALOG_PANE)).toBe('trust');
  });

  it('answers with the BOTTOM-most screen when scrollback holds several', () => {
    // The stuck pane holds screen 2 above screen 3. A top-down scan says
    // `hooks-list`, and the recovery key differs per screen.
    expect(getCodexLifecycleDialog(CODEX_HOOKS_STUCK_PANE)).toBe('hooks-detail');
  });

  it('is silent on a ready prompt, an approval request, and dismissed scrollback', () => {
    expect(getCodexLifecycleDialog(CODEX_READY_PANE)).toBeNull();
    // The control that matters most: an approval request is what Auto-Yes is
    // for. Classifying it as a launch dialog would silently disable Auto-Yes.
    expect(getCodexLifecycleDialog(CODEX_APPROVAL_PANE)).toBeNull();
    // Issue #892: already dealt with, sitting above a live prompt.
    expect(getCodexLifecycleDialog(CODEX_HOOKS_RESIDUAL_PLUS_PROMPT)).toBeNull();
    expect(isCodexPromptReady(CODEX_HOOKS_RESIDUAL_PLUS_PROMPT)).toBe(true);
  });

  it('does not disturb getCodexActiveDialog’s own verdicts', () => {
    // #890/#892's classifier is unchanged: it still knows nothing about the
    // hooks screens, which is why they needed their own classifier at all.
    expect(getCodexActiveDialog(CODEX_HOOKS_REVIEW_PANE)).toBeNull();
    expect(getCodexActiveDialog(CODEX_HOOKS_DETAIL_PANE)).toBeNull();
    expect(getCodexActiveDialog(CODEX_UPDATE_DIALOG_PANE)).toBe('update');
    expect(getCodexActiveDialog(CODEX_TRUST_DIALOG_PANE)).toBe('trust');
  });
});

describe('the detection layer still shows the human what is on screen', () => {
  it('keeps reporting the hooks review dialog as a prompt with option 1 defaulted', () => {
    // This is the measurement Issue #1829 was filed on, and it must stay true:
    // the fix belongs in the auto-answer layer. If detectPrompt stopped seeing
    // this screen, no PromptPanel and no prompt notification would either.
    const detection = detectPrompt(CODEX_HOOKS_REVIEW_PANE, buildDetectPromptOptions('codex'));
    expect(detection.isPrompt).toBe(true);
    expect(detection.promptData?.type).toBe('multiple_choice');
    const options = detection.promptData?.type === 'multiple_choice' ? detection.promptData.options : [];
    expect(options[0]).toMatchObject({ number: 1, label: 'Review hooks', isDefault: true });
    // …and the base rules still resolve it to "1". Nothing about the resolver
    // changed; what changed is that the poller no longer asks it about a
    // launch dialog.
    expect(resolveAutoAnswerWithPolicy(detection.promptData!).answer).toBe('1');
  });

  it('resolves the update dialog to "1" (Update now) by the base rules', () => {
    // The #890 hazard, stated as a measurement: "1" runs npm install and kills
    // the codex process. waitForReady sends "2".
    const detection = detectPrompt(CODEX_UPDATE_DIALOG_PANE, buildDetectPromptOptions('codex'));
    expect(detection.isPrompt).toBe(true);
    expect(resolveAutoAnswerWithPolicy(detection.promptData!).answer).toBe('1');
  });
});

describe('a session parked on the hooks screens is no longer reported as running', () => {
  it('reports the hooks list as waiting', () => {
    const result = detectSessionStatus(CODEX_HOOKS_LIST_PANE, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_HOOKS_REVIEW);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('reports the hooks review detail as waiting', () => {
    const result = detectSessionStatus(CODEX_HOOKS_DETAIL_PANE, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_HOOKS_REVIEW);
  });

  it('reports the real stuck capture as waiting, prompt-line-in-scrollback and all', () => {
    const result = detectSessionStatus(CODEX_HOOKS_STUCK_PANE, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_HOOKS_REVIEW);
  });

  it('renders NavigationButtons, because `t` and `esc` are the only ways out', () => {
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.CODEX_HOOKS_REVIEW)).toBe(true);
  });

  it('leaves a ready prompt and a genuine approval alone', () => {
    expect(detectSessionStatus(CODEX_READY_PANE, 'codex').reason).not.toBe(
      STATUS_REASON.CODEX_HOOKS_REVIEW
    );
    const approval = detectSessionStatus(CODEX_APPROVAL_PANE, 'codex');
    expect(approval.reason).not.toBe(STATUS_REASON.CODEX_HOOKS_REVIEW);
    expect(approval.hasActivePrompt).toBe(true);
  });

  it('does not fire for another CLI tool that happens to print the same words', () => {
    const result = detectSessionStatus(CODEX_HOOKS_DETAIL_PANE, 'claude');
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_HOOKS_REVIEW);
  });
});

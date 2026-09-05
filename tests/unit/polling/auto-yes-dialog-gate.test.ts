/**
 * The Auto-Yes dialog gate (Issue #1928, 方針書 §4 D1 決定 4).
 *
 * The gate's whole job is to answer one question — "may Auto-Yes send a
 * keystroke for the numbered list `detectPrompt` found on this frame?" — and its
 * value is entirely in the NO answers, so that is what most of this file is.
 *
 * The two properties that matter:
 *
 *  1. **It takes nothing away.** Every open dialog in the repository's live
 *    capture corpus is still allowed. A gate that also swallowed those would
 *    "fix" #1896 by switching Auto-Yes off, which is the bigger regression.
 *  2. **It stops #1896.** The reported frames — opencode's own answer, a
 *    numbered list of deployment options with "Which one do you want?" under it
 *    — are refused, and refused through the gate rather than through the tool's
 *    prompt options, which is what makes the protection survive a re-enabling of
 *    the numbered path.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import {
  buildDetectPromptOptions,
  stripAnsi,
  stripBoxDrawing,
} from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { TOOL_STATUS_DETECTORS } from '@/lib/detection/tools/registry';
import {
  AUTO_YES_DIALOG_GATE_DEFAULT_MODE,
  AUTO_YES_DIALOG_GATE_ENV_VAR,
  evaluateAutoYesDialogGate,
  resolveAutoYesDialogGateMode,
} from '@/lib/polling/auto-yes-dialog-gate';
import type { CLIToolType } from '@/lib/cli-tools/types';

const FIXTURES = path.resolve(__dirname, '../lib/detection/fixtures');

const TOOL_BY_PREFIX: Readonly<Record<string, CLIToolType>> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  opencode: 'opencode',
};

function frame(dir: string, name: string): string {
  return readFileSync(path.join(FIXTURES, dir, `${name}.txt`), 'utf8');
}

/** What `captureAndCleanOutput` hands `detectAndRespondToPrompt`. */
function asAutoYesSees(raw: string): string {
  return stripBoxDrawing(stripAnsi(raw));
}

const originalEnv = process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];

beforeEach(() => {
  delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
  else process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = originalEnv;
});

describe('[#1928] the rollout table', () => {
  it('gates only the four tools with measured dialog rules', () => {
    // Pinned by equality rather than by spot checks: adding a tool here without
    // a rule would silence its Auto-Yes entirely, so the change has to be a
    // visible diff to this line.
    expect(AUTO_YES_DIALOG_GATE_DEFAULT_MODE).toEqual({
      claude: 'enforce',
      codex: 'enforce',
      copilot: 'enforce',
      opencode: 'enforce',
      gemini: 'legacy',
      antigravity: 'legacy',
      'vibe-local': 'legacy',
      // Issue #2250 / Epic #2249 決定 3: Command Code's `PreToolUse` fires AFTER
      // its permission dialog is answered, so a hook-driven `permissionDecision`
      // cannot dismiss the dialog and there is no measured rule to gate on.
      'command-code': 'legacy',
    });
  });

  it('names every CLI tool, so a new one cannot default to gated by omission', () => {
    expect(Object.keys(AUTO_YES_DIALOG_GATE_DEFAULT_MODE).sort()).toEqual([...CLI_TOOL_IDS].sort());
  });

  it('never enforces for a tool that declared no rules', () => {
    // The cross-check the module docstring promises. An `enforce` row for a tool
    // whose detector answers `null` unconditionally would refuse every prompt it
    // ever sees.
    for (const detector of TOOL_STATUS_DETECTORS) {
      if (AUTO_YES_DIALOG_GATE_DEFAULT_MODE[detector.tool] === 'enforce') {
        expect(detector.hasDialogRules, detector.tool).toBe(true);
      }
    }
  });

  it('leaves an ungated tool answering yes without being judged', () => {
    const verdict = evaluateAutoYesDialogGate(
      'gemini',
      'multiple_choice',
      '? Do this\n❯ 1. Yes\n  2. No',
    );

    expect(verdict.allowed).toBe(true);
    // `gated: false` is the distinction that keeps "nobody looked" out of the
    // suppression record — an ungated tool must never produce an
    // `unclassified-frame` reason.
    expect(verdict.gated).toBe(false);
    expect(verdict.dialog).toBeNull();
  });
});

describe('[#1928] the kill switch', () => {
  const numberedTranscript = '  1. First\n  2. Second\n  3. Third\n  Which one do you want?';

  it('is off by default: a gated tool refuses a frame its rules cannot read', () => {
    expect(evaluateAutoYesDialogGate('codex', 'multiple_choice', numberedTranscript)).toMatchObject({
      allowed: false,
      gated: true,
      mode: 'enforce',
    });
  });

  it('puts one tool back to the pre-#1928 behaviour', () => {
    process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = 'codex=legacy';

    expect(evaluateAutoYesDialogGate('codex', 'multiple_choice', numberedTranscript)).toMatchObject({
      allowed: true,
      gated: false,
      mode: 'legacy',
    });
    // …and only that tool.
    expect(
      evaluateAutoYesDialogGate('claude', 'multiple_choice', numberedTranscript).allowed,
    ).toBe(false);
  });

  it('is read on every call, so flipping it does not need a restart', () => {
    expect(evaluateAutoYesDialogGate('codex', 'multiple_choice', numberedTranscript).allowed).toBe(
      false,
    );
    process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = '*=legacy';
    expect(evaluateAutoYesDialogGate('codex', 'multiple_choice', numberedTranscript).allowed).toBe(
      true,
    );
    delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
    expect(evaluateAutoYesDialogGate('codex', 'multiple_choice', numberedTranscript).allowed).toBe(
      false,
    );
  });

  it('takes a wildcard, and a tool entry beats it in either order', () => {
    const envWith = (value: string): NodeJS.ProcessEnv =>
      ({ [AUTO_YES_DIALOG_GATE_ENV_VAR]: value }) as unknown as NodeJS.ProcessEnv;

    for (const spelling of ['*=legacy,codex=enforce', 'codex=enforce,*=legacy']) {
      expect(resolveAutoYesDialogGateMode('codex', envWith(spelling))).toBe('enforce');
      expect(resolveAutoYesDialogGateMode('claude', envWith(spelling))).toBe('legacy');
    }
  });

  it('ignores a typo rather than throwing on the polling path', () => {
    for (const junk of ['codex=enfroce', 'codex', '=,=,=', '   ']) {
      expect(
        resolveAutoYesDialogGateMode('codex', {
          [AUTO_YES_DIALOG_GATE_ENV_VAR]: junk,
        } as unknown as NodeJS.ProcessEnv),
      ).toBe('enforce');
    }
  });
});

describe('[#1928] only the numbered-list inference is gated', () => {
  it('leaves a yes/no prompt alone', () => {
    // §4 D1 決定 4 names the numbered-list inference, and #1896 is an instance of
    // it. No tool in the registry has a measured yes/no dialog rule, so gating
    // that family would make every `(y/n)` prompt a suppression — an unattended
    // pipeline going quiet, which is the failure the rollout guidance forbids.
    const verdict = evaluateAutoYesDialogGate(
      'claude',
      'yes_no',
      'Do you want to proceed? (y/n)',
    );

    expect(verdict.allowed).toBe(true);
    expect(verdict.gated).toBe(false);
  });
});

describe('[#1928] the gate takes nothing away from the live corpus', () => {
  /** Every live capture the shipping estimator reports as a numbered prompt. */
  const answerable = readdirSync(FIXTURES)
    .sort()
    .flatMap(dir => {
      const tool = TOOL_BY_PREFIX[dir.split('-')[0]];
      if (!tool) return [];
      return readdirSync(path.join(FIXTURES, dir))
        .filter(file => file.endsWith('.txt'))
        .sort()
        .flatMap(file => {
          const clean = asAutoYesSees(readFileSync(path.join(FIXTURES, dir, file), 'utf8'));
          const detection = detectPrompt(clean, buildDetectPromptOptions(tool));
          if (!detection.isPrompt || detection.promptData?.type !== 'multiple_choice') return [];
          return [{ id: `${dir}/${file}`, tool, clean }];
        });
    });

  it('finds the dialogs it is supposed to protect', () => {
    // The corpus is the control. If this list ever empties, every assertion
    // below becomes vacuous.
    expect(answerable.map(f => f.id)).toEqual([
      'claude-live-1708/askuserquestion-submit-taskpanel.txt',
      'claude-live-1708/bash-approval-taskpanel.txt',
      'codex-live-1628/approval-apply-patch.txt',
      'codex-live-1628/approval-run-command.txt',
      'codex-live-1628/model-picker-step1.txt',
      'codex-live-1628/model-picker-step2.txt',
      'codex-live-1890/dialog-model-picker.txt',
      'copilot-live-1885/permission-dialog.txt',
      'copilot-picker-1895/picker-permissions.txt',
    ]);
  });

  it.each(answerable.map(f => [f.id, f] as const))(
    '%s is still answered',
    (_id, { tool, clean }) => {
      expect(evaluateAutoYesDialogGate(tool, 'multiple_choice', clean).allowed).toBe(true);
    },
  );
});

describe('[#1928] Issue #1896: an agent quoting a numbered list is never answered', () => {
  /**
   * The estimator with #1896's declaration taken back off.
   *
   * `buildDetectPromptOptions('opencode')` sets `hasNumberedDialogs: false`, so
   * on the shipping build these frames never reach the gate at all. That is the
   * FIRST line of defence and it is already pinned in
   * `tests/unit/detection-opencode-numbered-list-1896.test.ts`. What this file
   * pins is the second: with the declaration removed — a build of opencode that
   * grows a numbered dialog, or a copy of the same mistake in another tool — the
   * gate still refuses, because opencode's own rules never vouched for the
   * frame.
   */
  function preIssue1896Estimator(raw: string) {
    return detectPrompt(asAutoYesSees(raw), { requireDefaultIndicator: false });
  }

  it.each(['numbered-answer', 'numbered-answer-running'])(
    '%s: the estimator says multiple_choice and the gate still says no',
    name => {
      const raw = frame('opencode-live-1896', name);
      const detection = preIssue1896Estimator(raw);

      // Non-vacuity: the frame really does satisfy the generic inference.
      expect(detection.isPrompt).toBe(true);
      expect(detection.promptData?.type).toBe('multiple_choice');

      const verdict = evaluateAutoYesDialogGate('opencode', 'multiple_choice', asAutoYesSees(raw));
      expect(verdict.allowed).toBe(false);
      expect(verdict.gated).toBe(true);
      expect(verdict.dialog).toBeNull();
    },
  );

  it('still answers the permission dialog drawn OVER a numbered answer', () => {
    // `permission-over-numbered.txt` is the frame that proves the refusal above
    // is about the dialog and not about the numbers: the same numbered reply is
    // on the pane with opencode's permission strip open below it.
    //
    // opencode's strip is `keys`-driven — a typed `1` is swallowed and the Enter
    // after it confirms whatever is highlighted, so asking to Reject would
    // Approve (#1893) — so "answered" here means the human answers it, through
    // NavigationButtons, and Auto-Yes still sends nothing. What must NOT happen
    // is the pane being read as a numbered choice.
    const raw = frame('opencode-live-1896', 'permission-over-numbered');
    const verdict = evaluateAutoYesDialogGate('opencode', 'multiple_choice', asAutoYesSees(raw));

    expect(verdict.allowed).toBe(false);
  });

  it('refuses the same shape for a tool whose numbered path is still open', () => {
    // The #1896 shape as claude would render it: three numbered rows the agent
    // WROTE, with the question under them and no selection cursor on any of
    // them. `detectPrompt` reports `multiple_choice` for it — that is the whole
    // problem — and the gate is what refuses.
    //
    // No composer row: `detectPrompt`'s own user-input barrier
    // (`prompt-detect-multiple-choice.ts`) already rejects options that sit
    // above a `❯` line, so including one would make the estimator answer
    // `isPrompt: false` and the assertion below would prove nothing about the
    // gate. The frame this describes is the one MID-stream, before the composer
    // is repainted.
    const agentWroteAList = [
      '⏺ Here are the options:',
      '',
      '  1. On-premises (self-hosted) deployment',
      '  2. Cloud-managed platform',
      '  3. Containerized deployment with Kubernetes',
      '',
      '  Which one do you want?',
    ].join('\n');

    expect(detectPrompt(agentWroteAList, buildDetectPromptOptions('claude')).promptData?.type).toBe(
      'multiple_choice',
    );
    expect(
      evaluateAutoYesDialogGate('claude', 'multiple_choice', agentWroteAList).allowed,
    ).toBe(false);
  });
});

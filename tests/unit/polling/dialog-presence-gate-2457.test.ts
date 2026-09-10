/**
 * `evaluateDialogPresence` — the shared "is there a dialog on this frame?" gate
 * (Issue #2457).
 *
 * Issue #1928 put the tools' own dialog rules in front of Auto-Yes and left the
 * history-save path and `/prompt-response` reading the generic numbered-list
 * inference on their own. #2457 is the bill: a Claude reply written as
 * `1. / 2. / 3.` under a question was stored as a `prompt` row.
 *
 * The two gates deliberately answer DIFFERENT questions off the same rules, and
 * most of this file is about keeping that difference straight:
 *
 * | | `evaluateAutoYesDialogGate().allowed` | `evaluateDialogPresence().present` |
 * |---|---|---|
 * | question | may Auto-Yes type at this? | is a dialog on this screen? |
 * | positive | `dialog !== null` **and** `answerMode === 'numbered'` | `dialog !== null` |
 * | env override | `CM_AUTOYES_DIALOG_GATE` | none |
 * | frame | `stripBoxDrawing(stripAnsi(capture))` | the capture |
 *
 * @vitest-environment node
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { stripAnsi, stripBoxDrawing, buildDetectPromptOptions } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import {
  AUTO_YES_DIALOG_GATE_DEFAULT_MODE,
  AUTO_YES_DIALOG_GATE_ENV_VAR,
  evaluateAutoYesDialogGate,
  evaluateDialogPresence,
} from '@/lib/polling/auto-yes-dialog-gate';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';

const FIXTURES = path.resolve(__dirname, '../lib/detection/fixtures');
const REPLIES = path.resolve(__dirname, '../../fixtures/claude-idle-numbered-list-2457');

function frame(dir: string, name: string): string {
  return readFileSync(path.join(FIXTURES, dir, `${name}.txt`), 'utf8');
}

function reply(name: string): string {
  return readFileSync(path.join(REPLIES, `${name}.txt`), 'utf8');
}

const originalEnv = process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];

beforeEach(() => {
  delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
  else process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = originalEnv;
});

// ---------------------------------------------------------------------------
// The rollout table
// ---------------------------------------------------------------------------

describe('[#2457] the presence gate judges exactly the tools the table says', () => {
  /**
   * A pane that satisfies the generic numbered-list inference and carries no
   * dialog: the #1896 shape, with no composer row (the parser's own user-input
   * barrier would refuse options sitting above one, and the estimator has to
   * SAY multiple_choice for a gate test to mean anything).
   */
  const AGENT_WROTE_A_LIST = [
    'Which provider should I publish through?',
    '  1. tailscale',
    '  2. cloudflare',
    '  3. neither, keep it local',
  ].join('\n');

  const ENFORCED: CLIToolType[] = ['claude', 'codex', 'copilot', 'opencode'];
  const LEGACY: CLIToolType[] = ['gemini', 'antigravity', 'vibe-local', 'command-code'];

  it('covers every CLI tool exactly once', () => {
    // A tool added to `CLI_TOOL_IDS` without a row here would silently inherit
    // whichever branch the record's fallback lands on, which is the failure the
    // #1928 table was written to make impossible.
    expect([...ENFORCED, ...LEGACY].sort()).toEqual([...CLI_TOOL_IDS].sort());
  });

  it.each(ENFORCED)('%s: enforce, so a list with no dialog under it is refused', tool => {
    // Guards the premise for the tools whose parser still builds the candidate.
    const detection = detectPrompt(AGENT_WROTE_A_LIST, { requireDefaultIndicator: false });
    expect(detection.promptData?.type).toBe('multiple_choice');

    expect(AUTO_YES_DIALOG_GATE_DEFAULT_MODE[tool]).toBe('enforce');
    expect(getToolStatusDetector(tool).hasDialogRules).toBe(true);

    const verdict = evaluateDialogPresence(tool, 'multiple_choice', AGENT_WROTE_A_LIST);
    expect(verdict).toMatchObject({ present: false, dialog: null, mode: 'enforce', gated: true });
  });

  it.each(LEGACY)('%s: legacy, so the candidate is kept untouched', tool => {
    expect(AUTO_YES_DIALOG_GATE_DEFAULT_MODE[tool]).toBe('legacy');

    const verdict = evaluateDialogPresence(tool, 'multiple_choice', AGENT_WROTE_A_LIST);
    expect(verdict).toMatchObject({ present: true, dialog: null, mode: 'legacy', gated: false });
  });

  it('cross-checks the table against which modules actually declare rules', () => {
    // The #1928 docstring's belt and braces, as an assertion: an `enforce` row
    // for a tool with no `detectDialog` would silence that tool's prompts
    // outright, and a tool that HAS rules but is `legacy` must still be left
    // alone — `mode` decides, not the module's existence.
    const withRules = CLI_TOOL_IDS.filter(tool => getToolStatusDetector(tool).hasDialogRules);
    expect([...withRules].sort()).toEqual([...ENFORCED].sort());

    for (const tool of LEGACY) {
      expect(getToolStatusDetector(tool).hasDialogRules).toBe(false);
    }
  });

  it('leaves every prompt family but multiple_choice alone', () => {
    // A `yes_no` prompt is a different inference — `detectPrompt` requires an
    // explicit `(y/n)` token rather than deriving it from layout — and no tool
    // in the registry has a measured yes/no dialog rule to gate it against.
    for (const type of ['yes_no', 'approval', 'choice', 'input', 'continue'] as const) {
      expect(evaluateDialogPresence('claude', type, AGENT_WROTE_A_LIST)).toMatchObject({
        present: true,
        gated: false,
      });
    }
    expect(evaluateDialogPresence('claude', undefined, AGENT_WROTE_A_LIST).gated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Presence is not answerability
// ---------------------------------------------------------------------------

describe('[#2457] presence is `dialog !== null`, not `allowed`', () => {
  it('vouches for opencode\'s keys-driven strip, which Auto-Yes still refuses', () => {
    // opencode's permission strip takes ←/→ + Enter, so a digit sent at it
    // selects nothing and `allowed` is false (#1893). It is still a live dialog,
    // and a prompt nobody can auto-answer is precisely the one a human has to be
    // shown — so deleting it from History is the opposite of the right answer.
    const raw = frame('opencode-live-1893', 'permission-bash');

    expect(evaluateDialogPresence('opencode', 'multiple_choice', raw)).toMatchObject({
      present: true,
      gated: true,
    });
    expect(evaluateAutoYesDialogGate('opencode', 'multiple_choice', stripBoxDrawing(stripAnsi(raw))).allowed)
      .toBe(false);
  });

  it('reads the capture, not the box-stripped spelling Auto-Yes hands over', () => {
    // The same frame, and the reason the two gates take different strings:
    // opencode anchors its strip on the input box's own gutter, so removing the
    // box drawing removes the anchor. `dialogs.test.ts` documents this as the
    // one tool where the two spellings disagree; for Auto-Yes both answers mean
    // "send nothing", for this gate one of them means "there is no prompt here".
    const raw = frame('opencode-live-1893', 'permission-bash');

    expect(evaluateDialogPresence('opencode', 'multiple_choice', raw).present).toBe(true);
    expect(evaluateDialogPresence('opencode', 'multiple_choice', stripBoxDrawing(stripAnsi(raw))).present)
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The env override stays where it was
// ---------------------------------------------------------------------------

describe('[#2457] CM_AUTOYES_DIALOG_GATE stays an Auto-Yes override', () => {
  const AGENT_WROTE_A_LIST = ['Pick one?', '  1. a', '  2. b'].join('\n');

  it('does not turn the presence gate off', () => {
    // An operator sets this because their unattended pipeline stopped answering
    // prompts. They are saying nothing about what belongs in History, and the
    // chat surface's contents must not depend on an Auto-Yes setting.
    process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = '*=legacy';

    expect(evaluateAutoYesDialogGate('claude', 'multiple_choice', AGENT_WROTE_A_LIST).gated).toBe(false);
    expect(evaluateDialogPresence('claude', 'multiple_choice', AGENT_WROTE_A_LIST)).toMatchObject({
      present: false,
      gated: true,
    });
  });

  it('does not turn the presence gate on for a legacy tool either', () => {
    process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = '*=enforce';

    expect(evaluateDialogPresence('antigravity', 'multiple_choice', AGENT_WROTE_A_LIST).gated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

describe('[#2457] the gate takes nothing away from the live corpus', () => {
  const TOOL_BY_PREFIX: Record<string, CLIToolType> = {
    claude: 'claude',
    codex: 'codex',
    copilot: 'copilot',
    opencode: 'opencode',
  };

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
          const raw = readFileSync(path.join(FIXTURES, dir, file), 'utf8');
          const detection = detectPrompt(
            stripBoxDrawing(stripAnsi(raw)),
            buildDetectPromptOptions(tool),
          );
          if (!detection.isPrompt || detection.promptData?.type !== 'multiple_choice') return [];
          return [{ id: `${dir}/${file}`, tool, raw }];
        });
    });

  it('finds the dialogs it is supposed to protect', () => {
    // The control. If this list ever empties, every assertion below is vacuous.
    expect(answerable.length).toBeGreaterThanOrEqual(9);
  });

  it.each(answerable.map(f => [f.id, f] as const))('%s is still a prompt', (_id, { tool, raw }) => {
    expect(evaluateDialogPresence(tool, 'multiple_choice', raw).present).toBe(true);
  });

  it.each([
    'reply-numbered-list-idle',
    'reply-numbered-list-taskpanel',
    'reply-numbered-list-composer-text',
    'reply-numbered-list-repaint',
    'reply-numbered-list-generating-repaint',
    'reply-question-paragraph',
    'reply-quotes-dialog-wording',
    'reply-table',
  ])('%s carries no dialog', name => {
    expect(evaluateDialogPresence('claude', 'multiple_choice', reply(name)).present).toBe(false);
  });
});

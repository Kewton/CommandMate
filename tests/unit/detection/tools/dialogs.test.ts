/**
 * The per-tool dialog rules, over live captures (Issue #1928, 方針書 §4 D1 決定 4).
 *
 * `detectDialog` is what stands between an agent's own numbered list and a `1`
 * being typed into a live composer (#1896), so the thing this file has to prove
 * is not that it says "dialog" on a dialog — every capture of an open dialog
 * says that, and a `detectDialog` that answered non-null unconditionally would
 * pass such a suite outright. What it has to prove is the OTHER direction:
 *
 *  - the frames that merely look like dialogs are refused (the `negatives`
 *    table below is the #1896 shape for every tool that has one), and
 *  - the ANCHOR is load-bearing — take one word or one glyph out of a real
 *    capture and the verdict must collapse to `null`, never survive on the rest
 *    of the frame (the `mutations` table). §11 makes that case an acceptance
 *    condition (DR1-020: 「変異注入でしか非空虚性を証明できない」), and it is the
 *    same argument `fixture-sweep.ts` makes for the idle-evidence rules.
 *
 * ## Two spellings of the same frame
 *
 * Every assertion runs twice. `detectSessionStatus` hands the detector a frame
 * with its box drawing intact; the Auto-Yes poller hands it one that has already
 * been through `stripBoxDrawing(stripAnsi(...))` (`captureAndCleanOutput`). A
 * rule that answered differently on the two would be a rule that protects the
 * status API and not the path that actually sends keystrokes.
 *
 * opencode is the documented exception, and the reason is in its `prompt.ts`:
 * its permission strip is anchored on the input box's own gutter (#1893's
 * anchor, which must not be weakened), so on the ANSI/box-stripped spelling the
 * verdict is `null` rather than `permission`. Both answers suppress — `keys` and
 * `null` alike mean "do not send" — which is what {@link expectSameGateVerdict}
 * checks instead.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { evaluateAutoYesDialogGate } from '@/lib/polling/auto-yes-dialog-gate';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { DialogVerdict } from '@/lib/detection/tools/types';

const FIXTURES = path.resolve(__dirname, '../../lib/detection/fixtures');

function frame(dir: string, name: string): string {
  return readFileSync(path.join(FIXTURES, dir, `${name}.txt`), 'utf8');
}

/** The spelling the Auto-Yes poller judges: `captureAndCleanOutput`, exactly. */
function asAutoYesSees(raw: string): string {
  return stripBoxDrawing(stripAnsi(raw));
}

function dialogOf(tool: CLIToolType, raw: string): DialogVerdict | null {
  return getToolStatusDetector(tool).detectDialog(normalizeFrame(raw));
}

/**
 * Replace `from` with `to` in the FIRST row matching `rowMatch`, leaving every
 * other byte — including the same word anywhere else on the pane — untouched.
 *
 * Row-scoped on purpose. A whole-frame `raw.replace('❯', ' ')` hits the
 * transcript's echoed user turn hundreds of rows above the dialog and leaves the
 * cursor in place, so the "mutation" would prove nothing while staying green.
 * Throws when the row is missing or the replacement is a no-op, which is what
 * makes that failure loud instead of silent.
 */
function rewordRow(raw: string, rowMatch: RegExp, from: string, to: string): string {
  const rows = raw.split('\n');
  const index = rows.findIndex(row => rowMatch.test(stripAnsi(row)));
  if (index < 0) throw new Error(`no row matched ${rowMatch}`);
  const rewritten = rows[index].replace(from, to);
  if (rewritten === rows[index]) throw new Error(`row ${index} carries no ${from}`);
  rows[index] = rewritten;
  return rows.join('\n');
}

/** Erase the first row matching `rowMatch`, keeping the pane's row count. */
function blankRow(raw: string, rowMatch: RegExp): string {
  const rows = raw.split('\n');
  const index = rows.findIndex(row => rowMatch.test(stripAnsi(row)));
  if (index < 0) throw new Error(`no row matched ${rowMatch}`);
  rows[index] = '';
  return rows.join('\n');
}

/** Append a row to the bottom of the pane, below its trailing padding. */
function appendRow(raw: string, row: string): string {
  return `${raw.replace(/\n+$/, '')}\n${row}\n`;
}

interface DialogFixture {
  frame: string;
  kind: string;
  answerMode: DialogVerdict['answerMode'];
  /** First option, so a block that parsed the wrong rows is visible. */
  firstOption?: string;
}

interface DialogMutation {
  /** What the mutation is called in the test name. */
  label: string;
  /** Fixture it is injected into — always one of {@link DialogSuite.positives}. */
  frame: string;
  mutate: (raw: string) => string;
}

interface DialogSuite {
  tool: CLIToolType;
  dir: string;
  /** Frames the tool's rules must vouch for. */
  positives: readonly DialogFixture[];
  /**
   * Frames that must answer `null`.
   *
   * Every tool's list holds at least one frame whose pane carries the tool's own
   * dialog VOCABULARY as body text — that is the #1896 shape, and the reason
   * none of these rules may be a window match.
   */
  negatives: readonly string[];
  mutations: readonly DialogMutation[];
  /**
   * Whether the ANSI/box-stripped spelling reaches the same verdict.
   *
   * False only for opencode; see the module docstring.
   */
  sameVerdictWhenStripped: boolean;
}

const SUITES: readonly DialogSuite[] = [
  {
    tool: 'claude',
    dir: 'claude-live-1708',
    positives: [
      {
        frame: 'bash-approval-taskpanel',
        kind: 'permission',
        answerMode: 'numbered',
        firstOption: 'Yes',
      },
      {
        frame: 'askuserquestion-submit-taskpanel',
        kind: 'ask_user',
        answerMode: 'numbered',
        firstOption: 'Submit answers',
      },
    ],
    negatives: ['idle-taskpanel'],
    mutations: [
      {
        // Claude's `❯` is on the highlighted option of every dialog it draws and
        // on nothing it writes, so removing it turns the block into what an
        // agent's own numbered list looks like. `detectPrompt` cannot tell the
        // difference — it still reports `multiple_choice` for this frame — which
        // is precisely why the gate reads this rule and not that inference.
        label: 'the ❯ cursor is taken off the highlighted option',
        frame: 'bash-approval-taskpanel',
        mutate: raw => rewordRow(raw, /^\s*❯\s*1\.\s/, '❯', ' '),
      },
      {
        label: 'the footer verb is reworded',
        frame: 'bash-approval-taskpanel',
        mutate: raw => rewordRow(raw, /Esc to cancel/, 'cancel', 'dismiss'),
      },
      {
        // The AskUserQuestion review screen has NO footer, so the cursor is the
        // only anchor it has. If that stops being required, this frame is the
        // one that goes unprotected.
        label: 'the ❯ cursor is taken off a footer-less dialog',
        frame: 'askuserquestion-submit-taskpanel',
        mutate: raw => rewordRow(raw, /^\s*❯\s*1\.\s/, '❯', ' '),
      },
    ],
    sameVerdictWhenStripped: true,
  },
  {
    tool: 'codex',
    dir: 'codex-live-1628',
    positives: [
      {
        frame: 'approval-run-command',
        kind: 'permission',
        answerMode: 'numbered',
        firstOption: 'Yes, proceed (y)',
      },
      {
        frame: 'approval-apply-patch',
        kind: 'permission',
        answerMode: 'numbered',
        firstOption: 'Yes, proceed (y)',
      },
      { frame: 'model-picker-step1', kind: 'picker', answerMode: 'numbered' },
      { frame: 'model-picker-step2', kind: 'picker', answerMode: 'numbered' },
    ],
    negatives: ['idle-ready', 'working'],
    mutations: [
      {
        label: 'the confirm footer is reworded',
        frame: 'approval-run-command',
        mutate: raw => rewordRow(raw, /Press enter to confirm/, 'confirm', 'proceed'),
      },
      {
        label: 'the confirm footer is erased from the picker',
        frame: 'model-picker-step2',
        mutate: raw => blankRow(raw, /Press enter to confirm/),
      },
    ],
    sameVerdictWhenStripped: true,
  },
  {
    tool: 'copilot',
    dir: 'copilot-live-1885',
    positives: [
      {
        frame: 'permission-dialog',
        kind: 'permission',
        answerMode: 'numbered',
        firstOption: 'Yes',
      },
      // A picker copilot draws with no numbers at all: a dialog, and one nothing
      // may answer by typing.
      { frame: 'model-picker', kind: 'picker', answerMode: 'keys' },
    ],
    negatives: [
      'boot-idle',
      'turn-running-thinking',
      // The #1896 shape, live: copilot's finished reply IS a four-item numbered
      // list whose first item wears a `●` bullet, so the block reader finds a
      // "selected option 1" on it. Only the status bar tells the two apart.
      'turn-complete',
      // copilot printed ` ● Working esc interrupt` as body text.
      'status-vocabulary-in-response',
    ],
    mutations: [
      {
        // The positional guard, injected: put copilot's measured idle bar back
        // on the bottom row and the dialog must stop being one, because a frame
        // that still has its status bar is a frame with no dialog box on it.
        label: 'the idle status bar is drawn under the dialog',
        frame: 'permission-dialog',
        mutate: raw => appendRow(raw, ' ← open sidebar · / commands · ? help · tab next tab'),
      },
      {
        label: 'the navigate/select footer is erased',
        frame: 'permission-dialog',
        mutate: raw => blankRow(raw, /to navigate.*enter to select/),
      },
    ],
    sameVerdictWhenStripped: true,
  },
  {
    tool: 'opencode',
    dir: 'opencode-live-1893',
    positives: [
      {
        frame: 'permission-bash',
        kind: 'permission',
        answerMode: 'keys',
        firstOption: 'Allow once',
      },
      {
        frame: 'permission-edit',
        kind: 'permission',
        answerMode: 'keys',
        firstOption: 'Allow once',
      },
    ],
    negatives: ['turn-complete-short', 'turn-aborted-no-duration'],
    mutations: [
      {
        label: 'one button of the permission strip is reworded',
        frame: 'permission-bash',
        mutate: raw => rewordRow(raw, /Allow once/, 'Reject', 'Refuse'),
      },
    ],
    sameVerdictWhenStripped: false,
  },
];

/**
 * The two spellings must lead to the same ACTION even where they lead to
 * different verdicts.
 *
 * `allowed` is what the Auto-Yes poller acts on, so this is the property that
 * has to hold on both paths. For every tool but opencode the verdicts match
 * outright and this is implied; for opencode it is the whole statement.
 */
function expectSameGateVerdict(tool: CLIToolType, raw: string): void {
  const boxed = evaluateAutoYesDialogGate(tool, 'multiple_choice', normalizeFrame(raw).clean);
  const stripped = evaluateAutoYesDialogGate(tool, 'multiple_choice', asAutoYesSees(raw));
  expect(stripped.allowed).toBe(boxed.allowed);
}

describe.each(SUITES.map(suite => [suite.tool, suite] as const))(
  '[#1928] %s dialog rules',
  (tool, suite) => {
    it.each(suite.positives)(
      '$frame is a $kind the tool vouches for',
      ({ frame: name, kind, answerMode, firstOption }) => {
        const raw = frame(suite.dir, name);
        const verdict = dialogOf(tool, raw);

        expect(verdict, `${name} was not recognised`).not.toBeNull();
        expect(verdict!.kind).toBe(kind);
        expect(verdict!.answerMode).toBe(answerMode);
        if (firstOption !== undefined) expect(verdict!.options[0]).toBe(firstOption);
      },
    );

    it.each(suite.positives)('$frame reaches the same gate verdict on both spellings', ({ frame: name }) => {
      expectSameGateVerdict(tool, frame(suite.dir, name));
    });

    if (suite.sameVerdictWhenStripped) {
      it.each(suite.positives)(
        '$frame parses identically once ANSI and box drawing are gone',
        ({ frame: name }) => {
          const raw = frame(suite.dir, name);
          expect(dialogOf(tool, asAutoYesSees(raw))).toEqual(dialogOf(tool, raw));
        },
      );
    } else {
      it.each(suite.positives)(
        '$frame answers null once its gutter is gone, and still suppresses',
        ({ frame: name }) => {
          // opencode only. `OPENCODE_PERMISSION_PATTERN` is anchored on the input
          // box's gutter (#1893) and that anchor is not weakened for this seam,
          // because both answers lead to the same action — see the docstring.
          const raw = frame(suite.dir, name);
          expect(dialogOf(tool, asAutoYesSees(raw))).toBeNull();
          expect(
            evaluateAutoYesDialogGate(tool, 'multiple_choice', asAutoYesSees(raw)).allowed,
          ).toBe(false);
        },
      );
    }

    it.each(suite.negatives)('%s is not a dialog, on either spelling', name => {
      const raw = frame(suite.dir, name);
      expect(dialogOf(tool, raw), `${name} (boxed)`).toBeNull();
      expect(dialogOf(tool, asAutoYesSees(raw)), `${name} (stripped)`).toBeNull();
    });

    it.each(suite.mutations)('loses the verdict when $label', ({ frame: name, mutate }) => {
      const raw = frame(suite.dir, name);
      const mutated = mutate(raw);

      // The mutation landed. Without this the assertion below could pass on an
      // unchanged frame if the tool ever re-colours the row it edits.
      expect(mutated).not.toBe(raw);
      expect(dialogOf(tool, raw), 'the fixture was not a dialog to begin with').not.toBeNull();

      expect(dialogOf(tool, mutated)).toBeNull();
      expect(dialogOf(tool, asAutoYesSees(mutated))).toBeNull();
    });
  },
);

describe('[#1928] every gated tool declares at least one positive and one mutation', () => {
  it('leaves no tool in the gate whose green would be vacuous', () => {
    // Structural, not conventional: a tool added to
    // AUTO_YES_DIALOG_GATE_DEFAULT_MODE without both is a tool whose rule nobody
    // has shown to be load-bearing, and this is the test that says so.
    for (const suite of SUITES) {
      expect(suite.positives.length, suite.tool).toBeGreaterThan(0);
      expect(suite.mutations.length, suite.tool).toBeGreaterThan(0);
      expect(suite.negatives.length, suite.tool).toBeGreaterThan(0);
    }
  });
});

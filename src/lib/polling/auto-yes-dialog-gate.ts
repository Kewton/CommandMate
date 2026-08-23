/**
 * The one position that can stop Issue #1896: Auto-Yes may fire only on a
 * POSITIVELY detected tool dialog (Issue #1928, 方針書 §4 D1 決定 4).
 *
 * ## What goes wrong without it
 *
 * `detectPrompt` answers "does this frame look like a numbered choice?" from the
 * text alone. An agent that lists three deployment options and asks which one
 * the operator wants satisfies it exactly — and on opencode the `1` Auto-Yes
 * typed in reply was not answering anything, it was SENT AS A USER UTTERANCE
 * (#1896). Same shape, different tool: a codex approval the operator answered
 * five minutes ago is still on the pane, options and footer intact (#1160).
 *
 * The generic inference cannot tell any of these from a live dialog, because
 * nothing in the ROWS distinguishes them — what distinguishes them is position
 * and chrome, which only the tool's own module knows. So this gate asks that
 * module, through the `detectDialog` seam §4 D2 declared, and sends nothing when
 * it declines.
 *
 * ## Rollout, and why the table is explicit
 *
 * Per tool, exactly like the idle-evidence rollout in
 * `config/detection-evidence-config.ts`. A tool whose dialogs nobody has
 * measured must NOT be gated: gating it would turn every one of its prompts into
 * a suppression and stop Auto-Yes working at all for that tool, which is a
 * bigger regression than the false positive the gate exists to prevent. The
 * table states that decision rather than leaving it implicit in which modules
 * happen to declare `detectDialog` — although the two are cross-checked, because
 * an `enforce` row for a tool with no rules would silence it.
 *
 * ## Which inference is gated
 *
 * The NUMBERED-LIST one, and only it. §4 D1 決定 4 names it in as many words
 * (「`detectPrompt` の汎用な番号リスト推定だけでは撃たない」) and #1896 is an
 * instance of it, so `multiple_choice` is what this gate judges.
 *
 * A `yes_no` prompt is a different inference — `detectPrompt` requires an
 * explicit `(y/n)`-shaped token in the text rather than deriving it from layout
 * — and NO tool in the registry has a measured yes/no dialog rule to gate it
 * against. Gating an inference for which no positive rule exists is the failure
 * mode the rollout guidance is written to prevent: every such prompt would
 * become a suppression, and the operator would see a worker that had silently
 * gone quiet. When a tool's yes/no dialog is measured and fixtured, widen this
 * the same way a tool is added to the table.
 *
 * ## What "allowed" does NOT mean
 *
 * It does not mean "send this answer". The contract policy (#1547), the deny
 * patterns (#1699) and the base rules all still run afterwards and can each
 * withhold. This gate only removes an answer the tool's own rules cannot vouch
 * for.
 *
 * @module lib/polling/auto-yes-dialog-gate
 */

import { normalizeFrame } from '@/lib/detection/tools/frame';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { DialogVerdict } from '@/lib/detection/tools/types';
import type { PromptType } from '@/types/models';

/**
 * What to do with a tool's measured dialog rules.
 *
 * - `enforce` — Auto-Yes fires only where `detectDialog` vouched for the frame.
 * - `legacy` — the pre-#1928 behaviour: the generic numbered-list inference is
 *   enough. This is the correct setting for a tool whose dialogs have not been
 *   read off its own frames.
 */
export type AutoYesDialogGateMode = 'enforce' | 'legacy';

/** Every accepted value of {@link AutoYesDialogGateMode}, for parsing and tests. */
export const AUTO_YES_DIALOG_GATE_MODES: readonly AutoYesDialogGateMode[] = ['enforce', 'legacy'];

/**
 * The rollout state each tool ships in.
 *
 * `enforce` is set only for the four tools with a dialog rule measured from
 * their own live captures, each with a positive fixture and a mutation fixture
 * (`tests/unit/detection/tools/dialogs.test.ts`):
 *
 * | tool     | positive rule                                                        | Issue         |
 * |----------|----------------------------------------------------------------------|---------------|
 * | claude   | `❯` cursor on the option run above the chrome, dialog footer or none  | #1708 / #1495 |
 * | codex    | `Press enter to confirm …` under the options, above the status bar, not stale | #1628 / #1160 |
 * | copilot  | the bottom status bar is GONE and the option run carries a picker footer | #1885 / #1895 |
 * | opencode | the `Allow once / Allow always / Reject` strip, or a picker header    | #1893 / #1896 |
 *
 * The rest are `legacy` because nobody has measured them:
 *
 * - `gemini` and `vibe-local` have no tool module at all
 *   (`createGenericStatusDetector`), so there is nothing to ask.
 * - `antigravity` has a module, but its permission menu was measured only well
 *   enough to answer it (#999: an ASCII `>` cursor, a `↑/↓ Navigate` footer and
 *   no `press enter to confirm`), and the repository holds no live agy capture
 *   to write a dialog rule against. Gating it on a rule inferred from another
 *   tool's frames is the mistake #1979 had to correct; leaving it `legacy` keeps
 *   agy's Auto-Yes working exactly as it does today.
 */
export const AUTO_YES_DIALOG_GATE_DEFAULT_MODE: Readonly<
  Record<CLIToolType, AutoYesDialogGateMode>
> = {
  claude: 'enforce',
  codex: 'enforce',
  copilot: 'enforce',
  opencode: 'enforce',
  gemini: 'legacy',
  antigravity: 'legacy',
  'vibe-local': 'legacy',
};

/**
 * The kill switch (§13.1 DR3-016).
 *
 * A comma-separated list of `<tool>=<mode>` pairs, with `*` for "every tool",
 * spelled exactly like `CM_DETECTION_IDLE_EVIDENCE`:
 *
 * ```
 * CM_AUTOYES_DIALOG_GATE=codex=legacy    # one tool back to the pre-#1928 behaviour
 * CM_AUTOYES_DIALOG_GATE=*=legacy        # the whole gate off
 * ```
 *
 * Read on every poll rather than at module load, for the same reason the
 * idle-evidence switch is: an operator whose unattended pipeline has stopped
 * answering prompts must be able to undo this without a redeploy, and a cached
 * read would put a restart between them and the incident.
 */
export const AUTO_YES_DIALOG_GATE_ENV_VAR = 'CM_AUTOYES_DIALOG_GATE';

function isMode(value: string): value is AutoYesDialogGateMode {
  return (AUTO_YES_DIALOG_GATE_MODES as readonly string[]).includes(value);
}

/**
 * Resolve one tool's gate mode.
 *
 * Later entries win over earlier ones and a tool-specific entry beats `*` in
 * either order. An unparseable entry is ignored rather than thrown: this runs on
 * the Auto-Yes polling path, and a typo in an env var must not take the poller
 * down.
 *
 * @param tool - CLI tool to resolve for
 * @param env - Environment to read; injectable for tests
 */
export function resolveAutoYesDialogGateMode(
  tool: CLIToolType,
  env: NodeJS.ProcessEnv = process.env,
): AutoYesDialogGateMode {
  const raw = env[AUTO_YES_DIALOG_GATE_ENV_VAR];
  let wildcard: AutoYesDialogGateMode | null = null;
  let specific: AutoYesDialogGateMode | null = null;

  if (typeof raw === 'string' && raw.trim() !== '') {
    for (const entry of raw.split(',')) {
      const [rawKey, rawValue] = entry.split('=');
      if (rawValue === undefined) continue;
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (!isMode(value)) continue;
      if (key === '*') wildcard = value;
      else if (key === tool) specific = value;
    }
  }

  return specific ?? wildcard ?? AUTO_YES_DIALOG_GATE_DEFAULT_MODE[tool] ?? 'legacy';
}

/** The gate's answer for one frame. */
export interface AutoYesDialogGateVerdict {
  /** Whether Auto-Yes may go on to resolve and send an answer. */
  allowed: boolean;
  /** The dialog the tool vouched for, or null when it did not. */
  dialog: DialogVerdict | null;
  /** The mode in force, for the log line. */
  mode: AutoYesDialogGateMode;
  /**
   * Whether the gate actually judged this frame.
   *
   * False for a `legacy` tool and for one with no measured rules, where
   * `allowed` is true by default rather than by observation. The distinction is
   * what keeps a "we did not look" out of the suppression record.
   */
  gated: boolean;
}

/** The only prompt family this gate judges. See the module docstring. */
const GATED_PROMPT_TYPE: PromptType = 'multiple_choice';

/**
 * May Auto-Yes answer the prompt the generic inference found on this frame?
 *
 * @param cliToolId - CLI tool being polled
 * @param promptType - How `detectPrompt` classified the frame
 * @param cleanOutput - The capture Auto-Yes judged, i.e. what
 *   `captureAndCleanOutput` produced: ANSI **and** box drawing already removed.
 *   Every `detectDialog` implementation is written against that spelling as well
 *   as the untouched one, so the same frame reaches the same verdict on both
 *   paths.
 * @param env - Environment to read the kill switch from; injectable for tests
 */
export function evaluateAutoYesDialogGate(
  cliToolId: CLIToolType,
  promptType: PromptType,
  cleanOutput: string,
  env: NodeJS.ProcessEnv = process.env,
): AutoYesDialogGateVerdict {
  const detector = getToolStatusDetector(cliToolId);
  const mode = resolveAutoYesDialogGateMode(cliToolId, env);

  // A tool nobody has measured is not gated whatever the table says. Belt and
  // braces on purpose: the failure mode of getting this wrong is Auto-Yes going
  // permanently silent for that tool, which looks exactly like a hung worker.
  if (promptType !== GATED_PROMPT_TYPE || !detector.hasDialogRules || mode === 'legacy') {
    return { allowed: true, dialog: null, mode, gated: false };
  }

  const dialog = detector.detectDialog(normalizeFrame(cleanOutput));

  return {
    // `keys` is a dialog and still not answerable: opencode's button strip takes
    // ←/→ + Enter, so the digit is swallowed and the Enter confirms whatever is
    // highlighted — asking to Reject would Approve (#1893). Sending nothing is
    // the only safe answer, and `wait` still stops for the frame.
    allowed: dialog !== null && dialog.answerMode === 'numbered',
    dialog,
    mode,
    gated: true,
  };
}

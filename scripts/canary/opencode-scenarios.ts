/**
 * The opencode canary scenarios (Issue #2050).
 *
 * Five states, one per positive rule in `src/lib/detection/tools/opencode/detect.ts`
 * — the branches A0 / A / C / D / E that are the whole of what opencode's status
 * detector can say. Driving each of them against a real 1.18.22 TUI is what
 * turns "the rules were read off a capture once" into "the rules still describe
 * the CLI that is installed".
 *
 * | id                       | branch | state                                   |
 * |--------------------------|--------|-----------------------------------------|
 * | `opencode-idle`          | E      | boot composer, `┃  Ask anything...`      |
 * | `opencode-generating`    | A      | busy footer, `esc interrupt`             |
 * | `opencode-permission`    | A0     | `Allow once   Allow always   Reject`     |
 * | `opencode-picker`        | C      | `/models` fuzzy list                     |
 * | `opencode-turn-complete` | D      | `▣  Build · <model> · <duration>`        |
 *
 * ## Every mutant below is UNSATISFIABLE in its own scenario
 *
 * `--mutate` reports "self-test FAILED (vacuous assertion)" if any scenario goes
 * green against its `mutantExpectation`, so a mutant that the scenario could
 * *drift into* would make the self-test flaky rather than sharp. That rules out
 * the obvious pairing of `opencode-generating` with `opencode-turn-complete`:
 * the measured turn finished in 12.8 s, well inside `--mutate`'s 30 s clock, so
 * that mutant would have come true and been reported as a vacuous assertion.
 * Each mutant here instead demands a row the scenario never paints — the dialog
 * heading, the picker hint, the busy footer.
 *
 * ## The two scenarios that need the seeded config
 *
 * - `opencode-permission` only reaches a dialog because the throwaway HOME's
 *   `opencode.jsonc` sets `permission.bash = "ask"`. Measured on 1.18.22 with
 *   opencode's defaults, `ls -la` simply RAN and the turn completed with no
 *   dialog at all. That seed is the counterpart of claude's
 *   `--permission-mode manual` (#1847): a statement about the canary, not about
 *   what a CommandMate session gets.
 * - `opencode-picker` opens the model chooser, which WRITES the default model
 *   when confirmed. It is escaped rather than confirmed, it runs inside the
 *   throwaway HOME, and `guards.ts` fingerprints the developer's real
 *   `~/.config/opencode/opencode.json*` before and after every scenario.
 */

import {
  expectOpenCodeGenerating,
  expectOpenCodeIdleComposer,
  expectOpenCodePermissionDialog,
  expectOpenCodePicker,
  expectOpenCodeTurnComplete,
} from './opencode-expectations';
import type { CanaryScenario } from './types';

/** Prompt used by both token-spending narrative scenarios. Deliberately tool-free. */
const NARRATIVE_PROMPT =
  'Without using any tools, write about 300 words explaining how terminal multiplexers keep processes alive across disconnects.';

export const OPENCODE_SCENARIOS: readonly CanaryScenario[] = [
  {
    id: 'opencode-idle',
    tool: 'opencode',
    title: 'Idle composer on the boot screen',
    intent:
      'Branch E (#1883). `Ask anything...` behind the input box gutter is opencode\'s positive "the buffer is empty" evidence. Reporting this as running blocks `wait`; reporting it as ready WITHOUT evidence is the D1 violation that let a stalled session look finished.',
    cost: 'none',
    timeoutMs: 60_000,
    pollIntervalMs: 2_000,
    expectation: expectOpenCodeIdleComposer,
    // Unsatisfiable: nothing is driven, so no busy footer is ever painted.
    mutantExpectation: expectOpenCodeGenerating,
    async drive(): Promise<void> {
      // Reaching the composer IS the scenario. The readiness gate looks for the
      // `tab agents  ctrl+p commands` footer, NOT for the composer placeholder,
      // so the verdict asserted here is an independent statement.
    },
  },
  {
    id: 'opencode-generating',
    tool: 'opencode',
    title: 'Actively generating (`esc interrupt` footer)',
    intent:
      'Branch A (#1894). The busy footer has two spellings and for five seconds after a single Escape it is the second one; before #1894 those five seconds matched nothing and a generating session was published `ready`/`no_recent_output`. Misreading it makes `wait` return immediately.',
    cost: 'small',
    timeoutMs: 120_000,
    // The measured turn finished in 12.8s, so the running window is short —
    // poll fast enough not to step over it.
    pollIntervalMs: 750,
    expectation: expectOpenCodeGenerating,
    // Unsatisfiable: this prompt asks for no tools, so no dialog is ever drawn.
    mutantExpectation: expectOpenCodePermissionDialog,
    async drive(driver): Promise<void> {
      await driver.submitPrompt(NARRATIVE_PROMPT);
    },
  },
  {
    id: 'opencode-permission',
    tool: 'opencode',
    title: 'Permission dialog button strip (Allow once / Allow always / Reject)',
    intent:
      'Branch A0 (#1893). The strip has no number, no (y/n) and no confirm footer, so `detectPrompt` says isPrompt=false and the detector used to fall through to the duration-less `▣ Build · <model>` row of the step BLOCKED ON THIS DIALOG — publishing it as `ready`. `wait` then reported a false completion and the send guard opened.',
    cost: 'small',
    timeoutMs: 180_000,
    pollIntervalMs: 2_000,
    expectation: expectOpenCodePermissionDialog,
    // Unsatisfiable: the picker's hint row is never on screen here.
    mutantExpectation: expectOpenCodePicker,
    // Escape rejects the request (measured on 1.18.22) rather than approving it.
    resetKeys: ['Escape'],
    async drive(driver): Promise<void> {
      await driver.submitPrompt('Run the shell command: ls -la . Do not do anything else.');
    },
  },
  {
    id: 'opencode-picker',
    tool: 'opencode',
    title: '/models picker',
    intent:
      'Branch C (#1896). The picker WRITES the default model when confirmed — opencode\'s version of the #1495 trap. It must read as a selection list (NavigationButtons + escape hatch, `wait` exit 10) AND stay invisible to Auto-Yes, which would otherwise Enter-confirm whatever model is highlighted.',
    cost: 'none',
    timeoutMs: 60_000,
    pollIntervalMs: 1_500,
    expectation: expectOpenCodePicker,
    // Unsatisfiable: the dialog heading is never on screen here.
    mutantExpectation: expectOpenCodePermissionDialog,
    // Escape closes the picker WITHOUT selecting (measured on 1.18.22): the
    // frame returns to the boot composer and the seeded model is unchanged.
    resetKeys: ['Escape'],
    async drive(driver): Promise<void> {
      // Typed as literal text, then submitted, so opencode's command suggestion
      // row has settled before Enter selects it.
      await driver.submitPrompt('/models');
    },
  },
  {
    id: 'opencode-turn-complete',
    tool: 'opencode',
    title: 'Finished-turn marker with its duration',
    intent:
      'Branch D (#1893). opencode is the one tool design rule D1 credits with a completion marker of its own, and the DURATION is the whole of what makes it evidence — the same row without one is drawn for a step that is still open. Note the reason differs from `opencode-idle`: after a turn has run opencode stops painting `Ask anything...`, so branch E can no longer vouch for this frame.',
    cost: 'small',
    timeoutMs: 180_000,
    pollIntervalMs: 2_000,
    expectation: expectOpenCodeTurnComplete,
    // Unsatisfiable: this prompt asks for no tools, so no dialog is ever drawn.
    mutantExpectation: expectOpenCodePermissionDialog,
    async drive(driver): Promise<void> {
      await driver.submitPrompt(NARRATIVE_PROMPT);
    },
  },
];

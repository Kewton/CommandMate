/**
 * The five canary scenarios (Issue #1727).
 *
 * Each one drives a real `claude` into a state the detection layer has broken on
 * before, then asserts what production would conclude about that frame. The
 * prompts are deliberately tiny — the point is the TUI state, not the answer.
 *
 * Adding a scenario: append an entry here (id must be filename-safe, it names the
 * fixture), give it an expectation from `expectations.ts` and a DIFFERENT
 * `mutantExpectation` so `--mutate` can prove it is not vacuous. Nothing else
 * needs to change; `--only` / `--list` / fixtures pick it up automatically.
 */

import {
  expectAskUserQuestionWithTaskPanel,
  expectGenerating,
  expectIdleReady,
  expectModelOverlay,
  expectPermissionDialog,
} from './expectations';
import type { CanaryScenario } from './types';

/** Filename the permission scenario asks Claude to create (never actually created — the dialog is cancelled). */
const PERMISSION_PROBE_FILE = 'canary-permission-probe.txt';

export const SCENARIOS: readonly CanaryScenario[] = [
  {
    id: 'idle',
    title: 'Idle composer right after startup',
    intent:
      'A freshly started session must read as ready/input_prompt. Reporting it as running blocks `wait`; reporting it as waiting fires Auto-Yes at nothing.',
    cost: 'none',
    timeoutMs: 60_000,
    pollIntervalMs: 2_000,
    expectation: expectIdleReady,
    mutantExpectation: expectPermissionDialog,
    async drive(): Promise<void> {
      // Nothing to drive: reaching the composer IS the scenario. The readiness
      // gate in session.ts only looks for the raw "? for shortcuts" footer, so
      // the detector verdict asserted here is an independent statement.
    },
  },
  {
    id: 'permission-dialog',
    title: 'Tool permission dialog (Write tool)',
    intent:
      'The dialog both the UI PromptPanel and Auto-Yes depend on. When it slips through detection, `wait --on-prompt agent` never returns exit 10 and an unattended worker sits until timeout (#1708).',
    cost: 'small',
    timeoutMs: 150_000,
    pollIntervalMs: 2_000,
    expectation: expectPermissionDialog,
    mutantExpectation: expectIdleReady,
    resetKeys: ['Escape'],
    async drive(driver): Promise<void> {
      await driver.submitPrompt(
        `Use the Write tool to create a file named ${PERMISSION_PROBE_FILE} in the current directory containing the single word hello. Do not do anything else.`
      );
    },
  },
  {
    id: 'askuserquestion-task-panel',
    title: 'AskUserQuestion picker while the task panel is on screen',
    intent:
      'The Issue #1708 shape: the picker sits at the top of a 1000-row pane and Claude\'s "N tasks (...)" panel at the very bottom, where NORMAL_OPTION_PATTERN reads the panel header as an option and poisons collection. The assertion requires the panel to be visible, so a pass proves the coexistence was really exercised.',
    cost: 'small',
    timeoutMs: 240_000,
    pollIntervalMs: 3_000,
    expectation: expectAskUserQuestionWithTaskPanel,
    mutantExpectation: expectIdleReady,
    resetKeys: ['Escape'],
    async drive(driver): Promise<void> {
      await driver.submitPrompt(
        'Use the TaskCreate tool (load it with ToolSearch first if it is deferred) to create exactly 3 tasks named "Clear desk", "Sort papers" and "Wrangle cables". ' +
          'Then use the AskUserQuestion tool to ask me which task to start with. Do not do anything else and do not run any other tool.'
      );
    },
  },
  {
    id: 'model-overlay',
    title: '/model overlay',
    intent:
      'The overlay writes the default model when confirmed. It must read as a selection list (NavigationButtons + escape hatch) AND stay invisible to Auto-Yes — Auto-Yes Enter-confirming it is exactly how #1495 silently changed a user default.',
    cost: 'none',
    timeoutMs: 60_000,
    pollIntervalMs: 1_500,
    expectation: expectModelOverlay,
    mutantExpectation: expectPermissionDialog,
    resetKeys: ['Escape'],
    async drive(driver): Promise<void> {
      // Typed as literal text, then submitted, so the slash-command menu has
      // settled before Enter selects it.
      await driver.submitPrompt('/model');
    },
  },
  {
    id: 'generating',
    title: 'Actively generating',
    intent:
      'Generation must read as running/thinking_indicator. Misreading it as ready makes `wait` return immediately and the sidebar dot go static mid-run (#805, #1150).',
    cost: 'small',
    timeoutMs: 120_000,
    // Generation can finish quickly; poll fast so the running window is not missed.
    pollIntervalMs: 750,
    expectation: expectGenerating,
    mutantExpectation: expectModelOverlay,
    resetKeys: ['Escape'],
    async drive(driver): Promise<void> {
      await driver.submitPrompt(
        'Without using any tools, write about 400 words explaining how terminal multiplexers keep processes alive across disconnects.'
      );
    },
  },
];

/** Look up scenarios by id, preserving declaration order. */
export function selectScenarios(only: readonly string[], skip: readonly string[]): CanaryScenario[] {
  const known = new Set(SCENARIOS.map(scenario => scenario.id));
  for (const id of [...only, ...skip]) {
    if (!known.has(id)) {
      throw new Error(`canary: unknown scenario "${id}". Known ids: ${[...known].join(', ')}`);
    }
  }
  return SCENARIOS.filter(scenario => {
    if (only.length > 0 && !only.includes(scenario.id)) return false;
    return !skip.includes(scenario.id);
  });
}

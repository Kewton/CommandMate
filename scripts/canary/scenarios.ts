/**
 * The canary scenarios.
 *
 * Each one drives a real agent CLI into a state the detection layer has broken
 * on before, then asserts what production would conclude about that frame. The
 * prompts are deliberately tiny — the point is the TUI state, not the answer.
 *
 * Seven of them drive `claude`: five (#1727) read the frame alone, and the last
 * two (#1847) additionally point the session's injected hooks at the canary's
 * own receiver and assert what Auto-Yes v2's verdict did to the screen; those
 * carry a `hooks` block and their expectations live in `hook-expectations.ts`.
 * Five more (#2050) drive `opencode` and live in `opencode-scenarios.ts`.
 *
 * A run drives ONE tool (`--tool`, default claude) — the throwaway HOME, the
 * pane geometry and the readiness row all differ per tool — so every entry
 * declares which one it belongs to and {@link selectScenarios} filters on it.
 *
 * Adding a scenario: append an entry here (id must be filename-safe, it names the
 * fixture), give it a `tool`, an expectation from `expectations.ts` and a
 * DIFFERENT `mutantExpectation` so `--mutate` can prove it is not vacuous.
 * Nothing else needs to change; `--only` / `--list` / fixtures pick it up
 * automatically.
 */

import {
  expectAskUserQuestionWithTaskPanel,
  expectGenerating,
  expectIdleReady,
  expectModelOverlay,
  expectPermissionDialog,
} from './expectations';
import {
  expectPermissionAllowedByHook,
  expectPermissionDialogAfterNoDecision,
} from './hook-expectations';
import { OPENCODE_SCENARIOS } from './opencode-scenarios';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import type { CanaryScenario, CanaryToolId } from './types';

/** Filename the permission scenario asks Claude to create (never actually created — the dialog is cancelled). */
const PERMISSION_PROBE_FILE = 'canary-permission-probe.txt';

/** Filename the Auto-Yes v2 allow scenario asks Claude to create — and which really is created. */
const HOOK_ALLOW_PROBE_FILE = 'canary-hook-allow-probe.txt';

/** Filename the Auto-Yes v2 no-decision scenario asks for. The deny pattern below matches it. */
const HOOK_DENY_PROBE_FILE = 'canary-hook-deny-probe.txt';

/**
 * The one contract policy both Auto-Yes v2 scenarios are judged against
 * (Issue #1847).
 *
 * Deliberately the SAME object for both, with the outcome decided by the
 * filename each prompt asks for. That is what makes the pair a statement about
 * `denyPatterns` rather than about two unrelated configurations: the allow
 * scenario proves the pattern was evaluated and did not match, the no-decision
 * scenario proves the same pattern suppressed the answer when it did.
 *
 * `mode` is null — a contract that lists deny patterns and states no mode —
 * because deny patterns are honoured regardless of mode
 * (`evaluatePolicyAgainstTexts`), and any real mode would suppress the
 * `multiple_choice` verdict for its own reason and hide the pattern under it.
 */
const HOOK_SCENARIO_POLICY: AutoYesPolicy = {
  mode: null,
  allowPromptTypes: [],
  denyPatterns: ['canary-hook-deny-probe'],
};

const CLAUDE_SCENARIOS: readonly CanaryScenario[] = [
  {
    id: 'idle',
    tool: 'claude',
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
    tool: 'claude',
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
    tool: 'claude',
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
    tool: 'claude',
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
    tool: 'claude',
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
  {
    id: 'permission-hook-allow',
    tool: 'claude',
    title: 'Auto-Yes v2 — PermissionRequest answered allow',
    intent:
      'The load-bearing upstream contract of Auto-Yes v2 (#1724): a `decision.behavior: "allow"` reply makes Claude run the tool with NO dialog. Nothing in this repository can observe that, and if a Claude release stopped honouring it every Auto-Yes v2 session would silently fall back to sitting on a dialog. The probe file on disk is what separates "ran without asking" from "has not asked yet".',
    cost: 'small',
    timeoutMs: 180_000,
    pollIntervalMs: 2_000,
    expectation: expectPermissionAllowedByHook,
    // The two scenarios are each other's mutant, which is the sharpest wrong
    // answer available: it says "the receiver returned the opposite verdict".
    // It is also unsatisfiable rather than merely unlikely — this scenario's
    // probe file cannot match the deny pattern — so `--mutate` is deterministic
    // here instead of racing the moment the poll lands on.
    mutantExpectation: expectPermissionDialogAfterNoDecision,
    hooks: { policy: HOOK_SCENARIO_POLICY, probeFile: HOOK_ALLOW_PROBE_FILE },
    async drive(driver): Promise<void> {
      await driver.submitPrompt(
        `Use the Write tool to create a file named ${HOOK_ALLOW_PROBE_FILE} in the current directory containing the single word hello. Do not do anything else.`
      );
    },
  },
  {
    id: 'permission-hook-no-decision',
    tool: 'claude',
    title: 'Auto-Yes v2 — denyPatterns hit, no decision, dialog for a human',
    intent:
      "The other half of #1724's contract, and the one with no live record before this: an empty reply must land back in the ordinary approval flow. `denyPatterns` escalates rather than denies, so the human must get the dialog AND `capture --json` must be able to say why — a worker that stalls here with no reason published is the failure #1684 set out to remove.",
    cost: 'small',
    timeoutMs: 180_000,
    pollIntervalMs: 2_000,
    expectation: expectPermissionDialogAfterNoDecision,
    mutantExpectation: expectPermissionAllowedByHook,
    hooks: { policy: HOOK_SCENARIO_POLICY, probeFile: HOOK_DENY_PROBE_FILE },
    resetKeys: ['Escape'],
    async drive(driver): Promise<void> {
      await driver.submitPrompt(
        `Use the Write tool to create a file named ${HOOK_DENY_PROBE_FILE} in the current directory containing the single word hello. Do not do anything else.`
      );
    },
  },
];

/** Every scenario, claude's first then opencode's, in declaration order. */
export const SCENARIOS: readonly CanaryScenario[] = [...CLAUDE_SCENARIOS, ...OPENCODE_SCENARIOS];

/** The scenarios that drive `tool`, in declaration order. */
export function scenariosForTool(tool: CanaryToolId): CanaryScenario[] {
  return SCENARIOS.filter(scenario => scenario.tool === tool);
}

/**
 * Look up scenarios by id, preserving declaration order.
 *
 * `tool` narrows the pool BEFORE `--only` / `--skip` are applied, and an id
 * belonging to another tool is rejected with that tool's name rather than as
 * "unknown" — `--only opencode-idle` without `--tool opencode` would otherwise
 * read as a typo when it is really a missing flag (Issue #2050).
 */
export function selectScenarios(
  only: readonly string[],
  skip: readonly string[],
  tool?: CanaryToolId
): CanaryScenario[] {
  const pool = tool ? scenariosForTool(tool) : SCENARIOS;
  const known = new Set(pool.map(scenario => scenario.id));
  for (const id of [...only, ...skip]) {
    if (known.has(id)) continue;
    const otherTool = SCENARIOS.find(scenario => scenario.id === id);
    if (otherTool) {
      throw new Error(
        `canary: scenario "${id}" belongs to --tool ${otherTool.tool}, not ${tool}. ` +
          `Re-run with --tool ${otherTool.tool}.`
      );
    }
    throw new Error(`canary: unknown scenario "${id}". Known ids: ${[...known].join(', ')}`);
  }
  return pool.filter(scenario => {
    if (only.length > 0 && !only.includes(scenario.id)) return false;
    return !skip.includes(scenario.id);
  });
}

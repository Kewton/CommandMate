/**
 * Per-tool profiles for the detection canary (Issue #2050).
 *
 * #1727 built the canary around one CLI. Everything that was `claude` by
 * assumption — the executable, the pane geometry, how many rows a capture asks
 * for, the raw row that says "the composer accepts input", the first-run
 * screens that eat keystrokes, the launch flags — lives here instead, one
 * record per tool, so a second tool is a table entry rather than a fork of
 * `session.ts`.
 *
 * Two rules the entries below obey, because breaking either makes a green run
 * mean nothing:
 *
 * 1. **The readiness row must not be the row the detector reads.** Startup is
 *    gated on {@link CanaryToolProfile.composerReadyPattern}, and the scenario
 *    that follows asserts what `detectSessionStatus` concludes. If the two were
 *    the same row, the idle scenario would be asserting something the gate had
 *    already guaranteed — the vacuous green #1727 wrote `COMPOSER_READY_PATTERN`
 *    to avoid. claude uses its `? for shortcuts` footer; opencode uses the
 *    `tab agents  ctrl+p commands` footer, NOT the `Ask anything...` placeholder
 *    branch E of `tools/opencode/detect.ts` anchors on.
 * 2. **Geometry is production's, per tool.** claude's pane is
 *    `TUI_PANE_WIDTH x TUI_PANE_HEIGHT` (200x1000); opencode's is
 *    `80 x OPENCODE_PANE_HEIGHT` (80x200), the geometry `launchSession()` in
 *    `src/lib/cli-tools/opencode.ts` resizes every real session to. The
 *    `verifiedAgainst` stamps record exactly these two shapes, and a fixture
 *    captured at any other width is not a capture of what production sees.
 */

import { OPENCODE_PANE_HEIGHT, TMUX_HISTORY_LIMIT, TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '@/config/tmux-pane-config';
import { STARTUP_OVERLAYS } from './expectations';
import { OPENCODE_STARTUP_OVERLAYS } from './opencode-expectations';
import { CANARY_CAPTURE_LINES } from './probe';
import type { CanaryToolId, StartupOverlay } from './types';

export type { CanaryToolId };

/** Everything the harness needs to know about one tool. */
export interface CanaryToolProfile {
  /** Catalog / `CLIToolType` id. Also the value handed to the detectors. */
  readonly id: CanaryToolId;
  /** Human-readable name, used in the fixture header and the run summary. */
  readonly label: string;
  /** Name resolved on `PATH` by the preflight. */
  readonly executable: string;
  /** Pane columns — production's, for this tool. */
  readonly paneWidth: number;
  /** Pane rows — production's, for this tool. */
  readonly paneHeight: number;
  /** Rows a capture asks tmux for (`capture-pane -S -<n>`). */
  readonly captureLines: number;
  /** `history-limit` for the session's pane. */
  readonly historyLimit: number;
  /**
   * Raw-text row that says the composer accepts input. Deliberately NOT a
   * detector call, and deliberately not a row any status branch reads — see
   * rule 1 in the module doc.
   */
  readonly composerReadyPattern: RegExp;
  /** First-run screens that eat keystrokes ahead of the composer. */
  readonly startupOverlays: readonly StartupOverlay[];
  /** How long to wait for the composer before giving up. */
  readonly startupTimeoutMs: number;
  /** Whether `hooks`-carrying scenarios can run for this tool. */
  readonly supportsHookScenarios: boolean;
  /**
   * The shell command tmux runs.
   *
   * @param baseCommand - the shell-quoted executable, or (claude only) the
   *   production launcher's `'<claude>' --settings '<file>'`
   */
  buildLaunchCommand(baseCommand: string): string;
}

/**
 * Permission mode every claude canary session is launched in (Issue #1847).
 *
 * Claude Code 2.1.236 made **auto mode** the default — "Claude checks each tool
 * call for risky actions … runs the ones it assesses as lower-risk, and blocks
 * the rest" — and in that mode the approval dialog this canary exists to read
 * is simply not drawn. Measured on 2026-08-20 (2.1.236 / 2.1.237): in one
 * throwaway HOME the FIRST `claude` still starts in manual mode and every later
 * one migrates itself to auto, so a multi-scenario run silently stopped
 * measuring what a single-scenario run measured. It surfaced as a startup
 * timeout rather than as a wrong verdict, because the ready footer differs
 * between the modes (`? for shortcuts` only exists in manual).
 *
 * Pinned on the command line rather than in the throwaway `settings.json`:
 * writing `permissions.defaultMode` there puts an interactive
 * "Make auto mode your default permission mode?" choice in front of the
 * composer instead (measured — `defaultMode: "default"` is no longer one of the
 * modes `--permission-mode` accepts). This is a statement about the canary,
 * not about what a CommandMate session gets.
 */
export const CANARY_PERMISSION_MODE = 'manual';

/**
 * Idle footer Claude renders when the composer is accepting input
 * ("? for shortcuts").
 */
const CLAUDE_COMPOSER_READY_PATTERN = /\?\s+for\s+shortcuts/i;

/**
 * opencode's first-idle footer: `tab agents  ctrl+p commands`.
 *
 * Measured on 1.18.22 at 80x200 — opencode prints this row on the boot screen
 * and stops printing it once a turn has run, when the footer becomes the
 * context/cost cell (`8.9K (1%) · $…`) instead. That makes it a startup gate and
 * nothing else, which is what rule 1 in the module doc asks for: the composer
 * placeholder `┃  Ask anything...` IS branch E's rule, so gating readiness on it
 * would leave the `opencode-idle` scenario asserting the gate's own condition.
 */
const OPENCODE_COMPOSER_READY_PATTERN = /tab agents\s+ctrl\+p commands/;

export const CLAUDE_TOOL_PROFILE: CanaryToolProfile = {
  id: 'claude',
  label: 'Claude Code',
  executable: 'claude',
  paneWidth: TUI_PANE_WIDTH,
  paneHeight: TUI_PANE_HEIGHT,
  // `STATUS_DETECTION_CAPTURE_LINES` / `REDUCED_CAPTURE_LINES` are both 1000.
  captureLines: CANARY_CAPTURE_LINES,
  historyLimit: TMUX_HISTORY_LIMIT,
  composerReadyPattern: CLAUDE_COMPOSER_READY_PATTERN,
  startupOverlays: STARTUP_OVERLAYS,
  startupTimeoutMs: 90_000,
  supportsHookScenarios: true,
  buildLaunchCommand: (baseCommand: string): string =>
    `${baseCommand} --permission-mode ${CANARY_PERMISSION_MODE}`,
};

export const OPENCODE_TOOL_PROFILE: CanaryToolProfile = {
  id: 'opencode',
  label: 'opencode',
  executable: 'opencode',
  // 80 columns: `launchSession()` resizes every production opencode pane to
  // exactly this, and OPENCODE_PERMISSION_PATTERN's docblock records that the
  // dialog's `enter confirm` hint is truncated to `enter con` at this width.
  paneWidth: 80,
  paneHeight: OPENCODE_PANE_HEIGHT,
  // opencode runs in the alternate screen, so a capture can never return more
  // than the pane's own rows — the same number `resolveCaptureSpec('opencode')`
  // asks for on the production status path.
  captureLines: OPENCODE_PANE_HEIGHT,
  historyLimit: TMUX_HISTORY_LIMIT,
  composerReadyPattern: OPENCODE_COMPOSER_READY_PATTERN,
  startupOverlays: OPENCODE_STARTUP_OVERLAYS,
  // opencode reached the composer at ~3.6 s on an idle machine and at 24.1 s
  // under six parallel agents (#1908, `opencode-launch-boot-11821.ts`).
  startupTimeoutMs: 90_000,
  // opencode's AgentEventSource has no `PermissionRequest` equivalent to
  // adjudicate, so `--mutate-verdict` has nothing to mutate here.
  supportsHookScenarios: false,
  buildLaunchCommand: (baseCommand: string): string => baseCommand,
};

/** Tool id → profile. */
export const CANARY_TOOL_PROFILES: Readonly<Record<CanaryToolId, CanaryToolProfile>> = {
  claude: CLAUDE_TOOL_PROFILE,
  opencode: OPENCODE_TOOL_PROFILE,
};

/** Tool ids the canary accepts, in declaration order. */
export const CANARY_TOOL_IDS = Object.keys(CANARY_TOOL_PROFILES) as CanaryToolId[];

/** The tool a run drives when `--tool` is not given. */
export const DEFAULT_CANARY_TOOL: CanaryToolId = 'claude';

/** Look a profile up, rejecting an unknown id with the list of known ones. */
export function resolveToolProfile(toolId: string): CanaryToolProfile {
  const profile = CANARY_TOOL_PROFILES[toolId as CanaryToolId];
  if (!profile) {
    throw new Error(`canary: unknown tool "${toolId}". Known tools: ${CANARY_TOOL_IDS.join(', ')}`);
  }
  return profile;
}

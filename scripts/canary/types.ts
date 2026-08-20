/**
 * Shared types for the detection canary (Issue #1727).
 *
 * The canary drives a REAL `claude` TUI inside a throwaway tmux session and
 * feeds the captured frames to the same detection entry points production uses
 * (`detectSessionStatus` for the sidebar/status path, `detectPrompt` for the
 * Auto-Yes path). A new Claude Code release that changes the TUI therefore
 * turns the canary red before a user hits it.
 */

import type { StatusDetectionResult } from '@/lib/detection/status-detector';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import type { AutoYesPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';

/**
 * One hook delivery the canary's receiver answered (Issue #1847).
 *
 * The canary has no CommandMate server, so this log is what the run can say
 * about the wire: which hooks Claude actually posted, and what was written back
 * to the one it blocks on. `behavior` / `reason` are the adjudicator's, i.e.
 * `resolvePermissionRequest`'s own verdict — not the canary's paraphrase of it.
 */
export interface HookDelivery {
  /** Native hook event name, e.g. `PermissionRequest`, `Stop`, `session_start`. */
  eventName: string;
  /** `tool_name`, for the events that name one. */
  toolName: string | null;
  /** Epoch ms the receiver answered. */
  at: number;
  /** `PermissionRequest` only: `'allow'`, or null for no-decision. */
  behavior: 'allow' | null;
  /** `PermissionRequest` only: `PermissionDecisionReason`. */
  reason: string | null;
  /**
   * Whether `--mutate-verdict` flipped the answer that was actually sent. The
   * verdict above stays the adjudicator's, so a mutated run stays legible.
   */
  inverted: boolean;
}

/**
 * What the structured layer knows, sampled at the same instant as the frame
 * (Issue #1847).
 *
 * Every field is read from the module `buildCurrentOutput` reads it from, so a
 * scenario asserting on it is asserting on what `capture --json` would publish:
 * `structuredEvents` comes from `agent-event-state` + `resolvePromptWaiting`,
 * and `lastSuppression` from `auto-yes-suppression-state`. Nothing here is a
 * canary-local re-implementation.
 */
export interface HookObservation {
  /** Deliveries so far, in arrival order. */
  deliveries: readonly HookDelivery[];
  /** `capture --json`'s `structuredEvents`, minus the fields no scenario reads. */
  structuredEvents: {
    lastEventType: string | null;
    lastEventAt: number | null;
    lastEventDetail: string | null;
    promptWaitingSince: number | null;
    promptWaitingSource: string | null;
  };
  /** `capture --json`'s `autoYes.lastSuppression`. */
  lastSuppression: AutoYesPolicySuppression | null;
  /**
   * Whether the scenario's probe file is on disk.
   *
   * The proof that the tool actually RAN, as opposed to the dialog merely not
   * being visible in the captured window — which is the same screen a session
   * with no hooks at all shows while Claude is still thinking.
   */
  probeFileWritten: boolean;
}

/**
 * Hook wiring for a scenario that adjudicates real `PermissionRequest`s
 * (Issue #1847).
 *
 * A scenario carrying this is launched as `claude --settings <file>` with the
 * settings written by the PRODUCTION generator (`buildAgentHookSettings`),
 * pointed at the canary's own receiver on an ephemeral loopback port.
 */
export interface HookScenarioSetup {
  /**
   * The contract `autoYes` block the adjudicator judges this session's requests
   * against, or null for "no contract governs this instance".
   *
   * Supplied rather than read from SQLite: the canary is not a server and has
   * no task row. See `PermissionDecisionDeps` in
   * `src/lib/hooks/permission-decision-service.ts`.
   */
  policy: AutoYesPolicy | null;
  /** File the probe prompt asks Claude to write, relative to the working directory. */
  probeFile: string;
}

/**
 * One captured frame plus both detection verdicts.
 *
 * `frame` is the raw `capture-pane -p -e` output (ANSI escape sequences kept),
 * exactly what production hands to the detectors — the detectors strip ANSI
 * themselves, and stripping it here would hide an escape-sequence regression.
 */
export interface Observation {
  /** Raw capture-pane output, ANSI sequences included. */
  frame: string;
  /** Result of the status path: `detectSessionStatus(frame, 'claude')`. */
  status: StatusDetectionResult;
  /**
   * Result of the Auto-Yes path, which calls `detectPrompt()` DIRECTLY rather
   * than going through status-detector (see `src/lib/auto-yes-poller.ts`).
   * A prompt the status path rejects can still be auto-answered here, so both
   * verdicts must be asserted independently.
   */
  autoYes: PromptDetectionResult;
  /**
   * The structured layer's view of the same instant (Issue #1847).
   *
   * Present only for scenarios that declare {@link CanaryScenario.hooks}. The
   * expectations that read it treat `undefined` as a failed match rather than
   * as "nothing to check", so a scenario whose receiver was never wired up goes
   * red instead of passing vacuously.
   */
  hooks?: HookObservation;
}

/** A named, pure predicate over an {@link Observation}. */
export interface Expectation {
  /** Human-readable description printed in the run summary. */
  label: string;
  matches(observation: Observation): boolean;
}

/** Keys sent verbatim to `tmux send-keys` (key names, not literal text). */
export type SpecialKey = 'Enter' | 'Escape' | 'Down' | 'Up' | 'Tab' | 'C-c';

/** Live session handle handed to a scenario's `drive()` step. */
export interface ScenarioDriver {
  /** Type literal text into the composer (no submit). */
  sendText(text: string): Promise<void>;
  /** Send a single key by name. */
  sendKey(key: SpecialKey): Promise<void>;
  /** Type text, then submit it as a prompt. */
  submitPrompt(text: string): Promise<void>;
  /** Capture the pane and run both detectors on it. */
  observe(): Promise<Observation>;
  /** Poll until `predicate` holds; rejects with {@link ObservationTimeoutError}. */
  waitFor(
    predicate: (observation: Observation) => boolean,
    options: { timeoutMs: number; pollIntervalMs: number; label: string }
  ): Promise<Observation>;
  /** Emit a progress line (suppressed in `--json` mode). */
  log(message: string): void;
}

/** Raised when a scenario never reached its expected state within the timeout. */
export class ObservationTimeoutError extends Error {
  constructor(
    message: string,
    readonly lastObservation: Observation | null,
    readonly waitedMs: number
  ) {
    super(message);
    this.name = 'ObservationTimeoutError';
  }
}

/** Static definition of one canary scenario. */
export interface CanaryScenario {
  /** Stable id, used by `--only` / `--skip` and as the fixture filename. */
  id: string;
  /** One-line title for `--list` and the summary table. */
  title: string;
  /** What the scenario proves, in prose (printed by `--list`). */
  intent: string;
  /** Rough token cost of one run, for the docs and `--list`. */
  cost: 'none' | 'small';
  /** How long to wait for the expected state after `drive()` returns. */
  timeoutMs: number;
  /** Capture interval while waiting. */
  pollIntervalMs: number;
  /** The assertion this scenario makes. */
  expectation: Expectation;
  /**
   * A plausible but WRONG expectation, used by `--mutate` to prove the harness
   * is not vacuous: with mutants in place every scenario must go red.
   */
  mutantExpectation: Expectation;
  /**
   * Hook wiring, for the Auto-Yes v2 verdict scenarios (Issue #1847).
   *
   * Present means: launch this session with the production-generated hook
   * settings pointed at the canary's receiver, adjudicate its
   * `PermissionRequest`s with {@link HookScenarioSetup.policy}, and fill
   * {@link Observation.hooks} on every capture. Absent means the scenario runs
   * a bare `claude`, exactly as the five #1727 scenarios do.
   */
  hooks?: HookScenarioSetup;
  /** Drives the fresh session into the target state. */
  drive(driver: ScenarioDriver): Promise<void>;
  /** Best-effort keys to leave the state before the session is torn down. */
  resetKeys?: SpecialKey[];
}

/** Outcome of one scenario run. */
export interface ScenarioResult {
  scenarioId: string;
  title: string;
  /**
   * `blocked` means the scenario never reached its state because of an upstream
   * fault (API overload, rate limit) — deliberately distinct from `failed`, which
   * is the detection-regression signal the canary exists to raise.
   */
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  /** Expectation label that was evaluated (mutant label under `--mutate`). */
  expectationLabel: string;
  durationMs: number;
  /** Detector verdicts of the frame the scenario ended on, if any. */
  observed?: {
    status: string;
    reason: string;
    hasActivePrompt: boolean;
    autoYesIsPrompt: boolean;
    promptType?: string;
  };
  /** Failure explanation (timeout, drive error, ...). */
  error?: string;
  /** Paths of the fixture artifacts written for this scenario. */
  fixtures?: { module: string; raw: string };
}

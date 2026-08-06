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

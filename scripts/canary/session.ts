/**
 * Live throwaway agent session for the detection canary (Issue #1727; per-tool
 * since #2050).
 *
 * Each scenario gets its own tmux session on the canary's private socket and its
 * own working directory, so a frame can never contain another scenario's
 * scrollback. Geometry, history-limit, the readiness row and the launch flags
 * all come from the scenario's {@link CanaryToolProfile}, which reads them from
 * the production constants — a 200x1000 pane for claude (where the interactive
 * block sits at the top and the task panel at the very bottom, the layout Issue
 * #1708 turns on) and an 80x200 pane for opencode (the geometry
 * `launchSession()` resizes every real opencode session to).
 */

import { stripAnsi } from '@/lib/detection/ansi';
import { findStartupOverlay, findUpstreamFault } from './expectations';
import { probeFrame } from './probe';
import type { CanaryToolProfile } from './tool-profiles';
import type { PrivateTmuxServer } from './tmux-private';
import {
  ObservationTimeoutError,
  type HookObservation,
  type Observation,
  type ScenarioDriver,
  type SpecialKey,
} from './types';

const STARTUP_POLL_INTERVAL_MS = 1_000;
/** Pause between typing text and pressing Enter, so the TUI has composed it. */
const SUBMIT_SETTLE_MS = 700;
/** How long to wait for a submitted prompt to visibly leave the composer. */
const SUBMIT_CONFIRM_TIMEOUT_MS = 6_000;

/**
 * Extra waiting time granted while Claude is visibly retrying an upstream
 * failure. Capped so a persistent outage still ends the run.
 */
export const UPSTREAM_FAULT_GRACE_MS = 180_000;

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface CanarySessionOptions {
  tmux: PrivateTmuxServer;
  /** Geometry, readiness row, startup overlays and launch flags for this tool. */
  profile: CanaryToolProfile;
  sessionName: string;
  workingDirectory: string;
  isolatedHome: string;
  /** Absolute path of the tool's executable, as resolved by the preflight. */
  toolBinary: string;
  log: (message: string) => void;
  startupTimeoutMs?: number;
  /**
   * Shell command tmux runs instead of the bare binary (Issue #1847).
   *
   * For a hook scenario this is `'<claude>' --settings '<file>'`, produced by
   * the PRODUCTION launcher `buildClaudeLaunchCommand` — the same string a real
   * CommandMate session is started with, so the settings file the run observes
   * against is the one users get. Defaults to {@link toolBinary}.
   */
  launchCommand?: string;
  /**
   * Fills {@link Observation.hooks} on every capture (Issue #1847).
   *
   * Called with the frame's own detection verdicts, because the structured
   * layer's release rule needs the scraper's answer for the SAME frame — see
   * `CanaryHookReceiver.observe`. Omitted for the scenarios that run a bare
   * CLI, which leaves `hooks` undefined.
   */
  observeHooks?: (scraper: Observation) => HookObservation;
}

/** A running agent CLI in a throwaway tmux session. */
export class CanarySession implements ScenarioDriver {
  private constructor(
    private readonly options: CanarySessionOptions,
    /** HOME as the tmux session itself reports it — proof the transfer worked. */
    readonly reportedHome: string
  ) {}

  /**
   * Start the tool, verify HOME isolation actually took effect, then wait until
   * the composer accepts input (dismissing first-run overlays on the way).
   */
  static async start(options: CanarySessionOptions): Promise<CanarySession> {
    const { tmux, profile, sessionName, workingDirectory, isolatedHome, toolBinary } = options;

    await tmux.newSession({
      sessionName,
      workingDirectory,
      command: options.launchCommand ?? toolBinary,
      width: profile.paneWidth,
      height: profile.paneHeight,
      historyLimit: profile.historyLimit,
      env: { HOME: isolatedHome, TERM: 'xterm-256color', CM_DETECTION_CANARY: '1' },
    });

    // Assert the isolation transferred INTO the session rather than trusting the
    // spawn call: production tmux code takes no socket argument and reads HOME
    // from its environment, so a silently-ignored override is the failure mode
    // that would let a scenario write the developer's real settings.
    const reportedHome = await tmux.showEnvironment(sessionName, 'HOME');
    if (reportedHome !== isolatedHome) {
      await tmux.killSession(sessionName);
      throw new Error(
        `canary: HOME did not transfer into tmux session ${sessionName} ` +
          `(expected ${isolatedHome}, session reports ${reportedHome ?? '<unset>'}). Refusing to run.`
      );
    }
    const session = new CanarySession(options, reportedHome);
    await session.waitForComposer(options.startupTimeoutMs ?? profile.startupTimeoutMs);
    return session;
  }

  log(message: string): void {
    this.options.log(message);
  }

  /** Capture the pane exactly as production does, then run both detectors. */
  async observe(): Promise<Observation> {
    const frame = await this.options.tmux.capturePane(
      this.options.sessionName,
      this.options.profile.captureLines
    );
    const observation = probeFrame(frame, this.options.profile.id);
    const observeHooks = this.options.observeHooks;
    // Sampled here rather than in the scenario so `waitFor`, `submitPrompt` and
    // the fixture writer all see the same paired frame + structured state — and
    // so the structured layer's release rule runs on every poll, as it does in
    // `buildCurrentOutput`.
    return observeHooks ? { ...observation, hooks: observeHooks(observation) } : observation;
  }

  async sendText(text: string): Promise<void> {
    await this.options.tmux.sendLiteral(this.options.sessionName, text);
  }

  async sendKey(key: SpecialKey): Promise<void> {
    await this.options.tmux.sendKey(this.options.sessionName, key);
  }

  /**
   * Type a prompt and submit it.
   *
   * The Enter is sent as a separate key AFTER a settle delay: sending text and
   * `C-m` in one call races the TUI's composer and the newline can be absorbed
   * into the input instead of submitting. If the frame has not changed shortly
   * after Enter, one more Enter is sent — a swallowed submit otherwise shows up
   * as a detection timeout, which reads like a detector regression.
   */
  async submitPrompt(text: string): Promise<void> {
    await this.sendText(text);
    await sleep(SUBMIT_SETTLE_MS);

    const before = stripAnsi((await this.observe()).frame);
    await this.sendKey('Enter');

    const deadline = Date.now() + SUBMIT_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(700);
      const after = stripAnsi((await this.observe()).frame);
      if (after !== before) return;
    }
    this.log('  prompt did not visibly submit — re-sending Enter');
    await this.sendKey('Enter');
  }

  /**
   * Poll until `predicate` holds. Rejects with {@link ObservationTimeoutError}.
   *
   * Time spent showing a self-retrying upstream banner ("529 Overloaded ·
   * Retrying in 34s") does not count against the timeout, up to
   * {@link UPSTREAM_FAULT_GRACE_MS}: Anthropic capacity says nothing about the
   * detection layer, and letting it consume the budget turns the canary into a
   * capacity alarm.
   */
  async waitFor(
    predicate: (observation: Observation) => boolean,
    options: { timeoutMs: number; pollIntervalMs: number; label: string }
  ): Promise<Observation> {
    const startedAt = Date.now();
    let graceMs = 0;
    let faultReported = false;
    let last: Observation | null = null;

    for (;;) {
      last = await this.observe();
      if (predicate(last)) return last;

      const fault = findUpstreamFault(last.frame);
      if (fault?.selfRetrying && graceMs < UPSTREAM_FAULT_GRACE_MS) {
        graceMs = Math.min(UPSTREAM_FAULT_GRACE_MS, graceMs + options.pollIntervalMs);
        if (!faultReported) {
          this.log(`  upstream fault visible (${fault.id}) — pausing the scenario clock while Claude retries`);
          faultReported = true;
        }
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= options.timeoutMs + graceMs) {
        throw new ObservationTimeoutError(
          `timed out after ${Math.round(elapsed / 1000)}s waiting for: ${options.label}`,
          last,
          elapsed
        );
      }
      await sleep(options.pollIntervalMs);
    }
  }

  /**
   * Wait until the composer is usable, dismissing first-run overlays.
   *
   * Claude's trust / theme / release-notes screens (and opencode's
   * `Connect a provider` chooser) eat the first keystrokes, so a prompt sent too
   * early silently lands in the wrong place (a known trap in this Issue).
   * Seeding the tool's config normally prevents them; this loop is the defense
   * for the version that adds a new one. The row it waits for is
   * `profile.composerReadyPattern`, which is deliberately NOT a row any status
   * branch reads — see rule 1 in `tool-profiles.ts`.
   */
  private async waitForComposer(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const dismissAttempts = new Map<string, number>();
    const maxDismissAttempts = 3;

    for (;;) {
      const observation = await this.observe();
      const clean = stripAnsi(observation.frame);

      const overlay = findStartupOverlay(observation.frame, this.options.profile.startupOverlays);
      if (overlay) {
        if (overlay.dismissKey === null) {
          throw new Error(`canary: cannot start a session — ${overlay.fatalHint ?? overlay.id}`);
        }
        const attempts = dismissAttempts.get(overlay.id) ?? 0;
        if (attempts >= maxDismissAttempts) {
          throw new Error(
            `canary: startup overlay "${overlay.id}" did not close after ${maxDismissAttempts} ` +
              `${overlay.dismissKey} presses — the Claude first-run flow changed shape (see docs/qa/detection-canary.md)`
          );
        }
        this.log(`  dismissing startup overlay: ${overlay.id}`);
        dismissAttempts.set(overlay.id, attempts + 1);
        await this.sendKey(overlay.dismissKey);
        await sleep(2_000);
        continue;
      }

      if (this.options.profile.composerReadyPattern.test(clean)) return;

      if (Date.now() >= deadline) {
        throw new ObservationTimeoutError(
          `canary: ${this.options.profile.executable} did not reach an input-ready composer within ${Math.round(timeoutMs / 1000)}s`,
          observation,
          timeoutMs
        );
      }
      await sleep(STARTUP_POLL_INTERVAL_MS);
    }
  }

  /** Best-effort: leave the current modal state, then kill the session. */
  async close(resetKeys: readonly SpecialKey[] = []): Promise<void> {
    for (const key of resetKeys) {
      await this.sendKey(key).catch(() => undefined);
      await sleep(500);
    }
    await this.options.tmux.killSession(this.options.sessionName);
  }
}

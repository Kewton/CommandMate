/**
 * Sending a picker command until the picker opens (Issue #3803).
 *
 * The probe takes the first frame that stops changing for the idle screen
 * (`waitForStartup`, scripts/agent-health/probe-tool.ts). codex 0.163 paints
 * its composer before its own start-up is over and answers `/model` sent then
 * with "Model selection is disabled until startup completes." instead of the
 * picker, so one send judged a tool that was only still starting. A refusal of
 * that kind (`notReady`, new since the send) sends the command again; anything
 * else keeps the one-send behaviour of Issue #3053.
 */

import { countMatches } from './screen-checks';

/** The part of a picker screen (scripts/agent-health/tool-table.ts) this reads. */
export interface PickerOpenScreen {
  opened: RegExp;
  notReady?: RegExp;
}

export type PickerAttemptState = 'opened' | 'not-ready' | 'pending';

/** Occurrences before a send, so text already in the scrollback is not read as new. */
export interface PickerBaseline {
  opened: number;
  notReady: number;
}

export function pickerBaseline(clean: string, screen: PickerOpenScreen): PickerBaseline {
  return {
    opened: countMatches(clean, screen.opened),
    notReady: screen.notReady ? countMatches(clean, screen.notReady) : 0,
  };
}

/** What the frame says about the last send: the picker is up, it was refused as too early, or neither yet. */
export function readPickerAttempt(clean: string, screen: PickerOpenScreen, baseline: PickerBaseline): PickerAttemptState {
  if (countMatches(clean, screen.opened) > baseline.opened) return 'opened';
  if (screen.notReady && countMatches(clean, screen.notReady) > baseline.notReady) return 'not-ready';
  return 'pending';
}

export interface PickerOpenDeps {
  /** The ANSI-stripped frame now. */
  look: () => Promise<string>;
  /** Types the command and presses Enter exactly once. */
  send: () => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
}

export interface PickerOpenLimits {
  /** How long one send may take to open the picker. */
  appearMs: number;
  /** From the first send: how long "not ready" refusals are sent again. */
  startupMs: number;
  /** Pause after a refusal before the next send. */
  retryMs: number;
  pollMs: number;
}

export interface PickerOpenOutcome {
  opened: boolean;
  /** Sends answered with the tool's "not ready" text. */
  refusals: number;
}

export async function sendUntilPickerOpens(
  screen: PickerOpenScreen,
  deps: PickerOpenDeps,
  limits: PickerOpenLimits
): Promise<PickerOpenOutcome> {
  const startupLimit = deps.now() + limits.startupMs;
  let baseline = pickerBaseline(await deps.look(), screen);
  let refusals = 0;
  for (;;) {
    await deps.send();
    const limit = deps.now() + limits.appearMs;
    let state: PickerAttemptState = 'pending';
    while (deps.now() < limit) {
      await deps.sleep(limits.pollMs);
      const clean = await deps.look();
      state = readPickerAttempt(clean, screen, baseline);
      if (state !== 'pending') {
        baseline = pickerBaseline(clean, screen);
        break;
      }
    }
    if (state === 'opened') return { opened: true, refusals };
    if (state !== 'not-ready') return { opened: false, refusals };
    refusals++;
    if (deps.now() + limits.retryMs >= startupLimit) return { opened: false, refusals };
    await deps.sleep(limits.retryMs);
    baseline = pickerBaseline(await deps.look(), screen);
  }
}

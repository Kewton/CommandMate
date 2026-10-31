/**
 * The keys a launch types into its pane, in one writer's turn (Issue #3981).
 *
 * #3975 put gemini's and claude's launch lines under the instance input lock;
 * the other seven launch sites, and claude's `unset CLAUDECODE` before its
 * line, still typed with no lock, so a send holding the composer could have
 * them land in the middle of its body, paste or Enter. Every launch now types
 * through {@link typeLaunchLines}: one `exclusive` turn for all of its lines
 * (R2 of `session-launch-flight`), joined when the launcher already holds the
 * lock (codex relaunching inside a send). The init polls and readiness waits
 * that follow stay outside (#3975), so a send waiting for the prompt is never
 * held behind them.
 *
 * @module lib/cli-tools/launch-keys
 */

import { sendKeys } from '../tmux/tmux';
import { withInstanceInputLock } from '../session/instance-input-lock';

/**
 * One step of a launch's keys: a line typed with Enter, or a step that types
 * its own keys (claude's environment sanitize) in the same turn.
 */
export type LaunchKeyStep = string | (() => Promise<void>);

/**
 * Type `steps` into `sessionName` as one `exclusive` writer, in order.
 *
 * @param sessionName - tmux session name
 * @param steps - Lines (typed with Enter) and self-typing steps
 * @throws Whatever `withInstanceInputLock` throws when not admitted; nothing was typed then
 */
export async function typeLaunchLines(sessionName: string, steps: readonly LaunchKeyStep[]): Promise<void> {
  await withInstanceInputLock(sessionName, async () => {
    for (const step of steps) {
      if (typeof step === 'string') {
        await sendKeys(sessionName, step, true);
      } else {
        await step();
      }
    }
  });
}

/**
 * Expectations for the Auto-Yes v2 verdict scenarios (Issue #1847).
 *
 * Kept out of `expectations.ts` because they answer a different question from
 * everything in it. Those predicates read the FRAME and ask what the detection
 * layer concludes about it; these read {@link HookObservation} and ask what the
 * hook receiver's verdict did to the session — the screen is only half of each
 * assertion here.
 *
 * ## Why each of these needs both halves
 *
 * The screen a session shows when Auto-Yes v2 allows a tool call is the screen
 * it would show if the feature did not exist and Claude simply had not reached
 * the dialog yet. The screen it shows on a no-decision is *literally* the
 * feature-does-not-exist screen — that is the design (#1721 D5). So neither
 * scenario can be asserted from the pane alone without being satisfiable by a
 * receiver that answered nothing at all:
 *
 *  - the allow case pairs "no dialog" with **the probe file on disk**, which is
 *    the only thing that distinguishes "it ran without asking" from "it has not
 *    asked yet";
 *  - the no-decision case pairs "dialog on screen" with **the adjudicator's own
 *    recorded verdict** and the `lastSuppression` row `capture --json`
 *    publishes, which is what distinguishes "we declined to decide" from "the
 *    receiver was never reached".
 *
 * `--mutate-verdict` is the proof that this is not merely asserted but works:
 * it flips the reply the receiver sends and both scenarios must go red.
 *
 * Every predicate treats a missing {@link Observation.hooks} as a failed match,
 * never as "nothing to check", so a scenario whose receiver was not wired up
 * fails instead of passing vacuously.
 */

import { STATUS_REASON } from '@/lib/detection/status-detector';
import { PERMISSION_REQUEST_PROMPT_TYPE } from '@/lib/hooks/permission-decision-service';
import { PERMISSION_REQUEST_EVENT_NAME } from '@/lib/hooks/permission-request-payload';
import type { Expectation, HookDelivery, Observation } from './types';

/** Deliveries of the one hook whose response body is obeyed. */
export function permissionRequestDeliveries(observation: Observation): readonly HookDelivery[] {
  return (observation.hooks?.deliveries ?? []).filter(
    delivery => delivery.eventName === PERMISSION_REQUEST_EVENT_NAME
  );
}

/**
 * Scenario 6 — Auto-Yes v2 answered `allow` and the tool ran without a dialog.
 *
 * Four independent statements, because dropping any one of them leaves the
 * predicate satisfiable by a session that never got a verdict:
 *
 *  1. the adjudicator returned `allow` for reason `auto-yes` (not, say, for an
 *     unreadable payload — that reason is a no-decision and would be a bug);
 *  2. the probe file exists, i.e. the Write tool really executed;
 *  3. neither detection path sees a prompt on the pane, and the structured layer
 *     never reported one either (`promptWaitingSince` stays null — a
 *     `Notification(permission_prompt)` would have set it);
 *  4. lifecycle hooks are arriving at all (`lastEventType`), so a receiver that
 *     answered the permission hook and nothing else is not mistaken for a
 *     healthy injection.
 */
export const expectPermissionAllowedByHook: Expectation = {
  label:
    'PermissionRequest answered allow (reason=auto-yes) → probe file written, no dialog on either ' +
    'detection path, structuredEvents reports no prompt',
  matches: (o: Observation): boolean => {
    const hooks = o.hooks;
    if (!hooks) return false;
    const allowed = permissionRequestDeliveries(o).some(
      delivery => delivery.behavior === 'allow' && delivery.reason === 'auto-yes'
    );
    return (
      allowed &&
      hooks.probeFileWritten &&
      hooks.structuredEvents.lastEventType !== null &&
      hooks.structuredEvents.promptWaitingSince === null &&
      o.status.hasActivePrompt === false &&
      o.autoYes.isPrompt === false
    );
  },
};

/**
 * Scenario 7 — a contract `denyPatterns` hit produced a no-decision, and the
 * dialog appeared for a human.
 *
 * This is the half of #1724 that had no live record at all: the user guide
 * states that `denyPatterns` escalates rather than denies — "ダイアログが出て
 * 手動で応答できる" — and nothing had ever watched it happen.
 *
 * `promptWaitingSource` is deliberately not pinned to `permission-request`.
 * The no-decision opens the record with that source, and Claude's
 * `Notification(permission_prompt)` arrives a few seconds later and *upgrades*
 * it to `notification` (`openPromptWaiting` in `agent-event-state`), so which
 * one a poll observes depends only on where the poll landed. What matters — and
 * what is asserted — is that the structured layer knows a human is blocked, and
 * that the verdict which caused it is the adjudicator's own.
 */
export const expectPermissionDialogAfterNoDecision: Expectation = {
  label:
    'PermissionRequest suppressed by deny-pattern → dialog on both detection paths, ' +
    'autoYes.lastSuppression carries the reason, probe file NOT written',
  matches: (o: Observation): boolean => {
    const hooks = o.hooks;
    if (!hooks) return false;
    const suppressed = permissionRequestDeliveries(o).some(
      delivery => delivery.behavior === null && delivery.reason === 'policy-suppressed'
    );
    return (
      suppressed &&
      hooks.lastSuppression?.reason === 'deny-pattern' &&
      hooks.lastSuppression.promptType === PERMISSION_REQUEST_PROMPT_TYPE &&
      typeof hooks.lastSuppression.pattern === 'string' &&
      hooks.structuredEvents.promptWaitingSince !== null &&
      hooks.probeFileWritten === false &&
      o.status.status === 'waiting' &&
      o.status.reason === STATUS_REASON.PROMPT_DETECTED &&
      o.status.hasActivePrompt === true &&
      o.autoYes.isPrompt === true
    );
  },
};

/**
 * The judgments and the write of arming Auto-Yes, cut out of `POST /auto-yes`
 * (Issue #4466 PR1a).
 *
 * All synchronous, and all given the target the route resolved (`worktreeId`,
 * `cliToolId`, `instanceId`): {@link findAutoYesToolPolicyRefusal} and
 * {@link findAutoYesRelayRefusal} only read; {@link armAutoYesGrant} is what the route ran
 * after its last await — the shutdown, `onlyIfOff`, the relay judged again, then the grant
 * and its poller — with nothing in between. The route maps what they answer to the
 * responses it always gave, in the same order.
 *
 * @module app/api/worktrees/[id]/auto-yes/auto-yes-arm
 */

import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import {
  getAutoYesState,
  setAutoYesEnabled,
  startAutoYesPolling,
  type AutoYesState,
} from '@/lib/polling/auto-yes-manager';
import { isAutoYesShutdownStarted } from '@/lib/auto-yes-state';
import type { AutoYesAnswerMode } from '@/types/auto-yes-answer-mode';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AutoYesDuration } from '@/config/auto-yes-config';
import { createLogger } from '@/lib/logger';
import { decideToolPolicy, TOOL_POLICY_DENIED_MESSAGE } from '@/lib/tool-policy/policy';
import { readUsageDeclaration } from '@/lib/tool-policy/declaration';
import { findWriteToolPolicyRefusal, type WriteToolPolicyRequest } from '../send/write-tool-policy';

const logger = createLogger('api/auto-yes');

/** The target a grant is judged and written for (the route's strict resolution). */
export interface AutoYesArmTarget {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
}

/** The tool policy's 409 for arming Auto-Yes on `target`, or null when allowed. Reads only. */
export function findAutoYesToolPolicyRefusal(target: AutoYesArmTarget): NextResponse | null {
  const { worktreeId: id, cliToolId, instanceId } = target;
  const policy = decideToolPolicy({
    tool: cliToolId,
    operation: 'auto-yes',
    origin: 'legacy',
    declaration: readUsageDeclaration(),
  });
  if (!policy.allowed) {
    logger.warn('tool-policy-denied:', {
      worktreeId: id,
      cliToolId,
      instanceId,
      code: policy.code,
      reason: policy.reason,
    });
    return NextResponse.json(
      {
        code: policy.code,
        error: TOOL_POLICY_DENIED_MESSAGE,
        reason: policy.reason,
        links: policy.links,
        cliToolId,
        instanceId,
      },
      { status: 409 }
    );
  }
  return null;
}

/**
 * The relay's rule 0 for a grant on `target` (`send --auto-yes --reply-to`): the 409, or
 * null when allowed or the body named no `replyTo`. Reads only.
 */
export function findAutoYesRelayRefusal(
  db: Database.Database,
  target: AutoYesArmTarget,
  relayRequest: WriteToolPolicyRequest | null,
): NextResponse | null {
  if (relayRequest === null) return null;
  const refusal = findWriteToolPolicyRefusal(db, {
    worktreeId: target.worktreeId,
    tool: target.cliToolId,
    instanceId: target.instanceId,
    request: relayRequest,
  });
  return refusal ? NextResponse.json(refusal, { status: 409 }) : null;
}

/** What {@link armAutoYesGrant} did. */
export type AutoYesArmOutcome =
  | { kind: 'shutting-down' }
  | { kind: 'already-on'; live: AutoYesState }
  | { kind: 'relay-refused'; response: NextResponse }
  | { kind: 'armed'; state: AutoYesState; pollingStarted: boolean };

/**
 * Judge and arm the grant on `target`, with nothing in between: the shutdown, `onlyIfOff`,
 * the relay judged again (`relayRefusal`), then the grant and its poller. Synchronous.
 */
export function armAutoYesGrant(
  target: AutoYesArmTarget,
  input: {
    onlyIfOff: boolean;
    duration: AutoYesDuration;
    stopPattern: string | undefined;
    answerMode: AutoYesAnswerMode | undefined;
    relayRefusal: () => NextResponse | null;
  },
): AutoYesArmOutcome {
  const { worktreeId: id, cliToolId, instanceId } = target;
  const { duration, stopPattern, answerMode } = input;
  // Issue #3730: the ownership check above awaits, and a shutdown can
  // begin meanwhile. The shutdown has already written down which grants it
  // released, so a grant added now would be one the next process never
  // explains — and a poller started now would run into the teardown.
  // Checked here, after the last await and before the synchronous write.
  if (isAutoYesShutdownStarted()) {
    return { kind: 'shutting-down' };
  }

  // Issue #4132: read here, after the last await, so nothing lands between this
  // and the write below.
  if (input.onlyIfOff) {
    const live = getAutoYesState(id, cliToolId, instanceId);
    if (live?.enabled) {
      return { kind: 'already-on', live };
    }
  }

  // I3' of #4449: the relay judged again on the roster as it is now, with no await
  // between this and the grant written below (the grant's own target stays the one
  // resolved above).
  const relayRefusedLast = input.relayRefusal();
  if (relayRefusedLast) return { kind: 'relay-refused', response: relayRefusedLast };

  // Issue #3863: the mode is passed only when the request named one, so an
  // enable without it reaches the setter exactly as before (which keeps a
  // live grant's mode and starts a new one at `recommended`).
  const state = answerMode === undefined
    ? setAutoYesEnabled(id, cliToolId, true, duration, stopPattern, instanceId)
    : setAutoYesEnabled(id, cliToolId, true, duration, stopPattern, instanceId, answerMode);
  const result = startAutoYesPolling(id, cliToolId, instanceId);
  if (!result.started) {
    logger.warn('polling-not-started:');
  }
  return { kind: 'armed', state, pollingStarted: result.started };
}

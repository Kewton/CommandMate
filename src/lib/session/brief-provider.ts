/**
 * The port a session brief comes in through (Issue #4274, D1 of #4224).
 *
 * D1 detects conversation boundaries and puts a brief in front of the first send
 * after one, once. What the brief SAYS is #4223's (C): it implements this port, and
 * D2 (#4224) connects it: {@link getBriefProvider} answers C's `MEM_BRIEF_PORT`
 * (design `docs/design/brief-injection-d2-4224.md` §4). With mode `off` (the default)
 * or `injectOnStart` false nothing is asked of it. {@link EMPTY_BRIEF_PROVIDER} answers
 * an empty body, and a send briefed by it carries exactly the bytes it did before
 * (design `docs/design/session-boundary-brief-4274.md` §5).
 *
 * The send service never trusts the answer: the size, the line count and the mode
 * are checked again (`session-brief.ts`), and a failure leaves the brief off — the
 * operator's body is sent either way.
 *
 * @module lib/session/brief-provider
 */

import type { MemMode } from '@/types/mem';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { MEM_BRIEF_PORT } from '@/lib/brief/provider';

export type BriefBoundaryKind = 'launch' | 'auto_restart' | 'reset' | 'resume' | 'explicit';

/** What a brief is asked for. */
export interface BriefRequest {
  /** Whose boundary. */
  target: {
    worktreeId: string;
    /** Issue #4224: the worktree's lifetime this request was read for (W1); the provider builds for it only. */
    worktreeIncarnation: string;
    cliToolId: CLIToolType;
    /** `instanceId ?? cliToolId`. */
    instanceId: string;
    instanceIncarnation: string | null;
    /** Issue #4224: whether the instance was on the roster when the request was read (its entrance). */
    instanceOnRoster: boolean;
  };
  /** The membership `withMemTarget` settled (never asked for `off`). */
  membership: {
    repositoryId: string;
    readRepositoryIds: string[];
    /** null with a detached HEAD. */
    branch: string | null;
    detached: boolean;
    mode: Exclude<MemMode, 'off'>;
  };
  boundary: {
    id: string;
    kind: BriefBoundaryKind;
    late: boolean;
    /** Epoch ms, server time. */
    openedAt: number;
  };
  /** UTF-8 bytes and lines of the final text. Asked only when `maxBytes >= minBytes`. */
  budget: { maxBytes: number; maxLines: number };
  now: number;
}

/** What a provider answers. */
export interface BriefResult {
  /** Typed as is, in front of the operator's body. `''` attaches nothing. */
  body: string;
  /** The notice ids actually in `body` (D2 hands them to #4222's receipt). */
  includedNoticeIds: string[];
  /** The mode it built for; one that differs from the request's is not attached. */
  mode: Exclude<MemMode, 'off'>;
  /**
   * Issue #4224 (design §7.4): with an empty `body`, why nothing could be made. `over_limit`:
   * a line the brief must carry does not fit the budget — the send records it and goes on.
   */
  skipReason?: 'over_limit';
}

/** How a claimed brief ended, as told to {@link BriefProvider.settle}. */
export type BriefDeliveryOutcome = 'sent' | 'not_sent' | 'unknown' | 'discarded';

export interface BriefProvider {
  readonly id: string;
  /** Below this budget no brief can be made (C's minimum). */
  readonly minBytes: number;
  /** The budget asked for when there is room (C's default). */
  readonly defaultBytes: number;
  /**
   * Build the text. May evaluate `close_when` (#4222's D8 close, the same write as
   * `list` / `check`); never records a receipt, a reservation or "read". What it
   * builds may be thrown away (not claimed, settings changed, over budget).
   */
  build(request: BriefRequest): Promise<BriefResult> | BriefResult;
  /**
   * Called once in the claim's synchronous stretch, under the input lock (2nd
   * review D): reserve the notices per #4222's contract and answer the text rebuilt
   * from those reserved, or null to attach nothing (the boundary stays pending).
   * Must be synchronous. A provider without it is used as built.
   */
  reserve?(claim: {
    boundaryId: string;
    claimToken: string;
    includedNoticeIds: string[];
    body: string;
  }): { body: string; includedNoticeIds: string[] } | null;
  /**
   * Called once after the delivery settled, outside the lock. `included` are the
   * ids of the text actually typed only for `sent`; `discarded` also returns what
   * `reserve` took. D1 never fails a send for a throw here.
   */
  settle?(delivery: {
    boundaryId: string;
    outcome: BriefDeliveryOutcome;
    includedNoticeIds: string[];
  }): void | Promise<void>;
}

/** D1's provider: nothing to say, so nothing is attached (the boundary is still used up). */
export const EMPTY_BRIEF_PROVIDER: BriefProvider = {
  id: 'empty',
  minBytes: 0,
  defaultBytes: 0,
  build: (request) => ({ body: '', includedNoticeIds: [], mode: request.membership.mode }),
};

let override: BriefProvider | null = null;

/** The provider sends are briefed by: C's (#4223), connected by D2 (#4224, design §4.1). */
export function getBriefProvider(): BriefProvider {
  return override ?? MEM_BRIEF_PORT;
}

/** Swap the provider in a test; null restores the default (C's). */
export function setBriefProviderForTest(provider: BriefProvider | null): void {
  override = provider;
}

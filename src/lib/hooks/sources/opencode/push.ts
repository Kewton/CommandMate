/**
 * The phone notifications opencode's own stream raises (Issue #2045).
 *
 * ## Why opencode gets a producer of its own
 *
 * Every other tool's prompt notification is raised from the *waiting edge*
 * (`push/waiting-push-notifier`), and that edge is only ever observed by a
 * status probe — `worktree-status-helper` on a list/detail API read, or
 * `response-checker` while the poller happens to be running. So for the five
 * scraped tools a wait notifies when somebody is looking, and the phone is the
 * consolation prize for when nobody is.
 *
 * opencode is the one tool where that trade is unaffordable. Measured on
 * 1.18.22 (`docs/design/opencode-server-live-verification.md` §17): after
 * `question.asked` the session stays `busy` and **no `session.idle` ever
 * arrives** — `GET /session/status` still read `{"…":{"type":"busy"}}` twenty
 * seconds later, with nothing else on the stream. Nothing in this repository
 * answers an opencode question either (`grep` for a question-reply producer
 * finds only the manual `respond` path), so Auto-Yes cannot end the wait and
 * the turn is stopped until a human acts. A notification that waits for a page
 * view is exactly the wrong shape for that.
 *
 * ## Closed to opencode, on purpose
 *
 * The Issue's constraint, and it is the reason this is a module in
 * `sources/opencode/` rather than a hook on `notification` / `error` in the
 * shared receiver: the other five tools reach `recordAgentEvent` through
 * `POST /api/hooks/agent-event`, which does not import this file, so their push
 * counts cannot move. `tests/unit/hooks/sources/opencode-push-2045.test.ts`
 * pins that as a test rather than as a comment.
 *
 * ## One notification per wait, across both producers
 *
 * The question push carries `waitingSince: <the frame's receivedAt>`, which
 * routes it through `shouldSendWaitingPush` — the episode-scoped guard #1790
 * built — keyed `${worktreeId}::${instanceId}`. That is the *same* key and the
 * *same* value the waiting edge will later use, because
 * `worktree-status-helper` opens the episode with
 * `structuredSince = peekPromptWaiting().structured?.at`, and that `at` is the
 * `receivedAt` this module is handed. So the status probe's own notification is
 * suppressed as a repeat of this one, and the reader gets one card per wait
 * however many producers saw it. Passing no `waitingSince` would have fallen
 * back to the 30 s content hash, whose key is a different map — two cards.
 *
 * ## Nothing here throws
 *
 * The same contract `./ingest` declares, for the same reason: a notification is
 * advisory and must never cost the event that raised it.
 *
 * @module lib/hooks/sources/opencode/push
 */

import { createLogger } from '@/lib/logger';
import type { AgentInstanceRef } from '../types';

const logger = createLogger('lib/hooks/sources/opencode/push');

/**
 * How much of the question / error text the notification body carries.
 *
 * 80, from the Issue, and narrower than `push-sender`'s own 120 default: this
 * is applied at the producer so the truncation is the one the Issue specifies
 * rather than whatever the fan-out happens to default to. The re-truncation
 * inside `buildPushPayload` is then a no-op.
 */
export const OPENCODE_PUSH_EXCERPT_LENGTH = 80;

/**
 * The one `session.error` name that is not a failure (measured, §17).
 *
 * `MessageAbortedError` is what a `POST /session/:id/abort` produces — the user
 * pressed Escape, or CommandMate itself aborted the turn. Pushing "the agent
 * stopped with an error" for a stop the reader just asked for would report
 * their own action back to them as a fault. §5.3.2 of the design note already
 * establishes the same reading for `wait`.
 *
 * The other seven names in opencode 1.18.22's `session.error` union
 * (`APIError`, `ProviderAuthError`, `UnknownError`, `MessageOutputLengthError`,
 * `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError`) all
 * describe a turn that ended badly, so the default is to notify: a name nobody
 * enumerated here fails towards telling the human rather than towards silence.
 */
export const OPENCODE_INTERRUPT_ERROR_NAME = 'MessageAbortedError';

/**
 * The worktree's display name, for the notification title.
 *
 * Dynamic import for the reason `./ingest` documents at length: `../registry`
 * statically imports `./source`, so anything this module's graph reaches
 * eagerly would put `better-sqlite3` (and, through `@/lib/push`, `web-push`)
 * into every import of `@/lib/hooks/sources`.
 *
 * Falls back to the id rather than dropping the notification — the same call
 * `push/waiting-push-notifier` makes, and for the same reason: a database that
 * cannot answer is a reason to send a less readable title, not a reason to
 * leave the human waiting in silence.
 */
async function resolveWorktreeName(worktreeId: string): Promise<string> {
  try {
    const [{ getDbInstance }, { getWorktreeById }] = await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db'),
    ]);
    return getWorktreeById(getDbInstance(), worktreeId)?.name ?? worktreeId;
  } catch {
    return worktreeId;
  }
}

/**
 * `@/lib/push/push-sender`, reached by module path rather than through the
 * `@/lib/push` barrel.
 *
 * The barrel's own comments give the reason: a suite that stubs `@/lib/push`
 * wholesale would leave the very path it is guarding undefined. Both existing
 * producers (`waiting-push-notifier`, `failure-push-notifier`) import the
 * concrete module for that reason, and this one follows.
 */
async function loadPushSender(): Promise<typeof import('@/lib/push/push-sender')> {
  return import('@/lib/push/push-sender');
}

/** Where a notification is going, resolved once per send. */
interface PushSubject {
  worktreeId: string;
  worktreeName: string;
  instanceId: string;
}

async function subjectOf(target: AgentInstanceRef, instanceId: string): Promise<PushSubject> {
  return {
    worktreeId: target.worktreeId,
    worktreeName: await resolveWorktreeName(target.worktreeId),
    instanceId,
  };
}

/**
 * Tell the human's phone that opencode is asking them a question.
 *
 * `kind: 'prompt'` — this is the acting bucket, and it is the truthful one: the
 * turn does not continue until the question is answered.
 *
 * `waitingKind: 'prompt'` rather than `'menu'`, deliberately. The kind decides
 * whether the body says "waiting for your reply" or "needs attention in the
 * terminal", and an opencode question is answerable *from the app*: it arrives
 * as structured choices (`recordAskUserQuestion` in `./ingest`), so the picker
 * and `commandmate respond <n>` can both close it without a terminal.
 *
 * @param question - The question text, or null when the frame carried none
 * @param askedAt - The frame's `receivedAt`; the wait's identity (see module doc)
 */
export async function notifyOpencodeQuestionPush(
  target: AgentInstanceRef,
  instanceId: string,
  question: string | null,
  askedAt: number
): Promise<void> {
  try {
    const { notifyPushSubscribers, buildExcerpt } = await loadPushSender();
    const subject = await subjectOf(target, instanceId);

    await notifyPushSubscribers(
      {
        ...subject,
        kind: 'prompt',
        // Both halves of "worktree / instance" the Issue asks for: the title is
        // `${worktreeName} (${agentName})`, so naming the instance here is what
        // tells two panes of the same worktree apart.
        agentName: instanceId,
        waitingKind: 'prompt',
        waitingSince: askedAt,
        excerpt: buildExcerpt(question ?? undefined, OPENCODE_PUSH_EXCERPT_LENGTH),
      },
      // The frame's clock, not a fresh reading: `askedAt` is when the human
      // became blocked, and it is what the card's timestamp should say.
      askedAt
    );

    logger.info('opencode-question-push-sent', {
      worktreeId: target.worktreeId,
      instanceId,
      hasQuestion: question !== null,
    });
  } catch (error) {
    logger.warn('opencode-question-push-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Tell the human's phone that a turn ended in an error.
 *
 * `kind: 'failure'` (#2000), which shares the "you need to act" toggle with
 * `prompt` but keeps its own Service Worker `tag`, so a failure never replaces
 * the card for a question that is still open.
 *
 * The dedup content is the {@link FailureContext.signature}, not the excerpt:
 * `error.data.message` for a retrying provider carries changing detail, while
 * `(session, error name)` is the incident. Two *different* errors in one
 * session therefore both notify, and a repeat of one does not.
 *
 * @param errorName - `properties.error.name`, or null
 * @param message - The human-facing line `./ingest` already extracted
 *   (`error.data.message`, falling back to `error.name`)
 * @param sessionId - The opencode session the error belongs to, for the signature
 */
export async function notifyOpencodeSessionErrorPush(
  target: AgentInstanceRef,
  instanceId: string,
  errorName: string | null,
  message: string | null,
  sessionId: string | null,
  at: number
): Promise<void> {
  if (errorName === OPENCODE_INTERRUPT_ERROR_NAME) {
    logger.info('opencode-error-push-skipped-interrupt', {
      worktreeId: target.worktreeId,
      instanceId,
      errorName,
    });
    return;
  }

  try {
    const { notifyPushSubscribers, buildExcerpt } = await loadPushSender();
    const subject = await subjectOf(target, instanceId);

    await notifyPushSubscribers(
      {
        ...subject,
        kind: 'failure',
        agentName: instanceId,
        excerpt: buildExcerpt(message ?? undefined, OPENCODE_PUSH_EXCERPT_LENGTH),
        failure: {
          reason: 'agent-session-error',
          signature: `opencode:session-error:${sessionId ?? 'unknown'}:${errorName ?? 'unknown'}`,
        },
      },
      at
    );

    logger.info('opencode-error-push-sent', {
      worktreeId: target.worktreeId,
      instanceId,
      errorName,
      sessionId,
    });
  } catch (error) {
    logger.warn('opencode-error-push-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Tell the human that a newer opencode exists.
 *
 * `kind: 'completion'` — the informational bucket. Nothing is blocked and
 * nobody has to act, so this must not ride the toggle a waiting prompt and a
 * failed run share; a reader who opted out of "for information" opted out of
 * this too.
 *
 * The excerpt is the version rather than prose. It is never rendered — the body
 * comes from `updateAvailable` — but `passesDedup` hashes it, so carrying the
 * version there makes the fan-out's own 30 s guard key off *which* update this
 * is instead of off an empty string it would share with a bare completion.
 *
 * Suppressing repeats is the caller's job (`./subscription` remembers the
 * versions it has announced), not this module's: the frame carries **no
 * `sessionID`** — measured against 1.18.22's `GET /doc`, where
 * `EventInstallationUpdate-available.properties` is `{ version }` and nothing
 * else — so "once per session" can only be answered by whoever holds the
 * connection.
 */
export async function notifyOpencodeUpdateAvailablePush(
  target: AgentInstanceRef,
  instanceId: string,
  version: string,
  at: number
): Promise<void> {
  try {
    const { notifyPushSubscribers } = await loadPushSender();
    const subject = await subjectOf(target, instanceId);

    await notifyPushSubscribers(
      {
        ...subject,
        kind: 'completion',
        agentName: instanceId,
        excerpt: version,
        updateAvailable: { agent: instanceId, version },
      },
      at
    );

    logger.info('opencode-update-push-sent', {
      worktreeId: target.worktreeId,
      instanceId,
      version,
    });
  } catch (error) {
    logger.warn('opencode-update-push-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

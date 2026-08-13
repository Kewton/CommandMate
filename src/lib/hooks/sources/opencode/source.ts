/**
 * opencode as an {@link AgentEventSource} — the first pull implementation
 * (Issue #1763, Epic #1720 Phase 4-5).
 *
 * Five tools push into `POST /api/hooks/agent-event`; this one is subscribed
 * to. #1758 established that the difference is real and not cosmetic, and
 * #1759 built the interface so it could be expressed without a special case.
 * What is here is that expression: `definePullEventSource`, the measured
 * values, and nothing shaped like `if (tool === 'opencode')` anywhere above it.
 *
 * ## Why each declared value is what it is
 *
 * - **`noDecision: 'blocks'`** — measured, and the single most consequential
 *   line in the file. An approval left unanswered for **10 minutes 19 seconds**
 *   was still pending, with no timeout event and no fall-through (#1758 §5.5.3).
 *   The TUI dialog and the REST request are not two stages, they are the same
 *   pending object seen twice, so "abstaining costs a dialog" — true on Claude,
 *   codex and copilot — is false here: abstaining costs the session. Callers
 *   read this through `describeAbstain()` and owe the operator a visible signal.
 * - **`configScope: 'none'`** — nothing is written anywhere. No settings file,
 *   no hooks entry, no change to `~/.config/opencode/opencode.jsonc`. The whole
 *   integration is a `--port` argument and a subscription.
 * - **`decisionTimeoutSeconds: null`** — the honest encoding of "waits forever".
 *   Not zero, which would read as "answer instantly or lose the chance", and not
 *   a large number, which would read as a deadline that exists.
 * - **`supportedEvents`** — seven words, but two of them mean less than their
 *   name suggests. `session_end` fires only for an explicit
 *   `DELETE /session/:id`; the TUI's `/exit` emits nothing at all, so process
 *   death stays tmux's question (§5.6.4). And `notification` is a bundle of
 *   three unrelated events with no `idle_prompt` member — opencode never reports
 *   "the agent is sitting at the composer".
 *
 * ## What is deliberately not done
 *
 * `GET /session` is never called to enumerate "this instance's sessions". It
 * returns sessions belonging to *other processes* that share the same `HOME`
 * and project directory, because a session belongs to `opencode.db` rather than
 * to a server (§5.6.3). Instance identity is (worktree, tool, instance) and the
 * port, exactly as it is for every other tool.
 *
 * @module lib/hooks/sources/opencode/source
 */

import { AGENT_EVENT_TYPES } from '@/lib/hooks/agent-event-types';
import { isHookInjectionEnabled, shellQuote } from '@/lib/hooks/hook-settings-generator';
import { createLogger } from '@/lib/logger';
import { definePullEventSource } from '../define-source';
import type {
  AgentEventSource,
  AgentInstanceRef,
  AgentLaunchPlan,
  PendingDecision,
  SourceLiveness,
  Verdict,
} from '../types';
import {
  fetchOpencodePendingPermissions,
  fetchOpencodePendingQuestions,
  fetchOpencodeActivity,
  replyOpencodePermission,
  replyOpencodeQuestion,
  OPENCODE_SERVER_HOST,
  type OpencodePermissionReply,
} from './client';
import { OPENCODE_MAPPERS } from './mappers';
import {
  parseOpencodePermissionRequest,
  parseOpencodeQuestion,
  toOpencodePendingPermission,
  toOpencodePendingQuestion,
} from './payloads';
import { getAssignedOpencodePort } from './ports';
import {
  getOpencodeLiveness,
  openOpencodeSubscription,
} from './subscription';
import { OPENCODE_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/opencode/source');

/**
 * The `AGENT_EVENT_TYPES` members opencode can produce.
 *
 * All seven, but see the module comment for what two of them actually mean.
 * Spelled from the shared constant so a new word added to the vocabulary is a
 * compile-time decision here rather than a silent omission.
 */
const OPENCODE_SUPPORTED_EVENTS = AGENT_EVENT_TYPES;

/**
 * Map a verdict onto opencode's three-valued reply, or null when it has none.
 *
 * `abstain` is null and that is the point: there is no wire value for "no
 * opinion", because there is no request to answer — the reply is a fresh POST
 * that simply does not happen. What that costs is {@link
 * AgentEventSource.noDecision}, not something this function can express.
 */
export function toOpencodePermissionReply(verdict: Verdict): OpencodePermissionReply | null {
  switch (verdict.kind) {
    case 'allowOnce':
      return 'once';
    case 'allowAlways':
      return 'always';
    case 'deny':
      return 'reject';
    case 'answer':
    case 'abstain':
      return null;
  }
}

/**
 * Send a verdict over its own connection (C2).
 *
 * The caller — `answerPendingDecision` — does not know this is an HTTP call
 * rather than a response body, and must not.
 */
async function decideOpencode(
  target: AgentInstanceRef,
  decision: PendingDecision,
  verdict: Verdict
): Promise<void> {
  const instanceId = target.instanceId ?? target.cliToolId;

  if (verdict.kind === 'abstain') {
    // Nothing is sent, and on this tool that is an action rather than the
    // absence of one: the agent waits with no timeout. Logged here as well as
    // at the receiver, because this is the layer that knows the decision was
    // addressed to a source whose silence blocks.
    logger.warn('opencode-verdict-abstained', {
      worktreeId: target.worktreeId,
      instanceId,
      decisionId: decision.id,
      consequence: 'the agent waits indefinitely; nothing else will unblock it',
    });
    return;
  }

  const port = getAssignedOpencodePort(target);
  if (port === null) {
    logger.warn('opencode-verdict-undeliverable-no-port', {
      worktreeId: target.worktreeId,
      instanceId,
      decisionId: decision.id,
    });
    return;
  }

  if (decision.kind === 'question') {
    if (verdict.kind !== 'answer') {
      // An approval verdict cannot answer a question — and unlike Claude, where
      // allowing the `AskUserQuestion` permission still leaves the picker up,
      // there is nothing here that would make it harmless.
      logger.info('opencode-question-not-answerable', {
        worktreeId: target.worktreeId,
        instanceId,
        decisionId: decision.id,
        verdict: verdict.kind,
      });
      return;
    }
    const delivered = await replyOpencodeQuestion(port, decision.id, verdict.answers);
    logger.info('opencode-question-replied', {
      worktreeId: target.worktreeId,
      instanceId,
      decisionId: decision.id,
      delivered,
    });
    return;
  }

  const reply = toOpencodePermissionReply(verdict);
  if (reply === null) return;

  const delivered = await replyOpencodePermission(
    port,
    decision.id,
    reply,
    verdict.kind === 'deny' ? verdict.message : undefined
  );
  logger.info('opencode-permission-replied', {
    worktreeId: target.worktreeId,
    instanceId,
    decisionId: decision.id,
    reply,
    delivered,
  });
}

/** Re-read what is waiting on a human (C7). */
async function listOpencodePending(target: AgentInstanceRef): Promise<PendingDecision[]> {
  const port = getAssignedOpencodePort(target);
  if (port === null) return [];

  const askedAt = Date.now();
  const [permissions, questions] = await Promise.all([
    fetchOpencodePendingPermissions(port),
    fetchOpencodePendingQuestions(port),
  ]);

  const pending: PendingDecision[] = [];
  for (const entry of permissions) {
    const decision = toOpencodePendingPermission(entry, askedAt);
    if (decision) pending.push(decision);
  }
  for (const entry of questions) {
    const decision = toOpencodePendingQuestion(entry, askedAt);
    if (decision) pending.push(decision);
  }
  return pending;
}

/**
 * Ask whether the conversation is working (C7).
 *
 * Note what `busy` includes: a session blocked on an approval reads `busy`
 * (#1758 §5.3.1), because from the server's point of view the turn has not
 * ended. This answers "is the turn over", never "is a human needed".
 */
async function probeOpencodeActivity(
  target: AgentInstanceRef
): Promise<'busy' | 'idle' | null> {
  const port = getAssignedOpencodePort(target);
  if (port === null) return null;
  return fetchOpencodeActivity(port);
}

/**
 * The command that starts opencode for one instance (S3 / S4 / S5).
 *
 * The whole of the launch change #1763 makes. #1758 §5.1.2 measured that the
 * plain TUI serves the same API `opencode serve` does when given `--port`, so
 * there is no second process to start, no pid to track and no orphan to reap —
 * the server's lifetime is the pane's.
 *
 * Falls back to the bare executable — the pre-#1763 command, byte for byte —
 * whenever there is no port to pass: `CM_AGENT_HOOKS_INJECT=0`, an exhausted
 * range, or a caller that did not allocate one. A session that starts without
 * structured events is the status quo; a session that fails to start is not.
 *
 * `--hostname` is passed explicitly even though `127.0.0.1` is the default,
 * because the default is the security property: the server is unauthenticated,
 * and `--mdns` (never passed) would move it to `0.0.0.0` (#1758 §5.8.3).
 */
export function prepareOpencodeLaunch(
  target: AgentInstanceRef,
  executablePath: string
): AgentLaunchPlan {
  if (!isHookInjectionEnabled()) {
    return { command: executablePath, settingsPath: null };
  }
  const port = getAssignedOpencodePort(target);
  if (port === null) {
    return { command: executablePath, settingsPath: null };
  }
  return {
    command: `${shellQuote(executablePath)} --port ${port} --hostname ${OPENCODE_SERVER_HOST}`,
    // Nothing is written to disk. `configScope: 'none'` says the same thing to
    // a caller that asks the capabilities instead of the plan.
    settingsPath: null,
  };
}

/**
 * opencode as an event source.
 *
 * Registered in `../registry`. Nothing outside this directory imports it by
 * name; callers ask the registry for the tool they are holding.
 */
export const opencodeAgentEventSource: AgentEventSource = definePullEventSource({
  cliToolId: OPENCODE_CLI_TOOL_ID,

  // #1758 §5.5.3. Not a default, not an assumption — a stopwatch.
  noDecision: { kind: 'blocks' },

  capabilities: {
    supportedEvents: OPENCODE_SUPPORTED_EVENTS,
    configScope: 'none',
    decisionTimeoutSeconds: null,
  },

  // C4. Predicates, not a name table: see ./mappers.
  mappers: OPENCODE_MAPPERS,

  // The envelope names the event in `type`; `hook_event_name` does not exist.
  nativeEventNameFields: ['type'],
  // Flat lookup cannot reach `properties.sessionID`; the rules fill it in.
  conversationIdFields: [],

  parsePermissionRequest: parseOpencodePermissionRequest,
  parseQuestion: parseOpencodeQuestion,

  // Self-reference resolves at call time, which is after this const is bound.
  subscribe: (target, onEvent) =>
    openOpencodeSubscription(target, onEvent, (raw) =>
      opencodeAgentEventSource.normalizeEvent(raw)
    ),

  decide: decideOpencode,
  listPending: listOpencodePending,
  probeActivity: probeOpencodeActivity,
  liveness: (target: AgentInstanceRef): SourceLiveness => getOpencodeLiveness(target),

  prepareLaunch: prepareOpencodeLaunch,
});

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
 *   integration is a `--port` argument and a subscription. **#2053 re-opened
 *   this and closed it again.** Handing opencode an inline config through
 *   `OPENCODE_CONFIG_CONTENT` writes no file, and a `permission` `deny` declared
 *   that way really does make the dialog disappear — measured on 1.18.22,
 *   `permission.asked` went from 1 to 0 and the turn completed on `session.idle`
 *   instead of blocking forever. It is still not adopted, because inline config
 *   is the *top* of a five-layer precedence chain and therefore overwrites the
 *   operator's own `permission` rules with no warning and no way for
 *   CommandMate to see the collision: a string `permission.bash: "ask"` is
 *   replaced wholesale by an injected object (silently downgrading every
 *   unnamed command to the built-in `allow`), and within a merged object the
 *   rule order beats pattern specificity, so a broad glob from CommandMate
 *   defeats an exact-match rule the operator wrote. A malformed injection also
 *   makes the TUI refuse to start and exit 0 with no port, while `serve` keeps
 *   answering `GET /global/health` with `healthy` — a failure `liveness()`
 *   reports as alive. Ruling and the alternative (read the merged `permission`
 *   instead of writing one): `docs/design/agent-event-source-interface.md` §3.4;
 *   measurements: `docs/design/opencode-server-live-verification.md` §26.
 *   Pinned by `tests/unit/hooks/sources/opencode-config-scope-2053.test.ts`.
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
import { recordDecisionDelivery } from '../pending-decisions';
import type {
  AgentEventSource,
  AgentInstanceRef,
  AgentLaunchContext,
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
import { frameModel, opencodeEventIdentity, OPENCODE_MAPPERS } from './mappers';
import {
  parseOpencodePermissionRequest,
  parseOpencodeQuestion,
  toOpencodePendingPermission,
  toOpencodePendingQuestion,
} from './payloads';
import {
  getOpencodeLaunchSettings,
  opencodeLaunchArguments,
} from './launch-settings';
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
    recordDecisionDelivery(target, decision.id, { delivered: false, reason: 'abstained' });
    return;
  }

  const port = getAssignedOpencodePort(target);
  if (port === null) {
    logger.warn('opencode-verdict-undeliverable-no-port', {
      worktreeId: target.worktreeId,
      instanceId,
      decisionId: decision.id,
    });
    recordDecisionDelivery(target, decision.id, { delivered: false, reason: 'no-port' });
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
      recordDecisionDelivery(target, decision.id, {
        delivered: false,
        reason: 'question-needs-answer-verdict',
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
    recordDecisionDelivery(target, decision.id, {
      delivered,
      reason: delivered ? 'question-reply' : 'question-reply-failed',
    });
    return;
  }

  const reply = toOpencodePermissionReply(verdict);
  if (reply === null) {
    recordDecisionDelivery(target, decision.id, { delivered: false, reason: 'no-wire-value' });
    return;
  }

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
  // Issue #1898: the fact the ingest needs in order to decide whether a human
  // is still blocked. `replyOpencodePermission` answers false for a refused
  // connection, and a verdict that never arrived leaves the dialog on screen.
  recordDecisionDelivery(target, decision.id, {
    delivered,
    reason: delivered ? `permission-reply:${reply}` : 'permission-reply-failed',
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
 *
 * The aggregate of the same `GET /session/status` the reconnect reads per
 * session (#1900). Callers outside this directory hold an instance rather than
 * a session id, so aggregating is the only answer they can use; the reconnect
 * needs the detail, and both go through one reader in `./client`.
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
 *
 * ## The instance's own settings (Issue #2048)
 *
 * `--agent` and `--model` are appended when the operator configured them for
 * this instance, from the cache `loadOpencodeLaunchSettings` filled immediately
 * before this call — see `./launch-settings` for why the value arrives that way
 * rather than on {@link AgentLaunchContext}. **The `bare` branches above stay
 * bare**: a launch with no port has no structured events, and an operator who
 * turned hook injection off asked for the pre-#1763 command line, so neither is
 * a place to start adding flags.
 *
 * The variant is deliberately not here. `--variant` is a flag of `opencode run`
 * and **not** of the TUI (measured on 1.18.22,
 * `docs/design/opencode-server-live-verification.md` §20.3): passing it makes
 * opencode print its usage and exit, leaving an empty pane. It travels on the
 * prompt instead, which is the one channel measured to apply it.
 */
export function prepareOpencodeLaunch({
  target,
  executablePath,
}: AgentLaunchContext): AgentLaunchPlan {
  // `env` is empty for every branch: opencode is the one source that needs no
  // correlation variable at all, because CommandMate holds the connection and
  // therefore already knows which instance the frames belong to (#1846).
  const bare: AgentLaunchPlan = { command: executablePath, settingsPath: null, env: {} };
  if (!isHookInjectionEnabled()) return bare;
  const port = getAssignedOpencodePort(target);
  if (port === null) return bare;
  const settings = opencodeLaunchArguments(getOpencodeLaunchSettings(target));
  return {
    command:
      `${shellQuote(executablePath)} --port ${port} --hostname ${OPENCODE_SERVER_HOST}` +
      settings,
    // Nothing is written to disk. `configScope: 'none'` says the same thing to
    // a caller that asks the capabilities instead of the plan.
    settingsPath: null,
    // `env` stays empty on purpose, and #2053 is the reason it is worth saying
    // twice: `OPENCODE_CONFIG_CONTENT` would fit here and would work, but it is
    // the top precedence layer, so anything CommandMate puts in it silently
    // outranks the operator's own config. See the module doc.
    env: {},
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
    // #2053 measured the one candidate for changing this — an inline config in
    // `OPENCODE_CONFIG_CONTENT` — and ruled against it. Read the module doc
    // before flipping this value; the reason is not "it does not work".
    configScope: 'none',
    decisionTimeoutSeconds: null,
    // Issue #1924, §4 D3. Not hooks at all: CommandMate holds the SSE stream and
    // adjudicates itself, so there is no hook answer to forecast a dialog from.
    permissionHookPredictsDialog: false,
    sessionStartMayArriveLate: false,
    // `permission.replied` arrives on the same stream and is a positive
    // statement that the dialog is gone (#1898). The only source that can say so.
    permissionReplyReleasesPrompt: true,
    // `per_...` — the id in the reply URL, which is the same id the frame
    // carries (#1899). Real identity, so this source does not need the time
    // window that loses the `stop` of a short turn.
    eventIdentity: 'permission-id',
    // pull: the stream can drop, and `GET /session/status` is how a reconnect
    // finds out whether the conversation is still working (#1900). Read by
    // `./subscription`, which re-arms a `busy` session and synthesises the
    // `stop` of one that finished off-stream; flipping this to `'none'` puts
    // both back to the pre-#1900 behaviour, which is what the mutation case in
    // `tests/unit/hooks/sources/opencode-resilience-1900.test.ts` asserts.
    resync: 'session-status-poll',
    // Issue #2197. opencode is the push half: `./history` is already writing
    // the reply out of the SSE stream, so the gate asks whether the
    // subscription is live rather than asking for the turn.
    transcriptHistory: 'push',
  },

  // C4. Predicates, not a name table: see ./mappers.
  mappers: OPENCODE_MAPPERS,

  // The envelope names the event in `type`; `hook_event_name` does not exist.
  nativeEventNameFields: ['type'],
  // Flat lookup cannot reach `properties.sessionID`; the rules fill it in.
  conversationIdFields: [],
  // Issue #1783: nor `properties.info.model.*`, so the spec takes the reader
  // instead of a key list. See {@link frameModel} for the two spellings.
  extractModel: frameModel,
  // Issue #1899: the extraction half of `eventIdentity: 'permission-id'`. The
  // capability above says which id de-duplication uses; this is what reads it,
  // and the two must be changed together — declaring the capability without
  // this puts every frame back on the 3-second window.
  extractEventIdentity: opencodeEventIdentity,

  parsePermissionRequest: parseOpencodePermissionRequest,
  parseQuestion: parseOpencodeQuestion,

  // Self-reference resolves at call time, which is after this const is bound —
  // which is also how the reconnect loop gets to read a capability declared in
  // the same object literal it is declared in (#1900). It is handed across
  // rather than imported because `./subscription` is imported *by* this module.
  subscribe: (target, onEvent) =>
    openOpencodeSubscription(
      target,
      onEvent,
      (raw) => opencodeAgentEventSource.normalizeEvent(raw),
      { resync: opencodeAgentEventSource.capabilities.resync }
    ),

  decide: decideOpencode,
  listPending: listOpencodePending,
  probeActivity: probeOpencodeActivity,
  liveness: (target: AgentInstanceRef): SourceLiveness => getOpencodeLiveness(target),

  prepareLaunch: prepareOpencodeLaunch,
});

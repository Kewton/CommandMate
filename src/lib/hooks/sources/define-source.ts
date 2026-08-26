/**
 * Factories that turn a tool's *differences* into an {@link AgentEventSource}
 * (Issue #1759).
 *
 * The interface is wide because the six tools genuinely differ in eleven
 * places. Making every implementer restate all eleven would guarantee that
 * Phase 4-2…4-5 is four copies of Claude's file with four things changed —
 * which is the failure mode Epic #1720 was opened about. So the parts that are
 * the *same for every push transport* live here exactly once:
 *
 *  - `subscribe` resolves immediately; the receiver route is already listening
 *    and there is nothing per-instance to hold open (C1).
 *  - `decide` writes into the slot the receiver opened, so the verdict leaves
 *    through the response body (C2).
 *  - `listPending` answers with the requests in flight, because a hook that was
 *    dropped is gone and there is nothing to re-read (C7).
 *  - `probeActivity` answers null: an event cannot be asked again (C7).
 *  - `liveness` answers `unknown`: a quiet hook and a dead agent look identical
 *    (C6).
 *
 * What a push tool then has to supply is the list in
 * {@link PushHookSourceSpec} — spellings, field names, verdict shape, launch
 * command. `docs/design/agent-event-source-interface.md` walks through adding
 * one.
 *
 * {@link definePullEventSource} exists for the same reason in reverse: opencode
 * has real subscription, liveness and re-sync behaviour and no launch config at
 * all, so its defaults are the opposite ones.
 *
 * @module lib/hooks/sources/define-source
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { isAgentEventType, type AgentEventType } from '@/lib/hooks/agent-event-types';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import type { PermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import {
  buildNormalizedEvent,
  readFirstStringField,
  recordUnknownEvent,
  runEventMappers,
  type EventMapper,
} from './event-mapper';
import {
  fillDecisionSlot,
  listOpenDecisions,
  recordDecisionDelivery,
} from './pending-decisions';
import type {
  AgentEventSource,
  AgentEventSourceKind,
  AgentEventSourceStatus,
  AgentInstanceRef,
  AgentLaunchContext,
  AgentLaunchPlan,
  AgentSourceCapabilities,
  NoDecisionBehavior,
  NormalizedAgentEvent,
  PendingDecision,
  RawAgentEvent,
  SourceLiveness,
  Subscription,
  Verdict,
  VerdictEncoding,
} from './types';

/** A subscription that was never really opened. Closing it is legal and inert. */
const INERT_SUBSCRIPTION: Subscription = {
  close: async () => {},
  liveness: { state: 'unknown' },
};

/** Everything a push (hook) source has to say for itself. */
export interface PushHookSourceSpec {
  cliToolId: CLIToolType;
  /**
   * What silence costs (C3). Required, with no default: the whole point of the
   * field is that "we abstain, which is safe" is a claim, and a claim that
   * defaults to true is a claim nobody checked. antigravity's would be a lie.
   */
  noDecision: NoDecisionBehavior;
  capabilities: AgentSourceCapabilities;
  /**
   * Ordered rules, first match wins (C4). Anything they refuse is counted, not
   * thrown (C8).
   */
  mappers: readonly EventMapper[];
  /**
   * Where the tool puts the event's own name, when it puts it anywhere.
   *
   * antigravity puts it nowhere (#1757 R2), so an empty list is legal and means
   * "the caller must pass `event`, which the relay's `--event` argument does".
   */
  nativeEventNameFields?: readonly string[];
  /** Where the agent's session id lives (#1757 R4). */
  conversationIdFields?: readonly string[];
  /** Where a tool-call correlation id lives, if anywhere (#1757 R5). */
  toolCallIdFields?: readonly string[];
  /**
   * Where the model the agent is running lives, as flat payload keys (#1783).
   *
   * Declared the same way `conversationIdFields` is, and for the same reason:
   * three of the four tools that publish a model publish it as one top-level
   * string, and the only difference between them is its spelling — `model` for
   * claude and codex, `modelName` for antigravity. First non-empty wins. Omit
   * the field entirely for a tool that never sends one (gemini, copilot); the
   * normalised event then carries `model: null`, which is a fact rather than a
   * gap to be filled in by guessing.
   */
  modelFields?: readonly string[];
  /**
   * Model extraction for shapes a flat lookup cannot reach (#1783).
   *
   * The escape hatch {@link conversationIdFields} already needed for opencode,
   * whose model sits at `properties.info.model.{modelID,id}`. Wins over
   * {@link modelFields} when both are declared, so a tool that is mostly flat
   * with one nested exception can say so without giving up the list.
   */
  extractModel?: (payload: Record<string, unknown>) => string | null;
  /**
   * The frame's own id, for identity de-duplication (Issue #1899).
   *
   * Omit it and the source answers null for every frame, which is the only
   * honest answer while its `capabilities.eventIdentity` is `null`: nobody has
   * measured where — or whether — this tool publishes a per-frame id. The two
   * declarations move together, and `tests/unit/hooks/sources/capabilities.test.ts`
   * pins the capability half.
   */
  extractEventIdentity?: (payload: Record<string, unknown>) => string | null;
  /** Subtype extraction for events whose rule did not fix one (S2). */
  extractDetail?: (event: AgentEventType, payload: Record<string, unknown>) => string | null;
  parsePermissionRequest: (payload: Record<string, unknown>) => PermissionRequestPayload | null;
  parseQuestion: (payload: Record<string, unknown>) => AskUserQuestionSpec | null;
  /** The wire shape of a verdict (S6 / #1757 R15). */
  encodeVerdict: (verdict: Verdict) => Record<string, unknown>;
  /**
   * Config generation plus the command line (S3 / S4 / S5). Must not throw.
   *
   * Takes the whole {@link AgentLaunchContext} since #1846 — `worktreePath` is
   * in it, so a per-worktree config no longer needs a second entry point.
   * Correlation keys that cannot live in the config file go in the plan's
   * `env`, never as a prefix on `command`.
   */
  prepareLaunch: (context: AgentLaunchContext) => AgentLaunchPlan;
}

/**
 * Build a push (hook) source from its differences.
 *
 * @returns A source whose transport is `push` and whose lifecycle methods are
 *   the inert-but-callable ones every hook tool shares
 */
export function definePushHookSource(spec: PushHookSourceSpec): AgentEventSource {
  const nativeEventNameFields = spec.nativeEventNameFields ?? ['hook_event_name'];

  return {
    cliToolId: spec.cliToolId,
    transport: 'push',
    noDecision: spec.noDecision,
    capabilities: spec.capabilities,

    normalizeEvent(raw: RawAgentEvent): NormalizedAgentEvent | null {
      const receivedAt = raw.receivedAt ?? Date.now();
      const nativeEventName =
        nativeEventNameFields.length > 0
          ? readFirstStringField(raw.payload, nativeEventNameFields)
          : null;

      // An event word the caller already resolved wins over the payload. This
      // is the only channel antigravity has, and it is also how the relay
      // script's `--event` reaches here for every other tool.
      if (raw.event != null && isAgentEventType(raw.event)) {
        return buildNormalizedEvent({ event: raw.event }, raw.payload, receivedAt, {
          detail: spec.extractDetail,
          conversationId: spec.conversationIdFields,
          toolCallId: spec.toolCallIdFields,
          modelFields: spec.modelFields,
          extractModel: spec.extractModel,
        });
      }

      const mapping = runEventMappers(spec.mappers, nativeEventName, raw.payload);
      if (!mapping) {
        // C8. Not an error: a tool emits more events than CommandMate has words
        // for, and it grows more of them between releases.
        recordUnknownEvent(spec.cliToolId, nativeEventName);
        return null;
      }

      return buildNormalizedEvent(mapping, raw.payload, receivedAt, {
        detail: spec.extractDetail,
        conversationId: spec.conversationIdFields,
        toolCallId: spec.toolCallIdFields,
        modelFields: spec.modelFields,
        extractModel: spec.extractModel,
      });
    },

    eventIdentityOf(payload: Record<string, unknown>): string | null {
      // Issue #1899. Absent by default, because a push tool whose capability
      // says `eventIdentity: null` has nothing to read — and answering null is
      // what puts it on the time window `isDuplicateAgentEvent` has always
      // applied to it.
      return spec.extractEventIdentity?.(payload) ?? null;
    },

    parsePermissionRequest: spec.parsePermissionRequest,
    parseQuestion: spec.parseQuestion,

    encodeVerdict(verdict: Verdict): VerdictEncoding {
      return { kind: 'responseBody', body: spec.encodeVerdict(verdict) };
    },

    prepareLaunch: spec.prepareLaunch,

    async subscribe(): Promise<Subscription> {
      // C1: push sources are subscribed to by existing, not by connecting. The
      // method is here so a caller can treat both transports the same way.
      return INERT_SUBSCRIPTION;
    },

    async decide(
      target: AgentInstanceRef,
      decision: PendingDecision,
      verdict: Verdict
    ): Promise<void> {
      // C2: the verdict leaves through the body of the request the agent is
      // blocked on, which the receiver is holding open in a slot.
      const filled = fillDecisionSlot(target, decision.id, spec.encodeVerdict(verdict));
      // Issue #1898: for a push source "delivered" and "the slot was still
      // open" are the same fact — the body has nowhere else to go. Reported so
      // callers of `answerPendingDecisionWithReceipt` get the same shape of
      // answer from both transports.
      recordDecisionDelivery(target, decision.id, {
        delivered: filled,
        reason: filled ? 'response-body' : 'slot-closed',
      });
    },

    async listPending(target: AgentInstanceRef): Promise<PendingDecision[]> {
      return listOpenDecisions(target);
    },

    async probeActivity(): Promise<'busy' | 'idle' | null> {
      // C7: there is no endpoint to ask. Callers fall back to the scraper.
      return null;
    },

    liveness(): SourceLiveness {
      // C6: a hook that has not fired and an agent that has died look the same.
      return { state: 'unknown' };
    },
  };
}

/** Everything a pull (subscription) source has to say for itself. */
export interface PullEventSourceSpec {
  cliToolId: CLIToolType;
  /** C3. opencode's is `{ kind: 'blocks' }` — measured, not assumed. */
  noDecision: NoDecisionBehavior;
  capabilities: AgentSourceCapabilities;
  mappers: readonly EventMapper[];
  /**
   * Where the event's own type lives in the envelope. opencode's frames are
   * `{ id, type, properties }`, so this is `['type']` rather than
   * `['hook_event_name']`.
   */
  nativeEventNameFields?: readonly string[];
  conversationIdFields?: readonly string[];
  toolCallIdFields?: readonly string[];
  /** Flat keys holding the model (#1783). See {@link PushHookSourceSpec.modelFields}. */
  modelFields?: readonly string[];
  /** Nested model extraction (#1783). See {@link PushHookSourceSpec.extractModel}. */
  extractModel?: (payload: Record<string, unknown>) => string | null;
  /** Frame id extraction (#1899). See {@link PushHookSourceSpec.extractEventIdentity}. */
  extractEventIdentity?: (payload: Record<string, unknown>) => string | null;
  extractDetail?: (event: AgentEventType, payload: Record<string, unknown>) => string | null;
  parsePermissionRequest: (payload: Record<string, unknown>) => PermissionRequestPayload | null;
  parseQuestion: (payload: Record<string, unknown>) => AskUserQuestionSpec | null;
  /** Open the stream. The real work of a pull source. */
  subscribe: (
    target: AgentInstanceRef,
    onEvent: (event: NormalizedAgentEvent) => void
  ) => Promise<Subscription>;
  /** Send the verdict over its own connection (C2). */
  decide: (
    target: AgentInstanceRef,
    decision: PendingDecision,
    verdict: Verdict
  ) => Promise<void>;
  /** Re-read what is waiting, for recovery after a reconnect (C7). */
  listPending: (target: AgentInstanceRef) => Promise<PendingDecision[]>;
  /** `GET /session/status` or equivalent (C7). */
  probeActivity: (target: AgentInstanceRef) => Promise<'busy' | 'idle' | null>;
  /** Heartbeat-derived (C6). */
  liveness: (target: AgentInstanceRef) => SourceLiveness;
  /**
   * How the agent is started, when starting it is CommandMate's job at all.
   * opencode needs a `--port`; nothing is written to disk.
   */
  prepareLaunch?: (context: AgentLaunchContext) => AgentLaunchPlan;
}

/**
 * Build a pull (subscription) source from its differences.
 *
 * The mirror image of {@link definePushHookSource}: the lifecycle is real and
 * the verdict never rides on a response body, so {@link
 * AgentEventSource.encodeVerdict} always answers `outOfBand` and callers are
 * pushed towards `decide()`.
 */
export function definePullEventSource(spec: PullEventSourceSpec): AgentEventSource {
  const nativeEventNameFields = spec.nativeEventNameFields ?? ['type'];

  return {
    cliToolId: spec.cliToolId,
    transport: 'pull',
    noDecision: spec.noDecision,
    capabilities: spec.capabilities,

    normalizeEvent(raw: RawAgentEvent): NormalizedAgentEvent | null {
      const receivedAt = raw.receivedAt ?? Date.now();
      const nativeEventName =
        nativeEventNameFields.length > 0
          ? readFirstStringField(raw.payload, nativeEventNameFields)
          : null;

      if (raw.event != null && isAgentEventType(raw.event)) {
        return buildNormalizedEvent({ event: raw.event }, raw.payload, receivedAt, {
          detail: spec.extractDetail,
          conversationId: spec.conversationIdFields,
          toolCallId: spec.toolCallIdFields,
          modelFields: spec.modelFields,
          extractModel: spec.extractModel,
        });
      }

      const mapping = runEventMappers(spec.mappers, nativeEventName, raw.payload);
      if (!mapping) {
        recordUnknownEvent(spec.cliToolId, nativeEventName);
        return null;
      }

      return buildNormalizedEvent(mapping, raw.payload, receivedAt, {
        detail: spec.extractDetail,
        conversationId: spec.conversationIdFields,
        toolCallId: spec.toolCallIdFields,
        modelFields: spec.modelFields,
        extractModel: spec.extractModel,
      });
    },

    eventIdentityOf(payload: Record<string, unknown>): string | null {
      // Issue #1899. See the push factory's copy — the difference is that a
      // pull source is the one that actually declares an `eventIdentity`, so
      // omitting the extractor here would leave the capability announcing an id
      // nothing can read.
      return spec.extractEventIdentity?.(payload) ?? null;
    },

    parsePermissionRequest: spec.parsePermissionRequest,
    parseQuestion: spec.parseQuestion,

    encodeVerdict(): VerdictEncoding {
      // C2. There is no request to answer: the event arrived on a stream that
      // has been open for hours and carries no reply channel.
      return { kind: 'outOfBand' };
    },

    prepareLaunch:
      spec.prepareLaunch ??
      ((context: AgentLaunchContext) => ({
        command: context.executablePath,
        settingsPath: null,
        env: {},
      })),

    subscribe: spec.subscribe,
    decide: spec.decide,
    listPending: spec.listPending,
    probeActivity: spec.probeActivity,
    liveness: spec.liveness,
  };
}

// ============================================================================
// What a caller is told about the machinery behind one pane (Issue #2054)
// ============================================================================

/**
 * How long a heartbeat may be missing before the stream counts as stale.
 *
 * The same 30 s `OPENCODE_HEARTBEAT_TIMEOUT_MS` gives the watchdog that tears
 * the connection down, and deliberately the same number rather than a second
 * one tuned for display: a UI that called a stream `stale` before the transport
 * agreed would blame the agent for a beat that was merely late, and one that
 * called it `live` after the watchdog had already fired would contradict the
 * reconnect happening underneath it. Asserted equal in
 * `tests/unit/hooks/sources/opencode-liveness-2054.test.ts`, because the two
 * constants live in modules that cannot import each other — `./define-source`
 * is imported *by* `./opencode/source`, which is what owns the transport one.
 */
export const AGENT_SOURCE_STALE_AFTER_MS = 30_000;

/**
 * What a source says it is, before anything that happened to one pane (#2054).
 *
 * Read off two things the source already declares, so no tool has to be named
 * and no existing implementer has to be edited to answer:
 *
 *  - `pull` is `sse` — the only pull transport is a subscription to the agent's
 *    own server, which is what `sse` means.
 *  - `push` with an empty `supportedEvents` is `scraper`. That is not a
 *    heuristic: `createLegacyRelaySource` empties the list on purpose ("the
 *    honest answer to 'what does this tool emit?' when nobody has measured it"),
 *    and a tool on the compatibility relay has no structured reader — the frame
 *    is all there is.
 *  - every other `push` is `hooks`.
 */
export function declaredAgentSourceKind(source: AgentEventSource): AgentEventSourceKind {
  if (source.transport === 'pull') return 'sse';
  return source.capabilities.supportedEvents.length === 0 ? 'scraper' : 'hooks';
}

/**
 * Fold a source's declaration together with one pane's liveness (Issue #2054).
 *
 * **The one place `structuredEvents.source.kind` and
 * `CliToolSessionStatus.eventSource` are derived**, called by
 * `lib/session/current-output-builder` and `lib/session/worktree-status-helper`
 * so the header chip's tooltip and the roster's warning row cannot disagree
 * about the same pane.
 *
 * ## Why a push source gets exactly one field
 *
 * `liveness` and `degradedReason` are omitted for anything that is not a
 * subscription, and that is acceptance criterion 2 rather than tidiness: claude
 * and codex answer `{ state: 'unknown' }` by construction (`definePushHookSource`
 * — "a hook that has not fired and an agent that has died look the same"), so
 * publishing `liveness: 'stale'` for them would turn an unmeasurable into a
 * warning on every pane in the app. The surfaces render the extra two fields or
 * nothing, so a push tool's chip is byte-identical to its pre-#2054 self.
 *
 * @param source - The registry's source for this tool
 * @param liveness - `source.liveness(target)` for the pane being described
 * @param now - Epoch ms to age `lastHeartbeatAt` against
 */
export function describeAgentEventSource(
  source: AgentEventSource,
  liveness: SourceLiveness,
  now: number
): AgentEventSourceStatus {
  const declared = declaredAgentSourceKind(source);
  if (declared !== 'sse') return { kind: declared };

  switch (liveness.state) {
    case 'live':
      // Stale, not lost: the watchdog is about to fire and the reconnect will
      // say so itself. Reported as the declared `sse` because the stream is
      // still held — what the operator needs to know is that it went quiet, not
      // that it is gone.
      return now - liveness.lastHeartbeatAt >= AGENT_SOURCE_STALE_AFTER_MS
        ? { kind: 'sse', liveness: 'stale', degradedReason: 'heartbeat_stale' }
        : { kind: 'sse', liveness: 'live' };
    case 'lost':
      // The transport's own word for what went wrong, forwarded verbatim —
      // `port_identity_changed` is the one Issue #2054 is written around, and
      // inventing a display token here would hide every other one.
      return { kind: 'scraper', liveness: 'stale', degradedReason: liveness.reason };
    case 'unknown':
      // A pull source with no subscription: no port was assigned, hook injection
      // is off, or the pane predates the feature. All three mean the frame is
      // the only reader, which is what `scraper` says.
      return { kind: 'scraper', degradedReason: 'not_subscribed' };
  }
}

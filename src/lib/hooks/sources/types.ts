/**
 * `AgentEventSource` — the one seam every agent CLI plugs its lifecycle events
 * into (Issue #1759, Phase 4-1 of Epic #1720).
 *
 * Phases 1-3 left the *consuming* half of the structured-event pipeline already
 * tool-agnostic: `agent-event-state`, `permission-decision-service`,
 * `current-output-builder`, `status-mapping` and `prompt-waiting-composition`
 * all key off `(worktreeId, cliToolId, instanceId)` and branch on nothing else.
 * What stayed Claude-shaped is the half that *produces* the events and the half
 * that *answers* them. This module is the contract for that half, so Phase
 * 4-2…4-5 adds a tool by adding a file rather than by copying Claude's seams.
 *
 * Every type below exists because a measurement demanded it. The two spikes
 * that took those measurements are the specification:
 *
 *  - `docs/design/agent-hooks-phase4-live-verification.md` (#1757) — codex /
 *    copilot / gemini / antigravity, five push-mode hook implementations that
 *    disagree with each other about spelling, casing, correlation keys, config
 *    location and — most importantly — what silence means.
 *  - `docs/design/opencode-server-live-verification.md` (#1758) — opencode,
 *    which is not a hook implementation at all: CommandMate subscribes to *its*
 *    HTTP server over SSE and answers with a separate REST call. §9.1 of that
 *    report lists eight constraints (C1…C8) and §9.2 sketches this interface;
 *    the shapes here follow it.
 *
 * Three of those constraints are worth restating at the top of the file,
 * because getting them wrong is silent:
 *
 *  - **C1 — the direction of travel is not fixed.** Hooks push into
 *    `POST /api/hooks/agent-event`. opencode has to be *subscribed to*. So a
 *    source has a lifecycle (`subscribe` / `Subscription.close`), even when
 *    the push implementations make it a no-op.
 *  - **C2 — the reply channel is not fixed.** A hook is answered in the body of
 *    the request it arrived on; opencode is answered by `POST`ing to a
 *    different URL entirely. {@link AgentEventSource.decide} hides which.
 *  - **C3 — silence does not mean the same thing twice.** Claude / codex /
 *    copilot walk on when nobody answers (fail-open). antigravity reads an
 *    empty object as *deny* and stops every tool call. opencode waits forever
 *    (10m19s measured, no timeout). {@link NoDecisionBehavior} is a declared
 *    field for exactly this reason: "we abstain, which is the safe default" is
 *    a sentence that is only true for some of the tools.
 *
 * @module lib/hooks/sources/types
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import type { PermissionRequestPayload } from '@/lib/hooks/permission-request-payload';

/**
 * Which way events travel (C1).
 *
 * - `push` — the agent posts to CommandMate. Claude, codex, copilot, gemini and
 *   antigravity are all this: a `type: "command"` hook runs
 *   `scripts/hooks/cmate-agent-event.sh`, which POSTs. There is nothing to
 *   start and nothing to keep alive; the receiver route is always there.
 * - `pull` — CommandMate holds a long-lived `GET` against the agent's own HTTP
 *   server. opencode is this. Subscribing, losing the connection and
 *   re-subscribing are real states with real failure modes.
 */
export type AgentEventTransport = 'push' | 'pull';

/**
 * What happens to the agent when CommandMate does not adjudicate (C3).
 *
 * **This single field decides whether Auto-Yes may abstain.** It is not a
 * documentation comment; call sites read it. `describeAbstain()` in
 * `./abstain` turns it into the sentence an operator has to see.
 *
 * - `proceeds` — the agent falls through to its own approval flow. Measured for
 *   Claude (#1721 D5), codex and copilot (#1757 §5.1/§5.2). Abstaining costs a
 *   dialog and nothing else.
 * - `blocks` — the agent waits, with no timeout. Measured for opencode (#1758
 *   §5.5.3: a permission left unanswered for 10m19s was still pending).
 *   Abstaining silently stops the session, so somebody has to be told.
 * - `blocksUntil` — waits, but gives up after `timeoutMs`. No source measured
 *   so far behaves this way; it exists so that a tool which grows a timeout
 *   does not force a third shape into the union later.
 *
 * antigravity is deliberately *not* representable as "abstain is safe": an
 * empty `{}` reply is read as a denial and stops the tool call outright (#1757
 * P10). Its source (Phase 4-4) must encode abstention as a positive
 * `{"decision":"allow"}` or register no hook at all — which is a statement
 * about {@link AgentEventSource.encodeVerdict}, not about this field.
 */
export type NoDecisionBehavior =
  | { kind: 'proceeds' }
  | { kind: 'blocks' }
  | { kind: 'blocksUntil'; timeoutMs: number };

/**
 * The instance an event belongs to.
 *
 * The same triple every other structured-state module is keyed by. Deliberately
 * *not* the agent's own session id: Claude issues a new one on `/clear` while
 * the pane, the worktree and the instance are all untouched (#1721 D7 §1.1),
 * and opencode's `GET /session` returns sessions belonging to other processes
 * entirely (#1758 §5.6). See {@link NormalizedAgentEvent.conversationId}.
 */
export interface AgentInstanceRef {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Defaults to the primary instance (`instanceId === cliToolId`) when absent. */
  instanceId?: string;
}

/**
 * One lifecycle event, in CommandMate's vocabulary, with the original kept.
 *
 * `raw` is retained on purpose: every one of these tools auto-updated itself
 * mid-spike (#1757 P12, three tools in one afternoon), so a payload shape is a
 * moving target and the only defence is to keep what actually arrived.
 */
export interface NormalizedAgentEvent {
  /** One of the seven words in `AGENT_EVENT_TYPES`. */
  event: AgentEventType;
  /** The subtype — notification kind, end reason, tool name — or null. */
  detail: string | null;
  /**
   * The source's own id for the conversation this belongs to (C5).
   *
   * Claude/codex/copilot/gemini: `session_id`. antigravity: `conversationId`.
   * opencode: `sessionID`. **Never a persistence key** — see
   * {@link AgentInstanceRef}.
   */
  conversationId: string | null;
  /**
   * Correlation key for a single tool call, when the source publishes one (C5).
   * Claude: `tool_use_id` (absent on `PermissionRequest`, D2). opencode:
   * `part.callID`. codex/copilot/gemini/antigravity: mostly absent.
   */
  toolCallId: string | null;
  /**
   * The model the agent says it is running, or null (Issue #1783).
   *
   * Already in the payload of four of the six tools and previously dropped on
   * the floor here — `raw` kept it, but nothing above this layer reads `raw`.
   * Where it lives is the source's business, declared as `modelFields` /
   * `extractModel` on its spec, because the tools
   * disagree: claude and codex say `model`, antigravity says `modelName`, and
   * opencode nests it two levels down under a key that is `modelID` on one
   * frame and `id` on another.
   *
   * Null is ordinary and carries no information: gemini and copilot never send
   * it, and claude sends it on `SessionStart` alone. A reader that wants "the
   * model this instance is on" must therefore remember the last non-null value
   * rather than read the newest event — see `getLastKnownAgentModel`.
   *
   * Bounded to `MAX_EVENT_DETAIL_LENGTH` at extraction: it reaches a React text
   * node, and the payload is whatever the agent chose to send.
   */
  model: string | null;
  /** Exactly what arrived, unmodified. */
  raw: Record<string, unknown>;
  receivedAt: number;
}

/**
 * Input to {@link AgentEventSource.normalizeEvent}.
 *
 * `event` carries the word when the *caller* already knows it, which is not a
 * convenience: antigravity's payloads contain no event-name field at all and no
 * `cwd` either (#1757 R2/R6), so for that tool the only channel is the relay's
 * `--event` argument. A source that could only read the payload would be
 * unimplementable for it.
 */
export interface RawAgentEvent {
  payload: Record<string, unknown>;
  /** The event word the caller already resolved, or null to read the payload. */
  event?: AgentEventType | null;
  /** Defaults to `Date.now()`. */
  receivedAt?: number;
}

/** A permission request: something the agent wants to run. */
export interface PermissionSubject {
  kind: 'permission';
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** A question: something the agent wants the human to choose between. */
export interface QuestionSubject {
  kind: 'question';
  spec: AskUserQuestionSpec;
}

/**
 * One thing waiting on a human, in a shape that covers approvals and questions.
 *
 * They are one type because opencode makes them one type: `permission.asked`
 * and `question.asked` are two events on the same stream, answered by two
 * near-identical REST calls (#1758 §5.4/§5.5). Claude keeps them apart —
 * `PermissionRequest` versus the `AskUserQuestion` tool — but nothing above
 * this layer needs that distinction, and `kind` preserves it where it matters.
 */
export interface PendingDecision {
  kind: 'permission' | 'question';
  /**
   * Identifies this decision *to the source*.
   *
   * pull: the id that goes in the reply URL (`per_…` / `que_…`). push: an id
   * minted by the receiver for the in-flight request, since a hook's identity
   * is the HTTP request it arrived on and nothing else.
   */
  id: string;
  conversationId: string | null;
  subject: PermissionSubject | QuestionSubject;
  raw: Record<string, unknown>;
  askedAt: number;
}

/**
 * What CommandMate decided.
 *
 * Wider than Claude's two-valued allow/no-decision because opencode really has
 * three (`once` / `always` / `reject`, #1758 §5.5) and really does take
 * structured answers to questions. A source that cannot express a member says
 * so by encoding it as something safe — see {@link AgentEventSource.encodeVerdict}.
 *
 * `abstain` is the interesting one: it is the *absence* of a decision, and what
 * it costs is {@link NoDecisionBehavior}, not a property of the verdict.
 */
export type Verdict =
  | { kind: 'allowOnce' }
  | { kind: 'allowAlways' }
  | { kind: 'deny'; message?: string }
  | { kind: 'answer'; answers: string[][] }
  | { kind: 'abstain' };

/**
 * How a verdict reaches the agent (C2).
 *
 * - `responseBody` — write this object as the body of the request the agent is
 *   blocked on. Every hook-based source.
 * - `outOfBand` — the body cannot carry it; {@link AgentEventSource.decide}
 *   already did (or will) send it another way. opencode's REST reply.
 *
 * Callers must not branch on the tool; they branch on this.
 */
export type VerdictEncoding =
  | { kind: 'responseBody'; body: Record<string, unknown> }
  | { kind: 'outOfBand' };

/**
 * Whether the source is currently reachable (C6).
 *
 * `unknown` is the honest answer for every push source: a hook that has not
 * fired is indistinguishable from an agent that has nothing to say. opencode
 * heartbeats every 10s, so for it "quiet" and "gone" are different facts
 * (#1758 §5.7).
 */
export type SourceLiveness =
  | { state: 'unknown' }
  | { state: 'live'; lastHeartbeatAt: number }
  | { state: 'lost'; since: number; reason: string };

/** A subscription handle. Closing a push subscription is legal and does nothing. */
export interface Subscription {
  close(): Promise<void>;
  readonly liveness: SourceLiveness;
}

/** What a source can and cannot do, so callers never have to ask "which tool is this?". */
export interface AgentSourceCapabilities {
  /**
   * Which of the seven words this source can ever emit (#1757 §8.1).
   *
   * Not cosmetic. `session_end` never arrives from antigravity and only arrives
   * from opencode when something calls `DELETE /session/:id` — so "the agent
   * exited" has to keep coming from tmux, for every tool, forever. A caller
   * that waits for an event this list omits waits for good.
   */
  readonly supportedEvents: readonly AgentEventType[];
  /**
   * How the tool scopes its hook configuration (#1757 R8).
   *
   * - `per-instance` — a file per (worktree, instance). Claude: `--settings`.
   * - `per-worktree` — a file in the worktree. gemini: `.gemini/settings.json`.
   * - `global-singleton` — exactly one file for the whole machine, which
   *   CommandMate would have to occupy. antigravity: `~/.gemini/config/hooks.json`
   *   is the only file it reads, workspace-local ones are ignored (P8).
   * - `none` — no configuration at all; opencode is subscribed to instead.
   */
  readonly configScope: 'per-instance' | 'per-worktree' | 'global-singleton' | 'none';
  /**
   * Seconds the agent will wait for a verdict before giving up, or null when it
   * waits forever (#1757 R13 / #1758 §5.5.3).
   *
   * copilot's is ≈10s against Claude's 600s, so a decision path budgeted for
   * Claude silently misses copilot's window entirely.
   */
  readonly decisionTimeoutSeconds: number | null;
}

/** Everything needed to start the agent for one instance. */
export interface AgentLaunchPlan {
  /** The command line to send to the pane. */
  command: string;
  /** The generated config file, when the source writes one. */
  settingsPath: string | null;
}

/**
 * One agent CLI's end of the structured-event pipeline.
 *
 * Implemented once per tool, registered in `./registry` under its
 * {@link CLIToolType}. Nothing outside `sources/` may name a tool.
 */
export interface AgentEventSource {
  readonly cliToolId: CLIToolType;
  /** C1. */
  readonly transport: AgentEventTransport;
  /** C3. Read it before abstaining. */
  readonly noDecision: NoDecisionBehavior;
  readonly capabilities: AgentSourceCapabilities;

  /**
   * Turn one raw event into the shared vocabulary, or null when it does not map
   * (S1 + S2 + C4 + C8).
   *
   * Implemented as an ordered list of *predicates*, never as a name table: for
   * opencode `message.part.updated` is `pre_tool_use` or `post_tool_use`
   * depending on `part.state.status`, and `user_prompt_submit` is two different
   * events seen together (#1758 §5.2.3). A `Record<string, AgentEventType>`
   * cannot express either.
   *
   * **Never throws for an unrecognised event** (C8): opencode's `/doc` does not
   * even list `server.heartbeat`, which arrives every ten seconds. Unmapped
   * events return null and are counted — see `getUnknownEventTally`.
   */
  normalizeEvent(raw: RawAgentEvent): NormalizedAgentEvent | null;

  /** Read this source's permission-request payload, or null when unreadable (S7). */
  parsePermissionRequest(payload: Record<string, unknown>): PermissionRequestPayload | null;

  /** Read this source's "ask the human" payload, or null when it is not one (S7). */
  parseQuestion(payload: Record<string, unknown>): AskUserQuestionSpec | null;

  /**
   * Encode a verdict for this source's wire format (S6 / C2).
   *
   * Claude wants `hookSpecificOutput.decision.behavior`; copilot wants
   * `hookSpecificOutput.permissionDecision`; antigravity wants a top-level
   * `{"decision":…}`; opencode wants a REST call and therefore answers
   * `outOfBand` (#1757 R15).
   */
  encodeVerdict(verdict: Verdict): VerdictEncoding;

  /**
   * The command that starts this agent, with whatever config it needs written
   * out first (S3 / S4 / S5).
   *
   * Must never throw: injecting hooks is an enhancement to a session that has
   * to start anyway, so a config that cannot be written costs the events and
   * returns the bare executable.
   */
  prepareLaunch(target: AgentInstanceRef, executablePath: string): AgentLaunchPlan;

  /**
   * Begin receiving events for one instance (C1).
   *
   * push: resolves immediately with a subscription whose `close()` is a no-op —
   * the route is already listening, and there is nothing per-instance to hold.
   * pull: opens the SSE stream and keeps it alive.
   */
  subscribe(
    target: AgentInstanceRef,
    onEvent: (event: NormalizedAgentEvent) => void
  ): Promise<Subscription>;

  /**
   * Answer one pending decision (C2).
   *
   * The caller does not know, and must not care, whether this writes a response
   * body or opens a new connection. See `answerPendingDecision` in
   * `./pending-decisions`, which is how a receiver route uses it.
   */
  decide(target: AgentInstanceRef, decision: PendingDecision, verdict: Verdict): Promise<void>;

  /**
   * Re-read what is waiting on a human (C7).
   *
   * pull: `GET /permission` + `GET /question`, which is how a reconnect
   * recovers what it missed. push: whatever requests are in flight right now,
   * because a hook that was dropped is gone.
   */
  listPending(target: AgentInstanceRef): Promise<PendingDecision[]>;

  /**
   * Ask whether the conversation is working right now (C7), or null when the
   * source cannot be asked.
   *
   * push sources answer null: a hook is an event, and an event cannot be
   * re-read. opencode has `GET /session/status`.
   */
  probeActivity(target: AgentInstanceRef): Promise<'busy' | 'idle' | null>;

  /** C6. push sources answer `{ state: 'unknown' }`. */
  liveness(target: AgentInstanceRef): SourceLiveness;
}

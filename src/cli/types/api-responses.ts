/**
 * CLI-side API Response Type Definitions
 * Issue #518: [DR1-06] All types include Mirrors comments for server-side traceability
 *
 * These types mirror server-side response shapes. Phase 2 will migrate to
 * shared types in src/types/api-contracts.ts.
 */

// Mirrors: src/types/models.ts Worktree + src/app/api/worktrees/route.ts response shape
export interface WorktreeListResponse {
  worktrees: WorktreeItem[];
  repositories: unknown[]; // CLI does not use this
}

// Mirrors: src/types/models.ts Worktree (subset)
// [DR2-08] `name` is the display name / id-derived slug; `branch` (Issue #1003)
// is the real git branch. They usually coincide for sync-generated worktrees
// but can diverge, so `ls --branch` filters on `branch` (falling back to `name`).
export interface WorktreeItem {
  /**
   * Primary worktree identifier: a `<repo>-<branch>` slug (e.g. `anvil-develop`),
   * sanitized/lowercased. This is the prefix users pass to `ls --id` (Issue #1005)
   * and the id accepted by send/capture/wait/respond/instances.
   */
  id: string;
  name: string;
  /**
   * Mirrors: src/types/models.ts Worktree.branch (Issue #1003).
   * Git branch captured at sync time — a distinct concept from
   * gitStatus.currentBranch (live) and initialBranch (session start); it lags a
   * checkout until the next sync. Undefined for rows synced before Issue #1003
   * or written by non-sync paths; consumers fall back to {@link name}.
   */
  branch?: string;
  cliToolId?: string;
  isSessionRunning?: boolean;
  isWaitingForResponse?: boolean;
  isProcessing?: boolean;
  // [DR2-09] Per-CLI-tool session status for agent filtering
  //
  // Mirrors: src/lib/session/worktree-status-helper.ts CliToolSessionStatus
  // (the subset the CLI reads). Entries are the logical-OR aggregate across
  // every instance of a tool; the un-aggregated per-instance map is
  // `sessionStatusByInstance`, which the CLI does not read.
  sessionStatusByCli?: Partial<Record<string, {
    isRunning: boolean;
    isWaitingForResponse: boolean;
    isProcessing: boolean;
    /**
     * Whether the status rests on something positive, or only on nothing
     * having matched (Issue #1926, design §4 D1 / §7 / DR3-005).
     *
     * The second of Phase 1's two contract changes: `commandmate ls`, the
     * header status chip and `BranchStatusIndicator` read this object, not
     * `CurrentOutputResponse`, so the evidence reading had to be published
     * here as well as there.
     *
     * Optional twice over. A server older than #1926 sends no such key, and
     * even a current one omits it for a session that is not running (there was
     * no frame to read) and for a tool with two or more instances (an
     * aggregate has no single reason — read `--json` for the per-tool rows).
     */
    statusEvidence?: 'positive' | 'none';
    /**
     * The scraper's reason token: `input_prompt` / `no_recent_output` /
     * `thinking_indicator` / `default` … (Issue #1926).
     *
     * `string` rather than a union on purpose, exactly as
     * {@link CurrentOutputResponse.sessionStatusReason} is: the detector's
     * vocabulary grows, and a newer server naming a reason this build has never
     * heard of must not be a parse failure. This is what `commandmate ls`
     * prints in its REASON column.
     */
    sessionStatusReason?: string;
    /**
     * The last status anything could positively confirm for this tool, or
     * absent (Issue #1926, design §7).
     *
     * Held in server memory with a TTL and cleared by a restart, so absent is
     * the ordinary answer for a session nobody has polled recently. Read it
     * next to {@link statusEvidence}: it earns its keep when that is `'none'`
     * and the three booleans are a fallback rather than a reading.
     */
    lastKnownStatus?: string;
    /** Epoch ms of {@link lastKnownStatus}. */
    lastKnownStatusAt?: number;
  }>>;
  // Mirrors: src/lib/cli-tools/types.ts AgentInstance[] (Issue #869/#1000).
  // Present on both GET /api/worktrees and GET /api/worktrees/[id].
  agentInstances?: AgentInstance[];
}

// Mirrors: src/app/api/repositories/sync/route.ts POST response (Issue #1680)
export interface RepositorySyncResponse {
  success: boolean;
  message: string;
  worktreeCount: number;
  repositoryCount: number;
  repositories: string[];
  deletedCount: number;
  /** Sanitized, generic warnings only (SEC-MF-001); details stay in server logs. */
  cleanupWarnings: string[];
}

// Mirrors: src/lib/cli-tools/types.ts AgentInstance (Issue #868/#1000)
export interface AgentInstance {
  id: string;
  cliTool: string;
  alias: string;
  order: number;
}

/**
 * Mirrors: src/app/api/worktrees/[id]/opencode/session/route.ts GET response
 * (Issue #2038).
 *
 * opencode-only. Every field is nullable because the interesting case is a
 * **stopped** instance: the session id there is what the next launch will pass
 * to `opencode -s <id>`, and nothing is running to describe it.
 */
export interface OpencodeInstanceSession {
  instanceId: string;
  /** opencode's `Session.id`, or null when nothing has been recorded yet. */
  sessionId: string | null;
  /** opencode's `Session.title`, or null. Display only. */
  title: string | null;
  /** The directory opencode reported the session belongs to, or null. */
  worktreePath: string | null;
  /** Epoch ms the memory was written, or null. */
  updatedAt: number | null;
  /** Whether an opencode server is currently attached to this instance. */
  live: boolean;
}

/** Mirrors: the same route's GET body (Issue #2038). */
export interface OpencodeSessionsResponse {
  instances: OpencodeInstanceSession[];
}

// Mirrors: src/app/api/worktrees/[id]/route.ts GET response shape (subset used
// by the CLI `instances` command; omits gitStatus/session fields not needed here)
export interface WorktreeDetailResponse extends WorktreeItem {
  agentInstances: AgentInstance[];
}

/**
 * Mirrors: src/lib/polling/auto-yes-resolver.ts AutoYesSuppressionReason
 * (Issue #1843) — every value `autoYes.lastSuppression.reason` can carry.
 *
 * Copied rather than imported: tsconfig.cli.json sets `"paths": {}`, and the
 * server module that declares the union imports `@/config/auto-yes-config`, so
 * even a type-only import of it fails `npm run build:cli`. The copy is held to
 * the original by a bidirectional assignability assertion in
 * tests/unit/cli/config/cross-validation.test.ts, which fails `tsc --noEmit`
 * the moment a reason is added server-side.
 *
 * The first four are verdicts of a contract's `autoYes` block. `agent-launch-dialog`
 * is NOT: Issue #1829 records a CLI-lifecycle dialog the poller deliberately
 * leaves to the tool's own launch sequence, through the same channel. Anything
 * that phrases a suppression for a human has to tell the two apart — see
 * SUPPRESSION_CAUSE in src/cli/commands/wait.ts.
 */
export type AutoYesSuppressionReason =
  | 'mode-off'
  | 'deny-pattern'
  | 'deny-pattern-unusable'
  | 'type-not-allowed'
  | 'agent-launch-dialog'
  // `unclassified-frame` is NOT one either (Issue #1924): the generic prompt
  // estimator matched and the tool's own dialog detector did not, so nothing
  // was sent. Same channel, third kind of cause.
  | 'unclassified-frame';

// Mirrors: src/app/api/worktrees/[id]/current-output/route.ts response shape
// [DR2-03] All server-side fields included
export interface CurrentOutputResponse {
  isRunning: boolean;
  isComplete: boolean;
  isPromptWaiting: boolean;
  isGenerating: boolean;
  content: string;
  fullOutput: string;
  realtimeSnippet: string;
  lineCount: number;
  lastCapturedLine: number;
  promptData: PromptData | null;
  autoYes: {
    enabled: boolean;
    expiresAt: number | null;
    stopReason?: string;
    // Mirrors: src/lib/polling/auto-yes-suppression-state.ts AutoYesPolicySuppression
    // (Issue #1684). Non-null once the contract's autoYes policy withheld an
    // answer; `at` is refreshed every poll while the suppressed prompt remains.
    lastSuppression?: {
      /**
       * Normally an {@link AutoYesSuppressionReason}, but deliberately typed as
       * the wire's `string`: this is a server response, and a server newer than
       * the CLI can name a reason this build has never heard of. Consumers
       * narrow it themselves and must stay truthful about the miss (Issue #1843).
       */
      reason: string;
      mode: string | null;
      promptType: string;
      pattern?: string;
      at: number;
    } | null;
    /**
     * Mirrors: src/lib/auto-yes-state.ts AutoYesState.stopMatchedText
     * (Issue #1694). Short excerpt of what `--stop-pattern` matched, with one
     * line of context, present only while `stopReason` is
     * `stop_pattern_matched`. Bounded to STOP_MATCH_EXCERPT_MAX_BYTES UTF-8
     * bytes; a trailing `…[truncated]` marker means it was cut.
     */
    stopMatchedText?: string;
  };
  thinking: boolean;
  thinkingMessage: string | null;
  cliToolId?: string;
  isSelectionListActive: boolean;
  /** Issue #1017: Codex pager/edit-previous mode (subset of isSelectionListActive). */
  isPagerActive?: boolean;
  /**
   * The frame is interactive but the detection layer could not classify it
   * (Issue #1497). The server has published this since #1120; until Issue #1708
   * the CLI never read it, so a dialog the scraper failed to parse was treated
   * as "nothing is happening" and `wait` polled it until --timeout.
   *
   * Momentary by nature — a repaint mid-capture can raise it for a single poll —
   * so it is only a stop reason after it has persisted; see
   * UNCLASSIFIED_DWELL_MS in wait.ts.
   *
   * Produced by `isUnclassifiedFrame` in `src/lib/session/status-evidence.ts`,
   * and NOT the negation of {@link statusEvidence} (Issue #2011) — read the two
   * questions, and the frames on which their answers cross, over there.
   */
  isUnclassifiedActive?: boolean;
  /**
   * Whether {@link sessionStatus} rests on something positive, or only on
   * nothing having matched (Issue #1926, design §4 D1 決定 2 / §7).
   *
   * `'positive'` — a completion marker, a thinking indicator, a parsed prompt,
   * a tool-specific idle-composer rule, or the agent's own `Stop` said so.
   * `'none'` — nothing on the frame could be read either way, so the status is
   * a fallback.
   *
   * ## NOT the same fact as {@link isUnclassifiedActive} (Issue #2011)
   *
   * This comment used to say the two carried one fact under two names, and the
   * server derived the flag from `evidence === 'none'` to match. Issue #1927
   * had already broken that: it moved the evidence producer into the per-tool
   * detectors, and `'none'` widened from "nobody could read this frame" to "no
   * rule vouched for this verdict" — which an ordinary idle Claude composer
   * satisfies. Every idle Claude pane then raised the terminal escape hatch and
   * stopped `wait` completing. #2011 pulled them apart again.
   *
   * They ask different questions, and the answers cross in both directions:
   *
   *   - an idle composer no tool-specific idle rule vouches for is `'none'`
   *     and CLASSIFIED (`isUnclassifiedActive: false`) — `wait` completes on it;
   *   - an unreadable pane whose agent reported `Stop` is `'positive'` and
   *     UNCLASSIFIED (`isUnclassifiedActive: true`) — `wait` holds.
   *
   * This field asks "is there positive proof behind the verdict?", is produced
   * by the detector per tool, and widens as the §4 D1 rollout reaches each one.
   * {@link isUnclassifiedActive} asks "could ANY rule read this frame at all?",
   * is a statement about the reason vocabulary rather than about the strength of
   * the evidence, and is fixed: `isUnclassifiedFrame` in
   * `src/lib/session/status-evidence.ts` is `running` plus one of a closed set.
   *
   * Unclassified reasons: `no_recent_output`, `unknown_frame`, `default`.
   * Classified-but-unproven: `input_prompt`.
   *
   * A closed union, like {@link sessionStatus} and for the same reason: the
   * design fixes the domain at two members precisely so a newer server cannot
   * hand an older CLI a value it has never heard of. Adding a third would be a
   * breaking change, not an additive one.
   *
   * The two marker lines above and the union width are held to the server by
   * tests/unit/cli/types/status-evidence-contract-2015.test.ts; what it can and
   * cannot prove is written out there.
   *
   * Optional because a server older than #1926 sends no such key — which is not
   * the same as `'positive'`. Treat `undefined` as "this server does not say".
   */
  statusEvidence?: 'positive' | 'none';
  /**
   * The last status this server could positively confirm, or null
   * (Issue #1926, design §7 「直前の確定状態（証拠なしの間の表示）」).
   *
   * Equal to {@link sessionStatus} whenever `statusEvidence` is `'positive'`,
   * because the poll that answered just confirmed it. It says something the
   * other fields do not only when the evidence is `'none'`: this is what the
   * session last actually was, as opposed to what the fallback is calling it.
   *
   * Held in server memory, so `null` covers "nothing was ever confirmed", "the
   * confirmation aged out", "the server restarted" and "the session is not
   * running" without distinguishing them. Undefined means a server older than
   * #1926.
   */
  lastKnownStatus?: 'idle' | 'ready' | 'running' | 'waiting' | null;
  /** Epoch ms of {@link lastKnownStatus}, null when that is null (Issue #1926). */
  lastKnownStatusAt?: number | null;
  lastServerResponseTimestamp: number | null;
  serverPollerActive: boolean;
  /**
   * Issue #520: session status from `detectSessionStatus()` — or, since Issue
   * #1723, from the agent's own lifecycle events when they are available and
   * the scraper is not reporting a prompt. `sessionStatusReason` says which.
   */
  sessionStatus?: 'idle' | 'ready' | 'running' | 'waiting';
  /**
   * Issue #520: reason string from `detectSessionStatus()`, or
   * `session_not_running`.
   *
   * Issue #1723 adds a second family, distinguishable by its `hook_` prefix
   * (`hook_stop`, `hook_prompt_submit`, …; see
   * `src/lib/session/status-mapping.ts` HOOK_STATUS_REASON). A `hook_` reason
   * means `sessionStatus` came from an event the agent reported rather than
   * from reading its terminal, so it is exact rather than inferred — the
   * distinction matters when triaging why `wait` did or did not stop.
   */
  sessionStatusReason?: string;
  /**
   * Issue #1549: epoch ms of the last structured stop event, or null when the
   * agent has posted none.
   */
  lastStopEventAt?: number | null;
  /**
   * Issue #1722: the last lifecycle event the agent's injected hooks reported.
   * Diagnostic — it tells an operator whether hooks are arriving and for which
   * instance. No CLI verdict reads it; that is Issue #1723.
   *
   * Mirrors: src/lib/session/current-output-builder.ts StructuredEventsPayload
   */
  structuredEvents?: {
    lastEventType: string | null;
    lastEventAt: number | null;
    lastEventDetail: string | null;
    /**
     * The id of the turn this instance is in, or of the last one it was in
     * (Issue #1926, made a real identity in #1930).
     *
     * Stable for the life of the turn: a `pre_tool_use` arriving mid-turn no
     * longer re-stamps it, and a session recreated in the same pane does not
     * inherit it. `wait` reads a change of id as "a new turn began".
     *
     * Absent from a server older than #1926, and null on one that has heard
     * nothing from this instance.
     */
    turnId?: string | null;
    /**
     * Epoch ms the turn opened, or null (Issue #1926).
     *
     * The event that opens a turn is one of `user_prompt_submit` /
     * `pre_tool_use` / `post_tool_use` — the set `adoptTurnStart` mirrors as
     * {@link TURN_OPENING_EVENT_TYPES}. Null means the opening was never
     * observed: a `stop` arrived with no turn open, so the server publishes
     * null rather than guessing a time `closedAt - openedAt` would be rendered
     * from.
     */
    openedAt?: number | null;
    /** Epoch ms the turn ended, or null while it is open (Issue #1926). */
    closedAt?: number | null;
    /**
     * Why the turn ended, or null while none has (Issue #1926, filled in by
     * #1930).
     *
     * The six values a server produces today are `stop` (the agent's own
     * `Stop`), `session_end`, `stale`, `scraper_evidence`, `resync_idle` and
     * `generation`. A plain `string` on purpose: a newer server can name a
     * close reason this build has never heard of, and narrowing here would turn
     * a forward-compatible payload into a parse failure (Issue #1843).
     */
    closedBy?: string | null;
    /**
     * The approvals this instance is blocked on, oldest first (Issue #1930).
     *
     * Empty on a session with no dialog open. The agent's own `tool_input` is
     * deliberately NOT here — see the server-side type; what is published is
     * what a reader can act on.
     *
     * Mirrors: src/lib/session/current-output-builder.ts PendingDecisionPayload.
     */
    pendingDecisions?: Array<{
      /** The agent's own id for it, or null for a source that publishes none. */
      id: string | null;
      at: number;
      /** `notification` (proved) / `permission-request` (predicted). String-typed per #1843. */
      source: string;
      toolName: string | null;
      confirmedAt: number | null;
      scraperCorroborated: boolean;
      /**
       * Whether a verdict from the server can still reach the agent — the
       * source's `decisionTimeoutSeconds` applied to this record's age.
       *
       * True does **not** mean the dialog is gone. The pane is still blocked;
       * what has expired is the server's ability to answer it automatically.
       */
      deliveryExpired: boolean;
      /**
       * Whether a human is being asked to approve or to choose (Issue #2040).
       *
       * `permission` / `question`. The two block a worker identically and are
       * answered completely differently — three fixed verdicts against the
       * agent's own published choices — so a reader deciding whether to answer
       * at all has to see this first.
       *
       * String-typed and optional for this file's two usual reasons: a newer
       * server may name a third kind, and a server from before #2040 sends no
       * such key. Absent means "this daemon predates the field", never
       * "unknown".
       */
      kind?: string;
      /**
       * The choices a pending question offers, or null (Issue #2040).
       *
       * Null on every approval — an approval's three verdicts belong to the
       * SOURCE and are published as `promptData.decisionOptions` — and null on a
       * question whose payload is no longer held, because the numbers are the
       * payload's own order and quoting them from anything else would number a
       * list the agent never sent.
       *
       * These are the numbers `commandmate respond <worktree> <n>` resolves
       * against on an agent that publishes decision ids.
       */
      questionOptions?: Array<{ number: number; label: string }> | null;
    }>;
    /**
     * What this instance has had dropped by the structured layer's own bounds,
     * and on whose authority (Issue #1930).
     *
     * The field that separates "my `stop` never arrived" from "my `stop`
     * arrived and something had already claimed its id" — the same symptom with
     * different fixes.
     *
     * Mirrors: src/lib/session/agent-event-state.ts AgentEventDropCounts.
     */
    dedupDropped?: {
      dedupDropped: { identity: number; timeWindow: number };
      decisionEvicted: number;
      idsDiscarded: number;
      dialogTimedOut: number;
      decisionOverflow: number;
    };
    /**
     * How long a dialog record is retained without being answered, in ms
     * (Issue #1930).
     *
     * Two values because a prediction and a proof are different statements: a
     * `PermissionRequest` nothing corroborated expires far sooner than a
     * `Notification` that proved a dialog exists.
     */
    dialogPendingMaxMs?: { predicted: number; confirmed: number };
    /**
     * Epoch ms the structured layer first learned a dialog was open, or null
     * (Issue #1725). Non-null together with `isPromptWaiting` is how a caller
     * tells "the agent told us" from "the screen told us".
     */
    promptWaitingSince?: number | null;
    /** `notification` / `permission-request`, or null (Issue #1725). */
    promptWaitingSource?: string | null;
    /**
     * The last `tool_input` this server had to rewrite before it could
     * adjudicate it, or null (Issue #1902).
     *
     * Mirrors: src/lib/hooks/tool-input-normalization-state.ts
     * ToolInputNormalizationRecord.
     *
     * Copilot 1.0.80's `Edit` sends its apply-patch envelope as a bare string,
     * which `parseCopilotPermissionRequest` used to refuse — so every file edit
     * copilot made was answered `unknown-payload` (a no-decision) and drew a
     * dialog no matter what Auto-Yes said. It is now read as a patch, and this
     * field is how an operator sees that it was: a non-null `reason` says the
     * shape that was judged is not the shape the agent sent, and therefore why
     * the deny patterns were matched against the envelope's action headers
     * (`*** Add File: …`) rather than against the file body.
     *
     * `reason` is string-typed on the wire for the same reason
     * `lastSuppression.reason` is: a newer server may name a normalisation this
     * build has never heard of, and narrowing here would turn a
     * forward-compatible payload into a parse failure (Issue #1843).
     *
     * Optional here although the server always sends it — this mirror also
     * describes what an older daemon answers, and `undefined` means "this
     * server predates the field" rather than "nothing was normalised".
     */
    toolInputNormalization?: {
      /** `string-tool-input-as-patch` / `string-tool-input-as-text`. */
      reason: string;
      /** Key the raw value was stored under: `patch` or `text`. */
      key: string;
      /** `typeof` the value the agent sent. `string` is the only measured one. */
      receivedType: string;
      /** `tool_name` of the call that was normalised (`Edit` in #1902). */
      toolName: string;
      /** Epoch ms. */
      at: number;
    } | null;
    /**
     * The last approval this server adjudicated on the agent's behalf, or null
     * (Issue #1898).
     *
     * Mirrors: src/lib/hooks/permission-decision-state.ts
     * PermissionDecisionRecord.
     *
     * opencode's approvals are answered over a REST call nobody is holding, so
     * an Auto-Yes allow can approve a command, dismiss the dialog and leave no
     * trace on any surface an operator reads. This is that trace: what was
     * asked (`toolName`), what was answered (`behavior` / `reason`), whether it
     * reached the agent (`delivered`), and whether it retired the prompt
     * (`releasedPrompt`). `trigger` tells the live path apart from the
     * re-judgement `auto-yes --enable` performs on a dialog that was already up.
     *
     * `reason` and `trigger` are string-typed on the wire for the same reason
     * `lastSuppression.reason` is: a newer server may name a value this build
     * has never heard of, and narrowing here would turn a forward-compatible
     * payload into a parse failure (Issue #1843).
     *
     * Optional here although the server always sends it — this mirror also
     * describes what an older daemon answers.
     */
    permissionDecision?: {
      /** The agent's own id for the dialog (`per_…`), or null. */
      decisionId: string | null;
      /** `tool_name` the approval was judged as, or null. */
      toolName: string | null;
      /** `allow`, or null for a no-decision. */
      behavior: 'allow' | null;
      /** e.g. `auto-yes`, `auto-yes-disabled`, `policy-suppressed`. */
      reason: string;
      /** Whether the verdict actually reached the agent. */
      delivered: boolean;
      /** Whether this delivery retired the prompt-waiting record. */
      releasedPrompt: boolean;
      /** `event` for the live frame, `policy-recheck` for `auto-yes --enable`. */
      trigger: string;
      /** Epoch ms. */
      at: number;
    } | null;
    /**
     * Which agent event source speaks for this tool, and what it declares it can
     * do (Issue #1924).
     *
     * Mirrors: src/lib/session/current-output-builder.ts StructuredSourcePayload.
     * Optional here and required there for the usual reason — this CLI can be
     * newer than the server it is pointed at, and a build from before #1924
     * sends no `source` at all.
     *
     * The string-typed fields are string-typed on purpose, exactly as
     * `lastSuppression.reason` is: a server newer than this CLI can declare a
     * `configScope`, an `eventIdentity` or a `resync` strategy this build has
     * never heard of, and narrowing the wire to the unions this build knows
     * would turn a forward-compatible payload into a parse failure.
     */
    source?: {
      cliToolId: string;
      capabilities: {
        supportedEvents: string[];
        configScope: string;
        decisionTimeoutSeconds: number | null;
        /** Issue #1924, §4 D3: the five declared values, verbatim. */
        permissionHookPredictsDialog: boolean;
        sessionStartMayArriveLate: boolean;
        permissionReplyReleasesPrompt: boolean;
        /**
         * Where a frame-unique id for this source comes from, or null.
         *
         * Non-null is what makes an option number a VERDICT the server can POST
         * rather than a key it has to type, which is the gate `commandmate
         * respond` reads before choosing an endpoint (Issue #2040).
         */
        eventIdentity: string | null;
        resync: string;
      };
    };
    /**
     * What the agent says about the conversation this instance is in, or null
     * (Issue #2040).
     *
     * Mirrors: src/lib/hooks/agent-session-telemetry.ts AgentSessionRecord.
     *
     * The half of a worker's state a terminal frame cannot show — which
     * session, which persona, which model, what it has cost. Read off frames
     * the server was already receiving, so it costs no request; null on every
     * tool that publishes none (all but opencode today), on an opencode pane
     * whose stream has not reported a session yet, and on one that has been
     * killed since it did.
     *
     * Every value is the agent's own, unrounded and unformatted: a reader
     * compares them against what the agent reports about itself, and tidying on
     * the way out breaks that comparison exactly when it matters.
     */
    session?: {
      /** The agent's own session id, or null. */
      id: string | null;
      /** The agent's own title for it, or null. Display only, bounded. */
      title: string | null;
      /** Which persona is driving (opencode's `build` / `plan` / …), or null. */
      agent: string | null;
      /** The model id, verbatim, or null. */
      model: string | null;
      /** The provider that model belongs to, verbatim, or null. */
      provider: string | null;
      /** What the session has cost so far, in the agent's own unit, or null. */
      cost: number | null;
      /**
       * The tokens spent, as the agent counts them.
       *
       * Null members mean "the agent did not say", never zero. `cacheRead` /
       * `cacheWrite` are opencode's `tokens.cache.read` / `.write`, flattened;
       * `total` is declared on an assistant message rather than on a session, so
       * it is null today and is NOT this server's own sum of the other five.
       */
      tokens: {
        input: number | null;
        output: number | null;
        reasoning: number | null;
        cacheRead: number | null;
        cacheWrite: number | null;
        total: number | null;
      };
      /** Epoch ms this record was written, so a reader can judge its age. */
      at: number;
    } | null;
  };
  /**
   * Issue #1839: the upstream (model API) fault visible on the live frame, or
   * null when no known signature matched.
   *
   * Mirrors: src/lib/session/current-output-builder.ts
   * CurrentOutputPayload.upstreamFault
   *
   * **null is not an all-clear.** It means no signature from
   * `src/lib/detection/upstream-faults.ts` was on the last 100 rows — the pane
   * may have scrolled, or the failure may have left it blank (measured in
   * #1834). Only a non-null value is evidence of anything.
   *
   * Optional here although the server always sends it, for the reason
   * {@link CurrentOutputResponse.model} gives: this mirror also has to describe
   * what an older daemon answers, and the CLI is routinely newer than the
   * server it dials.
   */
  upstreamFault?: {
    /** `overloaded` / `retrying` / `limit-reached` / `api-error`. */
    id: string;
    /** The whole line that matched, trimmed and bounded to 200 UTF-8 bytes. */
    matchedText: string;
    /** Epoch ms the frame was captured. */
    at: number;
  } | null;
  /**
   * Issue #1785: the model the session is running, or null when nothing knows.
   *
   * Mirrors: src/lib/session/current-output-builder.ts CurrentOutputPayload.model
   *
   * Optional *here* although the server always sends it, and the two are not in
   * conflict: this mirror also describes what an older daemon answers, and the
   * CLI is routinely newer than the server it dials (`npm i -g` does not restart
   * the running daemon). `undefined` therefore means "this server predates the
   * field", which the commands normalise to null — the same thing they print for
   * a tool that publishes no model.
   */
  model?: string | null;
  /**
   * Issue #1785: reasoning effort, or null when nothing knows.
   *
   * Mirrors: src/lib/session/current-output-builder.ts
   * CurrentOutputPayload.reasoningEffort — including the part where it is null
   * for every session until Issue #1784's extraction layer lands.
   */
  reasoningEffort?: string | null;
  /**
   * Issue #1695: prompts the content-hash dedup guard suppressed for this
   * session, and when it last did.
   *
   * Mirrors: src/lib/polling/prompt-dedup-state.ts PromptDedupSkips
   *
   * The field an operator reads when a prompt was on screen but no prompt
   * message exists: a non-zero `skippedCount` with a recent `lastSkippedAt`
   * means `isDuplicatePrompt` dropped it, and a zero means the detection layer
   * never classified the frame at all (Issue #1676) — two causes with the same
   * symptom that nothing in this payload could previously separate.
   *
   * `skippedCount` is cumulative for the life of the server process, not
   * per-turn, so `lastSkippedAt` is what dates the evidence.
   *
   * Optional here for the same reason `model` is: this mirror also describes
   * what an older daemon answers, and `undefined` means "this server predates
   * the field" rather than "nothing was skipped".
   */
  promptDedup?: {
    skippedCount: number;
    lastSkippedAt: number | null;
  };
  /**
   * Issue #1884: which stage of the server's precedence chain picked
   * {@link CurrentOutputResponse.cliToolId}.
   *
   * Mirrors: src/lib/session/current-output-builder.ts
   * CurrentOutputPayload.resolvedBy — and, like `lastSuppression.reason`,
   * deliberately typed as the wire's `string` rather than the union this build
   * knows: a server newer than the CLI can name a stage this build has never
   * heard of, and narrowing here would turn a forward-compatible payload into a
   * parse failure.
   *
   * The field to read when a session visible in tmux is reported as not
   * running. Absent from a server that predates #1884 — which is also a server
   * that resolves `?instance=` incorrectly, so its absence is itself the answer.
   */
  resolvedBy?: string;
  /**
   * Issue #1884: the explicit `?cliTool` the roster contradicts, or null.
   *
   * Mirrors: src/lib/session/current-output-builder.ts
   * CurrentOutputPayload.conflict. This is a read path, so the server resolves
   * the contradiction (roster wins) and answers 200 with it attached rather
   * than 400 — the commands that act refuse it instead (DR3-015).
   */
  conflict?: {
    instanceId: string;
    rosterCliTool: string;
    requestedCliTool: string;
  } | null;

  /**
   * Whether the server's detection rules were read off the CLI build that is
   * installed (Issue #1929, design §4 D2 / §7).
   *
   * Optional **twice over**, and the two absences mean different things:
   *
   *  - no `detector` key at all — either a server older than #1929, or a server
   *    whose probe cache is still cold. `capture --json` runs on a 5-second
   *    poll, so the probe is never awaited on that path (DR3-013); the first
   *    polls after a restart simply carry nothing and a later one carries the
   *    answer. Read it as "not known yet", never as "nothing is stale".
   *  - `detector.staleness` present but `{}` — the probe HAS answered and every
   *    tool it could read is at or below the version its rules were measured
   *    against.
   *
   * A tool appears only when its installed build is strictly newer than
   * `verifiedAgainst`. A tool that is not installed, whose `--version` could not
   * be read, or whose executable did not resolve on `PATH` is absent — no probe
   * was run for it and no child process was spawned (§13.2 S17).
   *
   * Kept off `GET /api/capabilities` deliberately: an installed-CLI version list
   * is a software inventory, so it is published only on authenticated surfaces
   * (DR4-008).
   */
  detector?: {
    staleness?: Record<string, { installed: string; verifiedAgainst: string }>;
  };
}

// Mirrors: src/types/models.ts BasePromptData (subset for CLI output)
//
// Issue #1738: this mirror is deliberately LOOSER than the server union and
// must stay that way. `type` is `string`, not `PromptType`, and `options` is
// `unknown[]`, which is what already lets the degraded payloads through
// unchanged: #1725's `StructuredPromptWaitingData` on `current-output`, and
// #1708 / #1725's audit rows on `messages?messageType=prompt`. Both carry
// `type: 'unclassified'` and an empty option list, and `capture` / `wait`
// already branch on that literal (see UNCLASSIFIED_PROMPT_TYPE in
// cli/commands/wait.ts). Tightening `type` into the server's `PromptData` union
// would reintroduce exactly the gap #1738 closed, on the CLI side.
export interface PromptData {
  type: string;
  question: string;
  /**
   * Mirrors src/types/models.ts MultipleChoiceOption. Since Issue #1726 an
   * option may also carry `description` — the second line the AskUserQuestion
   * picker renders — when the agent's own `PreToolUse` payload supplied it.
   */
  options?: unknown[];
  status?: string;
  answer?: string;
  answeredAt?: string;
  /** Mirrors: src/types/models.ts PromptAnsweredBy (Issue #1685) */
  answeredBy?: string;
  /** Human-facing context block preceding the prompt (Issue #235). */
  instructionText?: string;
  /**
   * What this prompt asks approval for — the surface `autoYes.denyPatterns` are
   * judged against (Issue #1699). Narrower than `instructionText` on purpose:
   * the latter is a pane window and carries finished turns.
   */
  approvalTarget?: string;
  /**
   * The verdicts a structured approval accepts, when this payload is the
   * degraded `unclassified` form for a source that can be answered by decision
   * id (Issue #1898).
   *
   * Mirrors: src/lib/session/structured-prompt.ts StructuredDecisionOption.
   *
   * Held apart from {@link options}, which stays empty on that payload: a
   * reader that answers by typing an option number at the pane must go on
   * finding nothing here, because these numbers are verdicts delivered over the
   * agent's own API rather than lines on a screen. `commandmate wait` reports
   * them on its exit-10 output so the caller is told what `respond` will take.
   */
  decisionOptions?: Array<{ number: number; label: string; reply: string }>;
  [key: string]: unknown;
}

// Mirrors: src/types/models.ts ChatMessage (subset), as serialized by
// GET /api/worktrees/[id]/messages?messageType=prompt (Issue #1685).
// `timestamp` is an ISO string on the wire (Date is JSON-serialized).
export interface PromptMessageResponse {
  id: string;
  worktreeId: string;
  role: string;
  content: string;
  timestamp: string;
  messageType: string;
  promptData?: PromptData;
  cliToolId?: string;
  instanceId?: string;
  archived: boolean;
}

// Mirrors: src/app/api/worktrees/[id]/prompt-response/route.ts response shape
// [DR2-06] prompt-response API response
export interface PromptResponseResult {
  success: boolean;
  answer: string;
  /**
   * e.g. `prompt_no_longer_active`, `unresolvable_answer`, and since Issue
   * #1726 `answer_out_of_range` — the option number is outside the list the
   * agent's own `AskUserQuestion` payload declared, so nothing was sent.
   */
  reason?: string;
  /** Issue #1681: detail accompanying a reason that refused to send. */
  message?: string;
  /**
   * Issue #1681: how a semantic yes/no or --default answer was resolved.
   *
   * Issue #1726 also reports `via: 'semantic'` here when an option LABEL was
   * matched against the agent's structured options (`respond <id> Blue` → 1).
   */
  resolved?: {
    /**
     * Issue #1898 adds `structured-decision`: the answer was delivered to the
     * agent's own API by decision id rather than typed at the pane, so
     * `optionNumber` names a verdict (1 = Allow once, 2 = Allow always,
     * 3 = Reject) and not a line on a screen.
     */
    via: 'semantic' | 'default' | 'structured-decision';
    optionNumber?: number;
    optionLabel: string;
    /** The approval that was answered (Issue #1898). Absent on the key paths. */
    decisionId?: string;
  };
}

/**
 * Mirrors: src/app/api/worktrees/[id]/respond/structured-decision.ts, the body
 * of `POST /api/worktrees/[id]/respond` for the two id-less shapes
 * (Issue #2040).
 *
 * A different route from {@link PromptResponseResult} and therefore a different
 * mirror, even though `respond` reports both through the same lines. The
 * difference that matters is `resolved.via`: this route answers a QUESTION as
 * well as an approval, and a question's answer is a list of labels rather than
 * one verdict — so `optionNumber` / `optionLabel` are absent on that branch and
 * `answers` / `optionNumbers` / `optionLabels` / `freeText` take their place.
 *
 * Every field is optional for this file's usual reason: the CLI is routinely
 * newer than the daemon it dials, and a server from before #2040 answers this
 * body's shape only for the `{ decisionId, answer }` request.
 */
export interface StructuredDecisionResult {
  /** False when the verdict was resolved but the POST to the agent did not land. */
  success: boolean;
  /** The option number for an approval; the chosen numbers, or the text, for a question. */
  answer: string;
  /** `decision_not_delivered` — the only reason this shape carries on a 200. */
  reason?: string;
  /** Detail accompanying a reason, when the server sent one. */
  message?: string;
  resolved?: {
    /** `structured-decision` for an approval, `structured-question` for a question. */
    via: 'structured-decision' | 'structured-question';
    /** Approval only: 1 = Allow once, 2 = Allow always, 3 = Reject. */
    optionNumber?: number;
    /** Approval only: the verdict's label. */
    optionLabel?: string;
    /** The decision that was answered. */
    decisionId?: string;
    /** Question only: exactly what went on the wire — one array of labels per question. */
    answers?: string[][];
    /** Question only: the numbers the answer named, empty for free text. */
    optionNumbers?: number[];
    /** Question only: the labels those numbers named. */
    optionLabels?: string[];
    /** Question only: whether this was prose the agent never offered as a choice. */
    freeText?: boolean;
  };
}

/**
 * Mirrors: src/app/api/worktrees/[id]/auto-yes/route.ts AutoYesResponse
 * [Issue #1898, extended by Issue #1909].
 *
 * Every optional field is optional for the reason the rest of this file states —
 * the CLI is routinely newer than the daemon it talks to (`npm i -g` does not
 * restart a running server), so a field's absence means "this daemon predates
 * it", never "the answer is none". For `cliToolId` that distinction is the bug
 * itself: a server that does not name the agent is a server still arming a
 * hard-coded claude (#1909). The CLI reports what it was told and nothing more.
 */
export interface AutoYesSetResult {
  enabled: boolean;
  expiresAt: number | null;
  pollingStarted?: boolean;
  /**
   * Approvals that were already pending and got re-judged by this call
   * (Issue #1898-2). Absent when nothing was re-read — which is every hook
   * tool, whose `resync` capability is `none`.
   */
  pendingDecisions?: {
    examined: number;
    delivered: number;
    skipped: number;
  };
  /**
   * Issue #1909: the agent whose poller this request armed — and, therefore,
   * the agent `pendingDecisions` was re-judged for. One resolved pair.
   */
  cliToolId?: string;
  /** The instance it was armed for (the primary instance's id is its cliToolId). */
  instanceId?: string;
  /**
   * Which stage of the server's precedence chain chose `cliToolId`. Typed as the
   * wire's `string` rather than a union, like CurrentOutputResponse.resolvedBy:
   * a newer server may name a stage this build has never heard of, and
   * narrowing would turn that into a parse failure.
   */
  resolvedBy?: string;
  /** Read path only; a POST that contradicts the roster is refused, not resolved. */
  conflict?: {
    instanceId: string;
    rosterCliTool: string;
    requestedCliTool: string;
  } | null;
}

/** wait exit 10 CLI extended output type */
export interface WaitPromptOutput {
  worktreeId: string;
  cliToolId: string;
  type: string;
  question: string;
  options: unknown[];
  status: string;
  /**
   * What the prompt asks approval for, when the detector could attribute a block
   * to it (Issue #1699). Present so a caller that reads only this payload can
   * see what a `deny-pattern` verdict below was actually judged against.
   */
  approvalTarget?: string;
  /**
   * Set when the contract's autoYes policy withheld an answer for this session
   * (Issue #1699). Without it, a prompt an operator has to answer by hand is
   * indistinguishable on stdout from one nobody configured Auto-Yes for — which
   * is why the #1699 suppression loop went unnoticed for an hour.
   */
  autoYesSuppression?: {
    reason: string;
    mode: string | null;
    promptType: string;
    pattern?: string;
    ageSeconds: number;
  };
  [key: string]: unknown;
}

// Mirrors: src/app/api/daily-summary/route.ts GET response [Issue #636]
export interface DailySummaryGetResponse {
  report: SerializedReport | null;
  messageCount: number;
}

// Mirrors: src/app/api/daily-summary/route.ts POST response [Issue #636]
export interface DailySummaryGenerateResponse {
  report: SerializedReport;
  generated: boolean;
}

// Mirrors: serializeReport() in daily-summary route.ts [Issue #636]
export interface SerializedReport {
  date: string;
  content: string;
  generatedByTool: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

// Mirrors: src/lib/metrics/vibe-metrics.ts VibeMetrics [Issue #1551]
// Restated rather than imported: tsconfig.cli.json compiles src/cli alone with
// no `@/` paths, so the CLI cannot reach src/lib.
export interface VibeMetrics {
  periodDays: number;
  tasks: {
    total: number;
    succeeded: number;
    failed: number;
    notStarted: number;
    cancelled: number;
    /** 0..1 fraction; null when no tasks were created in the window. */
    successRate: number | null;
    /** null when nothing failed in the window. */
    avgRetryLoops: number | null;
  };
  verification: {
    runs: number;
    passed: number;
    failed: number;
    notStarted: number;
    /** 0..1 fraction; null when no runs started in the window. */
    passRate: number | null;
    gateFailBreakdown: Array<{ gateId: string; failCount: number }>;
  };
  intervention: {
    humanResponds: number;
    autoAnswered: number;
    /** Always null in v1: the policy suppression log is not persisted. */
    suppressedByPolicy: number | null;
  };
}

// Mirrors: src/app/api/metrics/vibe/route.ts GET response [Issue #1551]
export interface VibeMetricsResponse {
  metrics: VibeMetrics;
}

// Mirrors: src/app/api/templates/[id]/route.ts GET response [Issue #636]
export interface TemplateResponse {
  id: string;
  name: string;
  content: string;
}

// Mirrors: src/app/api/daily-summary/status/route.ts GET response [Issue #638]
export interface DailySummaryStatusResponse {
  generating: boolean;
  date?: string;
  tool?: string;
  startedAt?: string;
}

// Mirrors: src/types/models.ts ChatMessage (subset for send response)
export interface ChatMessage {
  id?: number;
  worktreeId: string;
  role: string;
  content: string;
  cliToolId?: string;
  createdAt?: string;
}

// =============================================================================
// Skill management [Issue #1237]
//
// Mirrors: src/lib/api/skills-api.ts (Catalog), src/lib/skills/install-plan.ts,
// src/lib/skills/uninstall-plan.ts and the four skill route modules.
//
// Only the fields the CLI reads are declared. `--json` prints the server body
// verbatim rather than a re-serialization of these types, so the JSON contract
// is the API's and cannot drift from what these declarations happen to cover.
// =============================================================================

/** Mirrors: src/lib/skills/compatibility.ts SkillCompatibilityStatus. */
export type SkillCompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';

/** Mirrors: src/lib/skills/compatibility.ts SkillCommandMateCompatibility (subset). */
export interface SkillCompatibilityView {
  status: SkillCompatibilityStatus;
  /** English fallback message built server-side from code, range and host version. */
  message: string;
  requiredRange: string;
}

/** Mirrors: src/lib/api/skills-api.ts SkillCatalogMetaDto (subset). */
export interface SkillCatalogMeta {
  stale: boolean;
  offline: boolean;
  state: string;
  /** Why the served Catalog is stale, or null when it was confirmed current. */
  staleReason: string | null;
  fetchedAt: string;
  revalidatedAt: string;
  source: { repository: string; ref: string; revision: string | null };
}

/** Mirrors: src/lib/api/skills-api.ts SkillVersionDto (subset; artifact.url is never served). */
export interface SkillCatalogVersionSummary {
  version: string;
  declaredRisk: string;
  prerelease: boolean;
  publishedAt: string;
  compatibility: { commandmate: SkillCompatibilityView };
}

/** Mirrors: src/lib/api/skills-api.ts SkillDto (subset). */
export interface SkillCatalogSummary {
  id: string;
  name: string;
  summary: string;
  provider: { name: string };
  license: string;
  homepage: string | null;
  latest: string;
  recommendedVersion: string | null;
  recommendedReason: string;
  compatibility: SkillCompatibilityView | null;
  versions: SkillCatalogVersionSummary[];
}

/** Mirrors: src/app/api/skills/route.ts GET response. */
export interface SkillListResponse {
  catalog: SkillCatalogMeta;
  skills: SkillCatalogSummary[];
}

/** Mirrors: src/app/api/skills/[id]/route.ts GET response. */
export interface SkillDetailResponse {
  catalog: SkillCatalogMeta;
  skill: SkillCatalogSummary;
}

/** A typed reason an operation is refused, with the repository-relative path responsible. */
export interface SkillPlanBlocker {
  code: string;
  path: string | null;
}

/** Mirrors: src/lib/skills/install-plan.ts SkillInstallPlanDto (subset). */
export interface SkillInstallPlan {
  /** Single-use token the apply step presents unchanged. The CLI never inspects it. */
  token: string;
  expiresAt: string;
  installable: boolean;
  requiresRiskAcknowledgement: boolean;
  riskAcknowledged: boolean;
  blockers: SkillPlanBlocker[];
  warnings: string[];
  target: {
    worktreeId: string;
    worktreeName: string;
    repositoryName: string;
    branch: string | null;
    headState: string;
    workingTreeDirty: boolean;
    /** Repository-relative; the server never serves a machine-absolute path. */
    installRoot: string;
    /** Every root the package is placed into, primary first (#1460). */
    installRoots?: string[];
    existingInstall: { version: string; receiptDigest: string } | null;
  };
  skill: {
    id: string;
    name: string;
    version: string;
    summary: string;
    license: string;
    declaredPermissions: string[];
    effectiveRisk: string;
    riskRationale: string;
    scriptPaths: string[];
    executablePaths: string[];
    requirements: {
      commands: Array<{ name: string; versionRange: string | null }>;
      networkHosts: string[];
    };
    compatibility: {
      commandmate: SkillCompatibilityView;
      agents: Array<{ agent: string; support: string }>;
    };
  };
  stats: {
    added: number;
    modified: number;
    unchanged: number;
    conflicted: number;
    unmanaged: number;
  };
}

/** Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/plan/route.ts POST response. */
export interface SkillInstallPlanResponse {
  plan: SkillInstallPlan;
}

/**
 * Mirrors: SkillInstallOperationDto / SkillUninstallOperationDto (subset).
 * `committed_reconciling` means the worktree already changed — never reported as a failure.
 */
export interface SkillOperationResult {
  operationId: string;
  state: string;
  result: 'succeeded' | 'committed_reconciling';
  committed: boolean;
  reconcilePending: boolean;
  nextActionKey: string;
  replayed: boolean;
}

/**
 * Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/install/route.ts POST response.
 * `files` is absent from the narrower replay body, and `install` is null when a
 * replay finds no index row.
 */
export interface SkillInstallResponse {
  operation: SkillOperationResult;
  install: {
    skillId: string;
    version: string;
    installRoot: string;
    installRoots?: string[];
    files?: Array<{ path: string }>;
  } | null;
}

/** Mirrors: api/worktrees/[id]/skills/[skillId]/git-workflow prepare response (Issue #1247). */
export interface SkillGitWorkflowPrepareResponse {
  workflowToken: string;
  target: {
    mode: string;
    branch: string;
    baseBranch: string | null;
    headCommit: string;
    branchCreated: boolean;
    remote: string;
  };
}

/** Mirrors: api/worktrees/[id]/skills/[skillId]/git-workflow apply response (Issue #1247). */
export interface SkillGitWorkflowApplyResponse {
  result: {
    branch: string;
    baseBranch: string | null;
    changedPaths: string[];
    committed: boolean;
    commitSha: string;
    pushed: boolean;
    pullRequestUrl: string | null;
    pullRequestExisted: boolean;
  };
}

/** Mirrors: src/lib/skills/uninstall-plan.ts SkillUninstallPlanDto (subset). */
export interface SkillUninstallPlan {
  token: string;
  expiresAt: string;
  removable: boolean;
  blockers: SkillPlanBlocker[];
  nextActionKey: string;
  target: {
    worktreeId: string;
    worktreeName: string;
    repositoryName: string;
    branch: string | null;
    workingTreeDirty: boolean;
    installRoot: string;
  };
  skill: { id: string; version: string; effectiveRisk: string };
  removals: Array<{ path: string }>;
  retained: Array<{ path: string; reason: string }>;
  stats: {
    removable: number;
    modified: number;
    missing: number;
    unknown: number;
    irregular: number;
  };
}

/** Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/uninstall-plan/route.ts POST response. */
export interface SkillUninstallPlanResponse {
  plan: SkillUninstallPlan;
}

/** A typed reason an update is refused (Issue #1243). Paths are repository-relative. */
export interface SkillUpdateBlocker {
  code: string;
  path: string | null;
  /** Underlying per-path finding, when one exists (e.g. a local modification). */
  detail: string | null;
}

/** Mirrors: src/lib/skills/update-plan.ts SkillUpdatePlanDto (subset) [Issue #1243]. */
export interface SkillUpdatePlan {
  /** Single-use token apply (#1244) will present unchanged. The CLI never inspects it. */
  token: string;
  expiresAt: string;
  updatable: boolean;
  blockers: SkillUpdateBlocker[];
  nextActionKey: string;
  requiresRiskAcknowledgement: boolean;
  riskIncreased: boolean;
  update: {
    fromVersion: string;
    toVersion: string;
    latestVersion: string | null;
    reasonCode: string;
    prerelease: boolean;
  };
  target: {
    worktreeId: string;
    worktreeName: string;
    repositoryName: string;
    branch: string | null;
    headState: string;
    workingTreeDirty: boolean;
    /** Repository-relative; the server never serves a machine-absolute path. */
    installRoot: string;
    /** Every recorded root the update rewrites, primary first (#1460). */
    installRoots: string[];
  };
  skill: {
    id: string;
    name: string;
    version: string;
    effectiveRisk: string;
    riskRationale: string;
    declaredPermissions: string[];
    scriptPaths: string[];
    compatibility: { commandmate: SkillCompatibilityView };
  };
  securityDiff: {
    risk: {
      from: { effective: string };
      to: { effective: string };
      increased: boolean;
    };
    permissions: { added: string[]; removed: string[] };
    executables: { added: string[]; removed: string[] };
    scripts: { added: string[]; removed: string[] };
    changelogs: Array<{ version: string; changelog: string }>;
  };
  files: Array<{ path: string; change: string }>;
  stats: {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
    localModified: number;
    localMissing: number;
    localUnknown: number;
    irregular: number;
  };
  warnings: string[];
}

/** Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/update-plan/route.ts POST response. */
export interface SkillUpdatePlanResponse {
  plan: SkillUpdatePlan;
}

/**
 * Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/update/route.ts POST
 * response [Issue #1244]. `update` is null when a replay finds no index row;
 * `reload` and `rollback` are absent from the narrower replay body.
 */
export interface SkillUpdateResponse {
  operation: SkillOperationResult;
  update: {
    skillId: string;
    fromVersion?: string;
    toVersion?: string;
    /** Present on the replay body instead of fromVersion/toVersion. */
    version?: string;
    installRoot: string;
    installRoots?: string[];
    pendingRoots?: string[];
  } | null;
  reload?: {
    skillId: string;
    version: string;
    installRoot: string;
    agents: Array<{ agent: string; support: string; messageKey: string }>;
  };
  rollback?: {
    available: boolean;
    backup: { backupId: string; fromVersion: string; fileCount: number; verified: boolean };
    messageKey: string;
  };
}

/** Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/uninstall/route.ts POST response. */
export interface SkillUninstallResponse {
  operation: SkillOperationResult;
  uninstall: {
    skillId: string;
    version: string | null;
    installRoot?: string;
    removedFiles?: Array<{ path: string }>;
    retained?: Array<{ path: string; reason: string }>;
    fullyRemoved?: boolean;
  } | null;
}

/** Mirrors: src/app/api/skills/reindex/route.ts POST response [Issue #1248]. */
export interface SkillReindexResult {
  scannedWorktrees: number;
  indexed: number;
  removed: number;
  skipped: Array<{
    worktreeId: string;
    skillId: string;
    /** Repository-relative root the directory was found at. */
    root: string;
    reason: string;
  }>;
  /** Registered worktrees whose directory is gone; their rows were left untouched. */
  unreadableWorktreeIds: string[];
}

// =============================================================================
// Verification (Issue #1544)
// =============================================================================

/** Mirrors: src/app/api/worktrees/[id]/verify/route.ts POST 202 response. */
export interface VerifyStartResponse {
  runId: number;
}

/**
 * Mirrors: src/lib/db/verification-db.ts VerificationRunStatus.
 * Declared here rather than imported so the CLI bundle stays free of the
 * server's better-sqlite3 dependency graph.
 */
export type VerificationRunStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'not_started'
  | 'error'
  | 'cancelled';

/**
 * Mirrors: src/lib/db/verification-db.ts VerificationGateSource (Issue #1791).
 *
 * `null` on gate rows written before migration v56, and absent entirely on
 * responses from a server older than #1791 — so a consumer must treat "no
 * source" as "unrecorded", never as "the repository declared it".
 */
export type VerificationGateSource = 'builtin' | 'verify.yaml' | 'contract';

/** Mirrors: src/lib/db/verification-db.ts VerificationGateStatus. */
export type VerificationGateStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'skipped'
  | 'error';

/** One admitted change and the contract pattern that admitted it (Issue #1841). */
export interface VerificationScopeAdmission {
  path: string;
  /**
   * The first matching `scope.allow` pattern, in the contract's declaration
   * order, or one of the gate's exemption stand-ins (`(exempt: ...)`), which are
   * parenthesised precisely so they cannot be mistaken for a declared pattern.
   */
  pattern: string;
}

/**
 * Machine-readable scope-gate evidence (Issue #1841).
 *
 * **Derived by the CLI, not sent by the server.** `verification_gate_results`
 * stores a status, an exit code and a log body and nothing else, so the gate's
 * report in `logTail` is the only carrier this evidence has; `verify --json`
 * and `verify show --json` parse it back out (see `parseScopeEvidence` in
 * src/cli/commands/verify.ts). Absent when the scope gate did not run, was
 * skipped, or errored — every one of those writes a message rather than a
 * report — and absent for every other gate.
 */
export interface VerificationScopeDetail {
  /** Capped at 100 entries, as the report is; see {@link totals}. */
  admitted: VerificationScopeAdmission[];
  /** Capped at 100 entries, as the report is; see {@link totals}. */
  violations: string[];
  /**
   * Counts as the gate itself made them, over *every* changed path.
   *
   * The lists above are the report's, so they stop at its cap; these do not.
   * A consumer asking "did anything fall outside the contract" must read
   * `totals.violations`, never `violations.length`.
   */
  totals: {
    changed: number;
    admitted: number;
    violations: number;
  };
}

/**
 * Machine-readable record of a gate that was re-run (Issue #1772).
 *
 * **Derived by the CLI, not sent by the server**, for the same reason
 * {@link VerificationScopeDetail} is: `verification_gate_results` holds one
 * status, one exit code and one duration per gate, and #1772 added no
 * migration, so the second run's numbers exist only in the `[flaky]` marker the
 * runner writes at the head of `logTail` (see `parseFlakyMarker` in
 * src/cli/utils/verify-runner.ts).
 *
 * Absent on every gate that ran once — which is every gate that did not declare
 * `retryOnFail: 1`, and every one of those that passed first time.
 */
export interface VerificationFlakyDetail {
  /** Runs the gate actually got. Always 2 today; `retryOnFail` maxes out at 1. */
  runs: number;
  /**
   * `flaky` = failed, then passed. `fail` = failed twice, which is a gate that
   * was never flaky and whose retry said so.
   */
  outcome: 'flaky' | 'fail';
  /** One per run, in order. null for a run killed by a signal (`n/a`). */
  exitCodes: (number | null)[];
  /** One per run, in order. null when the marker's value could not be read. */
  durationsMs: (number | null)[];
  /**
   * How the run counted this gate: `pass` only when the gate declared
   * `flakyIsPass: true` and the outcome was `flaky`. Recorded rather than
   * recomputed, because the verify.yaml that decided it may have changed by the
   * time anyone reads the run back.
   */
  verdict: 'pass' | 'fail';
  /** The marker's own `exit=` value (`1,0`), for rendering without re-rounding. */
  exit: string;
  /** The marker's own `duration=` value (`45.0s,44.0s`). */
  duration: string;
}

/**
 * Mirrors: src/lib/db/verification-db.ts VerificationGateResult.
 * Dates arrive as ISO strings because the route serializes them through JSON.
 */
export interface VerificationGateResultView {
  id: number;
  runId: number;
  gateId: string;
  command: string;
  status: VerificationGateStatus;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * Where the gate was declared (Issue #1791): the repository's verify.yaml,
   * this delegation's execution contract, or the runner's own built-ins.
   */
  source?: VerificationGateSource | null;
  /**
   * Whether `startedAt`/`finishedAt` bracket the execution `durationMs` counted
   * (Issue #1625).
   *
   * Rows written before #1625 stamped both at write time, and history is never
   * rewritten, so a consumer reading old runs must check this before treating
   * the timestamps as timing. `durationMs` was always correct and needs no such
   * check. Absent on responses from a server older than #1625.
   */
  timingsMeasured?: boolean;
  /**
   * Scope-gate evidence, on the `scope` gate only (Issue #1841).
   *
   * Not part of the server payload: the CLI adds it to the object it prints so
   * a caller can read what the contract admitted without re-parsing prose.
   * Existing fields, `logTail` included, are untouched.
   */
  scope?: VerificationScopeDetail;
  /**
   * Retry record, on a gate that was re-run (Issue #1772). Added by the CLI the
   * same way {@link VerificationGateResultView.scope} is, and for the same
   * reason: this is what a flake advisor reads instead of re-parsing the log.
   */
  flaky?: VerificationFlakyDetail;
}

/** Mirrors: src/lib/db/verification-db.ts VerificationRunWithGates. */
export interface VerificationRunView {
  id: number;
  worktreeId: string;
  instanceId: string | null;
  taskId: string | null;
  trigger: string;
  status: VerificationRunStatus;
  baseRef: string | null;
  startedAt: string;
  finishedAt: string | null;
  gates: VerificationGateResultView[];
}

/** Mirrors: src/app/api/worktrees/[id]/verify/runs/[runId]/route.ts GET response. */
export interface VerifyRunResponse {
  run: VerificationRunView;
}

/**
 * Mirrors: src/lib/db/verification-db.ts VerificationGateSummary (Issue #1593).
 * No `logTail` — the history listing does not carry log bodies, and declaring
 * one here would let `history` code read a field the server never sends.
 */
export interface VerificationGateSummaryView {
  gateId: string;
  status: VerificationGateStatus;
  exitCode: number | null;
  durationMs: number | null;
  /** Where the gate was declared (Issue #1791). */
  source?: VerificationGateSource | null;
}

/** Mirrors: src/lib/db/verification-db.ts VerificationRunWithGateSummaries. */
export interface VerificationRunSummaryView {
  id: number;
  worktreeId: string;
  instanceId: string | null;
  taskId: string | null;
  trigger: string;
  status: VerificationRunStatus;
  baseRef: string | null;
  startedAt: string;
  finishedAt: string | null;
  gates: VerificationGateSummaryView[];
}

/** Mirrors: src/app/api/verification/runs/route.ts GET response. */
export interface VerificationRunHistoryResponse {
  runs: VerificationRunSummaryView[];
}

// =============================================================================
// Task contracts (Issue #1545)
// =============================================================================

/** Mirrors: src/lib/db/tasks-db.ts TaskStatus. */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_input'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'not_started'
  | 'cancelled';

/**
 * Mirrors: src/lib/tasks/contract-parser.ts TaskContract.
 * The snapshot taken at send time, as stored in `tasks.contract_json`.
 */
export interface TaskContractView {
  version: number;
  title: string;
  goal: string;
  scope: { allow: string[]; deny: string[] };
  verify: {
    gates: string[] | null;
    /**
     * Gates this contract declares for itself (Issue #1791). Absent on
     * responses from a server older than #1791, and on tasks recorded before
     * it — `contract_json` is replayed verbatim, never re-validated.
     */
    gateDefinitions?: Array<{
      id: string;
      command: string;
      timeoutSec: number;
      /** Machine-wide lock the gate holds while it runs (Issue #1771). */
      mutex?: string;
    }>;
  };
  autoYes: { mode: string | null; allowPromptTypes: string[]; denyPatterns: string[] };
  success: { requireWorkEvidence: boolean; requireScopeClean: boolean };
}

/**
 * Mirrors: src/lib/db/tasks-db.ts Task.
 * Dates arrive as ISO strings because the route serializes them through JSON.
 */
export interface TaskView {
  id: string;
  worktreeId: string;
  cliToolId: string;
  instanceId: string | null;
  title: string;
  goal: string;
  contractPath: string | null;
  contract: TaskContractView;
  status: TaskStatus;
  lastVerificationRunId: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Mirrors: src/app/api/worktrees/[id]/tasks/route.ts POST response. */
export interface TaskCreateResponse {
  task: TaskView;
  /** Contract preamble + goal, composed server-side; this is what gets sent. */
  message: string;
}

/** Mirrors: src/app/api/worktrees/[id]/tasks/route.ts GET response. */
export interface TaskListResponse {
  tasks: TaskView[];
}

/** Mirrors: src/app/api/tasks/[taskId]/route.ts GET response. */
export interface TaskDetailResponse {
  task: TaskView;
  lastVerificationRun: VerificationRunView | null;
}

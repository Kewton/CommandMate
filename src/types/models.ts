/**
 * Data models for myCodeBranchDesk
 */

import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
// Type-only, and it has to stay that way: `lib/session/structured-prompt`
// imports UNCLASSIFIED_PROMPT_TYPE back from this module, so a value import
// here would close a runtime cycle. `import type` is erased, so there is none.
import type {
  StructuredPromptHistoryRecord,
  StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';

export type { AgentInstance };

/**
 * Remote ahead/behind counts relative to upstream
 * Issue #779: git status API + GitPane Current Status (Phase 1/5)
 */
export interface AheadBehind {
  /** Commits ahead of upstream */
  ahead: number;
  /** Commits behind upstream */
  behind: number;
}

/**
 * Why ahead/behind could not be computed (Issue #1515, B-1).
 *
 * A CLASSIFICATION CODE ONLY — never raw git stderr (which can carry a
 * credential-bearing remote URL or absolute paths). The API returns this so the
 * UI can say WHY the `↑N ↓N` chip is absent instead of rendering nothing:
 * - `no_upstream`:   the branch has no upstream configured (never pushed)
 * - `upstream_gone`: an upstream IS configured but its remote-tracking ref is
 *                    missing (`[gone]` — e.g. deleted after a merge)
 * - `detached`:      HEAD does not point to a branch
 * - `error`:         timeout / unparsable output / anything unclassified
 */
export type AheadBehindReason = 'no_upstream' | 'upstream_gone' | 'detached' | 'error';

/**
 * Git status information for a worktree
 * Issue #111: Branch visualization feature
 *
 * @remarks
 * New fields should be optional (?) for backward compatibility
 *
 * @future Potential extensions:
 * - stashCount?: number - Number of stashes
 * - lastCommitMessage?: string - Latest commit message
 */
export interface GitStatus {
  /** Current git branch name (e.g., "main", "feature/xxx", "(detached HEAD)", "(unknown)") */
  currentBranch: string;
  /** Branch name at session start (null if not recorded) */
  initialBranch: string | null;
  /** True if currentBranch differs from initialBranch */
  isBranchMismatch: boolean;
  /** Short commit hash (e.g., "abc1234") */
  commitHash: string;
  /** True if there are uncommitted changes */
  isDirty: boolean;
  /**
   * Remote difference (Issue #779).
   * - undefined: not computed (getGitStatus path / GET /api/worktrees/[id] payload)
   * - null: computed but no upstream / detached HEAD / error
   * - AheadBehind: successfully computed
   *
   * NOTE (Issue #1515): these counts compare HEAD against the LOCAL
   * remote-tracking ref, i.e. the last `git fetch` snapshot — not the live
   * remote. `lastFetchAt` tells the reader how old that snapshot is.
   */
  aheadBehind?: AheadBehind | null;
  /**
   * Why `aheadBehind` is null (Issue #1515, B-1). Non-null ONLY when
   * `aheadBehind` is null; a classification code, never raw git stderr.
   * - undefined: not computed (paths that do not compute aheadBehind at all)
   */
  aheadBehindReason?: AheadBehindReason | null;
  /**
   * When this worktree last fetched from a remote (Issue #1515, A-3), as epoch
   * milliseconds — the mtime of `FETCH_HEAD`. null means "never fetched" (no
   * FETCH_HEAD yet), undefined means "not computed".
   */
  lastFetchAt?: number | null;
}

/**
 * The waiting taxonomy published per agent instance (Issue #1786).
 *
 * Client mirror of `CliToolSessionStatus`'s waiting fields in
 * `lib/session/worktree-status-helper.ts`. Every field is optional here and
 * required there, deliberately: the server always fills them, but a payload from
 * an older server — and every fixture written before this Issue — has none of
 * them, and a consumer must go on compiling and rendering exactly as it did.
 * Read them null-safely; there is no UI change in #1786 itself.
 */
export interface SessionWaitingDetail {
  /**
   * What kind of wait: `prompt` is answerable from the app, `menu` needs the
   * terminal (selection list / pager), `unclassified` is a wait only the agent's
   * structured events reported. null / absent when not waiting.
   */
  waitingKind?: 'prompt' | 'menu' | 'unclassified' | null;
  /** Epoch ms the current wait began; stable for its whole duration. */
  waitingSince?: number | null;
  /** The agent said it is waiting for its next instruction (`idle_prompt`). */
  awaitingInstruction?: boolean;
}

/**
 * What is reading one agent pane besides the terminal frame (Issue #2054).
 *
 * Client mirror of `AgentEventSourceStatus` in `lib/hooks/sources/types.ts`.
 * Declared here rather than imported for the mechanical reason the agent-session
 * views give: that module's graph reaches `fs` through the sources it defines,
 * so a `'use client'` component cannot import it.
 *
 * **Published for opencode and nothing else today.** Every push (hook) tool
 * answers "unknown" by construction — a hook that has not fired and an agent
 * that has died look identical — so the server omits the whole object for them
 * and every surface that renders it renders nothing. That is what keeps the
 * claude / codex header chips byte-identical to their pre-#2054 selves.
 */
export interface AgentEventSourceView {
  /**
   * `sse` — CommandMate holds the agent's own event stream.
   * `hooks` — the agent posts events at CommandMate.
   * `scraper` — nothing structured is left; the frame is the only reader.
   */
  kind?: 'sse' | 'hooks' | 'scraper';
  /**
   * Why the pane is not on the machinery its tool declares, as a token:
   * `port_identity_changed` (another process took the port), `heartbeat_stale`,
   * `not_subscribed`. Absent when nothing is degraded.
   */
  degradedReason?: string;
  /** Whether the stream is beating. Absent for a source with no heartbeat. */
  liveness?: 'live' | 'stale';
}

/**
 * Worktree representation
 */
export interface Worktree {
  /** URL-safe ID (e.g., "main", "feature-foo") */
  id: string;
  /** Display name (e.g., "main", "feature/foo") */
  name: string;
  /** Absolute path to worktree directory */
  path: string;
  /** Repository root path (e.g., "/path/to/repo") */
  repositoryPath: string;
  /** Repository display name (e.g., "MyProject") */
  repositoryName: string;
  /**
   * Git branch captured at sync time (scanWorktrees), Issue #1003.
   *
   * This is a THIRD, distinct branch concept — do not conflate it with the
   * existing two:
   *   - {@link GitStatus.initialBranch}: branch recorded at session start.
   *   - {@link GitStatus.currentBranch}: the live branch resolved on read.
   *   - branch (this field): a `git worktree list` snapshot from the last sync.
   *
   * Freshness/meaning therefore differ: it lags behind a checkout until the
   * next sync. Optional and may be undefined for rows synced before Issue #1003
   * (NULL in DB) or written by non-sync paths; consumers should fall back to
   * {@link name}.
   */
  branch?: string;
  /** Repository user-defined alias (Issue #642) */
  repositoryDisplayName?: string;
  /** User description for this worktree */
  description?: string;
  /** Latest user message content (truncated to ~200 chars) */
  lastUserMessage?: string;
  /** Timestamp of latest user message */
  lastUserMessageAt?: Date;
  /** Summary of last message (for list view) - DEPRECATED: use lastUserMessage instead */
  lastMessageSummary?: string;
  /** Latest messages per CLI tool (truncated to 50 chars each) */
  lastMessagesByCli?: Partial<Record<CLIToolType, string>>;
  /** Last updated timestamp */
  updatedAt?: Date;
  /** Timestamp when user last viewed this worktree (for unread tracking) */
  lastViewedAt?: Date;
  /** Timestamp of the most recent assistant message (for unread tracking) */
  lastAssistantMessageAt?: Date;
  /** Whether a tmux session is currently running for this worktree */
  isSessionRunning?: boolean;
  /** Whether this worktree is waiting for Claude's response */
  isWaitingForResponse?: boolean;
  /** Whether Claude is actively processing a request (last message from user) */
  isProcessing?: boolean;
  /** Session status per CLI tool */
  sessionStatusByCli?: Partial<Record<CLIToolType, { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean } & SessionWaitingDetail>>;
  /**
   * Session status per agent instance (Issue #875), keyed by instanceId.
   * Primary instances are keyed by their CLI tool id (instanceId === cliToolId);
   * alias instances by their own instanceId. Each entry is that instance's own
   * (un-aggregated) status, so the per-instance UI can resolve each independently.
   */
  sessionStatusByInstance?: Partial<Record<string, {
    isRunning: boolean;
    isWaitingForResponse: boolean;
    isProcessing: boolean;
    /**
     * The model this instance last reported running (Issue #1783), or absent.
     *
     * Read from the agent's own structured hook events, so it is present only
     * for the tools that publish one (claude / codex / antigravity / opencode)
     * and only once one has arrived. Absent means "nothing has said" — render
     * nothing rather than an "unknown" badge.
     */
    model?: string | null;
    /**
     * The reasoning effort this instance is running at (Issue #1784), or absent.
     *
     * One of `minimal | low | medium | high | xhigh`. Read off the CLI's own
     * status bar / startup banner — no hook payload of any tool publishes an
     * effort — so it exists for codex, claude and antigravity and is absent for
     * everything else, and absent for a claude session old enough to have
     * scrolled its banner out of tmux history. Render nothing when absent.
     */
    reasoningEffort?: string | null;
    /**
     * What is reading this instance besides the frame (Issue #2054), or absent.
     *
     * Absent is the ordinary state and means "nothing to say": the tool's source
     * is a hook source, or the session is not running. See
     * {@link AgentEventSourceView}.
     */
    eventSource?: AgentEventSourceView;
  } & SessionWaitingDetail>>;
  /** Whether this worktree is marked as favorite */
  favorite?: boolean;
  /** Worktree status: ready, in_progress, in_review, done, or null if not set */
  status?: 'ready' | 'in_progress' | 'in_review' | 'done' | null;
  /** External link URL (e.g., issue tracker, PR, documentation) */
  link?: string;
  /** CLI tool type (claude, codex, gemini, vibe-local) - defaults to 'claude' */
  cliToolId?: CLIToolType;
  /** Selected agents for UI display (Issue #368) - 2-4 CLI tool IDs */
  selectedAgents?: CLIToolType[];
  /**
   * Agent instances for this worktree (Issue #868).
   * Replaces selectedAgents as the canonical model for the
   * 1-agent-multiple-sessions feature. Each entry maps a stable instanceId to a
   * CLI tool, with a user-facing alias and display order. When absent, callers
   * should derive primary instances from {@link selectedAgents}.
   */
  agentInstances?: AgentInstance[];
  /** Ollama model name for vibe-local (Issue #368) - null means default */
  vibeLocalModel?: string | null;
  /** Ollama context window size for vibe-local (Issue #374) - null means default */
  vibeLocalContextWindow?: number | null;
  /** Git status information (Issue #111) - optional for backward compatibility */
  gitStatus?: GitStatus;
  /** Review status derived from session state (Issue #600, ?include=review) */
  reviewStatus?: 'done' | 'approval' | 'stalled' | null;
  /** Whether the session is considered stalled (Issue #600, ?include=review) */
  isStalled?: boolean;
  /** Next action display string (Issue #600, ?include=review) */
  nextAction?: string;
}

/**
 * Repository representation (for Phase 2 multi-repo management)
 */
export interface Repository {
  /** Repository ID (hash of path) */
  id: string;
  /** Repository display name */
  name: string;
  /** User-defined alias for display (Issue #642) */
  displayName?: string;
  /** Absolute path to repository root */
  path: string;
  /** Whether this repository is enabled for scanning */
  enabled: boolean;
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
}

/**
 * Chat message role
 */
export type ChatRole = 'user' | 'assistant';

/**
 * Message type discriminator
 */
export type MessageType = 'normal' | 'prompt' | 'prompt_response';

/**
 * Prompt type discriminator
 */
export type PromptType = 'yes_no' | 'multiple_choice' | 'approval' | 'choice' | 'input' | 'continue';

/**
 * Who resolved a prompt (Issue #1685 audit trail).
 * - 'auto': the server-side Auto-Yes poller answered it
 * - 'human': an explicit reply through the respond APIs (chat UI / CLI respond)
 * - 'terminal': inferred — the agent moved on, so someone must have answered in the terminal
 */
export type PromptAnsweredBy = 'auto' | 'human' | 'terminal';

/**
 * Base prompt data interface
 */
export interface BasePromptData {
  /** Type of prompt */
  type: PromptType;
  /** The question being asked */
  question: string;
  /**
   * Current status of the prompt.
   *
   * `unclassified` (Issue #1708) is deliberately NOT `pending`: it marks a row
   * that records a detection FAILURE, and `markPendingPromptsAsAnswered()`
   * selects on `status = 'pending'`, so keeping it out of that value is what
   * stops the sweep from stamping "(answered via terminal)" onto a frame nobody
   * ever answered — or could have.
   */
  status: 'pending' | 'answered' | 'unclassified';
  /** User's answer (if status is 'answered') */
  answer?: string;
  /** Timestamp when answered (ISO 8601) */
  answeredAt?: string;
  /** Who resolved the prompt (Issue #1685). Absent on rows answered before this field existed. */
  answeredBy?: PromptAnsweredBy;
  /** Instruction text preceding the prompt (context for the user) - Issue #235 */
  instructionText?: string;
  /**
   * What *this* prompt is asking approval for — Issue #1699.
   *
   * `instructionText` is a scrollback window sized for human reading, so it
   * carries whatever the previous turns happened to leave on the pane. Machine
   * judgements (the contract's `autoYes.denyPatterns`) must not be made against
   * that: a `rm -rf` approved three turns ago kept matching and suppressed every
   * later prompt until it scrolled off. This field is the same block cut down to
   * the current prompt's own panel — the upward scan stops at the previous
   * turn's transcript marker (see `findApprovalContextStart`).
   *
   * Display keeps reading `instructionText`; only the deny surface reads this.
   * Undefined when the frame gave no block to attribute to this prompt.
   */
  approvalTarget?: string;
}

/**
 * Yes/No prompt data
 */
export interface YesNoPromptData extends BasePromptData {
  type: 'yes_no';
  /** Available options (always ['yes', 'no']) */
  options: ['yes', 'no'];
  /** Default option if user doesn't respond */
  defaultOption?: 'yes' | 'no';
}

/**
 * Multiple choice option
 */
export interface MultipleChoiceOption {
  /** Option number (e.g., 1, 2, 3) */
  number: number;
  /** Option text/label */
  label: string;
  /** Whether this is the default option (indicated by ❯) */
  isDefault?: boolean;
  /** Whether this option requires text input from the user */
  requiresTextInput?: boolean;
  /**
   * The explanatory second line the option carries, when one is known — Issue
   * #1726.
   *
   * Only ever set from an `AskUserQuestion` `tool_input`, never from the screen:
   * the picker renders the description as its own indented line, which the
   * scraper deliberately treats as a continuation and drops (otherwise it would
   * be parsed as another option). So this is information the structured payload
   * adds rather than information it duplicates.
   */
  description?: string;
}

/**
 * What an `AskUserQuestion` picker is showing, from the tool call rather than
 * from the screen (Issue #1726).
 *
 * Present only when the structured `PreToolUse` payload could be lined up
 * against the options the scraper parsed — see
 * `lib/session/ask-user-question-prompt`. Its absence means the options are the
 * scraper's alone, which is also the state of every session on a machine where
 * hooks never fire.
 */
export interface AskUserQuestionPromptMeta {
  /** The short tab label Claude renders for this question, when it sent one. */
  header?: string;
  /** Whether this question accepts several answers (checkbox rendering). */
  multiSelect: boolean;
  /** 0-based index of the question the picker is on. */
  questionIndex: number;
  /** How many questions this one tool call carries. */
  questionCount: number;
  /**
   * Option numbers the picker appended itself — "Type something." / "Chat about
   * this". They are real and selectable, but no structured payload describes
   * them, so a reader that wants only what the agent offered filters them out.
   */
  metaOptionNumbers: number[];
}

/**
 * Submit mode for multiple choice prompts.
 * - 'answer_only': Send only the answer number (no Enter key). Used by Codex CLI "Press number to confirm" UI.
 * - 'answer_then_enter': Send the answer number followed by Enter key (default behavior).
 * Issue #616: Codex Reasoning Level selection requires answer_only mode.
 */
export type SubmitMode = 'answer_only' | 'answer_then_enter';

/**
 * Type guard for SubmitMode values.
 * Validates that a string is a valid SubmitMode ('answer_only' or 'answer_then_enter').
 * Used for allowlist validation of untrusted input from API requests.
 * Issue #616.
 */
export function isValidSubmitMode(value: unknown): value is SubmitMode {
  return value === 'answer_only' || value === 'answer_then_enter';
}

/**
 * Multiple choice prompt data
 */
export interface MultipleChoicePromptData extends BasePromptData {
  type: 'multiple_choice';
  /** Available options */
  options: MultipleChoiceOption[];
  /** How to submit the answer: 'answer_only' (no Enter) or 'answer_then_enter' (default). Issue #616. */
  submitMode?: SubmitMode;
  /**
   * Whether this prompt is rendered as a Claude Code v2.x AskUserQuestion picker
   * (arrow-key navigation, "Enter to select … to navigate" footer). Issue #807.
   * When true, the answer sender engages the picker cursor with a net-zero
   * Down+Up nudge before confirming the already-highlighted default option, since
   * a bare Enter can fail to register on the picker. Absent/false for the legacy
   * numbered-confirmation format, whose response behavior is therefore unchanged.
   */
  isAskUserQuestion?: boolean;
  /**
   * The tool call behind this picker, when the agent's `PreToolUse` payload
   * could be matched to it (Issue #1726). See {@link AskUserQuestionPromptMeta}.
   *
   * Its presence is what tells `respond` the option list is authoritative — and
   * therefore that an out-of-range number may be refused before anything is sent
   * to the terminal. Absent means the options came from the screen alone and the
   * pre-#1726 behaviour applies.
   */
  askUserQuestion?: AskUserQuestionPromptMeta;
}

/**
 * Union type for all prompt data types (extensible for future prompt types)
 */
export type PromptData = YesNoPromptData | MultipleChoicePromptData;

/**
 * `promptData.type` written for an interactive frame nothing could classify.
 *
 * Deliberately NOT a member of {@link PromptType}: the detectors can never
 * produce it, and widening that union would oblige every exhaustive map over it
 * (the contract parser's promptType allowlist among them) to grow a case for a
 * value no prompt-answering path is allowed to accept. Readers compare against
 * this constant instead.
 */
export const UNCLASSIFIED_PROMPT_TYPE = 'unclassified';

/**
 * A record that the detection layer FAILED on a frame (Issue #1708).
 *
 * Deliberately outside the {@link PromptData} union. It is stored in the same
 * `chat_messages.prompt_data` column and listed by `capture --prompts`, so the
 * failure itself is retrievable after the fact — before this, the two prompt
 * history writers were both gated on `isPrompt === true`, so a missed frame left
 * no trace anywhere and the only evidence a worker had stalled was the raw pane,
 * for as long as it stayed on screen.
 *
 * But it is not a prompt: it carries no options (by definition nothing was
 * parsed to put in them) and nothing may answer it. Keeping it out of the union
 * is what stops it being handed to `respond` / the answer sender by a path that
 * only checks `messageType === 'prompt'`.
 *
 * `status` is `'unclassified'` rather than `'pending'` for the same reason
 * `markPendingPromptsAsAnswered()` selects on `status = 'pending'`: a frame
 * nobody could read must never be stamped "(answered via terminal)".
 */
export interface UnclassifiedFrameRecord {
  type: typeof UNCLASSIFIED_PROMPT_TYPE;
  status: 'unclassified';
  /** Human-readable description of the frame and where to go look at it. */
  question: string;
  /** Always empty — nothing was parsed. */
  options: never[];
  /** How long the frame had been unclassified when it was recorded, in seconds. */
  dwellSeconds: number;
  /** The `status/reason` the detector settled on, e.g. `running/default`. */
  sessionStatusReason: string;
}

/**
 * What a LIVE `promptData` field may actually hold (Issue #1738).
 *
 * `currentOutput.promptData` has published the degraded
 * {@link StructuredPromptWaitingData} since Issue #1725, but every layer the
 * value travels through — the WebSocket snapshot, the polling hooks, the UI
 * reducer — went on typing the field as {@link PromptData} alone. Only
 * `PromptPanel`, at the very end, widened its prop. So the intermediate layers
 * held a value their own types said could not exist, and a reader that trusted
 * them could reach `options` on a payload that has none, pass the type checker,
 * and break at runtime for `unclassified` alone.
 *
 * {@link StructuredPromptWaitingData} stays OUT of the {@link PromptData} union
 * itself — see the note on {@link UNCLASSIFIED_PROMPT_TYPE} for why that union
 * must stay closed to values no prompt-answering path may accept. What is
 * closed here is the path the value travels, not the union.
 */
export type LivePromptData = PromptData | StructuredPromptWaitingData;

/**
 * What the shared `chat_messages.prompt_data` column may actually hold
 * (Issue #1738).
 *
 * Two degraded records land there beside the parsed prompts: #1708's
 * {@link UnclassifiedFrameRecord}, written when the detectors failed on a
 * frame, and #1725's {@link StructuredPromptHistoryRecord}, written when only
 * the structured layer saw a dialog. Both go in through the same `promptData`
 * field of `createMessage` — which is why the writer in
 * `lib/session/current-output-builder` needed an `as unknown as PromptData`
 * cast to get past the old type. Naming them here is what makes that cast
 * unnecessary and stops a reader assuming `answer` is always there.
 */
export type StoredPromptData =
  | PromptData
  | UnclassifiedFrameRecord
  | StructuredPromptHistoryRecord;

/**
 * Narrow a prompt payload to the answerable {@link PromptData} union.
 *
 * The one branch every reader of {@link LivePromptData} / {@link
 * StoredPromptData} needs, defined once: `true` means the options, the default
 * and `answer` are meaningful and the value may be answered by option number;
 * `false` narrows to the degraded form, which by construction carries none of
 * them. Both directions come out of this single predicate so no call site has
 * to re-derive "is `type` the unclassified sentinel?" for itself.
 *
 * Deliberately not `isStructuredPromptWaitingData` from
 * `lib/session/structured-prompt`: that one asserts the *live* degraded shape,
 * which would be unsound over {@link StoredPromptData}, whose degraded members
 * share its `type` but not its `status`/`source`.
 */
export function isAnswerablePromptData(
  value: LivePromptData | StoredPromptData | null | undefined,
): value is PromptData {
  return value != null && value.type !== UNCLASSIFIED_PROMPT_TYPE;
}

/**
 * Issue #1121: Client-only optimistic send state for a message shown in the UI
 * before the server confirms it. `sending` = awaiting the send API / server
 * echo; `error` = the send failed and the user can retry or discard. Never set
 * on messages returned by the API.
 */
export type OptimisticSendState = 'sending' | 'error';

/**
 * Chat message
 */
export interface ChatMessage {
  /** Unique message ID (UUID) */
  id: string;
  /** Associated worktree ID */
  worktreeId: string;
  /** Message author role */
  role: ChatRole;
  /** Message content */
  content: string;
  /** Optional summary */
  summary?: string;
  /** Message timestamp */
  timestamp: Date;
  /** Associated log file name (relative path) */
  logFileName?: string;
  /** Request ID for tracking (future use) */
  requestId?: string;
  /** Message type (normal, prompt, etc.) */
  messageType: MessageType;
  /**
   * Prompt data (only for prompt messages).
   *
   * Issue #1738: {@link StoredPromptData}, not {@link PromptData} — the column
   * also carries the two degraded records, and a row that is one of them must
   * not look answerable to a reader. Narrow with {@link isAnswerablePromptData}
   * before touching `options` / `answer`.
   */
  promptData?: StoredPromptData;
  /** CLI tool type (claude, codex, gemini, vibe-local) - defaults to 'claude' */
  cliToolId?: CLIToolType;
  /**
   * Agent instance ID (Issue #868). Identifies which instance of a CLI tool
   * produced/owns this message. Defaults to the primary instance (=== cliToolId).
   */
  instanceId?: string;
  /** Whether this message is archived (from a previous session) */
  archived: boolean;
  /**
   * Issue #1121: Optimistic send state. Present only on client-side pending
   * messages inserted before the server confirms the send; never set on
   * messages returned by the API.
   */
  optimisticState?: OptimisticSendState;
}

/**
 * Individual memo item for a worktree
 * Supports up to 20 memos per worktree (position 0-19)
 */
export interface WorktreeMemo {
  /** Unique memo ID (UUID) */
  id: string;
  /** Associated worktree ID */
  worktreeId: string;
  /** Memo title (max 100 characters) */
  title: string;
  /** Memo content (max 10000 characters) */
  content: string;
  /** Position in the memo list (0-19) */
  position: number;
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
}

/**
 * Worktree session state for tmux capture
 */
export interface WorktreeSessionState {
  /** Associated worktree ID */
  worktreeId: string;
  /** CLI tool identifier for this session state */
  cliToolId: CLIToolType;
  /**
   * Agent instance ID (Issue #868). Together with worktreeId forms the
   * primary key of session_states. Defaults to the primary instance (=== cliToolId).
   */
  instanceId?: string;
  /** Last captured line number from tmux */
  lastCapturedLine: number;
  /** ID of the message currently being updated (null when no message is in progress) */
  inProgressMessageId?: string | null;
}

/**
 * File tree item representation
 */
export interface TreeItem {
  /** File or directory name */
  name: string;
  /** Item type: file or directory */
  type: 'file' | 'directory';
  /** File size in bytes (files only) */
  size?: number;
  /** File extension without dot (files only) */
  extension?: string;
  /** Number of items in directory (directories only) */
  itemCount?: number;
  /**
   * File creation time (ISO 8601 string) - files only [CO-001].
   * Platform note: not a reliable creation time on some Linux filesystems.
   */
  birthtime?: string;
  /** File last-modification time (ISO 8601 string) - files only [Issue #969] */
  mtime?: string;
}

/**
 * File tree response for directory listing
 */
export interface TreeResponse {
  /** Current directory path (relative to worktree root) */
  path: string;
  /** Current directory name */
  name: string;
  /** Directory items (files and subdirectories) */
  items: TreeItem[];
  /** Parent directory path (null for root) */
  parentPath: string | null;
}

/**
 * File content representation
 * [MF-001] Does not include 'success' field - API response is a wrapper
 * that returns { success: true, ...FileContent }
 *
 * [Issue #723] Added optional metadata fields (totalLines/totalBytes/encoding/range)
 * to support read-only large-file viewer with line-range fetch + virtualization.
 * All new fields are optional for backward compatibility with existing call sites.
 */
export interface FileContent {
  /** File path relative to worktree root */
  path: string;
  /** File content (text or Base64 data URI for images, or partial range slice) */
  content: string;
  /** File extension without dot (e.g., 'md', 'png') */
  extension: string;
  /** Worktree root path */
  worktreePath: string;
  /** Whether the file is an image (optional, for image files) */
  isImage?: boolean;
  /** Whether the file is a video (optional, for video files) - Issue #302 */
  isVideo?: boolean;
  /** Whether the file is an HTML file (optional, for HTML files) - Issue #490 */
  isHtml?: boolean;
  /** Whether the file is a PDF file (optional, for PDF files) - Issue #673 */
  isPdf?: boolean;
  /** MIME type (optional, for image/video/pdf files) */
  mimeType?: string;
  /** Total line count in the file (Issue #723, set on line-range and full-text reads of plain text files) */
  totalLines?: number;
  /** Total file size in bytes (Issue #723, set on plain text reads to support polling-throttle decisions) */
  totalBytes?: number;
  /** Encoding label, currently always 'utf-8' for text reads (Issue #723) */
  encoding?: string;
  /** Line range actually returned when {@link content} is a partial slice (Issue #723, 1-based inclusive) */
  range?: { start: number; end: number };
}

/**
 * API response type for file content (success wrapper)
 * [MF-001] Explicit wrapper type for API responses
 */
export type FileContentResponse = { success: true } & FileContent;

// ============================================================================
// Search Types (Issue #21)
// ============================================================================

/**
 * Search mode - determines whether to search by filename or file content
 * [Issue #21] File tree search functionality
 */
export type SearchMode = 'name' | 'content';

/**
 * Search query parameters
 * [Issue #21] File tree search functionality
 */
export interface SearchQuery {
  /** Search query string */
  query: string;
  /** Search mode: 'name' for filename, 'content' for file content */
  mode: SearchMode;
}

/**
 * Search result containing all matching files
 * [Issue #21] File tree search functionality
 */
export interface SearchResult {
  /** Search mode used */
  mode: SearchMode;
  /** Original search query */
  query: string;
  /** List of matching files */
  results: SearchResultItem[];
  /** Total number of matches found */
  totalMatches: number;
  /** Whether results were truncated (exceeds 100 items) */
  truncated: boolean;
  /** Time taken to execute search in milliseconds */
  executionTimeMs: number;
}

/**
 * Individual search result item
 * [Issue #21] File tree search functionality
 * [SEC-SF-001] filePath is relative path only (no absolute paths exposed)
 * [SEC-SF-002] content is truncated to 500 characters max
 */
export interface SearchResultItem {
  /** File path relative to worktree root (security: no absolute paths) */
  filePath: string;
  /** File name without path */
  fileName: string;
  /** Matching lines with content (for content search mode) */
  matches?: Array<{
    /** Line number (1-based) */
    line: number;
    /** Line content (truncated to 500 characters for security) */
    content: string;
  }>;
}

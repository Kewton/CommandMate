/**
 * Type definitions and interfaces for CLI tools
 */

/**
 * CLI Tool IDs constant array
 * T2.1: Single source of truth for CLI tool IDs
 * CLIToolType is derived from this constant (DRY principle)
 */
export const CLI_TOOL_IDS = ['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot'] as const;

/**
 * CLIツールタイプ
 * Derived from CLI_TOOL_IDS for type safety and sync
 */
export type CLIToolType = typeof CLI_TOOL_IDS[number];

// ============================================================================
// Agent Instances (Issue #868: multi-session foundation)
// ============================================================================

/**
 * Maximum number of agent instances allowed per worktree (Issue #868).
 * Caps how many concurrent sessions — including multiple instances of the same
 * CLI tool — a single worktree may hold.
 */
export const MAX_AGENT_INSTANCES = 10;

/**
 * Maximum length for an agent instance alias (display name).
 */
export const MAX_AGENT_ALIAS_LENGTH = 50;

/**
 * Valid instance ID character pattern (Issue #868).
 * Mirrors SESSION_NAME_PATTERN constraints so instance IDs can be embedded in
 * tmux session names without triggering command-injection defenses.
 * Length is bounded to keep generated session names well under tmux limits.
 */
export const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Maximum length for an instance ID. */
export const MAX_INSTANCE_ID_LENGTH = 64;

/**
 * Agent instance definition (Issue #868).
 *
 * Replaces the implicit `(worktreeId, cliToolId)` identity with an explicit,
 * stable `(worktreeId, instanceId)` identity that supports multiple instances
 * of the same CLI tool within one worktree.
 *
 * The PRIMARY instance of a CLI tool has `id === cliTool`, which keeps existing
 * session names, poller keys, and DB rows byte-for-byte identical (backward
 * compatibility / migration anchor).
 */
export interface AgentInstance {
  /** Stable instance identifier. Primary instance: `id === cliTool`. */
  id: string;
  /** CLI tool backing this instance. */
  cliTool: CLIToolType;
  /** Human-readable display name (defaults to the CLI tool's display name). */
  alias: string;
  /** Sort order within the worktree (0-based). */
  order: number;
}

/**
 * Validate an instance ID string (Issue #868).
 * @param id - Candidate instance ID
 * @returns True if the ID is a safe, bounded identifier
 */
export function isValidInstanceId(id: string): id is string {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= MAX_INSTANCE_ID_LENGTH
    && INSTANCE_ID_PATTERN.test(id);
}

/**
 * Get the primary instance ID for a CLI tool (Issue #868).
 * The primary instance is identified by `instanceId === cliTool`, which is the
 * backward-compatibility anchor: session names / poller keys / DB rows are
 * unchanged for the primary instance.
 *
 * @param cliTool - CLI tool type
 * @returns The primary instance ID (equal to the cliTool id)
 */
export function getPrimaryInstanceId(cliTool: CLIToolType): string {
  return cliTool;
}

/**
 * Determine whether an instance ID refers to the primary instance of a CLI tool.
 *
 * @param instanceId - Instance ID (may be undefined → treated as primary)
 * @param cliTool - CLI tool type
 * @returns True when the instance is the primary instance
 */
export function isPrimaryInstance(instanceId: string | undefined, cliTool: CLIToolType): boolean {
  return !instanceId || instanceId === cliTool;
}

/**
 * Build a non-primary instance ID from a suffix (Issue #868).
 * Format: `{cliTool}-{suffix}` (e.g. `claude-2`). Keeps the CLI tool encoded in
 * the ID so the backing tool can be recovered without a DB lookup.
 *
 * @param cliTool - CLI tool type
 * @param suffix - Distinguishing suffix (alphanumeric/underscore/hyphen)
 * @returns Composite instance ID
 */
export function buildInstanceId(cliTool: CLIToolType, suffix: string): string {
  return `${cliTool}-${suffix}`;
}

/**
 * Derive the tmux session-name suffix for a (non-primary) instance (Issue #868).
 * Strips a leading `{cliTool}-` prefix so `claude-2` yields `2`, avoiding a
 * redundant `mcbd-claude-{wt}-claude-2` session name. Falls back to the raw ID.
 *
 * @param instanceId - Instance ID
 * @param cliTool - CLI tool type
 * @returns Session-name-safe suffix
 */
export function deriveSessionSuffix(instanceId: string, cliTool: CLIToolType): string {
  const prefix = `${cliTool}-`;
  return instanceId.startsWith(prefix) ? instanceId.slice(prefix.length) : instanceId;
}

/**
 * SWE CLIツールの共通インターフェース
 */
export interface ICLITool {
  /** CLIツールの識別子 (claude, codex, gemini, vibe-local, opencode) */
  readonly id: CLIToolType;

  /** CLIツールの表示名 */
  readonly name: string;

  /** CLIツールのコマンド名 */
  readonly command: string;

  /**
   * CLIツールがインストールされているか確認
   * @returns インストールされている場合true
   */
  isInstalled(): Promise<boolean>;

  /**
   * セッションが実行中かチェック
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance.
   * @returns 実行中の場合true
   */
  isRunning(worktreeId: string, instanceId?: string): Promise<boolean>;

  /**
   * 新しいセッションを開始
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktreeのパス
   * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance.
   */
  startSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void>;

  /**
   * メッセージを送信
   * @param worktreeId - Worktree ID
   * @param message - 送信するメッセージ
   * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance.
   */
  sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void>;

  /**
   * セッションを終了
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance.
   */
  killSession(worktreeId: string, instanceId?: string): Promise<void>;

  /**
   * セッション名を取得
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance.
   * @returns セッション名
   */
  getSessionName(worktreeId: string, instanceId?: string): string;

  /**
   * 処理を中断（Escapeキー送信）
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance.
   */
  interrupt(worktreeId: string, instanceId?: string): Promise<void>;
}

/**
 * CLI tool display names for UI rendering
 * Issue #368: Centralized display name mapping
 *
 * Usage: UI display (tab headers, message lists, settings).
 * For internal logs/debug, use tool.name (BaseCLITool.name) instead.
 */
export const CLI_TOOL_DISPLAY_NAMES: Record<CLIToolType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  'vibe-local': 'Vibe Local',
  opencode: 'OpenCode',
  copilot: 'Copilot',
};

/**
 * Check if a string is a valid CLIToolType
 * Issue #368: Type guard for safe casting of untrusted CLI tool ID strings
 *
 * @param value - String to check
 * @returns True if value is a valid CLIToolType
 */
export function isCliToolType(value: string): value is CLIToolType {
  return (CLI_TOOL_IDS as readonly string[]).includes(value);
}

/**
 * Get the display name for a CLI tool ID
 * Issue #368: Centralized display name function for DRY compliance
 *
 * @param id - CLI tool type identifier
 * @returns Human-readable display name
 */
export function getCliToolDisplayName(id: CLIToolType): string {
  return CLI_TOOL_DISPLAY_NAMES[id] ?? id;
}

/**
 * Get the display name for a CLI tool ID string, with fallback for unknown IDs
 * Issue #368: Safe wrapper for UI components receiving untyped cliToolId strings
 *
 * Unlike getCliToolDisplayName(), this accepts optional/untyped strings and
 * returns a fallback value ('Assistant') for null, undefined, or unknown IDs.
 *
 * @param cliToolId - Optional CLI tool ID string (may be untyped)
 * @param fallback - Fallback display name for missing/unknown IDs (default: 'Assistant')
 * @returns Human-readable display name or fallback
 */
export function getCliToolDisplayNameSafe(cliToolId?: string, fallback = 'Assistant'): string {
  if (!cliToolId) return fallback;
  if (isCliToolType(cliToolId)) return getCliToolDisplayName(cliToolId);
  return fallback;
}

/**
 * Resolve a human-readable label for an agent instance (Issue #869).
 *
 * Alias-first: returns the instance alias when it is a non-empty string,
 * otherwise falls back to the backing CLI tool's display name. Use this for all
 * UI surfaces (header badge, terminal tabs, split selector) so additional
 * instances of the same tool remain distinguishable.
 *
 * @param instance - Agent instance (or a minimal `{ cliTool, alias }` shape)
 * @returns Non-empty display label
 */
export function getInstanceLabel(instance: { cliTool: CLIToolType; alias?: string }): string {
  const alias = instance.alias;
  if (typeof alias === 'string' && alias.trim().length > 0) {
    return alias;
  }
  return getCliToolDisplayName(instance.cliTool);
}

/**
 * Build the default set of agent instances from a worktree's selectedAgents
 * (Issue #868 migration / fallback).
 *
 * Each selected tool becomes its own PRIMARY instance (`id === cliTool`), so a
 * worktree with no explicit instance configuration behaves exactly as before.
 *
 * @param selectedAgents - Ordered list of selected CLI tools
 * @returns One primary AgentInstance per selected tool, preserving order
 */
export function agentInstancesFromSelectedAgents(selectedAgents: CLIToolType[]): AgentInstance[] {
  return selectedAgents.map((cliTool, order) => ({
    id: getPrimaryInstanceId(cliTool),
    cliTool,
    alias: getCliToolDisplayName(cliTool),
    order,
  }));
}

/**
 * Minimum context window size for vibe-local.
 * [S1-007] Lower bound rationale: Ollama's actual minimum context window is
 * typically 2048+, but 128 is set as a permissive lower bound to accommodate
 * custom models or future models with smaller contexts. Users are recommended
 * to use practical values (e.g., 2048+).
 * [S1-004] vibe-local specific constant. If more vibe-local constants are added,
 * consider extracting to src/lib/cli-tools/vibe-local-config.ts.
 * [SEC-002] Used to prevent unreasonable values in CLI arguments.
 */
export const VIBE_LOCAL_CONTEXT_WINDOW_MIN = 128;

/**
 * Maximum context window size for vibe-local (2M tokens).
 * Shared between API validation and defense-in-depth (DRY principle).
 * [S1-004] vibe-local specific constant. If more vibe-local constants are added,
 * consider extracting to src/lib/cli-tools/vibe-local-config.ts.
 * [SEC-002] Used to prevent unreasonable values in CLI arguments.
 */
export const VIBE_LOCAL_CONTEXT_WINDOW_MAX = 2097152;

/**
 * Validate vibe-local context window value.
 * Shared between API layer and CLI layer (defense-in-depth).
 * [S1-001] DRY: Single source of truth for context window validation.
 *
 * @param value - Value to validate (accepts unknown for type guard usage)
 * @returns True if value is a valid context window size (integer between MIN and MAX)
 */
export function isValidVibeLocalContextWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= VIBE_LOCAL_CONTEXT_WINDOW_MIN &&
    value <= VIBE_LOCAL_CONTEXT_WINDOW_MAX
  );
}

/**
 * Ollama model name validation pattern (API/DB layer).
 * Requires alphanumeric first character, followed by alphanumeric, dots, underscores,
 * colons, slashes, hyphens. No explicit length limit (DB schema handles storage limits).
 *
 * [SEC-001] Shared between API route validation and CLI command construction.
 *
 * Note: opencode-config.ts has a separate OLLAMA_MODEL_PATTERN with a 100-character
 * length limit (`{1,100}`) for DoS protection when parsing Ollama API responses.
 * The patterns are intentionally different: this one enforces first-character constraints
 * for user-facing validation, while the opencode-config version adds length limits
 * for untrusted external API data.
 */
export const OLLAMA_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

/**
 * Image-capable CLI tool interface (ISP compliant)
 * Issue #474: Extends ICLITool with image sending capability
 * [S1-M1] Separated from ICLITool to follow Interface Segregation Principle
 */
export interface IImageCapableCLITool extends ICLITool {
  /** Returns true to indicate image support */
  supportsImage(): true;
  /**
   * Send a message with an attached image
   * @param worktreeId - Worktree ID
   * @param message - Message text
   * @param imagePath - Absolute path to the image file
   * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance.
   */
  sendMessageWithImage(worktreeId: string, message: string, imagePath: string, instanceId?: string): Promise<void>;
}

/**
 * Type guard to check if a CLI tool supports image sending
 * Issue #474: Used by send/route.ts to determine sending strategy
 *
 * @param tool - CLI tool instance to check
 * @returns True if the tool implements IImageCapableCLITool
 */
export function isImageCapableCLITool(tool: ICLITool): tool is IImageCapableCLITool {
  const candidate = tool as IImageCapableCLITool;
  return typeof candidate.supportsImage === 'function'
    && candidate.supportsImage() === true;
}

/**
 * CLIツール情報
 */
export interface CLIToolInfo {
  /** CLIツールID */
  id: CLIToolType;
  /** 表示名 */
  name: string;
  /** コマンド名 */
  command: string;
  /** インストール済みか */
  installed: boolean;
}

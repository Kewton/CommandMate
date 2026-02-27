/**
 * Type definitions and interfaces for CLI tools
 */

/**
 * CLI Tool IDs constant array
 * T2.1: Single source of truth for CLI tool IDs
 * CLIToolType is derived from this constant (DRY principle)
 */
export const CLI_TOOL_IDS = ['claude', 'codex', 'gemini', 'vibe-local'] as const;

/**
 * CLIツールタイプ
 * Derived from CLI_TOOL_IDS for type safety and sync
 */
export type CLIToolType = typeof CLI_TOOL_IDS[number];

/**
 * SWE CLIツールの共通インターフェース
 */
export interface ICLITool {
  /** CLIツールの識別子 (claude, codex, gemini, vibe-local) */
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
   * @returns 実行中の場合true
   */
  isRunning(worktreeId: string): Promise<boolean>;

  /**
   * 新しいセッションを開始
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktreeのパス
   */
  startSession(worktreeId: string, worktreePath: string): Promise<void>;

  /**
   * メッセージを送信
   * @param worktreeId - Worktree ID
   * @param message - 送信するメッセージ
   */
  sendMessage(worktreeId: string, message: string): Promise<void>;

  /**
   * セッションを終了
   * @param worktreeId - Worktree ID
   */
  killSession(worktreeId: string): Promise<void>;

  /**
   * セッション名を取得
   * @param worktreeId - Worktree ID
   * @returns セッション名
   */
  getSessionName(worktreeId: string): string;

  /**
   * 処理を中断（Escapeキー送信）
   * @param worktreeId - Worktree ID
   */
  interrupt(worktreeId: string): Promise<void>;
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
 * Ollama model name validation pattern.
 * Allows: alphanumeric start, followed by alphanumeric, dots, underscores, colons, slashes, hyphens.
 * Max 100 characters. Used for defense-in-depth validation at point of use.
 *
 * [SEC-001] Shared between API route validation and CLI command construction
 */
export const OLLAMA_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

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

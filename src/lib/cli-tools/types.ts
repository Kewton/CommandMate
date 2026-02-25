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

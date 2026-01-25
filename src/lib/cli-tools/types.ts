/**
 * Type definitions and interfaces for CLI tools
 */

/**
 * CLIツールタイプ
 */
export type CLIToolType = 'claude' | 'codex' | 'gemini';

/**
 * SWE CLIツールの共通インターフェース
 */
export interface ICLITool {
  /** CLIツールの識別子 (claude, codex, gemini) */
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

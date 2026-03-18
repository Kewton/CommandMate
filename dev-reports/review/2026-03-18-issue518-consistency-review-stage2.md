# Architecture Review: Issue #518 - Stage 2 整合性レビュー

## Executive Summary

Issue #518 CLI基盤コマンド設計方針書と既存コードベースの整合性レビューを実施した。設計書は全体的に既存アーキテクチャを正しく理解した上で書かれているが、サーバーAPIの実際のリクエスト/レスポンス形状との不一致が複数箇所で検出された。特に、CLI側で定義する型がサーバー側の実態を正確に反映していない点は、実装フェーズで混乱を招く可能性が高い。

**Status**: conditionally_approved
**Score**: 3/5

| 重要度 | 件数 |
|--------|------|
| Must Fix | 3 |
| Should Fix | 6 |
| Nice to Have | 3 |
| **合計** | **12** |

---

## Detailed Findings

### Must Fix (3 items)

#### DR2-01: WaitExitCode.ERROR = 1 が ExitCode.DEPENDENCY_ERROR = 1 と衝突

- **設計書**: WaitExitCode = { SUCCESS: 0, ERROR: 1, PROMPT_DETECTED: 10, TIMEOUT: 124 }
- **実装**: ExitCode = { SUCCESS: 0, DEPENDENCY_ERROR: 1, CONFIG_ERROR: 2, START_FAILED: 3, STOP_FAILED: 4, UNEXPECTED_ERROR: 99 }
- **問題**: WaitExitCode.ERROR (1) と ExitCode.DEPENDENCY_ERROR (1) が同値。DR1-03の判定ツリーでは「インフラエラーにはExitCodeを使用」とあるが、WaitExitCodeにもERROR: 1が存在し、呼び出し元で区別不可能。
- **対応案**: WaitExitCodeからERRORを削除し、{ SUCCESS: 0, PROMPT_DETECTED: 10, TIMEOUT: 124 } のみに絞る。エラー系は既存ExitCodeを使う旨を明記する。

#### DR2-02: auto-yes APIのdurationパラメータ型不一致 (CLI: string, Server: number)

- **設計書**: CLI側DURATION_MAP = { '1h': 3600000, ... }、AutoYesOptions.duration: string
- **実装**: auto-yes/route.ts は body.duration を数値 (3600000等) で受け取り、isAllowedDuration()で数値チェック
- **問題**: 設計書のApiClient使用例 `client.post('/auto-yes', { enabled, duration })` ではdurationの型変換が不明瞭。
- **対応案**: auto-yesコマンド実装仕様にparseDurationToMs()による変換を明記。API呼び出し例も `{ enabled, duration: parseDurationToMs(options.duration) }` に修正。

#### DR2-03: CurrentOutputResponse型に6フィールド不足

- **設計書**: 11フィールド定義
- **実装**: 追加で fullOutput, lastCapturedLine, thinkingMessage, isSelectionListActive, lastServerResponseTimestamp, serverPollerActive の6フィールドを返却。autoYes型も { enabled } ではなく { enabled, expiresAt, stopReason } を返す。
- **問題**: waitコマンドの完了判定やcaptureコマンドの出力に影響するフィールドが型に含まれていない。
- **対応案**: CurrentOutputResponse型に不足フィールドを追加。CLI未使用分はoptionalで良いが、型としてサーバー実態を正確に反映すべき。

### Should Fix (6 items)

#### DR2-04: middleware.ts Bearer認証が未実装 (設計の前提条件)

設計書Section 2-3で「前提実装」として記載されたBearer認証サポートが現在のmiddleware.tsに存在しない。Cookie認証のみ実装されており、認証失敗時は常に/loginへリダイレクト。設計書に実装順序の明記とチェックリストへの追加を推奨。

#### DR2-05: send APIのリクエストボディキーが不一致

設計書: `{ message }` / 実装: `{ content }` (SendMessageRequest.content)。レスポンスも void ではなく ChatMessage (status 201)。

#### DR2-06: prompt-response APIのリクエスト/レスポンス形状が未記載

実装は answer に加えて cliTool, promptType, defaultOptionNumber を受け付け、{ success, answer, reason? } を返す。設計書には answer のみ記載。

#### DR2-07: tsconfig.cli.json の include スコープ外からの相対インポート問題

設計書では `isCliToolType()` を相対インポートすると記載しているが、src/lib/cli-tools/types.ts は tsconfig.cli.json の include (src/cli/**/*) 範囲外。

#### DR2-08: WorktreeItem.branch フィールドがサーバーの Worktree 型に存在しない

サーバーの Worktree 型には name フィールドがあり、これがブランチ名に相当するが、フィールド名が異なる。

#### DR2-09: sessionStatusByCli フィールドが WorktreeItem に未定義

サーバーレスポンスにはCLIツール別のセッションステータスが含まれるが、設計書のWorktreeItemにはトップレベルの集約値のみ定義。

### Nice to Have (3 items)

#### DR2-10: 既存CLIパターン対比の記載強化

startCommand() (直接関数export) と createIssueCommand() (factory) の具体的差異を設計書に追記すると実装者の理解が深まる。

#### DR2-11: send API のセッション自動起動副作用が設計書に未記載

send API はセッション未起動時に自動起動するが、この動作が設計書に明記されていない。

#### DR2-12: CLI --agent オプションと API cliToolId のマッピング表が未掲載

複数コマンドで共通する --agent から cliToolId への変換が暗黙的。対応表の追加を推奨。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| 技術的リスク | API型不一致による実装時の手戻り | Medium | High | P1 |
| 技術的リスク | tsconfig.cli.json スコープ外インポート | Medium | Medium | P2 |
| 運用リスク | middleware Bearer認証の実装順序混乱 | Medium | Medium | P2 |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

1. WaitExitCode からERROR: 1 を削除し、ExitCodeとの衝突を解消する
2. auto-yes API のduration型変換フローを明記する
3. CurrentOutputResponse型をサーバー実態に合わせて更新する

### 推奨改善項目 (Should Fix)

1. send APIのリクエストキーを content に修正し、レスポンス型を ChatMessage に修正する
2. prompt-response APIの完全なリクエスト/レスポンス仕様を追記する
3. tsconfig.cli.json のincudeスコープ拡張または型複製の方針を決定する
4. WorktreeItem.branch を name に修正する
5. sessionStatusByCli を WorktreeItem に追加する
6. middleware.ts Bearer対応の実装順序を明記する

### 検討事項 (Consider)

1. CLI オプション名とAPIボディキーの対応表を追加する
2. send API のセッション自動起動動作を明記する
3. 既存CLIパターンの対比をより明確にする

---

## Reviewed Files

| ファイル | 確認内容 |
|---------|---------|
| `dev-reports/design/issue-518-cli-base-commands-design-policy.md` | 設計方針書全体 |
| `src/cli/types/index.ts` | ExitCode enum、既存Options型 |
| `src/cli/index.ts` | コマンド登録パターン (inline vs addCommand) |
| `src/cli/commands/start.ts` | 既存コマンド実装パターン (直接関数export) |
| `src/cli/commands/issue.ts` | Factory パターン実装 (createIssueCommand) |
| `src/types/models.ts` | Worktree, PromptData, ChatMessage 型定義 |
| `src/middleware.ts` | 認証ミドルウェア (Cookie認証のみ、Bearerなし) |
| `src/lib/security/auth.ts` | トークン認証コア |
| `src/lib/cli-tools/types.ts` | CLI_TOOL_IDS, CLIToolType, isCliToolType |
| `src/config/auto-yes-config.ts` | ALLOWED_DURATIONS (数値配列), isAllowedDuration |
| `src/app/api/worktrees/route.ts` | GET /api/worktrees レスポンス形状 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | GET current-output レスポンス形状 |
| `src/app/api/worktrees/[id]/send/route.ts` | POST send リクエスト/レスポンス形状 |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | POST auto-yes リクエスト/レスポンス形状 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | POST prompt-response リクエスト/レスポンス形状 |
| `tsconfig.cli.json` | CLI ビルド設定 (include, paths) |
| `tsconfig.base.json` | ベース TS 設定 (@/* paths) |

---

*Reviewed by: Architecture Review Agent*
*Date: 2026-03-18*
*Issue: #518*
*Stage: 2 - 整合性レビュー*

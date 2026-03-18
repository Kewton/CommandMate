# Issue #518 影響範囲レビュー（Stage 3, 1回目）

## 対象Issue
**feat: CLI基盤コマンドの実装（ls / send / wait / respond / capture / auto-yes）**

## レビュー概要

Issue #518 は既存 CLI モジュールに6つの新コマンドを追加する大規模な変更である。既存 CLI コマンド（init, start, stop, status, issue, docs）はローカルプロセス管理が中心だが、新コマンドは全て REST API 呼び出しを行う点で根本的にアーキテクチャが異なる。この影響範囲レビューでは、既存コードベースとの整合性、ビルドシステム、型システム、テスト基盤、セキュリティ、後方互換性の観点から分析を行った。

## 影響を受けるファイル・モジュール一覧

### 直接変更が必要なファイル
| ファイル | 変更内容 |
|---------|---------|
| `src/cli/index.ts` | 6コマンドの追加登録 |
| `src/cli/types/index.ts` | WaitExitCode enum、各コマンドの Options 型追加 |
| `src/cli/commands/` | 6つの新コマンドファイル（ls.ts, send.ts, wait.ts, respond.ts, capture.ts, auto-yes.ts） |
| `src/cli/utils/` | HTTP クライアントユーティリティ（新規） |
| `tsconfig.cli.json` | paths マッピング追加の可能性 |

### 参照される既存APIルート（変更不要）
| APIルート | 呼び出し元コマンド |
|----------|------------------|
| `GET /api/worktrees` | ls |
| `POST /api/worktrees/:id/send` | send |
| `GET /api/worktrees/:id/current-output` | wait, capture |
| `POST /api/worktrees/:id/prompt-response` | respond |
| `POST /api/worktrees/:id/auto-yes` | auto-yes, send (--auto-yes) |

### 参照される既存型定義（変更不要）
| 型 | 使用箇所 |
|---|---------|
| `PromptData` (src/types/models.ts) | wait コマンドの stdout 出力 |
| `CLI_TOOL_IDS` / `CLIToolType` (src/lib/cli-tools/types.ts) | send --agent のバリデーション |
| `ALLOWED_DURATIONS` (src/config/auto-yes-config.ts) | send --duration のバリデーション |

## 検出事項サマリー

| 重要度 | 件数 |
|--------|------|
| must_fix | 2 |
| should_fix | 6 |
| nice_to_have | 3 |
| **合計** | **11** |

## must_fix（修正必須）

### F3-01: tsconfig.cli.json の include 範囲が新コマンドの外部型依存をカバーしない

**影響ファイル:** tsconfig.cli.json, src/types/models.ts, src/config/auto-yes-config.ts

tsconfig.cli.json の include は `src/cli/**/*` のみで、paths マッピングは空オブジェクト `{}` に設定されている。新コマンドは `src/types/models.ts` の PromptData 型や `src/config/auto-yes-config.ts` の ALLOWED_DURATIONS を参照する必要がある。既存コードは相対パス（`../../lib/security/auth`）で外部モジュールをインポートしているが、新コマンドは参照先が多岐にわたるため保守性が低下する。

**推奨対応:** tsconfig.cli.json の paths に `"@/*": ["./src/*"]` を追加し、tsc-alias を build:cli スクリプトに組み込む（tsconfig.server.json と同じパターン）。または既存パターンに合わせて相対パスで統一する方針を Issue に明記する。

### F3-02: CLI から REST API を呼ぶ HTTP クライアントユーティリティが存在しない

**影響ファイル:** src/cli/utils/（新規）, package.json

既存 CLI コマンドは全てローカルプロセス管理で完結しており、HTTP リクエストを送信するコードが一切存在しない。新コマンド群は全て REST API 呼び出しが必要であり、HTTP クライアントの実装方針（Node.js 組み込み fetch vs 外部ライブラリ）、共通エラーハンドリング、ベース URL 構築ロジックの設計について Issue に記載がない。

**推奨対応:** Issue に HTTP クライアントユーティリティの設計セクションを追加する。Node.js 18+ 組み込み fetch の使用（新規依存不要）を推奨し、`src/cli/utils/api-client.ts` として共通化する方針を記載する。

## should_fix（修正推奨）

### F3-03: ls コマンドの「エージェント種別」フィールドマッピングが不明確

GET /api/worktrees レスポンスの `cliToolId` フィールドと ls コマンドの「エージェント種別」の対応関係を Issue に明記すべき。

### F3-04: wait コマンドの完了判定に使う current-output API フィールドが未指定

current-output API のレスポンスフィールド（`isRunning`, `isPromptWaiting`, `isGenerating` 等）と wait コマンドの終了条件の具体的なマッピングを明記すべき。

### F3-05: index.ts への6コマンド追加によるファイル肥大化

新コマンドは `program.addCommand()` パターン（issue/docs と同じ）で追加する方針を推奨。

### F3-06: WaitExitCode と既存 ExitCode の統合方針が不明確

WaitExitCode は wait 専用、他の新コマンドは ExitCode を使用する方針を明記すべき。

### F3-07: send コマンドが呼ぶ API の副作用（セッション自動起動等）への言及不足

POST /api/worktrees/:id/send はセッション自動起動・ポーリング開始等の副作用を持つ。CLI からの呼び出しにおける期待動作を明記すべき。

### F3-08: HTTP モックを使ったテストパターンがプロジェクト内に存在しない

新コマンドのテストには fetch モックが必要だが、既存 CLI テストにそのパターンがない。vi.fn() による global.fetch モックの方針を記載すべき。

## nice_to_have（あれば望ましい）

### F3-09: wait コマンドのポーリングによるサーバー負荷

tmux-capture-cache（TTL=2s）により影響は限定的だが、複数 worktree 同時 wait 時の並列ポーリング方針を記載すべき。

### F3-10: npm パッケージビルド時の外部型出力確認

build:cli が外部依存ファイルを正しく dist/ に出力することの確認手順を受け入れ条件に追加推奨。

### F3-11: 認証トークン設定ファイル読み込み（優先順位3）のスコープ

.commandmate/config.json は現在存在しないため、Phase 1 では --token と CM_AUTH_TOKEN のみに絞るのが現実的。

## 後方互換性

既存コマンド（`commandmate start / stop / status / init / issue / docs`）との共存に問題はない。新コマンドは全て新規コマンド名（ls, send, wait, respond, capture, auto-yes）であり、既存コマンド名との衝突はない。`bin/commandmate.js` のエントリポイント構造も変更不要。

## 破壊的変更

なし。新コマンドの追加のみで、既存の API ルート・DB スキーマ・型定義への変更は不要。

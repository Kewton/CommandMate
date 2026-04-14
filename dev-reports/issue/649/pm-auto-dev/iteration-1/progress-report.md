# 進捗レポート: Issue #649 - アシスタントチャット機能

## 1. 概要

| 項目 | 内容 |
|------|------|
| **Issue番号** | #649 |
| **タイトル** | アシスタントチャット機能（Home画面） |
| **イテレーション** | 1 |
| **ブランチ** | `feature/649-worktree` |
| **ステータス** | SUCCESS（全フェーズ完了） |
| **レポート日時** | 2026-04-14 |

### 概要

Home画面に worktree 非依存のグローバル CLI セッション（アシスタントチャット）を追加する機能を実装。CLI ツール（Claude / Codex / Copilot 等）を登録済みリポジトリ情報と共に起動し、Home 画面のチャット UI から対話できるようにする。セッションは `__global__` 仮想 worktree ID で管理し、既存 worktree セッションや DB とは独立。

---

## 2. フェーズ別結果

### 2-1. TDDフェーズ

| 項目 | 結果 |
|------|------|
| ステータス | SUCCESS |
| 実装ファイル数 | 17件 |
| 新規テストファイル数 | 3件 |
| 新規テスト数 | 26件（全件パス） |
| ESLintエラー | 0件 |
| TypeScriptエラー | 0件 |
| Unit Test | 334ファイル / 6319件パス / 0件失敗 / 7スキップ |
| コミット | `38ec3c95: feat(assistant): implement assistant chat feature for Home page` |

#### 主要実装ファイル

**バックエンド**
- `src/lib/session/global-session-constants.ts` - グローバルセッション定数（`__global__` ID・ポーリング間隔）
- `src/types/assistant.ts` - アシスタントチャット関連型定義
- `src/lib/polling/global-session-poller.ts` - グローバルセッション専用ポーリング（`pollGlobalSession`）
- `src/lib/assistant/context-builder.ts` - CLI起動時コンテキスト生成（`buildGlobalContext`）
- `src/lib/session-cleanup.ts` - `cleanupGlobalSessions()` 追加、`syncWorktreesAndCleanup()` から呼び出し
- `src/lib/session/worktree-status-helper.ts` - `__global__` ID早期リターン（サイドバー除外）
- `src/app/api/assistant/start/route.ts` - POST セッション開始
- `src/app/api/assistant/terminal/route.ts` - POST メッセージ送信
- `src/app/api/assistant/current-output/route.ts` - GET ターミナル出力取得
- `src/app/api/assistant/session/route.ts` - DELETE セッション停止
- `src/lib/api/assistant-api.ts` - 型安全なクライアントAPI

**フロントエンド**
- `src/components/home/AssistantMessageInput.tsx` - 送信専用入力（IMEガード）
- `src/components/home/AssistantChatPanel.tsx` - 折りたたみ可能パネル・リポジトリ/ツール選択・ポーリング・セッション制御
- `src/app/page.tsx` - Home画面統合

### 2-2. 受入テストフェーズ

| 項目 | 結果 |
|------|------|
| ステータス | PASSED |
| 受入条件合格数 | 17 / 17件（100%） |
| ESLint | passed |
| Type Check | passed |
| Unit Tests | passed（334ファイル / 6319件） |

#### 受入条件別サマリー（全17件PASSED）

1. Home画面でアシスタントチャットが利用できる
2. 登録済みリポジトリから作業ディレクトリを選択できる
3. インストール済みの全CLIツールから選択してセッションを開始できる
4. セッション開始時にCLI使い方・リポジトリ情報がコンテキストとして付与される
5. メッセージの送受信が正常に動作する
6. アシスタントのターミナル出力がリアルタイムに表示される
7. キャプチャ間隔が既存capture APIと同等（2000ms）
8. セッション停止ボタンからグローバルセッションを停止できる
9. セッション実行中のリポジトリ変更時に確認ダイアログ表示
10. サーバー再起動時に孤立した `mcbd-{cli}-__global__` セッションがクリーンアップされる
11. グローバルセッションがサイドバーworktree一覧に表示されない
12. チャットUIの折りたたみ/展開（localStorage永続化）
13. 既存worktreeセッション機能への影響なし（回帰テストパス）
14. ダークモード対応（dark:クラス適用箇所多数）
15. モバイルレイアウト対応（flex-wrap / truncate / maxHeight:50vh）
16. `/api/assistant/*` が認証ミドルウェアで保護されている
17. npm run lint / tsc --noEmit / test:unit 全パス

#### 指摘事項（low）

- CLIツール選択UIが全ツール表示のままインストール済みフィルタリングされていない（サーバー側で `isInstalled()` チェックはあるため機能的には問題なし）→ **リファクタリングフェーズで対応**

### 2-3. リファクタリングフェーズ

| 項目 | 結果 |
|------|------|
| ステータス | SUCCESS |
| ESLint/Type | 0エラー |
| Unit Test | 6319件パス維持 |

#### 主な改善

1. **GET /api/assistant/tools エンドポイント追加**
   - `src/app/api/assistant/tools/route.ts` 新規追加
   - `CLIToolManager.getAllToolsInfo()` で各ツールのインストール状態を取得
2. **assistantApi.getInstalledTools() 追加**
   - `AssistantToolInfo` 型追加
3. **AssistantChatPanel UX改善**
   - `availableTools` stateでマウント時にインストール状態取得
   - 未インストールツールを `(not installed)` 表示で disabled 化
   - `CLI_TOOL_IDS` ハードコードから動的取得に置換

### 2-4. ドキュメント更新フェーズ

- `CLAUDE.md` の更新（モジュール一覧へのアシスタントチャット関連エントリ追加）

---

## 3. 総合品質メトリクス

| メトリクス | 値 | 判定 |
|-----------|-----|------|
| ESLintエラー | 0件 | OK |
| TypeScriptエラー | 0件 | OK |
| Unit Test パス率 | 6319 / 6319 (100%) | OK |
| Unit Test ファイル数 | 334ファイル | - |
| 新規テスト合格数 | 26 / 26 (100%) | OK |
| 受入条件合格率 | 17 / 17 (100%) | OK |
| テストカバレッジ（TDD結果） | 80% | OK |
| 実装ファイル数 | 17件（新規14 + 変更3） | - |
| コミット数 | 2件（実装1 + dev-reports 1） | - |

### 品質特記事項

- **回帰なし**: 既存の334テストファイルが全件パス（ファイル基盤・tmux基盤・CLIツール基盤に回帰なし）
- **セキュリティ**: `/api/assistant/*` は認証ミドルウェアで保護（auth-config除外パス外）
- **リソースリーク対策**: `syncWorktreesAndCleanup()` 経由で孤立グローバルセッション自動クリーンアップ
- **サイドバー非影響**: `__global__` ID早期リターンでworktree一覧から除外
- **アクセシビリティ**: ダークモード・モバイルレイアウト対応済み

---

## 4. ブロッカー

**現時点でブロッカーなし**

受入テストで指摘された low severity 事項（CLIツールUIフィルタリング）はリファクタリングフェーズで解消済み。設計通りの実装が完了しており、機能的・品質的・セキュリティ的な阻害要因は存在しない。

---

## 5. 次のステップ

### 推奨アクション（優先度順）

1. **[推奨] PR作成**
   - `feature/649-worktree` から `develop` へのPR作成
   - `/create-pr` コマンドの利用を推奨
   - PRタイトル案: `feat(assistant): add home-page assistant chat with global CLI session`
   - 付与ラベル: `feature`

2. **[任意] 統合テスト/E2Eテストの追加検討**
   - 現状はunit testとacceptance testのみ
   - 複数CLIツールでの起動・停止シナリオ、セッション孤立リカバリシナリオをE2Eで検証すると堅牢性が増す

3. **[任意] ドキュメント追記**
   - `docs/implementation-history.md` にIssue #649エントリ追加
   - `docs/user-guide/` にアシスタントチャット使用ガイド追加（ユーザー向け説明）

4. **[任意] UAT（実機受入テスト）の実行**
   - `/uat` コマンドで、実際のClaude/Codex/Copilotセッション起動・操作を確認
   - モバイル実機での折りたたみ・リポジトリ変更ダイアログの挙動確認

### 次イテレーションへの持ち越し

**なし**（全受入条件PASSED・全品質ゲート通過のため、本Issueの実装タスクは完了）

---

## 6. 参考情報

### 関連ファイル

- コンテキスト: `dev-reports/issue/649/pm-auto-dev/iteration-1/progress-context.json`
- TDD結果: `dev-reports/issue/649/pm-auto-dev/iteration-1/tdd-result.json`
- 受入結果: `dev-reports/issue/649/pm-auto-dev/iteration-1/acceptance-result.json`
- リファクタ結果: `dev-reports/issue/649/pm-auto-dev/iteration-1/refactor-result.json`

### 関連コミット

- `38ec3c95` - feat(assistant): implement assistant chat feature for Home page
- `db97cbd8` - chore(issue-649): add dev-reports (issue-review, work-plan, tdd, acceptance)

# 進捗レポート - Issue #368 (Iteration 1)

## 概要

**Issue**: #368 - feat: CMATEタブにAgent設定タブを追加し、表示するコーディングエージェントを選択可能にする
**Iteration**: 1
**報告日時**: 2026-02-25
**ステータス**: 成功 (コアロジック実装完了)
**ブランチ**: `feature/368-worktree`

---

## フェーズ別結果

### Phase 1: TDD実装

**ステータス**: 成功

- **テスト結果**: 3982 passed / 0 failed / 7 skipped (total: 3989)
- **新規テスト追加**: 30件
- **静的解析**: TypeScript 0 errors, ESLint 0 errors

**新規作成ファイル**:

| ファイル | 説明 |
|---------|------|
| `src/lib/selected-agents-validator.ts` | エージェント選択バリデーション (parseSelectedAgents, validateSelectedAgentsInput, validateAgentsPair) |
| `src/lib/cli-tools/vibe-local.ts` | VibeLocalTool スタブ実装 (tmuxセッション管理) |
| `tests/unit/selected-agents-validator.test.ts` | バリデーションテスト (23テスト) |
| `tests/unit/cli-tools/display-name.test.ts` | 表示名テスト (7テスト) |

**変更ファイル**:

| ファイル | 主な変更 |
|---------|---------|
| `src/lib/cli-tools/types.ts` | CLI_TOOL_IDS に 'vibe-local' 追加、getCliToolDisplayName() 追加 |
| `src/lib/cli-tools/manager.ts` | VibeLocalTool 登録 |
| `src/lib/db-migrations.ts` | Migration v18: selected_agents カラム追加 |
| `src/lib/db.ts` | getWorktreeById/getWorktrees に selectedAgents 追加、updateSelectedAgents() 追加 |
| `src/app/api/worktrees/[id]/route.ts` | GET/PATCH に selectedAgents 対応、isValidWorktreeId チェック追加 |
| `src/app/api/worktrees/route.ts` | CLI_TOOL_IDS ベースのハードコード除去 |
| `src/types/models.ts` | sessionStatusByCli/lastMessagesByCli を Partial<Record<CLIToolType,...>> に変更 |
| `src/types/sidebar.ts` | cliStatus を Partial<Record<CLIToolType, BranchStatus>> に変更 |
| `src/components/sidebar/BranchListItem.tsx` | cliStatus にオプショナルチェーン追加 |
| `src/lib/api-client.ts` | CLIToolType 型使用に統一 |

**コミット**:
- `c10591f`: feat(368): add agent settings core - validator, display names, DB migration, API, vibe-local

---

### Phase 2: 受入テスト

**ステータス**: 全基準クリア (12/12)

| # | 受入基準 | 結果 |
|---|---------|------|
| 1 | selected-agents-validator.ts が parseSelectedAgents, validateSelectedAgentsInput, validateAgentsPair を実装 | PASSED |
| 2 | CLI_TOOL_IDS に 'vibe-local' を含む | PASSED |
| 3 | getCliToolDisplayName が types.ts に実装済み | PASSED |
| 4 | DB migration v18 (add-selected-agents-column) が存在 | PASSED |
| 5 | GET /api/worktrees/:id が selectedAgents を返す | PASSED |
| 6 | PATCH /api/worktrees/:id が selectedAgents 更新とバリデーションに対応 | PASSED |
| 7 | sessionStatusByCli が Partial<Record<CLIToolType,...>> を使用 | PASSED |
| 8 | Worktree型に selectedAgents フィールドを含む | PASSED |
| 9 | vibe-local ツール実装 (tmuxセッション管理) が存在 | PASSED |
| 10 | テストファイル selected-agents-validator.test.ts が存在 | PASSED |
| 11 | テストファイル display-name.test.ts が存在 | PASSED |
| 12 | デフォルト selectedAgents が ['claude', 'codex'] (後方互換性) | PASSED |

**テスト実行結果**: 3982 passed / 0 failed / 193 test files

---

### Phase 3: リファクタリング

**ステータス**: 成功

| 指標 | Before | After | 改善 |
|------|--------|-------|------|
| テスト数 | 3982 | 3984 | +2 |
| TypeScript errors | 0 | 0 | - |
| ESLint errors | 0 | 0 | - |

**改善内容**:

1. **sidebar.ts toBranchItem() 動的化** -- ハードコードされた claude/codex を selectedAgents ベースの動的ルックアップに置換。サイドバーのステータス表示がユーザーのエージェント選択を反映するよう改善
2. **route.ts PATCH ハンドラの非null アサーション除去** -- `validatedAgents` 変数を型アサーション付きで抽出し、型安全性を向上
3. **JSDoc コメント更新** -- types.ts, manager.ts, models.ts の 3 ファイルで vibe-local を CLI ツール列挙に追加
4. **サイドバーテスト追加** -- selectedAgents ベースの cliStatus 動作を検証する 2 テストを追加

**コミット**:
- `6dc16ec`: refactor(368): improve code quality and consistency

---

## 総合品質メトリクス

| 指標 | 値 | 基準 | 状態 |
|------|---|------|------|
| テスト結果 | 3984 passed / 0 failed | 全テスト通過 | OK |
| 新規テスト | 32件 (TDD: 30 + Refactor: 2) | - | OK |
| TypeScript errors | 0 | 0 | OK |
| ESLint errors | 0 | 0 | OK |
| 受入基準達成率 | 12/12 (100%) | 100% | OK |
| 変更規模 | +746 / -69 行 (20 files) | - | - |

---

## ブロッカー

現時点でブロッカーとなる問題はなし。

---

## 残タスク (Iteration 2 以降)

### 優先度: 高

| タスク | 説明 |
|-------|------|
| Phase 4: AgentSettingsPane 新規作成 | UIコンポーネント -- エージェント選択ペイン |
| Phase 4: NotesAndLogsPane 拡張 | Agent サブタブの追加 |
| Phase 4: WorktreeDetailRefactored 動的レンダリング | selectedAgents に基づくUI切り替え |

### 優先度: 中

| タスク | 説明 |
|-------|------|
| Phase 0: 残 API ルートのハードコード除去 | send, current-output, interrupt, auto-yes, cli-tool, start-polling, messages ルート (11ファイル) |
| Phase 0: 表示名統一 | log-manager.ts, standard-commands.ts, LogViewer.tsx, MessageList.tsx, AutoYesToggle.tsx |
| Phase 0: ALLOWED_CLI_TOOLS リネーム | INTERACTIVE/NON_INTERACTIVE 分類 |
| Phase 3: switch exhaustive guards | cli-patterns.ts, assistant-response-saver.ts, claude-executor.ts |

### 優先度: 低

| タスク | 説明 |
|-------|------|
| Phase 3: vibe-local 技術調査 | 実際の CLI 仕様確認 |
| Phase 5: API 統合テスト | selected_agents 関連 |
| i18n 対応 | locales/en/schedule.json, locales/ja/schedule.json のエージェントキー追加 |
| R4-003 | BaseCLITool.isInstalled() execFile 移行 |

---

## 次のステップ

1. **Iteration 2 開始** -- Phase 4 の UI コンポーネント実装 (AgentSettingsPane, NotesAndLogsPane 拡張, WorktreeDetailRefactored 動的レンダリング) を優先的に実施
2. **残 API ルートのハードコード除去** -- 11 ファイルの CLI_TOOL_IDS ベース統一を並行して進行
3. **switch exhaustive guards 追加** -- vibe-local 追加に伴う全 switch 文の網羅性保証
4. **PR 作成判断** -- UI コンポーネントが完成次第、レビュー可能な単位で PR を作成

---

## 備考

- Iteration 1 ではコアロジック (バリデーション、DB マイグレーション、API、型定義) を全て完了
- 全ての受入基準 (12/12) を達成
- 既存テストへの回帰なし (3982 既存テスト全通過)
- UI コンポーネントの実装は Iteration 2 に計画的に延期

**Issue #368 Iteration 1 のコアロジック実装が完了しました。**

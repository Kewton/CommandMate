# 作業計画書: Issue #547

## Issue: fix: Copilot CLIのデフォルトスラッシュコマンドと選択ウィンドウが動作しない
**Issue番号**: #547
**サイズ**: M
**優先度**: Medium
**依存Issue**: #545（Copilot CLI対応 - 完了済み）
**ブランチ**: `feature/547-copilot-slash-commands`（作成済み）

---

## 詳細タスク分解

### Phase 1: パターン定義とビルトインコマンド（コア実装）

#### Task 1.1: COPILOT_SELECTION_LIST_PATTERN の定義
- **成果物**: `src/lib/detection/cli-patterns.ts`
- **依存**: なし
- **内容**:
  - `COPILOT_SELECTION_LIST_PATTERN` を新規追加
  - Copilot CLIの`/model`実行時の選択リスト表示パターンを定義
  - 既存placeholder パターン（COPILOT_PROMPT_PATTERN, COPILOT_THINKING_PATTERN等）の確認・必要に応じて更新
  - `COPILOT_SKIP_PATTERNS` に選択リスト関連パターン追加（必要に応じて）
- **セキュリティ**: [SEC4-001/002] ReDoS安全性検証、アンカー(`^`)保持、`/g`フラグ不使用

#### Task 1.2: getCopilotBuiltinCommands() の追加
- **成果物**: `src/lib/slash-commands.ts`
- **依存**: なし
- **内容**:
  - `getCopilotBuiltinCommands(): SlashCommand[]` 関数を追加
  - `/model` コマンドを `cliTools: ['copilot']`, `source: 'builtin'`, `category: 'standard-config'` で定義
  - `filePath: ''`（ビルトイン）- 下流コードでの空文字列処理を確認 [DR2-005]
  - `getSlashCommandGroups()` の**両ブランチ**（basePath/cache）で `deduplicateByName()` の第1引数にビルトインを含める [DR2-001]

#### Task 1.3: STATUS_REASON定数とSELECTION_LIST_REASONS Set追加
- **成果物**: `src/lib/detection/status-detector.ts`
- **依存**: Task 1.1
- **内容**:
  - `STATUS_REASON` に `COPILOT_SELECTION_LIST: 'copilot_selection_list'` を追加
  - `SELECTION_LIST_REASONS` Set定数を定義（OpenCode + Claude + Copilot）
  - `detectSessionStatus()` に Step 1.6（Copilot選択リスト検出）を追加
  - `cliToolId === 'copilot'` ガード条件を必ず含める [DR2-004]

#### Task 1.4: current-output/route.ts の更新（Task 1.3と同一コミット）
- **成果物**: `src/app/api/worktrees/[id]/current-output/route.ts`
- **依存**: Task 1.3
- **内容**:
  - 既存のOR条件チェーン（`=== OPENCODE_SELECTION_LIST || === CLAUDE_SELECTION_LIST`）を `SELECTION_LIST_REASONS.has()` に置換
  - `SELECTION_LIST_REASONS` を `status-detector.ts` からimport
- **重要**: [IA3-001] Task 1.3と**同一コミット**で実施すること

### Phase 2: テスト実装（TDD Red-Green）

#### Task 2.1: cli-patterns 選択リストパターンテスト
- **成果物**: `tests/unit/cli-patterns-selection.test.ts`（既存ファイルに追加）
- **依存**: Task 1.1
- **内容**:
  - `COPILOT_SELECTION_LIST_PATTERN` の正例テスト（選択リスト表示時にマッチ）
  - 負例テスト（通常会話、thinking状態ではマッチしない）

#### Task 2.2: status-detector 選択リスト検出テスト
- **成果物**: `tests/unit/status-detector-selection.test.ts`（既存ファイルに追加）
- **依存**: Task 1.3
- **内容**:
  - Copilot選択リスト検出 → `waiting` + `COPILOT_SELECTION_LIST` テスト
  - [IA3-004] `cliToolId='claude'` でCopilotパターン入力時に `copilot_selection_list` にならない負例テスト
  - [IA3-004] `STATUS_REASON.COPILOT_SELECTION_LIST` 定数存在確認テスト
  - `SELECTION_LIST_REASONS` Setの内容確認テスト

#### Task 2.3: slash-commands ビルトインコマンドテスト
- **成果物**: `tests/unit/lib/slash-commands.test.ts`（既存ファイルに追加）
- **依存**: Task 1.2
- **内容**:
  - `getCopilotBuiltinCommands()` の返却値検証（name, cliTools, source, category）
  - `getSlashCommandGroups()` にCopilotビルトインが含まれることの確認
  - `filterCommandsByCliTool()` でCopilot指定時にビルトインが返却される確認

#### Task 2.4: response-cleaner テスト（必要に応じて）
- **成果物**: `tests/unit/lib/response-cleaner.test.ts`
- **依存**: Task 1.1
- **内容**:
  - `COPILOT_SKIP_PATTERNS` を更新した場合、`cleanCopilotResponse()` のテスト追加

### Phase 3: 検証・品質チェック

#### Task 3.1: 回帰テスト実行
- **依存**: Phase 1, Phase 2 完了
- **内容**:
  - `npm run test:unit` 全テストパス確認
  - `npx tsc --noEmit` 型エラー0件確認
  - `npm run lint` ESLintエラー0件確認
  - `npm run build` ビルド成功確認

#### Task 3.2: 既存テスト影響確認
- **依存**: Task 3.1
- **内容**:
  - 既存OpenCode/Claude選択リストテストが影響を受けないこと
  - 既存Copilotテスト（`tests/unit/cli-tools/copilot.test.ts`）が影響を受けないこと
  - CLI waitコマンドの `copilot_selection_list` reason時の動作確認 [IA3-002]

---

## タスク依存関係

```
Task 1.1 (パターン定義)     Task 1.2 (ビルトインコマンド)
    │                            │
    ├──→ Task 2.1 (パターンテスト)  ├──→ Task 2.3 (コマンドテスト)
    │                            │
    ├──→ Task 1.3 (STATUS_REASON + 検出ロジック)
    │         │
    │         ├──→ Task 1.4 (route.ts) [同一コミット]
    │         │
    │         └──→ Task 2.2 (検出テスト)
    │
    └──→ Task 2.4 (cleanerテスト)
                    │
                    └──→ Task 3.1 (回帰テスト) → Task 3.2 (影響確認)
```

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| ESLint | `npm run lint` | エラー0件 |
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |

---

## 成果物チェックリスト

### コード
- [ ] `src/lib/detection/cli-patterns.ts` - COPILOT_SELECTION_LIST_PATTERN追加
- [ ] `src/lib/slash-commands.ts` - getCopilotBuiltinCommands()追加、getSlashCommandGroups()統合
- [ ] `src/lib/detection/status-detector.ts` - STATUS_REASON追加、SELECTION_LIST_REASONS Set追加、検出分岐追加
- [ ] `src/app/api/worktrees/[id]/current-output/route.ts` - SELECTION_LIST_REASONS.has()に置換

### テスト
- [ ] `tests/unit/cli-patterns-selection.test.ts` - Copilotパターンテスト追加
- [ ] `tests/unit/status-detector-selection.test.ts` - Copilot検出テスト追加
- [ ] `tests/unit/lib/slash-commands.test.ts` - ビルトインコマンドテスト追加

### レビュー指摘対応チェック
- [ ] [DR1-004] SELECTION_LIST_REASONS Set定数でOR条件を置換
- [ ] [DR2-001] getSlashCommandGroups()の両ブランチにCopilotビルトイン統合
- [ ] [DR2-004] cliToolId === 'copilot' ガード条件追加
- [ ] [IA3-001] Set定数導入とOR条件置換を同一コミットで実施
- [ ] [IA3-003] source: 'builtin' フィールド設定
- [ ] [IA3-004] cliToolIdガードの負例テスト追加
- [ ] [SEC4-001/002] ReDoS安全性検証

---

## Definition of Done

- [ ] すべてのタスクが完了
- [ ] CIチェック全パス（lint, type-check, test, build）
- [ ] 設計レビュー指摘事項のチェックリスト全項目対応
- [ ] 既存テストに回帰なし

---

## 次のアクション

1. **TDD実装開始**: `/pm-auto-dev 547`
2. **進捗報告**: `/progress-report`
3. **PR作成**: `/create-pr`

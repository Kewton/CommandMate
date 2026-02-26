# Issue #368 仮説検証レポート

## 検証日時
- 2026-02-25

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `CLI_TOOL_IDS` に `['claude', 'codex', 'gemini']` が定義されている | Confirmed | `src/lib/cli-tools/types.ts` L9で確認 |
| 2 | UIでは `claude` と `codex` のみハードコード表示 | Confirmed | `WorktreeDetailRefactored.tsx` L1795, L2081に `(['claude', 'codex'] as const)` を確認 |
| 3 | UIハードコード箇所: L1795, L2081 | Confirmed | grepで両行を確認 |
| 4 | CMATEタブ実装: `NotesAndLogsPane.tsx`（Notes/Logsのみ） | Confirmed | `SubTab = 'notes' \| 'logs'` を確認、Agentタブなし |
| 5 | `ALLOWED_CLI_TOOLS` が `claude-executor.ts` に存在し拡張が必要 | Confirmed | `claude-executor.ts` L33: `new Set(['claude', 'codex'])` 確認 |
| 6 | vibe-localはPythonスクリプトのため起動コマンドが異なる可能性 | Unverifiable | コードベース外（外部リポジトリ）の情報のため検証不可 |
| 7 | worktreesテーブルに `selected_agents` カラムが存在しない（追加が必要） | Confirmed | 最新マイグレーション（`db-migrations.ts`）を確認、カラムなし |
| 8 | vibe-localがコードベースに未実装 | Confirmed | `src/lib/cli-tools/` 以下にvibe-local関連ファイルなし |

## 詳細検証

### 仮説 1: CLI_TOOL_IDS の定義

**Issue内の記述**: 「現在 `CLI_TOOL_IDS` には `['claude', 'codex', 'gemini']` が定義されているが」

**検証手順**:
1. `src/lib/cli-tools/types.ts` を確認

**判定**: Confirmed

**根拠**:
```typescript
// src/lib/cli-tools/types.ts L9
export const CLI_TOOL_IDS = ['claude', 'codex', 'gemini'] as const;
```

**Issueへの影響**: なし（正確）

---

### 仮説 2・3: UIハードコード

**Issue内の記述**: 「UIでは `claude` と `codex` のみハードコード表示」「L1795付近、L2081付近」

**検証手順**:
1. `WorktreeDetailRefactored.tsx` をgrepで確認

**判定**: Confirmed

**根拠**:
- L1795: `{(['claude', 'codex'] as const).map((tool) => {`（デスクトップ用）
- L2081: `{(['claude', 'codex'] as const).map((tool) => {`（モバイル用）

**Issueへの影響**: なし（正確）

---

### 仮説 4: CMATEタブ（NotesAndLogsPane.tsx）

**Issue内の記述**: 「現在のCMATEタブ（Notes / Logs）に3つ目のサブタブ「Agent」を追加する」

**検証手順**:
1. `src/components/worktree/NotesAndLogsPane.tsx` を確認

**判定**: Confirmed

**根拠**:
```typescript
// NotesAndLogsPane.tsx L21
type SubTab = 'notes' | 'logs';
```
現在 `'agent'` サブタブは存在しない。

**Issueへの影響**: なし（正確）

---

### 仮説 5: ALLOWED_CLI_TOOLS

**Issue内の記述**: 「`src/lib/claude-executor.ts` - `ALLOWED_CLI_TOOLS` を全ツール対応に拡張」

**検証手順**:
1. `src/lib/claude-executor.ts` をgrepで確認

**判定**: Confirmed

**根拠**:
```typescript
// claude-executor.ts L33
export const ALLOWED_CLI_TOOLS = new Set(['claude', 'codex']);
```
`gemini` も `vibe-local` も含まれていない。拡張が必要。

**Issueへの影響**: なし（対応方針は正確）

---

### 仮説 6: vibe-localはPythonスクリプト

**Issue内の記述**: 「vibe-localはPythonスクリプトのため、tmuxセッション起動コマンドが他ツールと異なる可能性がある」

**検証手順**:
1. コードベース内にvibe-local関連の実装なし
2. 外部リポジトリ（https://github.com/ochyai/vibe-local）の情報

**判定**: Unverifiable

**根拠**: コードベース外の情報のため、コードレビューでは検証不可。実装時に要確認。

**Issueへの影響**: 実装時に実際のvibe-localの起動コマンドを確認する必要がある。技術的考慮事項として注記すべき。

---

### 仮説 7: worktreesテーブルへのカラム追加

**Issue内の記述**: 「worktreesテーブルに `selected_agents` カラム追加（JSON文字列）」

**検証手順**:
1. `src/lib/db-migrations.ts` の最新worktreesテーブル定義を確認

**判定**: Confirmed（カラム追加が必要）

**根拠**: 最新のworktreesテーブルカラム:
`id, name, path, repository_path, repository_name, description, last_user_message, last_user_message_at, last_message_summary, favorite, status, link, cli_tool_id, updated_at, last_viewed_at`

`selected_agents` カラムは存在しない。また、現在は `cli_tool_id` という単一ツール用カラムがあり、これとの関係を整理する必要がある。

**Issueへの影響**: 注意点として、既存の `cli_tool_id` との設計上の整合性を確認する必要がある（`selected_agents` と `cli_tool_id` の役割の違いを明確化すべき）。

---

## Stage 1レビューへの申し送り事項

1. **vibe-local起動コマンドの確認**: 実装時にvibe-localが実際にPythonスクリプトかどうか、起動コマンドを確認する必要がある。
2. **`cli_tool_id` と `selected_agents` の設計整合性**: 既存の `cli_tool_id` カラム（単一ツール設定）と新規 `selected_agents` カラム（JSON配列）の役割の違いと共存方針を明確化する必要がある。
3. **`ALLOWED_CLI_TOOLS` の拡張対象**: `claude-executor.ts` の `ALLOWED_CLI_TOOLS` はスケジュール実行での利用ツールの制限であり、UIの選択と連動させるかどうかの方針をIssueに記載する必要がある。

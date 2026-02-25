# Architecture Review Report: Issue #368 Stage 3 (Impact Analysis)

**Issue**: #368 - CMATEタブAgent設定タブ追加
**Focus**: 影響範囲 (Impact Scope)
**Stage**: 3 - 影響分析レビュー
**Date**: 2026-02-25
**Status**: conditionally_approved

---

## Executive Summary

Issue #368 の設計方針書に対して、変更の波及効果を5つの観点（型変更、DB変更、セッション管理、UI、スケジューラー）から分析した。CLIToolType型にvibe-localを追加する変更は40以上のファイルに波及するが、TypeScriptのas const推論によりコンパイル時に大部分の不整合が検出可能である。

2件のmust_fix（変更対象ファイル漏れ）、6件のshould_fix（副作用定義不足、統一方針の曖昧さ等）、3件のnice_to_haveを検出した。Stage 1/Stage 2のレビュー反映により設計品質は高いが、実装前に上記の漏れ対応が必要である。

---

## 1. Type Changes Impact Analysis (型変更の波及)

### 1-1. CLIToolType拡張の影響範囲

`CLI_TOOL_IDS`にvibe-localを追加すると、`CLIToolType`ユニオン型が`'claude' | 'codex' | 'gemini' | 'vibe-local'`に拡張される。以下のカテゴリで波及が発生する。

| カテゴリ | ファイル数 | 設計書カバー | リスク |
|---------|----------|------------|-------|
| 型定義直接参照 | 40+ files | 高 | 低 (コンパイル検出可) |
| ハードコードリテラル配列 | 15 files | 高 | 中 (ランタイムで漏れ) |
| switch文exhaustive check | 5 files | 高 | 低 (never guard導入) |
| UIハードコード | 4 files | 中 | **高** (一部漏れ) |

### 1-2. 設計書から漏れている型変更対象ファイル

以下のファイルが変更対象ファイル一覧（セクション14）から漏れている。

**[R3-001] BranchListItem.tsx (must_fix)**

```typescript
// src/components/sidebar/BranchListItem.tsx L94-95
<CliStatusDot status={branch.cliStatus.claude} label="Claude" />
<CliStatusDot status={branch.cliStatus.codex} label="Codex" />
```

`SidebarBranchItem.cliStatus`の型が`Partial<Record<CLIToolType, BranchStatus>>`に変更されると、`.claude`/`.codex`プロパティアクセスが型エラーにはならないが、undefined可能性が生じる。また、selectedAgentsに基づいて動的にステータスドットを表示する場合、このコンポーネントの変更が必須となる。

**[R3-004] LogViewer.tsx (should_fix)**

```typescript
// src/components/worktree/LogViewer.tsx L36
const [cliToolFilter, setCliToolFilter] = useState<'all' | 'claude' | 'codex' | 'gemini'>('all');
```

vibe-localのログファイルがフィルター選択肢に表示されなくなる。

**[R3-008] worktrees/route.ts sessionStatusByCliローカル型 (should_fix)**

```typescript
// src/app/api/worktrees/route.ts L36-40
const sessionStatusByCli: {
  claude?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
  codex?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
  gemini?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
} = {};
```

worktrees/[id]/route.tsのGETハンドラのR1-002対応と同様の修正が必要だが、worktrees/route.tsは言及されていない。

### 1-3. Exhaustive Check の影響

設計方針書セクション8-4で5箇所のswitch文にnever型ガードを導入する方針は適切。以下の追加確認点がある。

- `cli-patterns.ts` detectThinking(): L151 defaultケースがclaude互換フォールバック。vibe-local追加後もこのフォールバックは安全か?
- `assistant-response-saver.ts` cleanCliResponse(): L198 defaultケースがoutput.trim()。vibe-local用の専用クリーニングが不要であることの確認が必要。

---

## 2. DB Changes Backward Compatibility (DB変更の後方互換性)

### 2-1. selected_agentsカラム追加の影響

| 観点 | 評価 | 備考 |
|------|------|------|
| 既存データへの影響 | 低 | ALTER TABLE ADD COLUMNはSQLiteで安全 |
| マイグレーション後の整合性 | 中 | CASE文でcli_tool_id考慮あり |
| NULL許容 | 安全 | parseSelectedAgents()がnullをデフォルト値にフォールバック |
| 既存APIクライアント影響 | 低 | オプショナルフィールド追加のため後方互換 |

### 2-2. SQL IN句のハードコード (R3-002: must_fix)

```sql
-- src/lib/db.ts L143
AND cli_tool_id IN ('claude', 'codex', 'gemini')
```

このSQL IN句は`getLastMessagesByCliBatch()`内にあり、vibe-localのメッセージが`lastMessagesByCli`から除外される。設計方針書セクション14ではdb.tsの返値型変更は言及されているが、SQL IN句自体の修正は漏れている。

### 2-3. ロールバック戦略 (R3-005: should_fix)

設計方針書にv18マイグレーションのdown関数が未記載。既存パターン（v7, v15等）ではDROP COLUMN制限に対するテーブル再作成パターンまたはログのみの簡易down関数が使用されている。selected_agentsはNULL許容TEXT型で、カラムが残存しても既存処理に影響しないため、簡易down関数が適切。

---

## 3. Session Management Impact (セッション管理の波及)

### 3-1. cli_tool_id自動更新の波及チェーン

```
ユーザー操作: selectedAgents変更
  -> PATCH API: selectedAgents DB更新
  -> 整合性チェック: cli_tool_id not in selectedAgents?
  -> YES -> cli_tool_id自動更新
  -> ??? アクティブセッション・ポーラーの状態は?
```

**[R3-003] 未定義の副作用 (should_fix)**

| 影響コンポーネント | 現状の動作 | 自動更新後のリスク |
|------------------|----------|-----------------|
| tmuxセッション | 旧cli_tool_idのセッション稼働中 | 孤立セッション発生 |
| response-poller | 旧cli_tool_idでポーリング中 | ポーリング対象不整合 |
| auto-yes-poller | 旧cli_tool_idでポーリング中 | 応答先ツール不整合 |
| UIのactiveCliTab | 旧cli_tool_idを表示中 | 表示と実態の不一致 |

設計方針書では`cliToolIdAutoUpdated`フラグでクライアントに通知する方針だが、サーバーサイドでのセッション・ポーラー状態については言及がない。

### 3-2. Auto-Yesポーラーへの影響

Auto-Yesポーラー（`src/lib/auto-yes-manager.ts`）はcliToolIdを保持してポーリングを実行する。selectedAgents変更によるcli_tool_id自動更新が発生しても、既に起動済みのポーラーは旧cliToolIdのまま動作し続ける。これは次回のポーラー開始時に自然解消されるが、一時的な不整合が発生する。

### 3-3. session-cleanup.tsの自動波及 (R3-009: nice_to_have)

`session-cleanup.ts`はCLI_TOOL_IDSをfor...ofで反復するため、vibe-local追加で自動的にクリーンアップ対象に含まれる。VibeLocalToolの実装品質に依存するが、BaseCLIToolのデフォルト実装によりstub段階でも安全に動作する可能性が高い。

---

## 4. UI Component Impact (UIコンポーネントの波及)

### 4-1. 再レンダリング影響分析

| コンポーネント | 新規state | 再レンダリング影響 | リスク |
|-------------|----------|-----------------|-------|
| WorktreeDetailRefactored | selectedAgents | useEffect連鎖で2回レンダリング | 低 |
| AgentSettingsPane | (新規) | PATCH API呼び出し時のみ | 低 |
| NotesAndLogsPane | activeSubTab拡張 | タブ切替時のみ | 低 |
| BranchListItem | (型変更) | 親コンポーネントからのprops変更時 | 中 |

**[R3-007] selectedAgents変更時のactiveCliTab同期 (should_fix)**

```typescript
// 設計方針書セクション7-3の記載
// selectedAgents変更時にuseEffectでactiveCliTabを同期
useState<CLIToolType>(selectedAgents[0])
```

useEffect経由の同期は1フレーム遅延するため、selectedAgents変更直後のactiveCliTabは旧値を参照する可能性がある。PATCH APIレスポンス受信後のselectedAgents state更新までの間に不整合が生じうる。

### 4-2. WorktreeDetailRefactored.tsxのハードコード箇所

L1795とL2081の`(['claude', 'codex'] as const)`はselectedAgents stateに置換される予定（セクション7-3）。現在のハードコードから動的配列への変更は、配列長が2固定であることの制約を維持する限り安全。

---

## 5. Scheduler Impact (スケジューラーへの影響)

### 5-1. ALLOWED_CLI_TOOLSの現状

| 配置場所 | 値 | 用途 |
|---------|---|------|
| `claude-executor.ts` L33 | `Set(['claude', 'codex'])` | 非インタラクティブ実行のホワイトリスト |
| `auto-yes/route.ts` L23 | `['claude', 'codex', 'gemini']` | Auto-Yes有効化のバリデーション |
| `schedules/route.ts` | `claude-executor.ts`からimport | スケジュール作成時のバリデーション |

**[R3-006] 二重定義の整理方針 (should_fix)**

設計方針書セクション8-5では「現状維持（vibe-local/geminiは技術調査後に判断）」としているが、auto-yes/route.tsの`ALLOWED_CLI_TOOLS`がgeminiを含む（claude-executor.tsは含まない）という不整合の解消方針が不明確。

### 5-2. スケジュール実行へのvibe-local影響

vibe-localは`ALLOWED_CLI_TOOLS`に含まれないため、スケジュール実行ではrejectされる。selected_agentsにvibe-localが含まれていてもスケジュール実行には影響しない。これは設計方針書の意図通り。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | BranchListItem型エラー (R3-001) | High | High | P1 |
| 技術的リスク | DB SQL IN句漏れ (R3-002) | High | High | P1 |
| 運用リスク | セッション孤立 (R3-003) | Med | Med | P2 |
| 技術的リスク | LogViewer型漏れ (R3-004) | Med | High | P2 |
| 運用リスク | ロールバック戦略未定義 (R3-005) | Med | Low | P2 |
| 技術的リスク | ALLOWED_CLI_TOOLS不整合 (R3-006) | Med | Med | P2 |
| 技術的リスク | activeCliTab同期遅延 (R3-007) | Low | Med | P3 |
| 技術的リスク | worktrees/route.ts型漏れ (R3-008) | Med | High | P2 |

---

## Improvement Recommendations

### Must Fix (2 items)

1. **R3-001**: `src/components/sidebar/BranchListItem.tsx` をセクション14の変更対象ファイル一覧に追加する。cliStatusの動的表示方針（selectedAgentsベース or 固定2ツール表示）を決定して明記する。

2. **R3-002**: `src/lib/db.ts` の `getLastMessagesByCliBatch()` L143 のSQL IN句を `CLI_TOOL_IDS` から動的生成するか、IN句を除去する方針をセクション14に明記する。

### Should Fix (6 items)

3. **R3-003**: cli_tool_id自動更新時のアクティブセッション・ポーラーへの副作用動作を設計方針書に明記する。

4. **R3-004**: `src/components/worktree/LogViewer.tsx` をセクション14の変更対象ファイル一覧に追加する。

5. **R3-005**: v18マイグレーションのdown関数方針を設計方針書セクション3に追記する。

6. **R3-006**: `ALLOWED_CLI_TOOLS` の二重定義の整理方針を具体化する。

7. **R3-007**: selectedAgents変更時のactiveCliTab同期の注意事項と関連テストケースを追記する。

8. **R3-008**: `src/app/api/worktrees/route.ts` のsessionStatusByCliローカル型定義修正をセクション14に追記する。

### Nice to Have (3 items)

9. **R3-009**: session-cleanup.tsでのVibeLocalToolクリーンアップ動作の統合テスト追加を推奨。

10. **R3-010**: api-client.tsのselectedAgentsオプショナルチェーンガイドライン追記を推奨。

11. **R3-011**: CLIToolManager Singletonのテスト時再初期化ケース考慮を推奨。

---

## Impact Scope Summary Table

| カテゴリ | ファイル | 変更内容 | リスク | 設計書カバー |
|---------|---------|---------|-------|------------|
| 直接変更 | `src/lib/cli-tools/types.ts` | CLI_TOOL_IDS拡張 | 低 | Yes |
| 直接変更 | `src/lib/cli-tools/manager.ts` | VibeLocalTool登録 | 低 | Yes |
| 直接変更 | `src/lib/db-migrations.ts` | v18追加 | 低 | Yes |
| 直接変更 | `src/lib/db.ts` | selected_agents対応 | 中 | **部分的** (R3-002) |
| 直接変更 | `src/app/api/worktrees/[id]/route.ts` | PATCH/GET拡張 | 中 | Yes |
| 直接変更 | `src/types/models.ts` | Worktree拡張 | 低 | Yes |
| 直接変更 | `src/types/sidebar.ts` | cliStatus型変更 | 中 | Yes |
| 間接影響 | `src/components/sidebar/BranchListItem.tsx` | cliStatus表示変更 | **高** | **No** (R3-001) |
| 間接影響 | `src/components/worktree/LogViewer.tsx` | フィルター型変更 | 中 | **No** (R3-004) |
| 間接影響 | `src/app/api/worktrees/route.ts` | sessionStatusByCli型 | 中 | **部分的** (R3-008) |
| 間接影響 | `src/lib/session-cleanup.ts` | CLI_TOOL_IDS反復自動拡張 | 低 | N/A (自動) |
| 間接影響 | `src/lib/auto-yes-manager.ts` | ポーラー状態不整合リスク | 中 | **No** (R3-003) |
| 間接影響 | `src/lib/response-poller.ts` | ポーラー状態不整合リスク | 中 | **No** (R3-003) |
| 非影響 | `src/lib/schedule-manager.ts` | ALLOWED_CLI_TOOLSが独立管理 | 低 | Yes |

---

## Approval Status

**conditionally_approved** - must_fix 2件（R3-001, R3-002）の対応を条件として承認。should_fix 6件は実装段階での対応を推奨。

---

*Generated by architecture-review-agent for Issue #368 Stage 3*

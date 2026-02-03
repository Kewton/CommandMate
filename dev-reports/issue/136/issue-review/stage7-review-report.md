# Issue #136 Stage 7 Review Report

**Review Date**: 2026-02-03
**Focus**: 影響範囲レビュー (Impact Scope)
**Iteration**: 2nd (Final)
**Previous Stage**: Stage 3 (影響範囲レビュー - 1回目)

---

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 3 |

### Stage 3 Resolution Rate

| Category | Resolution |
|----------|------------|
| Must Fix | 3/3 (100%) |
| Should Fix | 5/5 (100%) |
| Nice to Have | 2.5/3 (83%) |

---

## Stage 3 Findings Status

### Must Fix - All Resolved

| ID | Original Issue | Status |
|----|----------------|--------|
| MF-1 | Issue #135依存関係の状態確認と並行作業方針 | RESOLVED |
| MF-2 | DBマイグレーション計画の未記載 | RESOLVED |
| MF-3 | システムリソース使用量の考慮不足 | RESOLVED |

**Details**:
- **MF-1**: 依存関係セクションに#135がOPEN状態であること、並行作業の禁止、代替案（同一ブランチ実装）を明記済み
- **MF-2**: Migration #16の詳細（ALTER TABLE、CREATE INDEX、CURRENT_SCHEMA_VERSION = 16）を追加済み
- **MF-3**: リソース使用量の考慮事項セクションを新設（メモリ200-500MB/サーバー、同時5-10個推奨）

### Should Fix - All Resolved

| ID | Original Issue | Status |
|----|----------------|--------|
| SF-1 | 既存テストへの影響範囲が不明確 | RESOLVED |
| SF-2 | ログ収集・監視方法の未定義 | RESOLVED |
| SF-3 | daemon.tsの変更内容不足 | RESOLVED |
| SF-4 | External Appsキャッシュへの影響確認 | RESOLVED |
| SF-5 | getPidFilePath()後方互換性確認 | RESOLVED |

### Nice to Have - Mostly Resolved

| ID | Original Issue | Status |
|----|----------------|--------|
| NTH-1 | CLIヘルプメッセージ更新の影響範囲記載 | RESOLVED |
| NTH-2 | 既存ユーザーの移行パス | PARTIALLY_RESOLVED |
| NTH-3 | CI/CDパイプライン動作詳細 | RESOLVED |

---

## New Findings (Stage 7)

### Should Fix

#### SF-1: CLI Type Definitions Impact

**Category**: CLI型定義影響
**Location**: `src/cli/types/index.ts`

**Issue**:
StopOptionsとStatusOptions（暗黙のvoid型）への--issueフラグ追加に伴う型定義更新が影響範囲に未記載。

**Evidence**:
- `src/cli/types/index.ts:44-47`にStopOptions定義（forceのみ）
- `statusCommand()`は現在引数なし（line 20-21）
- --issueフラグ追加により両方の型定義拡張が必要

**Recommendation**:
```typescript
// StopOptions拡張
export interface StopOptions {
  force?: boolean;
  issue?: number;  // 追加
}

// StatusOptions新規作成
export interface StatusOptions {
  issue?: number;
}
```

---

#### SF-2: External Apps DB Operation Impact

**Category**: External Apps DB操作影響
**Location**: `src/lib/external-apps/db.ts`

**Issue**:
external-apps/db.tsのDbExternalAppRowとDbExternalAppInsert型へのissue_no追加が影響範囲に未記載。

**Evidence**:
- `DbExternalAppRow`（line 37-51）はDBカラムに直接対応
- `DbExternalAppInsert`（line 56-66）はINSERT用型
- `mapDbRowToExternalApp()`と`mapExternalAppToDbRow()`関数の修正が必要

**Recommendation**:
影響範囲テーブルに以下を追加:

| File | Change |
|------|--------|
| `src/lib/external-apps/db.ts` | DbExternalAppRow/DbExternalAppInsert型にissue_no追加、マッピング関数修正 |

---

#### SF-3: Integration Test Impact

**Category**: テスト影響
**Location**: `tests/integration/external-apps-api.test.ts`

**Issue**:
external-apps-api.test.ts統合テストへの影響が未記載。

**Evidence**:
- `tests/integration/external-apps-api.test.ts`が存在
- ExternalAppインターフェース変更により既存テストへの影響確認が必要

**Recommendation**:
テスト計画の「既存テストへの影響確認」セクションに追加:
- [ ] `external-apps-api.test.ts`: issueNoフィールドを含むCRUD操作テスト追加

---

#### SF-4: Commander Configuration Impact

**Category**: コマンド引数影響
**Location**: `src/cli/index.ts`

**Issue**:
commander設定の--issueフラグ追加方法が具体的に未記載。

**Evidence**:
```typescript
// Current (line 51-60)
program
  .command('stop')
  .description('Stop the CommandMate server')
  .option('-f, --force', 'Force stop (SIGKILL)')
  .action(async (options) => {
    await stopCommand({ force: options.force });
  });
```

**Recommendation**:
影響範囲テーブルに具体的な変更内容を追記:
```typescript
// After
program
  .command('stop')
  .description('Stop the CommandMate server')
  .option('-f, --force', 'Force stop (SIGKILL)')
  .option('--issue <number>', 'Issue number for worktree', parseInt)
  .action(async (options) => {
    await stopCommand({ force: options.force, issue: options.issue });
  });
```

---

### Nice to Have

#### NTH-1: Log Directory Migration

**Category**: 運用影響
**Location**: ファイル構成（Worktree環境）セクション

**Issue**:
Stage 5でlogs/main/からlogs/default/に変更されたが、既存環境でlogs/main/を使用しているユーザーへの移行考慮が未記載。

**Recommendation**:
- 自動リネームスクリプトの検討
- または、ドキュメントに移行手順を追記

---

#### NTH-2: dotenv Version Compatibility

**Category**: 依存関係影響
**Location**: 環境変数読み込み順序セクション

**Issue**:
`dotenv.config()`の`override: true`オプションはdotenv v16.0.0以降で利用可能。

**Recommendation**:
package.jsonのdotenvバージョンが適合することを確認し、必要に応じてバージョン要件を明記。

---

#### NTH-3: Future Feature Scope Clarification

**Category**: 将来機能影響
**Location**: 2.4 ログ分離セクション

**Issue**:
`commandmate logs --all`は「オプション」と記載されているが、実装時の影響範囲が不明確。

**Recommendation**:
別Issueとして分離することを明示。

---

## Impact Analysis Update

### Newly Identified Affected Files

| File | Change |
|------|--------|
| `src/cli/types/index.ts` | StopOptions拡張（issue?: number）、StatusOptions新規作成 |
| `src/lib/external-apps/db.ts` | DbExternalAppRow/DbExternalAppInsert型にissue_no追加 |
| `tests/integration/external-apps-api.test.ts` | issueNoフィールドを含むテストケース追加 |

### CLI --issue Flag Impact

| Command | Current | After |
|---------|---------|-------|
| stop | `stopCommand(options: StopOptions)` - forceのみ | force + issue追加 |
| status | `statusCommand()` - 引数なし | `statusCommand(options?: StatusOptions)` |
| index.ts | - | `.option('--issue <number>', ...)`追加 |

### External Apps Extension Impact

| Type | Change |
|------|--------|
| Interface | `ExternalApp.issueNo?: number` |
| Interface | `CreateExternalAppInput.issueNo?: number` |
| Interface | `UpdateExternalAppInput.issueNo?: number` |
| DB Type | `DbExternalAppRow.issue_no: number \| null` |
| DB Type | `DbExternalAppInsert.issue_no: number \| null` |
| Function | `mapDbRowToExternalApp()` - issue_no→issueNoマッピング追加 |
| Function | `mapExternalAppToDbRow()` - issueNo→issue_noマッピング追加 |
| Cache | **影響なし**（pathPrefixベースのキャッシュ継続） |

---

## Backward Compatibility Verification

### getPidFilePath

| Item | Status |
|------|--------|
| Signature Change | `getPidFilePath()` → `getPidFilePath(issueNo?: number)` |
| Backward Compatible | YES |
| Existing Tests | `tests/unit/cli/utils/env-setup.test.ts:367-391` |

### external_apps Table

| Item | Status |
|------|--------|
| Change | `issue_no INTEGER` NULLableカラム追加 |
| Backward Compatible | YES (既存レコードはissue_no=NULL) |

### stop/status Commands

| Item | Status |
|------|--------|
| Change | `--issue`フラグ追加 |
| Backward Compatible | YES (フラグなし実行で既存動作維持) |

---

## Blocking Dependencies

| Issue | Title | State | Impact |
|-------|-------|-------|--------|
| #135 | バージョンアップ時にDBクリア | **OPEN** | db-path-resolver.ts変更の前提条件 |

> **Note**: Issue #135は依然としてOPEN状態です。本Issueの実装前に#135の完了が必要です。

---

## Code References

| File | Relevance |
|------|-----------|
| `/src/cli/types/index.ts` | StopOptions拡張、StatusOptions新規作成 |
| `/src/cli/index.ts` | --issueフラグ追加 |
| `/src/cli/commands/stop.ts` | --issueフラグ対応 |
| `/src/cli/commands/status.ts` | --issueフラグ対応 |
| `/src/lib/external-apps/db.ts` | 型・関数修正 |
| `/src/lib/external-apps/cache.ts` | 影響なし確認済み |
| `/src/lib/db-migrations.ts` | Migration #16追加 |
| `/tests/unit/cli/utils/env-setup.test.ts` | 既存テスト確認済み |
| `/tests/unit/cli/utils/pid-manager.test.ts` | 既存テスト確認済み |
| `/tests/integration/external-apps-api.test.ts` | テスト追加対象 |

---

## Conclusion

Stage 3で指摘した影響範囲の課題は**ほぼ全て対応済み**です：

- **Must Fix**: 100% 解決
- **Should Fix**: 100% 解決
- **Nice to Have**: 83% 解決

新たに特定した影響範囲は主に：
1. CLI型定義（StopOptions/StatusOptions）
2. External Apps DB操作の詳細（DbExternalAppRow/DbExternalAppInsert）
3. 統合テストへの影響
4. commander設定の具体的変更

いずれも**Should Fix（推奨対応）レベル**であり、**破壊的変更はなく、後方互換性は維持される設計**となっています。

### Recommendation

1. SF-1〜SF-4の影響範囲をIssue本文に追記
2. Issue #135完了後に実装を開始

---

*Generated by Issue Review Agent - Stage 7*

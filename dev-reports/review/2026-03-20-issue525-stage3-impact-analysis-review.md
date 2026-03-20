# Architecture Review Report: Issue #525 Stage 3 - Impact Analysis

## Executive Summary

Issue #525 の設計方針書「Auto-Yesエージェント毎独立制御」に対する影響範囲（Impact Analysis）レビューを実施した。設計方針書は変更の波及効果を概ね適切に分析しており、直接変更対象の10ファイルと間接影響の2ファイル、更新が必要なテスト6ファイルを特定した。ただし、auto-yes-poller.ts 内部関数群の compositeKey 対応の網羅性、および一部 API ルートでの getAutoYesState 呼び出し変更の記載漏れが確認されたため、conditionally_approved とする。

- **Status**: conditionally_approved
- **Score**: 4/5
- **Must Fix**: 2 items
- **Should Fix**: 4 items
- **Consider**: 3 items

---

## Impact Analysis Summary

### Direct Changes (設計方針書に記載あり)

| Category | File | Change Summary | Risk |
|----------|------|---------------|------|
| Backend Core | `src/lib/auto-yes-state.ts` | Map key compositeKey化、関数シグネチャ変更、byWorktreeヘルパー追加 | Medium |
| Backend Core | `src/lib/auto-yes-poller.ts` | Map key compositeKey化、公開API引数変更、byWorktreeヘルパー追加 | High |
| Barrel | `src/lib/polling/auto-yes-manager.ts` | 新規export追加（buildCompositeKey, extractWorktreeId等） | Low |
| API | `src/app/api/worktrees/[id]/auto-yes/route.ts` | GET/POST の cliToolId パラメータ対応 | Medium |
| API | `src/app/api/worktrees/[id]/current-output/route.ts` | compositeKey ベースの状態取得 | Medium |
| Cleanup | `src/lib/session-cleanup.ts` | byWorktreeヘルパー使用に変更 | Low |
| Cleanup | `src/lib/resource-cleanup.ts` | extractWorktreeId でDB照合 | Low |
| Support | `src/lib/session/worktree-status-helper.ts` | compositeKey でタイムスタンプ取得 | Low |
| Frontend | `src/components/worktree/WorktreeDetailRefactored.tsx` | activeCliToolId に紐づく auto-yes 状態表示 | Low |
| Frontend | `src/hooks/useAutoYes.ts` | 最小変更（cliTool パラメータ既存） | Low |

### Indirect Impacts (設計方針書で部分的に言及)

| Category | File | Impact | Risk |
|----------|------|--------|------|
| CLI | `src/cli/commands/auto-yes.ts` | API リクエストボディの body.cliToolId は変更不要（後方互換） | Low |
| CLI | `src/cli/commands/send.ts` | --auto-yes オプションから auto-yes API 呼び出し（後方互換） | Low |

### Test Files Requiring Update

| File | Reason |
|------|--------|
| `tests/unit/lib/auto-yes-manager.test.ts` | 公開API・内部関数のシグネチャ変更 |
| `tests/unit/auto-yes-manager-cleanup.test.ts` | deleteAutoYesState のcompositeKey対応 |
| `tests/unit/session-cleanup-issue404.test.ts` | byWorktreeヘルパー使用への変更 |
| `tests/unit/resource-cleanup.test.ts` | extractWorktreeId ベースの孤立検出 |
| `tests/unit/lib/worktree-status-helper.test.ts` | compositeKey でのタイムスタンプ取得 |
| `tests/integration/auto-yes-persistence.test.ts` | compositeKey での状態永続化テスト |

---

## Detailed Findings

### Must Fix Items

#### [IA-MF-001] incrementErrorCount 内の disableAutoYes/stopAutoYesPolling 呼び出しの compositeKey 未対応

**Severity**: High

auto-yes-poller.ts の `incrementErrorCount()` 関数（L178-191）内で、連続エラー閾値超過時に `disableAutoYes(worktreeId, 'consecutive_errors')` と `stopAutoYesPolling(worktreeId)` が呼ばれている。

```typescript
// 現行実装 (auto-yes-poller.ts L186-188)
if (pollerState.consecutiveErrors >= AUTO_STOP_ERROR_THRESHOLD) {
  disableAutoYes(worktreeId, 'consecutive_errors');
  stopAutoYesPolling(worktreeId);
}
```

compositeKey 化後は、`disableAutoYes` は `(worktreeId, cliToolId, reason?)` に、`stopAutoYesPolling` は `(compositeKey)` に変更されるため、この呼び出しも対応が必要。設計方針書の Section 4-2 には `stopAutoYesPolling` の引数変更は記載されているが、`incrementErrorCount` 内の呼び出し箇所の修正について具体的な言及がない。

**Recommendation**: 設計方針書 Section 4-2 に incrementErrorCount の変更方針を追記すること。引数を `(compositeKey: string)` に変更し、内部で `extractWorktreeId` / `extractCliToolId` を使って `disableAutoYes` を呼び出す、または `(worktreeId, cliToolId)` を受け取り内部で `buildCompositeKey` する方式のいずれかを明記。

#### [IA-MF-002] auto-yes-poller.ts 内部関数群のキー変更の網羅的記述不足

**Severity**: High

auto-yes-poller.ts には以下の内部関数が存在し、全て現在 `worktreeId` をキーとして `autoYesPollerStates` Map を操作している:

- `getPollerState(worktreeId)` - Map.get
- `updateLastServerResponseTimestamp(worktreeId, timestamp)` - Map.get
- `resetErrorCount(worktreeId)` - Map.get
- `incrementErrorCount(worktreeId)` - Map.get + disableAutoYes/stopAutoYesPolling
- `isDuplicatePrompt(pollerState, promptKey)` - 直接影響なし
- `validatePollingContext(worktreeId, pollerState)` - getAutoYesState + stopAutoYesPolling
- `captureAndCleanOutput(worktreeId, cliToolId)` - 直接影響なし
- `processStopConditionDelta(worktreeId, pollerState, cleanOutput)` - checkStopCondition
- `detectAndRespondToPrompt(worktreeId, pollerState, cliToolId, cleanOutput)` - 複数関数呼び出し
- `pollAutoYes(worktreeId, cliToolId)` - オーケストレーター
- `scheduleNextPoll(worktreeId, cliToolId)` - getPollerState + setTimeout

設計方針書は公開API（startAutoYesPolling, stopAutoYesPolling, isPollerActive, getLastServerResponseTimestamp）の変更を記載しているが、上記内部関数の変更方針が包括的に記述されていない。特に `pollAutoYes` と `scheduleNextPoll` は `(worktreeId, cliToolId)` を別引数で受け取る構造のため、compositeKey 化後の引数設計が重要。

**Recommendation**: 内部関数は compositeKey を Map キーとして使用しつつ、`pollAutoYes`/`scheduleNextPoll` は引き続き `(worktreeId, cliToolId)` を受け取り内部で `buildCompositeKey` する方式を推奨。理由: cliToolId が個別に必要な箇所（`captureSessionOutput`, `detectPrompt` 等）が多いため。設計方針書にこの方針を追記すること。

---

### Should Fix Items

#### [IA-SF-001] current-output/route.ts の getAutoYesState 呼び出しが cliToolId 未追加

設計方針書 Section 4-3 の current-output コード例では `isPollerActive(compositeKey)` と `getLastServerResponseTimestamp(compositeKey)` の変更は記述されているが、L116 の `getAutoYesState(params.id)` を `getAutoYesState(params.id, cliTool)` に変更する指示が明示的に含まれていない。このまま実装すると、エージェントAの auto-yes 状態がエージェントBのタブに表示される不具合が発生する。

**Recommendation**: Section 4-3 の current-output コード例に `getAutoYesState(params.id, cliTool)` への変更を明記すること。

#### [IA-SF-002] auto-yes/route.ts GET の cliToolId パラメータ追加に伴うフロントエンド波及影響

設計方針書では GET API が `cliToolId` クエリパラメータを受け取る設計だが、フロントエンド側から GET リクエスト時に cliToolId を付与する変更箇所が波及影響として記載されていない。現在のフロントエンドコードを確認したところ、auto-yes GET API の直接呼び出しは WorktreeDetailRefactored.tsx の current-output ポーリング経由で間接的に状態を取得しているため、auto-yes GET API を直接呼ぶフロントエンドコードの有無を確認し、影響範囲を明確にする必要がある。

**Recommendation**: auto-yes GET API の呼び出し元を影響範囲に明記すること。

#### [IA-SF-003] CLI send --auto-yes の後方互換性確認が欠落

`src/cli/commands/send.ts` の `--auto-yes` オプションは `auto-yes` API の POST を呼び出す。API 内部の `setAutoYesEnabled` シグネチャ変更は API 層で吸収されるため CLI 側の変更は不要だが、Section 6 の後方互換性表にこの確認が含まれていない。

**Recommendation**: Section 6 に `send --auto-yes` の互換性確認行を追加。

#### [IA-SF-004] テスト戦略で auto-yes-manager.test.ts が既存テスト更新リストに未記載

Section 10 の既存テスト更新リストに `tests/unit/lib/auto-yes-manager.test.ts` が含まれていない。このファイルには `validatePollingContext`, `processStopConditionDelta`, `detectAndRespondToPrompt` など compositeKey 化で影響を受ける関数のテストが存在する。

**Recommendation**: Section 10 のリストに追加。

---

### Consider Items

#### [IA-C-001] 非アクティブタブの auto-yes 状態表示

エージェント毎に独立した auto-yes 制御を導入するが、非アクティブタブでの auto-yes 有効状態の視覚的フィードバック（タブバッジ等）は設計範囲外。将来の UX 改善として検討に値する。

#### [IA-C-002] stopAllAutoYesPolling のログ出力で compositeKey が表示される

`stopAllAutoYesPolling()` のイテレーションログで `worktreeId` 変数名で compositeKey が出力される。機能上は問題ないが、ログの可読性のため `extractWorktreeId` を使った表示を検討。

#### [IA-C-003] getActivePollerCount() のセマンティクス変更

返り値の意味が「worktree数」から「エージェント単位のポーラー数」に変わる。MAX_CONCURRENT_POLLERS との比較用途では正しい動作だが、JSDoc の更新が推奨される。

---

## Risk Assessment

| Risk Type | Level | Detail |
|-----------|-------|--------|
| Technical | Medium | 内部関数群の compositeKey 対応漏れリスクがあるが、TypeScript コンパイルエラーで大半は検出可能 |
| Security | Low | 既存のバリデーション（isValidWorktreeId, isValidCliTool）は維持され、compositeKey バリデーション戦略も MF-001 で設計済み |
| Operational | Low | in-memory 管理は維持、DB スキーマ変更なし。リソースリーク対策（session-cleanup, resource-cleanup）は byWorktree ヘルパーで適切にカバー |

---

## Cleanup / Resource Management Impact

クリーンアップ・リソース管理への影響を詳細に分析した結果:

1. **session-cleanup.ts**: byWorktreeヘルパー方式の採用は適切。現行の `stopAutoYesPolling(worktreeId)` + `deleteAutoYesState(worktreeId)` が `stopAutoYesPollingByWorktree(worktreeId)` + `deleteAutoYesStateByWorktree(worktreeId)` に置き換わる設計は、既存の CLI_TOOL_IDS ループの外で呼び出す構成であり、既存の cleanup フローを壊さない。

2. **resource-cleanup.ts**: `getAutoYesStateWorktreeIds()` が compositeKey 配列を返すようになり、`extractWorktreeId` で DB 照合する設計は正しい。ただし、同一 worktreeId に複数の compositeKey が存在する場合、1つ目の孤立判定で worktreeId が invalid と判定されれば残りも全て削除される（正しい動作）。

3. **Timer リーク防止**: compositeKey 化により同一 worktree に複数の setTimeout タイマーが存在しうるが、`stopAutoYesPollingByWorktree` が全てを走査して clearTimeout するため、リーク防止は適切。

---

## Test Coverage Assessment

設計方針書のテスト戦略が影響範囲を十分にカバーしているかの評価:

| Test Area | Coverage | Gap |
|-----------|----------|-----|
| auto-yes-state.ts 単体テスト | Adequate | - |
| auto-yes-poller.ts 単体テスト | **Gap** | tests/unit/lib/auto-yes-manager.test.ts が更新リストに未記載 |
| API route テスト | Adequate | Section 10 で言及あり |
| Cleanup テスト | Adequate | 4ファイルが更新リストに記載 |
| 結合テスト（複数エージェント同時） | Adequate | 独立状態保持・片方無効化のシナリオ記載あり |
| CLI コマンドテスト | Not applicable | CLI は API を呼ぶだけのため API テストでカバー |
| incrementErrorCount パス | **Gap** | 連続エラー -> disableAutoYes の compositeKey 対応テストが未言及 |

---

## Approval Status

**conditionally_approved** - Must Fix 2件を設計方針書に反映した後、実装に進むことを推奨する。Should Fix 4件は実装時に対応可能。

---

*Review conducted: 2026-03-20*
*Reviewer: Architecture Review Agent (Stage 3: Impact Analysis)*
*Design Document: dev-reports/design/issue-525-auto-yes-per-agent-design-policy.md*

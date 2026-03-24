# Issue #534 - 整合性レビュー (Stage 2)

## Executive Summary

Issue #534「指定時間後メッセージ送信」の設計方針書について、整合性の観点からレビューを実施した。設計方針書は既存コードベースのパターン（globalThisシングルトン、session-cleanup Facadeパターン、DB操作モジュール配置規約など）を適切に踏襲しており、全体として良好な整合性を持つ。

ただし、CLIToolManager APIの呼び出し方法が実コードと異なるコード例（Must Fix 1件）、resource-cleanup.ts統合の詳細不足（Should Fix 1件）など、実装時に混乱を招き得る不整合が検出された。

**総合評価: conditionally_approved (4/5)**

---

## 整合性検証マトリクス

| 検証軸 | スコア | 評価 |
|--------|-------|------|
| 設計書 vs 既存コードベース | 4/5 | globalThis、session-cleanup統合パターンは整合。CLIToolManager API呼び出しに不一致あり |
| 設計書内部セクション間 | 4/5 | データモデル、API、モジュール設計間は概ね整合。GET/POSTレスポンス構造の微差あり |
| 設計書 vs 既存パターン | 4/5 | schedule-manager, auto-yes-config のパターンを適切に踏襲。resource-cleanup統合が未詳 |
| 設計書 vs server.tsライフサイクル | 4/5 | 起動・停止順序は実コードと概ね整合。停止順序の記述に微妙なずれあり |

---

## 詳細検証結果

### 1. 設計書 vs 既存コードベース

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| globalThisパターン | `globalThis.__timerManagerState` | schedule-manager.ts: `globalThis.__scheduleManagerStates` | 整合（同一パターン） |
| session-cleanup統合 | `stopTimersForWorktree()` を step 4 に追加 | session-cleanup.ts: step 1-4 (auto-yes, state, schedule) | 整合（追加位置は適切） |
| DB配置 | `src/lib/db/timer-db.ts` | chat-db.ts, memo-db.ts, session-db.ts は `src/lib/db/` | 整合 |
| マネージャ配置 | `src/lib/timer-manager.ts` | schedule-manager.ts は `src/lib/` 直下 | 整合 |
| 定数配置 | `src/config/timer-constants.ts` | auto-yes-config.ts は `src/config/` | 整合 |
| CLIToolManager API | `getCliTool(timer.cli_tool_id)` | `CLIToolManager.getInstance().getTool(cliToolId)` | **不一致 (CON-MF-001)** |
| sendKeys呼び出し | `sendKeys(sessionName, timer.message, true)` | `sendKeys(sessionName: string, keys: string, sendEnter: boolean)` | 整合 |
| マイグレーションバージョン | v23 | 現在 CURRENT_SCHEMA_VERSION = 22 | 整合（次バージョン） |
| isCliToolType検証 | `isCliToolType()` でcliToolId検証 | terminal/route.ts: `isCliToolType(cliToolId)` | 整合 |
| MAX_COMMAND_LENGTH | 10000文字 | terminal/route.ts: `MAX_COMMAND_LENGTH = 10000` (ローカル定数) | 整合（値は一致） |

### 2. 設計書内部セクション間

| 検証対象 | セクションA | セクションB | 結果 |
|---------|------------|------------|------|
| ステータス値 | S4: pending/sending/sent/failed/cancelled | S9-1: TIMER_STATUS定数 | 整合 |
| delay_ms範囲 | S5: 300000-31500000 | S9-1: MIN_DELAY_MS-MAX_DELAY_MS | 整合 |
| POST リクエスト/レスポンス | S5: delayMs/cliToolId/message | S4: delay_ms/cli_tool_id/message | 整合（camelCase vs snake_case は API vs DB の規約通り） |
| GET レスポンス | S5: worktreeId なし | S5 POST: worktreeId あり | **微差 (CON-SF-002)** |
| cancelTimer境界 | S4: pending -> cancelled | S9-2: cancelTimer() -> boolean | **未定義ケース (CON-SF-004)** |
| ライフサイクル | S10: initTimerManager() step 3 | S9-3: initTimerManager() export | 整合 |
| クリーンアップ | S10: stopTimersForWorktree() step 4 | S9-3: stopTimersForWorktree() export | 整合 |

### 3. 設計書 vs server.ts 実コード

| 設計書の記載 (S10) | server.ts 実コード | 差異 |
|-------------------|-------------------|------|
| 起動: 1. initializeWorktrees | L275: await initializeWorktrees() | 整合 |
| 起動: 2. initScheduleManager | L278: initScheduleManager() | 整合 |
| 起動: 3. initTimerManager (追加) | 未存在（追加予定） | 整合（挿入位置は適切） |
| 起動: 4. initResourceCleanup | L281: initResourceCleanup() | 整合 |
| 停止: 1. stopAllPolling | L297: stopAllPolling() | 整合 |
| 停止: 2. stopAllAutoYesPolling | L300: stopAllAutoYesPolling() | 整合 |
| 停止: 3. stopAllSchedules | L303: stopAllSchedules() | 整合 |
| 停止: 4. stopAllTimers (追加) | 未存在（追加予定） | 整合 |
| 停止: 5. stopResourceCleanup | L306: stopResourceCleanup() | 整合 |
| 停止: 6. closeWebSocket | L309: closeWebSocket() | 整合 |

### 4. resource-cleanup.ts との整合性

| 設計書の記載 | resource-cleanup.ts 実コード | 差異 |
|------------|----------------------------|------|
| 「24h間隔で孤立検出」(S7) | cleanupOrphanedMapEntries() で autoYes/schedule の孤立検出 | **timer-manager 統合方法が未記載 (CON-SF-003)** |
| getActiveTimerCount() (S9-3) | getScheduleWorktreeIds() がアクセサとして存在 | timer用の getTimerWorktreeIds() 相当が未設計 |

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | CLIToolManager API呼び出しの不一致による実装誤り | Medium | Medium | P2 |
| 運用リスク | resource-cleanup未統合によるtimer Mapエントリ残存 | Medium | Low | P2 |
| 技術的リスク | cancelTimer境界ケース未定義による不整合なAPI応答 | Low | Low | P3 |

---

## 改善項目

### 必須改善項目 (Must Fix)

**CON-MF-001: executeTimer内のCLIToolManager API呼び出しを実コードに合わせる**

設計書セクション3-3のコード例:
```typescript
const cliTool = getCliTool(timer.cli_tool_id);
const sessionName = cliTool.getSessionName(timer.worktree_id);
```

実際のコードベース (terminal/route.ts, session-cleanup.ts) のパターン:
```typescript
const manager = CLIToolManager.getInstance();
const tool = manager.getTool(cliToolId);
const sessionName = tool.getSessionName(worktreeId);
```

`getCliTool()` というトップレベル関数は存在せず、`CLIToolManager.getInstance().getTool()` がプロジェクト標準のアクセスパターンである。

### 推奨改善項目 (Should Fix)

**CON-SF-001: gracefulShutdownの停止順序記述を実コードと正確に対応させる**

設計書セクション10の停止順序が実際のserver.ts gracefulShutdown()と概ね一致しているが、stopAllTimers()の挿入位置を実コードの行番号と対応付けて明確にすべき。

**CON-SF-002: GET APIレスポンスのworktreeIdフィールド有無を明記する**

POST APIレスポンスにworktreeIdが含まれGET APIレスポンスに含まれない理由を設計書に明記するか、統一する。

**CON-SF-003: resource-cleanup.tsへのtimer-manager統合方針を追記する**

cleanupOrphanedMapEntries()にtimer-manager用孤立検出を追加する方針を明記する。具体的には:
- `getTimerWorktreeIds()` アクセサ関数のexport設計
- CleanupMapResult型への `deletedTimerWorktreeIds` フィールド追加
- `stopTimersForWorktree()` を孤立検出ループ内で呼び出すパターン

**CON-SF-004: cancelTimer()のpending以外のステータスに対する挙動を定義する**

DELETE APIで既にsent/failed/cancelledのタイマーを指定した場合のレスポンスを明記する（404 or 409 等）。

### 検討事項 (Consider)

**CON-C-001: i18n名前空間をscheduleに相乗りする合理性の明記**

timerとscheduleは異なる概念だが、同一名前空間に統合する場合はその理由を記載する。

**CON-C-002: MAX_COMMAND_LENGTHの共有定数化の検討**

terminal/route.tsとtimer APIルートで同じ値を使うなら、共通定数としてconfig配下に抽出することを検討する。

**CON-C-003: TimerPane.tsxのGET APIポーリング間隔の定義**

タイマー一覧の同期頻度をtimer-constants.tsに定数として定義し、ポーリング戦略（定期取得 or 楽観的UI更新）を明記する。

---

## 承認状態

**conditionally_approved** - Must Fix 1件を修正後、実装に着手可能。Should Fix 4件は実装フェーズでの対応でも可。

---

*Reviewed by: architecture-review-agent*
*Review date: 2026-03-24*
*Focus area: 整合性 (Consistency)*
*Design document: dev-reports/design/issue-534-timer-message-design-policy.md*

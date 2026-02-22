# Issue #323 影響範囲レビューレポート

**レビュー日**: 2026-02-21
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 2 |

Issue #323の `pollAutoYes()` 責務分割リファクタリングの影響範囲を分析した結果、変更は主に `auto-yes-manager.ts` 内部に閉じる設計であり、外部インターフェースへの破壊的変更は発生しない。ただし、テスト安定性、型定義変更、ドキュメント更新に関して影響範囲の明確化が必要である。

---

## Must Fix（必須対応）

### IF003: vi.advanceTimersByTimeAsync依存のタイマーテストがリファクタリング後に不安定化するリスク

**カテゴリ**: テスト
**場所**: `tests/unit/lib/auto-yes-manager.test.ts` L481-1515（約1030行）

**問題**:
現在の `pollAutoYes` テスト群は全て `vi.useFakeTimers` + `vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100)` パターンで間接的に `pollAutoYes()` を起動している。このアプローチは `pollAutoYes()` の内部実装（setTimeout再帰、scheduleNextPoll呼び出し、COOLDOWN_INTERVAL_MS待機等）に暗黙的に依存している。

リファクタリングで `pollAutoYes()` の内部構造が変わると、以下のシナリオでタイミングずれが発生する可能性がある:

1. **新関数内でawaitが追加された場合**: `advanceTimersByTimeAsync` の進行とPromise解決の順序が変わる
2. **scheduleNextPollの呼び出しタイミングが変わった場合**: 100msのバッファが不足する
3. **停止条件チェックでearly returnするパスが変わった場合**: 期待する `sendKeys` 呼び出し回数がずれる

特にIssue #306のcooldownテスト（L1076-1153）やIssue #314のdelta-basedテスト（L1344-1515）は `pollAutoYes` の内部フロー（baseline設定 -> デルタ計算 -> checkStopCondition呼び出し順序）に強く依存している。

**証拠**:
- L502: `await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100)` -- 100msバッファは暗黙的な仮定
- L987: 2回目のpollでCOOLDOWN_INTERVAL_MS後の挙動を検証 -- 内部のscheduleNextPoll実装に依存
- L1393-1398: 1回目poll（baseline確立）-> 2回目poll（デルタチェック）のフロー -- pollAutoYes内部のif/else分岐順序に依存

**推奨対応**:
Issue本文の受入条件に以下を追加:
- 「分割された各関数の個別テストはタイマー非依存（直接関数呼び出し）で記述すること」
- 「リファクタリング作業中に既存テストが失敗した場合、テストの修正は最小限にとどめ、テストの意図（検証対象の動作）は変えないこと」

これにより、既存の統合的テスト（pollAutoYes全体の動作確認）と新規の単体テスト（各関数の個別動作確認）が補完関係になり、リファクタリング後のテスト安定性が向上する。

---

## Should Fix（推奨対応）

### IF001: 新規@internal export関数のテストimport変更が必要

**カテゴリ**: 内部インターフェース
**場所**: `tests/unit/lib/auto-yes-manager.test.ts` L3-25

**問題**:
Issue #323で分割される関数（`validatePollingContext`, `captureAndCleanOutput`, `processStopConditionDelta`, `detectAndRespondToPrompt`）が `@internal export` される場合、テストファイルのimportブロックに新関数を追加する必要がある。

現在のimport状況:
```typescript
import {
  getAutoYesState,           // 関数
  setAutoYesEnabled,         // 関数
  isAutoYesExpired,          // 関数
  clearAllAutoYesStates,     // 関数
  startAutoYesPolling,       // 関数
  stopAutoYesPolling,        // 関数
  stopAllAutoYesPolling,     // 関数
  getLastServerResponseTimestamp,  // 関数
  isValidWorktreeId,         // 関数
  calculateBackoffInterval,  // 関数
  getActivePollerCount,      // 関数
  clearAllPollerStates,      // 関数
  disableAutoYes,            // 関数
  checkStopCondition,        // 関数 (@internal)
  executeRegexWithTimeout,   // 関数 (@internal)
  MAX_CONCURRENT_POLLERS,    // 定数
  POLLING_INTERVAL_MS,       // 定数
  MAX_BACKOFF_MS,            // 定数
  MAX_CONSECUTIVE_ERRORS,    // 定数
  THINKING_CHECK_LINE_COUNT, // 定数
  COOLDOWN_INTERVAL_MS,      // 定数
  type AutoYesState,         // 型
} from '@/lib/auto-yes-manager';
```

分割後は4-5個の新関数が追加され、21-25個程度のimportになる。また、`checkStopCondition` と `processStopConditionDelta()` の両方がexportされるため、テスト内での使い分けとdescribeブロックの構造化が必要。

**推奨対応**:
Issue本文の影響範囲テーブルで、テストファイルの変更内容を「importブロック拡張 + checkStopCondition/processStopConditionDelta describeブロック整理」を含むよう詳細化すること。

---

### IF002: 設計選択肢(B)の場合AutoYesPollerStateインターフェースへのフィールド追加が発生し得る

**カテゴリ**: 型定義
**場所**: `src/lib/auto-yes-manager.ts` L39-54（AutoYesPollerState定義）

**問題**:
設計選択肢(B)「関数群方式」を採用した場合、停止条件のBaseline管理に追加フィールドが必要になる可能性がある。`AutoYesPollerState` はexportされたインターフェースであり、変更時の影響は以下に波及する:

| 影響先 | 内容 |
|--------|------|
| `globalThis.__autoYesPollerStates` (L126-130) | 型宣言の更新 |
| `startAutoYesPolling()` (L653-661) | pollerState初期化オブジェクトの更新 |
| `tests/integration/auto-yes-persistence.test.ts` | globalThis参照テストへの潜在的影響 |

設計選択肢(A)「クラス方式」の場合、pollerState内にクラスインスタンスを保持するため、serializabilityや型の複雑さが増す。

**推奨対応**:
Issue本文で「AutoYesPollerStateインターフェースの変更が必要になるか」を明記すること。既存の `stopCheckBaselineLength` フィールドの再利用で十分かどうかを事前に検討し、変更を最小限にする方針を記載すること。

---

### IF005: processStopConditionDelta()のテスト方針 -- 同一モジュール内関数のモック化制約

**カテゴリ**: 内部インターフェース
**場所**: `src/lib/auto-yes-manager.ts`（processStopConditionDelta -> checkStopCondition呼び出し）

**問題**:
`processStopConditionDelta()` は内部で `checkStopCondition()` を呼び出す上位関数として設計されている。テスト時に `checkStopCondition()` をモック化して `processStopConditionDelta()` を単体テストする場合、同一モジュール内のnamed exportのモック化はVitestの `vi.spyOn` では制約がある場合がある（ESModulesのバインディング特性による）。

現在の `checkStopCondition` テスト（L1299-1342）は4テストケースで直接呼び出ししており、これは変更不要。しかし `processStopConditionDelta()` の新テストでは `checkStopCondition` の副作用（autoYesState変更、polling停止）も含めた統合的な検証が必要になる。

**推奨対応**:
`processStopConditionDelta()` のテストは `checkStopCondition()` をモック化せず、入出力（`pollerState.stopCheckBaselineLength` の変化、`checkStopCondition` の副作用としての `autoYesState` 変更）を検証する統合的な単体テストとする方針を事前に決定すること。

---

### IF006: CLAUDE.mdのauto-yes-manager.tsモジュール説明の更新が必要

**カテゴリ**: ドキュメント
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/CLAUDE.md` -- 主要機能モジュールテーブル

**問題**:
CLAUDE.mdの主要機能モジュールテーブルに `auto-yes-manager.ts` の詳細な説明が記載されている:

> Auto-Yes状態管理とサーバー側ポーリング（Issue #138）、thinking状態のprompt検出スキップ（Issue #161）。Issue #306: 重複応答防止 - AutoYesPollerStateにlastAnsweredPromptKey追加、isDuplicatePrompt()ヘルパー...（中略）...Issue #314: Stop条件機能追加...

Issue #323のリファクタリング完了後、`pollAutoYes()` が4-5関数に分割されるため、分割後の関数名（`validatePollingContext`, `captureAndCleanOutput`, `processStopConditionDelta`, `detectAndRespondToPrompt`）と設計選択結果（クラス方式 or 関数群方式）を追記する必要がある。

**推奨対応**:
Issue本文の影響範囲テーブルに `CLAUDE.md` を追加し、変更内容を「auto-yes-manager.tsモジュール説明の更新（分割関数名、設計選択結果の追記）」と記載すること。

---

## Nice to Have（あれば良い）

### IF004: 外部API・クライアント側への直接的な波及はないが、間接的な動作変更リスクの記載を推奨

**カテゴリ**: 外部API
**場所**: 以下の外部依存ファイル群

**問題**:
外部インターフェースの全数分析を実施した結果、以下の通り直接的な破壊的変更は発生しない:

| ファイル | 使用するimport | 影響 |
|---------|----------------|------|
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | getAutoYesState, setAutoYesEnabled, isValidWorktreeId, startAutoYesPolling, stopAutoYesPolling, AutoYesState(type) | 変更不要 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | getAutoYesState, getLastServerResponseTimestamp, isValidWorktreeId | 変更不要 |
| `src/hooks/useAutoYes.ts` | auto-yes-manager.tsからのimportなし | 変更不要 |
| `src/lib/session-cleanup.ts` | stopAutoYesPolling | 変更不要 |
| `server.ts` | stopAllAutoYesPolling | 変更不要 |

ただし、`pollAutoYes()` の内部フロー変更により、ポーリングのタイミングやエラーリカバリの微妙な動作変更が発生する可能性があり、本番環境での動作テスト（E2E）が推奨される。

**推奨対応**:
- Issue本文の「関連コンポーネント（変更なし）」リストに `server.ts` を追加
- 動作確認方法として「手動でauto-yesを有効化し、プロンプト応答 -> 停止条件マッチ -> 期限切れの3パターンで正常動作を確認」する旨を記載

---

### IF007: globalThisベースの状態管理はリファクタリング後も維持される設計

**カテゴリ**: 状態管理
**場所**: `src/lib/auto-yes-manager.ts` L125-138

**問題**:
globalThis依存の分析結果、以下の理由からリファクタリングの影響は受けない:

1. `autoYesStates` (Map) を操作する関数群（getAutoYesState, setAutoYesEnabled, disableAutoYes, clearAllAutoYesStates）はリファクタリング対象外
2. `autoYesPollerStates` (Map) は `startAutoYesPolling`, `stopAutoYesPolling`, `pollAutoYes` 等から操作されるが、新関数がpollerStateを引数として受け取る設計にすれば、globalThis Mapへの直接アクセスは増加しない
3. globalThis宣言（L125-130）とMap初期化（L133-138）はモジュールレベルであり、リファクタリングの影響を受けない
4. `tests/integration/auto-yes-persistence.test.ts` の5テストケースはglobalThis参照を直接テストしており、影響を受けない

**推奨対応**:
分割関数の設計時に「pollerStateは引数として受け取り、globalThis Mapへの直接アクセスは最小限に留める」方針を明記すると、テスト時のpollerState注入が容易になり、globalThis依存のテストへの影響も防げる。

---

## 影響ファイル一覧

### 変更が必要なファイル

| ファイル | 変更内容 | 影響度 |
|---------|---------|--------|
| `src/lib/auto-yes-manager.ts` | pollAutoYes()の責務分割、停止条件ロジック抽出 | 高 |
| `tests/unit/lib/auto-yes-manager.test.ts` | import拡張 + 分割関数の個別テスト追加 + describe整理 | 高 |
| `CLAUDE.md` | auto-yes-manager.tsモジュール説明の更新 | 低 |

### 変更不要なファイル（確認済み）

| ファイル | 理由 |
|---------|------|
| `src/config/auto-yes-config.ts` | 共有設定のみ、auto-yes-manager.ts内部には依存しない |
| `src/hooks/useAutoYes.ts` | auto-yes-manager.tsからのimportなし |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | exportされた関数シグネチャ不変 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | exportされた関数シグネチャ不変 |
| `src/lib/session-cleanup.ts` | stopAutoYesPollingのみ使用、シグネチャ不変 |
| `server.ts` | stopAllAutoYesPollingのみ使用、シグネチャ不変 |
| `src/lib/prompt-answer-sender.ts` | 外部依存として呼び出されるのみ |
| `src/lib/prompt-key.ts` | 外部依存として呼び出されるのみ |
| `tests/integration/auto-yes-persistence.test.ts` | globalThis参照テスト、AutoYesPollerState未変更の場合影響なし |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/auto-yes-manager.ts`: リファクタリング対象（706行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/tests/unit/lib/auto-yes-manager.test.ts`: 既存テスト（1517行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/tests/integration/auto-yes-persistence.test.ts`: 永続性テスト（185行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/config/auto-yes-config.ts`: 共有設定（116行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/hooks/useAutoYes.ts`: クライアントフック（109行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/app/api/worktrees/[id]/auto-yes/route.ts`: APIルート（180行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/app/api/worktrees/[id]/current-output/route.ts`: APIルート（152行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/session-cleanup.ts`: クリーンアップ（140行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/server.ts`: カスタムサーバー（175行）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/CLAUDE.md`: プロジェクトガイドライン（モジュール説明更新が必要）

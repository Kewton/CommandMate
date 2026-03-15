# Issue #499 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-15
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3
**対象Issue**: perf: Auto-Yes ポーリング性能改善（7項目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 5 |
| Nice to Have | 2 |
| **合計** | **8** |

**総合評価**: good

Issue は Stage 1-2 のレビューを経て高品質に仕上がっており、各対策の根拠と効果が明記されている。影響範囲の観点では、UI 側の stopReason ハンドリング不足が最も重要な指摘であり、実装時に対応漏れが発生するリスクがある。

---

## Must Fix（必須対応）

### F3-002: Item 5 の AutoYesStopReason 型拡張が UI 側の stopReason 判定に影響する

**カテゴリ**: 後方互換性

**問題**:
Item 5 では `AutoYesStopReason` に `'consecutive_errors'` を追加する提案だが、UI 側の `WorktreeDetailRefactored.tsx` (L391) では `stopReason === 'stop_pattern_matched'` の完全一致で判定している。新しい `'consecutive_errors'` 値が設定された場合、UI はこの停止理由を認識せず、ユーザーへの通知が行われない。

Issue 本文では「UIは既存の stopReason 表示機構で通知される」と記載されているが、これは不正確。既存の表示機構は `'stop_pattern_matched'` のみをハンドリングしている。

**証拠**:
- `src/components/worktree/WorktreeDetailRefactored.tsx` L391:
  ```typescript
  if (wasEnabled && !data.autoYes.enabled && data.autoYes.stopReason === 'stop_pattern_matched')
  ```
- `src/config/auto-yes-config.ts` L43: 現在の型定義は `'expired' | 'stop_pattern_matched'` のみ

**推奨対応**:
以下の実装タスクを Issue に追加する:
1. `WorktreeDetailRefactored.tsx` L391 の stopReason 判定に `'consecutive_errors'` 分岐を追加
2. i18n に `'autoYes.consecutiveErrorsStopped'` 等の翻訳キーを追加
3. 関連ファイルに `WorktreeDetailRefactored.tsx` と i18n ファイルを追加

---

## Should Fix（推奨対応）

### F3-001: Item 3 (キャプチャ行数削減) が response-poller.ts に与える影響の未記載

**カテゴリ**: 見落とし

**問題**:
`tmux-capture-cache` は auto-yes-poller 専用ではなく、`response-poller.ts` も同じ `captureSessionOutput` を使用しキャッシュを共有している。auto-yes-poller が 300行でキャッシュに書き込んだ後、response-poller が 5000行を要求した場合、`getCachedCapture()` の insufficient cached lines チェック (L120) によりキャッシュミスとなる。この動作は正常だが、キャッシュ効率への影響を明示すべき。

**証拠**:
- `src/lib/tmux/tmux-capture-cache.ts` L120-121: `if (requestedLines > entry.capturedLines) { return null; }`

**推奨対応**:
Item 3 の説明に「300行キャッシュは response-poller の 5000行要求に対してキャッシュミスとなるが、auto-yes-poller のコスト削減が主目的のため許容する」旨を追記する。

---

### F3-003: 既存テストファイルへの影響が具体的に特定されていない

**カテゴリ**: テスト影響

**問題**:
影響を受けるテストファイルが列挙されていない。以下のテストファイルは変更の直接的影響を受ける:

| テストファイル | 影響する Item |
|--------------|-------------|
| `tests/unit/lib/auto-yes-manager.test.ts` | Item 2 (新定数), Item 5 (エラー閾値), Item 7 |
| `tests/unit/config/auto-yes-config.test.ts` | Item 5 (AutoYesStopReason 型変更) |
| `tests/unit/prompt-detector.test.ts` | Item 4 (detectPrompt シグネチャ変更) |
| `tests/integration/auto-yes-persistence.test.ts` | Item 5 (状態変更) |

**推奨対応**:
関連ファイルセクションにテストファイルを追加する。

---

### F3-004: Item 4 の detectPrompt オプショナル引数追加が他の呼び出し元にも波及する

**カテゴリ**: 波及効果

**問題**:
`detectPrompt()` は以下のファイルから呼ばれている:
- `src/lib/auto-yes-poller.ts` L318 (本 Issue のスコープ)
- `src/lib/polling/response-poller.ts` L40
- `src/lib/detection/status-detector.ts` L28
- `src/app/api/worktrees/[id]/prompt-response/route.ts` L13
- テストファイル 4件

Issue 本文では後方互換性維持を明記しているが、他の呼び出し元での最適化可能性についてスコープを明確化すべき。

**推奨対応**:
「本 Issue のスコープは auto-yes-poller.ts のみ。他の呼び出し元での同様の最適化は別 Issue として検討する」旨を追記する。

---

### F3-005: Item 2 と Item 7 の組み合わせで期限切れ検出が遅延するリスク

**カテゴリ**: 並行処理

**問題**:
Item 7 で `validatePollingContext` 内の `isAutoYesExpired` チェックを除去し、Item 2 で Thinking 検出時の間隔を 5秒に延長すると、Thinking 中の期限切れ検出が最大 5秒遅延する（現状 2秒）。

**推奨対応**:
Item 2 の説明に「期限切れ検出の遅延も最大5秒に拡大するが、期限切れは分～時間単位の設定であり許容範囲」を追記する。

---

### F3-007: Item 3 で stopPattern 設定時に 5000行を維持する設計の根拠が不十分

**カテゴリ**: 見落とし

**問題**:
Item 3 は stopPattern 未設定時のみ行数を削減するが、stopPattern 設定時に 5000行を維持する理由が明確でない。`processStopConditionDelta()` はデルタ方式を採用しており、差分のみチェックするため、実際には 5000行の完全バッファは不要と考えられる。

**推奨対応**:
stopPattern 設定時に 5000行を維持する根拠（バッファ縮小時のベースラインリセットへの対応等）を追記する。

---

## Nice to Have（あれば良い）

### F3-006: Item 6 のキャッシュ TTL 変更が全 tmux capture 利用箇所に影響する

**カテゴリ**: 副作用リスク

`CACHE_TTL_MS` の変更は以下の全消費者に影響する:
- `auto-yes-poller.ts` (getOrFetchCapture 経由)
- `response-poller.ts` (captureSessionOutput 経由)
- `current-output/route.ts` (captureSessionOutput 経由)
- `worktree-status-helper.ts` (captureSessionOutput 経由)

Issue 本文にこの網羅的な影響範囲を記載すると、レビュアーの理解が深まる。

---

### F3-008: Item 1 のテスト方法として spy ベースのテストを推奨

**カテゴリ**: テスト影響

受入条件「stripBoxDrawing が 1回のみ呼ばれることをテストで確認」の具体的なテスト手法を記載すると実装がスムーズになる。`vi.mock` で `stripBoxDrawing` を spy し、`captureAndCleanOutput` + `detectAndRespondToPrompt` の流れで呼び出し回数が 1回であることを検証する方法が推奨される。

---

## 参照ファイル

### 直接変更対象
- `src/lib/auto-yes-poller.ts`: Item 1, 2, 3, 4, 7 の変更対象
- `src/lib/auto-yes-state.ts`: Item 5 の変更対象
- `src/config/auto-yes-config.ts`: Item 2, 5 の定数/型追加
- `src/lib/detection/prompt-detector.ts`: Item 4 のシグネチャ変更
- `src/lib/tmux/tmux-capture-cache.ts`: Item 6 の TTL 変更

### Issue 未記載の影響先
- `src/components/worktree/WorktreeDetailRefactored.tsx`: Item 5 の stopReason ハンドリング追加が必要
- `src/app/api/worktrees/[id]/current-output/route.ts`: stopReason の伝播経路
- `src/lib/polling/response-poller.ts`: キャッシュ共有による間接影響
- `src/lib/detection/status-detector.ts`: detectPrompt 呼び出し元

### 影響を受けるテストファイル
- `tests/unit/lib/auto-yes-manager.test.ts`: 複数の Item で更新が必要
- `tests/unit/config/auto-yes-config.test.ts`: AutoYesStopReason 型テスト
- `tests/unit/prompt-detector.test.ts`: detectPrompt シグネチャ変更
- `tests/integration/auto-yes-persistence.test.ts`: 状態永続化テスト

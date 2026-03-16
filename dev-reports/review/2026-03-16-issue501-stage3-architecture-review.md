# Architecture Review: Issue #501 Stage 3 - 影響分析レビュー

| 項目 | 値 |
|------|-----|
| Issue | #501 |
| Stage | 3 (影響分析レビュー) |
| Focus | 影響範囲 |
| Date | 2026-03-16 |
| Design Doc | `dev-reports/design/issue-501-auto-yes-dual-response-fix-design-policy.md` |

## Summary

| 重要度 | 件数 |
|--------|------|
| must_fix | 2 |
| should_fix | 5 |
| nice_to_have | 3 |
| **合計** | **10** |

## Overall Assessment

設計書は3つの対策の直接的な変更ファイルと変更内容を正確に記述しており、対策間の依存関係も明示されている。しかし、影響範囲の分析において、以下の3点に改善余地がある:

1. 現状のuseAutoYesの二重応答防止が事実上無効であるという現状認識の明示不足
2. worktrees/route.ts, worktrees/[id]/route.ts経由のサイドバーステータス変化の具体的影響
3. Auto-Yes未使用worktreeでの動作不変性の明記

must_fixの2件はいずれも設計書の記述補強であり、実装方針自体の変更は不要。

---

## Findings

### must_fix

#### DR3-001: CurrentOutputResponse型への追加が変更ファイル一覧で不明確

**影響範囲**: `src/components/worktree/WorktreeDetailRefactored.tsx`

設計書セクション3.1はCurrentOutputResponse型へのフィールド追加を指示しているが、セクション9の変更ファイル一覧の変更内容には「型追加」としか記載されていない。現在のCurrentOutputResponse interface (L116-132)にはlastServerResponseTimestampが存在しないため、実装者がこの型定義追加を見落とすリスクがある。

**推奨**: セクション9の変更内容に「CurrentOutputResponse interfaceに `lastServerResponseTimestamp?: number | null` を追加」と明記する。

---

#### DR3-002: useAutoYesの二重応答防止が現状事実上無効であることの明示不足

**影響範囲**: `src/hooks/useAutoYes.ts`, `src/components/worktree/WorktreeDetailRefactored.tsx`

現在のWorktreeDetailRefactored.tsx L961-967のuseAutoYes呼び出しにはlastServerResponseTimestampが渡されていない。useAutoYes.ts L36にはオプショナルプロパティとして定義済みだが、常にundefinedとして扱われ、L75-80の3秒ウィンドウチェックは事実上無効である。

設計書はこれを「対策1」として正しく記述しているが、間接影響セクションで「引数が正しく渡されるようになる」としか記載しておらず、**現在このチェックが完全に無効であるという重大な現状**が明示されていない。

**推奨**: 間接影響欄で、現状DUPLICATE_PREVENTION_WINDOW_MS(3秒)チェックが無効であり、対策1の実装によって初めて有効化されることを明記する。

---

### should_fix

#### DR3-003: resource-cleanup.tsへの影響がない根拠の不足

**影響範囲**: `src/lib/resource-cleanup.ts`

対策2の冪等化によりstartAutoYesPolling()がMap削除→再作成をスキップするケースが増えるが、resource-cleanupのorphan検出はMapのキー存在チェックに基づくため影響しない。設計書はこの点を「影響なし」と断定しているが、その根拠が示されていない。

**推奨**: 間接影響セクションに「冪等化によりMap.has(worktreeId)がtrueを維持するため、孤立検出ロジックに影響がない」旨を追記する。

---

#### DR3-004: サイドバーのステータス表示変化の具体的影響分析不足

**影響範囲**: `src/app/api/worktrees/route.ts`, `src/app/api/worktrees/[id]/route.ts`, `src/lib/session/worktree-status-helper.ts`

worktree-status-helper.ts L91のdetectSessionStatus()に第3引数lastOutputTimestampが追加されると、時間ベースヒューリスティック(status-detector.ts L406-417)が有効化される。従来status='running'(confidence=low)だったケースが、5秒経過でstatus='ready'に変化する。これがサイドバーのisProcessingフラグやステータスアイコンに波及する。

**推奨**: 間接影響セクションに、isProcessingがtrueからfalseに変化するケースがあり、サイドバーのステータスアイコンが変わりうることを明記する。

---

#### DR3-005: Auto-Yes未使用worktreeでの動作不変性が未明記

**影響範囲**: `src/lib/session/worktree-status-helper.ts`

Auto-Yesを一度も有効にしていないworktreeではgetLastServerResponseTimestamp()がnullを返し、undefinedに変換されてdetectSessionStatus()に渡される。既存動作と完全に同一だが、この条件分岐の境界が設計書で明確でない。

**推奨**: セクション3.3にAuto-Yes未使用worktreeでは既存動作に一切の変化がないことを明記する。

---

#### DR3-006: cliToolId変更時のタイムスタンプリセットによる一時的な二重応答リスク

**影響範囲**: `src/lib/auto-yes-poller.ts`, `src/hooks/useAutoYes.ts`

cliToolIdを変更して再有効化した場合(例: claude -> codex)、stop->新規作成となりタイムスタンプがnullにリセットされる。リセット自体は適切だが、その間クライアント側の3秒ウィンドウチェックがスキップされる。

**推奨**: セクション8のトレードオフにcliToolId変更時のタイムスタンプリセットによる一時的な二重応答リスクを既知の制限事項として記録する。

---

#### DR3-007: useState追加による再レンダリング影響の分析不足

**影響範囲**: `src/components/worktree/WorktreeDetailRefactored.tsx`

新規useState<number | null>のsetLastServerResponseTimestamp()がポーリングごとに呼ばれるが、値が変化しない場合はReactが再レンダリングをスキップする。追加の再レンダリングコストはプロンプト応答時のみ発生するが、この分析がパフォーマンスセクションにない。

**推奨**: セクション7にReactの同一値最適化により実質的なパフォーマンス影響がないことを追記する。

---

### nice_to_have

#### DR3-008: current-output/route.tsの変更に対するテストが計画に未記載

**影響範囲**: `src/app/api/worktrees/[id]/current-output/route.ts`

テスト計画ではauto-yes-manager.test.tsとworktree-status-helper.test.tsのみ列挙。current-output/route.tsのdetectSessionStatus()への第3引数追加に対するテストが欠けている。

---

#### DR3-009: サーバー再起動時の影響パスが未文書化

**影響範囲**: `src/lib/auto-yes-poller.ts`, `src/hooks/useAutoYes.ts`

サーバー再起動でglobalThis Mapがクリアされ、lastServerResponseTimestamp=null -> クライアント側チェックスキップ -> 一時的な二重応答リスク、という影響パスが文書化されていない。

---

#### DR3-010: session-cleanup.tsとの相互作用は正しく記載済み

**影響範囲**: `src/lib/session-cleanup.ts`

session-cleanup.ts L115のstopAutoYesPolling()はMapエントリを削除するため、cleanup後のstartAutoYesPolling()では冪等化は関与しない。設計書の記載は正確。追加対応不要。

---

## Impact Map

```
対策1 (タイムスタンプ伝播)
  [直接] WorktreeDetailRefactored.tsx
    -> CurrentOutputResponse型追加
    -> useState<number | null> 追加
    -> fetchCurrentOutput内でsetState
    -> useAutoYes引数追加
  [間接] useAutoYes.ts
    -> 3秒ウィンドウチェックが有効化

対策2 (ポーラー冪等化)
  [直接] auto-yes-poller.ts
    -> startAutoYesPolling()にcliToolId比較ロジック追加
  [直接] auto-yes/route.ts
    -> already_running時のハンドリング(変更なしの可能性)
  [間接] resource-cleanup.ts -> 影響なし(Map key不変)
  [間接] session-cleanup.ts -> 影響なし(stopはMap削除)

対策3 (ステータス検出改善)
  [直接] current-output/route.ts
    -> detectSessionStatus()第3引数追加
  [直接] worktree-status-helper.ts
    -> auto-yes-managerからimport追加
    -> detectSessionStatus()第3引数追加
  [間接] worktrees/route.ts -> ステータス値変化の可能性
  [間接] worktrees/[id]/route.ts -> ステータス値変化の可能性
  [間接] status-detector.ts -> 既存lastOutputTimestampロジック活用(変更なし)
  [条件] Auto-Yes未使用worktree -> 一切の影響なし
```

# マルチステージ設計レビュー完了報告

## Issue #246: スマホにて再開時Error loading worktreeとなる

**設計方針書**: `dev-reports/design/issue-246-visibility-recovery-design-policy.md`

---

## レビュー実施日時
- **開始**: 2026-02-13
- **完了**: 2026-02-13

---

## ステージ別結果

| Stage | レビュー種別 | フォーカス | 指摘数 (MF/SF/C) | 対応数 | スコア | ステータス |
|-------|------------|----------|-----------------|-------|--------|-----------|
| 1 | 通常レビュー | 設計原則 (SOLID/KISS/YAGNI/DRY) | 7 (1/3/3) | 7/7 | 4/5 | ✅ 条件付き承認 |
| 2 | 整合性レビュー | 設計書と実装の整合性 | 6 (1/3/2) | 6/6 | 4/5 | ✅ 条件付き承認 |
| 3 | 影響分析レビュー | 影響範囲・副作用 | 7 (1/3/3) | 4/4 (MF/SF) | 4/5 | ✅ 条件付き承認 |
| 4 | セキュリティレビュー | OWASP Top 10準拠 | 4 (0/2/2) | 4/4 | **5/5** | ✅ **承認** |

### 総計
- **総指摘数**: 24件
  - Must Fix: 3件 → **全対応完了**
  - Should Fix: 11件 → **全対応完了**
  - Consider: 10件 → **全記録完了**
- **最終スコア**: Stage 1-3は4/5、Stage 4は**5/5**

---

## Stage 1: 設計原則レビュー

### 主な指摘事項と対応

| ID | 原則 | タイトル | 対応内容 |
|----|------|---------|---------|
| **MF-001** | DRY | handleRetryとvisibilitychange復帰フローの重複 | visibilitychangeハンドラからhandleRetry()を直接呼び出す設計に変更。フローの再実装を完全に排除 |
| SF-001 | DRY | RECOVERY_THROTTLE_MSとIDLE_POLLING_INTERVAL_MSの値の重複 | 独立した定数として定義し、コメントで関係性を明記 |
| SF-002 | SRP | WorktreeDetailRefactored.tsxの責務過多（2006行） | 将来的にuseVisibilityRecoveryカスタムフックへの抽出を検討する旨を記録 |
| SF-003 | KISS | WorktreeList.tsxとWorktreeDetailRefactored.tsxのvisibilitychangeパターン差異 | 比較表を追加し、パターンが異なる根本理由を明確化 |

### 成果
- **DRY原則の徹底**: handleRetry()直接呼び出しによりコードの重複を排除
- **設計判断の明確化**: YAGNI/KISS原則に基づくカスタムフック化の判断基準を文書化
- **実装チェックリストの整備**: 全指摘事項を実装時のアクションアイテムに変換

---

## Stage 2: 整合性レビュー

### 主な指摘事項と対応

| ID | カテゴリ | タイトル | 対応内容 |
|----|---------|---------|---------|
| **IC-001** | 一貫性 | handleRetryフローの条件分岐が不明確 | フロー記述を更新し、fetchWorktree成功時のみfetchMessages/fetchCurrentOutputを実行することを明確化 |
| IC-002 | 一貫性 | lastServerResponseTimestampがuseAutoYesに渡されていない | 既存の不一致として記録。Issue #246のスコープ外であることを明記 |
| IC-004 | 一貫性 | WorktreeList.tsxのerror状態の説明が不正確 | 「error状態が発生しない」から「error状態は発生するが、ポーリングは停止しない」に修正 |

### 成果
- **14項目の整合性検証**: 主要な行番号、定数値、関数シグネチャがすべて一致
- **既存の不一致の記録**: Issue #246のスコープ外の問題を明確に分離
- **実装精度の向上**: 条件分岐やエラーハンドリングの詳細を正確に記述

---

## Stage 3: 影響分析レビュー

### 主な指摘事項と対応

| ID | カテゴリ | タイトル | 対応内容 |
|----|---------|---------|---------|
| **IA-001** | 副作用 | handleRetry呼び出しによるsetInterval再生成のタイミングギャップ | setLoading(true)によりpolling useEffectのcleanupが実行され、setIntervalが再生成される6ステップのライフサイクルを詳細化 |
| IA-002 | 副作用 | WebSocket再接続を含む3方向の同時発火 | visibilitychange + setInterval + WebSocket reconnectionによる最大9件の同時GETリクエストのシナリオを記録 |
| IA-003 | スコープ | ExternalAppsManagerのスコープ除外理由が不明確 | 除外理由表を追加（60秒の長いポーリング間隔によりタイマードリフトが無視できる） |
| IA-004 | 影響 | setLoading(true)による具体的なUI影響 | LoadingIndicatorによる全画面表示（ターミナル出力・メッセージ履歴の一瞬の消失）を明記 |

### 成果
- **新規セクション追加**: Section 9-3「WebSocket再接続の3方向オーバーラップ」を追加
- **ライフサイクルの可視化**: useEffectのcleanup/再実行フローを詳細に文書化
- **UX影響の明確化**: 一瞬のLoadingIndicator表示というトレードオフを記録

---

## Stage 4: セキュリティレビュー

### 主な指摘事項と対応

| ID | カテゴリ | タイトル | 対応内容 |
|----|---------|---------|---------|
| SEC-SF-001 | 情報漏洩 | API 404レスポンスでparams.idを露出 | 既存の問題として記録。Issue #246では新しいAPIエンドポイントを追加しないため影響なし |
| SEC-SF-002 | CSP | unsafe-inline/unsafe-evalの使用 | 既存の問題として記録。Next.js互換性のためのトレードオフであり、将来的にnonce-based CSP移行を検討 |
| SEC-C-001 | DoS | サーバー側レート制限の不在 | タイムスタンプガードにより十分保護されていると評価。ローカル開発ツールのため優先度低 |

### 成果
- **OWASP Top 10完全評価**: 全10項目をPASS/N/Aで評価（Section 8-3）
- **セキュリティスコア5/5**: 新しい攻撃面を一切追加しない設計であることを確認
- **既存問題の分離**: Issue #246に起因しない既存のセキュリティ問題を明確に記録

---

## 設計方針書の改善サマリー

### 追加されたセクション

| セクション | 内容 |
|-----------|------|
| Section 1-3 | スコープ除外理由表（ExternalAppsManager等） |
| Section 4-4 | visibilitychangeパターン差異の設計根拠（比較表） |
| Section 8-3 | OWASP Top 10チェックリスト |
| Section 8-4 | 既存セキュリティ問題（Issue #246スコープ外） |
| Section 8-5 | DoS防御評価 |
| Section 9-2 | handleRetry()実行ライフサイクル |
| Section 9-3 | WebSocket再接続の3方向オーバーラップ |
| Section 14 | レビュー履歴 |
| Section 15 | レビュー指摘事項サマリー |
| Section 16 | 実装チェックリスト |

### 主要な設計変更

| 変更箇所 | 変更前 | 変更後 | 理由 |
|---------|--------|--------|------|
| エラー復帰フロー | handleRetryフローを再実装 | **handleRetry()を直接呼び出し** | DRY原則（MF-001） |
| RECOVERY_THROTTLE_MS | IDLE_POLLING_INTERVALと共通 | **独立した定数** | 将来的な独立変更の可能性（SF-001） |
| WorktreeList.tsx error状態 | 「発生しない」 | 「発生するが、ポーリングは停止しない」 | 実装との整合性（IC-004） |
| handleRetryフロー | 6ステップのフラット記述 | **条件分岐を明示** | 実装の正確な反映（IC-001） |

### 追加された実装チェックリスト項目

**WorktreeDetailRefactored.tsx**:
- [MF-001] visibilitychangeハンドラからhandleRetry()を直接呼び出す
- [MF-001] handleVisibilityChangeのuseCallback依存配列にhandleRetryを含める
- [SF-001] RECOVERY_THROTTLE_MS定数を定義し、IDLE_POLLING_INTERVAL_MSとの関係性をコメントで明記
- [IA-001] setLoading(true)によるsetInterval再生成のタイミングギャップをコメントで説明

**コードコメント**:
- [SF-001] RECOVERY_THROTTLE_MSの定義箇所に、IDLE_POLLING_INTERVAL_MSとの関係性コメントを記載
- [SF-003] WorktreeList.tsxのvisibilitychangeハンドラに、WorktreeDetailRefactored.tsxとの実装差異の理由コメントを記載
- [IA-001] handleRetry()呼び出し箇所にsetInterval再生成の副作用コメントを記載
- [IA-002] WebSocket再接続との3方向オーバーラップの可能性をコメントで注記

---

## 最終検証結果

設計方針書のレビューのため、ソースコードの変更やテスト実行は行っていません。

### 設計方針書の品質評価

| 観点 | 評価 | 備考 |
|------|------|------|
| 設計原則準拠 | ✅ 4/5 | DRY原則違反を修正、YAGNI/KISS原則を徹底 |
| 実装との整合性 | ✅ 4/5 | 14項目の主要リファレンスが一致、条件分岐を明確化 |
| 影響範囲分析 | ✅ 4/5 | useEffect副作用、WebSocket相互作用を詳細化 |
| セキュリティ | ✅ **5/5** | OWASP Top 10全項目PASS、新しい攻撃面なし |

---

## 次のアクション

- [x] 設計方針書のレビュー完了
- [x] 全24件の指摘事項を設計方針書に反映
- [ ] `/work-plan` で作業計画立案
- [ ] `/tdd-impl` または `/pm-auto-dev` で実装を開始

---

## 成果物

| ファイル | パス |
|---------|------|
| **設計方針書（最新版）** | `dev-reports/design/issue-246-visibility-recovery-design-policy.md` |
| Stage 1 レビュー結果 | `dev-reports/issue/246/multi-stage-design-review/stage1-review-result.json` |
| Stage 1 反映結果 | `dev-reports/issue/246/multi-stage-design-review/stage1-apply-result.json` |
| Stage 2 レビュー結果 | `dev-reports/issue/246/multi-stage-design-review/stage2-review-result.json` |
| Stage 2 反映結果 | `dev-reports/issue/246/multi-stage-design-review/stage2-apply-result.json` |
| Stage 3 レビュー結果 | `dev-reports/issue/246/multi-stage-design-review/stage3-review-result.json` |
| Stage 3 反映結果 | `dev-reports/issue/246/multi-stage-design-review/stage3-apply-result.json` |
| Stage 4 レビュー結果 | `dev-reports/issue/246/multi-stage-design-review/stage4-review-result.json` |
| Stage 4 反映結果 | `dev-reports/issue/246/multi-stage-design-review/stage4-apply-result.json` |
| **サマリーレポート** | `dev-reports/issue/246/multi-stage-design-review/summary-report.md` |

---

*Generated by multi-stage-design-review command - 2026-02-13*

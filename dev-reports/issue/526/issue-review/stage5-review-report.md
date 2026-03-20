# Issue #526 レビューレポート（Stage 5）

**レビュー日**: 2026-03-20
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 2回目
**ステージ**: Stage 5（最終確認）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 2 |

**総合評価**: 実装着手可能（Ready for Implementation）

---

## 前回指摘の対応状況確認

### Stage 1 指摘（通常レビュー 1回目）: 全4件 resolved

| ID | カテゴリ | 指摘概要 | 対応状況 |
|----|---------|---------|---------|
| SF-1 | 技術的妥当性 | sync/asyncの整合性問題の設計判断が未記載 | resolved: 3選択肢(A/B/C)のトレードオフ比較テーブルを追加 |
| SF-2 | 完全性 | 受け入れ基準が未記載 | resolved: 9項目のチェックリストを追加 |
| SF-3 | 完全性 | 影響範囲がsync APIのみに限定 | resolved: 全6箇所の呼び出し元を網羅するテーブルに拡張 |
| SF-4 | 完全性 | テスト方針が未記載 | resolved: 7項目のテスト方針を追加 |

### Stage 3 指摘（影響範囲レビュー 1回目）: 全5件 resolved

| ID | カテゴリ | 指摘概要 | 対応状況 |
|----|---------|---------|---------|
| MF-1 | 影響ファイル | server.tsのexcludedPaths処理が影響範囲に未記載 | resolved: 影響テーブル、受け入れ基準、修正方針の全箇所に追加 |
| MF-2 | 破壊的変更 | 全呼び出し元の具体的修正内容が未記載 | resolved: 方針(A)/(B)別の修正内容一覧テーブルを追加 |
| SF-1 | 依存関係 | 方針(A)のモジュール依存方向の変化への言及なし | resolved: 設計ノートとして責務分離の観点から方針(B)推奨を明記 |
| SF-2 | テスト範囲 | server.ts/clone-manager.tsのテストアプローチ不足 | resolved: テスト方針に3項目追加（共通関数抽出、executeClone経由テスト等） |
| SF-3 | 破壊的変更 | 大量削除時のパフォーマンス影響分析の欠如 | resolved: 最悪ケース試算と3つの対策方針を追加 |

---

## コードベースとの整合性確認

更新後のIssue本文に記載されている技術的な情報が、実際のコードベースと整合していることを確認した。

| 確認項目 | Issue記載 | 実際のコード | 整合性 |
|---------|----------|-------------|--------|
| syncWorktreesToDB()のシグネチャ | `void`を返す同期関数 | `function syncWorktreesToDB(...): void` (L265-268) | 一致 |
| 削除ロジックの位置 | L290-306 | L295-301（deletedIds算出とdeleteWorktreesByIds呼び出し） | 一致 |
| sync/route.ts呼び出し位置 | L48 | L48 | 一致 |
| scan/route.ts呼び出し位置 | L53 | L53 | 一致 |
| restore/route.ts呼び出し位置 | L61 | L61 | 一致 |
| clone-manager.ts呼び出し位置 | L534 | L534 | 一致 |
| server.ts syncWorktreesToDB呼び出し | L239 | L239 | 一致 |
| server.ts excludedPaths削除処理 | L225-232 | L225-232 | 一致 |
| DEFAULT_TIMEOUT | 5000ms | `const DEFAULT_TIMEOUT = 5000` (tmux.ts:15) | 一致 |
| CLI_TOOL_IDS | 5種類 | `['claude', 'codex', 'gemini', 'vibe-local', 'opencode']` (types.ts:10) | 一致 |
| onCloneSuccess()のアクセス修飾子 | private | `private async onCloneSuccess(...)` (L513) | 一致 |
| cleanupMultipleWorktrees()の処理方式 | 逐次処理（forループ） | `for (const worktreeId of worktreeIds)` (L160) | 一致 |

---

## Nice to Have（あれば良い）

### NTH-1: パフォーマンス受け入れ基準の数値未定義

**カテゴリ**: 完全性
**場所**: 受け入れ基準 最終項目

**問題**:
「大量worktree削除時にsync処理が実用的な時間内に完了すること」について、「実用的な時間」の具体的な閾値が定義されていない。パフォーマンス考慮セクションでは最悪ケース20分の試算が記載されているが、受け入れ基準として検証可能な数値がない。

**推奨対応**:
テスト可能な閾値（例: 50件のworktree削除で60秒以内）を記載するか、「パフォーマンス対策（hasSession先行確認、並列実行等）が実装されていること」という実装要件に置き換える。実装時に検討すれば十分なレベル。

---

### NTH-2: 修正方針の最終決定プロセスが未記載

**カテゴリ**: 明確性
**場所**: 修正方針 セクション

**問題**:
方針(B)が「推奨」と記載されているが、最終的にどの方針を採用するかの決定プロセス（実装時に担当者判断か、事前にチーム議論か）が不明。

**推奨対応**:
意思決定のタイミングを明記するか、方針(B)を正式な決定事項として記載する。ただし推奨方針が明示されているため、実装上の支障にはならない。

---

## 総合評価

Issue #526は、Stage 1-4のレビュー・修正サイクルを経て、実装に必要な情報が十分に整備された状態にある。

**主な強み**:

1. **原因分析が正確**: コードスニペットと行番号がすべて実際のコードベースと一致
2. **影響範囲が網羅的**: syncWorktreesToDB()経由の5箇所 + server.tsのexcludedPaths処理の計6箇所を完全に特定
3. **修正方針が具体的**: 3つの選択肢のトレードオフ比較、呼び出し元ごとの修正内容一覧、責務分離の設計判断を明記
4. **受け入れ基準が検証可能**: 9項目のチェックリストで各呼び出し元をカバー
5. **テスト方針が詳細**: 7項目でモックテスト、エラーハンドリング、呼び出し元テスト、テスト困難箇所の対策を記載
6. **パフォーマンスリスクに対応**: 最悪ケース試算と3つの対策方針を明記

**残存する軽微な指摘（Nice to Have: 2件）**:
- パフォーマンス受け入れ基準の数値が未定義（実装時に決定可能）
- 方針の最終決定プロセスが未記載（推奨方針が明示されており支障なし）

いずれも実装着手を妨げるものではなく、本Issueは実装可能な品質に達している。

---

## 参照ファイル

### コード
- `src/lib/git/worktrees.ts` (L265-308): 修正対象 syncWorktreesToDB()
- `src/lib/git/clone-manager.ts` (L513-540): onCloneSuccess() 呼び出し元
- `src/lib/session-cleanup.ts` (L153-174): cleanupMultipleWorktrees() 既存インフラ
- `src/lib/tmux/tmux.ts` (L15): DEFAULT_TIMEOUT定数
- `server.ts` (L225-232, L239): excludedPaths削除処理 + syncWorktreesToDB()呼び出し
- `src/app/api/repositories/sync/route.ts` (L48): 呼び出し元
- `src/app/api/repositories/scan/route.ts` (L53): 呼び出し元
- `src/app/api/repositories/restore/route.ts` (L61): 呼び出し元
- `src/app/api/repositories/route.ts` (L30-44): 正しく実装済みの参考パターン
- `src/lib/cli-tools/types.ts` (L10): CLI_TOOL_IDS定義

### ドキュメント
- `CLAUDE.md`: プロジェクト構造・モジュール一覧の整合性確認

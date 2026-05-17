# Issue #716 マルチステージ設計レビュー完了報告

## 対象

- Issue #716: feat: Worktree詳細 HistoryPaneにメッセージテキスト検索機能を追加
- 設計方針書: dev-reports/design/issue-716-history-search-design-policy.md（v1.2）
- 実施日: 2026-05-17

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 1 | 通常レビュー（設計原則） | 12 (MF:2, SF:7, NTH:3) | 12/12 | 完了（v1.0→v1.1） |
| 2 | 整合性レビュー | 12 (MF:2, SF:8, NTH:2) | 12/12 | 完了（v1.1→v1.2） |
| 3 | 影響分析レビュー（Codex） | - | - | **スキップ**（ユーザーフィードバック「Codexレビュー委任スキップ」） |
| 4 | セキュリティレビュー（Codex） | - | - | **スキップ**（同上） |

## 主要な改善ポイント

### Stage 1（設計原則）

**Must Fix**
- **DR1-001 (OCP)**: terminal-highlight.ts の既存関数（`applyTerminalHighlights` / `clearTerminalHighlights`）のシグネチャを完全維持。新規 `applyHistoryHighlights` / `clearHistoryHighlights` を追加 export する方針に変更（既存呼び出し側を一切変更しない）
- **DR1-002 (KISS)**: useHistorySearch の return に `currentMatch: { messageId: string; localIndex: number } | null` を追加し、グローバル→局所インデックス変換を Hook に内包

**Should Fix**: setComposing の内部化、定数共通化方針の明文化、autoExpanded props の I/F 漏出回避、data-message-id 付与位置確定（MessageContent 親 div）、CSS Custom Highlight API のモック戦略、パフォーマンス計測手法

**Nice to Have**: HISTORY_SEARCH_NAMESPACE の export、historyDisplayLimit と MAX_MATCHES の関係性、useLayoutEffect 採用根拠

### Stage 2（整合性）

**Must Fix**
- **DR2-001 + DR2-002 統合解決**: HistoryPane 内で `autoExpandedIds: Set<string>` を独自管理する解決策Bを採用。これにより:
  - truncate 時の textContent オフセット不整合（DR2-001）→ ヒットを含む pair を事前に強制展開してハイライト適用前に全文表示状態にする
  - useConversationHistory の I/F（bulk setter 不在）との不一致（DR2-002）→ 既存 hook を改修せず、HistoryPane 内部完結で対応
  - Effect 宣言順序を §4.2 末尾に正典として集約: (1) scroll 保存 → (2) scroll 復元 → (3) autoExpandedIds 計算 → (4) ハイライト適用

**Should Fix**: TerminalSearch との非対称性説明、定数共通化の具体化（useTerminalSearch.ts からの export 追加）、fallback overlay の namespace 別スタイル、用語整理（§5.0 用語と型対応表新設）、モック戦略の既存パターン揃え、render 回数確認方法、§14 マッピング表の補完、命名統一

**Nice to Have**: 将来 namespace 追加時のマイグレーション戦略、effect 順序指示の §4.2 集約

## 設計方針書の主な変更点

- §4.1 Strategy パターン: ラッパー関数追加方式（既存関数名維持）に確定
- §4.2 副作用パターン: autoExpandedIds 解決策B、effect 宣言順序の正典化
- §5.0 用語と型対応表（新設）
- §6.1 useHistorySearch I/F: currentMatch return 追加、setComposing 削除
- §6.3 ConversationPairCard 追加 props: なし（HistoryPane 内部完結）
- §7.1 globals.css（新設）, §7.2 z-index 関係（新設）
- §9.2.1 memo 維持検証（新設）
- §15.3 反映サマリー表

## Skip 理由（Stage 3-4）

ユーザーメモリ「Codexレビュー委任スキップ」フィードバックに基づき、Stage 3（影響分析）と Stage 4（セキュリティ）の Codex 委任はスキップ。Stage 1-2 で設計原則・整合性の観点から十分な検証を実施しており、影響範囲とセキュリティの主要観点は以下のとおり Stage 1-2 で既にカバー済み:

- **影響範囲**: §11.3「既存パターン踏襲」、§12 リスク評価、§13 ドキュメント更新範囲、§15 実装順序
- **セキュリティ**: §7 セキュリティ設計（XSS, ReDoS, プライバシー, メモリリーク, DoS, DoM Cross-talk）

## 設計方針書 v1.2 の特徴

1. **OCP 完全準拠**: terminal-highlight.ts の既存 export を一切変更しない
2. **memo 維持**: ConversationPairCard への props 追加なし（HistoryPane 副作用方式）
3. **既存 hook 無改修**: useConversationHistory を改修せず autoExpandedIds で内部完結
4. **truncate 対応**: 自動展開→ハイライト適用の effect 順序で textContent オフセットを保証
5. **テスト可能性**: jsdom + globalThis.CSS モック戦略を既存パターンで統一
6. **将来拡張余地**: search-highlight.ts へのマイグレーションパスを §4.1 と §10 で言及

## 次のアクション

- ✅ Phase 1（マルチステージIssueレビュー）完了
- ✅ Phase 2（設計方針書作成）完了
- ✅ Phase 3（マルチステージ設計レビュー）完了
- ➡️ Phase 4: 作業計画立案（/work-plan 716）
- ➡️ Phase 5: TDD自動開発
- ➡️ Phase 6: 完了報告

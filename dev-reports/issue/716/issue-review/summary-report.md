# Issue #716 マルチステージレビュー完了報告

## 対象

- Issue #716: feat: Worktree詳細 HistoryPaneにメッセージテキスト検索機能を追加
- 実施日: 2026-05-17

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | HistoryPaneは検索UI/フィルタ機能を持たない | Confirmed |
| 2 | useConversationHistory + ConversationPairCard 構造 | Confirmed |
| 3 | TerminalSearchBar/useTerminalSearch/terminal-highlight.ts が参考実装として存在 | Confirmed |
| 4 | debounce 300ms, 最大500件, 最小2文字 | Confirmed |
| 5 | terminal-highlight.ts は CSS Custom Highlight API ラッパー | Confirmed |
| 6 | **履歴本体は ChatMessage[] を ConversationPairCard 内でMarkdownレンダリングしている** | **Rejected（重要）** |
| 7 | CLIタブ切替時に clearMessages() が走る | Confirmed |
| 8 | scrollContainerRef でスクロール位置を保持 | Confirmed |
| 9 | MobileContent から HistoryPane 呼出 | Confirmed |
| 10 | Issue #701 の props 伝播パターン | Confirmed |

**重要な事実誤認の修正**: ConversationPairCard は Markdown レンダリングを行っておらず、`whitespace-pre-wrap` + ファイルパス分割（`<span>` + `<button>`）のみ。これにより `terminal-highlight.ts` のCSS Custom Highlight API 方式が直接流用可能と判明。Stage 1 で「実装方針 4.」を全面書き直し。

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 0.5 | 仮説検証 | 10 (1 Rejected) | - | 完了 |
| 1 | 通常レビュー（1回目） | 13 (MF:3, SF:7, NTH:3) | - | 完了 |
| 2 | 指摘事項反映（1回目） | - | 13/13 | 完了 |
| 3 | 影響範囲レビュー（1回目） | 14 (MF:3, SF:8, NTH:3) | - | 完了 |
| 4 | 指摘事項反映（1回目・影響範囲） | - | 14/14 | 完了 |
| 5-8 | 2回目イテレーション（Codex） | - | - | **スキップ**（ユーザーフィードバック「Codexレビュー委任スキップ」に基づく） |

## 主要な改善ポイント

### Stage 1（通常レビュー）

- **MF S1-001**: Markdown レンダリング前提の削除、CSS Custom Highlight API 一本化
- **MF S1-002**: 折りたたみ挙動を「自動展開方式」に確定
- **MF S1-003**: `useHistorySearch` の I/F を `messageId + MatchPosition ranges` に確定
- IME composition / 検索state保持場所 / Pending/Orphan/truncate 取り扱い / ファイルパスボタン相互作用を明文化
- 用語統一: `useHistorySearch` / `HistorySearchBar` / 「メッセージテキスト検索」

### Stage 3（影響範囲レビュー）

- **MF S3-001**: `terminal-highlight.ts` の document-wide 名前空間衝突問題を発見 → `src/lib/highlight-common.ts` への共通化方針を確定（HistoryPane と TerminalPane が同画面に存在しうるため）
- **MF S3-002**: `ConversationPairCard` の memo を維持するため、ハイライトを HistoryPane の useLayoutEffect 副作用として CSS Custom Highlight API で適用する方針に変更
- **MF S3-003**: `historyDisplayLimit` 切替時の検索 state 挙動を明文化
- `src/app/globals.css` への `::highlight(history-search)` スタイル定義追加
- scrollPositionRef 復元と scrollIntoView の競合制御
- アクセシビリティ要件（Tab順序、aria-label）の格上げ
- log-export-sanitizer による検索クエリのプライバシー保護

## 最終Issue状態

- 本文行数: 344 行（元 80 行から大幅充実）
- 受入条件: 詳細化・テスト可能化
- 実装方針: 6項目に整理（共通化、Hook、UI、HistoryPane、ConversationPairCard、モバイル）
- 他Issue相互作用セクション新設（#168, #701, #485, #47）

## 次のアクション

- ✅ Phase 1（マルチステージIssueレビュー）完了
- ➡️ Phase 2: 設計方針書の確認・作成
- ➡️ Phase 3: マルチステージ設計レビュー
- ➡️ Phase 4: 作業計画立案
- ➡️ Phase 5: TDD自動開発

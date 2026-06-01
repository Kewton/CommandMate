# Issue #723 マルチステージレビュー完了報告

**対象Issue**: #723 perf(file-panel): 大規模ファイルでPC版がハングする問題への対応
**実行日**: 2026-05-28
**ブランチ**: feature/723-worktree

## 仮説検証結果（Phase 0.5）

| # | 仮説 | 判定 | 主な事実 |
|---|------|------|---------|
| H1 | テキスト読み込みに上限なし | **Partially Confirmed** | 通常テキストは上限なし、編集系は既に1MB上限あり |
| H2 | CodeViewer 同期ハイライト | Confirmed | useMemo内 hljs 同期実行、Web Worker化なし |
| H3 | 仮想化なしで全行マウント | Confirmed | content.split→全`<tr>`マウント、`@tanstack/react-virtual`未導入 |
| H4 | ポーリング毎の全文再取得 | **Partially Confirmed** | 5秒毎ポーリングだが304スキップ実装済み、mtime変更時のみ全文再取得 |
| H5 | 検索の同期実行・debounceなし | Confirmed | useEffect依存配列で毎入力ごと同期再計算 |
| H6 | 画像/動画/PDF/HTML サイズ上限 | **Partially Confirmed** | 画像は20MB（Issueの5MBは誤り） |
| H7 | hljs は全文必要 | Confirmed | 設計判断妥当 |
| H8 | EDITABLE_EXTENSIONS 対象 | Confirmed | `.md, .html, .htm, .yaml, .yml`（.html/.htmも含む） |
| H9 | file-operations.ts 拡張可能 | Confirmed | readFileContent存在、readline基盤未導入 |
| H10 | FILE_TOO_LARGE 流用可能 | Confirmed | ERROR_CODE_TO_HTTP_STATUSに既存 |

## ステージ別結果

| Stage | レビュー種別 | Must Fix | Should Fix | Nice to Have | 反映数 | ステータス |
|-------|------------|---------|-----------|-------------|--------|----------|
| 1 | 通常レビュー（1回目） | 4 | 6 | 3 | - | 完了 |
| 2 | 指摘事項反映（1回目） | - | - | - | 13/13 | 完了 |
| 3 | 影響範囲レビュー（1回目） | 4 | 6 | 3 | - | 完了 |
| 4 | 指摘事項反映（1回目） | - | - | - | 13/13 | 完了 |
| 5-8 | 2回目イテレーション（Codex） | - | - | - | - | **スキップ** |

**スキップ理由**: ユーザーフィードバック（`feedback_skip_codex_review.md`）に基づき、Codex委任は不要と判断。

## Issue本文の主な改善点

### Stage 1（通常レビュー）反映分

1. **画像サイズ修正**: 「5MB」→「20MB」（実装値）
2. **既存上限との整合**: `TEXT_MAX_SIZE_BYTES=1MB` を 2MB に引き上げて統一する方針を採用
3. **編集系拡張子明示**: `.html`, `.htm` を含む全5拡張子を列挙
4. **HTMLの除外明記**: HTMLは既存5MB（Issue #490）維持、新規2MBガード対象外
5. **メタ情報返却**: JSONボディに一意確定
6. **背景補強**: 304スキップ機構（Issue #469）の既存実装を明記
7. **判定ロジック所在**: A/B判定基準を実装方針に明示
8. **`@tanstack/react-virtual`採用根拠**: 代替検討を含む選定理由を追加

### Stage 3（影響範囲レビュー）反映分

1. **テスト破壊明示**: `editable-extensions.test.ts` への影響を「想定影響範囲」「破壊的変更」へ
2. **FileContent型波及**: 9ファイル（page.tsx / FileViewer / FilePanelTabs 等）の影響を表に追加、optional化前提
3. **マイグレーション影響**: 1MB→2MB引き上げによる『開けなくなるファイル』の破壊性を明記
4. **ドキュメント同期**: src/types/markdown-editor.ts コメント値 + CLAUDE.md モジュール一覧追記
5. **検索ロジック対称化**: FileViewer.tsx の独立検索ロジック改修を実装方針へ
6. **境界仕様**: totalBytes undefined 時の挙動定義
7. **行範囲モードと304の相互作用**: 仕様明記
8. **i18nキー**: ja/en error namespace 追加方針
9. **Client Components境界**: `@tanstack/react-virtual` の配置とバンドルサイズ目安
10. **分岐マッピング**: FilePanelContent.tsx 既存分岐順とA/B判定対応表

### 構造変更

- 新規セクション: `## 破壊的変更（マイグレーション影響）`
- 新規サブセクション: `## 実装方針 > 6. i18n` / `7. ドキュメント・コメント同期`
- 新規マッピング表: `## 対応方針 > 判定基準`（FilePanelContent.tsx 分岐 → A/B 分類）
- `## 想定影響範囲` を 6 サブテーブルに再構成

## 最終Issue本文

- 行数: 162 → 322 行
- ファイル: `dev-reports/issue/723/issue-review/issue-body-after-stage4.md`
- GitHub: https://github.com/Kewton/CommandMate/issues/723

## 次のアクション（pm-auto-issue2dev）

- ✅ Phase 1: マルチステージIssueレビュー（完了）
- ⏭ Phase 2: 設計方針書（ユーザー方針によりスキップ）
- ⏭ Phase 3: マルチステージ設計レビュー（ユーザー方針によりスキップ）
- ▶ Phase 4: 作業計画立案（`/work-plan 723`）
- ▶ Phase 5: TDD自動開発（`/pm-auto-dev 723`）
- ▶ Phase 6: 完了報告

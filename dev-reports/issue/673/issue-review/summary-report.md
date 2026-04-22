# Issue #673 マルチステージレビュー完了報告

## 対象Issue

- **Issue番号**: #673
- **タイトル**: pdfビューワ
- **URL**: https://github.com/Kewton/CommandMate/issues/673

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | FilePanelContentは画像・動画・HTML・Markdown・編集可能ファイルに対応、PDFはフォールバックでコード表示 | Confirmed |
| 2 | HtmlPreview（Issue #490）はiframe srcDoc + sandbox=""パターンを採用 | Confirmed |
| 3 | ファイル取得APIで画像/動画をBase64 data URI形式で返却 | Confirmed |
| 4 | FileContent型にisImage/isVideo/isHtmlフラグが存在 | Confirmed |
| 5 | pdf.js/react-pdf等のPDF関連ライブラリ未導入 | Confirmed |
| 6 | path-validatorによるパストラバーサル/シンボリックリンク防御が存在 | Confirmed |

**結論**: 全仮説Confirmed。ただしStage 1レビューで「HtmlPreviewパターンそのまま流用可能」という上位仮説がPDF特有の制約により崩れることが判明した。

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 0.5 | 仮説検証 | 6件検証 | - | 完了（全Confirmed） |
| 1 | 通常レビュー（1回目） | 15件（Must 4 / Should 7 / Nice 4） | - | 完了 |
| 2 | 指摘事項反映（1回目・通常） | - | 15件 | 完了 |
| 3 | 影響範囲レビュー（1回目） | 14件（Must 3 / Should 8 / Nice 3） | - | 完了 |
| 4 | 指摘事項反映（1回目・影響範囲） | - | 14件 | 完了 |
| 5-8 | 2回目イテレーション（Codex委任） | - | - | スキップ（ユーザー指示） |

**合計反映件数**: 29件（Must Fix 7, Should Fix 15, Nice to Have 7）

## 主要な設計変更ポイント

1. **実装方式の再設計**: `<iframe srcDoc>`方式を排除し、Blob URL + iframe方式（方式A）とストリーミングAPI + Blob URL方式（方式B）の2候補をPoC検証で確定する方針に変更
2. **サイズ上限見直し**: 100MB → 20MB（Base64エンコード時のメモリ膨張を考慮）
3. **CSP更新追加**: `next.config.js` の `frame-src 'self'` に `blob:` を追加（Issue #490のDR4-007を撤回、根拠を明記）
4. **Blob URLライフサイクル設計**: reactStrictMode二重マウント対応、cancelled flag、revokeObjectURLタイミングのリファレンス実装追加
5. **useFileContentPolling分岐**: PDFではポーリング無効化で確定（`enabled` 条件に `!tab.content?.isPdf` 追加）
6. **セキュリティ強化**: magic bytes検証（`%PDF-`）、Content-Dispositionサニタイズ
7. **a11y/エラーUX追加**: 非PDFファイル・破損PDF・サイズ超過のエラーメッセージ、スクリーンリーダー対応
8. **i18n・ドキュメント更新タスク追加**: `locales/{en,ja}/*.json`、CLAUDE.md、module-reference.md、implementation-history.md

## Issue本文の主要セクション構造

1. レビュー反映ノート（Stage 1・Stage 3）
2. 概要
3. 背景・課題（PDFに固有の技術的制約を含む）
4. 提案する解決策（方式A / 方式B 両論併記）
5. Blob URLライフサイクル設計（リファレンス実装）
6. 既存CSP変更の副作用評価
7. 実装タスク（PoC・実装・i18n・ドキュメント）
8. 受入条件（機能/セキュリティ/エラーUX/アクセシビリティ/テスト品質の5カテゴリ）
9. 影響範囲（変更対象ファイル・関連コンポーネント・将来の拡張性・バンドルサイズ）
10. セキュリティ考慮事項
11. レビュー履歴

## 次のアクション

- [x] Issueレビュー完了（Stage 1-4）
- [ ] `/work-plan 673` で作業計画立案
- [ ] `/pm-auto-dev 673` でTDD自動開発

## 成果物ファイル

```
dev-reports/issue/673/issue-review/
├── original-issue.json
├── hypothesis-verification.md
├── stage1-review-context.json
├── stage1-review-result.json
├── stage2-apply-context.json
├── stage2-apply-result.json
├── stage3-review-context.json
├── stage3-review-result.json
├── stage4-apply-context.json
├── stage4-apply-result.json
└── summary-report.md (本ファイル)
```

# マルチステージ設計レビュー完了報告

## Issue #490: HTMLファイル レンダリング

### レビュー日時
- 2026-03-13

### ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 1 | 通常レビュー（設計原則） | Must:1, Should:3, NTH:3 | 4/4 | ✅ |
| 2 | 整合性レビュー | Must:2, Should:3, NTH:2 | 7/7 | ✅ |
| 3 | 影響分析レビュー | Must:2, Should:3, NTH:2 | 7/7 | ✅ |
| 4 | セキュリティレビュー | Must:3, Should:4, NTH:2 | 7/9 | ✅ |

### 主な設計改善点

1. **DRY原則**: `SandboxLevel`型と`SANDBOX_ATTRIBUTES`を`html-extensions.ts`に一元化
2. **YAGNI原則**: Fullサンドボックスレベルを初期リリースから除外（Safe/Interactive 2段階に簡素化）
3. **セキュリティ**: Interactiveモード切り替え時に確認ダイアログを追加
4. **セキュリティ**: HTMLサニタイズ方針（DOMPurify不使用）を明記
5. **CSP修正**: `frame-src 'self'`（blob: 不要）に修正
6. **整合性**: FileViewer.tsx（モバイル版）のisHtml分岐詳細を明記
7. **影響範囲**: X-Frame-Options:DENYとframe-src追加の関係を明確化

### 更新された設計方針書
`dev-reports/design/issue-490-html-preview-design-policy.md`

### 次のアクション
- [ ] 作業計画立案（/work-plan）
- [ ] TDD実装（/pm-auto-dev）

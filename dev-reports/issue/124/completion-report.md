# Issue #124 完了報告 - i18n対応（多言語化基盤）

## 概要

CommandMateアプリケーションにnext-intlベースのi18n基盤を導入し、UIハードコード日本語文字列を翻訳キーに置換しました。Cookie/Headerベースのロケール検出、英語/日本語の2言語対応を実装しています。

## 実装結果サマリー

| 項目 | 結果 |
|------|------|
| TypeScript | 0 errors |
| ESLint | 0 warnings, 0 errors |
| Unit Tests | 155/156 files passed, 3073 tests passed |
| Build | Success |

## 変更ファイル一覧

### 新規作成ファイル (14)

| ファイル | 説明 |
|---------|------|
| `src/config/i18n-config.ts` | i18n設定のSingle Source of Truth |
| `src/lib/locale-cookie.ts` | Cookie操作ユーティリティ（SameSite=Lax, Secure対応） |
| `src/lib/date-locale.ts` | date-fnsロケールマッピング |
| `src/i18n.ts` | next-intlリクエスト設定 |
| `src/middleware.ts` | ロケール検出ミドルウェア |
| `src/hooks/useLocaleSwitch.ts` | 言語切替フック |
| `src/components/common/LocaleSwitcher.tsx` | 言語切替UIコンポーネント |
| `locales/en/common.json` | 英語共通翻訳 |
| `locales/en/worktree.json` | 英語ワークツリー翻訳 |
| `locales/en/prompt.json` | 英語プロンプト翻訳 |
| `locales/en/autoYes.json` | 英語AutoYes翻訳 |
| `locales/en/error.json` | 英語エラー翻訳 |
| `locales/ja/*.json` (5ファイル) | 日本語翻訳 (5 namespace) |

### 変更ファイル - 基盤 (4)

| ファイル | 変更内容 |
|---------|---------|
| `next.config.js` | next-intl plugin追加 |
| `src/components/providers/AppProviders.tsx` | NextIntlClientProvider追加 |
| `src/app/layout.tsx` | async化、動的lang属性、getMessages() |
| `src/components/layout/Sidebar.tsx` | LocaleSwitcher追加 |

### 変更ファイル - コンポーネント翻訳 (8)

| ファイル | 置換箇所数 |
|---------|-----------|
| `src/components/worktree/WorktreeCard.tsx` | ~10箇所 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | ~13箇所 |
| `src/components/worktree/MessageList.tsx` | ~15箇所 |
| `src/components/worktree/PromptMessage.tsx` | ~6箇所 |
| `src/components/worktree/PromptPanel.tsx` | ~5箇所 |
| `src/components/worktree/AutoYesConfirmDialog.tsx` | ~15箇所 |
| `src/components/mobile/MobilePromptSheet.tsx` | ~5箇所 |
| `src/components/error/ErrorBoundary.tsx` | ~3箇所 |
| `src/components/error/fallbacks.tsx` | ~12箇所 |
| `src/config/auto-yes-config.ts` | 3箇所（DURATION_LABELS） |

### 変更ファイル - テスト (4)

| ファイル | 変更内容 |
|---------|---------|
| `tests/setup.ts` | next-intlグローバルモック追加 |
| `tests/unit/config/auto-yes-config.test.ts` | i18nキー形式に更新 |
| `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` | i18nキー形式に更新 |
| `tests/unit/components/worktree/AutoYesToggle.test.tsx` | i18nキー形式に更新 |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | i18nキー形式に更新 |

### 新規テストファイル (3)

| ファイル | 説明 |
|---------|------|
| `tests/unit/config/i18n-config.test.ts` | i18n設定テスト |
| `tests/unit/lib/locale-cookie.test.ts` | Cookie操作テスト |
| `tests/unit/lib/date-locale.test.ts` | date-fnsロケールテスト |

## 設計方針

- **localePrefix: 'never'** - URL構造を変更せず、Cookie/Headerベースでロケール検出
- **5 namespace構成** - common, worktree, prompt, autoYes, error
- **i18n-config.tsをSingle Source of Truth** - すべてのロケール定数を一元管理
- **date-fns連携** - getDateFnsLocale()でロケールに応じた日時フォーマット
- **グローバルテストモック** - tests/setup.tsでnext-intlをモック化し、テストでは翻訳キーを検証

## 次のアクション

- [ ] コミット作成
- [ ] PR作成

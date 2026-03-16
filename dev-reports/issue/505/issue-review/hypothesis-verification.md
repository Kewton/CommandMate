# Issue #505 仮説検証レポート

## 検証日時
- 2026-03-16

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | react-markdownのaタグカスタムコンポーネントで対応可能 | Confirmed | MarkdownPreview.tsxでreact-markdown使用中、codeのカスタムコンポーネントあり、aタグは未実装 |
| 2 | HTMLプレビューはiframeサンドボックスで遮断されている | Confirmed | HtmlPreview.tsxでiframe srcDoc + sandbox属性使用、postMessage未実装 |
| 3 | 現在のファイルタブ上限が5 | Confirmed | useFileTabs.ts:20で `MAX_FILE_TABS = 5` |
| 4 | 外部URLリンクもクリックしても反応がない | Confirmed | aタグのカスタムハンドラが存在しないため |

## 詳細検証

### 仮説 1: react-markdownのaタグカスタムコンポーネントで対応可能

**Issue内の記述**: 「react-markdown の a タグカスタムコンポーネントを追加し、相対パスリンクをファイルタブとして開くハンドラを実装」

**検証手順**:
1. `src/components/worktree/MarkdownPreview.tsx` を確認
2. Line 22: `import ReactMarkdown from 'react-markdown'` を確認
3. Lines 72-77: `markdownComponents` で `code` のカスタムコンポーネント（MermaidCodeBlock）のみ定義

**判定**: Confirmed

**根拠**: react-markdownを使用しており、componentsプロパティでカスタムレンダリングが可能。現在codeのみカスタマイズ済みで、aタグの追加は自然な拡張。

### 仮説 2: HTMLプレビューはiframeサンドボックスで遮断されている

**Issue内の記述**: 「HTMLプレビュー内のリンクもiframeサンドボックスで遮断されている」

**検証手順**:
1. `src/components/worktree/HtmlPreview.tsx` を確認
2. Lines 98-105: `HtmlIframePreview` で `srcDoc` + `sandbox` 属性使用
3. sandbox属性: safe='', interactive='allow-scripts'（どちらもallow-top-navigationなし）

**判定**: Confirmed

**根拠**: sandbox属性にallow-top-navigationが含まれていないため、iframe内のリンククリックはブロックされる。postMessage連携も未実装。

### 仮説 3: 現在のファイルタブ上限が5

**Issue内の記述**: 「現在のファイルタブ上限が5のため、リンクで複数ファイルを開くと上限にすぐ達する」

**検証手順**:
1. `src/hooks/useFileTabs.ts` を確認
2. Line 20: `export const MAX_FILE_TABS = 5`

**判定**: Confirmed

**根拠**: コード上で定数として5が定義されている。

---

## Stage 1レビューへの申し送り事項

- 全仮説が確認済みのため、特にRejectedな仮説はなし
- 実装アプローチは技術的に妥当

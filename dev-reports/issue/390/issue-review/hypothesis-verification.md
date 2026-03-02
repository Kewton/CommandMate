# Issue #390 仮説検証レポート

## 検証日時
- 2026-03-02

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `globals.css` (L33-35) の `.prose pre { @apply bg-transparent p-0 border-0; }` が根本原因 | Confirmed | 実際にL33-35に同一ルールが存在する |
| 2 | `rehype-highlight` の `detect` オプションがデフォルト `false` のため言語未指定コードブロックに `.hljs` クラスが付与されない | Confirmed | MarkdownEditor.tsx L542・MessageList.tsx L204 いずれも `rehypeHighlight` をオプションなしで使用 |
| 3 | 言語指定ありの場合は `.hljs` クラスが付与され `github-dark.css` により正常表示 | Confirmed | MarkdownEditor.tsx L34: `import 'highlight.js/styles/github-dark.css'` が存在 |
| 4 | FileViewerPage のカスタム `pre` コンポーネントが `bg-gray-50`（明るい背景）で、言語未指定時に文字色が明るいまま | Confirmed | page.tsx L171: `className="bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto"` |

## 詳細検証

### 仮説 1: `globals.css` の `.prose pre { bg-transparent }` が根本原因

**Issue内の記述**: 「`src/app/globals.css` (L33-35) の以下のルールが原因」

**検証手順**:
1. `src/app/globals.css` の L33-35 を確認
2. 実際のルールをコードと照合

**実際のコード**:
```css
/* src/app/globals.css L33-35 */
.prose pre {
    @apply bg-transparent p-0 border-0;
}
```

**判定**: Confirmed

**根拠**: Issueに記載された通り `bg-transparent` が設定されており、Tailwind Typography デフォルトの `background-color: #1f2937` を上書きしている。`.prose pre code:not(.hljs)` のフォールバックスタイルは存在しない。

**Issueへの影響**: 仮説は正確。修正方針通りの対応が有効。

---

### 仮説 2: `rehype-highlight` の `detect` オプションがデフォルト `false`

**Issue内の記述**: 「`rehype-highlight` の `detect` オプションがデフォルト `false` のため `.hljs` クラスが付与されない」

**検証手順**:
1. `MarkdownEditor.tsx` の `rehypeHighlight` 呼び出し方法を確認
2. `MessageList.tsx` の `rehypeHighlight` 呼び出し方法を確認

**実際のコード**:
```tsx
// MarkdownEditor.tsx L542
rehypePlugins={[
  rehypeSanitize,
  rehypeHighlight,  // オプションなし
```
```tsx
// MessageList.tsx L204
rehypePlugins={[rehypeHighlight]}  // オプションなし
```

**判定**: Confirmed

**根拠**: 両コンポーネントとも `rehypeHighlight` をオプションなし（`detect: false` のデフォルト）で使用しており、言語未指定のコードブロックに `.hljs` クラスが付与されない。

**Issueへの影響**: `detect: true` の採用または CSS フォールバックで対応可能。修正方針に記載の CSS フォールバック方式（`.prose pre code:not(.hljs)`）が妥当。

---

### 仮説 3: FileViewerPage のカスタム `pre` コンポーネントの問題

**Issue内の記述**: 「FileViewerPage | `src/app/worktrees/[id]/files/[...path]/page.tsx` | カスタム `pre` コンポーネントが `bg-gray-50`（明るい背景）に明るい文字色」

**検証手順**:
1. `page.tsx` の `pre` カスタムコンポーネントを確認

**実際のコード**:
```tsx
// page.tsx L170-173
pre: ({ children }: { children?: React.ReactNode }) => (
  <pre className="bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto">
    {children}
  </pre>
),
```

**判定**: Confirmed

**根拠**: カスタム `pre` コンポーネントが `bg-gray-50`（明るい背景）を使用している。`rehypeHighlight` は L14 でインポートされているが、明示的な文字色指定なしに `.hljs` クラスの有無でテキスト可視性が変わる。また L150 の `prose-pre:bg-gray-100` クラスで `.prose pre` の背景を上書きしているが、文字色は未指定。

**Issueへの影響**: 修正方針記載の通りカスタム `pre` コンポーネントをダーク背景に変更する必要がある。

---

## Stage 1レビューへの申し送り事項

- 全仮説が Confirmed であり、Issueの根本原因・影響範囲の分析は正確
- `globals.css` の修正方針（`.prose pre code:not(.hljs)` フォールバック追加）は妥当
- FileViewerPage の修正方針も妥当
- `rehype-highlight` の `detect` オプションについては修正方針に含まれていないが、CSS フォールバックで十分対応可能
- 修正後に `prose-pre:bg-gray-100` クラス（page.tsx L150）がグローバルCSSの変更と干渉しないか確認が必要

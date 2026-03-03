# Architecture Review Report: Issue #390 Stage 2 (整合性レビュー)

**Issue**: #390 - 言語未指定コードブロックの背景修正
**Review Focus**: 整合性 (Consistency)
**Stage**: 2/4 (多段階設計レビュー)
**Date**: 2026-03-02
**Status**: conditionally_approved

---

## Executive Summary

設計方針書（Stage 1更新済み）と実際のコードベースの整合性を検証した。主要な変更対象4ファイルについて、設計方針書のBefore記述が実コードと一致しているか、After記述が実現可能か、影響範囲の記述が正確かを確認した。

**結果**: 設計方針書のセクション4, 5-1, 5-2の技術的記述は実コードと整合しているが、セクション11の実装チェックリストに内部矛盾が1件存在し、実装時に混乱を招くリスクがある。

---

## 整合性チェック結果

### 1. globals.css (L33-40)

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| `.prose pre` Before | `@apply bg-transparent p-0 border-0;` (L33-35) | L33-35: `@apply bg-transparent p-0 border-0;` | **一致** |
| `.prose pre code.hljs` Before | `@apply rounded-md; padding: 1rem;` (L37-40) | L37-40: `@apply rounded-md; padding: 1rem;` | **一致** |
| After: `.prose pre` 変更 | `bg-[#0d1117] p-0 border-0 rounded-md overflow-x-auto` | N/A (未実装) | 実現可能 |
| After: `.prose pre code:not(.hljs)` 追加 | `@apply block text-[#c9d1d9]; padding: 1rem;` | N/A (未実装) | 実現可能 |

**判定**: consistent

### 2. page.tsx (L150, L170-173)

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| L150 prose-pre classes Before | `prose-pre:bg-gray-100 prose-pre:border prose-pre:border-gray-200` | L150: 上記クラスが存在 | **一致** |
| L170-173 custom pre Before | `bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto` | L171: `bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto` | **一致** |
| L204 non-markdown pre | `.prose`コンテナ外 | L204: else分岐内、`.prose` div外 | **一致** |
| セクション11 チェックリスト | `bg-[#0d1117] text-[#c9d1d9] rounded-md p-4 を除去` | 実コードには `bg-[#0d1117]` `text-[#c9d1d9]` は存在しない | **不一致 (D2-001)** |

**判定**: inconsistent (セクション11のチェックリストに内部矛盾)

### 3. MarkdownEditor.tsx (L854, L871)

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| `.prose`クラス使用 | 自動適用（変更不要） | L854: `prose prose-sm max-w-none` | **一致** |
| L871同様 | 自動適用（変更不要） | L871: `prose prose-sm max-w-none` | **一致** |
| `highlight.js/styles/github-dark.css` import | 既存 | L34: `import 'highlight.js/styles/github-dark.css'` | **一致** |

**判定**: consistent

### 4. MessageList.tsx (L189)

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| `.prose`クラス使用 | 自動適用（変更不要） | L189: `prose prose-sm max-w-none` + conditional `prose-invert` | **一致** |
| prose-invert競合 | ダーク背景同士のため視覚的問題は軽微 | L189: `${isUser ? 'prose-invert' : ''}` | **一致** |
| realtime output pre | inline `bg-gray-900`が優先 | L598-599: `bg-gray-900` inline class | **一致** |

**判定**: consistent

---

## Detailed Findings

### D2-001 [must_fix] 実装チェックリストのカスタムpreコンポーネント除去対象クラスが実コードと不一致

**カテゴリ**: Before記述

**場所**:
- 設計方針書セクション11 実装チェックリスト 3番目の項目
- 実コード: `/Users/maenokota/share/work/github_kewton/commandmate-issue-390/src/app/worktrees/[id]/files/[...path]/page.tsx` L171

**問題の詳細**:

設計方針書セクション11のチェックリストには以下の記述がある:

> page.tsx: カスタム pre コンポーネントから **bg-[#0d1117] text-[#c9d1d9] rounded-md p-4** を除去し、overflow-x-auto のみ残す (D1-001)

しかし、実際のコード（L171）は:

```tsx
<pre className="bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto">
```

`bg-[#0d1117]` や `text-[#c9d1d9]` は現在のコードに存在しない。これはD1-001対応時に、Stage 1レビュー後のAfter設計値を誤ってチェックリストに記載したものと推測される。

一方、セクション5-2のBefore記述は正確に `bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto` と記載されており、セクション5-2とセクション11の間に内部矛盾がある。

**提案**: セクション11のチェックリスト3番目の項目を以下に修正:

> page.tsx: カスタム pre コンポーネントから **bg-gray-50 border border-gray-200 rounded-md p-4** を除去し、overflow-x-auto のみ残す (D1-001)

---

### D2-002 [should_fix] FileViewerPageのカスタムpreコンポーネントAfterでglobals.cssのp-0との競合が未分析

**カテゴリ**: 設計vs実装

**場所**:
- 設計方針書セクション5-1（globals.css After: `p-0`）
- 設計方針書セクション5-2（カスタムpre After: `overflow-x-auto`のみ）

**問題の詳細**:

After設計では:
- globals.css: `.prose pre { @apply bg-[#0d1117] **p-0** border-0 rounded-md overflow-x-auto; }`
- カスタムpre: `<pre className="overflow-x-auto">` (paddingクラスなし)

これにより、pre要素にはpadding: 0が適用される。コードテキストの内部余白は:
- 言語指定あり: `.prose pre code.hljs { padding: 1rem; }` で確保
- 言語指定なし: `.prose pre code:not(.hljs) { padding: 1rem; }` で確保

この動作は技術的に正しいが、paddingがpre要素からcode要素に委譲されるという設計意図が明示されていない。

**提案**: セクション5-2の設計根拠に「paddingはpre要素ではなく内部のcode要素が管理する」旨を追記する。

---

### D2-003 [nice_to_have] MessageList.tsxのrealtime output内のprose preへの影響分析が簡潔すぎる

**カテゴリ**: 影響範囲

**場所**:
- 設計方針書セクション5-1 影響コンポーネント最終項目
- 実コード: `/Users/maenokota/share/work/github_kewton/commandmate-issue-390/src/components/worktree/MessageList.tsx` L596-606

**問題の詳細**:

L598-599の `<pre>` タグは L596の `<div className="prose prose-sm max-w-none ...">` の内部に配置されているため、`.prose pre` セレクタのマッチ対象である。設計書は「inline クラス bg-gray-900 が優先されるため影響なし」と記載しており、これは正確だが、CSSカスケードの優先順位根拠が明記されていない。

具体的には、`bg-gray-900` はTailwindユーティリティクラス（`@layer utilities`内）であり、`.prose pre { bg-[#0d1117] }` は `@layer components` 内のため、Tailwindのレイヤー順序により `@layer utilities` が `@layer components` に勝つ。

**提案**: CSSカスケードの優先順位根拠を補足する。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | チェックリスト不一致による実装混乱 | Medium | High | P1 |
| 技術的リスク | paddingの委譲動作に関する未記載事項 | Low | Medium | P2 |
| 運用リスク | CSSレイヤー優先順位の理解不足 | Low | Low | P3 |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

1. **D2-001**: セクション11の実装チェックリスト3番目の項目を修正し、実コードの `bg-gray-50 border border-gray-200` を正確に記載する

### 推奨改善項目 (Should Fix)

2. **D2-002**: padding委譲の設計意図をセクション5-2に明記する

### 検討事項 (Consider)

3. **D2-003**: CSSカスケードの優先順位根拠を影響コンポーネント記述に補足する

---

## Approval Status

**Status**: conditionally_approved
**Score**: 4/5

セクション4, 5-1, 5-2の技術的設計は正確で実現可能。D2-001のチェックリスト修正は必須だが、設計の本質部分には影響しない。D2-001を修正すれば実装に進んで問題ない。

---

*Generated by architecture-review-agent for Issue #390 Stage 2*

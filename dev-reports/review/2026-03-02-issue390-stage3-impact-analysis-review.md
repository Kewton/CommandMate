# Issue #390 Stage 3: 影響分析レビュー

## 基本情報

| 項目 | 値 |
|------|-----|
| Issue | #390 |
| レビューステージ | Stage 3 (影響分析) |
| 対象文書 | dev-reports/design/issue-390-code-block-dark-bg-design-policy.md |
| レビュー日 | 2026-03-02 |
| ステータス | conditionally_approved |
| スコア | 4/5 |

## エグゼクティブサマリー

Issue #390 の設計方針書における影響範囲分析は、全体として高い網羅性を持っている。`.prose` クラスを使用する全5ファイル（globals.css含む）が設計方針書にカバーされており、`.prose` コンテナ外の `pre` 要素（FileViewer, ExecutionLogPane, LogViewer 等）への非影響も正確に分析されている。

ただし、1件の見落としが確認された。`MermaidDiagram.tsx` のエラー表示が `.prose` コンテナ内で描画される際に、`.prose pre { bg-[#0d1117] }` が適用されて視覚的不整合が生じる可能性がある。この点について設計方針書への追記とテストケースの追加を推奨する。

must_fix は 0 件であり、設計方針書の影響分析品質は高いと評価する。

## 影響範囲分析

### .prose クラス使用箇所の網羅性

コードベース全体で `.prose` クラスを使用している箇所を調査し、設計方針書のカバレッジを検証した。

| # | ファイル | 行番号 | prose バリアント | 設計方針書カバレッジ |
|---|---------|--------|-----------------|-------------------|
| 1 | `src/app/globals.css` | L33, L37, L43, L47-48 | `.prose pre`, `.prose pre code.hljs`, `.prose :not(pre) > code` | 直接変更対象 |
| 2 | `src/components/worktree/MarkdownEditor.tsx` | L854, L871 | `prose prose-sm max-w-none` | 自動適用として記載 |
| 3 | `src/components/worktree/MessageList.tsx` | L189 | `prose prose-sm max-w-none` + 条件付き `prose-invert` | T-003/T-004/T-005 で記載 |
| 4 | `src/components/worktree/MessageList.tsx` | L596 | `prose prose-sm max-w-none` (realtime output) | D2-003 で分析済み |
| 5 | `src/app/worktrees/[id]/files/[...path]/page.tsx` | L150 | `prose prose-slate max-w-none` + `prose-pre:*` ユーティリティ | 直接変更対象 |

**結論**: 全 `.prose` 使用箇所が設計方針書でカバーされている。

### .prose コンテナ外の pre 要素（影響なし）

以下の `pre` 要素は `.prose` コンテナ外にあり、`.prose pre` ルール変更の影響を受けない。

| ファイル | 行番号 | コンテキスト | 設計方針書記載 |
|---------|--------|------------|-------------|
| `FileViewer.tsx` | L185 | Modal 内、.prose コンテナ外 | 記載なし（影響なしのため問題なし） |
| `ExecutionLogPane.tsx` | L240, L246 | .prose コンテナ外 | 記載なし（影響なしのため問題なし） |
| `LogViewer.tsx` | L389 | .prose コンテナ外 | 記載なし（影響なしのため問題なし） |
| `page.tsx` | L204 | 非マークダウンファイル表示、.prose コンテナ外 | D1-004 で影響なし確認済み |

### .prose コンテナ内の pre 要素（見落とし）

| ファイル | 行番号 | コンテキスト | 設計方針書記載 |
|---------|--------|------------|-------------|
| `MermaidDiagram.tsx` | L156 | エラー表示。MermaidCodeBlock 経由で MarkdownEditor プレビュー領域 (.prose) 内に描画 | **未記載** (D3-001) |

## 詳細指摘事項

### D3-001 [should_fix] MermaidDiagram エラー表示の pre 要素が .prose pre ルール変更の影響を受ける

**カテゴリ**: 波及範囲

**該当コード** (`src/components/worktree/MermaidDiagram.tsx` L150-159):
```tsx
if (error) {
  return (
    <div
      data-testid="mermaid-error"
      className="bg-red-50 border border-red-200 p-4 rounded"
    >
      <p className="text-red-600 font-medium">Diagram Error</p>
      <pre className="text-sm text-red-500 mt-2 whitespace-pre-wrap break-words">
        {error}
      </pre>
    </div>
  );
}
```

**分析**: この `<pre>` 要素は明示的な背景色クラスを持たない。MermaidCodeBlock は MarkdownEditor の ReactMarkdown `components.code` として使用されており、描画先は `.prose` コンテナ内である。globals.css の `.prose pre` ルールが `bg-transparent` から `bg-[#0d1117]` に変更されると、この `pre` 要素にダーク背景が適用される。

CSS カスケード:
- `.prose pre { bg-[#0d1117] }` は `@layer components` 内（詳細度 0,1,1）
- MermaidDiagram の `pre` には背景色クラスなし
- 親 `div` の `bg-red-50` は `pre` 要素には継承されない（background は非継承プロパティ）

**結果**: 赤いエラーテキスト (`text-red-500`) がダーク背景 (`#0d1117`) 上に表示される。コントラスト比は十分だが、親の `bg-red-50` コンテナとの視覚的一貫性が崩れる。

**改善提案**: 設計方針書に MermaidDiagram エラー表示への影響を追記し、以下のいずれかを対応する:
1. MermaidDiagram の `pre` に `bg-red-50` を明示的に追加（Tailwind ユーティリティが `@layer components` より優先）
2. テスト計画に Mermaid エラー表示の確認を追加

---

### D3-002 [should_fix] テスト計画に Mermaid エラー表示ケースと非マークダウンファイル確認が不足

**カテゴリ**: テスト範囲

**分析**: 手動テスト8パターン (T-001 -- T-008) は主要なコードブロック表示シナリオを網羅しているが、以下が不足:

1. **Mermaid ダイアグラムのエラー表示** (D3-001 関連): `.prose` コンテナ内で描画されるエラー `pre` 要素
2. **FileViewerPage 非マークダウンファイル表示**: 設計方針書セクション10のステップ5で目視確認を指示しているが、テストケーステーブルには記載なし

**改善提案**:
```
| T-009 | MarkdownEditor | Mermaidダイアグラム構文エラー表示 | 中 |
| T-010 | FileViewerPage | 非マークダウンファイル表示（リグレッション） | 低 |
```

---

### D3-003 [nice_to_have] highlight.js/styles/github-dark.css の import が MarkdownEditor.tsx のみにある点の前提未記載

**カテゴリ**: 波及範囲

**分析**: `highlight.js/styles/github-dark.css` は `MarkdownEditor.tsx` (L34) でのみ import されている。`MessageList.tsx` と `FileViewerPage` は `rehype-highlight` を使用しているが、この CSS を直接 import していない。

Next.js のビルドパイプラインでは、クライアントコンポーネントの CSS import はビルド時にグローバル CSS バンドルに統合されるため、実際にはどのページでも `github-dark.css` が利用可能になる。

設計方針書にはこの CSS 適用メカニズムの前提が明記されておらず、将来の開発者が混乱する可能性がある。

**改善提案**: 設計方針書に「前提: highlight.js/styles/github-dark.css は MarkdownEditor.tsx で import されており、Next.js ビルドによりグローバルに適用される」と注記する。

---

### D3-004 [nice_to_have] FileViewerPage の inline code カスタムコンポーネントが globals.css と重複

**カテゴリ**: CSS詳細度

**分析**: `FileViewerPage` (page.tsx L157-162) のカスタム inline `code` コンポーネントと `globals.css` (L43-45) の `.prose :not(pre) > code` が同一のスタイル定義を持つ。DRY 原則の観点では冗長だが、本 Issue のスコープ外であり、機能的な問題はない。

**改善提案**: 将来のリファクタリングとして記録のみ。

## CSS 詳細度波及分析

| セレクタ | 詳細度 | レイヤー | 変更 | 波及リスク |
|---------|--------|---------|------|-----------|
| `.prose pre` | 0,1,1 | @layer components | bg-transparent -> bg-[#0d1117], overflow-x-auto 追加 | 低: MermaidDiagram エラー pre 以外は問題なし |
| `.prose pre code.hljs` | 0,2,2 | @layer components | 変更なし | なし |
| `.prose pre code:not(.hljs)` | 0,2,2 | @layer components | 新規追加 | なし: .hljs がない場合のみマッチ |
| `.prose :not(pre) > code` | 0,2,1 | @layer components | 変更なし | なし |
| Tailwind ユーティリティ (bg-gray-900 等) | 0,1,0 | layer なし | N/A | @layer components より高い優先度で上書き可能 |

**結論**: `:not(.hljs)` セレクタは既存の `.hljs` スタイルに干渉しない。Tailwind ユーティリティクラスは `@layer components` より優先されるため、明示的に背景色を指定している要素（MessageList の realtime output `bg-gray-900` 等）は影響を受けない。

## リスクアセスメント

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 視覚的リグレッション | MermaidDiagram エラー表示の背景色変更 | Low | Medium | P2 |
| テスト漏れ | エッジケースの手動テスト不足 | Low | Low | P3 |
| CSS カスケード競合 | prose-invert との微妙な競合 | Low | Low | P3 (設計方針書で許容済み) |

## 判定

**ステータス**: conditionally_approved

**条件**: D3-001 (MermaidDiagram エラー表示への影響) の分析を設計方針書に追記し、必要に応じて対策を実施すること。D3-002 のテストケース追加も推奨する。

---

*Generated by architecture-review-agent for Issue #390 Stage 3*

# Issue #390 Stage 1 レビューレポート

**レビュー日**: 2026-03-02
**フォーカス**: 通常レビュー（整合性・正確性）
**ステージ**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |

Issue #390 の根本原因分析と修正方針は概ね正確であり、仮説検証でも全4項目がConfirmedとなっている。致命的な技術的誤りはない。ただし、github-dark.css のインポート状況に関する記述の正確性、FileViewerPage の prose-pre 修飾子クラスとの干渉、MessageList.tsx への修正適用が暗黙的になっている点について補完が推奨される。

---

## Should Fix（推奨対応）

### ISSUE-001: MessageList.tsx と FileViewerPage では highlight.js/styles/github-dark.css がインポートされていない

**カテゴリ**: 正確性
**場所**: Issue本文 > 根本原因 > 詳細 > 3番

**問題**:

Issue本文の根本原因の詳細3番では以下のように記載している:

> 言語指定ありの場合は `rehype-highlight` が `.hljs` クラスを付与し、`highlight.js/styles/github-dark.css` が `background: #0d1117` + `color: #c9d1d9` を設定するため正常表示

しかし、`highlight.js/styles/github-dark.css` を明示的にインポートしているのは `MarkdownEditor.tsx` (L34) のみである。

```tsx
// src/components/worktree/MarkdownEditor.tsx L34
import 'highlight.js/styles/github-dark.css';
```

`MessageList.tsx` および `page.tsx` (FileViewerPage) にはこのインポートが存在しない。Next.js のバンドル特性上、MarkdownEditor が同一ページで使用されている場合はCSSがグローバルに適用される可能性があるが、FileViewerPage を単独で直接表示した場合には `github-dark.css` が読み込まれない可能性がある。

**推奨対応**:

根本原因分析において、各コンポーネントの `github-dark.css` インポート状況を正確に記載する。修正方針のCSSフォールバック方式で3コンポーネント全てに対応可能であることを明記するか、各コンポーネントへの `github-dark.css` インポート追加も選択肢として検討する。

---

### ISSUE-002: FileViewerPage の prose-pre:bg-gray-100 クラスと globals.css 修正の干渉

**カテゴリ**: 完全性
**場所**: Issue本文 > 修正方針

**問題**:

FileViewerPage (`page.tsx` L150) のマークダウン描画コンテナには以下のTailwindのproseモディファイアが指定されている:

```
prose-pre:bg-gray-100 prose-pre:border prose-pre:border-gray-200
```

`globals.css` の `.prose pre` を `bg-[#0d1117]` に変更した場合:
- Tailwind のユーティリティクラス（`prose-pre:bg-gray-100`）は `@layer components` 内のルールよりも高い優先度を持つ
- そのため FileViewerPage では `bg-gray-100`（明るい背景）が引き続き勝つ
- 修正方針2のカスタム `pre` コンポーネント修正だけでは不十分で、`prose-pre:bg-gray-100` も同時に修正または削除する必要がある

この点が修正方針に明記されていない。

**推奨対応**:

修正方針に以下のいずれかを追記:
1. `page.tsx` L150 の `prose-pre:bg-gray-100` を `prose-pre:bg-[#0d1117]` に変更する
2. `prose-pre:bg-gray-100` を削除し、カスタム `pre` コンポーネントの修正に統一する
3. `globals.css` のフォールバックスタイルに依存し、`prose-pre:bg-gray-100` を削除する

---

### ISSUE-003: MessageList.tsx の修正手順が暗黙的

**カテゴリ**: 完全性
**場所**: Issue本文 > 影響範囲テーブル > MessageList行、修正方針

**問題**:

影響範囲テーブルでは MessageList.tsx が影響を受けることが記載されているが、修正方針には MessageList.tsx 固有の修正手順が含まれていない。`globals.css` の修正のみで対応される暗黙の前提がある。

MessageList.tsx (L189) では `prose prose-sm` クラスを使用しているため、`globals.css` の `.prose pre` 修正が自動的に適用される。これ自体は正しいアプローチだが、修正方針に明記されていないため、実装者が「MessageList.tsx の修正を忘れている」と誤解する可能性がある。

**推奨対応**:

修正方針に「MessageList.tsx は `globals.css` の `.prose pre` 修正により自動的に対応されるため、コンポーネント固有の修正は不要」と明記する。

---

## Nice to Have（あれば良い）

### ISSUE-004: ダークモード/テーマ拡張性への言及

**カテゴリ**: 完全性
**場所**: Issue本文 > 受入条件

**問題**:

修正方針ではハードコードされた色値（`bg-[#0d1117]`、`text-[#c9d1d9]`）を使用している。現状のコードベースではダークモードは未実装のため即座の問題にはならないが、将来的な拡張性を考慮した注記があると良い。

**推奨対応**:

受入条件または注意事項として「ハードコードされた色値は `github-dark` テーマに合わせた固定値。将来ダークモード対応時にはCSS変数化を検討」の旨を追記。

---

### ISSUE-005: 修正方針コードサンプルと既存ルールの関係が不明確

**カテゴリ**: 明確性
**場所**: Issue本文 > 修正方針 > 1. globals.css の修正

**問題**:

現在の `globals.css` (L33-40) には以下の2つのルールが存在する:

```css
/* L33-35 */
.prose pre {
    @apply bg-transparent p-0 border-0;
}

/* L37-40 */
.prose pre code.hljs {
    @apply rounded-md;
    padding: 1rem;
}
```

修正方針のコードサンプルにも同名のルールが含まれているが、これが既存ルールの「置き換え」なのか「追記」なのかが文面上不明確。

**推奨対応**:

「既存の `.prose pre` ブロック (L33-35) および `.prose pre code.hljs` ブロック (L37-40) を以下に置き換える」と明記する。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-390/src/app/globals.css` | 根本原因の `.prose pre` ルール (L33-40) |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-390/src/components/worktree/MarkdownEditor.tsx` | 影響コンポーネント。唯一 `github-dark.css` をインポート (L34) |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-390/src/components/worktree/MessageList.tsx` | 影響コンポーネント。`prose` クラス使用 (L189)、`github-dark.css` インポートなし |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-390/src/app/worktrees/[id]/files/[...path]/page.tsx` | 影響コンポーネント。カスタム `pre` (L170-173)、`prose-pre:bg-gray-100` (L150)、`github-dark.css` インポートなし |

### 検証結果
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-390/dev-reports/issue/390/issue-review/hypothesis-verification.md` | 全仮説Confirmed。Stage 1への申し送り事項含む |

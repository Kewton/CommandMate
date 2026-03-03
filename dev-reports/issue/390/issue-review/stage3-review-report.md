# Issue #390 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-02
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**前提**: Stage 1（通常レビュー）の指摘事項5件が Stage 2 で全件反映済み

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |

globals.css の `.prose pre` 修正は、`prose` クラスを使用している全コンポーネント（MarkdownEditor, MessageList, FileViewerPage）に波及する。破壊的変更はなく、CSSの特異度ルールにより既存のインラインスタイルやユーティリティクラスが `@layer components` ルールより優先されるため、`prose` コンテナ外の `<pre>` 要素には影響しない。

---

## 影響を受けるコンポーネント一覧

| コンポーネント | ファイル | prose 使用箇所 | 影響レベル |
|-------------|---------|-------------|----------|
| MarkdownEditor | `src/components/worktree/MarkdownEditor.tsx` | L854, L871 | 直接影響 |
| MessageList (assistant) | `src/components/worktree/MessageList.tsx` | L189 (prose-invert なし) | 直接影響 |
| MessageList (user) | `src/components/worktree/MessageList.tsx` | L189 (prose-invert あり) | 間接影響 |
| MessageList (realtime) | `src/components/worktree/MessageList.tsx` | L596 | 影響なし |
| FileViewerPage | `src/app/worktrees/[id]/files/[...path]/page.tsx` | L150 (prose-slate) | 直接影響 |
| FileViewer (Modal) | `src/components/worktree/FileViewer.tsx` | (なし) | 影響なし |

---

## Should Fix（推奨対応）

### ISSUE-301: MessageList.tsx の prose-invert 使用時のスタイル競合が未検討

**カテゴリ**: 波及効果
**場所**: `src/components/worktree/MessageList.tsx` L189, `src/app/globals.css` L33-35

**問題**:

MessageList.tsx L189 では、ユーザーメッセージに対して `prose-invert` クラスが付与される。

```tsx
<div className={`prose prose-sm max-w-none ... ${isUser ? 'prose-invert' : ''}`}>
```

`prose-invert` は Tailwind Typography のダークモード互換機能で、`pre` 要素の背景色を明るく、文字色を暗くする反転テーマを提供する。globals.css の `.prose pre` に `bg-[#0d1117]` をハードコードした場合、`prose-invert` が期待する反転配色と矛盾する可能性がある。

Issue本文の影響範囲テーブルでは MessageList.tsx の `prose-invert` の存在に言及していない。

**推奨対応**:

- 受入条件に「MessageList.tsx のユーザーメッセージ（prose-invert付き）でコードブロックが適切に表示されること」を追加する
- 修正後に prose-invert 環境でのコードブロック表示を目視確認する
- 必要であれば `.prose.prose-invert pre { }` でスタイルを個別に調整する

---

### ISSUE-302: FileViewerPage のカスタム pre コンポーネントと globals.css の overflow プロパティの相互作用

**カテゴリ**: 影響範囲
**場所**: `src/app/worktrees/[id]/files/[...path]/page.tsx` L150, L170-173

**問題**:

FileViewerPage では ReactMarkdown のカスタム `components.pre` (L170-173) で `<pre>` を完全に置き換えている。

```tsx
pre: ({ children }) => (
    <pre className="bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto">
        {children}
    </pre>
),
```

修正方針1で globals.css の `.prose pre` に `overflow-hidden` を追加する提案があるが、カスタム pre の `overflow-x-auto` は Tailwind ユーティリティクラスとして `@layer components` の `overflow-hidden` より優先されるため実害はない。しかし、globals.css でデフォルト `overflow-hidden` を設定し、各コンポーネントで `overflow-x-auto` で上書きする構造はスタイルの意図が不明確になる。

**推奨対応**:

- globals.css の `.prose pre` から `overflow-hidden` を除外するか、Issue本文にこの上書き関係を明記する
- FileViewerPage のカスタム pre コンポーネント修正時に `overflow-x-auto` を維持することを明記する

---

### ISSUE-303: 具体的なテスト計画が未定義

**カテゴリ**: テスト範囲
**場所**: Issue本文 > 受入条件

**問題**:

Issue本文には受入条件が記載されているが、具体的なテスト手順やテストケースが定義されていない。globals.css の修正は視覚的なスタイル変更であり、単体テスト（Vitest + jsdom）では実際のCSSレンダリングを検証できない。

影響を受ける3コンポーネント x 2パターン（言語指定あり/なし）+ MessageList の prose-invert パターンで、合計8パターンの視覚確認が必要。

既存テスト（`tests/unit/components/MarkdownEditor.test.tsx`）は機能テストでありCSSスタイルの検証は含まれていない。FileViewerPage のテストは存在しない。

**推奨テスト計画**:

| ID | コンポーネント | シナリオ | 優先度 |
|----|-------------|---------|-------|
| T-001 | MarkdownEditor | 言語未指定コードブロック | High |
| T-002 | MarkdownEditor | 言語指定ありコードブロック（リグレッション） | High |
| T-003 | MessageList | アシスタントメッセージ内の言語未指定コードブロック | High |
| T-004 | MessageList | ユーザーメッセージ内のコードブロック（prose-invert） | Medium |
| T-005 | FileViewerPage | マークダウン内の言語未指定コードブロック | High |
| T-006 | 全共通 | インラインコードのスタイル不変確認 | High |
| T-007 | MessageList | realtime output の ANSI 出力 pre 要素 | Low |
| T-008 | FileViewerPage | 非マークダウンファイルの表示不変確認 | Medium |

---

## Nice to Have（あれば良い）

### ISSUE-304: globals.css の inline code ルールへの波及確認が影響範囲テーブルに未記載

**カテゴリ**: 影響範囲
**場所**: `src/app/globals.css` L43-50

**問題**:

修正方針1で `.prose pre code:not(.hljs)` ルールを追加すると、globals.css 内の `code` 要素に対するスタイルルールが3種類になる:

1. `.prose :not(pre) > code` (L43) -- inline code
2. `.prose pre code.hljs` (L37) -- 言語指定あり code
3. `.prose pre code:not(.hljs)` (新規) -- 言語未指定 code

セレクタ構造が異なるため直接干渉はないが、影響範囲テーブルにこの関係性の記載があると修正者の理解を助ける。

**推奨対応**:

影響範囲テーブルに inline code ルールを追加し、「新規ルールとの干渉なし」と明記する。

---

### ISSUE-305: MessageList.tsx の realtime output 領域での prose コンテナ内 pre 影響

**カテゴリ**: 波及効果
**場所**: `src/components/worktree/MessageList.tsx` L596-612

**問題**:

MessageList.tsx L596 の realtime output 領域は `prose` クラスを使用している。ANSI コード検出時の `<pre>` (L598) は `bg-gray-900` 等の Tailwind ユーティリティクラスを持つため、globals.css の `.prose pre` ルール（`bg-[#0d1117]`、`p-0`）よりユーティリティクラスが優先され実害はない。

しかし、Issue本文の影響範囲テーブルではこの領域の存在と「追加修正不要」である理由が明記されていない。

**推奨対応**:

影響範囲テーブルの MessageList 行に「realtime output 領域 (L596) は inline スタイルが globals.css より優先されるため追加修正不要」と補足する。

---

## CSS 特異度リスク分析

| リスク | 影響箇所 | 解決状況 |
|-------|---------|---------|
| `.prose pre` (components) vs `prose-pre:bg-gray-100` (utility) | FileViewerPage L150 | Issue修正方針3で対応済み |
| `.prose pre` (components) vs `prose-invert` の pre 背景色 | MessageList L189 | **未検討 -- ISSUE-301** |
| `.prose pre code:not(.hljs)` vs `.prose :not(pre) > code` | globals.css 内 | セレクタ構造異なるため干渉なし |
| `.prose pre` (overflow-hidden) vs カスタム pre (overflow-x-auto) | FileViewerPage L170 | utility が優先、実害なし |

---

## 参照ファイル

### コード
- `src/app/globals.css` L33-50: 修正対象のCSSルール
- `src/components/worktree/MarkdownEditor.tsx` L34, L854, L871: github-dark.css インポート + prose使用箇所
- `src/components/worktree/MessageList.tsx` L189, L596: prose + prose-invert 使用箇所
- `src/app/worktrees/[id]/files/[...path]/page.tsx` L150, L170-173: prose-slate + カスタムpreコンポーネント
- `src/components/worktree/FileViewer.tsx` L185: prose コンテナ外の pre（影響外）

### テスト
- `tests/unit/components/MarkdownEditor.test.tsx`: 既存機能テスト（CSSスタイル検証なし）
- `tests/unit/components/worktree/MessageListOptimistic.test.tsx`: MessageList既存テスト

### 設定
- `tailwind.config.js` L31: @tailwindcss/typography プラグイン設定

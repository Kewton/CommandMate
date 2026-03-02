# Issue #390: 言語未指定コードブロックの背景修正 - 設計方針書

## 1. 概要

### 問題
マークダウンファイル表示時、コードブロックに言語が指定されていない場合、背景が白/透明で文字が白（淡い灰色）になり、内容が読めない。

### 根本原因
`src/app/globals.css` の `.prose pre { @apply bg-transparent }` が Tailwind Typography のデフォルトダーク背景を透明に上書きしているが、`rehype-highlight` が言語未指定時に `.hljs` クラスを付与しないため、`highlight.js/styles/github-dark.css` のダーク背景が適用されず、透明背景+明るい文字色になる。

### 修正スコープ
- CSS修正のみ（ビジネスロジック変更なし）
- 3ファイルの変更（globals.css, FileViewerPage, MermaidDiagram.tsx）

## 2. アーキテクチャ設計

### 修正対象レイヤー

```
プレゼンテーション層（CSS/コンポーネント修正のみ）
├── globals.css          ← .prose pre フォールバック追加
├── MarkdownEditor.tsx   ← globals.css 修正で自動対応（変更不要）
├── MessageList.tsx      ← globals.css 修正で自動対応（変更不要）
├── MermaidDiagram.tsx   ← エラー表示 pre 要素への影響対応（D3-001）
└── FileViewerPage       ← カスタム pre コンポーネント + prose-pre クラス修正
```

### CSS カスケード構造

```
@layer components (.prose pre)           ← 最低優先度
  ↓ 上書きされる
Tailwind ユーティリティ (prose-pre:*)     ← 中優先度
  ↓ 上書きされる
インラインクラス (className=...)          ← 最高優先度
```

## 3. 技術選定

### 選定: CSSフォールバック方式

| 選択肢 | 方式 | メリット | デメリット | 採用 |
|--------|------|---------|-----------|------|
| A | `.prose pre code:not(.hljs)` フォールバック | 最小変更、既存の hljs スタイルに影響なし | ハードコード色値 | **採用** |
| B | `rehype-highlight` の `detect: true` 有効化 | 自動言語検出 | 誤検出リスク、パフォーマンス影響 | 不採用 |
| C | CSS変数による色管理 | 将来のダークモード対応が容易 | 本Issueのスコープ外、過剰設計 | 不採用 |

### 採用理由
- 方式Aは変更箇所が最小で、既存の `highlight.js` スタイルチェーンに影響を与えない
- `.hljs` クラスの有無で条件分岐でき、言語指定ありの場合は従来通り `github-dark.css` が適用される
- ハードコード色値 (`#0d1117`, `#c9d1d9`) は `github-dark` テーマの色に統一しており、一貫性がある
- 色値は globals.css に一元管理し、コンポーネント側への重複を排除する (D1-001対応)

## 4. 設計パターン

### フォールバックパターン

```css
/* 基本: 全 .prose pre に共通のダーク背景を設定 (D1-003: overflow-x-auto) */
.prose pre {
    @apply bg-[#0d1117] p-0 border-0 rounded-md overflow-x-auto;
}

/* 言語指定あり: hljs が完全にスタイルを管理 */
.prose pre code.hljs {
    @apply rounded-md;
    padding: 1rem;
}

/* 言語指定なし: hljs なし時のフォールバック */
.prose pre code:not(.hljs) {
    @apply block text-[#c9d1d9];
    padding: 1rem;
}
```

### CSS詳細度設計

| セレクタ | 詳細度 | 対象 |
|---------|--------|------|
| `.prose pre` | 0,1,1 | 全 prose 内 pre |
| `.prose pre code.hljs` | 0,2,1 | 言語指定あり code |
| `.prose pre code:not(.hljs)` | 0,2,2 | 言語指定なし code |
| `.prose :not(pre) > code` | 0,2,1 | インライン code（干渉なし） |

## 5. 変更ファイル設計

### 5-1. `src/app/globals.css`（修正）

**変更内容**: 既存の `.prose pre` ブロック (L33-35) および `.prose pre code.hljs` ブロック (L37-40) を置き換え

```css
/* Before */
.prose pre {
    @apply bg-transparent p-0 border-0;
}

.prose pre code.hljs {
    @apply rounded-md;
    padding: 1rem;
}

/* After (D1-003対応: overflow-hidden → overflow-x-auto に変更) */
.prose pre {
    @apply bg-[#0d1117] p-0 border-0 rounded-md overflow-x-auto;
}

.prose pre code.hljs {
    @apply rounded-md;
    padding: 1rem;
}

/* 言語未指定コードブロック（.hljsクラスなし）のフォールバック */
.prose pre code:not(.hljs) {
    @apply block text-[#c9d1d9];
    padding: 1rem;
}
```

**overflow-x-auto 採用理由 (D1-003)**: 当初の設計では `overflow-hidden` を指定していたが、これはコードブロック内の長い行を切り捨ててしまい、ユーザー体験を損なう可能性がある。`overflow-x-auto` に変更することで、長い行がある場合に横スクロールバーが表示され、コンテンツの可読性を維持できる。また、FileViewerPage のカスタム `pre` コンポーネントの `overflow-x-auto` と動作が統一されるため、全コンポーネントで一貫した横スクロール体験を提供できる。

**影響コンポーネント**:
- `MarkdownEditor.tsx`: 自動適用（`.prose` クラス使用、変更不要）
- `MessageList.tsx` (アシスタント): 自動適用（`.prose` クラス使用、変更不要）
- `MessageList.tsx` (ユーザー): `prose-invert` 付き。`bg-[#0d1117]` は `@layer components` 内のため `prose-invert` のスタイルが優先される可能性あり。ダーク背景同士のため視覚的問題は軽微
- `MessageList.tsx` (realtime output): inline クラス `bg-gray-900` が優先されるため影響なし。根拠: `bg-gray-900` は Tailwind ユーティリティクラス（layer なし）であり、`@layer components` 内の `.prose pre { bg-[#0d1117] }` より高い詳細度を持つため、`bg-gray-900` が優先される (D2-003)
- `MermaidDiagram.tsx` (エラー表示): MermaidCodeBlock 経由で MarkdownEditor のプレビュー領域（`.prose` コンテナ内）に描画される。エラー表示の `<pre className="text-sm text-red-500 mt-2 whitespace-pre-wrap break-words">` は明示的な背景色クラスを持たないため、`.prose pre { bg-[#0d1117] }` が適用され、赤テキストがダーク背景上に表示される視覚的不整合が生じる (D3-001)

**github-dark.css 適用メカニズムの前提 (D3-003)**: `highlight.js/styles/github-dark.css` は `MarkdownEditor.tsx` (L34) でのみ import されている。`MessageList.tsx` および `FileViewerPage` (page.tsx) は rehype-highlight を使用しているが github-dark.css を直接 import していない。ただし、Next.js はビルド時にクライアントコンポーネントの CSS import をグローバルに統合するため、MarkdownEditor が同一ビルドに含まれる限り、他のコンポーネント（MessageList、FileViewerPage）でも github-dark.css のスタイルが適用される。本設計方針書はこの Next.js ビルド時のグローバル CSS 統合を前提としている。

### 5-2. `src/app/worktrees/[id]/files/[...path]/page.tsx`（修正）

**変更1**: カスタム `pre` コンポーネント（L170-173）のスタイル変更

```tsx
// Before
pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto">
        {children}
    </pre>
),

// After (D1-001対応: 色指定を除去し、globals.css の .prose pre ルールを継承)
pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="overflow-x-auto">
        {children}
    </pre>
),
```

**設計根拠 (D1-001/D1-002)**: カスタム `pre` コンポーネントから `bg-[#0d1117]` / `text-[#c9d1d9]` / `rounded-md` / `p-4` を除去し、globals.css の `.prose pre` ルールを継承させる。これにより色値 (`#0d1117`, `#c9d1d9`) の管理を globals.css に一元化し、DRY原則を遵守する。カスタム `pre` コンポーネントには `overflow-x-auto` のみを残す。

**padding の管理 (D2-002)**: `.prose pre` の `p-0` により、pre 要素自体の padding は 0 に設定される。内部の code 要素（`.prose pre code.hljs` および `.prose pre code:not(.hljs)`）がそれぞれ `padding: 1rem` を持つことで、適切な内部余白が確保される。すなわち、pre 要素ではなく code 要素が padding を担う設計であり、padding の管理を code 要素に委譲している。

**カスタム `pre` コンポーネント維持の理由 (D1-002)**: globals.css の `.prose pre` には `overflow-x-auto` ではなく異なる overflow 設定を適用する可能性があるため、FileViewerPage では横スクロールを明示的に保証する目的でカスタム `pre` コンポーネントを維持する。色管理は globals.css に委ね、レイアウト制御（overflow-x-auto）のみをカスタム `pre` コンポーネントの責務とする。

**変更2**: prose コンテナ（L150）の `prose-pre:bg-gray-100` 削除

```tsx
// Before (L150の一部)
... prose-pre:bg-gray-100 prose-pre:border prose-pre:border-gray-200 ...

// After
... (prose-pre:bg-gray-100 prose-pre:border prose-pre:border-gray-200 を削除)
```

**方針**: globals.css の `.prose pre` ルールが色・背景を一元管理するため、`prose-pre:*` ユーティリティクラスは不要。削除して globals.css に統一する。

**非マークダウンファイルへの影響 (D1-004)**: FileViewerPage の非マークダウンファイル表示（L204付近の `<pre className="bg-gray-50 border border-gray-200 ...">` タグ）は `.prose` コンテナ外に配置されているため、globals.css の `.prose pre` ルールの影響を受けない。本 Issue の修正スコープ外であり、変更不要。

**スコープ外の DRY 違反記録 (D3-004)**: FileViewerPage (page.tsx L157-162) のカスタム `code` コンポーネント（inline 時）は `className='bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded text-sm font-mono'` を直接指定している。一方 globals.css (L43-45) には `.prose :not(pre) > code { @apply bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded text-sm font-mono }` が定義されており、両者は同一のスタイルを適用している。DRY 原則の観点では冗長であるが、本 Issue #390 の修正スコープ外であり、機能的な問題もないため、将来のリファクタリング候補として記録のみとする。

### 5-3. `src/components/worktree/MermaidDiagram.tsx`（エラー表示修正 - オプション）(D3-001)

**対象**: L150-159 のエラー表示 `<pre>` 要素

**問題**: MermaidDiagram のエラー表示は MermaidCodeBlock 経由で `.prose` コンテナ内に描画される。エラー表示の `<pre>` 要素には明示的な背景色クラスが指定されていないため、globals.css の `.prose pre { bg-[#0d1117] }` が適用され、赤いエラーテキスト (`text-red-500`) がダーク背景 (`#0d1117`) 上に表示される視覚的不整合が生じる。

**修正方針**: エラー表示の `<pre>` 要素に `bg-red-50` 等の明示的な背景色クラスを追加する。Tailwind ユーティリティクラスは `@layer components` 内の `.prose pre` より高い優先度を持つため、`bg-red-50` が `.prose pre` の `bg-[#0d1117]` を上書きする。

```tsx
// Before
<pre className="text-sm text-red-500 mt-2 whitespace-pre-wrap break-words">
    {error}
</pre>

// After (D3-001対応: 明示的背景色でproseのダーク背景を上書き)
<pre className="text-sm text-red-500 mt-2 whitespace-pre-wrap break-words bg-red-50">
    {error}
</pre>
```

**CSS カスケード根拠**: `bg-red-50` は Tailwind ユーティリティクラス（layer なし）として出力され、`@layer components` 内の `.prose pre { bg-[#0d1117] }` より高い詳細度を持つ。したがって `bg-red-50` が優先される。これは `MessageList.tsx` の realtime output (`bg-gray-900`) と同じメカニズムである (D2-003参照)。

## 6. セキュリティ設計

### XSS リスク

- 本修正は CSS スタイル変更のみであり、ユーザー入力を処理するロジックの変更はない
- `rehype-sanitize` による XSS 保護は `MarkdownEditor.tsx` で適用されている。`FileViewerPage` (page.tsx) および `MessageList.tsx` は `rehype-sanitize` を使用していないが、本 CSS 修正はユーザー入力処理ロジックを変更しないため、XSS リスクの増減はない (D4-001)
- **注記**: `FileViewerPage` と `MessageList` への `rehype-sanitize` 追加は本 Issue のスコープ外であり、別 Issue として検討すべきである

### CSS Injection リスク (D4-002)

追加される色値（`#0d1117`, `#c9d1d9`）は `globals.css` にハードコードされた静的値であり、ユーザー入力やサーバーサイドの動的値に依存しない。CSS Injection のリスクはない。

### dangerouslySetInnerHTML への影響分析 (D4-003)

本修正で変更される `.prose pre` のスタイルは、`dangerouslySetInnerHTML` を使用する以下のコンポーネントに影響しうるが、いずれも HTML 生成ロジック自体は変更されないため安全である。

| コンポーネント | dangerouslySetInnerHTML の用途 | `.prose pre` スタイル変更の影響 | 安全性 |
|--------------|------------------------------|-------------------------------|--------|
| `MermaidDiagram.tsx` (L169) | Mermaid が生成した SVG を描画 | `.prose` コンテナ内に描画されるため、`pre` 要素のスタイル変更の影響を受けうる。ただし SVG 描画は `pre` 要素ではなく `div` 要素に対して行われるため、直接的な影響はない | 安全 |
| `MessageList.tsx` (L199/L600) | ANSI エスケープシーケンスを HTML に変換して表示 | realtime output の `pre` 要素は `bg-gray-900` (Tailwind ユーティリティ) が `@layer components` の `.prose pre` より優先されるため、背景色は変更されない (D2-003) | 安全 |

### コンテンツ視認性への影響

ダーク背景変更によるテキスト視認性は、セクション8の手動テスト T-001 から T-010 でカバーされる。

## 7. パフォーマンス設計

- CSS ルール追加は1ルール（`.prose pre code:not(.hljs)`）のみ
- `:not()` 擬似クラスのパフォーマンス影響は無視可能
- JavaScript の変更なし
- パフォーマンスへの影響なし

## 8. テスト戦略

### テスト方針
本修正はCSS視覚変更のため、**手動テストが主体**。Vitest + jsdom ではCSSレンダリングを検証できない。

### テストケース（手動テスト10パターン）

| # | コンポーネント | シナリオ | 優先度 |
|---|-------------|---------|--------|
| T-001 | MarkdownEditor | 言語未指定コードブロック | 高 |
| T-002 | MarkdownEditor | 言語指定ありコードブロック（リグレッション） | 高 |
| T-003 | MessageList | アシスタントメッセージ - 言語未指定 | 高 |
| T-004 | MessageList | アシスタントメッセージ - 言語指定あり | 高 |
| T-005 | MessageList | ユーザーメッセージ（prose-invert） | 中 |
| T-006 | FileViewerPage | マークダウン - 言語未指定 | 高 |
| T-007 | 全コンポーネント | インラインコード（リグレッション） | 高 |
| T-008 | MessageList | realtime output ANSI出力（リグレッション） | 低 |
| T-009 | MermaidDiagram | エラー表示 - `.prose` 内の非コードブロック pre が適切な背景色で表示されること (D3-001) | 中 |
| T-010 | FileViewerPage | 非マークダウンファイル表示 - `.prose` 外の pre 要素がリグレッションしていないこと (D3-002) | 低 |

### 自動テスト
- `npx tsc --noEmit`: TypeScript型チェック（TSXファイル変更あり）
- `npm run lint`: ESLint チェック
- `npm run test:unit`: 既存ユニットテストのリグレッション確認

## 9. 設計上の決定事項とトレードオフ

| 決定事項 | 理由 | トレードオフ | レビュー対応 |
|---------|------|-------------|-------------|
| ハードコード色値 `#0d1117`/`#c9d1d9` を globals.css に一元管理 | DRY原則遵守。色値の変更箇所を1ファイルに限定 | 将来のダークモード対応時にCSS変数化が必要 | D1-001 |
| カスタム `pre` コンポーネントは `overflow-x-auto` のみ保持 | globals.css の `.prose pre` ルールを継承し、色管理を委ねる。レイアウト制御のみをカスタム `pre` の責務とする | カスタム `pre` コンポーネントの存在理由が弱くなるが、overflow-x-auto の明示的保証のため維持 | D1-001, D1-002 |
| `prose-pre:*` ユーティリティ削除 | globals.css に一元化 | FileViewerPage の prose 設定が長い文字列のまま | - |
| `overflow-x-auto` を `.prose pre` に適用 | 長い行の横スクロールを全コンポーネントで統一。`overflow-hidden` はコンテンツ切り捨てのリスクがある | 横スクロールバーが表示される場合があるが、コンテンツの可読性を優先 | D1-003 |
| `MessageList.tsx` は globals.css で自動対応 | コンポーネント固有修正不要 | prose-invert との微妙な競合は許容 | - |
| 非マークダウンファイル表示は影響なし | `.prose` コンテナ外のため `.prose pre` ルールは適用されない | 設計方針書に明記して後から確認しやすくする | D1-004 |

## 10. 実装順序

1. `src/app/globals.css` の `.prose pre` を `bg-transparent` から `bg-[#0d1117] p-0 border-0 rounded-md overflow-x-auto` に変更
2. `src/app/globals.css` に `.prose pre code:not(.hljs)` フォールバックルールを追加
3. `src/app/worktrees/[id]/files/[...path]/page.tsx` のカスタム `pre` コンポーネントから色指定を除去し、`overflow-x-auto` のみ残す (D1-001)
4. 同ファイルの `prose-pre:*` ユーティリティクラス削除
5. `src/components/worktree/MermaidDiagram.tsx` のエラー表示 `<pre>` に `bg-red-50` を追加 (D3-001)
6. 非マークダウンファイル表示（L204付近）に影響がないことを目視確認 (D1-004)
7. `npx tsc --noEmit` + `npm run lint` で静的チェック
8. `npm run test:unit` でリグレッション確認
9. 手動テスト（10パターン: T-001 -- T-010）

## 11. レビュー指摘事項サマリー (Stage 1: 通常レビュー)

### 反映済み指摘事項

| ID | 重要度 | 原則 | タイトル | 対応内容 |
|----|--------|------|---------|---------|
| D1-001 | should_fix | DRY | ハードコード色値の重複 | カスタム `pre` コンポーネントから色指定を除去し、globals.css に一元化（セクション5-2） |
| D1-002 | should_fix | 一貫性 | カスタム pre と globals.css の役割分担不明確 | カスタム `pre` の維持理由（overflow-x-auto）を明記し、色管理は globals.css に委ねる設計を明確化（セクション5-2） |
| D1-003 | nice_to_have | YAGNI | overflow-hidden の必要性不明 | `overflow-hidden` を `overflow-x-auto` に変更。全コンポーネントで横スクロール動作を統一（セクション4, 5-1） |
| D1-004 | nice_to_have | DRY | 非マークダウンコード表示への影響未記載 | `.prose` コンテナ外のため影響なしであることをセクション5-2に明記 |

### 実装チェックリスト

- [ ] globals.css: `.prose pre` の `bg-transparent` を `bg-[#0d1117]` に変更し、`rounded-md overflow-x-auto` を追加
- [ ] globals.css: `.prose pre code:not(.hljs)` フォールバックルールを追加
- [ ] page.tsx: カスタム `pre` コンポーネントから `bg-gray-50 border border-gray-200 rounded-md p-4` を除去し、`overflow-x-auto` のみ残す (D1-001)
- [ ] page.tsx: `prose-pre:bg-gray-100 prose-pre:border prose-pre:border-gray-200` を削除
- [ ] MermaidDiagram.tsx: エラー表示 `<pre>` に `bg-red-50` クラスを追加 (D3-001)
- [ ] 非マークダウンファイル表示（L204付近）に影響がないことを確認 (D1-004)
- [ ] `npx tsc --noEmit` 型チェック通過
- [ ] `npm run lint` リントチェック通過
- [ ] `npm run test:unit` リグレッションなし
- [ ] 手動テスト（10パターン: T-001 -- T-010）

## 12. レビュー指摘事項サマリー (Stage 2: 整合性レビュー)

### 反映済み指摘事項

| ID | 重要度 | カテゴリ | タイトル | 対応内容 |
|----|--------|---------|---------|---------|
| D2-001 | must_fix | Before記述 | 実装チェックリストのカスタムpreコンポーネント除去対象クラスが実コードと不一致 | セクション11の実装チェックリスト3番目の項目を修正: `bg-[#0d1117] text-[#c9d1d9]` を実コードの `bg-gray-50 border border-gray-200` に訂正 |
| D2-002 | should_fix | 設計vs実装 | FileViewerPageのカスタムpreコンポーネントAfterでglobals.cssのp-0との競合が未分析 | セクション5-2に「padding の管理 (D2-002)」として、`.prose pre` の `p-0` により pre 要素の padding が 0 となり、code 要素の `padding: 1rem` で内部余白を確保する設計を明記 |
| D2-003 | nice_to_have | 影響範囲 | MessageList.tsxのrealtime output内のprose preへの影響分析が簡潔すぎる | セクション5-1の影響コンポーネント記述に CSS カスケードの根拠（Tailwind ユーティリティクラスは layer なしのため @layer components より高い詳細度を持つ）を補足 |

### 整合性チェック結果

| 対象ファイル | 整合性 |
|-------------|--------|
| globals.css | consistent |
| page.tsx | inconsistent → **修正済み** (D2-001) |
| MarkdownEditor.tsx | consistent |
| MessageList.tsx | consistent |

## 13. レビュー指摘事項サマリー (Stage 3: 影響分析レビュー)

### 反映済み指摘事項

| ID | 重要度 | カテゴリ | タイトル | 対応内容 |
|----|--------|---------|---------|---------|
| D3-001 | should_fix | 波及範囲 | MermaidDiagram エラー表示の pre 要素が .prose pre ルール変更の影響を受ける | セクション2の修正対象レイヤーに MermaidDiagram.tsx を追加、セクション5-1の影響コンポーネントに追記、セクション5-3に修正方針を新設、実装チェックリストおよび実装順序に反映 |
| D3-002 | should_fix | テスト範囲 | テスト計画に Mermaid エラー表示ケースと FileViewerPage 非マークダウンファイル確認が不足 | セクション8のテストケーステーブルに T-009（MermaidDiagram エラー表示、中優先度）と T-010（FileViewerPage 非マークダウンファイル表示、低優先度）を追加。実装チェックリストと実装順序のテストパターン数を 8 から 10 に更新 |
| D3-003 | nice_to_have | 波及範囲 | highlight.js/styles/github-dark.css の import が MarkdownEditor.tsx のみにある点の影響分析 | セクション5-1に「github-dark.css 適用メカニズムの前提 (D3-003)」として、Next.js ビルド時のグローバル CSS 統合により他コンポーネントでも github-dark.css が適用される前提を明記 |
| D3-004 | nice_to_have | CSS詳細度 | FileViewerPage の inline code カスタムコンポーネントが globals.css のインラインコードルールと重複 | セクション5-2に「スコープ外の DRY 違反記録 (D3-004)」として、本 Issue スコープ外の DRY 違反を将来のリファクタリング候補として記録 |

### 影響分析結果サマリー

| 分析対象 | 結果 |
|---------|------|
| `.prose` コンテナ内の pre 要素（設計カバー済み） | MarkdownEditor, MessageList (assistant/user/realtime), FileViewerPage -- 全てセクション5-1で分析済み |
| `.prose` コンテナ内の pre 要素（新規発見） | MermaidDiagram.tsx エラー表示 -- D3-001で追加対応 |
| `.prose` コンテナ外の pre 要素 | FileViewer, ExecutionLogPane, LogViewer, FileViewerPage(非MD) -- 影響なし |
| CSS 詳細度の波及リスク | 低。`:not(.hljs)` セレクタは既存の `.hljs` スタイルに干渉しない |
| github-dark.css の適用範囲 | Next.js ビルド時のグローバル CSS 統合により全ページで適用 -- D3-003で前提を明記 |

## 14. レビュー指摘事項サマリー (Stage 4: セキュリティレビュー)

### 反映済み指摘事項

| ID | 重要度 | OWASP | タイトル | 対応内容 |
|----|--------|-------|---------|---------|
| D4-001 | nice_to_have | A07 | FileViewerPage および MessageList に rehype-sanitize が未適用（既存問題・スコープ外） | セクション6の XSS リスク記述を修正: rehype-sanitize の適用範囲を MarkdownEditor.tsx のみと正確に記述し、FileViewerPage/MessageList は未適用だが本 CSS 修正による XSS リスク増減はない旨を明記 |
| D4-002 | nice_to_have | N/A | セキュリティ設計セクションに CSS Injection 分析が欠如 | セクション6に「CSS Injection リスク」サブセクションを追加: ハードコード静的値のため CSS Injection リスクなしと明記 |
| D4-003 | nice_to_have | N/A | セキュリティ設計セクションの記述が簡潔すぎる | セクション6に「dangerouslySetInnerHTML への影響分析」サブセクションを追加: MermaidDiagram.tsx と MessageList.tsx の dangerouslySetInnerHTML 使用箇所への影響を分析し、HTML 生成ロジック未変更のため安全と明記。「コンテンツ視認性への影響」サブセクションも追加 |

### OWASP Top 10 準拠チェック結果

| カテゴリ | 結果 |
|---------|------|
| A03 Injection | pass |
| A04 Insecure Design | pass |
| A05 Security Misconfiguration | pass |
| A07 XSS | pass |

### セキュリティレビュー総評

Issue #390 の設計方針書は CSS のみの変更であり、セキュリティリスクは極めて低い。OWASP Top 10 の主要カテゴリは全て pass と評価された。指摘事項 3 件は全て nice_to_have レベルであり、設計方針書の記述精度向上を目的としたものである。highlight.js 11.11.1 および rehype-highlight 7.0.2 に既知の脆弱性は確認されなかった。

---

*Generated by design-policy command for Issue #390*

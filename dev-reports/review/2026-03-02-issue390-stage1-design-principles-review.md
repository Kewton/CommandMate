# Issue #390 Stage 1 Architecture Review: 設計原則

**Issue**: #390 - 言語未指定コードブロックの背景修正
**Stage**: 1 (通常レビュー)
**Focus**: 設計原則 (SOLID/KISS/YAGNI/DRY)
**Date**: 2026-03-02
**Status**: conditionally_approved
**Score**: 4/5

---

## Executive Summary

設計方針書は全体として KISS 原則に沿ったシンプルな CSS 修正アプローチを採用しており、技術選定（方式A: CSSフォールバック方式）は適切である。修正スコープを CSS のみに限定し、ビジネスロジックの変更を伴わない方針は高く評価できる。

主な改善ポイントは、ハードコード色値の重複（DRY）と FileViewerPage における修正アプローチの一貫性の2点。いずれも must_fix ではないが、実装前に方針を整理しておくことで保守性が向上する。

---

## 設計原則チェックリスト

### KISS (Keep It Simple, Stupid)

- [x] **修正スコープが最小限**: CSS修正のみ、JavaScript変更なし
- [x] **技術選定が適切**: `detect: true` やCSS変数方式を不採用とした判断は正しい
- [x] **変更ファイル数が最小**: 実質2ファイル（globals.css + page.tsx）
- [ ] **一部過剰**: `.prose pre` への `overflow-hidden` 追加は、現時点で報告されていない問題への対処（D1-003参照）

**評価**: 良好。方式B（rehype-highlight detect:true）や方式C（CSS変数）を不採用とした判断は的確で、最小の変更で問題を解決する方針が貫かれている。

### YAGNI (You Aren't Gonna Need It)

- [x] **不要な機能が含まれていない**: CSS変数化やダークモード切替機構は将来課題として適切にスコープ外にしている
- [x] **テスト戦略が現実的**: CSS変更に対してVitest自動テストではなく手動テストを主体とする判断は正しい
- [ ] **overflow-hidden**: 明確な問題報告がないまま追加している点は軽微なYAGNI違反の可能性あり

**評価**: 良好。将来のダークモード対応をスコープ外にした判断は特に良い。

### DRY (Don't Repeat Yourself)

- [ ] **色値の重複**: `#0d1117` が globals.css と page.tsx の2箇所に登場（D1-001参照）
- [ ] **色値の重複**: `#c9d1d9` が globals.css と page.tsx の2箇所に登場（D1-001参照）
- [x] **prose-pre:* 削除によるカスタム pre への一元化**: 方向性は正しい

**評価**: 改善の余地あり。設計方針としてハードコード色値を `github-dark` テーマに合わせる意図は理解できるが、同じ値が2ファイルに散在する点は DRY 違反。

### SOLID 原則

- [x] **単一責任**: globals.css がグローバルスタイル、page.tsx がページ固有スタイルという責務分離は適切
- [x] **開放閉鎖**: 既存の `.hljs` スタイルチェーンに影響を与えない `:not(.hljs)` フォールバック設計は、拡張に開いている
- N/A: その他の SOLID 原則は CSS 修正のため該当なし

**評価**: 良好。

### 修正の一貫性

- [ ] **アプローチの不統一**: MarkdownEditor/MessageList は globals.css で自動対応、FileViewerPage はカスタム pre コンポーネントで個別対応（D1-002参照）
- [x] **色テーマの一貫性**: 全箇所で `github-dark` テーマの色に統一
- [x] **CSS詳細度の分析**: 設計方針書の詳細度テーブルは的確

**評価**: 概ね良好だが、FileViewerPage の修正アプローチが他と異なる点の理由付けが不足。

---

## 詳細指摘事項

### D1-001: ハードコード色値の重複 [should_fix / DRY]

**場所**: 設計方針書 セクション5-1 (globals.css) と セクション5-2 (page.tsx)

**問題**: `#0d1117`（背景色）と `#c9d1d9`（テキスト色）が globals.css と page.tsx の両方に記載されている。

```css
/* globals.css */
.prose pre {
    @apply bg-[#0d1117] p-0 border-0 rounded-md overflow-hidden;
}
.prose pre code:not(.hljs) {
    @apply block text-[#c9d1d9];
    padding: 1rem;
}
```

```tsx
/* page.tsx - カスタム pre コンポーネント */
<pre className="bg-[#0d1117] text-[#c9d1d9] rounded-md p-4 overflow-x-auto">
```

**提案**: page.tsx のカスタム pre コンポーネントでは色指定を省略し、globals.css の `.prose pre` と `.prose pre code:not(.hljs)` に統一する方式を検討する。カスタム pre コンポーネントに残すのはレイアウト関連（`p-4 overflow-x-auto`）のみとし、色は globals.css から継承させる。

ただし、カスタム pre コンポーネントの className が Tailwind の `bg-*` を含む場合、globals.css の `@layer components` ルールより優先度が高くなるため、色を省略すれば自然に globals.css のルールが適用される。

---

### D1-002: FileViewerPage の修正アプローチの一貫性 [should_fix / 一貫性]

**場所**: 設計方針書 セクション2 (アーキテクチャ設計) と セクション5-2

**問題**: MarkdownEditor と MessageList は globals.css の修正だけで自動対応するのに対し、FileViewerPage のみカスタム pre コンポーネントの className を直接変更する設計となっている。

現在の page.tsx（L170-173）のカスタム pre コンポーネント:
```tsx
pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto">
        {children}
    </pre>
),
```

このカスタム pre コンポーネントが globals.css の `.prose pre` ルールを完全に上書きしているため、FileViewerPage だけ別のスタイル管理方式になっている。

**提案**: 以下のいずれかを選択し、設計方針書に理由を明記する。

- **案A（推奨）**: カスタム pre コンポーネントを削除し、globals.css の `.prose pre` に統一。`overflow-x-auto` が必要であれば globals.css 側に追加。
- **案B**: カスタム pre コンポーネントを維持するが、色値は省略して globals.css から継承。レイアウトのみカスタム定義。

---

### D1-003: overflow-hidden 追加の必要性 [nice_to_have / YAGNI]

**場所**: 設計方針書 セクション5-1

**問題**: `.prose pre` に `overflow-hidden` を追加する設計だが、セクション9のトレードオフ表で自ら「FileViewerPage では無効」と認めている。MarkdownEditor/MessageList で長い行のコードブロックが `overflow-hidden` により切り捨てられるリスクがある。

**提案**: `overflow-hidden` ではなく `overflow-x-auto`（横スクロール可能）を検討するか、現時点では追加しない。

---

### D1-004: 非マークダウンコード表示への影響記載漏れ [nice_to_have / DRY]

**場所**: page.tsx L202-208（設計方針書に記載なし）

**問題**: FileViewerPage には非マークダウンファイル用のコード表示 pre タグ（L204）があるが、設計方針書で言及されていない。`.prose` コンテナ外のため影響はないが、明示しておくと確認しやすい。

```tsx
// L202-208: 非マークダウンファイルのコード表示
<pre className="bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto text-sm">
    <code className={`language-${content.extension}`}>
        {content.content}
    </code>
</pre>
```

**提案**: 設計方針書に「非マークダウンファイルのコード表示（L204）は .prose コンテナ外のため影響なし」を追記。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 色値重複による将来のテーマ変更時の変更漏れ | Low | Medium | P3 |
| 技術的リスク | overflow-hidden によるコード切り捨て | Medium | Low | P3 |
| セキュリティ | なし（CSS変更のみ） | - | - | - |
| 運用リスク | なし | - | - | - |

---

## フォールバック設計の評価

`.prose pre code:not(.hljs)` によるフォールバック設計は技術的に適切である。

**良い点**:
- `.hljs` クラスの有無で条件分岐する `:not(.hljs)` セレクタは、rehype-highlight の動作仕様と整合
- CSS詳細度 (0,2,2) は `.prose pre code.hljs` (0,2,1) より高いため、意図しない上書きが起きない
- 言語指定ありの場合は従来通り `github-dark.css` が適用される

**注意点**:
- `github-dark.css` のインポートが `MarkdownEditor.tsx` のみにある点は、Next.js のバンドルにより他コンポーネントでも利用可能だが、設計方針書で明示しておくとよい

---

## 総合評価

| 項目 | 評価 |
|------|------|
| KISS | 4/5 - overflow-hidden の追加が若干過剰 |
| YAGNI | 5/5 - 不要な機能の追加なし |
| DRY | 3/5 - 色値の2箇所重複 |
| 一貫性 | 3/5 - FileViewerPage のみ異なるアプローチ |
| フォールバック設計 | 5/5 - 技術的に正しく明確 |
| **総合** | **4/5** |

**判定**: conditionally_approved (条件付き承認)

D1-001 と D1-002 の should_fix 項目について方針を確認・整理した上で実装に進むことを推奨する。いずれも設計の根本を変える必要はなく、色値管理の一元化とカスタム pre コンポーネントの要否を明確にするだけで解決できる。

---

*Generated by architecture-review-agent for Issue #390 Stage 1*

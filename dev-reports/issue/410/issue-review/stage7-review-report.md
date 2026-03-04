# Issue #410 Stage 7 レビューレポート - 影響範囲レビュー（2回目）

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: Stage 7（最終影響範囲レビュー）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 1 |

**総合評価**: good

Issue #410 は Stage 3 の影響範囲レビューで指摘された Must Fix (IAF-003) および Should Fix (IAF-001, IAF-002, IAF-005, IAF-006, IAF-009) の全てが適切に反映されており、影響範囲の記載は正確で網羅的です。新たな Must Fix / Should Fix 指摘はありません。

---

## 前回指摘事項の対応確認

### IAF-003 (Must Fix): named export の next/dynamic パターン - **対応済み**

Stage 3 で指摘した「MarkdownEditor と TerminalComponent は named export であるため、`next/dynamic` 使用時に `.then((mod) => ({ default: mod.XXX }))` パターンが必要」という問題は、以下の3箇所で完全に対応されています。

1. **解決策セクション3「named exportに関する注意事項」** - 独立セクションとして新設され、MarkdownEditor/TerminalComponent 両方の `.then()` パターンが明記されている
2. **実装タスク** - 各タスクに `.then((mod) => ({ default: mod.TerminalComponent }))` / `.then((mod) => ({ default: mod.MarkdownEditor }))` パターン使用が記載されている
3. **参考実装の明示** - `src/components/worktree/MermaidCodeBlock.tsx` (L20-23) が参考パターンとして記載されている

**検証根拠**:
- `src/components/worktree/MarkdownEditor.tsx` L110: `export function MarkdownEditor(...)` (named export)
- `src/components/Terminal.tsx` L20: `export function TerminalComponent(...)` (named export)
- 既存パターン: `src/components/worktree/MermaidCodeBlock.tsx` L20-24, `src/app/login/page.tsx` L23-25

---

## 影響範囲テーブルの正確性検証

Issue の影響範囲テーブルに記載された全6エントリを検証しました。

| ファイル | Issue記載の変更内容 | 検証結果 |
|---------|--------------------|---------|
| `terminal/page.tsx` | Terminal.tsx動的import化 | 正確。L9 で TerminalComponent を静的 import しており、dynamic import に変更が必要 |
| `WorktreeDetailRefactored.tsx` | MarkdownEditor動的import化 | 正確。L39 で MarkdownEditor を静的 import しており、dynamic import に変更が必要 |
| `MarkdownEditor.tsx` | 参照のみ、変更なし | 正確。named export のままでよく、ファイル自体の変更は不要 |
| `Terminal.tsx` | 参照のみ、変更なし | 正確。named export のままでよく、ファイル自体の変更は不要 |
| `MarkdownEditor.test.tsx` | 変更不要 | 正確。L16 で `import { MarkdownEditor } from '@/components/worktree/MarkdownEditor'` と直接 import しているため影響なし |
| `WorktreeDetailRefactored.test.tsx` | 変更不要 | 正確。MarkdownEditor への参照が一切ないことを grep で確認済み |

---

## テスト影響の正確性検証

- **MarkdownEditor.test.tsx**: MarkdownEditor を `@/components/worktree/MarkdownEditor` から直接 import (L16)。WorktreeDetailRefactored.tsx 内の import 方式変更の影響を受けない。Issue の「変更不要」記載は正確。
- **WorktreeDetailRefactored.test.tsx**: MarkdownEditor への参照が 0 件であることを grep で確認。Issue の「MarkdownEditor を参照していない」記載は正確。
- **`npm run test:unit` パス確認**: 実装タスクに明記されており適切。

---

## 技術的解決策の正確性検証

1. **named export の .then() パターン**: Next.js ドキュメントに準拠し、プロジェクト内で `MermaidCodeBlock.tsx` (L20-34) および `login/page.tsx` (L23-26) で実績のあるパターン。正確。
2. **ssr: false の必要性**: `terminal/page.tsx` は `'use client'` 宣言済みだが、Issue が正しく指摘するように Next.js App Router はプリレンダリング時にサーバー側でも Client Component を実行するため、xterm.js のような DOM 依存ライブラリには `ssr: false` が必要。正確。
3. **props 型維持**: `next/dynamic` は `.then()` パターンで返されたコンポーネントの props 型を維持するため、`EditorProps` の import 変更は不要。WorktreeDetailRefactored.tsx に `EditorProps` の import がないことも確認済み。正確。
4. **条件付きレンダリング**: MarkdownEditor は `editorFilePath && (...)` 条件 (L2061, L2300) でのみレンダリングされるため、遅延ロードの効果が高い。正確。

---

## 見落としリスクの確認

以下の観点で追加の影響範囲を調査しましたが、新たな問題は発見されませんでした。

1. **MarkdownEditor の import 元**: `WorktreeDetailRefactored.tsx` (L39) と `MarkdownEditor.test.tsx` (L16) の 2 箇所のみ。他に影響なし。
2. **TerminalComponent の import 元**: `terminal/page.tsx` (L9) の 1 箇所のみ。他に影響なし。
3. **TerminalDisplay との混同リスク**: `WorktreeDetailRefactored.tsx` (L25) が import する `TerminalDisplay` は xterm.js を使用しない別コンポーネントであることを確認。影響なし。
4. **MessageList.tsx のスコープ外判断**: barrel export (`src/components/worktree/index.ts` L12) に含まれるが、`/worktrees/[id]` ページのコンポーネントツリーから直接使用されていないことを確認。barrel import は `src/app/page.tsx` (`WorktreeList` のみ) で使用。スコープ外の判断は妥当。`npm run build` 後の確認タスクも記載済み。
5. **EditorProps 型の import**: WorktreeDetailRefactored.tsx に `EditorProps` の import がないことを確認。dynamic import 変更で型 import の追加は不要。

---

## Nice to Have 指摘

### IAF2-001: globals.css の参照行追加

**カテゴリ**: 完全性
**場所**: 影響範囲テーブル

**問題**:
`MarkdownEditor.tsx` (L35) が `import 'highlight.js/styles/github-dark.css'` をインポートしている。dynamic import 化するとこの CSS の適用タイミングがコンポーネントロード時に遅延する。`globals.css` (L32-46) に highlight.js CSS との競合修正スタイル (`.prose pre`、`.prose pre code.hljs` 等) が定義されている。MarkdownEditor はモーダル内で表示されロード完了後にレンダリングされるため実質的な問題は起きないが、影響範囲テーブルに globals.css を参照ファイルとして記載すると実装者が動作確認時のチェックポイントとして意識できる。

**推奨対応**:
影響範囲テーブルに `| src/app/globals.css | （参照のみ、変更なし）highlight.js競合修正スタイル | /worktrees/[id] |` を追加。

**備考**: Stage 3 の IAF-008 (Nice to Have) と同様の指摘であり、対応は任意。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/src/components/worktree/WorktreeDetailRefactored.tsx` L39: MarkdownEditor 静的 import、L2061/L2300: 条件付きレンダリング
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/src/app/worktrees/[id]/terminal/page.tsx` L9: TerminalComponent 静的 import
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/src/components/worktree/MarkdownEditor.tsx` L110: named export 確認、L33-35: rehype-highlight/highlight.js import
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/src/components/Terminal.tsx` L20: named export 確認、L9-12: xterm.js import
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/src/components/worktree/MermaidCodeBlock.tsx` L20-34: 既存 dynamic import パターン（参考実装）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/src/app/login/page.tsx` L23-26: 既存 dynamic import パターン（参考実装）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/src/components/worktree/index.ts` L12: MessageList barrel export 確認
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/src/app/globals.css` L32-46: highlight.js 競合修正スタイル

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/tests/unit/components/MarkdownEditor.test.tsx` L16: 直接 import 確認
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/tests/unit/components/WorktreeDetailRefactored.test.tsx`: MarkdownEditor 参照なし確認

### レビュー履歴
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-410/dev-reports/issue/410/issue-review/stage3-review-result.json`: Stage 3 影響範囲レビュー（1回目）結果

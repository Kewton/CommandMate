# Issue #410 Stage 3 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: Stage 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 5 |
| Nice to Have | 3 |

**総合評価**: acceptable

Issue #410 の影響範囲は概ね正確に特定されているが、named export に対する next/dynamic の使い方に関する重要な実装詳細が欠落している。テストファイルへの影響分析も明示的に記載すべき。

---

## Must Fix（必須対応）

### IAF-003: MarkdownEditor は named export であり next/dynamic での import 時に .then(mod => ...) が必要

**カテゴリ**: 技術的正確性

**問題**:
`MarkdownEditor.tsx` は `export function MarkdownEditor(...)` (L110) という named export である。default export ではない。`next/dynamic` のデフォルトの使い方は default export を前提としているため、`WorktreeDetailRefactored.tsx` で単純に `dynamic(() => import('./MarkdownEditor'))` とすると、default export がない旨のエラーになる。

**証拠**:
- `src/components/worktree/MarkdownEditor.tsx` L110: `export function MarkdownEditor({`
- 既存の正しいパターン: `src/components/worktree/MermaidCodeBlock.tsx` L20-23:
  ```typescript
  const MermaidDiagram = dynamic(
    () =>
      import('./MermaidDiagram').then((mod) => ({
        default: mod.MermaidDiagram,
      })),
    { ssr: false, loading: () => (...) }
  );
  ```
- 同様: `src/app/login/page.tsx` L23-24:
  ```typescript
  const QrCodeGenerator = dynamic(
    () => import('@/components/auth/QrCodeGenerator').then((m) => ({ default: m.QrCodeGenerator })),
    { ssr: false }
  );
  ```

**推奨対応**:
実装タスクまたは解決策セクションに以下を追記:
> MarkdownEditor は named export のため、dynamic import 時は既存の MermaidCodeBlock.tsx パターンに倣い `.then((mod) => ({ default: mod.MarkdownEditor }))` を使用する。TerminalComponent も同様に named export である。参考: `src/components/worktree/MermaidCodeBlock.tsx` L20-23

---

## Should Fix（推奨対応）

### IAF-001: MarkdownEditor.test.tsx でのdynamic import対応が未記載

**カテゴリ**: テスト範囲の明確性

**問題**:
`tests/unit/components/MarkdownEditor.test.tsx` (L16) は `MarkdownEditor` を直接 import してテストしている。`WorktreeDetailRefactored.tsx` 側で `next/dynamic` を使って MarkdownEditor を動的importに変更しても、このテストファイル自体は影響を受けない。しかし、Issue の実装タスクに「既存テスト（MarkdownEditor.test.tsx等）の更新・動作確認」と記載がある一方で、具体的に何を更新するのかが不明確。

**証拠**:
- `tests/unit/components/MarkdownEditor.test.tsx` L16: `import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';`
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`: MarkdownEditor への参照なし

**推奨対応**:
実装タスクを具体化する:
- MarkdownEditor.test.tsx: 変更不要（直接 import のため dynamic import の影響を受けない）
- WorktreeDetailRefactored.test.tsx: 変更不要（MarkdownEditor を参照していない）
- 動作確認として `npm run test:unit` の全テストパスを確認するタスクに限定

---

### IAF-002: MessageList.tsx の rehype-highlight 使用がスコープ外の根拠不十分

**カテゴリ**: 影響範囲の正確性

**問題**:
Issue 本文の「スコープ外（今後の検討）」に `MessageList.tsx` (L18) を含めている。根拠として「現在は/worktrees/[id]に直接含まれていない」と記載されているが、実際の調査結果では MessageList は `src/components/worktree/index.ts` の barrel export に含まれているのみで、どのページコンポーネントからも直接importされていない（HistoryPane も未使用）。

**証拠**:
- `src/components/worktree/index.ts` L12: `export { MessageList } from './MessageList';`
- `src/components/worktree/HistoryPane.tsx`: MessageList への参照なし
- `src/components/worktree/WorktreeDetailRefactored.tsx`: MessageList への参照なし
- `src/app/page.tsx` L5: `import { WorktreeList } from '@/components/worktree';` (WorktreeList のみ使用)

**推奨対応**:
スコープ外の根拠を補強する。barrel export 経由のみの参照であること、ツリーシェイキングにより実際にはバンドルに含まれない見込みであることを明記し、`npm run build` 時に確認する旨を追加。

---

### IAF-005: MarkdownEditor の dynamic import 化で EditorProps 型の参照に関する不安の解消

**カテゴリ**: TypeScript型安全性

**問題**:
`WorktreeDetailRefactored.tsx` は現在 `MarkdownEditor` の型情報を静的 import から推論している。dynamic import に変更した場合、`next/dynamic` が返すコンポーネントの props 型が維持されるか実装者が不安になる可能性がある。

**証拠**:
- `src/types/markdown-editor.ts` L75-91: `EditorProps` interface (worktreeId, filePath, onClose, onSave, initialViewMode, onMaximizedChange)
- `src/components/worktree/WorktreeDetailRefactored.tsx` L2070-2076, L2309-2314: `<MarkdownEditor worktreeId={worktreeId} filePath={editorFilePath} onClose={handleEditorClose} onSave={handleEditorSave} onMaximizedChange={setIsEditorMaximized} />`
- `next/dynamic` は `.then()` パターンで返されたコンポーネントの props 型を維持する

**推奨対応**:
影響範囲テーブルまたは解決策に注記を追加:
> next/dynamic は .then() パターンで返されたコンポーネントの props 型を維持するため、WorktreeDetailRefactored.tsx での MarkdownEditor 使用箇所の props 型チェックは引き続き動作する。EditorProps 型の別途 import は不要。

---

### IAF-006: terminal/page.tsx の dynamic import 化の App Router 互換性詳細不足

**カテゴリ**: 技術的正確性

**問題**:
`terminal/page.tsx` は既に `'use client'` を宣言しているが、Issue の背景セクション F1 では「SSR時にエラーが発生する可能性がある」としか記載がない。`'use client'` があっても Next.js App Router はプリレンダリング時にサーバー側でも Client Component を実行するため、xterm.js のようなブラウザ専用 API 依存モジュールは SSR エラーが発生しうるという技術的な説明が不足している。

**証拠**:
- `src/app/worktrees/[id]/terminal/page.tsx` L6: `'use client';`
- `src/app/worktrees/[id]/terminal/page.tsx` L9: `import { TerminalComponent } from '@/components/Terminal';`
- Next.js ドキュメント: Client Components are pre-rendered on the server

**推奨対応**:
背景セクション F1 に補足を追加:
> 注: `'use client'` が宣言されていても、Next.js App Router はプリレンダリング時にサーバー側でも Client Component を実行するため、xterm.js のようなブラウザ専用 API に依存するモジュールはトップレベル import で SSR エラーが発生しうる。

---

### IAF-009: 影響範囲テーブルにテストファイルが含まれていない

**カテゴリ**: テスト範囲の完全性

**問題**:
影響範囲テーブルには4つのソースファイルのみ記載されているが、テストファイルへの影響が未記載。影響がないことの明示的な記載も有用。

**推奨対応**:
影響範囲テーブルに以下を追加:

| ファイル | 変更内容 | 影響ページ |
|---------|---------|-----------|
| `tests/unit/components/MarkdownEditor.test.tsx` | 変更不要（直接 import のため） | - |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | 変更不要（MarkdownEditor 未参照） | - |

---

## Nice to Have（あれば良い）

### IAF-004: Terminal.tsx も named export であることの明記

IAF-003 と同じ問題が `TerminalComponent` にも当てはまる。`src/components/Terminal.tsx` L20: `export function TerminalComponent({`。IAF-003 の修正時に併せて TerminalComponent についても言及すると実装ミスを防げる。

---

### IAF-007: ローディングインジケーターの既存パターンとの整合性確認

実装タスクに「ローディングインジケーター追加」とあるが、具体的なUIの指定がない。既存パターンとして:
- `MermaidCodeBlock.tsx` L27-32: `Loader2` スピナー + テキスト
- `MarkdownEditor.tsx` L627-638: `animate-spin` + `'Loading...'`

MarkdownEditor の dynamic import ローディングは、MarkdownEditor 自身のファイル読み込みローディングと区別できるメッセージにすべき（例: 'Loading editor...'）。

---

### IAF-008: highlight.js CSS のグローバル影響に関する注記

`MarkdownEditor.tsx` L35 の `import 'highlight.js/styles/github-dark.css'` は dynamic import 化により、コンポーネントチャンクロード時に適用されるようになる。`src/app/globals.css` L32 に highlight.js との競合修正スタイルがあるため、CSS 適用タイミングの変化が影響しないか確認が必要。実際には MarkdownEditor はモーダル内で表示されるためロード完了後にレンダリングされ、問題は発生しにくい。

---

## コンポーネントツリー波及影響の分析

`WorktreeDetailRefactored.tsx` で MarkdownEditor を dynamic import 化した場合の波及影響を分析:

### 影響なし
- **Toast / ToastContainer**: MarkdownEditor 内部で使用されるが、MarkdownEditor 全体が動的チャンクに分離されるため、Toast も同チャンクに含まれる。WorktreeDetailRefactored 自身も ToastContainer を独自に使用しており、こちらは影響を受けない。
- **PaneResizer**: MarkdownEditor 内部でのみ使用。動的チャンクに自動的に含まれる。
- **MermaidCodeBlock**: MarkdownEditor 内で使用され、さらに内部で MermaidDiagram を dynamic import している。二重の dynamic import になるが、Next.js はこれを正しく処理する。
- **ReactMarkdown / rehype-highlight / remarkGfm / rehype-sanitize**: MarkdownEditor のチャンクに含まれる。メインバンドルからの分離が本 Issue の目的そのもの。
- **useAutoSave / useFullscreen / useSwipeGesture / useVirtualKeyboard 等のフック**: MarkdownEditor 内部でのみ使用されるため、動的チャンクに含まれる。

### 注意点
- **Modal コンポーネント**: `WorktreeDetailRefactored.tsx` で MarkdownEditor を Modal 内に表示している (L2062-2078, L2301-2318)。Modal は static import のまま維持され、MarkdownEditor のみが dynamic になる。Modal のレンダリング → MarkdownEditor のロード → MarkdownEditor の表示という順序になるため、Modal 内にローディングインジケーターが表示される期間が発生する。UX として問題ないが、ローディングUI の高さを `h-[80vh]` に合わせると見栄えがよい。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/MarkdownEditor.tsx` | rehype-highlight/highlight.js CSS import (L34-35), named export (L110) |
| `src/components/Terminal.tsx` | xterm.js top-level imports (L9-12), named export (L20) |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | MarkdownEditor static import (L39), usage sites (L2070-2076, L2309-2314) |
| `src/app/worktrees/[id]/terminal/page.tsx` | 'use client' (L6), TerminalComponent static import (L9) |
| `src/components/worktree/MermaidCodeBlock.tsx` | 既存 next/dynamic パターン (L13, L20-34) |
| `src/app/login/page.tsx` | 既存 next/dynamic パターン (L18, L23-26) |
| `src/types/markdown-editor.ts` | EditorProps interface (L75-91) |
| `src/app/globals.css` | highlight.js 競合修正 (L32) |
| `src/components/worktree/MessageList.tsx` | rehype-highlight import (L18) - スコープ外 |
| `tests/unit/components/MarkdownEditor.test.tsx` | 直接 import (L16) - 影響なし |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | MarkdownEditor 未参照 - 影響なし |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | MarkdownEditor, Terminal, WorktreeDetailRefactored のモジュール記載 |

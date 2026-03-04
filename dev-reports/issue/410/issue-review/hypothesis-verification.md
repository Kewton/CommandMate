# Issue #410 仮説検証レポート

## 検証日時
- 2026-03-03

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | Terminal.tsx (L9-12) でxterm/xterm-addon-fit/xterm-addon-web-linksをトップレベルimport | Confirmed | コード確認済み |
| 2 | ターミナル未表示時でもロードされ、/worktrees/[id] の初期ロードが291KBに達している | Partially Confirmed | Terminal.tsxは/worktrees/[id]ではなく/worktrees/[id]/terminalページにのみimportされており、主ページへの直接影響はない。ただし/worktrees/[id]/terminalページではSSRビルド時も問題あり |
| 3 | MarkdownEditor.tsx (L34-35) でrehypeHighlight/highlight.js CSSを無条件import | Confirmed | コード確認済み（L34-35に正確） |
| 4 | markdown編集画面を開いていなくてもCSSとJSがロードされる | Confirmed | WorktreeDetailRefactored.tsx L39でMarkdownEditorを静的import。MarkdownEditorは条件付きレンダリングだが、モジュールの初期化時にrehype-highlight/highlight.js CSSが読み込まれる |

## 詳細検証

### 仮説 1: Terminal.tsx (L9-12) でxterm関連をトップレベルimport

**Issue内の記述**: `src/components/Terminal.tsx` (L9-12) でxterm/xterm-addon-fit/xterm-addon-web-linksをトップレベルimport

**検証手順**:
1. `src/components/Terminal.tsx` を確認

**判定**: Confirmed

**根拠**:
```typescript
// Terminal.tsx L9-12
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
```

**Issueへの影響**: 記載は正確

---

### 仮説 2: /worktrees/[id] の初期ロードへの影響

**Issue内の記述**: 「ターミナル未表示時でもロードされ、/worktrees/[id] の初期ロードが291KBに達している」

**検証手順**:
1. `src/app/worktrees/[id]/page.tsx` を確認
2. `src/app/worktrees/[id]/terminal/page.tsx` を確認
3. `src/components/worktree/WorktreeDetailRefactored.tsx` のimportを確認

**判定**: Partially Confirmed

**根拠**:
- `Terminal.tsx` は `src/app/worktrees/[id]/terminal/page.tsx` にのみimportされている
- メインの `src/app/worktrees/[id]/page.tsx` はWorktreeDetailRefactored.tsxをimportするが、WorktreeDetailRefactored.tsxはTerminal.tsxをimportしていない
- Next.jsのルートベースコード分割により、xterm.jsは `/worktrees/[id]/terminal` ページのバンドルに含まれる（メインページではない）

**修正すべき点**: Issueの記載を「/worktrees/[id]/terminal の初期ロード」と修正が必要

---

### 仮説 3: MarkdownEditor.tsx (L34-35) で無条件import

**Issue内の記述**: `src/components/worktree/MarkdownEditor.tsx` (L34-35) で無条件import

**検証手順**:
1. `src/components/worktree/MarkdownEditor.tsx` L34-35 を確認

**判定**: Confirmed

**根拠**:
```typescript
// MarkdownEditor.tsx L34-35
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
```
行番号も正確に一致

---

### 仮説 4: markdown編集画面を開いていなくてもCSSとJSがロードされる

**Issue内の記述**: 「markdown編集画面を開いていなくてもCSSとJSがロードされる」

**検証手順**:
1. `src/components/worktree/WorktreeDetailRefactored.tsx` のimportを確認
2. MarkdownEditorのレンダリング条件を確認

**判定**: Confirmed

**根拠**:
- WorktreeDetailRefactored.tsx L39: `import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';`
- MarkdownEditorは条件付きレンダリングだが（ファイルクリック時のみ表示）、静的importのため `MarkdownEditor.tsx` のモジュールコードは `WorktreeDetailRefactored.tsx` のロード時に実行される
- これにより `rehype-highlight` と `highlight.js/styles/github-dark.css` が `/worktrees/[id]` ページの初期バンドルに含まれる

---

## Stage 1レビューへの申し送り事項

1. **Partially Confirmedな仮説**: Issue記載の「/worktrees/[id] の初期ロードが291KBに達している」という主張について、Terminal.tsxはメインページとは別ルートのページ（/worktrees/[id]/terminal）にのみ存在するため、正確には「/worktrees/[id]/terminal ページ」への影響として記載を修正すべき

2. **実装タスクへの影響**:
   - Terminal.tsxのdynamic import化は `/worktrees/[id]/terminal` ページのSSR問題解決として有効（ブラウザ専用APIを使用）
   - MarkdownEditorのrehype-highlight遅延ロードは `/worktrees/[id]` メインページのバンドルサイズ削減として有効

3. **受入条件の確認**: 「/worktrees/[id] の初期ロードJSが200KB以下に削減されること」という条件は、MarkdownEditorのdynamic import化のみで達成可能か、Terminal.tsxの動的インポートは別ページの問題であることを明確化する必要がある

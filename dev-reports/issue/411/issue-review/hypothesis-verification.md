# Issue #411 仮説検証レポート

## 検証日時
- 2026-03-03

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | MessageInput (L32) で `memo()` なし | Confirmed | L32は `export function MessageInput(...)` で memo なし |
| 2 | MessageInputに9個のハンドラがuseCallbackなし | Partially Confirmed | 9個確認済み（submitMessage/handleSubmit/handleCompositionStart/handleCompositionEnd/handleCommandSelect/handleCommandCancel/handleFreeInput/handleMessageChange/handleKeyDown）。すべてuseCallbackなし |
| 3 | MarkdownEditor (L110) で `memo()` なし | Confirmed | L110は `export function MarkdownEditor({...})` で memo なし |
| 4 | FileViewer (L49) で `memo()` なし | Confirmed | L49は `export function FileViewer(...)` で memo なし |
| 5 | WorktreeDetailRefactored L1935-2013でleftPane/rightPaneがインラインJSX | Confirmed | L1935から `leftPane={<div>...</div>}`、L2000から `rightPane={<TerminalDisplay ... />}` がインライン定義されている |
| 6 | FileViewerがWorktreeDetailRefactoredから2箇所(L2054, L2293)で描画 | Confirmed | L2054とL2293の両方でFileViewerが描画されている |

## 詳細検証

### 仮説 1: MessageInput (L32) で memo() なし

**Issue内の記述**: `src/components/worktree/MessageInput.tsx` (L32) で`memo()`なし

**検証手順**:
1. `src/components/worktree/MessageInput.tsx` を確認
2. L32: `export function MessageInput({ worktreeId, onMessageSent, cliToolId, isSessionRunning = false }: MessageInputProps)`

**判定**: Confirmed

**根拠**: L32にはReact.memoラップなし。`import React, { useState, FormEvent, useRef, useEffect }` にmemoインポートもなし

**Issueへの影響**: なし（正確な情報）

---

### 仮説 2: 9個のイベントハンドラがuseCallbackなし

**Issue内の記述**: 9個のイベントハンドラ（submitMessage、handleSubmit、handleKeyDown等）がuseCallbackなしで定義

**検証手順**:
1. MessageInput.tsx の全ハンドラ定義を確認
2. 以下の9個を確認:
   - `submitMessage` (L67): 非同期関数、useCallbackなし
   - `handleSubmit` (L87): useCallbackなし
   - `handleCompositionStart` (L95): useCallbackなし
   - `handleCompositionEnd` (L108): useCallbackなし
   - `handleCommandSelect` (L125): useCallbackなし
   - `handleCommandCancel` (L134): useCallbackなし
   - `handleFreeInput` (L144): useCallbackなし
   - `handleMessageChange` (L157): useCallbackなし
   - `handleKeyDown` (L191): useCallbackなし

**判定**: Partially Confirmed

**根拠**: 9個のハンドラはすべて存在しuseCallbackなし。ただし`submitMessage`は直接的なイベントハンドラではなく内部関数（他のハンドラから呼ばれる）。その点はIssueの記述と若干異なるが、最適化が必要な点は正確。

**Issueへの影響**: 軽微。`submitMessage`も含めて最適化対象に含めるべき。

---

### 仮説 3: MarkdownEditor (L110) で memo() なし

**Issue内の記述**: `src/components/worktree/MarkdownEditor.tsx` (L110) で`memo()`なし

**検証手順**:
1. `src/components/worktree/MarkdownEditor.tsx` のL110を確認
2. L110: `export function MarkdownEditor({`

**判定**: Confirmed

**根拠**: L110でmemo()ラップなしの関数定義。MarkdownEditorは約989行の大規模コンポーネント。

**Issueへの影響**: なし

---

### 仮説 4: FileViewer (L49) で memo() なし

**Issue内の記述**: `src/components/worktree/FileViewer.tsx` (L49) で`memo()`なし

**検証手順**:
1. `src/components/worktree/FileViewer.tsx` のL49を確認
2. L49: `export function FileViewer({ isOpen, onClose, worktreeId, filePath }: FileViewerProps)`

**判定**: Confirmed

**根拠**: L49でmemo()ラップなし。`isOpen=false`時でも親更新時に再レンダーが発生する。

**Issueへの影響**: なし

---

### 仮説 5: WorktreeDetailRefactoredのleftPane/rightPaneがインラインJSX (L1935-2013)

**Issue内の記述**: (L1935-2013) leftPane/rightPaneがJSXとしてインラインで毎レンダー生成

**検証手順**:
1. WorktreeDetailRefactored.tsx のL1935-2013を確認
2. L1935: `leftPane={<div className="h-full flex flex-col">...</div>}`（80行超のJSX）
3. L2000: `rightPane={<TerminalDisplay ... />}`

**判定**: Confirmed

**根拠**: WorktreeDesktopLayoutコンポーネントのpropsにインラインJSXとして渡されており、毎レンダーで新しいオブジェクト参照が生成される。

**Issueへの影響**: なし

---

### 仮説 6: FileViewerがWorktreeDetailRefactoredから2箇所(L2054, L2293)で描画

**Issue内の記述**: WorktreeDetailRefactoredから2箇所で描画（L2054, L2293）

**検証手順**:
1. WorktreeDetailRefactored.tsx のFileViewer使用箇所をGrep検索
2. L2054: デスクトップレイアウト内のFileViewer
3. L2293: モバイルレイアウト内のFileViewer

**判定**: Confirmed

**根拠**: L2054とL2293の両方でFileViewerが描画されることを確認。

**Issueへの影響**: なし

---

## Stage 1レビューへの申し送り事項

- 全仮説が基本的に正確であるため、追加修正は不要
- `submitMessage`が直接イベントハンドラではなく内部関数である点を認識した上でuseCallback適用範囲を検討すること
- MarkdownEditorは既に`useCallback`や`useMemo`を多用しているため（loadContent, updatePreviewなど）、コンポーネント全体のmemo化による効果を明確に議論すること
- FileViewerの`memo`適用時、`onClose`コールバック（handleFileViewerClose）が既に`useCallback`でラップされているか確認すること

# Issue #469 作業計画書

## Issue: feat: Filesタブ・ファイル内容の自動更新（外部変更検知）
**Issue番号**: #469
**サイズ**: L
**優先度**: Medium
**ブランチ**: `feature/469-worktree`
**設計方針書**: `dev-reports/design/issue-469-file-auto-update-design-policy.md`

---

## タスク分解

### Phase 1: 基盤（型定義・定数・共通フック）

#### Task 1.1: ポーリング定数定義
- **成果物**: `src/config/file-polling-config.ts`（新規）
- **テスト**: `tests/unit/config/file-polling-config.test.ts`（新規）
- **内容**:
  - FILE_TREE_POLL_INTERVAL_MS = 5000
  - FILE_CONTENT_POLL_INTERVAL_MS = 5000
- **依存**: なし

#### Task 1.2: useFilePolling カスタムフック
- **成果物**: `src/hooks/useFilePolling.ts`（新規）
- **テスト**: `tests/unit/hooks/useFilePolling.test.ts`（新規）
- **内容**:
  - UseFilePollingOptions型定義（intervalMs, enabled, onPoll）
  - setInterval管理（enabled切替で開始/停止）
  - document.visibilitychange監視（hidden→停止、visible→即時onPoll+再開）
  - unmount時のcleanup
  - コールバックはuseRefで最新参照
  - 既存visibilitychangeハンドラとの独立動作（設計書セクション4-1）
- **依存**: Task 1.1

#### Task 1.3: useFileTabs isDirty拡張
- **成果物**: `src/hooks/useFileTabs.ts`（変更）
- **テスト**: `tests/unit/hooks/useFileTabs.test.ts`（既存拡張）
- **内容**:
  - FileTab型にisDirty: boolean追加
  - FileTabsActionにSET_DIRTYアクション追加
  - reducer: OPEN_FILE/RESTORE/SET_CONTENTでisDirty: false設定
  - reducer: SET_DIRTYケース追加
  - readPersistedTabs: isDirtyは常にfalseでリストア
- **依存**: なし

#### Task 1.4: EditorProps型拡張 + MarkdownEditor onDirtyChange
- **成果物**: `src/types/markdown-editor.ts`（変更）、`src/components/worktree/MarkdownEditor.tsx`（変更）
- **テスト**: `tests/unit/components/MarkdownEditor.test.tsx`（既存拡張）
- **内容**:
  - EditorProps型にonDirtyChange?: (isDirty: boolean) => void追加
  - MarkdownEditor内: useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange])
  - テスト: 編集時true、保存後false、未指定時エラーなし
- **依存**: なし

### Phase 2: サーバー側（304応答対応）

#### Task 2.1: files API Last-Modified / 304応答
- **成果物**: `src/app/api/worktrees/[id]/files/[...path]/route.ts`（変更）
- **テスト**: `tests/integration/api/files-304.test.ts`（新規）
- **内容**:
  - GETハンドラでfs.stat取得、Last-Modifiedヘッダ追加
  - If-Modified-Sinceヘッダ処理: isNaNチェック → 304応答またはフォールバック
  - Cache-Control: no-store, private ヘッダ追加（304/200両方）
  - テスト: 正常304、初回200、不正日時文字列→200フォールバック
- **依存**: なし

### Phase 3: クライアント側ポーリング

#### Task 3.1: useFileContentPolling フック
- **成果物**: `src/hooks/useFileContentPolling.ts`（新規）
- **テスト**: `tests/unit/hooks/useFileContentPolling.test.ts`（新規）
- **内容**:
  - UseFileContentPollingOptions型定義（tab, worktreeId, onLoadContent）
  - lastModifiedRef管理（初期値null → 初回はIf-Modified-Since未付与）
  - useFilePolling呼び出し（enabled = !isDirty && content !== null && !loading）
  - 304応答: return（変更なし）
  - 200応答: lastModifiedRef更新 + onLoadContent呼び出し
- **依存**: Task 1.1, Task 1.2, Task 1.3

#### Task 3.2: FilePanelContent ポーリング統合
- **成果物**: `src/components/worktree/FilePanelContent.tsx`（変更）
- **内容**:
  - useFileContentPolling呼び出し（1行追加）
  - MarkdownWithSearch: onDirtyChange props追加 → dispatch SET_DIRTY
  - MarpEditorWithSlides: onDirtyChange props追加 → dispatch SET_DIRTY
  - 既存auto-fetchに防衛的304チェック追加
- **依存**: Task 1.3, Task 1.4, Task 3.1

#### Task 3.3: WorktreeDetailRefactored ツリーポーリング
- **成果物**: `src/components/worktree/WorktreeDetailRefactored.tsx`（変更）
- **内容**:
  - useFilePolling呼び出し（enabled = Filesタブアクティブ）
  - onPoll: fetch(`/api/worktrees/${worktreeId}/tree`) → JSON.stringify比較 → setFileTreeRefresh
  - prevTreeHashRef管理
- **依存**: Task 1.1, Task 1.2

#### Task 3.4: FilePanelTabs isDirtyインジケーター
- **成果物**: `src/components/worktree/FilePanelTabs.tsx`（変更）
- **内容**:
  - isDirty=trueのタブに未保存インジケーター表示（ドット等）
- **依存**: Task 1.3

### Phase 4: テスト拡充・最終確認

#### Task 4.1: 結合テスト・追加ユニットテスト
- **内容**:
  - files-304.test.ts: 不正日時文字列テストケース追加
  - useFileContentPolling.test.ts: isDirty=false時のSET_CONTENT動作検証
  - 全テスト実行・確認
- **依存**: Phase 1-3全て

#### Task 4.2: 品質チェック・最終検証
- **内容**:
  - npx tsc --noEmit
  - npm run lint
  - npm run test:unit
  - npm run build
- **依存**: Task 4.1

---

## タスク依存関係

```
Phase 1（基盤）:
  Task 1.1 (定数) ──┐
  Task 1.3 (isDirty)─┤
  Task 1.4 (onDirty)─┤
                      │
  Task 1.1 → Task 1.2 (useFilePolling)
                      │
Phase 2（サーバー）:   │
  Task 2.1 (304応答) ─┤  ※Phase 1と並行可能
                      │
Phase 3（クライアント）:
  Task 1.2 + 1.1 → Task 3.1 (useFileContentPolling)
  Task 1.2 + 1.1 → Task 3.3 (ツリーポーリング)
  Task 1.3 + 1.4 + 3.1 → Task 3.2 (FilePanelContent)
  Task 1.3 → Task 3.4 (FilePanelTabs)

Phase 4（テスト・検証）:
  Phase 1-3 全て → Task 4.1 → Task 4.2
```

---

## 実装順序（推奨）

| 順序 | タスク | 理由 |
|:----:|--------|------|
| 1 | Task 1.1 | 依存なし、最小単位 |
| 2 | Task 1.3 | 依存なし、型変更は早期に |
| 3 | Task 1.4 | 依存なし、型変更は早期に |
| 4 | Task 1.2 | Task 1.1依存 |
| 5 | Task 2.1 | 依存なし（Phase 1と並行可能だが順次がTDD向き） |
| 6 | Task 3.1 | Task 1.1, 1.2, 1.3依存 |
| 7 | Task 3.3 | Task 1.1, 1.2依存 |
| 8 | Task 3.2 | Task 1.3, 1.4, 3.1依存 |
| 9 | Task 3.4 | Task 1.3依存 |
| 10 | Task 4.1 | 全タスク完了後 |
| 11 | Task 4.2 | 最終検証 |

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| ESLint | `npm run lint` | エラー0件 |
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |

---

## 成果物チェックリスト

### 新規ファイル
- [ ] src/config/file-polling-config.ts
- [ ] src/hooks/useFilePolling.ts
- [ ] src/hooks/useFileContentPolling.ts
- [ ] tests/unit/config/file-polling-config.test.ts
- [ ] tests/unit/hooks/useFilePolling.test.ts
- [ ] tests/unit/hooks/useFileContentPolling.test.ts
- [ ] tests/integration/api/files-304.test.ts

### 変更ファイル
- [ ] src/hooks/useFileTabs.ts（isDirty, SET_DIRTY）
- [ ] src/types/markdown-editor.ts（onDirtyChange）
- [ ] src/components/worktree/MarkdownEditor.tsx（onDirtyChange useEffect）
- [ ] src/components/worktree/FilePanelContent.tsx（useFileContentPolling, onDirtyChange中継）
- [ ] src/components/worktree/FilePanelTabs.tsx（isDirtyインジケーター）
- [ ] src/components/worktree/WorktreeDetailRefactored.tsx（ツリーポーリング）
- [ ] src/app/api/worktrees/[id]/files/[...path]/route.ts（Last-Modified, 304応答）

### テスト
- [ ] useFilePolling ユニットテスト
- [ ] useFileContentPolling ユニットテスト
- [ ] useFileTabs SET_DIRTY ユニットテスト
- [ ] MarkdownEditor onDirtyChange ユニットテスト
- [ ] files API 304 結合テスト
- [ ] ポーリング定数 ユニットテスト

---

## Definition of Done

- [ ] すべてのタスク（Task 1.1〜4.2）が完了
- [ ] CIチェック全パス（lint, type-check, test, build）
- [ ] 設計方針書のチェックリスト全項目完了
- [ ] ドキュメント更新完了

---

## 次のアクション

1. **TDD実装開始**: `/pm-auto-dev 469`
2. **PR作成**: `/create-pr`

---

*Generated by /work-plan command for Issue #469*
*Date: 2026-03-11*

# 作業計画: Issue #549

## Issue: スマホ版にてmarkdownファイル表示時、初期表示をビューワにしてほしい
**Issue番号**: #549
**サイズ**: S（小規模、2ファイル変更 + テスト追加）
**優先度**: Medium
**依存Issue**: なし
**ブランチ**: `feature/549-mobile-markdown-viewer`

---

## 詳細タスク分解

### Phase 1: 実装タスク

#### Task 1.1: MarkdownEditor.tsx - mobileTab初期値のuseEffect追加
- **成果物**: `src/components/worktree/MarkdownEditor.tsx`
- **依存**: なし
- **変更内容**:
  - `mobileTab` state宣言（line 134付近）の直後にuseEffectを追加
  - `isMobile`がtrueになった時に`setMobileTab('preview')`を実行
  - 依存配列は`[isMobile]`のみ（filePath含めない）
- **実装パターン**:
  ```typescript
  const [mobileTab, setMobileTab] = useState<MobileTab>('editor');

  // Issue #549: モバイル時にpreviewタブをデフォルトに
  useEffect(() => {
    if (isMobile) {
      setMobileTab('preview');
    }
  }, [isMobile]);
  ```
- **注意事項**:
  - elseブランチ不要（showMobileTabsがfalseになりMobileTabBar非表示）
  - SSRハイドレーション安全（useIsMobileの初期値falseを前提）

#### Task 1.2: WorktreeDetailRefactored.tsx - モバイルModal initialViewMode追加
- **成果物**: `src/components/worktree/WorktreeDetailRefactored.tsx`
- **依存**: なし（Task 1.1と並行可能）
- **変更内容**:
  - モバイルレイアウトのMarkdownEditor呼び出し（line 1869付近）に`initialViewMode="split"`を追加
- **実装パターン**:
  ```tsx
  <MarkdownEditor
    worktreeId={worktreeId}
    filePath={editorFilePath}
    onClose={handleEditorClose}
    onSave={handleEditorSave}
    onMaximizedChange={setIsEditorMaximized}
    initialViewMode="split"
  />
  ```
- **理由**: localStorageに'editor'が保存されている場合にshowMobileTabsがfalseになる問題を防止

### Phase 2: テストタスク

#### Task 2.1: MarkdownEditor mobileTab ユニットテスト追加
- **成果物**: `tests/unit/components/MarkdownEditor.test.tsx`（既存ファイルに追加）
- **依存**: Task 1.1
- **テストケース**:
  1. モバイル環境（useIsMobile=true）でpreviewタブがデフォルト選択されること
  2. PC環境（useIsMobile=false）でeditorが初期表示のまま変更なしであること
  3. モバイルでlocalStorageにviewMode='editor'があってもpreviewが初期表示されること
  4. filePath変更時にmobileTabがリセットされないこと（意図的な挙動）
  5. WorktreeDetailRefactored.tsxモバイルModal経由でinitialViewMode='split'が渡されること
- **モック戦略**:
  ```typescript
  vi.mock('@/hooks/useIsMobile', () => ({
    useIsMobile: vi.fn(() => true),
    MOBILE_BREAKPOINT: 768,
  }));
  ```
  - scoped `vi.mock` を `describe` ブロック内で使用（既存テストとの分離）

### Phase 3: 品質確認

#### Task 3.1: 静的解析・ビルド確認
- **依存**: Task 1.1, 1.2, 2.1
- **チェック項目**:
  ```bash
  npx tsc --noEmit
  npm run lint
  npm run test:unit
  ```

---

## タスク依存関係

```
Task 1.1 (MarkdownEditor.tsx)  ──┐
                                  ├──> Task 2.1 (テスト) ──> Task 3.1 (品質確認)
Task 1.2 (WorktreeDetailRefactored.tsx) ──┘
```

Task 1.1 と 1.2 は独立しており並行実施可能。

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| ESLint | `npm run lint` | エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |

---

## 成果物チェックリスト

### コード
- [ ] `src/components/worktree/MarkdownEditor.tsx` - mobileTab useEffect追加
- [ ] `src/components/worktree/WorktreeDetailRefactored.tsx` - initialViewMode="split"追加

### テスト
- [ ] `tests/unit/components/MarkdownEditor.test.tsx` - mobileTab関連テスト5ケース追加

---

## Definition of Done

- [ ] すべてのタスクが完了
- [ ] 新規テスト5ケース全パス
- [ ] 既存テスト全パス（回帰テスト）
- [ ] CIチェック全パス（lint, type-check, test, build）
- [ ] モバイルでpreviewが初期表示されること（UAT）
- [ ] PCでの動作に影響がないこと（UAT）

---

## 次のアクション

1. TDD実装開始（`/pm-auto-dev 549`）
2. 進捗報告（`/progress-report`）
3. PR作成（`/create-pr`）

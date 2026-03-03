# Issue #389 Stage 3: 影響分析レビュー

## レビュー概要

| 項目 | 値 |
|-----|-----|
| Issue番号 | #389 |
| レビューステージ | Stage 3: 影響分析レビュー |
| フォーカス | 影響範囲 |
| レビュー日 | 2026-03-02 |
| 設計書 | dev-reports/design/issue-389-auto-save-design-policy.md |

## Executive Summary

Issue #389 (MarkdownEditor Auto-Save) の設計変更がコードベース全体に与える影響を分析した。結果として、影響範囲は限定的かつ制御可能である。

**直接変更ファイル**: 3 ファイル (MarkdownEditor.tsx, markdown-editor.ts, MarkdownEditor.test.tsx)
**間接影響ファイル**: 0 ファイル (EditorProps 変更なし、WorktreeDetailRefactored.tsx への変更不要)
**主な影響**: 既存テストの前提条件明示と新規テストの追加

Must Fix: 3 件 / Should Fix: 4 件 / Nice to Have: 3 件

---

## 影響範囲マトリクス

| カテゴリ | ファイル | 変更内容 | リスク |
|---------|---------|---------|-------|
| 直接変更 | `src/components/worktree/MarkdownEditor.tsx` | auto-save 統合 (6 箇所) | 中: 既存テストへの影響 |
| 直接変更 | `src/types/markdown-editor.ts` | 2 定数追加 | 低: 追加のみ |
| 直接変更 | `tests/unit/components/MarkdownEditor.test.tsx` | テスト更新 + 新規追加 | 中: カバレッジ確保 |
| 影響なし | `src/hooks/useAutoSave.ts` | 変更不要 | なし |
| 影響なし | `src/hooks/useLocalStorageState.ts` | 変更不要 | なし |
| 影響なし | `src/components/worktree/MemoCard.tsx` | 競合なし | なし |
| 影響なし | `src/components/worktree/WorktreeDetailRefactored.tsx` | EditorProps 変更なし | なし |
| 影響なし | `src/components/ui/Modal.tsx` | 変更不要 | なし |
| 要注意 | `tests/e2e/markdown-editor.spec.ts` | localStorage 残留時の影響 | 低 |

---

## 詳細分析

### 1. 既存テストへの影響

#### 1.1 Unsaved Changes Warning テスト (Line 350-413) -- **Must Fix [DR3-001]**

既存テスト 3 件:
- `should show dirty indicator when content changes` (Line 351-363)
- `should register beforeunload handler when dirty` (Line 366-382)
- `should remove beforeunload handler after save` (Line 384-413)

**影響**: beforeunload ハンドラーの useEffect 依存配列が `[isDirty]` から `[isDirty, isAutoSaving, isAutoSaveEnabled]` に変更される。auto-save OFF がデフォルトのため既存テストは直接壊れないが、テストの前提条件を明示する必要がある。

**必要なアクション**:
- 既存テストに auto-save OFF 前提のコメント追加
- auto-save ON 時の beforeunload 条件分岐テスト 3 件追加

#### 1.2 Save Operations テスト (Line 185-348) -- **Must Fix [DR3-002]**

既存テスト 6 件:
- `should have save button disabled when no changes` (Line 186-195)
- `should enable save button when content changes` (Line 197-209)
- `should call API and show success toast on save` (Line 211-250)
- `should handle Ctrl+S keyboard shortcut` (Line 252-283)
- `should handle Cmd+S keyboard shortcut on Mac` (Line 285-316)
- `should show error toast on save failure` (Line 318-347)

**影響**: auto-save ON 時に save-button が DOM から消える (Section 5.3)。既存テストは auto-save OFF (デフォルト) のため壊れないが、auto-save ON 時の Ctrl+S 動作 (saveNow + onSave) は新規テストでカバーが必要。

**必要なアクション**:
- auto-save ON 時の save-button 非表示テスト追加
- auto-save ON 時の Ctrl+S テスト追加

#### 1.3 onClose callback テスト (Line 732-789) -- **Must Fix [DR3-003]**

既存テスト 3 件:
- `should call onClose when close button is clicked` (Line 733-745)
- `should warn before closing with unsaved changes` (Line 747-767)
- `should close when user confirms unsaved changes` (Line 769-789)

**影響**: handleClose が同期関数から async 関数に変更される。テスト (1) は isDirty=false のケースで同期的に onClose() を呼ぶため壊れない可能性が高いが、安全のため waitFor でラッピングを推奨。

**必要なアクション**:
- auto-save ON + isDirty=true 時の handleClose テスト追加
- fireEvent.click 後の waitFor ラッピング検討

### 2. MarkdownEditor 呼び出し元への影響

#### 2.1 WorktreeDetailRefactored.tsx

```typescript
// Line 2070-2076 (Desktop)
<MarkdownEditor
  worktreeId={worktreeId}
  filePath={editorFilePath}
  onClose={handleEditorClose}
  onSave={handleEditorSave}
  onMaximizedChange={setIsEditorMaximized}
/>

// Line 2309-2315 (Mobile) - 同一パターン
```

**EditorProps interface (src/types/markdown-editor.ts Line 75-91) は変更なし**。新しい props は追加されない (auto-save 設定は MarkdownEditor 内部の localStorage で管理)。handleEditorSave の呼出頻度は auto-save 時に onSave() を呼ばない設計 (Section 7.2) により変化しない。

**結論**: WorktreeDetailRefactored.tsx へのコード変更は不要。

#### 2.2 Modal.tsx

MarkdownEditor への言及はコメントのみ (Line 21)。変更不要。

### 3. localStorage キーの衝突リスク

プロジェクト全体の localStorage キー一覧:

| キー | ファイル | 用途 |
|-----|---------|------|
| `commandmate:md-editor-view-mode` | markdown-editor.ts | エディタ表示モード |
| `commandmate:md-editor-split-ratio` | markdown-editor.ts | 分割比率 |
| `commandmate:md-editor-maximized` | markdown-editor.ts | 最大化状態 |
| `commandmate:md-editor-auto-save` (NEW) | markdown-editor.ts | auto-save ON/OFF |
| SIDEBAR_SORT_STORAGE_KEY | SidebarContext.tsx | サイドバーソート |
| SIDEBAR_STORAGE_KEY | useSidebar.ts | サイドバー状態 |
| `locale` | useLocaleSwitch.ts | 言語設定 |

**結論**: `commandmate:md-editor-auto-save` は既存キーと衝突しない。プレフィックス `commandmate:md-editor-` パターンに完全準拠。

### 4. useAutoSave の使用パターン分析

| 観点 | MemoCard | MarkdownEditor (設計) |
|------|----------|---------------------|
| インスタンス数 | 2 (title, content) | 1 (content) |
| disabled | 未使用 (常に有効) | `!isAutoSaveEnabled` (動的切替) |
| debounceMs | デフォルト 300ms | 3000ms (明示指定) |
| saveFn | `async (value) => { await onUpdate(...) }` | `saveToApi(valueToSave)` |
| onSaveComplete | 未使用 | 未使用 (DR2-001) |

**結論**: 各 useAutoSave インスタンスは独立した state/refs を持ち、コンポーネント間の競合なし。disabled 動的切替は MarkdownEditor 固有の新規利用パターン (DR2-003)。

### 5. beforeunload イベントハンドラーの影響

**変更前** (現在):
```
isDirty === true -> beforeunload 登録
isDirty === false -> beforeunload 解除
```

**変更後** (設計書 Section 4.6):
```
auto-save OFF: isDirty === true -> 登録 (従来通り)
auto-save ON: (isDirty || isAutoSaving) === true -> 登録
```

**ユーザー体験への影響**: 全ケースで適切な警告が表示される。auto-save ON + 保存完了後にページを安全に離れられる動作も維持される。

### 6. E2E テストへの影響

`tests/e2e/markdown-editor.spec.ts` の以下のテストが潜在的に影響を受ける:

- `should enable save button when content is modified` (Line 199-238): save-button の disabled/enabled を検証。localStorage に auto-save=true が残留している場合、save-button が DOM に存在せずテスト失敗する。

**対策**: テスト前の localStorage クリア処理の追加を推奨。

### 7. パフォーマンスへの影響

| 指標 | 変更前 | 変更後 (auto-save ON) |
|------|--------|---------------------|
| PUT リクエスト頻度 | 手動保存時のみ | 最大 20 回/分 (3 秒デバウンス) |
| 最大転送量 | 手動 | 20MB/分 (1MB ファイル継続編集時) |
| ファイルツリー refresh | 保存ごと | 手動保存 (Ctrl+S) 時のみ |

3 秒デバウンスは VS Code の auto-save 間隔 (1 秒) より保守的であり、ローカル開発ツールとして許容範囲。

### 8. 型定義への影響

`src/types/markdown-editor.ts` への変更は 2 定数のエクスポート追加のみ:

```typescript
export const LOCAL_STORAGE_KEY_AUTO_SAVE = 'commandmate:md-editor-auto-save';
export const AUTO_SAVE_DEBOUNCE_MS = 3000;
```

既存の 22 エクスポート (型 + 定数 + 関数) に影響なし。他ファイルのインポートにも影響なし。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| テストリスク | 既存テストの前提条件不明確化 | Medium | Medium | P1 |
| テストリスク | handleClose async 化によるテスト不安定化 | Medium | Low | P1 |
| E2E リスク | localStorage 残留による save-button テスト失敗 | Low | Low | P2 |
| パフォーマンスリスク | API 呼出頻度増加 | Low | Low | P3 |
| 互換性リスク | EditorProps 変更 | - | - | なし (変更なし) |

---

## 指摘事項サマリー

### Must Fix (3 件)

| ID | カテゴリ | タイトル |
|----|---------|---------|
| DR3-001 | テスト影響 | Unsaved Changes Warning テスト: beforeunload 条件変更による前提条件明示と新規テスト追加 |
| DR3-002 | テスト影響 | Save Operations テスト: Save ボタン条件付き非表示の新規テスト追加 |
| DR3-003 | テスト影響 | onClose callback テスト: handleClose async 化への対応 |

### Should Fix (4 件)

| ID | カテゴリ | タイトル |
|----|---------|---------|
| DR3-004 | パフォーマンス | API 呼出頻度分析の設計書補記 |
| DR3-005 | テスト影響 | E2E テストの localStorage クリーンアップ |
| DR3-006 | API影響 | handleEditorSave 呼出頻度の確認と検証 |
| DR3-007 | ユーザー体験 | beforeunload 動作変化のテスト検証 |

### Nice to Have (3 件)

| ID | カテゴリ | タイトル |
|----|---------|---------|
| DR3-008 | 型影響 | markdown-editor.ts への定数追加: 影響なし |
| DR3-009 | テスト影響 | localStorage キー衝突: リスクなし |
| DR3-010 | API影響 | useAutoSave の MemoCard/MarkdownEditor 間独立性: 競合なし |

---

## 実装チェックリスト (Stage 3 追加分)

Stage 3 影響分析に基づく実装時の確認事項:

- [ ] **[DR3-001]** 既存 Unsaved Changes Warning テスト 3 件に auto-save OFF 前提のコメントを追加する
- [ ] **[DR3-001]** auto-save ON 時の beforeunload 条件分岐テスト 3 件を新規追加する
- [ ] **[DR3-002]** auto-save ON 時の save-button 非表示テストを追加する
- [ ] **[DR3-002]** auto-save ON 時の Ctrl+S テスト (saveNow + onSave 呼出) を追加する
- [ ] **[DR3-003]** auto-save ON + isDirty=true 時の handleClose テストを追加する
- [ ] **[DR3-003]** handleClose テストで fireEvent.click 後の waitFor ラッピングを検討する
- [ ] **[DR3-005]** E2E テストの beforeEach で localStorage.clear() を追加する
- [ ] **[DR3-006]** auto-save 中に handleEditorSave (onSave) が呼ばれないことをテストで検証する

---

*Generated by architecture-review-agent for Issue #389*
*Stage: 3 (影響分析レビュー)*
*Date: 2026-03-02*

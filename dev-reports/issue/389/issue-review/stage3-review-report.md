# Issue #389 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-02
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 6 |
| Nice to Have | 2 |

**総括**: Issue #389の変更は主に`MarkdownEditor.tsx`と`markdown-editor.ts`の2ファイルに閉じており、破壊的変更は発生しない。`EditorProps`型への変更もないため、呼び出し元（`WorktreeDetailRefactored`）への型レベルの影響はない。ただし、既存テストの更新範囲が未記載である点と、`saveContent`関数分離の波及箇所が十分に分析されていない点が要対応である。

---

## 影響範囲マップ

### 直接影響ファイル

| ファイル | 変更種別 |
|---------|---------|
| `src/components/worktree/MarkdownEditor.tsx` | 大規模変更（UI追加、ロジック分岐、フック統合） |
| `src/types/markdown-editor.ts` | 定数追加（後方互換） |
| `tests/unit/components/MarkdownEditor.test.tsx` | テスト更新+追加 |
| `tests/e2e/markdown-editor.spec.ts` | 確認必要 |

### 間接影響ファイル

| ファイル | 影響内容 |
|---------|---------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | onSaveコールバックの呼び出し頻度増加の可能性 |
| `src/components/common/Toast.tsx` | 影響なし（既存インターフェースで対応可能） |
| `src/hooks/useAutoSave.ts` | 変更不要（既存APIで要件充足） |
| `src/hooks/useLocalStorageState.ts` | 変更不要（既存APIで要件充足） |
| `tests/unit/hooks/useAutoSave.test.ts` | 変更不要（間接的な統合確認のみ） |

### 影響なし確認済みファイル

- `src/components/worktree/MemoCard.tsx` -- 参考実装として参照のみ
- `src/hooks/useFullscreen.ts`, `useIsMobile.ts`, `useSwipeGesture.ts`, `useVirtualKeyboard.ts` -- 独立フック、変更なし
- `src/components/worktree/PaneResizer.tsx`, `MermaidCodeBlock.tsx` -- 独立コンポーネント、変更なし
- `src/app/api/worktrees/[id]/files/[...path]/route.ts` -- APIルートは変更なし
- `src/hooks/useContextMenu.ts` -- `ContextMenuState`型のみ使用、影響なし

---

## Must Fix（必須対応）

### S3-001: 既存MarkdownEditorテストの大規模更新が必要

**カテゴリ**: テスト影響
**影響ファイル**: `tests/unit/components/MarkdownEditor.test.tsx`

**問題**:
`tests/unit/components/MarkdownEditor.test.tsx`には以下の既存テストセクションが存在し、auto-saveモード導入により前提条件が変わる：

- **Save Operations** (6テスト): `saveContent`のisDirtyガード除去、Saveボタンの表示/非表示切替
- **Unsaved Changes Warning** (3テスト): beforeunloadハンドラーのisSaving条件追加
- **Keyboard Shortcuts**: Ctrl+Sの挙動分岐（auto-save ON時はsaveNow）

Issueの実装タスクには「ユニットテストの追加」のみ記載されているが、既存テストの更新が必要。

**証拠**:
- `MarkdownEditor.test.tsx` L185-347: Save Operationsテスト群
- `MarkdownEditor.test.tsx` L350-413: Unsaved Changes Warningテスト群
- `MarkdownEditor.test.tsx` L252-316: Ctrl+S/Cmd+Sテスト

**推奨対応**:
実装タスクに「既存MarkdownEditorテストのauto-saveモード対応更新」を追加する。具体的には：
1. auto-save OFF時（デフォルト）は既存テストが引き続きpassすることの確認
2. auto-save ON時の新テスト追加（Saveボタン非表示、インジケーター表示、beforeunload条件分岐、Ctrl+SでのsaveNow呼び出し）

---

### S3-002: saveContent関数の分離が3箇所の呼び出し元に波及

**カテゴリ**: 影響範囲
**影響ファイル**: `src/components/worktree/MarkdownEditor.tsx`

**問題**:
現在の`MarkdownEditor.tsx`では`saveContent`関数が以下の3箇所で使用されている：

1. **Saveボタン** (L702): `onClick={saveContent}` -- auto-save ON時は非表示/disabled
2. **handleKeyDown内Ctrl+S** (L368): `saveContent()` -- auto-save ON時はsaveNow()に分岐
3. **handleClose** (L306-316): isDirtyチェック後のconfirm -- auto-save ON+isSaving時はsaveNow()で即座保存してから閉じる

Issueの実装タスクでは「useAutoSave用の保存関数をisDirtyチェックを含まない純粋なAPI呼び出しとして切り出す」とあるが、各呼び出し箇所でのauto-save ON/OFF分岐の具体的な設計が不足している。

**証拠**:
```typescript
// L245-279: 現在のsaveContent（isDirtyガード含む）
const saveContent = useCallback(async () => {
  if (!isDirty || isSaving) return;  // ← この行がauto-save時に問題
  // ...API呼び出し...
}, [worktreeId, filePath, content, isDirty, isSaving, onSave, showToast]);

// L366-370: handleKeyDown内のCtrl+S
if ((e.ctrlKey || e.metaKey) && e.key === 's') {
  e.preventDefault();
  saveContent();  // ← auto-save ON時はsaveNow()に変更必要
  return;
}
```

**推奨対応**:
影響範囲テーブルの変更内容を具体化する：
- `saveToApi()`: 純粋API呼び出し（isDirtyガードなし）
- `saveContent()`: 手動保存用（isDirtyガード付き、既存互換）
- `handleKeyDown`: auto-save ON/OFF分岐追加
- `handleClose`: auto-save ON+isSaving時のsaveNow()+待機ロジック

---

## Should Fix（推奨対応）

### S3-003: useAutoSaveのsaveNow()内部デバウンスキャンセル動作の明確化

**カテゴリ**: 影響範囲
**影響ファイル**: `src/hooks/useAutoSave.ts`

**問題**:
受入条件の「デバウンスをキャンセルしてsaveNow()で即座保存」という記述が2ステップに読めるが、`saveNow()`内部で`cancelPendingSave()`が自動的に呼ばれる（L173）ため、実際は1ステップで済む。

**証拠**:
```typescript
// useAutoSave.ts L170-175
const saveNow = useCallback(async (): Promise<void> => {
  if (disabled) return;
  cancelPendingSave();  // ← 内部でデバウンスキャンセル済み
  await executeSave(valueRef.current);
}, [disabled, cancelPendingSave, executeSave]);
```

**推奨対応**:
受入条件の文言を「saveNow()を呼び出し即座保存する」に簡略化するか、影響範囲テーブルのuseAutoSave.ts「変更不要」の根拠としてこの内部動作を補足する。

---

### S3-004: E2Eテストへの影響が未記載

**カテゴリ**: テスト影響
**影響ファイル**: `tests/e2e/markdown-editor.spec.ts`

**問題**:
E2Eテストが存在するが、Issueの影響範囲に含まれていない。auto-saveのデフォルトがOFF（手動保存モード）であるため既存テストへの破壊的影響は限定的だが、UIレイアウト変更の確認は必要。

**推奨対応**:
影響範囲テーブルに「`tests/e2e/markdown-editor.spec.ts` - auto-saveトグルUI追加に伴うE2Eテスト確認」を追加する。

---

### S3-005: auto-save ON時のAPI呼び出し頻度とサーバー負荷

**カテゴリ**: パフォーマンス
**影響ファイル**: `src/components/worktree/MarkdownEditor.tsx`, `src/app/api/worktrees/[id]/files/[...path]/route.ts`

**問題**:
MarkdownEditorは最大1MB（`FILE_SIZE_LIMITS.MAX_SIZE`）のファイルを扱う。auto-save ON時は3秒デバウンスでファイル全体がPUT送信される。MemoCardの300msデバウンスは小さなデータだが、MarkdownEditorは性質が異なる。

**推奨対応**:
3秒デバウンスが十分長く、かつ`useAutoSave`は値が変わった場合のみデバウンスを開始する（`initialValueRef`比較）ため、実用上問題ないと判断した旨を影響範囲に明記する。

---

### S3-006: WorktreeDetailRefactoredのonSaveコールバック経由のファイルツリーrefresh頻度

**カテゴリ**: 影響範囲
**影響ファイル**: `src/components/worktree/WorktreeDetailRefactored.tsx`, `src/components/worktree/MarkdownEditor.tsx`

**問題**:
`WorktreeDetailRefactored`の`handleEditorSave`（L1205-1207）は`setFileTreeRefresh(prev => prev + 1)`を呼び出す。Issueの実装タスクでは`onSaveComplete`コールバックで`onSave?.(filePath)`を呼び出すとしており、3秒ごとの自動保存のたびにファイルツリーrefreshが発生する可能性がある。

**証拠**:
```typescript
// WorktreeDetailRefactored.tsx L1205-1207
const handleEditorSave = useCallback((_savedPath: string) => {
  setFileTreeRefresh(prev => prev + 1);  // ← 毎回ファイルツリーを再取得
}, []);
```

**推奨対応**:
auto-save時のonSave呼び出し方針を明記する。推奨は「auto-save時もonSaveを呼び出すが、ファイルツリーのrefreshは内容変更がないため実質的な負荷は小さい。ただし気になる場合は、onSave呼び出しにデバウンスを追加する」旨の記載。

---

### S3-007: AUTO_SAVE_DEBOUNCE_MS定数の配置先妥当性

**カテゴリ**: 型影響
**影響ファイル**: `src/types/markdown-editor.ts`, `src/components/worktree/MarkdownEditor.tsx`

**問題**:
`AUTO_SAVE_DEBOUNCE_MS`を`markdown-editor.ts`（型定義モジュール）に配置する計画だが、この値は`useAutoSave`フックの`debounceMs`引数に渡される設定値である。既存の`PREVIEW_DEBOUNCE_MS`もmarkdown-editor.tsに配置されているため一貫性はあるが、将来的にMemoCardのデバウンス値（300ms、ハードコード）との統一を考えると配置先の検討余地がある。

**推奨対応**:
現時点では`markdown-editor.ts`への配置で問題ない（既存パターンとの一貫性）。備考として記載するのみで十分。

---

### S3-008: auto-save失敗時のフォールバック制御フロー

**カテゴリ**: 互換性
**影響ファイル**: `src/components/worktree/MarkdownEditor.tsx`, `src/hooks/useAutoSave.ts`

**問題**:
受入条件「auto-save失敗時は手動保存モードにフォールバック」の具体的な制御フローが実装タスクに未記載。`useAutoSave`は`error`状態を返すが、auto-saveをOFFに切り替えるロジックはMarkdownEditor側で実装する必要がある。

**推奨対応**:
フォールバックの実装方針を明記する：
1. `useAutoSave`の`error`を`useEffect`で監視
2. `error !== null`時にauto-save設定stateを`false`に切り替え（localStorage含む）
3. Toast通知「Auto-save failed. Switched to manual save mode.」を1回表示
4. `useAutoSave`の`disabled`が`true`になりデバウンス保存停止
5. SaveボタンとCtrl+S手動保存UIが復活

---

## Nice to Have（あれば良い）

### S3-009: i18n対応の影響範囲

**カテゴリ**: 影響範囲
**影響ファイル**: `src/components/worktree/MarkdownEditor.tsx`

**問題**:
MarkdownEditorは現在`next-intl`を使用しておらず、UIテキストはハードコードされている。新たに追加されるテキスト（Saving.../Saved/Error等）も同様にハードコードとなる見込み。

**推奨対応**:
既存パターンと同様にハードコードとし、i18n対応は将来Issueとして別途対応する旨を備考に記載する。

---

### S3-010: useAutoSaveテストへの間接的影響

**カテゴリ**: テスト影響
**影響ファイル**: `tests/unit/hooks/useAutoSave.test.ts`

**問題**:
`useAutoSave`自体は変更不要であるため、既存テスト（`debounceMs=300`と`debounceMs=500`をカバー）への影響はない。`debounceMs=3000`のテストは存在しないが、useAutoSaveの汎用性は既存テストで十分に検証されている。

**推奨対応**:
MarkdownEditor.test.tsx内でuseAutoSave統合動作を間接的にテストする方針で十分。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/MarkdownEditor.tsx` | 直接変更対象（892行） |
| `src/types/markdown-editor.ts` | 直接変更対象（定数追加） |
| `src/hooks/useAutoSave.ts` | 変更不要（既存APIで要件充足） |
| `src/hooks/useLocalStorageState.ts` | 変更不要（既存APIで要件充足） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 間接影響（onSaveコールバック頻度） |
| `src/components/worktree/MemoCard.tsx` | 参考実装（影響なし） |
| `src/components/common/Toast.tsx` | 既存インターフェースで対応可能（影響なし） |

### テスト

| ファイル | 関連性 |
|---------|--------|
| `tests/unit/components/MarkdownEditor.test.tsx` | 更新必要（12テスト以上が影響） |
| `tests/e2e/markdown-editor.spec.ts` | 確認必要（UIレイアウト変更） |
| `tests/unit/hooks/useAutoSave.test.ts` | 変更不要 |
| `tests/unit/components/worktree/MemoCard.test.tsx` | 影響なし |

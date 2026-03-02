# Issue #389 Stage 1 レビューレポート

**レビュー日**: 2026-03-02
**フォーカス**: 通常レビュー（整合性・正確性・完全性・明確性・設計）
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 7 |
| Nice to Have | 3 |

**総合評価**: Issue #389の全体的な方向性は適切であり、既存のuseAutoSaveフックとuseLocalStorageStateフックの活用方針は正しい。仮説検証によりコードベースとの整合性も確認済み。ただし、Must Fixとして2点の設計上の問題がある。(1) saveContent()のisDirtyガードとuseAutoSaveの競合問題が未検討であり、MemoCardの実装パターンに倣って純粋なAPI呼び出し関数を切り出す設計が必要。(2) beforeunload抑制の仕様が単純化されすぎており、デバウンス待機中・保存進行中のデータロスシナリオへの対応が必要。

---

## Must Fix（必須対応）

### S1-001: saveContent()のisDirtyガードとuseAutoSaveの競合問題がIssueに未記載

**カテゴリ**: 設計
**場所**: `src/components/worktree/MarkdownEditor.tsx` L245-279

**問題**:
現在のMarkdownEditor.tsxのsaveContent()関数は先頭で`if (!isDirty || isSaving) return;`のガードを持つ。useAutoSaveのsaveFnとしてこの関数をそのまま渡すと、useAutoSaveが内部でinitialValueRefとvalueの比較で保存トリガーを制御しているのとは別に、isDirtyフラグ（`content !== originalContent`）が保存を阻止するケースがある。

具体的には、useAutoSaveのデバウンス完了後にsaveFnが呼ばれた瞬間、MarkdownEditor側のisDirtyが既にfalseになっている場合（他の経路でoriginalContentが更新された場合など）に保存がスキップされる。

**証拠**:
```typescript
// MarkdownEditor.tsx L245-246 - 現在のsaveContent
const saveContent = useCallback(async () => {
  if (!isDirty || isSaving) return;  // <-- このガードがuseAutoSaveと競合する
```

```typescript
// MemoCard.tsx L94-99 - 参考: useAutoSaveの正しい使い方
} = useAutoSave({
  value: title,
  saveFn: async (value) => {
    await onUpdate(memo.id, { title: value });  // <-- 純粋なAPI呼び出し、ガードなし
  },
});
```

**推奨対応**:
実装タスクに「saveContent()のisDirtyガードを分離し、useAutoSave用の保存関数（saveFn）はisDirtyチェックを含まない純粋なAPI呼び出しとして切り出す」旨のタスクを追加する。MemoCardの実装パターン（saveFnがAPI呼び出しを直接ラップ）を踏襲するのが妥当。

---

### S1-002: auto-save ON時のbeforeunload抑制ロジックの不十分な記述

**カテゴリ**: 設計
**場所**: Issueの「実装タスク」セクション / `src/components/worktree/MarkdownEditor.tsx` L449-473

**問題**:
Issueの実装タスクには「beforeunloadハンドラーのauto-saveモード対応（auto-save ON時は未保存警告不要）」とあるが、これは正確ではない。auto-save ONでもsaveFn実行中（isSaving=true）でページ離脱すると保存がキャンセルされてデータが失われる。また、useAutoSaveのデバウンス中（タイマー待機中、まだsaveFnが呼ばれていない状態）の離脱もデータ喪失のリスクがある。

**証拠**:
```typescript
// useAutoSave.ts L180-197 - デバウンスタイマーの内部動作
useEffect(() => {
  if (value === initialValueRef.current) { return; }
  if (disabled) return;
  cancelPendingSave();
  timerRef.current = setTimeout(() => {
    void executeSave(valueRef.current);  // <-- タイマー発火前にページ離脱するとこの保存は実行されない
  }, debounceMs);
  // ...
```

**推奨対応**:
受入条件を修正し、「auto-save ON時は、保存済み（isDirty=false かつ isSaving=false）の場合のみbeforeunload警告を抑制する。デバウンス待機中またはisSaving=trueの場合は警告を表示する」とする。あるいは、離脱時にsaveNow()をトリガーしてフラッシュする方式も検討に値する。

---

## Should Fix（推奨対応）

### S1-003: auto-save ON時のhandleClose()の考慮が実装タスクに未記載

**カテゴリ**: 完全性
**場所**: `src/components/worktree/MarkdownEditor.tsx` L306-316

**問題**:
handleClose()はisDirty時にwindow.confirm()で確認ダイアログを表示する。auto-save ON時にこのダイアログをどう扱うかが実装タスクに含まれていない。beforeunloadだけでなく、Closeボタン押下時のフローもauto-saveモードに合わせた調整が必要。

**推奨対応**:
実装タスクに「auto-save ON時のhandleClose()挙動の調整：isSaving中の場合はsaveNow()で即座保存を完了してから閉じる、または閉じる前にsaveNow()をawaitする」を追加する。

---

### S1-004: auto-save ON時のCtrl+Sキーボードショートカットの挙動が未定義

**カテゴリ**: 完全性
**場所**: Issueの受入条件 / `src/components/worktree/MarkdownEditor.tsx` L363-387

**問題**:
auto-save ON時にCtrl+S / Cmd+Sを押した場合の挙動について言及がない。saveNow()をトリガーするのか、何もしないのか。

**推奨対応**:
「auto-save ON時のCtrl+S操作は、デバウンスをキャンセルしてsaveNow()で即座保存をトリガーする」を明記する。

---

### S1-005: デバウンス間隔3秒の定数化が未記載

**カテゴリ**: 整合性
**場所**: `src/types/markdown-editor.ts`

**問題**:
3000msのデバウンス値を定数として定義する方針が未記載。既存コードでは`PREVIEW_DEBOUNCE_MS = 300`が定数化されている。

**推奨対応**:
変更対象ファイルのsrc/types/markdown-editor.tsの変更内容に「`AUTO_SAVE_DEBOUNCE_MS = 3000`定数の追加」を含める。

---

### S1-006: auto-save失敗時のUI/UXが不十分

**カテゴリ**: 完全性
**場所**: Issueの受入条件

**問題**:
Error時の具体的なUI・UXが不明確。リトライ上限到達後のユーザーアクションが未定義。

**推奨対応**:
受入条件に「auto-save失敗時（リトライ上限到達後）は、エラーをToastで通知し、手動保存にフォールバックする」を追加する。

---

### S1-007: i18n対応の方針が未記載

**カテゴリ**: 整合性
**場所**: `src/components/worktree/MarkdownEditor.tsx`

**問題**:
プロジェクトではnext-intlによるi18n対応が広く行われているが、MarkdownEditor.tsx自体がi18n未対応（ハードコードされた英語文字列）。auto-save関連の新規文字列についての方針が未記載。

**推奨対応**:
MarkdownEditor全体がi18n未対応であるため、今回のIssueスコープではハードコード英語で統一する旨を明記する。

---

### S1-008: useAutoSaveのonSaveCompleteコールバック活用方針が未記載

**カテゴリ**: 完全性
**場所**: `src/hooks/useAutoSave.ts` L32

**問題**:
useAutoSaveはonSaveCompleteコールバックを持つが、活用方針に言及がない。保存成功時にsetOriginalContent(content)とonSave(filePath)を呼ぶ必要がある。

**推奨対応**:
実装タスクにonSaveCompleteの活用方針を追加する。

---

### S1-009: auto-save ON時のToast通知抑制が未記載

**カテゴリ**: 設計
**場所**: `src/components/worktree/MarkdownEditor.tsx` L268

**問題**:
auto-save ON時に毎回Toast通知が表示されるとユーザー体験が悪化する。Issueではインジケーター表示の記載はあるが、Toast抑制については未記載。

**証拠**:
```typescript
// MarkdownEditor.tsx L268 - 現在のsaveContent内
showToast('File saved successfully', 'success');  // <-- auto-save ON時に毎回表示されると煩わしい
```

**推奨対応**:
「auto-save ON時はToast通知を抑制し、インラインインジケーターのみで状態を伝える。失敗時のみToast通知を使用する」を追加する。

---

## Nice to Have（あれば良い）

### S1-010: アクセシビリティ（a11y）への考慮

**カテゴリ**: 完全性

auto-saveトグルスイッチに`role='switch'`と`aria-checked`属性、保存状態インジケーターに`aria-live='polite'`の設定を推奨する。

---

### S1-011: 「Saved」インジケーターの表示タイミング

**カテゴリ**: 明確性

「Saved」表示の持続時間が未定義。「保存完了後は'Saved'インジケーターを表示し、次のテキスト変更まで維持する」などの具体的なタイミングを明記することを推奨する。

---

### S1-012: テスト計画の詳細化

**カテゴリ**: 完全性

既存のMarkdownEditor.test.tsx（約1128行）への影響、および新規テストケースの具体的な列挙を推奨する。以下のテストケースを想定：
1. auto-saveトグルの切り替え
2. auto-save ON時の3秒デバウンス動作
3. auto-save ON時のインジケーター表示
4. auto-save ON/OFF切り替え時の状態遷移
5. localStorage永続化のテスト
6. 既存テストケースとの互換性確認

---

## 参照ファイル

### コード
| ファイル | 行 | 関連性 |
|---------|------|--------|
| `src/components/worktree/MarkdownEditor.tsx` | L245-279 | saveContent() - isDirtyガードとuseAutoSaveの競合箇所 |
| `src/components/worktree/MarkdownEditor.tsx` | L449-473 | beforeunloadハンドラー - auto-saveモード対応必要箇所 |
| `src/components/worktree/MarkdownEditor.tsx` | L306-316 | handleClose() - auto-saveモード対応必要箇所 |
| `src/components/worktree/MarkdownEditor.tsx` | L363-387 | handleKeyDown() - Ctrl+S挙動調整必要箇所 |
| `src/hooks/useAutoSave.ts` | L20-33 | UseAutoSaveOptions定義 |
| `src/hooks/useAutoSave.ts` | L117-155 | executeSave()リトライロジック |
| `src/components/worktree/MemoCard.tsx` | L89-111 | useAutoSaveの参考実装パターン |
| `src/types/markdown-editor.ts` | L182-197 | 既存LOCAL_STORAGE_KEY定数群 |
| `tests/unit/components/MarkdownEditor.test.tsx` | - | 既存テストスイート |
| `tests/unit/hooks/useAutoSave.test.ts` | - | useAutoSave既存テスト |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクトのモジュール構造・コーディング規約 |

---

*Generated by Issue Review Agent - Stage 1*

# Issue #389 レビューレポート - Stage 7

**レビュー日**: 2026-03-02
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7/8（影響範囲レビュー 2回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 2 |

**総括**: Stage 3で指摘された影響範囲の問題は全て適切に反映されている。新たなMust Fix項目は検出されなかった。Issue #389の影響範囲記述は実装着手に十分な品質に達している。

---

## 前回指摘事項の反映確認

### Stage 3 Must Fix（2件 -> 全て解決済み）

| ID | タイトル | 状態 |
|----|---------|------|
| S3-001 | 既存MarkdownEditorテストの大規模更新が必要 | **解決済み** |
| S3-002 | saveContent関数分離の波及箇所を影響範囲に明記 | **解決済み** |

**S3-001**: 実装タスクの「ユニットテストの追加・更新」セクションが詳細化され、既存Save Operations(6テスト)、Unsaved Changes Warning(3テスト)、Keyboard Shortcuts Ctrl+S関連テストの更新が具体的サブ項目として列挙されている。

**S3-002**: 影響範囲テーブルのMarkdownEditor.tsxが6項目に拡充。(1) saveToApi/saveContentの2関数化、(2) handleKeyDown Ctrl+S分岐、(3) handleClose auto-save対応、(4) Saveボタン表示制御、(5) beforeunloadハンドラー条件拡張（isDirty OR isSaving）、(6) ヘッダーにauto-saveトグルUI+保存インジケーター追加。

### Stage 3 Should Fix（6件 -> 4件解決済み、2件スキップ妥当）

| ID | タイトル | 状態 |
|----|---------|------|
| S3-003 | Ctrl+S連携のsaveNow()説明修正 | **解決済み** |
| S3-004 | E2Eテストへの影響追加 | **解決済み** |
| S3-005 | API呼び出し頻度とサーバー負荷 | 未反映（スキップ妥当） |
| S3-006 | onSaveコールバック頻度 | **解決済み** |
| S3-007 | 定数配置先の明示 | 未反映（スキップ妥当） |
| S3-008 | auto-save失敗時のフォールバック制御 | **解決済み** |

### Stage 3 Nice to Have（2件 -> スキップ妥当）

| ID | タイトル | 状態 |
|----|---------|------|
| S3-009 | i18n対応の影響範囲 | 未反映（スキップ妥当） |
| S3-010 | useAutoSaveテストへの間接的影響 | 未反映（スキップ妥当） |

### Stage 5/6 影響範囲関連（4件 -> 全て解決済み）

| ID | タイトル | 状態 |
|----|---------|------|
| S5-002 | onSaveCompleteコールバックの矛盾解消 | **解決済み** |
| S5-003 | beforeunload受入条件の明確化 | **解決済み** |
| S5-004 | beforeunload条件式のOR修正 | **解決済み** |
| S5-006 | handleClose()のデバウンス待機中対応 | **解決済み** |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### S7-001: onClose callbackテスト群（3テスト）のauto-saveモード対応が実装タスクに未記載

**カテゴリ**: テスト影響
**影響ファイル**: `tests/unit/components/MarkdownEditor.test.tsx`

**問題**:
実装タスクのテスト更新項目に「Save Operations（6テスト）」「Unsaved Changes Warning（3テスト）」「Keyboard Shortcuts」は記載されているが、「onClose callback」テスト群（3テスト: L732-789）への影響が漏れている。

`tests/unit/components/MarkdownEditor.test.tsx` L747-767の `'should warn before closing with unsaved changes'` テストは、auto-save ON時のhandleClose()挙動変更（isDirty=true時にwindow.confirm()ではなくsaveNow()を呼び出してから閉じる）に直接影響する。

**推奨対応**:
実装タスクのテスト更新項目に「既存onClose callbackテスト（3テスト）のauto-saveモード対応更新」を追加する。

---

#### S7-002: useAutoSaveのsaveFnにおけるvalueパラメータ利用の影響範囲が未分析

**カテゴリ**: 影響範囲
**影響ファイル**: `src/components/worktree/MarkdownEditor.tsx`, `src/hooks/useAutoSave.ts`

**問題**:
useAutoSaveのexecuteSave()（`src/hooks/useAutoSave.ts` L118）はsaveFnにvalueToSaveを引数として渡す。saveFnはこのパラメータを使用してAPI送信すべきであり、クロージャのcontent stateを参照すべきではない。

現在のsaveContent()（`src/components/worktree/MarkdownEditor.tsx` L256）はクロージャでcontentを参照する設計であり、saveToApiへの分離時にこの設計制約を認識していないと、タイミングによる値のずれが生じる可能性がある。

**参考実装** - MemoCardのパターン（`src/components/worktree/MemoCard.tsx` L96-98）:
```typescript
saveFn: async (value) => {
  await onUpdate(memo.id, { title: value });
},
```

**推奨対応**:
影響範囲テーブルのMarkdownEditor.tsx変更箇所(1)に「saveToApiはsaveFnのパラメータ（valueToSave）を使用する」旨を補足する。

---

#### S7-003: auto-saveトグルUIの具体的なdata-testid属性が未定義

**カテゴリ**: 影響範囲
**影響ファイル**: `src/components/worktree/MarkdownEditor.tsx`, `tests/unit/components/MarkdownEditor.test.tsx`

**問題**:
新しいUI要素（auto-saveトグル、保存状態インジケーター）のdata-testid属性名が未定義。既存のMarkdownEditorでは全インタラクティブ要素にdata-testidが付与されている:
- `save-button`, `close-button`, `maximize-button`
- `view-mode-split`, `view-mode-editor`, `view-mode-preview`
- `dirty-indicator`, `large-file-warning`, `maximize-hint`

テスト項目ではトグル操作やインジケーター表示の検証が計画されており、セレクターの事前定義が実装効率に寄与する。

**推奨対応**:
以下のdata-testidを規定する:
- auto-saveトグル: `auto-save-toggle`
- 保存状態インジケーター: `auto-save-indicator`

---

#### S7-004: auto-save ON切り替え時のinitialValueRefエッジケースが影響範囲に未記載

**カテゴリ**: 互換性
**影響ファイル**: `src/components/worktree/MarkdownEditor.tsx`, `src/hooks/useAutoSave.ts`

**問題**:
useAutoSaveのデバウンスeffect（`src/hooks/useAutoSave.ts` L180-184）は `value === initialValueRef.current` の場合にスキップする。auto-saveをONに切り替えた時点のcontent値がinitialValueRefに記録されるため、その時点で既にisDirty=trueの場合、さらに編集するまでauto-saveが発火しない。

この実装上の制約はMarkdownEditor.tsxのuseAutoSave統合部分の設計に影響し、「ON切り替え時のsaveNow()呼び出し」等の追加対応が必要になる可能性がある。

**推奨対応**:
影響範囲テーブルのMarkdownEditor.tsxに注意事項として追記する。推奨対策: auto-save ON切り替え時にisDirty=trueの場合はsaveNow()を即座呼び出し、未保存変更を保存する。

---

### Nice to Have（あれば良い）

#### S7-005: auto-saveインジケーター状態遷移のテストシナリオが具体化されていない

**カテゴリ**: テスト影響
**影響ファイル**: `tests/unit/components/MarkdownEditor.test.tsx`

テスト追加項目の「インジケーター表示」について、Saving -> Saved -> 再編集 -> Saving のような状態遷移テストの具体的なシナリオが未列挙。実装者判断で問題ないが、期待する状態遷移が明示されていると実装効率が上がる。

---

#### S7-006: Issueタイトルと影響範囲テーブルの対象の不一致

**カテゴリ**: 影響範囲

Issueタイトル「メモ機能にauto saveモードの追加」は変更対象のMarkdownEditorを指しておらず、MemoCardへの変更と誤解される可能性がある。影響範囲テーブルの変更対象ファイルは全てMarkdownEditor関連。Stage 5でS5-007として指摘済みだがスキップされた項目。

---

## 影響範囲分析

### 直接影響

| ファイル | 影響内容 |
|---------|---------|
| `src/components/worktree/MarkdownEditor.tsx` | 6箇所の変更（saveToApi分離、handleKeyDown、handleClose、Saveボタン、beforeunload、トグルUI） |
| `src/types/markdown-editor.ts` | LOCAL_STORAGE_KEY_AUTO_SAVE, AUTO_SAVE_DEBOUNCE_MS定数追加 |
| `tests/unit/components/MarkdownEditor.test.tsx` | 既存テスト更新（Save Ops 6件、Unsaved Warning 3件、Ctrl+S、onClose 3件）+ 新テスト追加 |

### 間接影響

| ファイル | 影響内容 |
|---------|---------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | auto-save時はonSave非呼び出しで影響なし（確認済み） |
| `src/hooks/useAutoSave.ts` | 変更不要（debounceMs引数、saveNow内部キャンセル機能で対応可能） |
| `src/hooks/useLocalStorageState.ts` | 変更不要（boolean型のauto-save設定永続化に対応済み） |
| `tests/e2e/markdown-editor.spec.ts` | デフォルトOFFのため既存テスト影響は限定的（確認のみ） |

### 破壊的変更

なし。auto-saveはデフォルトOFF、EditorProps型の変更なし、既存APIの変更なし。

---

## 参照ファイル

### コード
- `src/components/worktree/MarkdownEditor.tsx`: 直接変更対象（L245-279: saveContent, L306-316: handleClose, L363-387: handleKeyDown, L449-473: beforeunload, L606-726: ヘッダーUI）
- `src/hooks/useAutoSave.ts`: 変更不要（L86-88: initialValueRef, L117-155: executeSave, L170-175: saveNow）
- `src/types/markdown-editor.ts`: 直接変更対象（定数追加）
- `src/components/worktree/MemoCard.tsx`: 参考実装（L94-111: useAutoSaveのsaveFnパターン）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 間接影響（L1205-1207: handleEditorSave）
- `tests/unit/components/MarkdownEditor.test.tsx`: 更新必要（L185-348: Save Operations, L350-413: Unsaved Changes, L688-730: Keyboard Shortcuts, L732-789: onClose callback）

### ドキュメント
- `CLAUDE.md`: プロジェクト規約（テスト要件、コーディング規約）の参照

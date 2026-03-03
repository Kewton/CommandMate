# Issue #389 レビューレポート - Stage 5

**レビュー日**: 2026-03-02
**フォーカス**: 通常レビュー（2回目）
**ステージ**: 5/6（通常レビュー 2回目イテレーション）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

---

## 前回指摘事項の確認

Stage 1およびStage 3で指摘された全14件のうち、適用対象の10件が**全てIssueに反映されている**ことを確認した。

| 指摘ID | ステージ | 優先度 | ステータス |
|--------|---------|--------|-----------|
| S1-001 | Stage 1 | Must Fix | 解決済み |
| S1-002 | Stage 1 | Must Fix | 解決済み |
| S1-003 | Stage 1 | Should Fix | 解決済み |
| S1-004 | Stage 1 | Should Fix | 解決済み |
| S1-005 | Stage 1 | Should Fix | 解決済み |
| S1-006 | Stage 1 | Should Fix | 解決済み |
| S1-008 | Stage 1 | Should Fix | 解決済み |
| S1-009 | Stage 1 | Should Fix | 解決済み |
| S3-001 | Stage 3 | Must Fix | 解決済み |
| S3-002 | Stage 3 | Must Fix | 解決済み |
| S3-003 | Stage 3 | Should Fix | 解決済み |
| S3-004 | Stage 3 | Should Fix | 解決済み |
| S3-006 | Stage 3 | Should Fix | 一部解決（S5-002で矛盾を指摘） |
| S3-008 | Stage 3 | Should Fix | 解決済み |

---

## Must Fix（必須対応）

### S5-002: onSaveCompleteコールバックの実装タスク間で矛盾する記述

**カテゴリ**: 整合性
**場所**: 実装タスク 4番目と5番目

**問題**:
実装タスクの4番目に以下の記述がある:

> useAutoSaveのonSaveCompleteコールバックでsetOriginalContent(content)と**onSave?.(filePath)を呼び出し**、保存成功時の状態同期を行う

一方で、5番目のタスクでは:

> auto-save成功時のonSave呼び出し方針：ファイルツリーrefreshの頻度を考慮し、**auto-save時のonSave呼び出しはしない**（manual saveのみonSaveを呼び出す）

前者はonSaveCompleteでonSave(filePath)を呼ぶと読め、後者はauto-save時のonSave呼び出しはしないと明記しており、矛盾している。onSaveCompleteはauto-saveの保存成功時に呼ばれるコールバックであるため、ここでonSave(filePath)を呼ぶことは5番目のタスクに違反する。

**証拠**:
- 実装タスク4: `onSaveCompleteコールバックでsetOriginalContent(content)とonSave?.(filePath)を呼び出し`
- 実装タスク5: `auto-save時のonSave呼び出しはしない（manual saveのみonSaveを呼び出す）`

**推奨対応**:
4番目の実装タスクを以下に修正する:

> useAutoSaveのonSaveCompleteコールバックでsetOriginalContent(content)を呼び出し、dirty状態を解除する（onSave(filePath)はauto-save時には呼ばない。manual save時のみ呼び出す）

---

### S5-004: 影響範囲テーブルのbeforeunload条件式が論理的に誤り

**カテゴリ**: 正確性
**場所**: 影響範囲テーブル > MarkdownEditor.tsx > 変更箇所(5)

**問題**:
影響範囲テーブルの変更箇所(5)に「beforeunloadハンドラーの条件拡張（**isDirty AND isSaving**）」と記載されている。

しかし、受入条件に記載されているロジックは:

> isDirty=false かつ isSaving=false の場合のみbeforeunload警告を**抑制**する

この否定（つまり警告を表示する条件）は:

> isDirty=true **OR** isSaving=true の場合に警告を表示する

「isDirty AND isSaving」だと、isDirty=true かつ isSaving=false のデバウンス待機中に警告が表示されないことになり、データロスリスクがある。

**証拠**:
- 現在のコード (`/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/components/worktree/MarkdownEditor.tsx` L451-456): `if (isDirty)` のみで判定
- 受入条件: 「isDirty=false かつ isSaving=false の場合のみ抑制」 = 「isDirty OR isSaving の場合に警告」
- 影響範囲テーブル: 「isDirty AND isSaving」（誤り）

**推奨対応**:
影響範囲テーブルの変更箇所(5)を以下に修正する:

> beforeunloadハンドラーの条件拡張（isDirty **OR** isSaving で警告表示）

---

## Should Fix（推奨対応）

### S5-001: レビュー履歴セクションのS3-002の記述と影響範囲テーブルの項目数の不一致

**カテゴリ**: 整合性
**場所**: レビュー履歴 > Stage 3 > S3-002

**問題**:
レビュー履歴のStage 3セクションでS3-002の対応として「影響範囲テーブルのMarkdownEditor.tsxを**5項目**の具体的な変更箇所に拡充」と記載されているが、実際の影響範囲テーブルでは(1)~(6)の**6項目**が列挙されている。

**推奨対応**:
レビュー履歴のS3-002記述を「6項目」に修正する。

---

### S5-003: beforeunloadハンドラーにおけるデバウンス待機中の検出方法が未明確

**カテゴリ**: 明確性
**場所**: 受入条件 > beforeunload関連

**問題**:
受入条件に「デバウンス待機中またはisSaving=trueの場合は警告を表示する」と記載されているが、useAutoSaveフックの公開APIにはデバウンス待機中を示すフラグが存在しない（公開APIはisSaving/error/saveNowの3つのみ）。

実際にはisDirty=trueチェックでデバウンス待機中が自然にカバーされる（editによりcontent !== originalContentとなるため）が、受入条件の記述から別途検知が必要と読み取れる。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/hooks/useAutoSave.ts` L35-42: UseAutoSaveResultにはisSaving/error/saveNowのみ公開
- isSavingはexecuteSave()実行中のみtrue、デバウンスタイマー待機中はfalse

**推奨対応**:
受入条件を以下に修正して、isDirtyチェックでデバウンス待機中がカバーされることを明示する:

> auto-save ON時は、isDirty=false かつ isSaving=false の場合のみbeforeunload警告を抑制する。isDirty=true（デバウンス待機中を含む）またはisSaving=trueの場合は警告を表示する

---

### S5-005: useAutoSaveのinitialValueRef問題がauto-save ON/OFF切り替え時に影響する可能性

**カテゴリ**: 完全性
**場所**: 実装タスク

**問題**:
useAutoSaveフック (`/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/hooks/useAutoSave.ts` L88, L180-184) はinitialValueRefに初期値を記録し、value === initialValueRef.currentの場合はデバウンス保存をスキップする。

ユーザーが既にcontentを編集済み（isDirty=true）の状態でauto-saveをONに切り替えた場合、その時点のcontentがinitialValueRefとなり、さらに編集するまでauto-saveが発火しない。つまり、auto-save ON切り替え時点の未保存変更はauto-saveされず、ユーザーは保存されたと誤解する可能性がある。

**推奨対応**:
実装タスクまたは注意事項として「auto-save ON切り替え時に既にisDirty=trueの場合、即座にsaveNow()を呼び出して未保存変更を保存することを検討する」を追加する。

---

### S5-006: handleClose()のauto-saveモード対応における「isSaving中」以外のケースが未定義

**カテゴリ**: 明確性
**場所**: 実装タスク > handleClose()調整

**問題**:
実装タスクに「auto-save ON時のhandleClose()調整：isSaving中はsaveNow()で即座保存してから閉じる」と記載されているが、auto-save ON かつ isSaving=false かつ isDirty=true（デバウンス待機中）の場合の挙動が未定義。

この状態ではデバウンスタイマーがまだ発火前であり、handleClose()が呼ばれた際にisSavingチェックのみだとデバウンス待機中の未保存データが失われる。

**証拠**:
- 現在の`handleClose()` (`/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/components/worktree/MarkdownEditor.tsx` L306-316): isDirty時にwindow.confirm()を表示
- 実装タスク: 「isSaving中はsaveNow()」のみ言及、デバウンス待機中は対象外

**推奨対応**:
実装タスクを以下に修正する:

> auto-save ON時のhandleClose()調整：isDirty=trueまたはisSaving=trueの場合はsaveNow()で即座保存を完了してから閉じる

---

## Nice to Have（あれば良い）

### S5-007: Issueタイトルと実際のスコープの不一致

**カテゴリ**: 完全性
**場所**: Issueタイトル

**問題**:
Issueタイトルは「メモ機能にauto saveモードの追加」だが、実際の変更対象はMarkdownEditor（ファイル編集エディタ）であり、MemoCard（メモ機能）ではない。

**推奨対応**:
Issueタイトルを「MarkdownEditorにauto-saveモードの追加」に修正する。

---

### S5-008: auto-save ON/OFF切り替え時のデバウンスタイマー・保存中状態のクリーンアップが未記載

**カテゴリ**: 明確性
**場所**: 実装タスク

**問題**:
auto-save ON状態で編集中（デバウンスタイマー待機中またはisSaving=true）にユーザーがauto-saveをOFFに切り替えた場合の挙動が未定義。

**推奨対応**:
「auto-save OFF切り替え時の進行中保存は完了を待つ（キャンセルしない）」旨を注意事項として記載する。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/hooks/useAutoSave.ts` L86-88, L180-184 | initialValueRefとデバウンスeffect - S5-005 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/hooks/useAutoSave.ts` L35-42 | UseAutoSaveResult公開API - S5-003 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/components/worktree/MarkdownEditor.tsx` L449-473 | beforeunloadハンドラー - S5-004 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/components/worktree/MarkdownEditor.tsx` L306-316 | handleClose() - S5-006 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/components/worktree/MarkdownEditor.tsx` L245-279 | saveContent() - S5-002 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| CLAUDE.md | プロジェクト規約の参照 |

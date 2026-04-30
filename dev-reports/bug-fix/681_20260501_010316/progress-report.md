# Bug Fix Progress Report — Issue #681

**Issue**: verify: .yaml/.yml/.html でも #675 と同種の re-render ループが発生しないか確認
**Status**: ✅ Completed
**Branch**: `feature/681-worktree`
**Date**: 2026-05-01

---

## Summary

Issue #681 は `.md` ファイルで発見された無限 re-render ループ (Issue #675) が `.yaml`/`.yml`/`.html`/`.htm` でも発生するかを検証する verify Issue。**コード解析と新規テストにより、いずれの拡張子でもループは再現しないことを確認**した上で、`HtmlPreview` の dead prop を整理し、回帰防止テストを追加した。

---

## Phase Results

### Phase 1 — Investigation
拡張子別ルーティング (`FilePanelContent.tsx`):
- `.md` → `MarkdownEditor` (markdown mode) ← #675 で問題化
- `.yaml`/`.yml` → `MarkdownEditor` (text mode) — **同じ親callback + 同じreducerを経由**
- `.html`/`.htm` → `HtmlPreview` — **`onDirtyChange` は prop 宣言のみで本体は dead wiring**

### Phase 2 — User Decision
ユーザー選択: **案1+案2 を実施**

### Phase 3 — Work Plan
1. 回帰防止テスト追加 (`tests/unit/hooks/useFileTabs.test.ts`)
2. `HtmlPreview` の未使用 `onDirtyChange` prop を削除

### Phase 4 — Implementation

| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/hooks/useFileTabs.test.ts` | #681 用 SET_DIRTY 同値連打テスト 3 件追加 |
| `src/components/worktree/HtmlPreview.tsx` | `HtmlPreviewProps.onDirtyChange` 削除 (dead prop) |
| `src/components/worktree/FilePanelContent.tsx` | `<HtmlPreview onDirtyChange={...}>` の渡し削除 |

### Phase 5 — Acceptance Test

| 受入条件 | 結果 |
|---------|------|
| 4拡張子で再現テスト | ✅ いずれも再現せず (#675 修正で構造的にカバー) |
| 再現する場合は Issue 起票 | ✅ 不要 |
| HtmlPreview の `onDirtyChange` useEffect 実装確認 | ✅ 実装なし (dead prop) を確認・整理 |

---

## Quality Gates

| Gate | Result |
|------|--------|
| `tsc --noEmit` | ✅ 0 errors |
| ESLint (modified files) | ✅ 0 errors |
| Unit Tests | ✅ 340 files / 6396 pass / 7 skipped |
| New Regression Tests | ✅ 3 件追加・全てパス |

---

## Why No Reproduction

3層の防御で `.yaml`/`.yml`/`.html`/`.htm` 全てが安全:

- **Layer A (#675)**: `WorktreeDetailRefactored.tsx:1317-1320` の `handleDirtyChange` deps が `[fileTabs.dispatch]` で安定
- **Layer B (#675)**: `useFileTabs.ts:239-249` で SET_DIRTY 同値 dispatch が state 参照を変えない
- **Layer C (#681 finding)**: `HtmlPreview` は `onDirtyChange` を呼ばないため、HTML はループの起点を持たない

---

## Files Changed (Summary)

```
tests/unit/hooks/useFileTabs.test.ts          | +59 lines (3 new tests)
src/components/worktree/HtmlPreview.tsx       |  -1 line  (remove dead prop)
src/components/worktree/FilePanelContent.tsx  |  -1 line  (remove dead pass-through)
```

---

## Next Steps

- Issue #681 をクローズ可能 (verify-only + 軽微な整理で完了)
- PR 作成は別途ユーザー指示で実施

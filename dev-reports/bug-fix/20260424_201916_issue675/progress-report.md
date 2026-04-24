# バグ修正完了レポート - Issue #675

## 概要

| 項目 | 内容 |
|------|------|
| Issue 番号 | #675 |
| タイトル | fix: Markdown ファイル表示中にサイドバーからのブランチ遷移が効かない (onDirtyChange 無限ループ) |
| ブランチ | `feature/675-worktree` |
| 修正コミット | `e91e1928` |
| 報告日時 | 2026-04-24 20:35 JST |
| 総合ステータス | PASS (自動受入全件通過、実機受入は別途推奨) |

### 症状

Files タブで `.md` ファイルを表示中、サイドバーのブランチ切替をクリックしても URL 遷移 (router.push) が commit されない。画像/JSON/PDF 表示中は問題なし。

---

## 根本原因 (サマリ)

React 18 の並行レンダリング下で発生する re-render ループが、App Router の transition (低優先度更新) を継続的に defer させていた。連鎖の起点は次の 2 点。

1. **`useFileTabs` の return が毎レンダー新オブジェクト**
   → 呼び出し側 `WorktreeDetailRefactored.tsx` の 4 useCallback (`handleLoadContent` / `handleLoadError` / `handleSetLoading` / `handleDirtyChange`) の deps が `[fileTabs]` だったため、コールバックが毎レンダー再生成 → `FilePanelContent` → `MarkdownEditor` と伝播。
2. **`SET_DIRTY` reducer に同値判定なし**
   → `MarkdownEditor` の `useEffect([isDirty, onDirtyChange])` が不安定 prop で毎レンダー発火 → dispatch が同値でも新 state 参照 → 親の再レンダー → 無限連鎖。

`.md` に限らず `isEditableExtension()` が true を返す拡張子 (`.yaml` / `.yml` 等) でも MarkdownEditor 経路で再現しうる。画像/JSON/PDF ビューアは `onDirtyChange` を受け取らないため影響なし。

---

## Phase 別結果

### Phase 1: 調査 (investigation)

- Issue 本文記載のコード位置 5 箇所 (useFileTabs L239-246 / L384、WorktreeDetailRefactored L1298-1313、FilePanelContent L563-568、MarkdownEditor L226-228) を実コードと照合し全て一致を確認。
- メカニズム分析は概ね妥当。ただし「`.md` 限定」は言い過ぎで MarkdownEditor を描画する編集可能拡張子全般で再現する可能性を指摘。
- 同種アンチパターン (`fileTabs` 全体を useCallback deps に置く) を同ファイル内に 5 箇所残存確認 (L551/L570/L581/L875/L904) → 別 Issue 化を推奨。
- 成果物: `investigation-result.json`

### Phase 2: ユーザー確認

- **採用方針**: A案 + B案 両方適用 (多層防御)
- **スコープ外**: 他 5 箇所のアンチパターンは別 Issue として分離

### Phase 3: 作業計画

- A案 (WorktreeDetailRefactored の 4 useCallback deps → `[fileTabs.dispatch]`) と B案 (useFileTabs.ts SET_DIRTY 同値 no-op) を 1 コミットで実装。
- TDD で B案の reducer テストを先行追加する方針に決定。
- 成果物: `work-plan-context.json`

### Phase 4: TDD 修正 (tdd-fix)

| フェーズ | 結果 |
|---------|------|
| Red | `tests/unit/hooks/useFileTabs.test.ts` に同値 no-op 検証 3 件 (false→false / true→true / 二重適用) を追加。初回実行で 3 FAIL / 6381 PASS (Red 成立)。 |
| Green | B案 (useFileTabs.ts に `find` + 同値判定) → A案 (4 useCallback deps 変更、`eslint-disable-next-line react-hooks/exhaustive-deps` 付与) を順次適用。全ユニットテスト 6384 PASS / 7 skipped。 |
| Refactor | スコープ最小維持。対象外の 5 箇所のアンチパターンは非変更。 |

- コミット: `e91e1928 fix(#675): stop re-render loop blocking worktree URL updates`

### Phase 5: 受入テスト (acceptance)

| シナリオ | 内容 | 結果 |
|---------|------|------|
| S1 | B案: SET_DIRTY 同値 dispatch で state 参照不変 (false→false / true→true / 二重適用) | PASS |
| S2 | B案: SET_DIRTY で真に変化する場合は従来通り新 state を返す | PASS |
| S3 | A案: WorktreeDetailRefactored の 4 useCallback deps が `[fileTabs.dispatch]` | PASS |
| S4 | lint / typecheck / unit test / build 全通過 | PASS |
| S5 | 実機: `.md` 表示中のサイドバーブランチ遷移 | SKIPPED (実機確認はユーザー側) |
| S6 | 実機: `.yaml` / `.yml` での同挙動確認 | SKIPPED |
| S7 | 実機: `.png` / `.json` 回帰確認 | SKIPPED |

---

## 変更ファイル一覧

| ファイル | 変更 |
|---------|------|
| `src/hooks/useFileTabs.ts` | +3 -0 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | +11 -4 |
| `tests/unit/hooks/useFileTabs.test.ts` | +36 -0 |

### Diff サマリ

**`src/hooks/useFileTabs.ts`** (SET_DIRTY case, L237 付近)

```ts
case 'SET_DIRTY': {
  // [Issue #675] Short-circuit no-op dispatches so upstream useReducer skips re-render
  const current = state.tabs.find((t) => t.path === action.path);
  if (current && current.isDirty === action.isDirty) return state;
  const newTabs = updateTabByPath(state.tabs, action.path, (tab) => ({
    ...tab,
    isDirty: action.isDirty,
  }));
  ...
}
```

**`src/components/worktree/WorktreeDetailRefactored.tsx`** (L1295 付近の 4 useCallback)

```tsx
// deps を [fileTabs] → [fileTabs.dispatch] に変更 (4 箇所)
const handleLoadContent = useCallback((path, content) => {
  fileTabs.dispatch({ type: 'SET_CONTENT', path, content });
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [fileTabs.dispatch]);
// handleLoadError / handleSetLoading / handleDirtyChange も同様
```

**`tests/unit/hooks/useFileTabs.test.ts`**: SET_DIRTY 同値 no-op 検証 3 件を追加。

---

## 自動検証結果

| チェック | コマンド | 結果 |
|---------|---------|------|
| ESLint | `npm run lint` | PASS (No ESLint warnings or errors) |
| TypeScript | `npx tsc --noEmit` | PASS (exit 0) |
| Unit Test | `npm run test:unit` | PASS (340 files, 6384 passed, 7 skipped, 0 failed) |
| Build | `npm run build` | PASS (Next.js compiled successfully) |
| Static grep (A案) | `WorktreeDetailRefactored.tsx` の 4 箇所すべて `[fileTabs.dispatch]` | PASS |
| Static grep (B案) | `useFileTabs.ts:242` に同値判定存在 | PASS |

全自動チェック通過。

---

## スコープ外 (別 Issue 化推奨)

1. **`WorktreeDetailRefactored.tsx` 内の同種アンチパターン 5 箇所**
   - L551 `handleFilePathClick` (fileTabs.openFile のみ使用)
   - L570 `handleFileSelect` (同上)
   - L581 `handleOpenFile` (同上)
   - L875 `handleRename` (fileTabs.onFileRenamed のみ使用)
   - L904 `handleDelete` (fileTabs.onFileDeleted のみ使用)
   - いずれも `deps=[..., fileTabs, ...]` で object 全体を依存しているが、顕在化していない。一括整理を推奨。

2. **`useFileTabs` の return を `useMemo` ラップ or 個別 export 化**
   - 呼び出し側で `deps=[fileTabs]` と書いてもループしない API に改善。根本的な API 設計課題。

---

## 推奨フォローアップ

1. **実機受入 (S5/S6/S7) のユーザー実施**
   - `commandmate start` でサーバ起動
   - Worktree A で `.md` / `.yaml` / `.yml` を開いた状態 → サイドバーで Worktree B を選択 → URL が `/worktrees/{B}` に更新されることを確認
   - `.png` / `.json` (非対象拡張子) でも遷移することを回帰確認

2. **PR 作成**
   - `/create-pr` または `gh pr create` で `develop` へマージ依頼
   - 実機受入 OK 後にマージ

3. **別 Issue 起票**
   - 「WorktreeDetailRefactored.tsx 内の useCallback deps 安定化 (L551/L570/L581/L875/L904)」
   - 「useFileTabs の戻り値安定化 API リファクタリング」

---

## 備考

- A案 + B案 両方適用により、根本原因を断ちつつ将来の同種バグに対する多層防御を確保。
- `eslint-disable-next-line react-hooks/exhaustive-deps` は `useReducer` 由来の dispatch が stable という React 保証に依拠する局所抑止であり、各箇所にコメントで理由を明記済み。
- データ破壊リスクなし (編集内容は保存ボタン / オートセーブ経路で別管理)。

**Issue #675 のバグ修正は自動検証レベルで完了しました。実機受入後にマージ推奨です。**

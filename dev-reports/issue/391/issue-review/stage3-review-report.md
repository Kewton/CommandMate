# Issue #391 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-02
**フォーカス**: 影響範囲レビュー（1回目）
**全体リスク**: Low

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

## 影響範囲マップ

### 直接影響ファイル（修正対象）

| ファイル | 影響内容 |
|---------|---------|
| `src/components/worktree/AgentSettingsPane.tsx` | isEditingフラグ追加、useEffect(L98-100)のガード、handleCheckboxChangeのsetIsEditing制御 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | fetchWorktree()内(L1035-1036)でselectedAgentsの同一値チェック追加（useRefパターン） |
| `tests/unit/components/worktree/AgentSettingsPane.test.tsx` | L62-80のテスト前提変更（isEditing=false条件付き同期） |

### 間接影響ファイル（変更不要）

| ファイル | 影響なしの理由 |
|---------|---------------|
| `src/components/worktree/NotesAndLogsPane.tsx` | AgentSettingsPaneへのprops透過のみ。インターフェース変更なし |
| `src/app/api/worktrees/[id]/route.ts` | API側変更なし。クライアントサイドの状態管理修正のみ |
| `src/lib/selected-agents-validator.ts` | バリデーションロジック変更なし |
| `src/types/models.ts` | Worktree型変更なし |
| `src/types/sidebar.ts` | サーバーサイドのデータ読み取りのみ |
| `tests/unit/components/worktree/NotesAndLogsPane.test.tsx` | AgentSettingsPaneをモック化しており影響なし |
| `tests/integration/api-worktrees.test.ts` | API側変更なしのため影響なし |
| `tests/unit/types/sidebar.test.ts` | サーバーサイドのデータ読み取りテストのため影響なし |

### Props伝播パス

```
WorktreeDetailRefactored
  |-- [state] selectedAgents / setSelectedAgents
  |-- [callback] handleSelectedAgentsChange -> setSelectedAgents
  |-- [polling] fetchWorktree() -> setSelectedAgents (案Bで同一値チェック追加)
  |
  |-- (Desktop) NotesAndLogsPane
  |     |-- AgentSettingsPane (isEditing追加対象)
  |
  |-- (Mobile) MobileContent -> NotesAndLogsPane
        |-- AgentSettingsPane (isEditing追加対象)
```

### 関連useEffect依存グラフ

```
selectedAgents変更
  |
  |--> AgentSettingsPane useEffect(L98-100): setCheckedIds (案AでisEditingガード)
  |
  |--> WorktreeDetailRefactored useEffect(L1118-1122): activeCliTab同期
       (案Bにより不要なselectedAgents更新が減少し、間接的に呼び出し頻度が減る)
```

---

## Should Fix（推奨対応）

### IF-001: activeCliTab同期useEffect(L1118-1122)の間接的影響の考慮が不足

**カテゴリ**: 影響範囲
**場所**: ## 修正方針 案B

**問題**:
WorktreeDetailRefactored L1118-1122のuseEffectは `selectedAgents` の変更に依存している。案Bの修正により `setSelectedAgents` の呼び出し頻度が減少するが、実際にサーバー側でselectedAgentsが変更された場合は引き続き `setSelectedAgents` が呼ばれるため、`activeCliTab` の同期は正しく動作する。ただし、Issueの修正方針セクションでこの間接的影響について明示的に言及されていない。

**関連コード** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-391/src/components/worktree/WorktreeDetailRefactored.tsx` L1116-1122):
```tsx
// Issue #368: Sync activeCliTab when selectedAgents changes
// If current activeCliTab is no longer in selectedAgents, switch to first agent
useEffect(() => {
  if (!selectedAgents.includes(activeCliTab)) {
    setActiveCliTab(selectedAgents[0]);
  }
}, [selectedAgents, activeCliTab]);
```

**推奨対応**:
修正方針セクションに「案Bの同一値チェックはactiveCliTab同期(L1118-1122)に影響しない。サーバー側でselectedAgentsが変更された場合のみsetSelectedAgentsが呼ばれるため、activeCliTabの同期は引き続き正しく動作する」旨の注記を追加する。

---

### IF-002: テスト更新方針にWorktreeDetailRefactored側のテストケース言及がない

**カテゴリ**: 不足情報
**場所**: ## テスト更新方針

**問題**:
Issue本文のテスト更新方針セクションはAgentSettingsPane.test.tsxの更新と追加テストケースのみ言及している。しかし案Bの修正対象であるWorktreeDetailRefactored.tsx の `fetchWorktree()` 内の同一値チェックロジックについてもテスト方針を記載すべきである。

**現行テスト状況**:
- `AgentSettingsPane.test.tsx` -- 直接のユニットテストあり（更新方針記載済み）
- `NotesAndLogsPane.test.tsx` -- AgentSettingsPaneをモック化（影響なし）
- WorktreeDetailRefactored -- ユニットテスト不在（大規模コンポーネント）

**推奨対応**:
テスト更新方針に「WorktreeDetailRefactored.tsx: fetchWorktree()内のselectedAgents同一値チェックは、配列比較ロジックが正しく動作することをAgentSettingsPane側のE2Eシナリオテスト（isEditing中のprop変更無視テスト）で間接的に検証する」旨を追加する。

---

## Nice to Have（あれば良い）

### IF-003: MobileContentコンポーネント経由のprops透過についての影響範囲記載

**カテゴリ**: 影響範囲
**場所**: ## 影響範囲

影響範囲テーブルにNotesAndLogsPane.tsxとMobileContent（WorktreeDetailRefactored内部コンポーネント）の行を追加し、「props透過のみ、変更なし」と記載すると、レビュアーが影響範囲を網羅的に把握しやすくなる。

---

### IF-004: 案Bの配列比較ロジックにおける順序依存性リスク

**カテゴリ**: リスク
**場所**: ## 修正方針 案B 擬似コード

案Bの同一値チェックは `every((v, i) => v === current[i])` で順序を含む厳密比較を行う。現在のAPI実装(route.ts L219)ではクライアントから送信した順序でDBに保存されるため問題ないが、将来的にソート処理が追加された場合のリスクがある。擬似コードにコメントで「順序を含む厳密比較。APIはクライアント送信順でDBに保存するため、順序の一致が保証される」と付記するとよい。

---

### IF-005: visibilitychange復帰時のfetchWorktree呼び出しへの影響

**カテゴリ**: 影響範囲
**場所**: ## 受入条件

WorktreeDetailRefactored L1755ではページ復帰時に `fetchWorktree()` を呼ぶ。案Bの同一値チェックにより、ページ復帰時もselectedAgentsが変わっていなければ `setSelectedAgents` が呼ばれず、isEditing中のローカル状態が保護される。受入条件の5番目にvisibilitychange復帰シナリオを明示するか、既存の条件5の説明を拡充するとよい。

---

## 破壊的変更の有無

**破壊的変更なし**。

- `AgentSettingsPaneProps` インターフェースに変更はない
- API（PATCH/GET `/api/worktrees/[id]`）に変更はない
- `selected-agents-validator.ts` のバリデーションロジックに変更はない
- DB スキーマに変更はない

---

## パフォーマンスへの影響

**案A（isEditingフラグ）**: パフォーマンス影響なし。useStateの追加とuseEffect内のif文分岐のみ。

**案B（同一値チェック）**: ポーリングごとに配列比較（2要素の文字列比較）が追加されるが、計算コストは無視できる。`setSelectedAgents` の不要な呼び出しが減少するため、React再レンダリング回数がわずかに削減される正の効果がある。

---

## 参照ファイル

### 直接修正対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-391/src/components/worktree/AgentSettingsPane.tsx` - isEditingフラグ追加対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-391/src/components/worktree/WorktreeDetailRefactored.tsx` - fetchWorktree同一値チェック追加対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-391/tests/unit/components/worktree/AgentSettingsPane.test.tsx` - テスト前提変更対象

### 間接参照（変更不要を確認）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-391/src/components/worktree/NotesAndLogsPane.tsx` - props透過コンテナ
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-391/src/app/api/worktrees/[id]/route.ts` - APIエンドポイント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-391/src/lib/selected-agents-validator.ts` - バリデーションロジック
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-391/src/types/models.ts` - Worktree型定義
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-391/src/types/sidebar.ts` - サイドバーステータス判定

# Issue #727 仮説検証レポート

**対象Issue**: #727 feat(layout): replace LeftPaneTabSwitcher with VS Code-style Activity Bar + relocate History pane (PC)
**日付**: 2026-05-30
**カテゴリ**: 機能追加（リファクタリング兼ねる）

## 概要

Issue #727 は新規 UI レイアウト追加だが、本文中に「現状のコード構造」「再利用する既存コンポーネント」「参照する既存パターン」など多数の事実主張（Assumption）を含む。これらを実コードで検証する。

---

## 検証結果サマリー

| # | 主張カテゴリ | 主張内容 | 判定 |
|---|------------|----------|------|
| H1 | Assumption | `LeftPaneTabSwitcher` が History/Files/CMATE の3タブ式 | **Partially Confirmed** |
| H2 | Assumption | CMATE タブ中身 `NotesAndLogsPane` は Notes/Logs/Agent/Timer の4サブタブ二層構造 | **Confirmed** |
| H3 | Assumption | `GitPane.tsx`(Issue #447) を Git Activity として流用可能 | **Partially Confirmed**（現状サブタブ） |
| H4 | Assumption | `MemoPane.tsx`(Issue #485) を Notes Activity として流用可能 | **Confirmed** |
| H5 | Assumption | `ExecutionLogPane.tsx` を Schedules Activity として流用可能 | **Confirmed** |
| H6 | Assumption | `AgentSettingsPane.tsx` を Agent Activity として流用可能 | **Confirmed** |
| H7 | Assumption | `TimerPane.tsx`(Issue #534) を Timer Activity として流用可能 | **Confirmed** |
| H8 | Assumption | `PaneResizer.tsx` を流用可能 | **Confirmed** |
| H9 | Assumption | `LeftPaneTabSwitcher.tsx` を**削除**してよい | **Confirmed** |
| H10 | Assumption | `NotesAndLogsPane.tsx` を**削除**してよい | **Rejected**（モバイルが使用中） |
| H11 | Assumption | モバイル (`GlobalMobileNav`) は現状維持で済む | **Rejected**（NotesAndLogsPane 削除と矛盾） |
| H12 | Assumption | 既存テストは限定的な変更で済む | **Partially Confirmed** |
| H13 | Assumption | `LayoutState` 拡張で吸収可能（`activityBar`/`historyPane`セクション追加） | **Confirmed**（既存 `leftPaneTab` の扱いは要設計） |
| H14 | Assumption | localStorage 永続化キー `commandmate:activeActivity` 等の名前空間が衝突しない | **Confirmed** |
| H15 | Assumption | Issue #688 leftPaneCollapsed パターンが流用可能 | **Confirmed**（ただし旧 `leftPaneCollapsed` の意味が消失） |
| H16 | Assumption | `jest-axe` 等によるアクセシビリティ検証が可能 | **Rejected**（jest-axe 未導入） |

---

## 詳細検証

### H1: `LeftPaneTabSwitcher` が History/Files/CMATE の3タブ式

**判定**: Partially Confirmed

**根拠コード**:
- `src/components/worktree/LeftPaneTabSwitcher.tsx:19`
  ```ts
  export type LeftPaneTab = 'history' | 'files' | 'memo';
  ```
- 内部 ID は `'memo'`、ラベルが "CMATE" として表示されている（多言語キー経由）

**事実**:
- タブ数3個は正しい
- 内部 ID は `memo`（Issue 本文の「CMATE」は表示ラベル）
- 新規実装でもタブ ID の歴史的命名差異に注意（既存 deep-link `?pane=notes|logs|agent|timer` は `leftPaneTab='memo'` にマップされている）

**Stage 1への申し送り**:
- Issue 本文の「CMATEタブ」記述は実装上 `memo` ID であることを明記すべき
- 既存 `LeftPaneTab` 型自体が削除されるか、内部だけ残るかの方針が不明確

---

### H2: `NotesAndLogsPane` は Notes/Logs/Agent/Timer の4サブタブ二層構造

**判定**: Confirmed

**根拠コード**:
- `src/components/worktree/NotesAndLogsPane.tsx:27`
  ```ts
  type SubTab = 'notes' | 'logs' | 'agent' | 'timer';
  ```
- `src/components/worktree/NotesAndLogsPane.tsx:64-69`
  ```ts
  const SUB_TABS: readonly SubTabConfig[] = [
    { id: 'notes', labelKey: 'notes' },
    { id: 'logs', labelKey: 'logs' },
    { id: 'agent', labelKey: 'agentTab' },
    { id: 'timer', labelKey: 'timerTab' },
  ] as const;
  ```

**事実**: 完全一致。

---

### H3: `GitPane.tsx`(Issue #447) を Git Activity として流用可能

**判定**: Partially Confirmed

**根拠コード**:
- `src/components/worktree/GitPane.tsx` は存在し、`worktreeId`/`onDiffSelect`/`isMobile`/`className` の props を持つ
- **ただし**現状 `GitPane` は History タブ内の「Git サブタブ」として呼び出されている（`WorktreeDetailRefactored.tsx:1559-1568`）
  ```tsx
  {historySubTab === 'git' && (
    <ErrorBoundary componentName="GitPane">
      <GitPane worktreeId={worktreeId} onDiffSelect={handleDiffSelect} isMobile={false} className="flex-1 min-h-0" />
    </ErrorBoundary>
  )}
  ```

**事実**:
- 現状は History 内サブタブとして `Message | Git` 切替が存在する（Issue 本文に未記載）
- Issue #727 で Git が Activity に昇格すると、`HistorySubTab` 型と `historySubTab` ローカル state が**事実上廃止**される（PC 版）
- ただしモバイル版は `HistoryPane` を `case 'history'` で表示しており、サブタブ自体の存在/不存在の影響範囲が PC/モバイルで分岐

**Stage 1への申し送り**:
- Issue 本文に「現状の History 内 Message/Git サブタブ」の存在と廃止可否を追記すべき
- `HistorySubTab` 型（`src/types/ui-state.ts:76`）と `useWorktreeTabState` のマッピング (`?pane=git`→`historySubTab='git'`) の改修方針を明示すべき

---

### H4: `MemoPane.tsx` を Notes Activity として流用可能

**判定**: Confirmed
- `src/components/worktree/MemoPane.tsx` 存在
- `MemoPaneProps` あり (`worktreeId` props 経由で利用)

---

### H5: `ExecutionLogPane.tsx` を Schedules Activity として流用可能

**判定**: Confirmed
- `src/components/worktree/ExecutionLogPane.tsx` 存在
- 既存 `NotesAndLogsPane.tsx:122` で `<ExecutionLogPane worktreeId={worktreeId} className="h-full" />` として使われている
- ただし Issue が "Schedules" と命名している部分は、既存 i18n キー上 "logs" / "schedule" 系の語彙が混在

**Stage 1への申し送り**:
- ナビゲーション/aria-label/i18n キーの命名統一方針を明示すべき（"Schedules" or "Logs"）

---

### H6 / H7: `AgentSettingsPane.tsx` / `TimerPane.tsx` を Activity として流用可能

**判定**: Confirmed
- 両ファイル存在、`worktreeId` props 経由で利用可能（型は確認済み）

---

### H8: `PaneResizer.tsx` を流用可能

**判定**: Confirmed
- `src/components/worktree/PaneResizer.tsx` 存在、`onResize(delta)` API を持つ
- WorktreeDesktopLayout の DesktopLayout サブコンポーネントが既に使用中

---

### H9: `LeftPaneTabSwitcher.tsx` を削除してよい

**判定**: Confirmed

**根拠コード（参照箇所）**:
- `src/components/worktree/WorktreeDetailRefactored.tsx:40,1510` のみ（PC 版のみ）
- モバイル経路は `MobileTabs`（存在せず）/`WorktreeDetailSubComponents.tsx` 側で別実装
- テスト: `tests/unit/components/worktree/LeftPaneTabSwitcher.test.tsx` の更新/削除が必要

---

### H10: `NotesAndLogsPane.tsx` を削除してよい

**判定**: ❌ **Rejected**

**根拠コード（残存参照）**:
- `src/components/worktree/WorktreeDetailSubComponents.tsx:32` import
- `src/components/worktree/WorktreeDetailSubComponents.tsx:1041-1054` モバイル `case 'memo'` で使用中
  ```tsx
  case 'memo':
    return (
      <ErrorBoundary componentName="NotesAndLogsPane">
        <NotesAndLogsPane worktreeId={worktreeId} ... />
      </ErrorBoundary>
    );
  ```
- テスト: `tests/unit/components/worktree/NotesAndLogsPane.test.tsx`

**事実**:
- モバイル版が依然として `NotesAndLogsPane` を 'memo' タブで使用している
- Issue 本文「PC版のみが対象」「モバイル (`GlobalMobileNav`) は現状維持」と「NotesAndLogsPane を削除」の主張は**矛盾**
- 削除すると `WorktreeDetailSubComponents` のモバイル経路が import エラーで build 失敗

**Stage 1への申し送り**:
- 削除ではなく「PC 版での参照解除のみ」とすべき、または「モバイル経路を `MemoPane` + 個別タブに分解する」必要がある
- 同様の課題が `LeftPaneTabSwitcher` には無いことを確認済み（PC 専用ファイル）

---

### H11: モバイル `GlobalMobileNav` は現状維持で済む

**判定**: ❌ **Rejected**

**事実**:
- `GlobalMobileNav` (4 タブ Home/Sessions/Review/More) 自体は変わらないが、Worktree 詳細画面のモバイル経路 `WorktreeDetailSubComponents.tsx` は `LeftPaneTab='memo'` 値および `NotesAndLogsPane` に依存している
- 「モバイル現状維持」と「NotesAndLogsPane 削除」を両立させるには、モバイル用に旧ファイル/旧型を残すか、モバイル経路も同時改修する必要がある

**Stage 1への申し送り**:
- 削除リストから `NotesAndLogsPane.tsx` を外す、または「モバイル経路の改修」をスコープに追加する旨を明記すべき
- `LeftPaneTab` 型と `useWorktreeTabState` の `toLeftPaneTab()` マッピングも同様に対応必須

---

### H12: 既存テストは限定的な変更で済む

**判定**: Partially Confirmed

**影響する既存テスト**:
- `tests/unit/components/worktree/LeftPaneTabSwitcher.test.tsx` (削除予定)
- `tests/unit/components/worktree/NotesAndLogsPane.test.tsx` (削除可否は H10 次第)
- `tests/unit/components/HistoryPane.test.tsx` (HistoryPane に `onCollapse` props 追加 → 既存テストへの影響)
- `tests/unit/components/WorktreeDesktopLayout.test.tsx` (2col→4col 構造変更 → 大幅修正)

**Stage 1への申し送り**:
- 受入条件にテスト更新/削除リストを明示するか、`/work-plan` フェーズで反映する想定を明示すべき

---

### H13: `LayoutState` に `activityBar` / `historyPane` セクション追加で吸収可能

**判定**: Confirmed（ただし `leftPaneTab` 残存方針が要設計）

**根拠コード**:
- `src/types/ui-state.ts:82-97`
  ```ts
  export interface LayoutState {
    mode: 'split' | 'tabs';
    mobileActivePane: MobileActivePane;
    leftPaneTab: LeftPaneTab;
    splitRatio: number;
    leftPaneCollapsed: boolean;
  }
  ```
- 拡張は型上可能。ただし以下方針が不明:
  - `leftPaneTab` フィールドは PC 用途で廃止／モバイル用途で残すのか？
  - `leftPaneCollapsed` の意味は PC 改修で何になるのか？

---

### H14: localStorage 永続化キー衝突

**判定**: Confirmed（衝突なし）

**既存キー**:
- `commandmate.worktree.leftPaneCollapsed` (#688)
- `commandmate:historyDisplayLimit` (#701)
- `commandmate:historyUserOnly` (#725)
- `commandmate.draft.*` (Issue #485 系)

**新規予定キー**:
- `commandmate:activeActivity` ※プレフィックス記法が既存 (`commandmate:` vs `commandmate.worktree.`) で混在 → 一貫性に注意

**Stage 1への申し送り**:
- 既存命名は `commandmate.worktree.<feature>` と `commandmate:<feature>` が混在。新規キーの命名規約を統一すべき

---

### H15: Issue #688 leftPaneCollapsed パターンが流用可能

**判定**: Confirmed

**事実**:
- `src/components/worktree/WorktreeDesktopLayout.tsx` に既にパターン実装あり
- 新規 History ペイン折りたたみは同パターンで実装可能

**留意**:
- 旧 `leftPaneCollapsed` ステートは、新レイアウトで「History/ActivityPane どちらの折りたたみ状態」を指すのか不明確
- 過去設定の localStorage 値の取扱い（マイグレーション / 初期化）が未定

---

### H16: `jest-axe` 等によるアクセシビリティ検証が可能

**判定**: ❌ **Rejected**

**事実**:
- `package.json` に `jest-axe` パッケージなし
- Vitest 用の jest-axe-vitest 派生も導入なし

**Stage 1への申し送り**:
- Issue 本文「アクセシビリティ: jest-axe 等で `role` / `aria-*` 検証」は実装方針として未準備
- 代替: 手書きの `getByRole('tablist')` / `getByRole('tab', { selected: true })` / `aria-label` 検証で代替する旨を明示すべき

---

## Stage 1 への重要申し送り事項（優先度順）

### Must Address（受入条件に直結する矛盾）

1. **H10/H11**: `NotesAndLogsPane.tsx` の削除はモバイル経路を壊す。Issue を以下のいずれかに修正:
   - (A) 「削除」→「PC 版経路から参照を除去するのみ」に変更
   - (B) モバイル経路も改修する旨をスコープに追加（モバイル用 Activity 風 UI 化など）

2. **H3**: 現状の History 内 `Message | Git` サブタブ（`historySubTab` ローカル state、`HistorySubTab` 型）の扱いを明示
   - Git が Activity に昇格 → History の中身は Message 一択になる → `historySubTab` state は廃止 or モバイル/deep-link 限定で残すか

3. **deep-link 影響**: `useWorktreeTabState.toLeftPaneTab()` 関数と `?pane=git|notes|logs|agent|timer` のマッピングを再設計する必要がある（影響範囲レビューの観点でも重要）

### Should Address（実装方針の明確化）

4. **H16**: `jest-axe` 未導入 → アクセシビリティ検証手段を「手書き role/aria 検証」と明記
5. **H14**: localStorage キー命名規約（`commandmate:` vs `commandmate.worktree.`）の統一
6. **H13/H15**: 既存 `leftPaneTab` / `leftPaneCollapsed` の意味の再定義（マイグレーション含む）

### Nice to Have（命名整理）

7. **H5**: "Schedules" Activity の i18n/aria-label 命名と既存 "logs"/"schedule" 系の整合
8. **H1**: "CMATE タブ" の内部 ID が `memo` である歴史的経緯を Issue 本文補足

---

## 結論

Issue #727 は機能追加 Issue として概ね妥当な内容だが、**H10/H11 のモバイル経路矛盾は build エラーを引き起こす致命的な事実誤認**であり、Stage 1 通常レビューで Must Fix として確実に指摘されるべき。

また H3 の「History 内 Git サブタブ廃止」は影響範囲レビュー（Stage 3）で deep-link 互換性に直結するため、両ステージで取り上げる必要がある。

# Bug Fix Progress Report - Issue #710

## 1. 概要

| 項目 | 内容 |
|------|------|
| **Issue** | [#710](https://github.com/Kewton/CommandMate/issues/710) |
| **タイトル** | perf(sidebar): useWorktreesCache のポーリング間隔を active/idle 遷移時に動的切替 |
| **Bug ID** | `20260515_211253` |
| **ブランチ** | `feature/710-worktree` |
| **重要度** | high（全ユーザー恒常影響・性能/運用リスク） |
| **ステータス** | accepted（PR作成準備完了） |
| **対応日** | 2026-05-15 |

### 修正サマリ

`useWorktreesCache` フックの adaptive polling が初回マウント時の `setInterval` 間隔に固定され、`worktrees` の active/idle 遷移を検知して再計算されない問題を、`currentIntervalRef` パターンで解決。`worktrees` 変化を契機に desired interval を再評価し、現在の interval と異なる場合のみ `startPolling()` を再実行する。`document.hidden` 時および初期化前 (`currentIntervalRef.current === null`) は no-op で、既存の `visibilitychange` ハンドラとの責務分離を維持。

---

## 2. 根本原因（Phase 1 調査結果）

### カテゴリ
コードバグ — 適応的ポーリングの状態遷移ロジック欠落 (`logic_bug / stale-closure-by-design`)

### 一次原因
`src/hooks/useWorktreesCache.ts` L90-132 の adaptive polling `useEffect` の依存配列が `[refresh]` のみであり、`refresh` は `useCallback([])` で安定参照のため、**マウント時にしか実行されない**。`startPolling()` 内で `const interval = hasActiveSession() ? ACTIVE : IDLE` と評価された値が `setInterval(refresh, interval)` にベイクされ、その後の `worktrees` 状態遷移では再評価されない。

### 二次原因
L134-137 の `worktrees` 同期 `useEffect` は `worktreesRef.current = worktrees` を行うのみで、`startPolling` を呼び出す責務がない。`hasActiveSession()` は ref 経由で最新値を読めるが、すでに `setInterval` クロージャに固定された interval 値は変えられない。

### ユーザ影響
- **active → idle 永続化**: セッション 1 回起動でサイドバーが永続 5s ポーリングとなり、停止後もサーバ負荷・電池消費・帯域が下がらない
- **idle → active 遅延**: idle 起動時はセッション開始後も 30 秒間反応遅延
- 影響範囲: `WorktreesCacheProvider` / `sessions/page.tsx` / `WorktreeSelectionContext` 経由の全画面（PC/モバイル）

---

## 3. 実装内容（Phase 4 TDD修正）

### アプローチ
**Action A: `currentIntervalRef` パターン**（Issue 提案案）

### コード変更箇所

| ファイル | 変更内容 |
|---------|---------|
| `src/hooks/useWorktreesCache.ts` | `currentIntervalRef` 追加、`startPolling`/`stopPolling`/`hasActiveSession` を `useCallback` でフック直下へリフトアップ、`worktrees` 同期 useEffect に動的切替ロジックを追加 |
| `tests/unit/useWorktreesCache.test.ts` | 新規 4 テストケース追加（idle→active, active→idle, no-op, hidden時） |

### 主要な実装ポイント

1. **`currentIntervalRef`（L63）**
   `useRef<number | null>(null)` を追加し `null = 停止中` のセマンティクスを明示
2. **`stopPolling`（L111-117）**
   `intervalRef` と `currentIntervalRef` の両方をリセット
3. **`startPolling`（L125-134）**
   既存タイマーを `stopPolling` 経由でクリア → desired interval を `currentIntervalRef.current` に保存 → `setInterval` 生成
4. **adaptive-polling useEffect（L137-159）**
   初期起動と `visibilitychange` を専有。`worktrees` に依存しないため頻繁な再構築なし
5. **`worktrees`-change useEffect（L164-182）**
   `worktreesRef` 同期 +「`document.hidden=false` AND `currentIntervalRef.current !== null` AND `desired !== current`」の3段ガードで no-op 判定

### 設計判断

- **責務分離**: adaptive-polling useEffect が初期起動 / visibility を所有、worktrees-change useEffect は state 変化時の interval 再評価のみを担う
- **二重起動防止**: `currentIntervalRef.current === null` ガードにより、初期化前および停止中は `startPolling()` を呼ばない
- **SSR セーフ**: L168 で `typeof document !== 'undefined'` チェック
- **代替案（Action 2: 派生プリミティブ依存）を非採用**: 「同じ間隔なら no-op」を厳密に満たすには `currentIntervalRef` ガードの方が安全と判断

---

## 4. テスト結果

### 新規追加テスト（4件・全 PASS）

| テスト名 | 検証内容 |
|---------|---------|
| `should switch from idle to active interval when a session starts` | idle→active 遷移時に 5s 間隔に切り替わる |
| `should switch from active to idle interval when all sessions stop` | active→idle 遷移時に 30s 間隔に切り替わる |
| `should not restart interval when active state does not change` | identity 変化のみでは setInterval 再起動しない（no-op） |
| `should not restart polling when tab is hidden` | `document.hidden=true` 中は再起動しない |

### TDD サイクル
- **Red phase 確認**: 上記 4 件のうち遷移系 2 件が初期実装前に失敗することを確認 (`expected 2 to be greater than 2`, `expected 3 to be 2`)
- **Green phase 確認**: 実装後に 4 件すべて PASS

### テストスイート全体

| 項目 | 結果 |
|------|------|
| `useWorktreesCache.test.ts` 単体 | **15/15 PASS**（既存 11 + 新規 4） |
| 全体ユニットテスト | **6495 passed / 7 skipped / 0 failed** |
| ベースライン | 6491 passed |
| 差分 | **+4 (新規のみ、回帰 0 件)** |
| 実行時間 | 13.87s |

### カバレッジ（`src/hooks/useWorktreesCache.ts`）

| 指標 | 値 | 目標 |
|------|----|------|
| Statements | **95.45%** | 80% |
| Branches | **87.5%** | 80% |
| Functions | **100%** | 80% |
| Lines | **95.31%** | 80% |

未カバー行: L142-143 (cleanup 内 clearTimeout)、L169 (SSR guard) — いずれも環境依存の防御コード

---

## 5. 受入条件チェックリスト

| # | 受入条件 | 結果 | エビデンス |
|---|---------|------|----------|
| 1 | worktrees の active/idle 状態変化を検知し、間隔が変わるべきタイミングで `startPolling` を再実行 | PASS | L164-182 の useEffect + 新規テスト 2 件 |
| 2 | active 状態でアプリ起動 → セッション停止 → 30秒間隔に移行 | PASS | `should switch from active to idle interval...` (ACTIVE 5s 経過でも fetch されず、IDLE 30s で fetch) |
| 3 | idle 状態でアプリ起動 → セッション開始 → 5秒間隔に移行 | PASS | `should switch from idle to active interval...` (IDLE 30s 後 active 受信 → 以降 ACTIVE 5s で fetch) |
| 4 | 不要な `setInterval` 再起動が発生しない（同じ間隔なら no-op） | PASS | L179 `if (currentIntervalRef.current !== desired)` ガード + テスト |
| 5 | visibility hidden → visible の挙動が壊れない | PASS | L168 `if (document.hidden) return` + テスト、既存 `handleVisibilityChange` 維持 |
| 6 | `npm run test:unit` 回帰 0 件 | PASS | 6495 passed (baseline 6491 + 新規 4 で一致) |

**合計: 6/6 PASS**

---

## 6. 品質ゲート

| ゲート | コマンド | 結果 |
|-------|---------|------|
| ESLint | `npm run lint` | **PASS**（errors: 0, warnings: 0）|
| TypeScript | `npx tsc --noEmit` | **PASS**（exit 0, no output）|
| Unit Test (target) | `NODE_ENV=test npx vitest run tests/unit/useWorktreesCache.test.ts` | **PASS**（15/15, 789ms）|
| Unit Test (full) | `npm run test:unit` | **PASS**（343 files / 6495 tests, 13.87s, regression 0）|

---

## 7. 影響範囲

### 修正対象ファイル（2件）

- `src/hooks/useWorktreesCache.ts` — 主要修正
- `tests/unit/useWorktreesCache.test.ts` — 新規テスト 4 件追加

### 波及するコンポーネント（読み取り側、変更不要）

- `src/components/providers/WorktreesCacheProvider.tsx`
- `src/contexts/WorktreeSelectionContext.tsx`
- `src/app/sessions/page.tsx`
- Sidebar（worktree 一覧）/ Sessions / Review / Home などフックを経由する全画面

### リグレッションリスク評価
- **低**: 修正は `useWorktreesCache` 内で完結、コンシューマ側 API 変更なし
- 既存テスト 6491 件すべて回帰なし、`SessionsPage.test.tsx` (18/18) も PASS

---

## 8. 次のアクション

1. **PR 作成**: `feature/710-worktree` → `develop`（または `main`）に向けて PR を作成
   - 推奨タイトル: `perf(sidebar): switch useWorktreesCache polling interval on active/idle transition (#710)`
   - 必須ラベル: `bug` / `performance`
2. **コードレビュー**: `useWorktreesCache.ts` の責務分離（adaptive-polling useEffect と worktrees-change useEffect の役割境界）について確認
3. **本番監視**:
   - active → idle 遷移後 30 秒間隔への移行確認（DevTools Network タブ）
   - idle → active 遷移時の 5 秒間隔への切替確認
   - visibility hidden/visible トグル時にポーリングが破綻しないことの確認
4. **追加検証（任意）**: `npm run test:e2e` でサイドバー操作系の E2E が壊れていないかをスポットチェック

---

*Generated by progress-report-agent at 2026-05-15*

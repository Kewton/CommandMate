# Bug Fix 進捗レポート - Issue #709

## 1. 概要

| 項目 | 内容 |
|------|------|
| Issue 番号 | [#709](https://github.com/Kewton/CommandMate/issues/709) |
| Issue タイトル | perf(sidebar): useWorktreesCache の二重インスタンス化を解消（Provider 経由に統一） |
| Bug ID | `709-20260515_211219` |
| ブランチ | `feature/709-worktree` |
| 重要度 | high |
| ステータス | 合格（受入テスト T1〜T8 全 PASS / Issue 受入条件 9 件全達成） |
| 作業ディレクトリ | `/Users/maenokota/share/work/github_kewton/commandmate-issue-709` |

---

## 2. 不具合の概要と根本原因

### 2.1 不具合の概要

`src/hooks/useWorktreesCache.ts` は名前こそ「cache」だが実体は **React Context を使わないカスタムフック** で、内部に `useState` / `useRef` / `setInterval` を保有している。そのため複数コンポーネントで呼び出されると、その都度独立したインスタンスとポーリングタイマーが生成される。

現状アプリ内で `useWorktreesCache()` を実際に呼び出していたのは以下の 2 箇所:

1. `src/components/providers/WorktreesCacheProvider.tsx` L32（正規・想定通り）
2. `src/app/sessions/page.tsx` L110（Provider と独立に直接呼び出していた）

この結果、Sessions ページ表示中は `/api/worktrees` への HTTP ポーリングが **2 系統並走** し、サーバ側の `scanMultipleRepositories`（N×M ステータス検出）が二重に走っていた。

### 2.2 根本原因

| 観点 | 内容 |
|------|------|
| 直接原因 | `useWorktreesCache` が Context API ではなく単なるフックとして実装されており、複数呼び出しがそれぞれ独立した状態とポーリングタイマーを持つ |
| 構造的原因 | 「Cache」という命名から共有インスタンスを連想させるが、実装は共有機構を持たない |
| 検出機構の欠如 | 二重呼び出しを警告する仕組みが無く、re-introduction が容易 |

### 2.3 影響範囲

| スコープ | 影響 |
|---------|------|
| ユーザー影響 | サイドバー表示遅延、ネットワーク帯域・サーバ負荷の倍増 |
| サーバ影響 | `/api/worktrees` の N×M ステータス検出処理が 2 倍の頻度で発生 |
| 影響ユーザー | Sessions ページ表示中の全ユーザー |

---

## 3. 採択した対策案

**対策案 1: WorktreesCacheProvider に Context を導入し Sessions ページから消費**

### 3.1 設計方針

- `useWorktreesCache` の戻り値（`worktrees` / `repositories` / `isLoading` / `error` / `refresh`）を `React.createContext<UseWorktreesCacheReturn | null>(null)` で公開する **`WorktreesCacheContext`** を新設
- `WorktreesCacheProvider` が単一の `useWorktreesCache()` インスタンスを保持し、`useMemo` でラップした context value を配信
- Sessions ページは `useContext` を `useWorktreesCacheContext()` フック経由で取得（Provider 外呼び出し時は明示的に throw）
- `useWorktreesCache` フック自体の実装は **一切変更しない**（テスト/単体利用の互換性維持）
- 既存の `WorktreeSelectionProvider` への `externalWorktrees` / `externalRepositories` 伝播は維持

### 3.2 採用理由

- Issue の実装方針案に完全準拠
- React 標準パターン（Provider + useContext）で実装コストが低い
- Sessions ページ以外（Repositories / Review / More 等）でも将来同じ Context から取得可能
- `useWorktreesCache` フック実装は変更不要のため副作用が最小

### 3.3 不採用案

- **対策案 2（重複呼び出し検知の警告追加）**: StrictMode の double-invoke で誤検知のリスクがあり、また再発防止策であって根本解決ではないため不採用

---

## 4. TDD サイクル

Red → Green → Refactor を 2 サイクル実施。

### 4.1 サイクル 1: Provider Context 実装

| Step | 内容 | 検証 |
|------|------|------|
| **Red 1** | `tests/unit/components/providers/WorktreesCacheProvider.test.tsx` 新規作成。5 失敗テスト（cached fields 公開 / loading 伝播 / error 伝播 / refresh forward / Provider 外呼び出し時 throw） | `5 failed (useWorktreesCacheContext is not a function)` |
| **Green 1** | `WorktreesCacheProvider.tsx` に `createContext<UseWorktreesCacheReturn \| null>(null)` と `useMemo` ラップ context value、`useWorktreesCacheContext()` フックを実装。Provider 外呼び出し時は明示的 Error throw | `5 passed` |

### 4.2 サイクル 2: Sessions ページ移行

| Step | 内容 | 検証 |
|------|------|------|
| **Red 2** | `tests/unit/SessionsPage.test.tsx` のモック対象を `@/hooks/useWorktreesCache` から `@/components/providers/WorktreesCacheProvider`（`useWorktreesCacheContext`）に置換。`mockRepositories` を追加し `beforeEach` でリセット。既存 18 ケース維持 | `15 failed / 3 passed`（実装側未対応のため fall back で fetch → loading で停止） |
| **Green 2** | `src/app/sessions/page.tsx` の `import { useWorktreesCache } from '@/hooks/useWorktreesCache'` を `import { useWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider'` に変更。呼び出しも `useWorktreesCacheContext()` に切替 | `23 passed`（18 Sessions + 5 Provider） |

### 4.3 Refactor

- `WorktreesCacheProvider` ヘッダー、`useWorktreesCacheContext` JSDoc、Sessions ページヘッダーに Issue #709 の rationale コメントを追記
- Context value を `useMemo` でラップして参照安定性を確保
- `src/hooks/useWorktreesCache.ts` は制約通り無改修

| 検証コマンド | 結果 |
|-------------|------|
| `npm run lint` | 0 errors |
| `npx tsc --noEmit` | 0 errors |
| `npm run test:unit` | 344 ファイル / 6496 PASS / 7 skipped / 0 failed |

---

## 5. 変更ファイル一覧

| ファイル | 種別 | 変更概要 |
|---------|------|---------|
| `src/components/providers/WorktreesCacheProvider.tsx` | 修正 | `createContext` + `useMemo` + `useWorktreesCacheContext()` を追加。`WorktreeSelectionProvider` への `externalWorktrees` / `externalRepositories` 伝播は維持。ヘッダー JSDoc に Issue #709 rationale 追記 |
| `src/app/sessions/page.tsx` | 修正 | `useWorktreesCache` 直接呼び出しを `useWorktreesCacheContext` 呼び出しに置換。ヘッダー JSDoc に Issue #709 説明追記。レンダーツリー / フィルタ / ソート / sanitize 変更なし |
| `tests/unit/SessionsPage.test.tsx` | 修正 | モック対象を `@/hooks/useWorktreesCache` → `@/components/providers/WorktreesCacheProvider`（`useWorktreesCacheContext`）に変更。`mockRepositories` フィールド追加・`beforeEach` リセット追加。既存 18 アサーションは intact |
| `tests/unit/components/providers/WorktreesCacheProvider.test.tsx` | **新規** | Context の契約を担保する 5 テスト：cached fields 公開 / loading 伝播 / error 伝播 / refresh forward / Provider 外呼び出し時 throw。`WorktreeSelectionProvider` をモック化して Context 契約に集中 |

**git status による現在の差分:**

```
modified:   src/app/sessions/page.tsx
modified:   src/components/providers/WorktreesCacheProvider.tsx
modified:   tests/unit/SessionsPage.test.tsx
Untracked:  tests/unit/components/providers/WorktreesCacheProvider.test.tsx
```

`src/hooks/useWorktreesCache.ts` は **不変**（制約遵守を `git diff` スコープで確認済み）。

---

## 6. 検証結果

### 6.1 総合品質メトリクス

| 項目 | 結果 | 詳細 |
|------|------|------|
| **ESLint** | PASS | 0 warnings / 0 errors |
| **TypeScript (`tsc --noEmit`)** | PASS | 0 errors |
| **Unit Test** | PASS | 344 ファイル / 6503 中 **6496 PASS** / 7 skipped / **0 failed** / Duration 13.73s |
| **新規 Provider テスト** | PASS | 5/5 PASS（Duration 433ms） |
| **Sessions ページ既存テスト** | PASS | 18/18 PASS（Duration 470ms） |

### 6.2 カバレッジ

| ファイル | Statements | Branches | Functions | Lines | 備考 |
|---------|-----------|----------|-----------|-------|------|
| `WorktreesCacheProvider.tsx` | **100%** | 100% | 100% | 100% | 新規追加 Context API 部分は完全カバー |
| `sessions/page.tsx` | 69.56% | 53.01% | 88.88% | 70.76% | 未カバー行 (76, 96-97, 149-170) は本 fix 以前から存在するレンダリング分岐であり、修正範囲外 |

**目標カバレッジ 80%**: 新規コードについては 100% 達成 ✅

### 6.3 受入テスト（T1〜T8）

| ID | テスト名 | 結果 | エビデンス |
|----|---------|------|----------|
| T1 | Sessions ページの直接呼び出し廃止確認 | ✅ pass | `grep "useWorktreesCache" src/app/sessions/page.tsx` → 実呼び出し消滅、`useWorktreesCacheContext()` のみ |
| T2 | 他箇所での二重呼び出し確認 | ✅ pass | `grep -rn 'useWorktreesCache(' src/` → 実呼び出しは `WorktreesCacheProvider.tsx:52` 1 箇所のみ |
| T3 | Provider Context テスト（新規） | ✅ pass | 5/5 PASS |
| T4 | Sessions ページテスト回帰確認 | ✅ pass | 18/18 PASS |
| T5 | Lint 検査 | ✅ pass | 0 warnings / 0 errors |
| T6 | 型検査 | ✅ pass | tsc clean |
| T7 | Unit Test 全件実行 | ✅ pass | 6496/6503 PASS / 0 failed |
| T8 | Provider 階層維持確認 | ✅ pass | `WorktreeSelectionProvider` への `externalWorktrees` / `externalRepositories` 伝播維持 |

### 6.4 回帰チェック

| 領域 | 結果 |
|------|------|
| Sessions 画面（フィルタ・ソート・XSS sanitize・loading/error/empty state） | 回帰なし（18/18 PASS） |
| Sidebar の Worktree 表示（WorktreeSelectionContext 経由） | 回帰なし（伝播経路維持） |
| リポジトリ visible/enabled フィルタ（Issue #690） | 回帰なし（`externalRepositories` 伝播経路維持） |

---

## 7. Issue 受入条件チェックリスト

| # | 受入条件 | 達成 | エビデンス |
|---|---------|:----:|----------|
| 1 | Sessions ページで `useWorktreesCache()` の直接呼び出しが廃止されている（Provider 経由 Context から取得） | ✅ | `src/app/sessions/page.tsx` は `useWorktreesCacheContext()` のみを呼び出し（T1） |
| 2 | プロジェクト全体で `useWorktreesCache` の二重呼び出し箇所が存在しない（Provider のみ呼び出す） | ✅ | 実呼び出しは `WorktreesCacheProvider.tsx` L52 の 1 箇所のみ（T2） |
| 3 | `useWorktreesCacheContext()` を Provider 外で呼ぶと適切なエラーが投げられる | ✅ | `'useWorktreesCacheContext must be used within a WorktreesCacheProvider'` を throw（T3） |
| 4 | Sessions 画面の既存機能（フィルタ・ソート・XSS sanitize・loading/error/empty state）に回帰がない | ✅ | SessionsPage.test.tsx 18 件全 PASS（T4） |
| 5 | 新規テスト `tests/unit/components/providers/WorktreesCacheProvider.test.tsx` が全件 PASS | ✅ | 5 件全 PASS（T3） |
| 6 | 既存テスト `tests/unit/SessionsPage.test.tsx` が全件 PASS | ✅ | 18 件全 PASS（T4） |
| 7 | `npm run test:unit` 全件 PASS、回帰 0 件 | ✅ | 344 ファイル / 6496 PASS / 0 failed（T7） |
| 8 | `npm run lint` クリーン | ✅ | 0 warnings / 0 errors（T5） |
| 9 | `npx tsc --noEmit` クリーン | ✅ | 型エラー 0 件（T6） |

**達成率: 9/9 (100%)**

### 制約遵守

| 制約 | 遵守 | 根拠 |
|------|:----:|------|
| `useWorktreesCache` フック自体の実装は変更しない | ✅ | `git diff` スコープで `src/hooks/useWorktreesCache.ts` 不変を確認 |
| 既存の Sessions ページ振る舞いに回帰を発生させない | ✅ | 既存 18 テスト全 PASS |
| `WorktreeSelectionProvider` への `externalWorktrees` / `externalRepositories` 伝播維持 | ✅ | T8 構造確認済 |

---

## 8. ブロッカー・残課題

### 8.1 ブロッカー

**なし**。受入テスト・品質ゲート（lint/tsc/test）全合格、Issue 受入条件 9 件全達成。

### 8.2 残課題・推奨事項

| 項目 | 内容 |
|------|------|
| 実機検証 | Chrome DevTools Network パネルで `/api/worktrees` が単一インスタンス化されることの確認は本受入テストの範疇外。構造的には `useWorktreesCache` 実呼び出しが 1 箇所に限定されており、setInterval ポーリングが 1 系統に統一されていることがコード上保証されているが、develop マージ後に実機検証推奨 |
| 将来の検討課題 | `useWorktreesCache` の export を Provider 専用 internal API として JSDoc に明示するかは将来の検討事項。今後 Sessions ページ以外のページ（Repositories / Review / More 等）で worktrees キャッシュを参照する場合は必ず `useWorktreesCacheContext()` を使うこと |

---

## 9. 次のアクション

### 9.1 PR 作成手順

1. **コミット作成**

   ```bash
   git add src/components/providers/WorktreesCacheProvider.tsx \
           src/app/sessions/page.tsx \
           tests/unit/SessionsPage.test.tsx \
           tests/unit/components/providers/WorktreesCacheProvider.test.tsx
   ```

   コミットメッセージ案:

   ```
   perf(sidebar): expose useWorktreesCache via Context to dedupe polling (#709)

   - Add WorktreesCacheContext / useWorktreesCacheContext in WorktreesCacheProvider
   - Switch sessions page from direct useWorktreesCache() to useWorktreesCacheContext()
   - Add 5 unit tests covering context contract (cached fields / loading / error / refresh / out-of-provider throw)
   - Migrate SessionsPage mock target from useWorktreesCache to useWorktreesCacheContext

   Eliminates duplicate /api/worktrees polling caused by two independent useWorktreesCache
   instances. Direct call site is now limited to WorktreesCacheProvider only.

   Refs: #709
   ```

2. **PR 作成（feature/709-worktree → develop）**

   ```bash
   gh pr create --base develop --title "perf(sidebar): useWorktreesCache の二重インスタンス化を解消（Provider 経由に統一） (#709)" --body "..."
   ```

   PR 本文に含めるべき内容:
   - Summary: 二重ポーリング解消の背景と Context 化方針
   - Test plan: lint / tsc / test:unit の結果、新規 5 テスト・既存 18 テスト PASS
   - 実機検証 TODO: Chrome DevTools Network パネルで `/api/worktrees` ポーリング 1 系統化を確認

3. **ラベル付与**: `bug`, `performance`, `refactor`

### 9.2 マージ後アクション

| アクション | 内容 |
|-----------|------|
| 実機検証 | develop マージ後、ブラウザ DevTools Network パネルで Sessions ページ表示時の `/api/worktrees` ポーリング回数を実測（修正前: 2 系統 → 修正後: 1 系統） |
| ドキュメント反映 | 必要に応じて [モジュールリファレンス](../../../docs/module-reference.md) の `WorktreesCacheProvider` 項目に Issue #709 注記追加 |
| フォローアップ Issue（任意） | `useWorktreesCache` の export を internal API としてマーキングするか、もしくは hooks ディレクトリから providers ディレクトリへ移設するかの方針決定 |

---

## 10. 参考リンク

- Issue: https://github.com/Kewton/CommandMate/issues/709
- 調査結果: `dev-reports/bug-fix/709-20260515_211219/investigation-result.json`
- TDD 修正結果: `dev-reports/bug-fix/709-20260515_211219/tdd-fix-result.json`
- 受入テスト結果: `dev-reports/bug-fix/709-20260515_211219/acceptance-result.json`
- 作業計画コンテキスト: `dev-reports/bug-fix/709-20260515_211219/work-plan-context.json`

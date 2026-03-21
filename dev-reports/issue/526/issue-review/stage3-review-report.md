# Issue #526 影響範囲レビューレポート

**レビュー日**: 2026-03-20
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: server.ts の excludedPaths 削除処理が影響範囲から漏れている

**カテゴリ**: 影響ファイル
**場所**: server.ts:225-232

**問題**:
Issue本文の影響範囲テーブルに `server.ts` が含まれていない。`server.ts` の初期化処理(L225-232)では、除外リポジトリのworktreeを `deleteWorktreesByIds()` で直接削除しており、`syncWorktreesToDB()` を経由していない。この箇所でもtmuxセッションのクリーンアップが欠落している。

**証拠**:
```typescript
// server.ts:225-232
for (const excludedPath of excludedPaths) {
  const resolvedPath = resolveRepositoryPath(excludedPath);
  const worktreeIds = getWorktreeIdsByRepository(db, resolvedPath);
  if (worktreeIds.length > 0) {
    const result = deleteWorktreesByIds(db, worktreeIds);
    // tmuxセッションクリーンアップの呼び出しなし
  }
}
```

**推奨対応**:
影響範囲テーブルに server.ts を追加し、修正方針でもこの箇所への対応を明記すること。`syncWorktreesToDB()` 経由ではないため、修正方針(A)/(B)いずれを選んでもこの箇所は別途対応が必要。

---

### MF-2: syncWorktreesToDB() シグネチャ変更の全呼び出し元への影響が未整理

**カテゴリ**: 破壊的変更
**場所**: 修正方針 セクション

**問題**:
修正方針(A)を選択した場合は `void` から `Promise<void>` に、方針(B)を選択した場合は `void` から `string[]` にシグネチャが変わる。いずれの方針でも **5箇所すべての呼び出し元** で修正が必要だが、Issue に具体的な修正一覧がない。

**証拠**:
全呼び出し元（すべて async コンテキスト内）:

| 呼び出し元 | 行 | 方針(A)の修正 | 方針(B)の修正 |
|-----------|-----|-------------|-------------|
| sync/route.ts | L48 | await 追加 | deletedIds 受取 + クリーンアップ呼出 |
| scan/route.ts | L53 | await 追加 | 同上 |
| restore/route.ts | L61 | await 追加 | 同上 |
| clone-manager.ts | L534 | await 追加 | 同上 |
| server.ts | L239 | await 追加 | 同上 |

**推奨対応**:
各方針について、全呼び出し元での具体的修正内容を一覧化して Issue に追記すること。

---

## Should Fix（推奨対応）

### SF-1: worktrees.ts モジュールの責務越境リスク

**カテゴリ**: 依存関係
**場所**: 修正方針 セクション

**問題**:
方針(A)を採用する場合、`worktrees.ts`（Git + DB操作モジュール）が `session-cleanup.ts` と `tmux.ts` に新たに依存することになり、モジュールの責務が越境する。現在の import は `child_process`, `path`, `@/lib/db`, `@/lib/env`, `@/lib/logger` のみ。

**推奨対応**:
方針(B)（削除対象IDを戻り値で返し、呼び出し元でクリーンアップ）は責務分離の観点で優位であることを Issue に追記する。方針(A)を採用する場合は、`killSessionFn` を引数で注入する設計を検討する。

---

### SF-2: テスト方針の具体性不足

**カテゴリ**: テスト範囲
**場所**: テスト方針 セクション

**問題**:
以下のテスト課題が未言及:
1. `server.ts` の初期化時 excludedPaths 削除のテスト方法（モジュールレベル処理で直接テスト困難）
2. `clone-manager.ts` の `onCloneSuccess()` は private メソッドでテストアプローチが未記載
3. 方針(B)の場合、各 API ルートで個別にクリーンアップが呼ばれることを検証するテストが必要

**推奨対応**:
テスト方針に以下を追加:
- server.ts の初期化処理は共通関数を抽出してテスト可能化を検討
- clone-manager.ts は `executeClone()` 経由のインテグレーションテストで検証
- 方針(B)の場合は各 API ルートの個別テストケースを明記

---

### SF-3: 大量削除時のパフォーマンス影響

**カテゴリ**: 破壊的変更
**場所**: 受け入れ基準 / 修正方針 セクション

**問題**:
発見経緯の47件worktreeケースで、tmuxクリーンアップが逐次処理される場合の最悪ケース:
- 47 worktrees x 5 CLI tools x 5秒(tmux DEFAULT_TIMEOUT) = **約1175秒（約20分）**
- sync APIは日常的に呼ばれるため、DELETE APIよりもパフォーマンス影響が大きい

**証拠**:
- `tmux.ts:15` の `DEFAULT_TIMEOUT = 5000ms`
- `CLI_TOOL_IDS` = 5種類（claude, codex, gemini, vibe-local, opencode）
- `cleanupMultipleWorktrees()` は逐次処理（`session-cleanup.ts:160-161` の for ループ）

**推奨対応**:
大量削除時の対策を検討:
1. `hasSession()` で存在確認を先に行い、存在するセッションのみ kill する
2. `killSession()` の並列実行（`Promise.all`）を検討
3. sync API のレスポンスタイム要件を明記

---

## Nice to Have（あれば良い）

### NTH-1: killSessionFn の供給方法の設計

**カテゴリ**: 依存関係
**場所**: 修正方針 セクション

方針(A)を採用する場合、`cleanupWorktreeSessions()` が依存性注入パターンで `killSessionFn` を受け取る設計になっている。`syncWorktreesToDB()` にもオプショナルパラメータとして `killSessionFn` を追加する設計が、テスト時のモック注入を容易にする。

---

### NTH-2: JSDoc への変更記録

**カテゴリ**: 移行考慮
**場所**: 修正方針 セクション

`syncWorktreesToDB()` のシグネチャ変更時に、JSDoc に変更理由（Issue #526）と戻り値の意味を記録しておくことで、将来の保守性が向上する。

---

## 影響範囲マップ

### 直接影響ファイル（修正必須）

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `src/lib/git/worktrees.ts` | modify | syncWorktreesToDB() のシグネチャ変更 + クリーンアップロジック |
| `src/app/api/repositories/sync/route.ts` | modify | 呼び出し元修正 |
| `src/app/api/repositories/scan/route.ts` | modify | 呼び出し元修正 |
| `src/app/api/repositories/restore/route.ts` | modify | 呼び出し元修正 |
| `src/lib/git/clone-manager.ts` | modify | onCloneSuccess() 内の呼び出し修正 |
| `server.ts` | modify | syncWorktreesToDB() 呼び出し修正 + excludedPaths 削除のクリーンアップ追加 |

### 間接影響ファイル（変更不要だが参照される）

| ファイル | 関連 |
|---------|------|
| `src/lib/session-cleanup.ts` | cleanupMultipleWorktrees() を利用 |
| `src/lib/tmux/tmux.ts` | killSession() を利用 |
| `src/lib/cli-tools/manager.ts` | CLIToolManager を利用（killSessionFn 構築） |

### テストファイル（更新必須）

| ファイル | 内容 |
|---------|------|
| `src/lib/__tests__/worktrees-sync.test.ts` | tmuxクリーンアップのモックテスト追加 |

## 並行処理リスク

| シナリオ | 重大度 | 緩和策 |
|---------|--------|--------|
| 複数API同時呼び出しによるsyncWorktreesToDB()の並行実行 | 低 | killSession()は冪等。SQLite単一ライターモデルでDB操作は直列化。 |
| DB削除後〜tmux kill前のUI操作 | 低 | DB上でworktreeが消えるためUIには表示されない。tmuxは直後にkillされる。 |

---

## 参照ファイル

### コード
- `src/lib/git/worktrees.ts:265-308`: 修正対象 syncWorktreesToDB()
- `server.ts:225-232, 239`: Issue未記載の影響箇所
- `src/lib/session-cleanup.ts:71-174`: 既存クリーンアップインフラ
- `src/lib/tmux/tmux.ts:15, 372-387`: killSession() とタイムアウト定数
- `src/app/api/repositories/route.ts:30-44`: 正しい実装の参考パターン
- `src/lib/cli-tools/types.ts:10`: CLI_TOOL_IDS 定義

### ドキュメント
- `CLAUDE.md`: モジュール依存関係の確認

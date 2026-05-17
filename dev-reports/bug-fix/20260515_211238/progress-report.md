# Issue #711 修正報告書

## 概要
`scanMultipleRepositories` の逐次スキャン (`for ... await`) を `Promise.allSettled` で並列化し、`POST /api/repositories/sync` の体感遅延を改善。

- **Issue**: [#711 perf(sync): scanMultipleRepositories の git worktree list を並列実行](https://github.com/Kewton/CommandMate/issues/711)
- **ブランチ**: `feature/711-worktree`

## 根本原因
`src/lib/git/worktrees.ts:239-257` で `for (const repoPath of repositoryPaths) { await scanWorktrees(...) }` の逐次ループになっており、リポジトリ数 N に比例して合計時間が増えていた。リポジトリ間は独立で並列化可能。

## 修正内容

### `src/lib/git/worktrees.ts`
- `for ... await` → `Promise.allSettled(repositoryPaths.map(...))` に変更
- 個別失敗時はログ出力のみ行い、全体は成功させる挙動を維持
- ログには `repoPath` を付与（並列実行で順序が不定になるため、後追いで紐付け可能にする）

### `tests/unit/worktrees.test.ts`
- `vi.mock('child_process')` を auto-mock から factory mock へ変更。
  これは vitest の auto-mock が `child_process.exec` から `util.promisify.custom` シンボルを引き継いでしまい、`promisify(exec)` がモックではなく実装をバイパスして呼び出すための回避策。
- `scanMultipleRepositories` の単体テスト4件を追加：
  - 各リポジトリで `git worktree list` が1回ずつ呼ばれる
  - 1件失敗時も他のリポジトリの結果は返る
  - 空配列で `[]` を返す
  - **並列実行の検証**: deferred-callback パターンで、最初の `await setImmediate` 後に全リポジトリの exec が起動していることを確認（逐次なら1件のみ）

## 検証結果

| 項目 | 結果 |
|------|------|
| `npx tsc --noEmit` | エラー 0 |
| `npm run lint` | エラー 0 |
| `npm run test:unit` | baseline 6491 → 6495 passed（+4 新規テスト、0 リグレッション） |

## 期待される効果
Issue 記載の試算では:
- Before: 12 リポジトリ × 50〜100ms ≒ 600〜1200ms
- After: 最遅 1 件分 ≒ 100〜200ms

実機ベンチは PR 後にコメントで報告予定。

## 留意点
- 現状の規模（数十リポジトリ）では FD 上限の懸念はないため chunk 化は未実施。
- `scanWorktrees` 内 `execAsync` のタイムアウト追加は別 Issue 推奨（Issue 本文の留意点に記載済み）。

## 受入条件チェック
- [x] `scanMultipleRepositories` を `Promise.allSettled` で並列化
- [x] 個別リポジトリで失敗しても全体は失敗させない（既存挙動維持）
- [x] ログ出力に `repoPath` を付与
- [x] `npm run test:unit` 回帰 0 件
- [x] 単体テストが並列化後も通る（4件新規追加）
- [ ] 同期所要時間のベンチ計測（PR 後実機で実施）

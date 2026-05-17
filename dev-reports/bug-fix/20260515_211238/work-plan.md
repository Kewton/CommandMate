# Issue #711 作業計画

## 目的
`scanMultipleRepositories` の逐次スキャンを `Promise.allSettled` で並列化し、`POST /api/repositories/sync` の体感遅延を改善する。

## 変更ファイル
- `src/lib/git/worktrees.ts` (本体修正)
- `tests/unit/worktrees.test.ts` (`scanMultipleRepositories` の並列化を検証するテストを追加)

## 実装内容
1. `scanMultipleRepositories` を `Promise.allSettled(repositoryPaths.map(...))` で書き換え
2. 個別失敗時の挙動を維持（rejected の場合は logger.error を出し、全体は失敗させない）
3. `repoPath` を保持したログ出力（並列実行で順序が不定になるため）

## 受入条件
- [x] `scanMultipleRepositories` を `Promise.allSettled` で並列化
- [x] 個別リポジトリで失敗しても全体は失敗させない（既存挙動維持）
- [x] ログ出力に `repoPath` を付与
- [x] `npm run test:unit` 回帰 0 件
- [x] 並列化の動作を確認する単体テストを追加

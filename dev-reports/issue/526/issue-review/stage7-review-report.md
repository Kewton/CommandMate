# Issue #526 レビューレポート（Stage 7）

**レビュー日**: 2026-03-20
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目
**ステージ**: Stage 7（最終影響範囲レビュー）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 3 |

## 前回指摘（Stage 3）の対応状況確認

Stage 3の影響範囲レビューで指摘した全5件の対応状況を確認した。すべて適切に反映されている。

| 指摘ID | カテゴリ | ステータス |
|--------|---------|-----------|
| MF-1 | 影響ファイル（server.ts excludedPaths未記載） | 解決済み |
| MF-2 | 破壊的変更（全呼び出し元の修正内容未記載） | 解決済み |
| SF-1 | 依存関係（方針(B)の責務分離優位性未記載） | 解決済み |
| SF-2 | テスト範囲（server.ts/clone-manager.tsテスト不足） | 解決済み |
| SF-3 | パフォーマンス（大量削除時の影響分析欠如） | 解決済み |

### 対応内容の詳細

**MF-1**: 影響範囲テーブルにserver.ts excludedPaths削除処理を追加。呼び出し元ごとの修正内容テーブルにも専用行を追加し、syncWorktreesToDB()経由ではない旨の注意書きも明記。受け入れ基準にも対応項目を追加。

**MF-2**: 6箇所すべての呼び出し元について、方針(A)/(B)それぞれの具体的修正内容を一覧テーブルとして記載。全呼び出し元がasyncコンテキスト内にある旨も明記。

**SF-1**: 設計ノートとして方針(B)が責務分離の観点で推奨である旨を追記。worktrees.tsの現在のimport一覧と依存の変化も詳述。

**SF-2**: テスト方針を7項目に拡充。server.ts初期化処理の共通関数抽出（項目5）、clone-manager.tsのexecuteClone()経由テスト（項目6）、方針(B)時の呼び出し元テスト（項目7）を追加。

**SF-3**: 大量削除時のパフォーマンス影響分析セクションを追加。最悪ケース試算と3つの対策方針を記載。受け入れ基準にもパフォーマンス対策の具体的要件を追加。

---

## 新規レビュー結果

### 呼び出し元一覧の完全性

Issueに記載された6箇所の呼び出し元をコードベースで検証した。

| 呼び出し元 | 行番号 | コード確認 |
|-----------|--------|-----------|
| sync/route.ts | L48 | `syncWorktreesToDB(db, allWorktrees)` -- 一致 |
| scan/route.ts | L53 | `syncWorktreesToDB(db, worktrees)` -- 一致 |
| restore/route.ts | L61 | `syncWorktreesToDB(db, worktrees)` -- 一致 |
| clone-manager.ts | L534 | `syncWorktreesToDB(this.db, worktrees)` -- 一致 |
| server.ts | L239 | `syncWorktreesToDB(db, worktrees)` -- 一致 |
| server.ts (excludedPaths) | L225-232 | `deleteWorktreesByIds(db, worktreeIds)` -- 一致 |

**結果**: 6箇所すべてが正確。追加の呼び出し箇所は発見されなかった。一覧は完全である。

### パフォーマンス影響分析の妥当性

最悪ケース試算（47 worktrees * 5 CLI tools * 5秒 = 約20分）は逐次処理かつ全タイムアウトの場合の理論値であり、保守的な見積もりとして妥当。

ただし、既存の`killWorktreeSession()`パターン（repositories/route.ts:30-44）では`isRunning()`チェックが組み込まれており、セッションが存在しない場合は即座に`false`を返す。47件のworktree削除ケースでも大半はセッション未起動のため、実際の処理時間は理論最悪値よりも大幅に短い。

### 方針(B)推奨時の各呼び出し元での修正実行可能性

全呼び出し元がasyncコンテキスト内にあることをコードベースで確認した。

| 呼び出し元 | async確認 | 修正実行可能性 |
|-----------|----------|--------------|
| sync/route.ts | `async function POST()` | 可能 |
| scan/route.ts | `async function POST()` | 可能 |
| restore/route.ts | `async function PUT()` | 可能 |
| clone-manager.ts | `private async onCloneSuccess()` | 可能 |
| server.ts:239 | async IIFE内 | 可能 |
| server.ts:225-232 | async IIFE内 | 可能 |

方針(B)の修正パターン（戻り値を受け取り `cleanupMultipleWorktrees()` を呼び出す）は、既存のDELETE /api/repositoriesの実装パターンと同一であり、全箇所で技術的に実行可能。

### エラーハンドリング方針の波及効果

「セッションkill失敗時にsync処理自体は成功すること」という方針は、既存の`cleanupWorktreeSessions()`のtry-catchパターン（session-cleanup.ts:89-99）と完全に一致。既存のエラーハンドリングインフラをそのまま活用でき、新規のパターン導入は不要。波及効果は最小限。

---

## Nice to Have（あれば良い）

### NTH-1: hasSession先行確認は既存パターンで実現済みである旨の補足

**カテゴリ**: 影響ファイル
**場所**: 大量削除時のパフォーマンス考慮 セクション 項目1

**問題**:
パフォーマンス対策の「セッション存在確認を先行」について、既存の`killWorktreeSession()`パターン（repositories/route.ts:30-44）では既に`isRunning()`チェックが組み込まれている。このパターンを踏襲すれば追加実装不要で自然に実現される。Issueでは「新規に実装すべき対策」のように読めるが、既存パターンの踏襲で解決される点を補足するとより正確になる。

**推奨対応**:
「既存のkillWorktreeSession()パターンではisRunning()チェックが組み込まれており、このパターンを踏襲することで自然に実現される」旨を補足する。

---

### NTH-2: テスト方針の項目4と項目7の関係性明確化

**カテゴリ**: テスト範囲
**場所**: テスト方針 セクション 項目4, 7

**問題**:
項目4「呼び出し元テスト」と項目7「方針(B)採用時の呼び出し元テスト」の関係が曖昧。方針(B)採用時は項目4が項目7で代替されるのか、両方必要なのかが不明確。

**推奨対応**:
項目4は方針(A)時、項目7は方針(B)時のテスト観点である旨を明確化する。ただし実装担当者が方針決定後にテスト計画を具体化する想定であれば、現状でも支障はない。

---

### NTH-3: killWorktreeSession()関数の共通化可能性

**カテゴリ**: 影響ファイル
**場所**: 呼び出し元ごとの具体的修正内容 テーブル

**問題**:
方針(B)採用時、sync/route.ts, scan/route.ts, restore/route.ts, server.tsの4箇所で`killWorktreeSession()`関数が必要になる。現在この関数はrepositories/route.tsにローカル定義されており、共通化の検討が自然に発生する。影響ファイルの変更内容にこの共通化の可能性が言及されていない。

**推奨対応**:
方針(B)の修正内容に、killWorktreeSession()を複数箇所で利用するための共通化（例: session-cleanup.tsへの移動、または新規ユーティリティファイルの作成）を検討事項として追記する。

---

## 総合評価

**品質**: 高い
**実装準備状態**: 実装着手可能

Stage 1-6で累計7件のMust Fix / Should Fix指摘を行い、すべて適切に反映されている。更新後のIssue内容に対して新たな影響範囲の問題（Must Fix / Should Fix相当）は発見されなかった。

Issue本文は以下を包括的にカバーしている:
- 問題の原因と影響範囲（全6箇所の呼び出し元を網羅）
- 修正方針（3選択肢のトレードオフ、推奨方針の明示、呼び出し元ごとの具体的修正内容）
- パフォーマンス影響分析（最悪ケース試算と対策方針）
- 受け入れ基準（9項目）
- テスト方針（7項目）
- エラーハンドリング方針

残存する3件のNice to Have指摘はいずれも実装時に自然に解決される軽微な補足情報であり、実装着手を妨げるものではない。

---

## 参照ファイル

### コード
- `src/lib/git/worktrees.ts` (L265-308): 修正対象 syncWorktreesToDB()
- `src/app/api/repositories/route.ts` (L30-44): 既存killWorktreeSession()パターン（共通化候補）
- `src/lib/session-cleanup.ts` (L71-174): cleanupWorktreeSessions() / cleanupMultipleWorktrees()
- `src/app/api/repositories/sync/route.ts` (L48): 呼び出し元
- `src/app/api/repositories/scan/route.ts` (L53): 呼び出し元
- `src/app/api/repositories/restore/route.ts` (L61): 呼び出し元
- `src/lib/git/clone-manager.ts` (L513-549): 呼び出し元
- `server.ts` (L225-232, L239): 呼び出し元（2箇所）

### ドキュメント
- `CLAUDE.md`: モジュール依存関係の整合性確認

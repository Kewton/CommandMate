# Issue #409 レビューレポート - Stage 7

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7/8

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 1 |

**総合判定**: Issue #409 の影響範囲は正確に特定されており、前回指摘事項（R3-001 -- R3-010）は全て適切に対処されている。Stage 5-6 の修正による新たな影響範囲の発生もない。実装着手可能な品質に達している。

---

## 前回指摘事項（Stage 3）の対処確認

### Must Fix（2件） -- 全て対処済み

#### R3-001: session-cleanup.ts の stopAllSchedules() グローバル呼び出し問題

**対処状況**: 対処済み

Issue本文に「依存関係・並行開発リスク」セクションが新設され、以下が明記されている:
- `session-cleanup.ts:111` の `stopAllSchedules()` がグローバル操作であること
- `manager.schedules.clear()` と `manager.initialized = false` により全 worktree に影響すること
- cmateFileCache 追加により影響が拡大すること
- Issue #407 で worktree 単位の停止・エントリ削除関数に置換予定であること（R5-001 反映済みで関数名は断定していない）

**コード検証**: `session-cleanup.ts:111` は現在も `stopAllSchedules()` を呼び出しており、Issue #407 での修正が前提である点はIssue本文の記載と一致している。

#### R3-002: マイグレーション version 21 の連番競合リスク

**対処状況**: 対処済み

実装タスクに注意事項として「実装着手前に他ブランチの version 21 使用を確認すること」が追記されている。現時点のopen Issues（#406, #407, #408, #410, #411）を確認したところ、いずれもDBマイグレーションを含まないため version 21 の競合リスクは低い。

---

### Should Fix（6件） -- 全て対処済み

| ID | 指摘内容 | 対処状況 |
|----|---------|---------|
| R3-003 | Issue #406 との相互依存 | 推奨マージ順序（#409先行）と理由が明記済み |
| R3-004 | Issue #407 との並行開発リスク | ManagerState変更の競合リスクとキャッシュクリーンアップ推奨が記載済み |
| R3-005 | db-migrations.test.ts が影響範囲テーブルに未記載 | 影響範囲テーブルと実装タスクに追加済み |
| R3-006 | schedule-manager.test.ts のテストケース不足 | 3テストケース（ヒット/ミス/削除時）が明記済み |
| R3-007 | fs.statSync() の ENOENT エラー処理 | 提案する解決策と実装タスクに詳細な処理方針が記載済み |
| R3-008 | globalThis キャッシュと Hot Reload の挙動 | 備考セクションに既存パターンとの同一性が確認済みとして記載 |

---

### Nice to Have（2件） -- スキップ判断は正当

| ID | 指摘内容 | 判断 |
|----|---------|------|
| R3-009 | CLAUDE.md のモジュール説明更新 | 実装完了後に更新するためスキップ -- 正当 |
| R3-010 | API受益ファイルの影響範囲テーブル記載 | 必須ではないためスキップ -- 正当 |

---

## Stage 5-6 修正の影響範囲分析

### R5-001 反映（stopScheduleForWorktree() 表現変更）

具体的な関数名 `stopScheduleForWorktree()` を「worktree 単位の停止・エントリ削除関数」に抽象化。Issue #409 の影響範囲には変化なし。Issue #407 との齟齬を解消する表現修正に留まる。

### R5-002 反映（バルクSELECT実装手順の詳細化）

以下の手順が明記された:
1. `SELECT id, name FROM scheduled_executions WHERE worktree_id = ?` を1回実行
2. `Map<name, id>` を構築
3. `db.transaction()` 内で Map ルックアップにより UPDATE/INSERT を判定

**新規クエリのインデックス検証**:
- バルクSELECTの `WHERE worktree_id = ?` は `UNIQUE(worktree_id, name)` 制約（`db-migrations.ts:829`）による暗黙インデックスの左プレフィックスで効率的に実行される
- 追加インデックスは不要
- 影響範囲テーブルに新たなファイル追加は不要

---

## 新規影響範囲の探索結果

### 1. scheduled_executions テーブルへの全クエリの影響確認

コードベース内の `scheduled_executions` テーブルに対する全クエリを検証した:

| 場所 | クエリ | 新規インデックス恩恵 |
|------|-------|-------------------|
| `schedule-manager.ts:152` | `WHERE worktree_id = ? AND name = ?` | なし（UNIQUE制約インデックス使用） |
| `schedule-manager.ts:276` | `WHERE worktree_id IN (...) AND enabled = 1` | **あり**（新規複合インデックス使用） |
| `schedule-manager.ts:281` | `WHERE id = ?` | なし（PRIMARY KEY使用） |
| `schedule-manager.ts:228` | `WHERE id = ?` | なし（PRIMARY KEY使用） |
| `schedules/route.ts:42` | `WHERE worktree_id = ? AND enabled = 1` | **あり**（新規複合インデックス使用） |
| `[scheduleId]/route.ts:44,81,133,137,169` | `WHERE id = ? AND worktree_id = ?` | なし（PRIMARY KEY使用） |

Issue本文の影響範囲テーブルに記載されている受益クエリ（`disableStaleSchedules()` と API `GET /schedules`）と一致している。見落とされたクエリはない。

### 2. cleanupMultipleWorktrees() のカスケード影響

`src/app/api/repositories/route.ts:92` から `cleanupMultipleWorktrees()` が呼ばれ、内部で `cleanupWorktreeSessions()` -> `stopAllSchedules()` が実行される。複数 worktree 削除時に1回目の呼び出しで cmateFileCache が全消去される動作は、Issue #407 の依存関係セクションで既に文書化されている。新たな影響範囲の発見ではない。

### 3. server.ts の graceful shutdown

`server.ts:281` の `stopAllSchedules()` は cmateFileCache を含む ManagerState をリセットするが、プロセスシャットダウン時であるためメモリリークの懸念はない。影響なし。

### 4. [scheduleId]/route.ts の確認

`src/app/api/worktrees/[id]/schedules/[scheduleId]/route.ts` は全て PRIMARY KEY による検索であり、`(worktree_id, enabled)` 複合インデックスの恩恵は受けない。コード変更不要であり、影響範囲テーブルに含まれていないのは正しい。

---

## Nice to Have（1件）

### R7-001: db.transaction() のエラーハンドリング動作変更

**カテゴリ**: 影響範囲
**場所**: 提案する解決策 > 2. スケジュール同期の差分ベース化

**問題**:
`db.transaction()` で upsertSchedule ループをラップすると、動作が変わる。現在は個別エントリ単位で独立した DB 操作だが、トランザクション化後は worktree 単位のアトミック操作になる。1エントリの upsert が失敗した場合、現状では他のエントリは正常に処理されるが、トランザクション化後は worktree 全体がロールバックされる。

**実用上の影響**:
`upsertSchedule()` が失敗するのは DB コネクションエラーなどの稀なケースのみであり、そのようなエラーは `syncSchedules()` 内の既存の try-catch（`schedule-manager.ts:425-427`）で捕捉される。実用上の問題は極めて小さい。

**推奨対応**:
Issue本文の備考または提案する解決策に、トランザクション化によりアトミック更新になる旨を1文追記するとよいが、現在の記述でも実装に支障はない。

---

## 影響範囲テーブルの妥当性評価

Issue本文の影響範囲テーブル:

| ファイル | 変更内容 | 妥当性 |
|---------|---------|--------|
| `src/lib/db-migrations.ts` | マイグレーション version 21 追加 | 正確 |
| `src/lib/schedule-manager.ts` | ManagerState/syncSchedules()/バッチ化 | 正確 |
| `tests/unit/lib/schedule-manager.test.ts` | mtimeキャッシュテスト追加 | 正確 |
| `tests/unit/lib/db-migrations.test.ts` | CURRENT_SCHEMA_VERSION アサーション更新 | 正確 |

**見落とされたファイル**: なし。上記4ファイルで変更範囲が網羅されている。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/src/lib/schedule-manager.ts`: 主要変更対象（ManagerState, syncSchedules(), upsertSchedule()）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/src/lib/db-migrations.ts`: CURRENT_SCHEMA_VERSION = 20、version 21 マイグレーション追加対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/src/lib/session-cleanup.ts`: L111 stopAllSchedules() 呼び出し（Issue #407 修正予定）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/tests/unit/lib/db-migrations.test.ts`: L37 CURRENT_SCHEMA_VERSION アサーション
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/tests/unit/lib/schedule-manager.test.ts`: L77 globalThis リセット
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/src/app/api/worktrees/[id]/schedules/route.ts`: L42 受益クエリ（コード変更不要）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/src/app/api/worktrees/[id]/schedules/[scheduleId]/route.ts`: PRIMARY KEY 検索のみ（影響なし）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/CLAUDE.md`: L171 session-cleanup.ts 説明に stopScheduleForWorktree() 記載あり（実装未存在、スコープ外）

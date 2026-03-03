# Issue #409 Stage 1 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（整合性・正確性・完全性・明確性）
**ステージ**: 1回目
**仮説検証**: 実施済み（hypothesis-verification.md参照）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 4 |
| Should Fix | 5 |
| Nice to Have | 2 |
| **合計** | **11** |

Issueの主要な問題（スケジュールマネージャのポーリング非効率性）は正確に特定されているが、S6（DBインデックス不足）セクションの記述に複数の事実誤認がある。仮説検証の結果、chat_messagesのインデックス不足は存在せず、scheduled_executionsの暗黙インデックスの存在も見落とされている。クエリ数の見積もりも過小である。

---

## Must Fix（必須対応）

### R1-001: chat_messages(cli_tool_id) のインデックス不足記述は誤り

**カテゴリ**: 正確性
**場所**: 背景・課題 S6 - chat_messages(cli_tool_id) の記述

**問題**:
「chat_messages(cli_tool_id) の複合インデックスが不足（cli_tool_id単独でのフィルタリング時）」という記述は誤り。以下の事実と矛盾する。

1. 既に `idx_messages_cli_tool(worktree_id, cli_tool_id, timestamp DESC)` が存在する（`src/lib/db.ts` L98-101）
2. コードベース内に `cli_tool_id` 単独でフィルタリングするクエリは存在しない
3. 全ての `cli_tool_id` クエリは `worktree_id` を先頭条件に含む（`src/lib/db.ts` L592, L706, L913）

**証拠**:
```typescript
// src/lib/db.ts L98-101
CREATE INDEX IF NOT EXISTS idx_messages_cli_tool
ON chat_messages(worktree_id, cli_tool_id, timestamp DESC);
```

**推奨対応**:
S6セクションから chat_messages(cli_tool_id) に関する記述を完全に削除する。

---

### R1-002: scheduled_executions(worktree_id, name) のインデックス記述が不正確

**カテゴリ**: 正確性
**場所**: 背景・課題 S6 - scheduled_executions(worktree_id, name) の記述

**問題**:
「scheduled_executions(worktree_id, name) にインデックスがなく」は不正確。`UNIQUE(worktree_id, name)` 制約（`src/lib/db-migrations.ts` L829）によりSQLiteが暗黙的に複合インデックスを自動生成する。`upsertSchedule()` の `WHERE worktree_id = ? AND name = ?` はこのインデックスで効率的に動作する。

実際に最適化が不足しているのは `disableStaleSchedules()` の `WHERE worktree_id IN (...) AND enabled = 1` クエリ（`src/lib/schedule-manager.ts` L276）で、現在の `idx_scheduled_executions_enabled(enabled)` 単独インデックスでは `worktree_id` との複合フィルタリングが最適化されない。

**証拠**:
```sql
-- db-migrations.ts L829: 暗黙インデックスを生成
UNIQUE(worktree_id, name)

-- db-migrations.ts L835-837: worktree_id単独のインデックス
CREATE INDEX idx_scheduled_executions_worktree ON scheduled_executions(worktree_id);

-- db-migrations.ts L842-843: enabled単独のインデックス（複合ではない）
CREATE INDEX idx_scheduled_executions_enabled ON scheduled_executions(enabled);
```

**推奨対応**:
記述を「UNIQUE制約による暗黙インデックスが存在するが、`disableStaleSchedules()` の `WHERE worktree_id IN (...) AND enabled = 1` クエリおよびAPIの `WHERE worktree_id = ? AND enabled = 1` クエリに対して `(worktree_id, enabled)` の複合インデックスが不足」と修正する。

---

### R1-003: クエリ数の見積もりが過小

**カテゴリ**: 正確性
**場所**: 背景・課題 P3 - クエリ数の見積もり

**問題**:
「100 worktree x 5 schedule = 500クエリ/60秒」は過小見積もり。`upsertSchedule()` は1エントリあたり最低2クエリ（SELECT + UPDATE/INSERT）を発行する。

- 既存レコードの場合: `SELECT id`（L151-153）+ `UPDATE`（L156-160）
- 新規レコードの場合: `SELECT id`（L151-153）+ `INSERT`（L165-168）

実際は 100 x 5 x 2 = **1000クエリ以上**/60秒。さらに `disableStaleSchedules()` のSELECT + 個別UPDATEも加算。

**証拠**:
```typescript
// src/lib/schedule-manager.ts L143-170
function upsertSchedule(worktreeId, entry) {
  // クエリ1: SELECT
  const existing = db.prepare(
    'SELECT id FROM scheduled_executions WHERE worktree_id = ? AND name = ?'
  ).get(worktreeId, entry.name);

  if (existing) {
    // クエリ2a: UPDATE
    db.prepare('UPDATE scheduled_executions SET ...').run(...);
  } else {
    // クエリ2b: INSERT
    db.prepare('INSERT INTO scheduled_executions ...').run(...);
  }
}
```

**推奨対応**:
「100 worktree x 5 schedule x 2 (SELECT + UPDATE/INSERT) = 1000+クエリ/60秒」に修正する。

---

### R1-004: SELECT * FROM worktrees の引用が不正確

**カテゴリ**: 正確性
**場所**: 背景・課題 P3 - SQLクエリの引用

**問題**:
「`SELECT * FROM worktrees`を実行」とあるが、実際のクエリは `SELECT id, path FROM worktrees`（`src/lib/schedule-manager.ts` L127）。全カラムではなく2カラムのみの取得。LIMIT/フィルタなしという問題の本質は正しいが、クエリ文の引用が誤り。

**証拠**:
```typescript
// src/lib/schedule-manager.ts L127
return db.prepare('SELECT id, path FROM worktrees').all() as WorktreeRow[];
```

**推奨対応**:
「`SELECT id, path FROM worktrees` を実行（LIMIT/フィルタなし）」に修正する。

---

## Should Fix（推奨対応）

### R1-005: インデックス追加提案の修正

**カテゴリ**: 完全性
**場所**: 提案する解決策 1. インデックス追加

**問題**:
`scheduled_executions(worktree_id, name)` の複合インデックス追加は冗重（UNIQUE制約から暗黙存在）。chat_messagesのインデックス追加も不要。代わりに `(worktree_id, enabled)` 複合インデックスが `disableStaleSchedules()` とAPIエンドポイント（`src/app/api/worktrees/[id]/schedules/route.ts` L42）の両方で有効。

**推奨対応**:
インデックス追加の提案を以下に修正:
1. `scheduled_executions(worktree_id, enabled)` 複合インデックス追加
2. `chat_messages` 関連のインデックス追加は不要と明記
3. 既存の `idx_scheduled_executions_enabled`（enabled単独）の廃止を検討

---

### R1-006: mtimeキャッシュの無効化戦略が不明確

**カテゴリ**: 完全性
**場所**: 提案する解決策 2. スケジュール同期の差分ベース化

**問題**:
mtimeキャッシュの実装方針は述べられているが、キャッシュの無効化戦略が明記されていない。初回同期時の挙動、サーバー再起動時のキャッシュ初期化、CMATE.md削除時のキャッシュエントリ除去方針が不足。

**推奨対応**:
以下を明記する:
1. キャッシュは`globalThis`（既存の`ManagerState`を拡張）に保持し、サーバー再起動時は自動クリア
2. 初回`syncSchedules()`はキャッシュ未構築のため全worktree処理
3. `fs.statSync().mtimeMs` でmtime取得（`readFileSync`前にチェック）
4. CMATE.md削除時（`readCmateFile()` が null を返す場合）のキャッシュエントリ除去方針

---

### R1-007: バッチupsertの具体化

**カテゴリ**: 完全性
**場所**: 実装タスク - バッチupsertへのリファクタリング

**問題**:
「バッチupsertへのリファクタリング（必要に応じて）」が曖昧。better-sqlite3の`transaction()`を使った一括処理が可能な点への言及がない。

**推奨対応**:
タスクを具体化:
「`syncSchedules()` 内のupsertScheduleループを `db.transaction()` で囲み、1 worktreeあたりの複数スケジュールをトランザクション単位で処理。バルクSELECTで既存レコードをMapに取得した後、トランザクション内でUPDATE/INSERTを実行する形式に変更。」

---

### R1-008: 受入条件「DBクエリが発生しない」が不正確

**カテゴリ**: 明確性
**場所**: 受入条件

**問題**:
「CMATE.md未変更時にDBクエリが発生しないこと」は不正確。`getAllWorktrees()` はworktree一覧取得のため差分ベースでも毎回必要（worktree削除検出のため）。正しくは「upsertSchedule()のDBクエリが発生しない」。また、検証方法が不明確。

**推奨対応**:
「CMATE.md未変更時に `upsertSchedule()` のDBクエリ（`scheduled_executions` テーブルへのSELECT/UPDATE/INSERT）が発生しないこと。検証方法: ユニットテストでDB操作をモック/スパイし、mtime未変更時にupsert関連クエリが呼ばれないことを確認。」

---

### R1-009: 影響範囲にテストファイルとマイグレーションバージョンが不足

**カテゴリ**: 完全性
**場所**: 影響範囲テーブル

**問題**:
影響範囲にDBマイグレーションと`schedule-manager.ts`のみ記載。テストファイルやマイグレーションの具体的なバージョン番号が不足。

**推奨対応**:
影響範囲に以下を追加:

| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/lib/schedule-manager.test.ts` | mtimeキャッシュのテスト追加 |
| `src/lib/db-migrations.ts` | version 21 追加（インデックスマイグレーション） |
| `src/app/api/worktrees/[id]/schedules/route.ts` | (worktree_id, enabled) インデックスの恩恵を受ける（変更不要） |

現在の `CURRENT_SCHEMA_VERSION` は 20（`src/lib/db-migrations.ts` L14）のため、次のバージョンは 21。

---

## Nice to Have（あれば良い）

### R1-010: Issue分割の検討

**カテゴリ**: 完全性
**場所**: Issue全体

**問題**:
S6（DBインデックス修正）とP3（ポーリング効率化）は異なる性質の問題。S6は実質的に軽微（chat_messages修正不要、scheduled_executionsも小規模）であるのに対し、P3は中規模の実装を伴う。

**推奨対応**:
必須ではないが、分離するとレビュー・実装・テストがしやすい。現行のまま1 Issueで進めても問題はない。

---

### R1-011: mtime vs ハッシュの方針明記

**カテゴリ**: 完全性
**場所**: 提案する解決策 2

**問題**:
「mtime/ハッシュをキャッシュ」とあるが、どちらを使うか未決定。

**推奨対応**:
推奨はmtime（`fs.statSync().mtimeMs`）。CMATE.mdは通常数KB以下の小さなファイルのため、mtimeチェックのオーバーヘッドは極小。ハッシュ計算はファイル全体の読み取りが必要なためmtimeキャッシュの利点を損なう。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/schedule-manager.ts` | 主要変更対象。syncSchedules() L363-442、getAllWorktrees() L124-132、upsertSchedule() L143-170 |
| `src/lib/db-migrations.ts` | version 17 L793-894 でテーブル・インデックス定義。新規マイグレーション追加対象 |
| `src/lib/db.ts` | chat_messages インデックス定義 L98-101 |
| `src/lib/cmate-parser.ts` | readCmateFile() L311-329、parseSchedulesSection() L200-302 |
| `src/app/api/worktrees/[id]/schedules/route.ts` | WHERE worktree_id = ? AND enabled = 1 クエリ L42 |
| `tests/unit/lib/schedule-manager.test.ts` | 既存テスト。mtimeキャッシュテスト追加が必要 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | schedule-manager.ts、cmate-parser.ts のモジュール説明 |

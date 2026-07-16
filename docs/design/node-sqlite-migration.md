# better-sqlite3 → node:sqlite 移行調査レポート

- **Issue**: #1201（親: #1193 Phase 3）
- **種別**: 調査スパイク（本番コード変更なし）
- **調査日**: 2026-07-15
- **調査環境**: macOS (darwin/arm64, Apple M3 Ultra), Node **v24.1.0**, better-sqlite3 **12.6.2**（`package.json`: `^12.4.1`）
- **検証スクリプト**: `scripts/spike/`（再実行可能）
- **ベース commit**: `fdb6d54b`

---

## 0. 結論（TL;DR）

### 判定: **No-Go（現時点では時期尚早）** — 条件付きで将来 Go

**技術的には移行できる。** v01〜v41 の全マイグレーションが `node:sqlite` 上で完走し、スキーマは完全一致、DB ファイルは双方向で読み書きでき、性能は総合で同等（むしろ僅かに速い）。API ギャップも実装済みアダプタ約 130 行で埋まることを実証した。

**しかし移行すべきではない。** 理由は 1 点に尽きる:

> **`node:sqlite` は、現在サポートされている全 LTS（Node 22 / 24）で experimental のままであり、
> 利用者の実行時に毎回 `ExperimentalWarning` が出る。**

Release candidate 化（Stability 1.2、警告除去）は **v25.7.0 でのみ**行われ、**LTS へバックポートされていない**。
そして v25 は既に EOL（2026-06-01）。RC 版が載る最初の LTS は **Node 26（LTS 化: 2026-10-28）** である。

つまり今移行すると、**利用者の大多数（Node 22 / 24 LTS）が experimental の DB ドライバを踏む**。
本件の元動機は「IT に詳しくない利用者のインストール失敗を減らす」ことなので、
その層に「experimental」警告を見せるのは**動機と逆行する**。

### 再評価の条件（トリガ）

以下のいずれかを満たした時点で本調査を再実行し、Go に切り替える:

1. `node:sqlite` が **Stability 2 (Stable)** になる、**かつ** それが Active LTS に載る
2. または RC (1.2) が **Node 24 LTS 系にバックポート**される（＝警告が消える）
3. 現実的な最短ライン: **2026-10-28（Node 26 の LTS 化）以降**に再評価

### 元動機（インストール失敗の削減）は、移行を待たずに別手段で改善できる

§9 に代替案を示す。特に **`engines: >=20.0.0` は既に陳腐化している（Node 20 は 2026-04-30 に EOL 済み）** ため、
この修正は node:sqlite の是非と無関係に、今すぐ実施すべき。

---

## 1. experimental ステータスの評価（最重要）

### 1-1. 実測（このマシン / Node v24.1.0）

```
$ node -e "require('node:sqlite')"
(node:72914) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

API は完全に動作するが、**警告が出る**。`scripts/spike/01-api-surface.mjs` で再現可能。

### 1-2. 一次情報（Node.js 公式ドキュメント / PR）

[Node.js SQLite ドキュメント](https://nodejs.org/api/sqlite.html) の Stability index と version history:

| Node バージョン | 変更内容 |
|---|---|
| v22.5.0 | 追加（`--experimental-sqlite` フラグ必須の experimental） |
| v23.4.0, v22.13.0 | フラグ不要になる。ただし **still experimental** |
| **v25.7.0** | **Release candidate 化（Stability 1.2）。ExperimentalWarning 除去** |

現在の Stability index: **`Stability: 1.2 - Release candidate`**（Node v26 ドキュメント時点）。
**Stable (Stability 2) には到達していない。**

RC 化の PR: [nodejs/node#61262 "sqlite: mark as release candidate"](https://github.com/nodejs/node/pull/61262)（v25.7.0 / 2026-02-24 リリース）。
**この PR に LTS へのバックポート形跡はない。** 実測（v24.1.0 で警告が出る）とも整合する。

### 1-3. Node リリーススケジュールとの突き合わせ

[nodejs/Release schedule.json](https://github.com/nodejs/Release/blob/main/schedule.json) より:

| Version | Start | LTS 化 | Maintenance | End | 2026-07-15 時点の状態 |
|---|---|---|---|---|---|
| v20 | 2023-04-18 | 2023-10-24 | 2024-10-22 | **2026-04-30** | **EOL 済み** |
| v22 | 2024-04-24 | 2024-10-29 | 2025-10-21 | 2027-04-30 | LTS(maintenance) |
| v24 | 2025-05-06 | 2025-10-28 | 2026-10-20 | 2028-04-30 | **Active LTS** |
| v25 | 2025-10-15 | — | 2026-04-01 | **2026-06-01** | **EOL 済み** |
| v26 | 2026-05-05 | **2026-10-28** | 2027-10-20 | 2029-04-30 | Current（LTS 前） |

**この表が本レポートの結論を決めている:**

- RC（警告なし）が入っているのは **v25.7.0+ と v26** のみ
- **v25 は既に EOL**（2026-06-01）→ 選択肢にならない
- **v26 はまだ LTS ではない**（2026-10-28 に LTS 化）
- ⇒ **今日サポートされている LTS（22 / 24）は全て「警告が出る experimental」**

### 1-4. 警告の抑止方法と、それが根本解決でない理由

Node 21.3+ の `--disable-warning` で**外科的に**抑止できる（実測済み）:

```bash
$ node --disable-warning=ExperimentalWarning -e "require('node:sqlite'); console.log('loaded, no warning')"
loaded, no warning
```

他の警告は残る（実測: `DeprecationWarning` は表示され続けた）ため、`--no-warnings`（全抑止）より遥かにマシ。
CommandMate は `bin/commandmate.js` で node 起動を制御しているため、技術的には適用可能。

**しかしこれは根本解決ではない:**

1. **警告を消しても experimental である事実は変わらない。** 「いつ変わってもおかしくない」と Node 公式が明言している API に、
   利用者の全データ（worktree・チャット履歴・スケジュール）を載せることになる。警告の抑止は*症状*の除去であって*リスク*の除去ではない
2. **`ExperimentalWarning` を一律で握り潰す。** SQLite 以外の experimental 機能を将来使ったとき、その警告も見えなくなる。
   本来気付くべきシグナルを自ら塞ぐ
3. **利用者が CommandMate 経由以外で触ると警告が出る。** 開発者が `npm run dev` や vitest を直接叩く経路では抑止が効かない

⇒ **抑止できることは No-Go の判定を覆さない。**

---

## 2. API 対応表

### 2-1. 使用実態の実測（Issue 記述の訂正を含む）

`grep` による実測値（`src/` 配下）:

| 項目 | 実測値 | 備考 |
|---|---|---|
| `better-sqlite3` を含むファイル | **41** | Issue 決定2 の記載どおり |
| └ うち **値 import**（`import Database from`）＝ランタイム利用 | **20** | このうち 4 はテスト → **本番 16 ファイル** |
| └ うち **型のみ import**（`import type Database from`） | **18** | **移行時にランタイム変更不要**（型の差し替えのみ） |
| └ うち **コメント内の言及のみ**（import なし） | **3** | `cron-parser.ts` / `v26-*.ts` / `resource-cleanup.ts` |
| マイグレーション定義ファイル | **23** | Issue 決定2 の記載どおり |
| マイグレーション**定義数** | **41**（v1〜v41、欠番なし） | `CURRENT_SCHEMA_VERSION = 41` と一致 |

> **Issue 記述の補足（矛盾ではない）**: Issue 本文は「v01〜v41 の全マイグレーション」、決定ブロックは「23ファイル」と書いており、
> 一見矛盾するが**どちらも正しい**。**41 個のマイグレーション定義が 23 ファイルに同居**している
> （例: `v01-v05-initial-schema.ts` に 5 定義）。実測で確認済み。

> **実務上の含意**: 「41ファイル全ての API 使用を洗い出す」という決定2 の指示は、
> 実際には**本番 16 ファイル**が対象。18 ファイルは型 import のみ、3 ファイルはコメントのみで、
> ランタイムの移行対象ではない。**移行規模は決定ブロックの想定より小さい。**

### 2-2. 使用中の API 一覧（実測）

| API | 使用箇所数 | node:sqlite | 判定 |
|---|---|---|---|
| `db.prepare()` | 194 | ✅ あり | OK |
| `db.exec()` | 151 | ✅ あり | OK |
| `db.transaction()` | **8** | ❌ **なし** | **GAP** → §2-3 |
| `db.pragma()` | 6（本番 **2** / テスト 4） | ❌ **なし** | **GAP** → §2-4 |
| `db.close()` | 5 | ✅ あり | OK |
| `stmt.get()` / `stmt.all()` / `stmt.run()` | 主要 | ✅ あり | OK |

**未使用と確認された API**（＝ギャップでも影響なし）:
`db.function` / `db.aggregate` / `db.backup` / `db.serialize` / `db.loadExtension` / `db.defaultSafeIntegers` /
`stmt.iterate` / `stmt.pluck` / `stmt.raw` / `stmt.columns` / `stmt.bind` / `stmt.safeIntegers` /
`.deferred` / `.immediate` / `.exclusive`

`grep -rn "\.iterate(\|\.pluck(\|\.raw(\|\.safeIntegers(\|\.columns()\|\.aggregate(\|\.backup(\|loadExtension" src` → **0 件**（実測）。

> **Issue スコープの訂正: WAL は幻**
> Issue のスコープに「WAL モード」が挙がっているが、**CommandMate は WAL を一切設定していない。**
> `grep -rn "journal_mode" src scripts tests` → **0 件**（実測）。デフォルトの `journal_mode=delete` で動作している。
> したがって WAL は移行検討項目ではない。
> （なお `node:sqlite` でも `db.exec('PRAGMA journal_mode = WAL')` で WAL 化は可能。実測で `delete → wal` の遷移を確認済み。
> 将来 WAL を導入したくなってもドライバ選択の制約にはならない。）

### 2-3. GAP 1: `db.transaction()` — 移行コストの中心

**better-sqlite3 の挙動**（CommandMate が依存しているもの）:
1. `db.transaction(fn)` は **関数を返す**（即時実行しない）。呼び出し側は `db.transaction(...)()` と 2 段で呼ぶ
2. **例外時に自動 ROLLBACK**
3. **入れ子を SAVEPOINT で自動吸収**（再入可能）

**使用箇所 8 件の内訳（全件）**:

| ファイル:行 | 用途 | 例外送出の有無 |
|---|---|---|
| `src/lib/db/migrations/runner.ts:92` | マイグレーション適用（`migration.up(db)` + schema_version 記録） | あり（失敗時 rethrow） |
| `src/lib/db/migrations/runner.ts:154` | ロールバック（`migration.down(db)` + schema_version 削除） | あり |
| `src/lib/cron-parser.ts:167` | cron エントリの一括 upsert | — |
| `src/lib/db/worktree-db.ts:318` | worktree upsert（stale 行の ID 移行を含む） | — |
| `src/lib/db/worktree-todo-db.ts:268` | todo の並び替え（position の一括更新） | — |
| `src/lib/db/agent-instances-db.ts:174` | roster の全置換（DELETE + 一括 INSERT） | — |
| `src/lib/db/agent-instances-db.ts:203` | インスタンス追加（上限チェック付き） | **あり**（`AgentInstanceLimitError` / `InvalidAgentInstanceError`） |
| `src/lib/db/memo-db.ts:199` | memo の並び替え | — |

**`node:sqlite` の実測結果**:

| 挙動 | 結果 |
|---|---|
| `db.transaction` の有無 | **なし**（`typeof db.transaction === 'undefined'`） |
| 手動 `BEGIN` / `try` / `ROLLBACK` での rollback-on-throw | ✅ **再現可**（実測: 例外後の残存行数 = 0） |
| 素の `BEGIN` の入れ子 | ❌ **THROW**: `cannot start a transaction within a transaction` |
| `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` による入れ子 | ✅ **動作する** |

**代替実装**: `scripts/spike/lib/node-sqlite-adapter.mjs` に**実装済み**（約 40 行）。
better-sqlite3 と同じ戦略（深さ 0 なら `BEGIN`、1 以上なら `SAVEPOINT`）で 3 つの挙動すべてを再現する。

**移行コスト評価（決定ブロックの想定より小さい）**:

決定ブロックは「41ファイル全体でトランザクション境界を手で管理し直すことになり、これは移行コストの中心になる」と想定していたが、**実測はそうならない**:

- `db.transaction()` は **8 箇所のみ**。うち 2 箇所は `runner.ts`（マイグレーション基盤）
- **マイグレーション 41 定義の中では `db.transaction` は 1 度も使われていない**
  （実測: `migrations/` 配下の使用は `db.exec` 142 / `db.prepare` 15 / `db.transaction` 2 = runner.ts のみ）
  ⇒ **入れ子は実際には発生していない**（runner が外側で 1 段張るだけ）
- アダプタ（§7 方式 b）を採れば **呼び出し側 8 箇所は 1 行も変更不要**
- 一括置換（§7 方式 a）でも、書き換えるのは 8 箇所 + ヘルパ 1 個

| 方式 | transaction 起因の変更量 | リスク |
|---|---|---|
| (a) 一括置換 | 8 箇所を手動 BEGIN/COMMIT へ + 共通ヘルパ ~40 行 | rollback 漏れ・例外経路の見落とし |
| (b) アダプタ | **0 箇所**（ヘルパ ~40 行を 1 度書くのみ） | アダプタ自体のバグに集約される |

**性能影響**: なし。むしろ速い（§6: トランザクション内バルク INSERT は **x0.75 = 25% 高速**）。

### 2-4. GAP 2: `db.pragma()`

**本番の使用は 2 箇所のみ**（残り 4 箇所はテスト）:

| ファイル:行 | 内容 |
|---|---|
| `src/lib/db/db-instance.ts:48` | `dbInstance.pragma('foreign_keys = ON')` — マイグレーション前に FK 強制を有効化（Issue #294） |
| `src/lib/db/worktree-db.ts:426` | `db.pragma('defer_foreign_keys = ON')` — worktree ID 移行時に FK チェックを遅延 |

テスト側 4 箇所: `db-migrations-v10.test.ts:44`（`table_info(worktree_memos)`）, `:123`, `:140`, `db-memo.test.ts:186`（`foreign_keys = ON`）。

**`node:sqlite` の実測結果**: `db.pragma()` は**存在しない**が、全て代替可能。

| PRAGMA | 代替手段 | 実測結果 |
|---|---|---|
| `foreign_keys = ON` | `db.exec('PRAGMA foreign_keys = ON')` | ✅ ok |
| `defer_foreign_keys = ON` | `db.exec('PRAGMA defer_foreign_keys = ON')` | ✅ ok |
| `foreign_keys`（参照） | `db.prepare('PRAGMA foreign_keys').get()` | ✅ `{"foreign_keys":1}` |
| `table_info(t)`（テストで使用） | `db.prepare('PRAGMA table_info(t)').all()` | ✅ 列一覧を取得できた |
| `journal_mode = WAL`（**未使用**） | `db.exec('PRAGMA journal_mode = WAL')` | ✅ `delete → wal` を確認 |

**代替コスト**: アダプタに約 15 行実装済み（代入形は `exec`、参照形は `prepare().all()` に振り分け、
better-sqlite3 の戻り値形状（配列 / `simple` オプション）も再現）。方式 (b) なら呼び出し側の変更は **0 箇所**。

**性能影響**: なし（起動時 1 回 + worktree ID 移行時のみ）。

### 2-5. GAP 3: 行オブジェクトが null-prototype（未知だった発見）

**実測**:

```
better-sqlite3 proto: Object.prototype
node:sqlite    proto: null  →  [Object: null prototype] { a: 1, b: 'x' }
```

| 操作 | better-sqlite3 | node:sqlite |
|---|---|---|
| `{...row}`（スプレッド） | ✅ | ✅ OK |
| `JSON.stringify(row)` | ✅ | ✅ OK |
| `row.hasOwnProperty('a')` | ✅ | ❌ **THROW**: `row.hasOwnProperty is not a function` |
| `row instanceof Object` | `true` | **`false`** |
| vitest `expect(row).toEqual({...})` | ✅ | ✅ **PASS** |
| vitest `expect(row).toStrictEqual({...})` | ✅ | ❌ **FAIL** |
| vitest `toMatchObject` / `toHaveProperty` | ✅ | ✅ PASS |

**実害の実測 — 現状は「潜在リスク」であって「現在の破壊」ではない**:

- DB を触る 73 テストファイル中、`toStrictEqual` の使用: **0 件**
- `src/` 配下の `hasOwnProperty` 使用: **1 件のみ**、しかも
  `src/hooks/usePcDisplaySize.ts:66` の `Object.prototype.hasOwnProperty.call(...)` 形式
  （**null-prototype でも安全に動く書き方**）で、そもそも DB 行が対象ではない

⇒ **正規化（`Object.assign({}, row)`）は現時点では不要。** ただし将来 `toStrictEqual` や `row.hasOwnProperty()` を
書いた瞬間に壊れる**時限爆弾**であり、移行するなら lint ルールか正規化のどちらかで蓋をすべき。

**そして正規化には実測で重い代償がある（§6-2 参照）: 読み取りが 138% 遅くなる。**

### 2-6. GAP 4: 型変換の差分

| 値 | better-sqlite3 | node:sqlite | 評価 |
|---|---|---|---|
| `42` | `42` | `42` | 同一 |
| `'hello'` | `'hello'` | `'hello'` | 同一 |
| `null` | `null` | `null` | 同一 |
| `Buffer` / `Uint8Array` | `Uint8Array` | `Uint8Array` | 同一 |
| `true`（boolean） | **THROW** `SQLite3 can only bind numbers, strings, bigints, buffers...` | **THROW** `Provided value cannot be bound to SQLite parameter 1.` | **どちらも throw**。文言のみ差分 |
| `9007199254740993n`（bigint、`Number.MAX_SAFE_INTEGER` 超） | ⚠️ **黙って `9007199254740992` に丸める（データ破損）** | **THROW** `Value is too large to be represented as a JavaScript number` | **node:sqlite の方が安全** |

**boolean について**: 両ドライバとも throw するため、既存コードは既に `? 1 : 0` で明示変換している
（例: `cron-parser.ts:167` の `entry.enabled ? 1 : 0`、`agent-instances-db.ts`）。**移行時の追加対応は不要。**

**bigint について**: node:sqlite の方が厳格（黙って壊さず throw する）。CommandMate は timestamp に
`Date.now()`（`2^53` 未満）しか入れないため実害はないが、**挙動差として記録**しておく。

### 2-7. GAP 5: SQLite 本体のバージョンが Node に固定される（見落としやすい）

| ドライバ | 同梱 SQLite | 更新の自由度 |
|---|---|---|
| better-sqlite3 12.6.2（このリポジトリ） | **3.51.2** | `npm update` で独立に更新可 |
| better-sqlite3（クリーンインストール時の最新） | 3.53.2 | 同上 |
| **node:sqlite (Node v24.1.0)** | **3.49.1** | ❌ **Node のリリースに固定**。Node を上げないと SQLite が上がらない |

**含意**: `node:sqlite` に移ると SQLite 自体のバージョンが**古くなる**（3.51.2 → 3.49.1）うえ、
以後 SQLite のバグ修正・新機能を得るには **Node 本体を上げるしかない**。

**現時点の実害はなし**（全 41 マイグレーションが 3.49.1 で完走。
`v26-repository-display-name.ts` の `down()` が使う `ALTER TABLE ... DROP COLUMN` は SQLite 3.35+ 必須だが 3.49.1 で充足）。
ただし**自由度を失う**トレードオフは Go/No-Go の判断材料に含めるべき。

---

## 3. マイグレーション互換性の実測結果

**検証方法（重要）**: 再実装ではなく、**本番の `migrations` 配列と `runMigrations()` をそのまま**
node:sqlite アダプタに流した。`scripts/spike/02-migrations.ts` で再実行可能。

```
$ npx tsx scripts/spike/02-migrations.ts

Spike 02: migrations v01-v41  |  Node v24.1.0
  migration 定義数: 41  |  CURRENT_SCHEMA_VERSION: 41

[1] better-sqlite3 でベースライン構築
  PASS  better-sqlite3: 全マイグレーション適用
  PASS  better-sqlite3: version == 41  actual=41
  PASS  better-sqlite3: validateSchema()

[2] node:sqlite アダプタで全マイグレーション適用
  PASS  node:sqlite: 全マイグレーション適用
  PASS  node:sqlite: version == 41  actual=41
  PASS  node:sqlite: validateSchema()

[3] スキーマ差分（sqlite_master 全比較）
  better-sqlite3: 58 objects  (tables=22, indexes=36, triggers=0)
  node:sqlite   : 58 objects  (tables=22, indexes=36, triggers=0)
  PASS  スキーマ完全一致

[4] DB ファイルの相互運用
  PASS  前方互換: better-sqlite3 製 DB を node:sqlite で読み書き  version=41, objects=58
  PASS  後方互換: node:sqlite 製 DB を better-sqlite3 で読み書き（ロールバック可否）  version=41

[5] SQLite ライブラリバージョン
  better-sqlite3 同梱 SQLite: 3.51.2
  node:sqlite 内蔵 SQLite   : 3.49.1

RESULT: 全チェック PASS
```

### 判明したこと

| 検証項目 | 結果 |
|---|---|
| v01〜v41 の全 41 マイグレーションが node:sqlite 上で流れるか | ✅ **全件成功** |
| 生成スキーマが better-sqlite3 と一致するか | ✅ **完全一致**（58 オブジェクト / 22 テーブル / 36 インデックス / トリガ 0） |
| `validateSchema()` が通るか | ✅ 両ドライバで `true` |
| **前方互換**: 既存の better-sqlite3 製 DB を node:sqlite で開けるか | ✅ **読み書き可**（＝既存ユーザーの `cm.db` をそのまま使える。データ移行不要） |
| **後方互換**: node:sqlite 製 DB を better-sqlite3 で開けるか | ✅ **読み書き可**（＝**ロールバックしてもデータは無傷**） |

**ロールバック方針への含意**: SQLite のファイルフォーマットは両ドライバで完全互換のため、
**移行に失敗しても `git revert` するだけでよい。データ変換もダウングレード処理も不要。**
これは移行リスクを大きく下げる材料（Go の場合の安全弁）。

**本番 DB への影響**: なし。全て `/tmp` の使い捨て DB で検証し、スクリプト終了時に削除している。
本番 `~/.commandmate/data/cm.db` は**読み取りも含め一切触れていない**（md5 `3db2498fa7e0f1819d85190606979f0c` 不変、mtime は 3月14日のまま）。

---

## 4. Node 要件（engines）の影響評価

### 4-1. 現状は既に壊れている（node:sqlite と無関係の発見）

`package.json` の `engines` は **`>=20.0.0`**。しかし **Node 20 は 2026-04-30 に EOL 済み**（本日 2026-07-15 時点）。
**サポート切れの Node を engines で許可し続けている**状態であり、これは node:sqlite の是非とは独立に修正すべき。

### 4-2. node:sqlite を採用する場合に必要な engines

| 目標 | 必要な最小 Node | 2026-07-15 時点の妥当性 |
|---|---|---|
| `node:sqlite` が動く（フラグ必須） | v22.5.0 | 警告 + フラグ。非現実的 |
| `node:sqlite` がフラグ不要 | **v22.13.0** | ⚠️ 動くが **ExperimentalWarning が出る** |
| `node:sqlite` が **RC（警告なし）** | **v25.7.0** | ❌ **v25 は EOL（2026-06-01）**。実質 **v26 以上** |
| `node:sqlite` が **Stable** | **未定** | ❌ まだ存在しない |

### 4-3. 影響評価

**「警告を許容する」なら `engines: >=22.13.0`**
- 既存ユーザーへの影響: Node 20 ユーザーは切り捨て（ただし既に EOL なので実質影響小）
- **代償: Node 22 / 24 の全ユーザーが毎回 experimental 警告を見る**

**「警告を出さない」なら `engines: >=26.0.0`**
- 既存ユーザーへの影響: **Node 22 LTS / 24 LTS のユーザーを全て切り捨てる**
- v24 は Active LTS で 2028-04-30 まで生存。**ここを切るのは 2026 年時点では非現実的**
- v26 の LTS 化は 2026-10-28。それ以前に `>=26` を要求するのは「Current 版必須」＝**インストール難易度を上げる**
  ⇒ **元動機（インストール失敗の削減）と真正面から矛盾する**

### 4-4. 推奨

| 時期 | engines | 理由 |
|---|---|---|
| **今すぐ（node:sqlite とは独立）** | **`>=22.0.0`** | Node 20 は EOL 済み。陳腐化した宣言の是正 |
| 2026-10-28（Node 26 LTS 化）以降に再評価 | `>=26.0.0` + node:sqlite | RC/Stable かつ LTS が揃って初めて成立 |

**結論: engines 引き上げによって node:sqlite の警告問題を解決することはできない**（v26 必須は代償が大きすぎる）。
これが No-Go の主因の 1 つ。

---

## 5. テスト影響

### 5-1. 実測

| 項目 | 実測値 |
|---|---|
| `better-sqlite3` を参照するテストファイル | **73**（`src/**/__tests__` + `tests/unit` + `tests/integration`） |
| `tests/helpers/` での better-sqlite3 / モック使用 | **0 件** |
| DB 系テスト 73 ファイル中の `toStrictEqual` 使用 | **0 件** |

> **Issue スコープの訂正**: Issue は「`tests/helpers/` のテストヘルパ・モックへの影響を確認する」としているが、
> **`tests/helpers/` は better-sqlite3 を一切使っていない**（実測 0 件）。
> 実際の影響は **73 個のテストファイルが各自 `new Database(':memory:')` を直接生成している**点にある。
> ヘルパに集約されていないため、方式 (a) 一括置換では **73 ファイル全てに手が入る**。

### 5-2. vitest との互換性（実測）

実際に vitest を走らせて確認した結果:

```
 ❯ _tmp-proto.test.ts (6 tests | 1 failed)
     × node:sqlite row: toStrictEqual
AssertionError: expected { a: 1, b: 'x' } to strictly equal { a: 1, b: 'x' }
 Tests  1 failed | 5 passed (6)
```

| アサーション | node:sqlite の行に対する結果 |
|---|---|
| `toEqual` | ✅ PASS |
| `toMatchObject` | ✅ PASS |
| `toHaveProperty` | ✅ PASS |
| **`toStrictEqual`** | ❌ **FAIL**（null-prototype のため） |

**現時点で `toStrictEqual` は DB テストで 0 件使用のため、実害はない。**
エラーメッセージが `expected { a: 1, b: 'x' } to strictly equal { a: 1, b: 'x' }`（**見た目が同一なのに fail**）
という極めてデバッグしにくい形になる点は、将来のリスクとして記録しておく。

### 5-3. vitest 実行環境そのものへの影響

- `node:sqlite` は Node 組み込みのため、vitest（vite/rollup）の外部モジュール解決の対象外 → **バンドル設定の変更不要**
- `next.config.js` に better-sqlite3 向けの `externals` / `serverExternalPackages` 設定は**存在しない**（実測）
  ため、Next.js 側の設定変更も不要
- **警告**: vitest 実行時にも `ExperimentalWarning` が出る（テスト出力のノイズになる）

### 5-4. 移行時のテスト作業量

| 方式 | テストの変更量 |
|---|---|
| (a) 一括置換 | **73 ファイル**の `new Database(...)` を差し替え。`db.pragma()` を使う 4 箇所も修正 |
| (b) アダプタ | テストヘルパ経由に寄せれば **1 箇所**。ただし 73 ファイルがヘルパを使っていない現状では、**まずヘルパへの集約リファクタが必要** |

---

## 6. パフォーマンス比較

### 6-1. 代表クエリのベンチマーク

`scripts/spike/03-bench.ts` で再実行可能。node:sqlite 側は**アダプタ経由**（＝方式 (b) を採った場合に本番で出る性能）。

```
Spike 03: performance  |  Node v24.1.0  |  Apple M3 Ultra
  iterations: 2000 (B2 は 500, B5 は 5 回 x 1000 行)

ベンチ                                    better-sqlite3    node:sqlite          比
------------------------------------------------------------------------------------
B1 chat_messages INSERT                         870.3          795.7      x0.91  同等以上
B2 chat_messages 一覧(LIMIT 50)                 277.1          312.4      x1.13  やや低速
B3 session_states UPSERT                        483.8          473.0      x0.98  同等以上
B4 worktrees 一覧                                 7.3           11.2      x1.53  低速
B5 transaction バルクINSERT(1000行)              63.5           47.8      x0.75  同等以上
------------------------------------------------------------------------------------
合計                                           1702.0         1640.2      x0.96
```

**総合: x0.96 = node:sqlite の方が僅かに速い。**
書き込み（INSERT / UPSERT / バルク）は node:sqlite が優位。読み取りは better-sqlite3 が優位。

**受入基準「同等以上であること」は総合で満たす。**

> **測定のばらつきについて（誠実性のため記録）**: 本ベンチは実行ごとに数値が揺れる（別実行では総合 **x0.82**）。
> 絶対値を鵜呑みにせず、**傾向**（書き込み優位・読み取り劣位・総合は同等以上）のみを判断材料にすること。
> 単一マシン（Apple M3 Ultra / darwin arm64）・単一 Node（v24.1.0）での測定であり、
> Linux や低速ディスク環境では傾向が変わりうる。再評価時は `03-bench.ts` を対象環境で再実行すること。

### 6-2. 読み取りが遅い原因の切り分け（重要）

B4 の x1.53 が「node:sqlite が遅い」のか「アダプタの null-prototype 正規化が遅い」のかを切り分けた
（5000 行テーブルからインデックス経由で 50 行取得 × 500 回）:

```
better-sqlite3 .all()              : 8.6 ms  (baseline)
node:sqlite .all() (raw)           : 12.7 ms  x1.47
node:sqlite .all() + Object.assign : 30.3 ms  x3.50
=> null-prototype 変換の追加コスト  : 17.5 ms (138% 増)
```

**判明したこと:**

1. **node:sqlite 素の読み取りは better-sqlite3 より x1.47 遅い**（アダプタのせいではない）
2. **null-prototype を正規化すると x3.50（138% 増）まで悪化する** — 正規化は高くつく
3. §6-1 の B2 が x1.13 に留まったのは、クエリ自体が重く（ORDER BY のコストが支配的）
   行変換の比率が相対的に小さかったため。**インデックスが効く軽いクエリほど変換コストが目立つ**

**設計上の含意**: §2-5 の実測どおり **null-prototype の正規化は現時点では不要**
（`toStrictEqual` 0 件 / `hasOwnProperty` の危険な使用 0 件）。
**正規化を省けば読み取り x1.47・書き込みは高速**で、総合同等以上を維持できる。
ただしそれは「将来 `toStrictEqual` を書いたら壊れる」状態を受け入れるということ。

| 選択 | 読み取り性能 | 安全性 |
|---|---|---|
| 正規化しない | x1.47（許容） | ⚠️ 時限爆弾（lint で蓋をする必要） |
| 正規化する | **x3.50（138% 悪化）** | ✅ 安全 |

**この二択そのものが、方式 (b) アダプタ設計の主要な論点になる。**

---

## 7. 移行方式の比較と推奨

### (a) 一括置換

| 観点 | 評価 |
|---|---|
| 変更対象 | 本番 **16 ファイル** + テスト **73 ファイル** + 型 import **18 ファイル** |
| `db.transaction` | 8 箇所を手動 BEGIN/COMMIT + 共通ヘルパへ書き換え |
| `db.pragma` | 本番 2 + テスト 4 箇所を `exec`/`prepare` へ書き換え |
| 段階リリース | ❌ 不可（all-or-nothing） |
| ロールバック | `git revert`（DB ファイルは互換なのでデータは無傷） |
| 性能 | node:sqlite 素の性能（読み x1.47 / 書き 高速） |
| 工数見積 | **3〜5 日**（テスト 73 ファイルの機械的変更が支配的） |
| リスク | 一度に全経路が切り替わる。rollback 漏れ・例外経路の見落としが本番で顕在化 |

### (b) ドライバ抽象化レイヤ（アダプタ）で段階移行

| 観点 | 評価 |
|---|---|
| 変更対象 | アダプタ **1 ファイル（~130 行）** + `db-instance.ts` の生成箇所 **1 行** |
| `db.transaction` | **呼び出し側 0 箇所**（アダプタが吸収。実装済み・実証済み） |
| `db.pragma` | **呼び出し側 0 箇所**（同上） |
| 段階リリース | ✅ **可**（環境変数で両ドライバを切替。カナリア可能） |
| ロールバック | **環境変数を戻すだけ**（再デプロイ不要） |
| 性能 | 正規化するかで x1.47 / x3.50 が分岐（§6-2） |
| 工数見積 | **2〜3 日**（アダプタは本スパイクで完成済み。型定義の整備が主） |
| リスク | アダプタにバグが集中（＝テストで集中的に守れる、とも言える） |
| 副次効果 | better-sqlite3 を **dependency に残したまま**移行できる → 逃げ道が常にある |

**本スパイクの実証**: 方式 (b) のアダプタ（`scripts/spike/lib/node-sqlite-adapter.mjs`）は**既に動いている**。
本番の `runMigrations()` を 1 行も変えずに 41 マイグレーション全件を通し、スキーマ完全一致を達成した。
**「抽象化レイヤ方式は現実的」は推測ではなく実証済み。**

### 推奨: **Go する場合は (b)**。ただし**現時点の推奨は No-Go**（§1）

方式 (b) は「移行するか決めきれない」状況と相性が良い:
- better-sqlite3 を残したまま `node:sqlite` を**オプトイン**で試せる
- Node 26 が LTS 化して RC/Stable が揃った時点で、**デフォルトを切り替えるだけ**
- 万一問題が出れば環境変数で即座に戻せる

> **注意**: 方式 (b) を「今すぐ」入れることにも**コストがある**。アダプタという間接層は、
> better-sqlite3 のみを使い続ける限り**純粋な負債**（誰も使わない分岐の保守）。
> No-Go 期間中にアダプタだけ先に入れる価値があるかは、再評価時期（§1）が近い（約 3.5 ヶ月）ことを踏まえると**低い**。
> **アダプタは Go 判断と同時に入れるのが合理的。** 本スパイクの成果物として保存してあるため、その時点で再利用できる。

---

## 8. Go/No-Go の推奨と根拠

### 推奨: **No-Go（時期尚早）**

### 根拠（実測に基づく）

| # | 事実（すべて実測 / 一次情報） | Go/No-Go への寄与 |
|---|---|---|
| 1 | **Node 22 / 24 LTS で `ExperimentalWarning` が出る**。RC 化は v25.7.0 のみで **LTS 未バックポート**、v25 は EOL | 🔴 **No-Go の決定打** |
| 2 | `node:sqlite` は **Stability 1.2 (RC)**。**Stable ではない**。「いつ変わってもおかしくない」 | 🔴 No-Go |
| 3 | 警告なしを実現するには `engines: >=26`。**Node 22/24 LTS ユーザーを切り捨てる**＝元動機と矛盾 | 🔴 No-Go |
| 4 | `node:sqlite` の SQLite は **3.49.1（Node に固定・現行より古い）**。更新の自由度を失う | 🟡 No-Go 寄り |
| 5 | 読み取りが **x1.47 遅い**。null-prototype 正規化まで入れると **x3.50** | 🟡 中立〜No-Go 寄り |
| 6 | 全 41 マイグレーションが完走、**スキーマ完全一致** | 🟢 Go 寄り（技術的実現性は証明済み） |
| 7 | **DB ファイルは双方向互換** → データ移行不要・ロールバック安全 | 🟢 Go 寄り |
| 8 | API ギャップは **transaction 8 箇所 / pragma 2 箇所**のみ。アダプタ ~130 行で解決（実証済み） | 🟢 Go 寄り（コストは想定より小） |
| 9 | 書き込み性能は **同等〜25% 高速** | 🟢 Go 寄り |
| 10 | **ABI mismatch 問題を根絶できる**（元動機の中核） | 🟢 **Go 寄り（最大の魅力）** |

### 「移行できる」と「移行すべき」の分離

**移行できる（6〜9 が証明）**: 技術的障壁は事実上ない。ギャップは埋まり、データは安全で、性能も許容範囲。

**移行すべきではない（1〜3 が阻止）**: しかし、**現在サポートされている全 LTS で experimental**。
本 Issue の元動機は「IT に精通していない利用者のインストール成功率を上げる」こと。
その利用者に対し、
- 毎回 `ExperimentalWarning: SQLite is an experimental feature and might change at any time` を見せる
- または `--disable-warning` で警告を握り潰し、experimental であることを隠したまま全データを載せる

のどちらも、**元動機に照らして正当化できない**。「動いたから Go」にはしない。

### 再評価のトリガ（§0 再掲）

1. `node:sqlite` が **Stable (Stability 2)** になり、それが **Active LTS に載る**
2. または **RC が Node 24 LTS へバックポート**される
3. 現実的最短: **2026-10-28（Node 26 の LTS 化）以降**

再評価は `scripts/spike/` を再実行するだけで大部分が自動化されている。

---

## 9. 元動機を今すぐ満たす代替案（node:sqlite 以外）

元動機は **「better-sqlite3 のネイティブビルドがインストール失敗要因になっている」**。
node:sqlite を待つ間、以下で実際の痛みを減らせる。

### 9-1. 実測: インストールは実際どれくらい壊れるのか

クリーン環境（`/tmp`）で `npm install better-sqlite3@^12.4.1` を実行（darwin/arm64, Node 24.1.0）:

```
> prebuild-install || node-gyp rebuild --release
added 38 packages in 1s
```

**prebuild が効き、node-gyp へのフォールバックは発生しなかった（1 秒で完了）。**
⇒ **主要プラットフォームでは「初回インストールの失敗」は実はあまり起きない。**

**ただし 2 つの問題が実在する:**

1. **`prebuild-install@7.1.3` が deprecated**（実測ログ: `npm warn deprecated prebuild-install@7.1.3: No longer maintained.`）
   ⇒ better-sqlite3 のインストール基盤自体が**無保守**。将来の Node ABI に prebuild が追随しなくなるリスク
2. **本当の痛みは ABI mismatch**（`docs/user-guide/wsl2-setup.md:200-226` に実在を確認）:
   nvm で Node を切り替えると `NODE_MODULE_VERSION 137 vs 115` で**起動不能**になり、`npm rebuild better-sqlite3` が必要。
   これは**インストール時ではなく、インストール後に突然壊れる**ため、利用者体験としてはより深刻

### 9-2. 代替案（優先度順）

| # | 施策 | 効果 | 工数 | 備考 |
|---|---|---|---|---|
| **A1** | **起動時に ABI mismatch を検知し、自動で `npm rebuild better-sqlite3` を実行**（または明確な 1 コマンド案内） | 🔴 **最大**。実在する唯一の恒常的痛みを直撃 | S（1〜2日） | `commandmate start` / `doctor` に組込。node:sqlite を待たずに今できる |
| **A2** | `engines` を **`>=22.0.0`** に修正 | 中（Node 20 EOL の是正） | XS | **node:sqlite と無関係に今すぐやるべき**（§4-1） |
| **A3** | better-sqlite3 の**ロード失敗時のエラーメッセージ改善**（生の NODE_MODULE_VERSION エラーではなく対処法を提示） | 中 | S | IT に不慣れな利用者向けに効く |
| **A4** | ドライバ抽象化レイヤ（方式 b）を先行導入 | 低（今は純粋な負債） | M | **Go 判断と同時が合理的**（§7 の注記） |
| **A5** | node:sqlite への移行 | 高（ABI 問題を根絶） | M | 🔴 **現時点 No-Go**。2026-10-28 以降に再評価 |

**推奨アクション: A1 + A2 + A3 を先に実施し、A5 は Node 26 LTS 化後に再評価。**
A1 は node:sqlite 移行が実現しても無駄にならない（移行までの期間、確実に効く）。

> **libsql / sql.js / WASM について**（Issue の対象外指定につき備考のみ）:
> ネイティブビルド排除という点では WASM ビルド（`sql.js` / `wa-sqlite`）も候補になるが、
> 同期 API・ファイル永続化・性能の制約が大きく、better-sqlite3 の同期 API 前提で書かれた
> 本コードベース（`resource-cleanup.ts:215` が同期性に明示的に依存）とは相性が悪い。
> `libsql`（better-sqlite3 互換 API を持つ fork）はネイティブモジュールのままなので動機を満たさない。**いずれも推奨しない。**

---

## 10. Go の場合の実装 Issue 分割案

**現時点の推奨は No-Go** だが、再評価で Go になった場合の分割案を以下に示す（そのまま起票可能）。

| # | Issue 案 | サイズ | 依存 | 内容 |
|---|---|---|---|---|
| 1 | `feat(db): ドライバ抽象化レイヤを導入し better-sqlite3 を隠蔽` | M (8h) | なし | `scripts/spike/lib/node-sqlite-adapter.mjs` を `src/lib/db/driver/` へ昇格。型定義（`.d.ts`）を整備。`db-instance.ts` を経由させる。**既定は better-sqlite3 のまま**（挙動不変） |
| 2 | `refactor(test): DB テストのインスタンス生成を共通ヘルパへ集約` | M (8h) | #1 | 73 テストファイルの `new Database(':memory:')` を `tests/helpers/` の 1 関数へ集約（現状ヘルパは DB を扱っていない）。以後のドライバ切替を 1 箇所にする |
| 3 | `feat(db): CM_DB_DRIVER 環境変数で node:sqlite を選択可能にする` | S (4h) | #1, #2 | オプトイン。既定は better-sqlite3。null-prototype 正規化の有無もフラグ化（性能 §6-2） |
| 4 | `test(db): 全 DB テストを両ドライバで実行するマトリクスを追加` | M (8h) | #3 | CI で `CM_DB_DRIVER=node-sqlite` の 2 週目を回す。差分検出 |
| 5 | `chore(db): 既定ドライバを node:sqlite に切替 / engines 引き上げ` | S (4h) | #4 | **Node 26 LTS 化 + Stable 化が前提**。`engines` を `>=26` へ。better-sqlite3 は 1 リリース分 dependency に残す |
| 6 | `chore(db): better-sqlite3 を dependencies から削除` | S (2h) | #5 | 安定確認後。ここで初めてネイティブビルド依存が消える |

**合計見積: 約 34h（M×3 + S×3）**

**リスクと緩和**:

| リスク | 緩和策 |
|---|---|
| null-prototype 起因の実行時バグ | #3 で正規化フラグを用意。lint ルールで `toStrictEqual` / `row.hasOwnProperty()` を禁止 |
| 読み取り性能の劣化（x1.47〜x3.50） | #4 でベンチを CI 化。正規化 OFF を既定にする |
| node:sqlite の RC 破壊的変更 | #5 を Stable 化まで実施しない。#1〜#4 は better-sqlite3 既定のままなので無害 |
| SQLite バージョンが Node 固定になる | 受容。#5 の判断時に当時の SQLite バージョンを再確認 |

**ロールバック方針**:
- #1〜#4 は既定挙動を変えないため、ロールバック不要
- #5 は **環境変数を戻すだけ**（再デプロイ不要）
- #6 実施後に問題が出た場合は `git revert` + `npm install`。**DB ファイルは双方向互換のためデータは無傷**（§3 で実証済み）

---

## 11. 検証スクリプト

すべて `scripts/spike/` 配下。**本番 DB・本番サーバには一切触れない**（`/tmp` の使い捨て DB のみ使用）。

| スクリプト | 内容 | 実行 |
|---|---|---|
| `01-api-surface.mjs` | node:sqlite と better-sqlite3 の API 差分・型変換・PRAGMA・transaction 代替可否を全件比較 | `node scripts/spike/01-api-surface.mjs` |
| `02-migrations.ts` | **本番の** `runMigrations()` を node:sqlite アダプタに流し、v01〜v41 全適用・スキーマ一致・DB ファイル双方向互換を検証 | `npx tsx scripts/spike/02-migrations.ts` |
| `03-bench.ts` | 代表 5 クエリの性能比較 | `npx tsx scripts/spike/03-bench.ts` |
| `lib/node-sqlite-adapter.mjs` | better-sqlite3 互換アダプタ（方式 (b) の実証実装）。transaction / pragma を含む | （上記から import） |

再評価時（§1 のトリガ到達時）は、**新しい Node で 01〜03 を再実行**すれば
experimental ステータス・API ギャップ・性能の変化を即座に確認できる。

### CI 実行結果（本スパイク追加後）

`scripts/spike/` を追加した状態で、CLAUDE.md の必須チェックを実行:

| チェック | 結果 |
|---|---|
| `npx tsc --noEmit` | ✅ パス（エラー 0） |
| `npm run lint` | ✅ パス（`eslint src` にスコープされており `scripts/` は対象外） |
| `npm run test:unit` | ✅ **562 files / 9523 tests 全パス** |

> **注意（将来 `scripts/` に .ts を追加する人向け）**: `tsconfig.json` の `include` は `**/*.ts`、
> `exclude` は `node_modules` のみ。したがって **`scripts/` 配下の `.ts` も `tsc --noEmit` の対象になる**。
> 本スパイクでも当初 `@ts-expect-error` の未使用（TS2578）で type-check を落としており、修正済み。
> `scripts/spike/*.ts` を編集したら **必ず `npx tsc --noEmit` を通すこと**。

---

## 12. 本調査で判明した Issue 記述の訂正

決定3 の指示（「Issue 本文の記述を鵜呑みにせずコードと実機で確認し、誤りを見つけたらレポートに明記する」）に従い記録する。

| # | Issue / 決定ブロックの記述 | 実測 | 影響 |
|---|---|---|---|
| 1 | スコープに「**WAL モード**」の調査が含まれる | **CommandMate は WAL を一切使っていない**（`journal_mode` は repo 全体で 0 件） | 調査項目として無意味。対応表では「未使用・将来も制約にならない」と記載（§2-2） |
| 2 | 「`tests/helpers/` のテストヘルパ・モックへの影響を確認」 | **`tests/helpers/` は better-sqlite3 を 0 件使用**。実際は **73 テストファイルが各自 `new Database()` している** | 影響範囲の所在が違う。集約リファクタが別途必要（§5-1, 実装案 #2） |
| 3 | 決定: 「**41ファイル全ての API 使用を洗い出す**」 | 41 のうち **18 は型のみ import・3 はコメントのみ**。ランタイム対象は **本番 16 ファイル** | 移行規模は想定より小さい（§2-1） |
| 4 | 決定: 「`db.transaction` と `db.pragma` は**多用されているはず**」「**41ファイル全体でトランザクション境界を手で管理し直す**ことになり、これは**移行コストの中心**」 | `db.transaction` **8 箇所** / `db.pragma` **本番 2 箇所**。マイグレーション 41 定義内では transaction 未使用＝**入れ子は発生しない**。方式 (b) なら呼び出し側 **0 箇所** | **移行コストの中心ではない**。想定より大幅に小さい（§2-3） |
| 5 | Issue 本文「**v01〜v41 の全マイグレーション**」 vs 決定2「**23ファイル**」 | **どちらも正しい**（41 定義が 23 ファイルに同居） | 矛盾ではない。誤解を避けるため明記（§2-1） |
| 6 | 決定: 「Node 22 系では experimental フラグ付きだった」 | 正確には **v22.5.0 でフラグ必須 → v22.13.0 でフラグ不要（ただし experimental 継続）** | 記述はほぼ正しい。より正確な内訳を §1-2 に記載 |
| 7 | 決定: 「**Node v24 でも node:sqlite は experimental**」 | ✅ **正しい**（実測で確認）。さらに RC 化が **LTS 未バックポート**であることまで判明 | 決定ブロックの中核主張は正確。本レポートはその根拠を一次情報で補強した |
| 8 | （記載なし） | **`engines: >=20.0.0` だが Node 20 は 2026-04-30 に EOL 済み** | node:sqlite と無関係の既存不具合を発見。即修正を推奨（§4-1, §9-2 A2） |
| 9 | （記載なし） | **`prebuild-install@7.1.3` が deprecated（No longer maintained）** | better-sqlite3 の install 基盤が無保守。長期的には移行動機を補強する（§9-1） |
| 10 | （記載なし） | **node:sqlite の行は null-prototype**。`toStrictEqual` が fail、`hasOwnProperty` が throw | 誰も想定していなかったギャップ。現状実害 0 だが時限爆弾（§2-5, §5-2） |

---

## 付録: 受入基準の充足状況

### 🤖 自動検証可能

| 基準 | 結果 |
|---|---|
| `src/` 配下が一切変更されていない | ✅ `git status --porcelain src/` → 空 |
| `package.json` の dependencies が未変更 | ✅ `git status --porcelain package.json package-lock.json` → 空 |
| 検証スクリプトが `scripts/spike/` にあり再実行可能 | ✅ `01-api-surface.mjs` / `02-migrations.ts` / `03-bench.ts` |
| 既存 CI（lint / type-check / unit / build）に影響がない | ✅ 実行して確認: `npx tsc --noEmit` パス / `npm run lint` パス / `npm run test:unit` **562 files, 9523 tests 全パス**（詳細は下記「CI 実行結果」） |
| 本番 DB が変更されていない（md5 不変） | ✅ md5 `3db2498fa7e0f1819d85190606979f0c`、mtime 3月14日（調査中に一切アクセスせず） |

### 👤 手動検証（オーケストレーター実施）

| 基準 | 対応箇所 |
|---|---|
| レポートを読んだだけで Go/No-Go を判断できる | §0（TL;DR）・§8（根拠表）・§1（決定打の詳細） |
| API 対応表に「使用中だが node:sqlite に存在しない」項目がすべて代替案付きで列挙されている | §2-2（一覧）・§2-3〜§2-7（GAP 全 5 件の代替案・コスト・リスク） |
| experimental ステータスのリスクが正面から評価されている | §1 全体（実測 + 一次情報 + LTS スケジュール + 抑止策が根本解決でない理由） |

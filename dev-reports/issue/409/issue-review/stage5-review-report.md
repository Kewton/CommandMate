# Issue #409 レビューレポート - Stage 5

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（2回目）
**ステージ**: Stage 5 / 5

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |
| **合計** | **4** |

**総合評価**: Issue #409 は Stage 1 および Stage 3 の全 Must Fix / Should Fix 指摘が適切に反映されており、実装着手可能な品質に達している。残る指摘は軽微な改善提案のみ。

---

## 前回指摘の対処確認

### Stage 1 (通常レビュー1回目) - 全11件

| ID | 重要度 | 対処状況 | 検証結果 |
|----|--------|----------|----------|
| R1-001 | Must Fix | applied | S6セクションからchat_messages記述が正しく削除されている |
| R1-002 | Must Fix | applied | UNIQUE制約の暗黙インデックスが注記され、(worktree_id, enabled)に修正されている |
| R1-003 | Must Fix | applied | クエリ数見積もりが「1000+クエリ/60秒」に修正されている |
| R1-004 | Must Fix | applied | 「SELECT id, path FROM worktrees」に修正され、コードベースと一致 |
| R1-005 | Should Fix | applied | インデックス提案が(worktree_id, enabled)に変更されている |
| R1-006 | Should Fix | applied | mtimeキャッシュの実装方針が具体化されている |
| R1-007 | Should Fix | applied | db.transaction()バッチ化が具体的に記述されている |
| R1-008 | Should Fix | applied | 受入条件がupsertSchedule()単位に精緻化されている |
| R1-009 | Should Fix | applied | テストファイルが影響範囲テーブルに追加されている |
| R1-010 | Nice to Have | skipped | Issue分割はレビュー自体が任意と認めている。妥当 |
| R1-011 | Nice to Have | skipped | R1-006反映でmtime方針が確定済み。妥当 |

**結果**: Must Fix 4件、Should Fix 5件 -- 全9件が適切に反映。Nice to Have 2件は妥当な理由でスキップ。

### Stage 3 (影響範囲レビュー1回目) - 全10件

| ID | 重要度 | 対処状況 | 検証結果 |
|----|--------|----------|----------|
| R3-001 | Must Fix | applied | 依存関係セクション新設、Issue #407との関係を詳述 |
| R3-002 | Must Fix | applied | マイグレーション番号競合の確認手順とフェイルセーフを記載 |
| R3-003 | Should Fix | applied | Issue #406との推奨マージ順序を記載 |
| R3-004 | Should Fix | applied | Issue #407との並行開発リスクを記載 |
| R3-005 | Should Fix | applied | db-migrations.test.tsを影響範囲に追加 |
| R3-006 | Should Fix | applied | テストケース3件を具体的に列挙 |
| R3-007 | Should Fix | applied | ENOENTエラー処理方針を追記 |
| R3-008 | Should Fix | applied | Hot Reload時の動作確認を備考に記載 |
| R3-009 | Nice to Have | skipped | CLAUDE.md更新は実装完了後に実施。妥当 |
| R3-010 | Nice to Have | skipped | API受益ファイルの記載は必須ではない。妥当 |

**結果**: Must Fix 2件、Should Fix 6件 -- 全8件が適切に反映。Nice to Have 2件は妥当な理由でスキップ。

---

## 新規指摘事項

### Should Fix（推奨対応）

#### R5-001: stopScheduleForWorktree() の関数名がIssue #407と未整合

**カテゴリ**: 正確性
**場所**: 依存関係・並行開発リスク > Issue #407 との依存関係

**問題**:
Issue本文にて「Issue #407 で stopAllSchedules() の呼び出しを worktree 単位の停止関数（stopScheduleForWorktree()）に置換する予定」と記載されている。しかし Issue #407 の本文には stopScheduleForWorktree() という具体的な関数名は言及されておらず、「エントリ削除用エクスポート関数追加」という抽象的な記述のみ。

さらに、CLAUDE.md の session-cleanup.ts 説明（L171）には「Issue #294: stopScheduleForWorktree()呼び出し追加」と記載されているが、実際の `session-cleanup.ts:111` は `stopAllSchedules()` を呼び出しており、`stopScheduleForWorktree()` はコードベースのどこにも実装されていない。

**推奨対応**:
具体的な関数名を断定しない表現に変更する（「worktree 単位の停止・エントリ削除関数に置換する予定」）。または Issue #407 側にも具体的な関数名を提案する。

---

#### R5-002: バルクSELECTの実装手順が不明確

**カテゴリ**: 完全性
**場所**: 提案する解決策 > 2. スケジュール同期の差分ベース化

**問題**:
「バルクSELECT -> トランザクション内UPDATE/INSERT」と記載されているが、バルクSELECTの具体的な実装方法が不明確。現在の `upsertSchedule()` は1エントリずつ `SELECT id FROM scheduled_executions WHERE worktree_id = ? AND name = ?` を実行している。

**推奨対応**:
バッチ化の手順を具体化する。例:
1. worktree単位で `SELECT id, name FROM scheduled_executions WHERE worktree_id = ?` を1回実行し、既存スケジュールの `Map<name, id>` を構築
2. `db.transaction()` 内で entries をループし、Map に存在すれば UPDATE、なければ INSERT
3. これにより1 worktreeあたりの SELECT が `entries.length` 回から1回に削減される

---

### Nice to Have（あれば良い）

#### R5-003: 既存のenabled単独インデックスの扱いが未記載

**カテゴリ**: 完全性
**場所**: 提案する解決策 > 1. インデックス追加

**問題**:
`(worktree_id, enabled)` 複合インデックスを追加すると、既存の `idx_scheduled_executions_enabled (enabled)` 単独インデックスが冗長になる可能性がある。このインデックスの扱い（DROP or 維持）の方針が記載されていない。

**推奨対応**:
マイグレーション version 21 で既存の `idx_scheduled_executions_enabled` を DROP するか維持するかの方針を実装タスクに追加する。enabled 単独でフィルタリングするクエリが現時点で存在しないため、DROP して複合インデックスに統合することを推奨。

---

#### R5-004: 概要にバッチ化の言及がない

**カテゴリ**: 明確性
**場所**: 概要セクション

**問題**:
概要に mtime キャッシュとインデックス追加は記載されているが、`db.transaction()` によるバッチ化についての言及がない。

**推奨対応**:
概要を以下のように調整する: 「スケジュールマネージャの60秒ポーリングにmtimeキャッシュとトランザクションバッチ化を導入し、不足しているDBインデックスを追加する。」

---

## 整合性チェック

### 内部整合性

| チェック項目 | 結果 |
|------------|------|
| S6セクション <-> 解決策1 | 整合。(worktree_id, enabled)の不足がS6で指摘され、解決策1で対処 |
| P3セクション <-> 解決策2 | 整合。60秒ポーリングの非効率がP3で指摘され、mtimeキャッシュ+バッチ化で対処 |
| 解決策 <-> 実装タスク | 整合。解決策の各項目が実装タスクに対応している |
| 実装タスク <-> 受入条件 | 整合。タスク完了時に受入条件が満たされる |
| 実装タスク <-> 影響範囲 | 整合。タスクで変更するファイルが影響範囲テーブルに記載されている |
| 依存関係 <-> 備考 | 整合。Hot Reloadの動作が備考で補足され、依存関係セクションと矛盾なし |

### コードベースとの整合性

| 記述 | 実際のコード | 結果 |
|------|------------|------|
| `SELECT id, path FROM worktrees` | schedule-manager.ts:127 | 一致 |
| `UNIQUE(worktree_id, name)` 暗黙インデックス | db-migrations.ts:829 | 一致 |
| `idx_scheduled_executions_enabled ON (enabled)` | db-migrations.ts:842-843 | 一致 |
| `upsertSchedule()` が2クエリ/エントリ | schedule-manager.ts:151-168 | 一致 |
| `CURRENT_SCHEMA_VERSION = 20` | db-migrations.ts:14 | 一致 |
| `session-cleanup.ts:111` が `stopAllSchedules()` を呼出 | session-cleanup.ts:111 | 一致 |
| `WHERE worktree_id = ? AND enabled = 1` (API) | schedules/route.ts:42 | 一致 |

---

## 実装可能性評価

**判定**: 十分に実装可能

**根拠**:
1. **変更対象が明確**: 影響範囲テーブルに4ファイルが具体的に記載されている
2. **実装方針が具体的**: ManagerStateへのcmateFileCacheフィールド追加、syncSchedules()のmtimeチェック、db.transaction()バッチ化の3つの主要変更が詳述されている
3. **エッジケースが網羅**: ENOENTエラー処理、Hot Reload時の動作、サーバー再起動時のキャッシュクリアが記載されている
4. **テストケースが具体的**: キャッシュヒット/ミス/CMATE.md削除時の3ケースが列挙されている
5. **依存関係が整理**: Issue #406/#407 との推奨マージ順序が明記されている

---

## 参照ファイル

### コード
- `src/lib/schedule-manager.ts`: 主要変更対象（ManagerState, syncSchedules, upsertSchedule, stopAllSchedules）
- `src/lib/db-migrations.ts`: version 21マイグレーション追加対象
- `src/lib/session-cleanup.ts`: stopAllSchedules()のグローバル呼び出し（Issue #407で修正予定）
- `tests/unit/lib/schedule-manager.test.ts`: mtimeキャッシュのテスト追加対象
- `tests/unit/lib/db-migrations.test.ts`: CURRENT_SCHEMA_VERSIONアサーション更新対象

### ドキュメント
- `CLAUDE.md`: session-cleanup.tsの説明にstopScheduleForWorktree()の記載あり（実装未存在、Issue #409スコープ外）

---

## レビュー履歴

| Stage | レビュー種別 | 日付 | Must Fix | Should Fix | Nice to Have |
|-------|------------|------|----------|------------|-------------|
| Stage 1 | 通常レビュー（1回目） | 2026-03-03 | 4 | 5 | 2 |
| Stage 2 | 指摘事項反映（1回目） | 2026-03-03 | - | - | - |
| Stage 3 | 影響範囲レビュー（1回目） | 2026-03-03 | 2 | 6 | 2 |
| Stage 4 | 指摘事項反映（1回目） | 2026-03-03 | - | - | - |
| **Stage 5** | **通常レビュー（2回目）** | **2026-03-03** | **0** | **2** | **2** |

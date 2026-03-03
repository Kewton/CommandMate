# Stage 1: 通常レビュー（設計原則） - Issue #409

## レビュー情報

| 項目 | 内容 |
|------|------|
| Issue | #409 - perf: DBインデックス追加とスケジュールマネージャのクエリ効率化 |
| ステージ | Stage 1: 通常レビュー（設計原則） |
| レビュー日 | 2026-03-03 |
| 対象文書 | `dev-reports/design/issue-409-schedule-perf-design-policy.md` |
| 対象ソース | `src/lib/schedule-manager.ts`, `src/lib/db-migrations.ts` |

## サマリ

| 区分 | 件数 |
|------|------|
| must-fix | 2 |
| should-fix | 4 |
| nice-to-have | 4 |
| **合計** | **10** |

設計方針書全体としては、mtimeキャッシュ導入、トランザクションバッチ化、複合インデックス追加という3つの改善が明確に定義されており、技術選定の根拠も十分に記載されている。KISS/YAGNIの観点からもスコープが適切に絞られている。

ただし、(1) Cronジョブの状態整合性に関するエラーリカバリの記述不足、(2) CMATE.md削除時の動作フローの暗黙性、(3) DRY原則に基づくファイル名定数の再利用、(4) 既存関数の削除方針の明記、の4点について改善が必要である。

---

## 指摘事項

### DR1-001 [should-fix] CMATE_FILENAME定数の二重定義（DRY）

**場所**: 設計方針書 Section 6 - `getCmateMtime()` / `cmate-parser.ts` `readCmateFile()`

**問題**:
`getCmateMtime()`の設計コードでは `path.join(worktreePath, 'CMATE.md')` とファイル名をハードコードしているが、既存の `cmate-parser.ts` では `CMATE_FILENAME` 定数を使用している。

```typescript
// 設計方針書のコード（ハードコード）
function getCmateMtime(worktreePath: string): number | null {
  const filePath = path.join(worktreePath, 'CMATE.md');
  // ...
}
```

```typescript
// 既存コード（定数使用） - src/lib/cmate-parser.ts L312
const filePath = path.join(worktreeDir, CMATE_FILENAME);
```

ファイル名が2箇所で定義される形になりDRY原則に違反する。

**改善案**: `getCmateMtime()`でも`CMATE_FILENAME`定数を`@/config/cmate-constants.ts`からimportして使用する。

---

### DR1-002 [should-fix] upsertSchedule()の削除方針が未明記（SRP）

**場所**: 設計方針書 Section 7 - `batchUpsertSchedules()`

**問題**:
`batchUpsertSchedules()`は既存`upsertSchedule()`を完全に置換する設計だが、`upsertSchedule()`を削除するか残すかが設計方針書で明言されていない。Section 13では「既存upsertSchedule()はbatchUpsertSchedules()に置換」とあるが、「削除する」とは書かれていない。

もし両方が残存した場合、同じ`scheduled_executions`テーブルに対する2つのupsert関数が存在し、SRP観点でメンテナンス上の混乱を招く。

**改善案**: 設計方針書に「`upsertSchedule()`は`batchUpsertSchedules()`に完全に置き換えられ、削除する」と明記する。

---

### DR1-003 [nice-to-have] mtime未変更時のscheduleId復元走査（KISS）

**場所**: 設計方針書 Section 6 - mtime未変更時のscheduleId復元ロジック

**問題**:
mtime未変更時に`manager.schedules`を全走査して当該worktreeIdに属するscheduleIdを収集するロジック:

```typescript
for (const [scheduleId, state] of manager.schedules) {
  if (state.worktreeId === worktree.id) {
    activeScheduleIds.add(scheduleId);
  }
}
```

100 worktree x 5 scheduleで最大500件のMap走査が毎サイクルで発生する。現状の規模では問題ないが、逆引きMapがあればO(1)になる。

**改善案**: KISS優先で現状の方式を維持し、走査コストが許容範囲内である旨のコメントをコードに追加するのが妥当。

---

### DR1-004 [must-fix] Cronジョブの状態整合性リカバリ未記述（OCP）

**場所**: 設計方針書 Section 6 - syncSchedules()処理フロー Step 3c / Section 8

**問題**:
mtime未変更でスキップする場合、CMATE.mdの内容は同一でもメモリ上のCronジョブが何らかの理由で停止・消失していた場合のリカバリが設計されていない。

具体的には、以下のシナリオを考える:
1. 初回syncSchedules()でCronジョブ作成、mtimeキャッシュ設定
2. 外部要因（メモリ圧迫など）でglobalThisの一部が破損、またはCronライブラリの内部エラーでジョブが停止
3. 次のsyncSchedules()でmtime未変更 -> パース・Cronジョブ再作成スキップ

Section 8のエラーハンドリングではdb.transaction()失敗のみを扱い、Cronジョブの状態整合性については言及がない。

**改善案**: 以下のいずれかを設計方針書に追記する:
- (A) mtime未変更時でも`manager.schedules`にcronJobが存在しないscheduleIdがあればキャッシュを無効化して再パースするフォールバック
- (B) globalThisが破損した場合は`initialized`フラグも失われるため全体再初期化されるという理由の明記（Section 13の設計決定事項に追記）

現実的には(B)が正しい -- `globalThis.__scheduleManagerStates = undefined`になればinitScheduleManager()の`if (manager.initialized)`チェックで再初期化される。この動作保証をSection 8またはSection 13に明記すべき。

---

### DR1-005 [should-fix] ManagerState interfaceのキャッシュ混在（ISP）

**場所**: 設計方針書 Section 5 - ManagerState interface拡張

**問題**:
ManagerState interfaceにスケジュール管理フィールド（timerId, schedules, initialized）とキャッシュフィールド（cmateFileCache）が混在する。Issue #407でworktree単位のキャッシュクリーンアップが必要になった際、ManagerStateへの依存が増大する。

**改善案**: 現時点では直接追加で問題ない。ただし、キャッシュ操作用のヘルパー関数（`clearCmateCache()`, `clearAllCmateCache()`）を設計方針書に記載し、Issue #407との接続点を明確にする。

---

### DR1-006 [nice-to-have] 冗長インデックスの判断根拠不足（DRY）

**場所**: 設計方針書 Section 4 - 既存インデックスの状態

**問題**:
新規複合インデックス`(worktree_id, enabled)`は、既存の`idx_scheduled_executions_worktree (worktree_id)`をプレフィクスとしてカバーする。SQLiteのインデックスはB-tree構造であるため、複合インデックスの先頭カラムは単独インデックスと同等の検索効率を持つ。

設計方針書では「明示的に残す」としているが、冗長なインデックスは書き込み時のオーバーヘッド（INSERT/UPDATE/DELETE時に2つのインデックスを更新）になる。

**改善案**: 設計方針書に判断根拠を追記する。例: 「`idx_scheduled_executions_worktree`は複合インデックスのプレフィクスでカバー可能だが、既存マイグレーション（version 17）で作成されたインデックスを削除するとロールバック時の整合性が複雑になるため残存させる」

---

### DR1-007 [should-fix] prepared statementのキャッシュ方針（SRP）

**場所**: 設計方針書 Section 7 - `batchUpsertSchedules()` DB操作

**問題**:
`batchUpsertSchedules()`内でdb.prepare()を毎回呼び出す設計になっている:

```typescript
function batchUpsertSchedules(...): string[] {
  const db = getLazyDbInstance();
  // ...
  const updateStmt = db.prepare(`UPDATE scheduled_executions ...`);
  const insertStmt = db.prepare(`INSERT INTO scheduled_executions ...`);
  // ...
}
```

better-sqlite3のdb.prepare()は内部的にキャッシュされるため実害はないが、60秒ごとに最大100回（worktree数分）呼ばれるため、意図が不明瞭になる。

**改善案**: better-sqlite3のprepare()がキャッシュされる動作に関するコメントを関数内に追加する。または、getLazyDbInstance()の特性（遅延初期化）を考慮し、DB初期化後にprepared statementをモジュールスコープでキャッシュするパターンの採用を検討する。

---

### DR1-008 [nice-to-have] stopAllSchedules()でのキャッシュクリア未記載（YAGNI）

**場所**: 設計方針書 Section 12 - 依存関係・マージ順序

**問題**:
設計方針書ではIssue #407でcmateFileCacheのworktree単位クリーンアップを対応する旨が記載されているが、本Issue #409のスコープで最低限必要な`stopAllSchedules()`でのcmateFileCache.clear()が記載されていない。

`stopAllSchedules()`の既存コード（L502）:
```typescript
manager.schedules.clear();
```

ここにcmateFileCache.clear()を追加しないと、stopAllSchedules()後のre-initializeでstaleなキャッシュが残る。

**改善案**: Section 6のフローまたはstopAllSchedules()の変更箇所として`cmateFileCache.clear()`を明記する。

---

### DR1-009 [must-fix] CMATE.md削除時の動作フローの暗黙性（設計の明確性）

**場所**: 設計方針書 Section 6 - syncSchedules() Step 3b

**問題**:
CMATE.md削除時のフローで以下の動作が暗黙的:

1. getCmateMtime() -> null
2. キャッシュにエントリあり -> CMATE.md削除とみなす
3. キャッシュエントリ除去 -> continue
4. **暗黙**: activeScheduleIdsにそのworktreeのscheduleIdが追加されない
5. **暗黙**: Step 4のClean Upで該当cronJobが停止・削除される
6. **暗黙**: disableStaleSchedules()でDB上のscheduleがdisabledになる

Step 4-6の動作は論理的に正しいが、「CMATE.md削除 -> スケジュール無効化」という重要なビジネスロジックが暗黙的に実現されている。

**改善案**: Section 6のフロー説明にStep 3bの結果として以下を明記する:
「CMATE.md削除時: activeScheduleIdsにそのworktreeのscheduleIdを追加しないことで、Step 4のClean Upフェーズで当該worktreeの全cronJobが停止・削除され、disableStaleSchedules()でDBレコードもdisabledになる」

---

### DR1-010 [nice-to-have] getAllWorktrees()のキャッシュ不要判断（KISS）

**場所**: 設計方針書 Section 11 / Section 13

**問題**:
getAllWorktrees()は毎サイクル実行される設計だが、worktreeリストのキャッシュも検討可能。ただしSection 13で「worktree追加/削除の検出に必要」と正当な理由が記載されている。

**改善案**: 追加アクション不要。Section 13の記載で十分。

---

## 設計原則別サマリ

### SOLID原則

| 原則 | 評価 | 備考 |
|------|------|------|
| SRP | B | batchUpsertSchedules()は明確な責務を持つが、upsertSchedule()の削除方針が不明（DR1-002, DR1-007） |
| OCP | B | mtimeキャッシュ導入は既存コードへの変更を局所化しているが、Cronジョブリカバリの拡張ポイントが不足（DR1-004） |
| LSP | A | 該当なし（継承関係なし） |
| ISP | B | ManagerState interfaceの肥大化リスクは低いが注意（DR1-005） |
| DIP | A | getLazyDbInstance()による遅延初期化は適切。具体的なDB実装への依存は既存パターンと一致 |

### KISS原則

**評価: A**

mtimeキャッシュは最小限の複雑さで最大の効果を得る設計。fs.watch/chokidarを採用しなかった判断、ファイルハッシュを不採用とした判断はいずれもKISS原則に沿っている。

### YAGNI原則

**評価: A**

スコープが明確に定義されており、Issue #406（非同期化）とIssue #407（session-cleanup修正）を明示的にOut of Scopeとしている。stopAllSchedules()でのcmateFileCache.clear()のみ追記が必要（DR1-008）。

### DRY原則

**評価: B**

CMATE_FILENAME定数の再利用（DR1-001）、インデックス冗長性の判断根拠（DR1-006）について改善余地あり。

### 設計の明確性

**評価: B**

全体的に明確だが、CMATE.md削除時の暗黙フロー（DR1-009）とCronジョブリカバリ（DR1-004）について設計方針書上の記述を充実させるべき。

---

## 総合評価

本設計方針書は、パフォーマンス改善の3つの軸（mtimeキャッシュ、トランザクションバッチ化、複合インデックス）を明確に定義しており、技術選定の根拠、パフォーマンス見積もり、マージ順序の考慮も十分に行われている。

must-fixの2件（DR1-004: Cronジョブ整合性の設計根拠明記、DR1-009: 削除フローの明示化）は、いずれも設計方針書への記述追加で対応可能であり、アーキテクチャの変更を要するものではない。

should-fixの4件についても、実装品質を高めるための改善であり、設計の方向性を変更するものではない。

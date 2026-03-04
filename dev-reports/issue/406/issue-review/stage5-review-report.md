# Issue #406 レビューレポート

**レビュー日**: 2026-03-04
**フォーカス**: 通常レビュー
**イテレーション**: 2回目（Stage 5）
**ステージ**: Stage 4 までの指摘反映後の再チェック

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

**総合評価**: good

Stage 1 (通常レビュー1回目) で指摘された must_fix 2件・should_fix 4件、Stage 3 (影響範囲レビュー1回目) で指摘された must_fix 2件・should_fix 4件の大半が適切に対応されている。残存する指摘は should_fix 2件と nice_to_have 2件のみであり、Issue の品質は大幅に向上している。

---

## 前回指摘の対応状況

### Stage 1 レビュー結果

| ID | 重要度 | 対応状況 | 備考 |
|----|--------|---------|------|
| R1-001 | must_fix | 対応済み | readCmateFile() async化とreadFileSync置換が実装タスクに追加 |
| R1-002 | must_fix | 対応済み | syncSchedules() async化、fire-and-forget、catch パターンを追加 |
| R1-003 | should_fix | 対応済み | 受入条件を readCmateFile() 含めた表現に拡充 |
| R1-004 | should_fix | 対応済み | 背景セクションに getCmateMtime() statSync スコープ外理由を明記 |
| R1-005 | should_fix | 対応済み | 行番号を現在のコードに合わせて更新 |
| R1-006 | should_fix | 対応済み | テスト更新タスクに具体的なパターン変更を明記 |
| R1-007 | nice_to_have | 対応済み | fire-and-forget 設計を明記 |
| R1-008 | nice_to_have | 未対応 | 定量的パフォーマンス見積もり（許容範囲） |

### Stage 3 レビュー結果

| ID | 重要度 | 対応状況 | 備考 |
|----|--------|---------|------|
| R3-001 | must_fix | 対応済み | mockReturnValue → mockResolvedValue タスク追加 |
| R3-002 | must_fix | 部分対応 | fs/promises 対応は記載されたが方針未確定 (R5-001) |
| R3-003 | should_fix | 対応済み | export 維持 + Promise<boolean> 戻り値型を明記 |
| R3-004 | should_fix | 部分対応 | ENOENT 確認はタスクに含むが受入条件に未反映 (R5-002) |
| R3-005 | should_fix | 対応済み | CLAUDE.md を影響範囲テーブルに追加 |
| R3-006 | should_fix | 対応済み | setInterval の .catch() パターン明記 |
| R3-007 | nice_to_have | 対応済み | import 文変更を影響範囲に記載 |
| R3-008 | nice_to_have | 未対応 | cmate-validator.ts 注記（許容範囲） |

---

## Should Fix（推奨対応）

### R5-001: schedule-manager.test.ts の fs モック変更方針が二択のまま未確定

**カテゴリ**: completeness
**場所**: 実装タスク - schedule-manager.test.ts 関連タスク

**問題**:
実装タスクに「schedule-manager.test.ts の `vi.doMock('fs', ...)` を `fs/promises` 対応に変更」と記載されているが、具体的な方針が未確定である。

テストファイル (`tests/unit/lib/schedule-manager.test.ts` L277-281) では `vi.doMock('fs', ...)` で `readFileSync`、`realpathSync`、`statSync` をまとめてモック化している。cmate-parser.ts の async 化後は `readFileSync` と `realpathSync` が `fs/promises` モジュールの `readFile` と `realpath` に移行するが、`statSync` は `schedule-manager.ts` 内の `getCmateMtime()` (L163) で引き続き同期的に使用される。

方針 (A) の場合、`fs` モジュール（statSync用）と `fs/promises` モジュール（readFile/realpath用）の2つを同時にモック化する必要があり、テストの複雑さが増す。方針 (B) の cmate-parser モジュール自体のモック化であれば、fs モジュールへの依存を排除でき保守性が向上する。

**推奨対応**:
実装タスクを以下のいずれかに具体化する:
- **(A)**: `vi.doMock('fs', ...)` の `statSync` モックは維持し、新たに `vi.doMock('fs/promises', ...)` で `readFile`/`realpath` をモック化する
- **(B)**: cmate-parser モジュール自体を `vi.mock()` でモック化し、`readCmateFile()` の戻り値を直接制御する（fs モックへの依存を排除）

方針 (B) の方がテストの意図が明確になり保守性が高いため推奨。

---

### R5-002: readCmateFile() の ENOENT エラー処理の受入条件が不足

**カテゴリ**: completeness
**場所**: 受入条件

**問題**:
`readCmateFile()` (`src/lib/cmate-parser.ts` L314-328) の catch ブロックは ENOENT コードでファイル不存在を判定し `null` を返す。`realpathSync()` → `fs.promises.realpath()` および `readFileSync()` → `fs.promises.readFile()` の置換後、ENOENT エラーの挙動が同一であることの検証は重要だが、受入条件に含まれていない。

実装タスクの `realpathSync` 置換タスクに「ENOENT エラー時の動作確認含む」と記載されている点は適切だが、受入条件にはこの検証基準が明示されていない。

**推奨対応**:
受入条件に以下を追加する: 「`readCmateFile()` が CMATE.md 不存在時に `null` を返す動作が async 化後も維持されること（テストで検証）」

---

## Nice to Have（あれば良い）

### R5-003: initScheduleManager() fire-and-forget 設計判断の根拠

**カテゴリ**: clarity
**場所**: 実装タスク - initScheduleManager 関連タスク

**問題**:
`initScheduleManager()` 内の `syncSchedules()` を `void syncSchedules()` (fire-and-forget) にする設計判断は記載されているが、その根拠が未記載である。`server.ts` (L260) が `initScheduleManager()` を同期呼び出ししているため、`initScheduleManager()` を async にすると `server.ts` にも変更が波及する。fire-and-forget にすることでこの波及を回避できるという意図を明記すると理解が深まる。

**推奨対応**:
実装タスクの該当項目に補足を追加: 「-- initScheduleManager() の同期 API を維持し、server.ts への変更波及を回避するため」

---

### R5-004: validateCmatePath() テスト更新の正常系パターン明記

**カテゴリ**: clarity
**場所**: 実装タスク - テスト更新タスク

**問題**:
テスト更新タスクで `.toThrow()` → `.rejects.toThrow()` の変更は記載済みだが、正常系のテストパターン変更（`expect(() => validateCmatePath(...)).not.toThrow()` → `expect(validateCmatePath(...)).resolves.toBe(true)`）が明記されていない。

テストファイル (`tests/unit/lib/cmate-parser.test.ts` L378) の正常系パターンも async 化に伴い変更が必要。

**推奨対応**:
テスト更新タスクに正常系パターンの変更も含めて明記する。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/cmate-parser.ts` (L15, L80-98, L311-329) | 変更対象: import文、validateCmatePath()、readCmateFile() |
| `src/lib/schedule-manager.ts` (L478-591, L603-626) | syncSchedules() async化、initScheduleManager() fire-and-forget |
| `tests/unit/lib/schedule-manager.test.ts` (L273-338) | mtime cache テストの fs モック方針が未確定 |
| `tests/unit/lib/schedule-manager-cleanup.test.ts` (L79) | readCmateFile モック更新（対応済み） |
| `tests/unit/lib/cmate-parser.test.ts` (L358-391) | validateCmatePath テスト async/await 対応 |
| `server.ts` (L260) | initScheduleManager() 呼び出し元（変更不要） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | cmate-parser.ts と schedule-manager.ts のモジュール説明更新（影響範囲に記載済み） |

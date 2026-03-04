# Issue #406 Stage 7 レビューレポート

**レビュー日**: 2026-03-04
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |
| **全体品質** | **Good** |

Stage 3 で発見された 8 件の指摘事項（R3-001 -- R3-008）は全て対応済みである。特に、R3-002（schedule-manager.test.ts のモック方針）は Stage 5 (R5-001) で再指摘され、Stage 6 で方針(B)（cmate-parser モジュール自体の vi.mock()）に確定した。本 Stage 7 では、方針(B) の具体的な実装詳細（パス指定方法、テスト分離、statSync モック維持）について 3 件の Should Fix を指摘した。

---

## Stage 3 指摘事項の対応状況

| ID | 指摘内容 | ステータス |
|----|---------|-----------|
| R3-001 | schedule-manager-cleanup.test.ts の mockReturnValue -> mockResolvedValue | 対応済み |
| R3-002 | schedule-manager.test.ts の fs モック方針 | 対応済み（方針(B)確定） |
| R3-003 | validateCmatePath() の export 維持と Promise<boolean> | 対応済み |
| R3-004 | ENOENT エラー処理の確認 | 対応済み（受入条件にも追加） |
| R3-005 | CLAUDE.md の更新 | 対応済み（影響範囲テーブルに追加） |
| R3-006 | setInterval の .catch() パターン | 対応済み |
| R3-007 | import 文変更の明示 | 対応済み |
| R3-008 | cmate-validator.ts 影響なし注記 | 対応済み |

---

## Should Fix（推奨対応）

### R7-001: vi.mock パス指定方法の明示

**カテゴリ**: テスト
**場所**: 実装タスク - schedule-manager.test.ts 関連タスク

**問題**:
方針(B) として cmate-parser モジュールを vi.mock() でモック化する際のパス指定方法が未記載である。

schedule-manager.test.ts では既に vi.mock('../../../src/lib/db-instance', ...) の相対パスパターンを使用しており（L20）、schedule-manager-cleanup.test.ts でも vi.mock('../../../src/lib/cmate-parser', ...) の相対パスパターンを使用している（L78）。Vitest の resolve.alias 設定（vitest.config.ts L34-35）により '@/lib/cmate-parser' パスも動作するが、ファイル内規約の一貫性を保つなら相対パスが適切である。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager.test.ts` L20: `vi.mock('../../../src/lib/db-instance', ...)`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager-cleanup.test.ts` L78: `vi.mock('../../../src/lib/cmate-parser', ...)`

**推奨対応**:
実装タスクに「vi.mock('../../../src/lib/cmate-parser', ...)」のパス指定を明記する。

---

### R7-002: vi.mock() 適用時のテスト分離戦略の明確化

**カテゴリ**: テスト
**場所**: 実装タスク - schedule-manager.test.ts 関連タスク

**問題**:
vi.mock() はファイルスコープで動作するため、schedule-manager.test.ts 内の全テストケースで readCmateFile() がモック化される。以下のテスト群への影響を確認した:

1. **initScheduleManager テスト群** (L106-128): readCmateFile() が null を返す前提で動作しており、mockResolvedValue(null) で問題なし
2. **stopAllSchedules テスト群** (L130-164): readCmateFile() に依存しないため問題なし
3. **batchUpsertSchedules テスト群** (L172-270): 直接 DB 操作のため readCmateFile() に依存しない
4. **mtime cache テスト 'should skip DB queries when mtime is unchanged'** (L274-312): readCmateFile() がパース済み CmateConfig を返す必要がある。mockResolvedValueOnce() で個別に上書きする必要あり
5. **その他の mtime cache テスト** (L314-338): readCmateFile(null) で動作するため問題なし

テスト 4 番のモック戦略が明示されていない。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager.test.ts` L274-312: mtime cache テストで readCmateFile() が CmateConfig を返す必要がある箇所

**推奨対応**:
実装タスクに補足を追加する: 「vi.mock() のデフォルトは mockResolvedValue(null) とし、mtime cache テストの 'should skip DB queries when mtime is unchanged' では mockResolvedValueOnce() で CmateConfig を返すようモックを上書きする」。

---

### R7-003: statSync モック維持方法の設計判断

**カテゴリ**: テスト
**場所**: 実装タスク - schedule-manager.test.ts 関連タスク

**問題**:
方針(B) で cmate-parser モジュール自体をモック化しても、schedule-manager.ts の getCmateMtime() (L163) が直接 statSync() を呼び出しているため、fs モジュールの statSync モックは引き続き必要である。

現在のテスト (L277-281) は vi.doMock('fs', ...) で statSync/readFileSync/realpathSync を一括モック化しているが、方針(B) 採用後は readFileSync/realpathSync モックが不要になる。残る問題は:

1. vi.doMock() は動的 import と組み合わせないと効果がない場合がある（schedule-manager.ts は static import で fs を読み込んでいる）
2. vi.mock('fs', ...) に切り替える場合はファイルスコープで適用され、全テストに影響する

statSync のモック方法の設計判断が記載されていない。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/schedule-manager.ts` L20: `import { statSync } from 'fs';` (static import)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/schedule-manager.ts` L163: `return statSync(filePath).mtimeMs;`

**推奨対応**:
実装タスクに注記を追加する: 「statSync は schedule-manager.ts の static import で使用されているため、vi.mock('fs', ...) でファイルスコープモック化し、statSync のみをモック関数として定義する。readFileSync/realpathSync は cmate-parser モジュールのモック化で不要になるため fs モックから除外する」。

---

## Nice to Have（あれば良い）

### R7-004: initScheduleManager() 初回 syncSchedules() の .catch() 設計根拠の注記

**カテゴリ**: 影響範囲
**場所**: 実装タスク - initScheduleManager 関連タスク

**問題**:
setInterval 内の呼び出しには `void syncSchedules().catch(...)` パターンが記載されている一方、initScheduleManager() 内の初回呼び出しは `void syncSchedules()` (.catch() なし) としている。syncSchedules() 内部の try-catch (L486, L574) で全エラーが捕捉されるため .catch() は不要だが、両者の非対称性の設計根拠が暗黙的である。

**推奨対応**:
initScheduleManager() 側の実装タスクに「syncSchedules() 内部の try-catch で全エラーが捕捉されるため .catch() は省略可（setInterval 側との差異は意図的）」または、統一して両方とも `.catch()` パターンにする旨を注記する。

---

### R7-005: 影響範囲テーブル内の schedule-manager.test.ts 変更内容の具体化

**カテゴリ**: ドキュメント
**場所**: 影響範囲テーブル

**問題**:
影響範囲テーブルに schedule-manager.test.ts が追加されているが、変更内容の記載を具体化するとよい。

**推奨対応**:
変更内容を「vi.mock('cmate-parser')でモック化（readCmateFile を mockResolvedValue(null)）、vi.doMock('fs') から readFileSync/realpathSync を削除し statSync のみ維持（vi.mock('fs') へ移行）」に更新する。

---

## 新規影響範囲チェック結果

Stage 3 の指摘に加え、以下の追加影響チェックを実施した:

| チェック対象 | 結果 | アクション |
|------------|------|-----------|
| schedule-manager.test.ts 全テストケースへの vi.mock 影響 | initScheduleManager/stopAllSchedules/batchUpsertSchedules テストは影響なし。mtime cache の 1 テストのみ要個別対応 | R7-002 で指摘 |
| vi.doMock('fs') のスコープと static import の関係 | vi.doMock() は dynamic import 用であり、static import に対する効果が不確実 | R7-003 で指摘 |
| syncSchedules() async 化で影響を受ける内部関数 | readCmateFile() のみ。他の内部関数は sync のまま | 問題なし |
| readCmateFile() の try-catch 構造（async 化後） | await validateCmatePath() + await readFile() が同一 try-catch 内。構造維持 | 問題なし |
| schedule-manager-cleanup.test.ts のモック変更影響 | readCmateFile は全テストで呼ばれない。mockResolvedValue(null) への変更は正確性のためのみ | 問題なし |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/cmate-parser.ts`: 変更対象（validateCmatePath/readCmateFile の async 化）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/schedule-manager.ts`: 呼び出し元（syncSchedules async 化、getCmateMtime statSync 維持）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/cmate-validator.ts`: 影響なし確認済み

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/cmate-parser.test.ts`: validateCmatePath テスト async 対応
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager.test.ts`: vi.mock('cmate-parser') 追加、fs モック改修
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager-cleanup.test.ts`: mockResolvedValue(null) 変更

### 設定
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/vitest.config.ts`: resolve.alias 設定（vi.mock パス解決）

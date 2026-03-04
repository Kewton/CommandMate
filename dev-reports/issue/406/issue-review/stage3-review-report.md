# Issue #406 Stage 3 レビューレポート

**レビュー日**: 2026-03-04
**フォーカス**: 影響範囲レビュー（変更の波及効果、隠れた依存関係、型変更の影響）
**イテレーション**: 1回目
**ステージ**: 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

Stage 2 反映後の Issue は、主要な変更対象（cmate-parser.ts, schedule-manager.ts, cmate-parser.test.ts）を適切に特定しているが、テストファイルのモック更新に関する漏れが 2 件存在する。特に `schedule-manager-cleanup.test.ts` と `schedule-manager.test.ts` の fs モックは、async 化後に動作不良を起こす可能性が高い。

---

## Must Fix（必須対応）

### R3-001: schedule-manager-cleanup.test.ts のモックが async 化後に不整合

**カテゴリ**: testing
**場所**: ## 影響範囲 / ## 実装タスク

**問題**:
`tests/unit/lib/schedule-manager-cleanup.test.ts` L79 で `readCmateFile` のモックが以下のように定義されている:

```typescript
vi.mock('../../../src/lib/cmate-parser', () => ({
  readCmateFile: vi.fn().mockReturnValue(null),
  parseSchedulesSection: vi.fn().mockReturnValue([]),
}));
```

`readCmateFile()` が async 化されると戻り値型は `Promise<CmateConfig | null>` になる。`mockReturnValue(null)` は同期的に `null` を返すため、`await readCmateFile()` は偶然 `null` に解決されるが、これは意図しない互換性である。正しくは `mockResolvedValue(null)` を使用すべき。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager-cleanup.test.ts` L78-81
- Issue の影響範囲テーブルに `schedule-manager-cleanup.test.ts` が含まれていない

**推奨対応**:
影響範囲テーブルに `tests/unit/lib/schedule-manager-cleanup.test.ts` を追加し、実装タスクに「readCmateFile モックを `mockReturnValue(null)` から `mockResolvedValue(null)` に変更」を追加する。

---

### R3-002: schedule-manager.test.ts の fs モックが async 化後に無効

**カテゴリ**: testing
**場所**: ## 影響範囲 / ## 実装タスク

**問題**:
`tests/unit/lib/schedule-manager.test.ts` L277-281 の mtime cache テスト群で、`vi.doMock('fs', ...)` を使用して `readFileSync` と `realpathSync` をモック化している:

```typescript
vi.doMock('fs', () => ({
  statSync: mockStatSync,
  readFileSync: vi.fn().mockReturnValue('## Schedules\n...'),
  realpathSync: vi.fn().mockImplementation((p: string) => p),
}));
```

async 化後、`cmate-parser.ts` は `fs.promises.readFile()` と `fs.promises.realpath()` を使用するため、上記のモックは効果を持たなくなる。`schedule-manager.test.ts` は `cmate-parser` モジュール自体をモック化していないため（`schedule-manager-cleanup.test.ts` とは異なるモック戦略）、この影響は顕在化する。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager.test.ts` L277-281
- `schedule-manager.test.ts` には `vi.mock('../../../src/lib/cmate-parser', ...)` が存在しない
- Issue の影響範囲テーブルに `schedule-manager.test.ts` が「テスト更新」として含まれていない

**推奨対応**:
影響範囲テーブルに `tests/unit/lib/schedule-manager.test.ts` を追加する。テスト修正方法として以下の2択がある:
- (A) `vi.doMock('fs/promises', ...)` に変更し `readFile`/`realpath` をモック化する
- (B) `cmate-parser` モジュール自体をモック化する（`schedule-manager-cleanup.test.ts` と同様のアプローチ）

実装タスクに対応項目を追加する。

---

## Should Fix（推奨対応）

### R3-003: validateCmatePath() の public export 維持に関する設計判断の明示

**カテゴリ**: type_system
**場所**: ## 実装タスク

**問題**:
`validateCmatePath()` は `export` されているが、実際の呼び出し元は以下の2箇所のみ:
1. `cmate-parser.ts` 内部の `readCmateFile()` (L316)
2. `cmate-parser.test.ts` のテスト (L378, L387)

外部モジュールからの直接呼び出しはない。async 化により `boolean` から `Promise<boolean>` への破壊的型変更が発生するが、外部呼び出しが存在しないため実影響はない。ただし、export を維持する以上、この型変更は public API の breaking change であり、設計意図を明示すべき。

**推奨対応**:
Issue 本文に設計判断として「validateCmatePath() は引き続き export する。戻り値型を `Promise<boolean>` に変更する」と記載する。

---

### R3-004: 同期 throw から非同期 reject への変更時の ENOENT エラー互換性

**カテゴリ**: error_handling
**場所**: ## 実装タスク

**問題**:
`readCmateFile()` の catch ブロック (L319-326) は ENOENT エラーを判定して `null` を返す:

```typescript
if (
  error instanceof Error &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT'
) {
  return null;
}
```

async 化後、`fs.promises.realpath()` と `fs.promises.readFile()` が ENOENT エラーを返す場合、同じ `NodeJS.ErrnoException` 形式（`code: 'ENOENT'`）であることを前提としている。Node.js の公式ドキュメントでは `fs.promises` API も同じ `ErrnoException` を使用するため問題はないが、実装時に明示的に確認すべき。

**推奨対応**:
実装タスクの注意事項として「`fs.promises.realpath()` / `fs.promises.readFile()` は ENOENT エラー時に `realpathSync()` / `readFileSync()` と同じ `NodeJS.ErrnoException` (code: 'ENOENT') を throw することをテストで確認する」を追記する。

---

### R3-005: CLAUDE.md のモジュール説明に async 化の変更が未反映

**カテゴリ**: documentation
**場所**: ## 影響範囲

**問題**:
CLAUDE.md の主要機能モジュールテーブルには:
- `cmate-parser.ts` (L177): `validateCmatePath()` と `readCmateFile()` の説明がある
- `schedule-manager.ts` (L180): `syncSchedules()` の説明がある

Issue #406 完了後、これらの関数が async 化されたことを CLAUDE.md に反映する必要があるが、影響範囲テーブルに CLAUDE.md が含まれていない。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/CLAUDE.md` L177, L180

**推奨対応**:
影響範囲テーブルに以下を追加する:

| ファイル | 変更内容 |
|---------|---------|
| `CLAUDE.md` | cmate-parser.ts エントリに async 化（validateCmatePath/readCmateFile）を記載、schedule-manager.ts エントリに syncSchedules の async 化を記載 |

---

### R3-006: setInterval 内の void syncSchedules() の UnhandledPromiseRejection 対策

**カテゴリ**: impact_scope
**場所**: ## 実装タスク

**問題**:
Issue のタスクでは `setInterval` 内の呼び出しを `void syncSchedules()` に変更すると記載している。`void` キーワードは Promise の結果を明示的に無視するが、`syncSchedules()` 内部でトップレベルの例外が発生した場合（`getManagerState()` の失敗など）、`UnhandledPromiseRejection` が発生し、Node.js プロセスがクラッシュする可能性がある。

現在の `syncSchedules()` は個別 worktree の処理を try-catch で保護しているが、関数のトップレベル（L479 `getManagerState()` の後、L480 `getAllWorktrees()` の前など）での例外は捕捉されない。

**推奨対応**:
以下いずれかのアプローチを実装タスクに記載する:
- (A) `syncSchedules()` の関数本体全体を try-catch で囲む
- (B) setInterval 内を `void syncSchedules().catch(err => console.error(...))` パターンにする

---

## Nice to Have（あれば良い）

### R3-007: cmate-parser.ts の import 文変更の明示

**カテゴリ**: impact_scope
**場所**: ## 影響範囲

`cmate-parser.ts` L15 の `import { readFileSync, realpathSync } from 'fs'` を `import { realpath, readFile } from 'fs/promises'` に変更する必要がある。影響範囲テーブルに関数変更のみ記載されているが、import 文の変更も含まれることを明示するとよい。

---

### R3-008: cmate-validator.ts との整合性確認（影響なし）

**カテゴリ**: impact_scope
**場所**: ## 影響範囲

`cmate-validator.ts` は `cmate-parser.ts` のクライアントサイド等価物だが、`cmate-parser.ts` からの import はなく、`@/config/cmate-constants` からのみ import している。`validateCmatePath()` / `readCmateFile()` の async 化は `cmate-validator.ts` に影響しない。この除外情報を注記として追加するとレビュアーの安心材料となる。

---

## 隠れた依存関係チェック結果

| 対象ファイル | 結果 | 根拠 |
|-------------|------|------|
| `src/lib/cmate-validator.ts` | 影響なし | `cmate-parser.ts` からの import なし。`@/config/cmate-constants` からのみ import |
| `server.ts` | 影響なし | `initScheduleManager()` は sync のまま維持（fire-and-forget 設計判断済み） |
| `src/lib/session-cleanup.ts` | 影響なし | `schedule-manager.ts` の sync API（stopAllSchedules/stopScheduleForWorktree）のみ呼び出し |
| `src/lib/resource-cleanup.ts` | 影響なし | `schedule-manager.ts` の sync API（getScheduleWorktreeIds）のみ参照 |
| `src/app/api/` ルート群 | 影響なし | `cmate-parser.ts` を直接 import していない |

---

## 影響範囲テーブル（修正提案）

現在の Issue の影響範囲テーブルに対する追加提案:

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/cmate-parser.ts` | `validateCmatePath()` と `readCmateFile()` を async 化（既存） |
| `src/lib/schedule-manager.ts` | `syncSchedules()` を async 化など（既存） |
| `tests/unit/lib/cmate-parser.test.ts` | テスト更新（既存） |
| `tests/unit/lib/schedule-manager.test.ts` | **追加**: mtime cache テストの fs モックを fs/promises 対応に更新 |
| `tests/unit/lib/schedule-manager-cleanup.test.ts` | **追加**: readCmateFile モックを mockResolvedValue(null) に変更 |
| `CLAUDE.md` | **追加**: cmate-parser.ts/schedule-manager.ts のモジュール説明に async 化を反映 |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/cmate-parser.ts` (L15, L80-98, L311-329): 変更対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/schedule-manager.ts` (L478-591, L603-626): 呼び出し元
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/cmate-validator.ts` (L1-17): 影響なし確認済み
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/server.ts` (L260): 影響なし確認済み

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/cmate-parser.test.ts` (L358-391): async/await 更新が必要（Issue 記載済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager.test.ts` (L273-338): fs モック更新が必要（Issue 未記載）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager-cleanup.test.ts` (L78-81): mockResolvedValue 変更が必要（Issue 未記載）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/CLAUDE.md` (L177, L180): モジュール説明の更新が必要（Issue 未記載）

# Architecture Review: Issue #406 - Impact Analysis (Stage 3)

**Date**: 2026-03-04
**Reviewer**: Architecture Review Agent
**Focus**: Impact Scope (影響範囲)
**Design Policy**: `dev-reports/design/issue-406-async-cmate-parser-design-policy.md`

---

## Executive Summary

Issue #406 proposes async-ifying synchronous I/O in `cmate-parser.ts` (replacing `realpathSync()`/`readFileSync()` with `fs.promises` equivalents) and propagating the async change to `syncSchedules()` in `schedule-manager.ts`. The impact analysis review confirms that the design policy's identification of affected files is **substantially complete and accurate**. The change is well-scoped with minimal cascade effects, as `readCmateFile()` is called from only one location (`schedule-manager.ts` L516) and `syncSchedules()` is a module-internal function.

One must-fix finding relates to test implementation details for the `schedule-manager.test.ts` mtime cache tests, where the async fire-and-forget pattern requires explicit await strategies. Three should-fix findings address documentation gaps regarding error propagation, real-filesystem test migration, and initialization order safety.

**Status**: Conditionally Approved (4/5)

---

## Impact Scope Analysis

### 1. Direct Change Files

| File | Change | Risk |
|------|--------|------|
| `src/lib/cmate-parser.ts` | import変更 (`fs` -> `fs/promises`), `validateCmatePath()`/`readCmateFile()` async化 | Low |
| `src/lib/schedule-manager.ts` | `syncSchedules()` async化, `initScheduleManager()` fire-and-forget化, `setInterval` `.catch()` 追加 | Medium |
| `tests/unit/lib/cmate-parser.test.ts` | async/await テスト対応 (`resolves`/`rejects` マッチャー) | Low |
| `tests/unit/lib/schedule-manager.test.ts` | `vi.mock` 方式変更, async/await 対応 | Medium |
| `tests/unit/lib/schedule-manager-cleanup.test.ts` | `mockReturnValue(null)` -> `mockResolvedValue(null)` | Low |
| `CLAUDE.md` | モジュール説明更新 | Low |

### 2. Caller Verification

#### `readCmateFile()` callers

Verified by grep across entire `src/` directory:

- **Only caller**: `src/lib/schedule-manager.ts` L516 (`const config = readCmateFile(worktree.path)`)
- No API routes import `readCmateFile`
- No re-exports from barrel files
- `src/lib/cmate-validator.ts` has its own `parseCmateContent()` (independent client-side implementation importing from `@/config/cmate-constants`, not from `cmate-parser.ts`)

Design policy's claim at Section 7 is **verified correct**.

#### `validateCmatePath()` callers

- **Only caller**: `src/lib/cmate-parser.ts` L316 (internal call from `readCmateFile()`)
- Exported but no external callers exist (DJ-001 is accurate)
- Test file `cmate-parser.test.ts` L378/L387 calls it directly for testing purposes

#### `syncSchedules()` callers

- **Not exported** (module-internal function at L478)
- Called from `initScheduleManager()` L617 and `setInterval` callback L621
- No external callers possible

### 3. Cascade Effect Analysis

```
readCmateFile() async化
    |
    v
syncSchedules() async化 (module-internal)
    |
    +---> initScheduleManager() [sync API維持, void fire-and-forget]
    |         |
    |         +---> server.ts L260 [変更なし]
    |
    +---> setInterval callback [void + .catch() 追加]
```

The async change is fully contained within the `syncSchedules()` -> `readCmateFile()` call path. No cascade to:

- `stopAllSchedules()` (sync, no readCmateFile usage)
- `stopScheduleForWorktree()` (sync, no readCmateFile usage)
- `getScheduleWorktreeIds()` (sync, no readCmateFile usage)
- `batchUpsertSchedules()` (sync, called from syncSchedules but its own signature is unchanged)

### 4. Confirmed No-Impact Files

| File | Reason | Verified |
|------|--------|----------|
| `server.ts` | `initScheduleManager()` sync API maintained; fire-and-forget does not change return behavior | Yes |
| `src/lib/session-cleanup.ts` | Imports only `stopScheduleForWorktree()` (sync) | Yes |
| `src/lib/resource-cleanup.ts` | Imports only `stopScheduleForWorktree()` + `getScheduleWorktreeIds()` (both sync) | Yes |
| `src/lib/cmate-validator.ts` | No import from `cmate-parser.ts`; uses `@/config/cmate-constants` | Yes |
| `tests/unit/session-cleanup-issue404.test.ts` | Mocks `schedule-manager`; no internal dependency | Yes |
| `tests/unit/resource-cleanup.test.ts` | Mocks `schedule-manager`; no internal dependency | Yes |
| Integration tests | No files in `tests/integration/` reference affected functions | Yes |

---

## Detailed Findings

### Must Fix (1 item)

#### DR3-001: schedule-manager.test.ts mtime cache テストの async fire-and-forget 対応パターンが不足

**Severity**: must_fix
**Category**: Impact Completeness

**Problem**:

`schedule-manager.test.ts` L273-339 の mtime cache テストセクション（4テスト）は、`initScheduleManager()` を呼んで `syncSchedules()` の動作を間接的に検証している。async 化後、`initScheduleManager()` は `void syncSchedules()` を fire-and-forget で呼び出すため、`initScheduleManager()` が返った時点で `syncSchedules()` は未完了の可能性がある。

特に L274 のテスト「should skip DB queries when mtime is unchanged」では:
1. `initScheduleManager()` を呼ぶ (初回 sync が fire-and-forget)
2. `vi.advanceTimersByTime(POLL_INTERVAL_MS)` で2回目の sync をトリガー
3. DB prepare 呼び出し回数を比較

しかし、初回 sync の Promise が解決される前に2回目の sync がトリガーされる可能性があり、テスト結果が非決定的になる。

設計方針書 Section 4.3 では `await vi.advanceTimersByTimeAsync()` の使用に言及しているが、`initScheduleManager()` の初回 fire-and-forget 完了を待つための具体的な await パターンが記載されていない。

**Current Code** (`tests/unit/lib/schedule-manager.test.ts` L274-312):

```typescript
it('should skip DB queries when mtime is unchanged', () => {
  // ...mock setup...
  initScheduleManager();
  // At this point, syncSchedules() may not have completed!
  const callCountAfterFirst = dbSpy.mock.calls.length;
  vi.advanceTimersByTime(POLL_INTERVAL_MS);
  // ...assertions...
});
```

**Suggestion**:

Add concrete await patterns to Section 4.3 for handling the fire-and-forget initial sync. Options include:
- `await vi.advanceTimersByTimeAsync(0)` after `initScheduleManager()` to flush microtask queue
- Verify `vi.mocked(readCmateFile)` call counts instead of db.prepare counts
- Use `await vi.waitFor(() => expect(readCmateFile).toHaveBeenCalled())` pattern

---

### Should Fix (3 items)

#### DR3-002: DJ-002 fire-and-forget パターンの unhandled rejection 挙動の明記

**Severity**: should_fix
**Category**: Error Propagation

`initScheduleManager()` で `.catch()` なしの `void syncSchedules()` を使用する DJ-002 の判断は文書化されているが、`syncSchedules()` 内部の try-catch を突破する想定外エラー（モジュールロードエラー等）が unhandled rejection になった場合の挙動が明記されていない。

`server.ts` には `process.on('uncaughtException')` ハンドラはあるが `unhandledRejection` ハンドラは定義されていない。Node.js v15+ では unhandled rejection はプロセスを終了させる。

**Suggestion**: DJ-002 のトレードオフに「想定外エラーは unhandled rejection → プロセス終了となるが、起動直後のモジュールエラーは致命的であるため fail-fast として許容」を追記するか、DJ-003 同様に `.catch()` を付与して一貫性を保つ。

#### DR3-003: validateCmatePath テストの実ファイルシステム使用に関する注記

**Severity**: should_fix
**Category**: Test Coverage

`cmate-parser.test.ts` L358-391 の `validateCmatePath` テストは、実際に `fs.mkdtempSync` で一時ディレクトリを作成し、symlink を作成してパストラバーサル検出を検証している。async 化後も `fs.promises.realpath()` は実ファイルシステムの symlink を正しく解決するため、テストロジックはそのまま動作する。

設計方針書 Section 4.3 で async/await パターンの変更は記載されているが、このテストが実ファイルシステムを使用すること、およびモックが不要であることの確認注記がない。

**Suggestion**: Section 4.3 に「L358-391 の validateCmatePath テストは実ファイルシステムを使用しており、fs.promises.realpath() でも同一の動作をするためモック不要」の注記を追加。

#### DR3-004: server.ts 初期化順序の安全性根拠

**Severity**: should_fix
**Category**: Initialization Order

`server.ts` L260-263 の初期化順序:
```typescript
initScheduleManager();   // L260 - syncSchedules() は fire-and-forget
initResourceCleanup();   // L263 - 直後に呼ばれる
```

fire-and-forget 化により、`initResourceCleanup()` は `syncSchedules()` 完了前に実行される。`initResourceCleanup()` の初回 `runCleanupCycle()` は `getScheduleWorktreeIds()` を使用するが、schedules Map が空の状態でイテレートするだけなので安全。

**Suggestion**: Section 7 の影響なしファイル server.ts の理由に初期化順序の安全性根拠を追記。

---

### Consider (5 items)

| ID | Title | Assessment |
|----|-------|------------|
| DR3-005 | cmate-validator.ts の影響なし判定 | 正確。import 関係なし確認済み |
| DR3-006 | session-cleanup.ts/resource-cleanup.ts のカスケード不在 | 正確。sync API のみ使用 |
| DR3-007 | readCmateFile/validateCmatePath の public API 型変更 | 外部呼び出し元なし。TypeScript 型チェックで安全 |
| DR3-008 | 関連テストファイル (session-cleanup, resource-cleanup) への影響なし | 正確。モック化済みで内部実装非依存 |
| DR3-009 | integration テストへの影響なし | 正確。参照ファイルなし |

---

## Risk Assessment

| Risk Type | Level | Justification |
|-----------|-------|---------------|
| Technical | Medium | schedule-manager.test.ts の mtime cache テスト4件は async fire-and-forget パターンへの対応が必要で、テスト実装の複雑性がやや高い |
| Security | Low | パストラバーサル防御ロジックは不変。TOCTOU リスク増加は実質なし (SEC-406-002) |
| Operational | Low | server.ts の API は不変。initScheduleManager() の同期呼び出しパターンが維持される |

---

## Approval

**Status**: Conditionally Approved
**Score**: 4/5

**Conditions**:
1. DR3-001 (must_fix): `schedule-manager.test.ts` の async fire-and-forget 初回 sync の await パターンを設計方針書に追記すること
2. DR3-002 ~ DR3-004 (should_fix): 実装前にドキュメントへの追記を推奨（実装には直接影響しない）

**Positive Findings**:
- 影響範囲の識別は網羅的かつ正確
- `readCmateFile()` の呼び出し元確認 (schedule-manager.ts のみ) は正確
- カスケード効果が syncSchedules() 内部で完結する設計は適切
- server.ts への波及回避 (DJ-002) は合理的な判断
- テストファイルの変更対象 (3ファイル) は網羅的

---

*Generated by Architecture Review Agent - Stage 3: Impact Analysis Review*

# Architecture Review: Issue #406 Stage 2 - 整合性レビュー

## Executive Summary

Issue #406 の設計方針書（cmate-parser の同期 I/O 非同期化）について、コードベースとの整合性を中心にレビューを実施した。

設計方針書は高品質であり、記載された行番号・コードスニペット・呼び出し元の網羅的確認が全て現在のコードベースと正確に一致している。must_fix 指摘はなく、should_fix 2 件、nice_to_have 8 件（うち 5 件は肯定的所見）の結果となった。

**Status**: conditionally_approved (Score: 4/5)

---

## Review Scope

| 項目 | 内容 |
|------|------|
| Issue | #406 |
| Stage | 2 (整合性レビュー) |
| 設計方針書 | `dev-reports/design/issue-406-async-cmate-parser-design-policy.md` |
| レビュー対象 | 設計方針書とコードベースの整合性 |

---

## Detailed Findings

### should_fix (2 items)

#### DR2-001: schedule-manager.test.ts のモック方式の記載が現状コードと異なる

- **Category**: code_consistency
- **Location**: 設計方針書 Section 4.3「schedule-manager.test.ts」

設計方針書 Section 4.3 では schedule-manager.test.ts に対して、ファイルスコープの `vi.mock('fs', async (importOriginal) => {...})` で statSync のみをモック化するよう記載している。

しかし、現在の `schedule-manager.test.ts` (L277-281) は以下のように `vi.doMock('fs', ...)` をテスト内で使用し、`readFileSync` と `realpathSync` も含めてモック化している:

```typescript
// 現在のコード (L277-281)
vi.doMock('fs', () => ({
  statSync: mockStatSync,
  readFileSync: vi.fn().mockReturnValue('## Schedules\n...'),
  realpathSync: vi.fn().mockImplementation((p: string) => p),
}));
```

設計方針書の After は提案として正しいが、Before の現状との差異が明示されておらず、どの既存コードを置き換えるのかが不明瞭である。特に、現在の `vi.doMock` が `readFileSync`/`realpathSync` もモック化している理由（現在の `readCmateFile` が `fs` を直接使用しているため）と、提案後はそれが不要になる点の明記がない。

**Suggestion**: Section 4.3 の schedule-manager.test.ts 部分に、現在の `vi.doMock('fs', ...)` パターン（L277-281）を Before として明示し、After では cmate-parser モジュールモック導入により `readFileSync`/`realpathSync` のモックが不要になることを記載する。

---

#### DR2-006: import 文変更のプロジェクト内パターン統一注記

- **Category**: code_consistency
- **Location**: 設計方針書 Section 4.1「import文変更」

設計方針書の import 文変更で `import { realpath, readFile } from 'fs/promises'` と記載している。Node.js の `fs/promises` モジュールは `realpath` と `readFile` の両方を named export しており、この import 文は技術的に正しい。

しかし、プロジェクト内で `fs/promises` のインポートパターンが一貫しているか（`import { xxx } from 'fs/promises'` vs `import fs from 'fs'; fs.promises.xxx`）の確認注記があると実装時の迷いが減る。

**Suggestion**: プロジェクト内の `fs/promises` 使用パターンを確認し、既存パターンと統一する旨を注記する。

---

### nice_to_have (8 items, including 5 positive findings)

#### DR2-002: DJ-002 の try-catch カバレッジの正確性

- **Category**: code_consistency
- **Location**: 設計方針書 Section 3 DJ-002

DJ-002 で「syncSchedules() 内部の try-catch L486/L574 で全エラー捕捉済み」と記載しているが、L579-586 の stale schedule cleanup ループは per-worktree try-catch の外にある。`cronJob.stop()` が例外を throw する可能性は極めて低いため実質的なリスクは無視できるが、「全エラー捕捉」という表現は厳密には不正確。

---

#### DR2-003: cmate-validator.ts の影響なし判定

- **Category**: spec_consistency

Section 7 の「cmate-validator.ts は cmate-parser.ts からの import なし」という記載は正確であることを確認した。cmate-validator.ts は `@/config/cmate-constants` からのみ import しており、cmate-parser.ts とは完全に独立している。

---

#### DR2-004, DR2-005: 設計上の軽微な補足事項

いずれも対応不要。async 化のスコープが適切に限定されていること、コードスニペットの簡略表記が妥当であることを確認した。

---

#### DR2-007 (Positive): 実装チェックリストの整合性

Section 9 の実装チェックリスト全 12 項目が Section 4 の設計詳細と 1:1 で対応しており、漏れがない。

---

#### DR2-008 (Positive): Mermaid フロー図の正確性

変更前・変更後の Mermaid フロー図を実際のコードと照合した結果、全てのノードと矢印が正しく対応していることを確認した。

---

#### DR2-009 (Positive): 全行番号参照の正確性

設計方針書内で参照されている全ての行番号を実際のソースコードと照合した結果:

| 参照 | 設計書記載 | 実コード | 一致 |
|------|-----------|---------|------|
| cmate-parser.ts L15 | `import { readFileSync, realpathSync } from 'fs'` | 同一 | OK |
| cmate-parser.ts L80-98 | `validateCmatePath()` | 同一 | OK |
| cmate-parser.ts L311-329 | `readCmateFile()` | 同一 | OK |
| schedule-manager.ts L159-176 | `getCmateMtime()` | 同一 | OK |
| schedule-manager.ts L478-591 | `syncSchedules()` | 同一 | OK |
| schedule-manager.ts L485 | `for (const worktree of worktrees)` | 同一 | OK |
| schedule-manager.ts L486 | `try {` (per-worktree) | 同一 | OK |
| schedule-manager.ts L516 | `const config = readCmateFile(...)` | 同一 | OK |
| schedule-manager.ts L574 | `} catch (error) {` | 同一 | OK |
| schedule-manager.ts L617 | `syncSchedules();` | 同一 | OK |
| schedule-manager.ts L620-622 | `setInterval(...)` | 同一 | OK |
| schedule-manager-cleanup.test.ts L79 | `mockReturnValue(null)` | 同一 | OK |
| server.ts L260 | `initScheduleManager();` | 同一 | OK |

---

#### DR2-010 (Positive): readCmateFile() 呼び出し元の網羅性

`src/` 配下で `readCmateFile` を import/使用している箇所が `schedule-manager.ts` のみであること、`validateCmatePath()` が `readCmateFile()` 内部 (L316) からのみ呼び出されていることを grep により確認した。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | async 化に伴う呼び出し元への波及 | Low | Low | P3 |
| セキュリティ | TOCTOU リスク（既存と同等） | Low | Low | P3 |
| 運用リスク | fire-and-forget パターンのエラー見逃し | Low | Low | P3 |

---

## 整合性検証サマリー

### 1. コードスニペットの一致性

設計方針書に記載された Before コードスニペット（`validateCmatePath()`, `readCmateFile()`, `syncSchedules()`, `initScheduleManager()`, `setInterval`）は全て実際のコードと論理的に一致している。フォーマット上の簡略化（関数シグネチャの改行省略等）は許容範囲内。

### 2. ファイルパス・行番号の一致性

全 13 箇所の行番号参照が現在のコードベースと完全に一致している（上記 DR2-009 参照）。

### 3. 技術的実現可能性

- `fs.promises.realpath()` と `fs.promises.readFile()` は ENOENT 時に同一の `NodeJS.ErrnoException` を throw するため、既存の catch ブロックは変更不要。
- `syncSchedules()` の async 化と fire-and-forget パターンは技術的に実現可能。
- `vi.mock()` によるモジュールレベルモック（DJ-005 方針 B）は Vitest で正しく動作する。

### 4. セクション間の内部整合性

- DJ-002 と DJ-003 の `.catch()` 非対称性の根拠が Stage 1 指摘 (DR1-001) を受けて追記されており、整合している。
- DJ-006 が Section 6 パフォーマンス設計と Section 8 トレードオフ表の両方から参照されており、内部一貫性がある。
- Section 9 チェックリストが Section 4 設計詳細と 1:1 対応している。

### 5. Issue #406 要件との整合性

Issue #406 の目的「cmate-parser の同期 I/O を非同期化し、イベントループブロックを解消する」に対して、設計方針書は:
- `validateCmatePath()` と `readCmateFile()` の async 化を明確に定義
- `getCmateMtime()` の `statSync` をスコープ外として合理的に除外
- `initScheduleManager()` の sync API 維持による波及回避を適切に判断

---

## Improvement Recommendations

### 推奨改善項目 (Should Fix)

1. **DR2-001**: schedule-manager.test.ts の Before/After を明示化し、既存の `vi.doMock('fs', ...)` パターンとの差分を記載する
2. **DR2-006**: `fs/promises` import パターンのプロジェクト内一貫性を確認する注記を追加する

### 検討事項 (Consider)

1. **DR2-002**: DJ-002 の「全エラー捕捉」表現の厳密性を改善する（任意）

---

## Approval Status

**conditionally_approved** - should_fix 2 件は設計方針書の明瞭性に関するものであり、技術的な正確性には影響しない。これらの対応後、実装に進むことが可能。

---

*Reviewed: 2026-03-04*
*Reviewer: Architecture Review Agent (Stage 2: 整合性)*
*Design Doc: `dev-reports/design/issue-406-async-cmate-parser-design-policy.md`*

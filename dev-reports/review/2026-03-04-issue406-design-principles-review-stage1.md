# Architecture Review: Issue #406 - Design Principles (Stage 1)

## Executive Summary

Issue #406 の設計方針書「cmate-parserの同期I/O非同期化」を設計原則（SOLID, KISS, YAGNI, DRY）の観点からレビューした。全体的に設計品質は高く、変更スコープが適切に限定されている。KISS 原則に基づくシンプルな設計判断（initScheduleManager() の sync API 維持、statSync のスコープ外判断、逐次処理の維持）は妥当である。

must_fix 1件、should_fix 3件、nice_to_have 6件を検出。must_fix は設計判断の記載形式に関する一貫性の問題であり、実装上のリスクは低い。

**Status**: Conditionally Approved (Score: 4/5)

---

## Review Details

### Focus Area: 設計原則 (Design Principles)

| 原則 | 評価 | 備考 |
|------|------|------|
| Single Responsibility (SRP) | OK | cmate-parser.ts のI/O関数と純粋関数の責務境界が維持されている |
| Open/Closed (OCP) | OK | 既存の parseCmateFile/parseSchedulesSection は変更なし |
| Liskov Substitution (LSP) | OK | 該当する継承関係なし |
| Interface Segregation (ISP) | OK | export 関数のインターフェースは最小限 |
| Dependency Inversion (DIP) | OK | fs/promises への依存は I/O 層に限定 |
| KISS | Good | スコープ限定と既存パターン維持の判断が適切 |
| YAGNI | Good | 並列化やstatSync非同期化を明示的にスコープ外としている |
| DRY | OK | fire-and-forget パターンの軽微な重複あり（低リスク） |

---

## Findings

### Must Fix (1件)

#### DR1-005: syncSchedules() の逐次 await 設計判断が DJ 番号で管理されていない

**Category**: completeness
**Location**: Section 3: 設計判断 (DJ-006 が欠落)

syncSchedules() の async 化に伴い、for...of ループ内で `await readCmateFile()` を逐次実行する設計判断は、本変更の重要なアーキテクチャ決定である。Section 6（パフォーマンス設計）と Section 8（トレードオフ表）に分散して記載されているが、他の全ての設計判断が DJ-001 ~ DJ-005 として体系的に管理されている中で、この判断だけが独立した DJ を持たない。

```
// 設計方針書に記載されている syncSchedules() の変更
async function syncSchedules(): Promise<void> {
  // ...
  for (const worktree of worktrees) {
    // ...
    const config = await readCmateFile(worktree.path);  // 逐次 await
    // ...
  }
}
```

**Suggestion**: DJ-006 として「syncSchedules() 内の worktree ループは逐次 await を維持（Promise.all 並列化はスコープ外）」を Section 3 に追加し、Section 6/8 からは DJ-006 を参照する形にする。

---

### Should Fix (3件)

#### DR1-001: DJ-002 と DJ-003 の .catch() 非対称性の設計根拠

**Category**: solid
**Location**: Section 3: DJ-002 実装欄 と DJ-003 の非対称性

DJ-002 の initScheduleManager() 内では `void syncSchedules()` (.catch() なし)、DJ-003 の setInterval 内では `void syncSchedules().catch(...)` (.catch() あり) という非対称な実装が提案されている。DJ-002 の実装欄に syncSchedules() 内部の try-catch がエラーを捕捉する旨は記載されているが、であれば DJ-003 でも .catch() は不要になるはずであり、なぜ DJ-003 のみ .catch() を付与するのかの根拠が不明確である。

**Suggestion**: DJ-002 に「DJ-003 では想定外エラーに対する多重防御として .catch() を付与するが、initScheduleManager() の初回呼び出しは server 起動直後の単発実行であるため .catch() を省略する」等の設計根拠を明記するか、統一して両方に .catch() を付ける。

#### DR1-003: schedule-manager-cleanup.test.ts の変更詳細が欠落

**Category**: completeness
**Location**: Section 4.3 テスト変更 および Section 7 変更ファイル表

Section 7 の変更ファイル表には schedule-manager-cleanup.test.ts が記載されているが、Section 4.3 のテスト変更の詳細設計には含まれていない。実際のファイル（L78-81）を確認すると:

```typescript
// 現在の schedule-manager-cleanup.test.ts (L78-81)
vi.mock('../../../src/lib/cmate-parser', () => ({
  readCmateFile: vi.fn().mockReturnValue(null),   // <- mockResolvedValue に変更が必要
  parseSchedulesSection: vi.fn().mockReturnValue([]),
}));
```

**Suggestion**: Section 4.3 に schedule-manager-cleanup.test.ts の変更詳細を追加する。

#### DR1-010: readCmateFile() の呼び出し元の網羅的確認が未記載

**Category**: completeness
**Location**: Section 7: 影響範囲

readCmateFile() は破壊的に async 化されるため、呼び出し元の網羅的確認は必須である。実際には schedule-manager.ts (L516) のみが呼び出し元であることを Grep で確認できたが、設計方針書にはこの検証結果が明示されていない。DJ-001 は validateCmatePath() について「外部呼び出し元なし」と述べているのみである。

**Suggestion**: Section 7 に「readCmateFile() の呼び出し元は schedule-manager.ts (L516) のみ（src/ 配下の grep で確認済み）」と明記する。

---

### Nice to Have (6件)

#### DR1-002: validateCmatePath() の Promise<boolean> 戻り値の意義

**Category**: solid
**Location**: Section 3: DJ-001

validateCmatePath() は成功時に true を返し、失敗時は throw するため、boolean 戻り値に情報量がない。Promise<void> のほうがインターフェースの意図を正確に表現する。ただし DJ-001 で public API の一貫性維持を判断しており、スコープ限定の意図は理解できる。

#### DR1-004: DJ-004 の将来的な非同期化余地への言及

**Category**: yagni
**Location**: Section 3: DJ-004

YAGNI に準拠した妥当な判断だが、Section 6 で逐次処理の「将来の最適化候補」に言及しているのと対称的に、DJ-004 にも将来の非同期化可能性を一言添えると一貫性が向上する。

#### DR1-006: fire-and-forget パターンの共通化可能性

**Category**: dry
**Location**: Section 4.2

initScheduleManager() と setInterval の両方で syncSchedules() を fire-and-forget で呼び出すパターンが繰り返されている。現時点では対応不要だが、呼び出しパターンが増える場合はヘルパー関数への抽出を検討できる。

#### DR1-007: import 文変更の影響範囲の明確化

**Category**: clarity
**Location**: Section 4.1 import文変更

`import { readFileSync, realpathSync } from 'fs'` が完全に削除されることと、cmate-parser.ts 内の他の関数が fs モジュールに依存しないことの確認を明記すべきである。

#### DR1-008: KISS 原則への良好な準拠（肯定的所見）

**Category**: kiss
**Location**: 設計方針書全体

変更スコープが適切に限定されており、不要な複雑性を導入していない。特に initScheduleManager() の sync API 維持、getCmateMtime() の statSync 維持、逐次処理の維持はいずれも KISS に準拠した妥当な判断。

#### DR1-009: SRP の維持（肯定的所見）

**Category**: solid
**Location**: Section 4.1 全体

cmate-parser.ts の I/O 関数と純粋関数の境界が明確に維持されている。async 化は validateCmatePath() と readCmateFile() の I/O 関数のみに適用され、parseCmateFile() / parseSchedulesSection() / sanitizeMessageContent() の純粋関数は変更されない。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | async 化による既存テストの修正漏れ | Low | Low | P3 |
| 技術的リスク | fire-and-forget での初回同期エラー見逃し | Low | Low | P3 |
| セキュリティリスク | TOCTOU リスク増加（SEC-406-002 で分析済み） | Low | Low | P3 |
| 運用リスク | 変更なし | Low | Low | - |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix) - 1件
1. **DR1-005**: syncSchedules() の逐次 await 設計判断を DJ-006 として Section 3 に追加する

### 推奨改善項目 (Should Fix) - 3件
1. **DR1-001**: DJ-002 と DJ-003 の .catch() 非対称性の設計根拠を明記する
2. **DR1-003**: schedule-manager-cleanup.test.ts の変更詳細を Section 4.3 に追加する
3. **DR1-010**: readCmateFile() の呼び出し元の網羅的確認結果を Section 7 に明記する

### 検討事項 (Consider) - 6件
1. **DR1-002**: validateCmatePath() の Promise<void> 化の検討
2. **DR1-004**: DJ-004 への将来的な非同期化余地の言及
3. **DR1-006**: fire-and-forget パターンの将来的な共通化
4. **DR1-007**: import 文変更の影響範囲の明確化
5. **DR1-008**: KISS 準拠の良好な設計を維持（肯定的所見）
6. **DR1-009**: SRP 維持の継続（肯定的所見）

---

## Reviewed Files

| ファイル | 確認内容 |
|---------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/dev-reports/design/issue-406-async-cmate-parser-design-policy.md` | レビュー対象の設計方針書 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/cmate-parser.ts` | 変更対象のソースコード（現在の実装確認） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/src/lib/schedule-manager.ts` | 変更対象のソースコード（syncSchedules, initScheduleManager 確認） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/server.ts` | initScheduleManager() 呼び出し元（L260, sync 呼び出し確認） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/cmate-parser.test.ts` | テスト変更対象の確認 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager.test.ts` | テスト変更対象の確認 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-406/tests/unit/lib/schedule-manager-cleanup.test.ts` | テスト変更対象の確認（mockReturnValue -> mockResolvedValue） |

---

## Approval Status

**Status**: Conditionally Approved
**Score**: 4/5
**Condition**: DR1-005 の must_fix 項目を対応後に再レビュー不要（設計方針書への追記で完了）

---

*Reviewed by Architecture Review Agent - 2026-03-04*

# Issue #402 Stage 2: 整合性レビュー報告書

## 概要

| 項目 | 内容 |
|------|------|
| Issue | #402: detectPromptの重複ログ出力抑制 |
| レビューステージ | Stage 2: 整合性レビュー |
| 設計方針書 | `dev-reports/design/issue-402-detect-prompt-log-dedup-design-policy.md` |
| ステータス | **conditionally_approved** |
| スコア | 4/5 |
| レビュー日 | 2026-03-03 |

---

## エグゼクティブサマリー

設計方針書の内容と実際のコードベースの整合性を6つの観点から検証した。全体として設計方針書の品質は高く、ログ行番号（L171, L185, L216）、スキャンウィンドウ（50行）、`@internal`エクスポートパターンなど主要な整合性ポイントは正確に記述されている。

should_fixレベルの指摘が2件あり、いずれも実装時の誤解を防ぐための修正である。must_fixレベルの指摘はなし。

---

## 整合性チェック結果

### 1. D2コード例の整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| `lines`変数の定義 | `const lines = output.split('\n');` を関数冒頭で1回実行 | L173: `const lines = output.split('\n');` | 一致 |
| `tailForDedup`の定義 | `lines.slice(-50).join('\n')` | 未実装（設計段階） | N/A |
| `isDuplicate`フラグ | `tailForDedup === lastOutputTail` | 未実装（設計段階） | N/A |
| `multipleChoiceResult`変数名 | D2-004で使用 | L183: `const multipleChoiceResult = ...` | 一致 |
| S1-004 split()共有コメント | 「split()の二重呼び出しを回避」 | `detectMultipleChoicePrompt`内で独立にsplit()を実行（L620） | **不一致** (S2-001) |

### 2. 末尾50行の根拠

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| multipleChoice scan window | `effectiveEnd - 50` | L631: `Math.max(0, effectiveEnd - 50)` | 一致 |
| yes/no scan window | 末尾20行 | L175: `lines.slice(-20)` | 一致 |
| キャッシュ対象 | 末尾50行 | 設計通り（multipleChoice windowに合わせた妥当な設計） | 整合 |

### 3. @internal exportパターン

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| `resetDetectPromptCache()` | `@internal` export | prompt-detector.tsに現在`@internal`なし（初導入） | パターン自体は一致 |
| 既存パターン | auto-yes-manager.ts等に前例あり | auto-yes-manager.ts: 8件、version-checker.ts: 1件、claude-session.ts: 2件+、path-validator.ts: 1件 | 確認済・整合 |
| JSDocフォーマット | `@internal` | 既存は `@internal Exported for testing purposes only.` 形式 | **微差** (S2-005相当) |

### 4. ログ行番号の検証

| 設計書の行番号 | 実際の行番号 | ログ内容 | 結果 |
|--------------|------------|---------|------|
| L171 | L171 | `logger.debug('detectPrompt:start', ...)` | **完全一致** |
| L185 | L185 | `logger.info('detectPrompt:multipleChoice', ...)` | **完全一致** |
| L216 | L216 | `logger.debug('detectPrompt:complete', ...)` | **完全一致** |

### 5. テスト設計の整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| テストフレームワーク | vitest (describe/it) | L6: `import { describe, it, expect } from 'vitest';` | 一致 |
| モック方式 | `vi.mock('@/lib/logger')` | 既存テストにvi.mock未使用 | **要検討** (S2-002) |
| beforeEach | `resetDetectPromptCache()` | 既存テストにbeforeEachなし | 追加可能 |
| インポート方式 | `import { detectPrompt } from '@/lib/prompt-detector'` | L7: 一致 | 一致 |
| 既存テスト構造 | describe('Prompt Detector') > describe('detectPrompt') | L12-L13: 一致 | 一致 |

### 6. CLAUDE.md記載の整合性

| 設計項目 | 設計書の記載 | 既存パターン | 差異 |
|---------|------------|------------|------|
| 記載フォーマット | `**Issue #402: 重複ログ抑制** - details` | `**Issue #NNN: description** - details` 形式（全モジュール共通） | 一致 |
| 記載位置 | prompt-detector.tsのモジュール説明 | 該当テーブル行に追記 | 適切 |
| 記載内容 | `lastOutputTailモジュールスコープキャッシュ` | 他モジュールの記述粒度と整合 | 一致 |

---

## 指摘事項

### Should Fix (2件)

#### S2-001: D2コード例のsplit()共有コメントが不正確

**重要度**: should_fix
**カテゴリ**: 整合性

設計方針書D2のコメント `[S1-004]` で「output.split()を1回に統一し、lines変数を共有する」と記載されているが、`detectMultipleChoicePrompt(output, options)` はL620で独立に `output.split('\n')` を実行している。`detectPrompt()` 内の `lines` と `detectMultipleChoicePrompt()` 内の `lines` は関数スコープが異なるため共有不可能であり、設計方針書のコメントが実装の実態と乖離している。

**根拠コード**:
```
prompt-detector.ts L173: const lines = output.split('\n');  // detectPrompt内
prompt-detector.ts L620: const lines = output.split('\n');  // detectMultipleChoicePrompt内
```

**改善案**: D2のS1-004コメントを「detectPrompt()内でoutput.split('\n')を1回だけ実行し、キャッシュ判定用tailForDedupとyes/noパターン用lastLinesの両方で共有する。detectMultipleChoicePrompt()は独立した関数スコープで独自にsplit()を実行しており、これは関数カプセル化の範囲内である」に修正する。

---

#### S2-002: テストでvi.mock()追加時の既存テスト影響

**重要度**: should_fix
**カテゴリ**: 整合性

設計方針書セクション8のテスト方式では `vi.mock('@/lib/logger')` を使用する旨が記載されているが、既存の `tests/unit/prompt-detector.test.ts` には `vi.mock` が一切使用されていない。vitestの `vi.mock()` はファイルトップレベルにホイストされるため、同一ファイル内の全テストに影響する。

**根拠コード**:
```
tests/unit/prompt-detector.test.ts L1-L10: vi.mockの使用なし、beforeEach/afterEachなし
```

**改善案**: 以下のいずれかの方式を設計方針書に明記する:
1. 重複ログ抑制テストを別ファイル（`tests/unit/prompt-detector-cache.test.ts`）に分離する
2. `vi.spyOn()` を `describe` ブロック内で使用し、`afterEach` で `vi.restoreAllMocks()` を呼び出す方式にする（vi.mock不使用）

---

### Nice to Have (3件)

#### S2-003: detectPrompt()呼び出し回数の記載

**重要度**: nice_to_have

設計方針書セクション1で「最大6回呼び出されており」と記載されているが、実際の直接呼び出し箇所は7箇所（response-poller.ts: 3、auto-yes-manager.ts: 1、status-detector.ts: 1、current-output/route.ts: 1、prompt-response/route.ts: 1）。response-poller.tsのL1088は `result.promptDetection ?? detectPromptWithOptions(...)` であり条件付き呼び出しのため、実質的には最大6回程度という記載は大きく外れてはいない。

---

#### S2-004: D1のモジュールスコープ変数の設計根拠

**重要度**: nice_to_have

auto-yes-manager.tsの `pollerState` はglobalThisパターンを使用しており、純粋なモジュールスコープ変数ではない。参照パターンとして `ip-restriction.ts` のモジュールスコープキャッシュの方が正確。

---

#### S2-005: D2コード例のlogger.info引数省略

**重要度**: nice_to_have

D2-004のlogger.info引数が `{ ... }` と省略されているが、実際のコード（L185-189）の完全な引数を記載した方が実装時の確認が容易。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | split()共有コメントの誤解による不要なリファクタリング | Low | Low | P3 |
| テストリスク | vi.mock()導入による既存テスト破壊 | Medium | Medium | P2 |
| 運用リスク | なし | Low | Low | - |

---

## 承認ステータス

**conditionally_approved** - should_fix 2件（S2-001, S2-002）の対応を条件に承認。

S2-001はコメントの修正のみであり実装への影響は小さい。S2-002はテスト実装方針に関わるため、実装前に方針を決定しておくことが望ましい。

---

*Generated by architecture-review-agent for Issue #402 Stage 2*

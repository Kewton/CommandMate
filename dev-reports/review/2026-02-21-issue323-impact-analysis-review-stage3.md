# Issue #323 影響分析レビュー (Stage 3)

## レビュー概要

| 項目 | 内容 |
|------|------|
| Issue | #323 |
| レビュー種別 | 影響分析 (Impact Scope) |
| ステージ | Stage 3 |
| 対象 | `dev-reports/design/issue-323-auto-yes-manager-refactoring-design-policy.md` (Stage 1-2反映済み) |
| 実施日 | 2026-02-21 |
| 判定 | 条件付き承認 |
| スコア | 4/5 |

## Executive Summary

`auto-yes-manager.ts` の `pollAutoYes()` 関数を4つのサブ関数に分割するリファクタリング設計方針書に対して、6つの影響分析観点からレビューを実施した。全体として影響範囲は適切に制御されており、既存の外部インターフェース（API route、session-cleanup、useAutoYes hook）に対する破壊的変更はない。`@internal export` の追加も既存パターン（`checkStopCondition`, `executeRegexWithTimeout`）に準じており、安全である。

主な指摘は Section 10（変更対象ファイル一覧）の網羅性に関する3件の should_fix であり、設計書の実装ガイドとしての品質向上に資する改善事項である。

---

## 1. 変更の波及範囲分析

### 1-1. 直接変更ファイル

| ファイル | 変更内容 | リスク |
|---------|---------|-------|
| `src/lib/auto-yes-manager.ts` | pollAutoYes() 分割、4関数追加、getPollerState()追加 | Low - 機能変更なし、既存インターフェース維持 |
| `tests/unit/lib/auto-yes-manager.test.ts` | import拡張、分割関数の個別テスト追加 | Low - 既存テストはそのまま維持 |
| `CLAUDE.md` | auto-yes-manager.ts モジュール説明の更新 | Low - ドキュメントのみ |
| `docs/implementation-history.md` | Issue #323 エントリ追加 | Low - ドキュメントのみ |

### 1-2. 間接影響ファイル（影響なし確認）

以下のファイルは `auto-yes-manager.ts` からimportを行っているが、今回のリファクタリングでは影響を受けない。

| ファイル | importしている関数/型 | 影響有無 | 理由 |
|---------|---------------------|---------|------|
| `src/lib/session-cleanup.ts` | `stopAutoYesPolling` | 影響なし | 関数シグネチャ・動作に変更なし |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | `getAutoYesState`, `setAutoYesEnabled`, `isValidWorktreeId`, `startAutoYesPolling`, `stopAutoYesPolling`, `AutoYesState` | 影響なし | 全てpublic export関数/型であり、シグネチャ変更なし |
| `src/app/api/worktrees/[id]/current-output/route.ts` | `getAutoYesState`, `getLastServerResponseTimestamp`, `isValidWorktreeId` | 影響なし | 同上 |
| `src/hooks/useAutoYes.ts` | なし（直接importなし、APIルート経由で間接利用） | 影響なし | サーバーサイド関数を直接使用していない |
| `src/lib/prompt-answer-sender.ts` | なし（auto-yes-managerから呼び出される側） | 影響なし | 呼び出しインターフェース変更なし |
| `tests/integration/auto-yes-persistence.test.ts` | 動的importで複数関数を使用 | 確認推奨 | 後述（IA001） |

### 1-3. @internal export 追加のインパクト

新規 @internal export 関数:
- `validatePollingContext()`
- `captureAndCleanOutput()`
- `processStopConditionDelta()`
- `detectAndRespondToPrompt()`

これらは TypeScript の export として外部に公開されるが、JSDoc の `@internal` タグにより「テスト専用」であることが文書的に示される。既存の `checkStopCondition()` (L409) と `executeRegexWithTimeout()` (L384) が同一パターンで export 済みであり、プロジェクトの確立された慣例に沿っている。

外部インターフェースへの実質的影響: **なし**

---

## 2. 既存テストへの影響分析

### 2-1. 単体テスト (`tests/unit/lib/auto-yes-manager.test.ts`)

テストファイルは1517行、以下のdescribeブロックで構成:

| テストカテゴリ | 行数（概算） | タイマー使用 | 分割後の影響 |
|--------------|-------------|-------------|-------------|
| setAutoYesEnabled | L59-120 | vi.useFakeTimers | 影響なし |
| AUTO_YES_TIMEOUT_MS migration | L122-133 | なし | 影響なし |
| getAutoYesState | L135-176 | vi.useFakeTimers | 影響なし |
| isAutoYesExpired | L178-215 | vi.useFakeTimers | 影響なし |
| clearAllAutoYesStates | L217-227 | なし | 影響なし |
| isValidWorktreeId | L233-253 | なし | 影響なし |
| calculateBackoffInterval | L255-276 | なし | 影響なし |
| startAutoYesPolling | L278-325 | なし | 影響なし |
| stopAutoYesPolling | L327-341 | なし | 影響なし |
| stopAllAutoYesPolling | L343-359 | なし | 影響なし |
| getLastServerResponseTimestamp | L361-371 | なし | 影響なし |
| Poller State Management | L373-388 | vi.useFakeTimers | 影響なし |
| Constants | L390-397 | なし | 影響なし |
| globalThis state management | L403-475 | なし | 影響なし |
| **pollAutoYes thinking state skip** | L481-555 | **vi.useFakeTimers** | **間接的影響（後述）** |
| **detectThinking windowing** | L563-704 | **vi.useFakeTimers** | **間接的影響（後述）** |
| **Claude Code cursor-based navigation** | L711-955 | **vi.useFakeTimers** | **間接的影響（後述）** |
| **duplicate prevention** | L960-1073 | **vi.useFakeTimers** | **間接的影響（後述）** |
| **cooldown** | L1076-1153 | **vi.useFakeTimers** | **間接的影響（後述）** |
| **stop condition delta** | L1344-1515 | **vi.useFakeTimers** | **間接的影響（後述）** |
| Issue #314 unit tests | L1180-1342 | 一部 | 影響なし |

太字のテストカテゴリは `pollAutoYes()` を間接的にテストしている。これらは `vi.advanceTimersByTimeAsync()` で setTimeout を駆動し、`pollAutoYes()` 内部のロジックを `captureSessionOutput`/`sendKeys`/`sendSpecialKeys` のモック呼び出しで検証する。

**分割後の影響評価**: `pollAutoYes()` のオーケストレーター構造が変わっても、外部から観測可能な動作（captureSessionOutput の呼び出し、sendKeys/sendSpecialKeys の呼び出し有無、getAutoYesState の状態変化）は同一のため、既存テストはそのまま動作する。

### 2-2. モック依存チェーン

既存テストのモック設定:
```
vi.mock('@/lib/cli-session')     -> captureSessionOutput
vi.mock('@/lib/tmux')            -> sendKeys, sendSpecialKeys
vi.mock('@/lib/cli-tools/manager') -> CLIToolManager
```

`sendPromptAnswer()` (`src/lib/prompt-answer-sender.ts`) は内部で `sendKeys`/`sendSpecialKeys` を呼び出す。既存の `pollAutoYes()` は既に `sendPromptAnswer()` を使用しているため（L561-566）、分割後の `detectAndRespondToPrompt()` でも同じ `sendPromptAnswer()` 呼び出しが行われ、tmux モジュールのモックが間接的に適用される。

**結論**: 既存テストの修正は import 文への新規関数追加のみで十分。

### 2-3. 結合テスト (`tests/integration/auto-yes-persistence.test.ts`)

このテストは `vi.resetModules()` を使用してモジュールリロードをシミュレートし、globalThis 経由の状態永続性を検証する。新規 export 関数は globalThis を直接操作せず（既存の `autoYesStates`/`autoYesPollerStates` 変数を経由）、リロード後も同一の Map インスタンスを参照するため、影響なし。

ただし、設計書 Section 10 にこのファイルが記載されていない点は IA001 で指摘。

---

## 3. Section 10 変更対象ファイル一覧の完全性

### 3-1. 設計書の記載（Section 10）

| ファイル | 変更種別 | 記載 |
|---------|---------|------|
| `src/lib/auto-yes-manager.ts` | 修正 | あり |
| `tests/unit/lib/auto-yes-manager.test.ts` | 修正 | あり |
| `CLAUDE.md` | 修正 | あり |
| `docs/implementation-history.md` | 修正 | あり |

### 3-2. 漏れの確認

| ファイル | 状況 | 評価 |
|---------|------|------|
| `tests/integration/auto-yes-persistence.test.ts` | Section 10 に未記載 | **should_fix** (IA001) - 確認対象として記載推奨 |
| `src/lib/session-cleanup.ts` | 影響なしだが未記載 | nice_to_have (IA004) |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | 影響なしだが未記載 | nice_to_have (IA004) |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 影響なしだが未記載 | nice_to_have (IA004) |
| `src/hooks/useAutoYes.ts` | 影響なし | nice_to_have (IA004) |

---

## 4. globalThis 依存の影響分析

### 4-1. 現行の globalThis パターン

```typescript
// L125-138
declare global {
  var __autoYesStates: Map<string, AutoYesState> | undefined;
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
}

const autoYesStates = globalThis.__autoYesStates ??
  (globalThis.__autoYesStates = new Map<string, AutoYesState>());
const autoYesPollerStates = globalThis.__autoYesPollerStates ??
  (globalThis.__autoYesPollerStates = new Map<string, AutoYesPollerState>());
```

### 4-2. getPollerState() 導入の影響

`getPollerState()` は `autoYesPollerStates.get(worktreeId)` の1行ラッパーであり、`autoYesPollerStates` はモジュールスコープ定数として globalThis の Map を参照する。この参照チェーンは `getPollerState()` 導入前後で同一であり、globalThis パターンへの影響はない。

### 4-3. 新規 @internal export 関数の globalThis 使用

新規関数は全て `pollerState` を引数として受け取る設計（Section 3-1 ~ 3-4）であり、内部で `autoYesPollerStates` を直接参照しない（`validatePollingContext` のみ `getAutoYesState()` を経由して `autoYesStates` にアクセスする）。この設計により、globalThis への依存は `pollAutoYes()` オーケストレーター（および `getPollerState()`）に集約され、分割関数はテスト時に任意の `pollerState` オブジェクトを渡すことで独立テストが可能になる。

**結論**: globalThis パターンへの影響なし。

---

## 5. 外部インターフェースの維持確認

### 5-1. 既存 export 関数（public API）

以下の関数/型は全て変更なしで維持される:

| export | 使用箇所 | 変更有無 |
|--------|---------|---------|
| `getAutoYesState()` | route.ts x2, useAutoYes (API経由) | なし |
| `setAutoYesEnabled()` | auto-yes/route.ts | なし |
| `isValidWorktreeId()` | auto-yes/route.ts, current-output/route.ts | なし |
| `startAutoYesPolling()` | auto-yes/route.ts | なし |
| `stopAutoYesPolling()` | auto-yes/route.ts, session-cleanup.ts | なし |
| `stopAllAutoYesPolling()` | テスト用 | なし |
| `getLastServerResponseTimestamp()` | current-output/route.ts | なし |
| `isAutoYesExpired()` | テスト用 | なし |
| `getActivePollerCount()` | テスト用 | なし |
| `clearAllAutoYesStates()` | テスト用 | なし |
| `clearAllPollerStates()` | テスト用 | なし |
| `disableAutoYes()` | テスト用 | なし |
| `checkStopCondition()` | テスト用(@internal) | なし |
| `executeRegexWithTimeout()` | テスト用(@internal) | なし |
| `calculateBackoffInterval()` | テスト用 | なし |
| `AutoYesState` (type) | auto-yes/route.ts | なし |
| `AutoYesPollerState` (type) | テスト用 | なし |
| `StartPollingResult` (type) | 未使用（自己完結） | なし |
| `AutoYesStopReason` (re-export) | 外部 | なし |
| 定数群 (POLLING_INTERVAL_MS等) | テスト用 | なし |

### 5-2. 新規 export（@internal）

| export | 用途 | 外部影響 |
|--------|------|---------|
| `validatePollingContext()` | テスト専用 | なし |
| `captureAndCleanOutput()` | テスト専用 | なし |
| `processStopConditionDelta()` | テスト専用 | なし |
| `detectAndRespondToPrompt()` | テスト専用 | なし |

**結論**: 外部インターフェースは設計方針書通りに維持される。

---

## 6. CLAUDE.md 更新範囲の評価

### 6-1. 現行の CLAUDE.md エントリ

```
| `src/lib/auto-yes-manager.ts` | Auto-Yes状態管理とサーバー側ポーリング（Issue #138）、
thinking状態のprompt検出スキップ（Issue #161）。**Issue #306: 重複応答防止** -
AutoYesPollerStateにlastAnsweredPromptKey追加、isDuplicatePrompt()ヘルパー、
プロンプト非検出時nullリセット、COOLDOWN_INTERVAL_MS=5000クールダウン、
scheduleNextPoll()にoverride_interval下限値ガード付き）。**Issue #314: Stop条件
機能追加** - AutoYesStateにstopPattern/stopReason追加、disableAutoYes()専用関数
（全フィールド明示設定）、checkStopCondition()独立関数（@internal export、
safe-regex2+タイムアウト保護）、executeRegexWithTimeout()タイムアウト保護付き評価、
pollAutoYes()にStop条件チェック挿入（thinking後・プロンプト検出前）、
AutoYesStopReason型をauto-yes-config.tsに移動）|
```

### 6-2. 必要な更新内容

Issue #323 の記載追加が必要:
- `**Issue #323: pollAutoYes()リファクタリング**` のセクション追加
- 関数群方式の採用（クラスではなく関数ベース）
- 4つの分割関数名の列挙（全て @internal export）
- `getPollerState()` 内部ヘルパー追加
- pollerState存在確認の共通化

設計書 Section 10 にはこの粒度の記載方針が示されていない（IA002 で指摘）。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 既存テストの破壊 | Med | Low | P2 - 機能変更なしのため低リスク |
| 技術的リスク | globalThis 参照チェーンの不整合 | Med | Low | P3 - getPollerState()は1行ラッパー |
| 運用リスク | CLAUDE.md 記載不備による開発者混乱 | Low | Med | P2 - 具体的記載方針を設計書に追加 |
| セキュリティ | @internal export による外部アクセス | Low | Low | P3 - 既存パターン踏襲で十分 |

---

## 指摘事項一覧

| ID | 重要度 | カテゴリ | タイトル | 対象セクション |
|----|--------|---------|---------|---------------|
| IA001 | should_fix | ファイル漏れ | Section 10に結合テスト（auto-yes-persistence.test.ts）が未記載 | Section 10 |
| IA002 | should_fix | ドキュメント | CLAUDE.md更新内容の具体的な記述方針が不足 | Section 10 |
| IA003 | should_fix | テスト影響 | 既存タイマーベーステストにおけるモック範囲拡大の影響評価が不足 | Section 6-1 |
| IA004 | nice_to_have | 波及範囲 | session-cleanup.ts等の「影響なし確認済み」リスト追加 | Section 10 |
| IA005 | nice_to_have | 外部インターフェース | AutoYesPollerState export型と@internal関数の関係 | Section 5 |
| IA006 | nice_to_have | 波及範囲 | getPollerState()置換の機械的変換テストカバレッジ | Section 4 |

---

## 改善推奨事項

### 推奨改善項目 (Should Fix)

1. **IA001**: Section 10 に `tests/integration/auto-yes-persistence.test.ts` を「確認対象」として追記する
2. **IA002**: Section 10 の CLAUDE.md 変更内容に具体的なエントリ文案を記載する
3. **IA003**: Section 6-1 に sendPromptAnswer() の間接モック依存の補足説明を追加する

### 検討事項 (Nice to Have)

4. **IA004**: Section 10 に「影響なし確認済み」ファイルリストを追加する
5. **IA005**: 追加対応不要（既存パターンと同一）
6. **IA006**: リファクタリング前後のテスト結果一致確認手順を実装手順に含める

---

## 判定

**条件付き承認**

設計方針書の影響範囲分析は全体として適切であり、外部インターフェースの維持、globalThis パターンへの非影響、既存テストの安定性が確認された。should_fix 3件の対応により、設計書の実装ガイドとしての品質がさらに向上する。

---

*Reviewed by: architecture-review-agent (Stage 3: Impact Analysis)*
*Date: 2026-02-21*

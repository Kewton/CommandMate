# Architecture Review Report: Issue #306 - Stage 2 整合性レビュー

## Executive Summary

| 項目 | 値 |
|------|-----|
| Issue | #306 |
| Stage | 2 - 整合性レビュー |
| Focus | 設計方針書 vs 実装コードベースの整合性 |
| Status | 条件付き承認 (Conditionally Approved) |
| Score | 4/5 |
| Must Fix | 2件 |
| Should Fix | 4件 |
| Nice to Have | 4件 |

設計方針書は全体として既存コードベースとの整合性が高く、Stage 1の指摘事項（F001-F010）が適切に反映されている。ただし、コード例レベルでの不整合が2件検出され、実装時のバグ誘発リスクがある。特にasync/awaitの記載漏れとHealthCheckResultの完全なコード例の欠如は、実装者が設計書のコード例をそのまま使用した場合に問題が発生する。

---

## 1. 設計書 vs 実装の整合性

### 1.1 isClaudeRunning()の現在の実装と設計変更の整合性

**現在の実装** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-306/src/lib/claude-session.ts` L419-427):

```typescript
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  const exists = await hasSession(sessionName);
  if (!exists) {
    return false;
  }
  return isSessionHealthy(sessionName);  // <- boolean直接返却
}
```

**設計書のコード例** (セクション3.1 L92-98):

```typescript
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  const exists = await hasSession(sessionName);
  if (!exists) return false;
  const result = isSessionHealthy(sessionName);  // <- awaitが欠落
  return result.healthy;
}
```

**不整合**: 設計書コード例の`isSessionHealthy()`呼び出しに`await`が欠落している。isSessionHealthy()はasync関数（内部で`getCleanPaneOutput()`をawaitする）であるため、awaitなしでは`result`に`Promise<HealthCheckResult>`が入り、`result.healthy`は`undefined`になる。

**影響度**: Must Fix - 設計書のコード例をそのまま実装に使用するとバグになる。

### 1.2 isSessionHealthy()の判定方式の変更

**現在の実装** (L280-291):

```typescript
const trimmed = cleanOutput.trim();
if (trimmed === '') {
  return false;
}
if (SHELL_PROMPT_ENDINGS.some(ending => trimmed.endsWith(ending))) {
  return false;
}
```

**設計書の変更** (セクション3.2):

```typescript
const lines = trimmed.split('\n').filter(line => line.trim() !== '');
const lastLine = lines[lines.length - 1]?.trim() ?? '';
// 行長チェック -> SHELL_PROMPT_ENDINGS -> 個別パターン除外
```

**差異**: `trimmed.endsWith()` (全体末尾) から `lastLine.endsWith()` (最終行末尾) への変更。通常は等価だが、空行フィルタリングの有無で挙動が異なるケースがある。設計書では「変更前 vs 変更後」の差分が明示されていない。

### 1.3 AutoYesPollerStateの型定義と追加フィールドの整合性

**現在の型定義** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-306/src/lib/auto-yes-manager.ts` L31-42):

```typescript
export interface AutoYesPollerState {
  timerId: ReturnType<typeof setTimeout> | null;
  cliToolId: CLIToolType;
  consecutiveErrors: number;
  currentInterval: number;
  lastServerResponseTimestamp: number | null;
}
```

**設計書の拡張** (セクション3.3):

```typescript
export interface AutoYesPollerState {
  // ... 既存フィールド ...
  lastAnsweredPromptKey: string | null;  // <- 追加
}
```

**整合性**: 良好。追加フィールドは既存フィールドと矛盾せず、`null`初期値は他のnullableフィールド（`lastServerResponseTimestamp`）と一致。ただし、`startAutoYesPolling()` (L414-420) の初期化オブジェクトへの追加コード例が設計書に欠如。

### 1.4 promptData.type / promptData.question のフィールド名整合性

**既存型定義** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-306/src/types/models.ts`):

```typescript
export interface BasePromptData {
  type: PromptType;        // 'yes_no' | 'multiple_choice'
  question: string;
  status: 'pending' | 'answered';
  // ...
}
```

**設計書のpromptKey生成** (セクション3.3):

```typescript
export function generatePromptKey(promptData: { type: string; question: string }): string {
  return `${promptData.type}:${promptData.question}`;
}
```

**整合性**: 良好。`type`と`question`はBasePromptDataに存在するフィールド。設計書のgeneratePromptKey()は`{ type: string; question: string }`という構造的型を使用しており、PromptDataを直接参照しないことでサーバー/クライアント両方で使用可能。

---

## 2. 設計書内部の整合性

### 2.1 セクション間のコード例整合性

| セクション | コード例の内容 | 整合性 |
|-----------|-------------|--------|
| 3.1 (HealthCheckResult) | isClaudeRunning()、ensureHealthySession()のコード例 | await欠落あり (S2-F001) |
| 3.2 (多段防御) | 最終行抽出+行長チェック+SHELL_PROMPT_ENDINGSのコード例 | empty output/error pattern判定のHealthCheckResult形式が欠如 (S2-F010) |
| 3.3 (重複応答防止) | pollAutoYes()内のpromptKey生成・比較・リセットのコード例 | クールダウンパスへの相互参照なし (S2-F004) |
| 3.4 (クールダウン) | scheduleNextPoll()のoverrideInterval追加 | 単独では整合 |
| 6 (テスト設計) | import文でisSessionHealthy/HealthCheckResult参照 | 3.1の@internal export設計と整合 |

### 2.2 実装順序（セクション8）と変更対象ファイル（セクション9）の整合性

| 実装順序ステップ | 対象ファイル（セクション9） | 整合性 |
|--------------|--------------------------|--------|
| 1. HealthCheckResult + isSessionHealthy()拡張 | claude-session.ts | 整合 |
| 2. SHELL_PROMPT_ENDINGS多段防御 | claude-session.ts | 整合 |
| 3. isClaudeRunning() + ensureHealthySession() | claude-session.ts | 整合 |
| 4. promptKey共通化 | prompt-key.ts (新規) | 整合 |
| 5. lastAnsweredPromptKey + isDuplicatePrompt | auto-yes-manager.ts | 整合 |
| 6. COOLDOWN_INTERVAL_MS + scheduleNextPoll拡張 | auto-yes-manager.ts | 整合 |

**注**: セクション9のuseAutoYes.ts変更（promptKey生成をgeneratePromptKey()に置換）はステップ4に含まれるべきだが、セクション8では明示的に「useAutoYes.tsから使用」と記載されており整合している。

### 2.3 テスト設計（セクション6）とコード例の整合性

| テスト項目 | 対応コード例 | 整合性 |
|-----------|------------|--------|
| 6.1: 偽陽性防止テスト (7%/100%/短いプロンプト) | 3.2: 多段防御コード | 整合 |
| 6.1: 境界値テスト (39/40/41文字) | 3.2: MAX_SHELL_PROMPT_LENGTH | 整合 |
| 6.2: reason検証テスト (empty output, error pattern) | 3.1-3.2: HealthCheckResult | **不整合** - コード例にempty output/errorのreason返却例がない (S2-F010) |
| 6.3: 重複防止テスト | 3.3: isDuplicatePrompt() | 整合 |
| 6.4: クールダウンテスト | 3.4: COOLDOWN_INTERVAL_MS | 整合 |
| 6.5: promptKeyテスト | 3.3: generatePromptKey() | 整合 |

---

## 3. 既存パターンとの整合性

### 3.1 clearCachedClaudePath()の@internalパターン

**既存パターン** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-306/src/lib/claude-session.ts` L148-156):

```typescript
/**
 * @internal Exported for testing purposes only.
 * Follows the same pattern as version-checker.ts resetCacheForTesting().
 * Function name clearCachedClaudePath() is retained (without ForTesting suffix)
 * because it is also called in production code (catch block), not only in tests.
 */
export function clearCachedClaudePath(): void {
```

**設計書の提案** (セクション3.1):

```typescript
/**
 * @internal Exported for testing purposes only.
 * Follows clearCachedClaudePath() precedent (L148-156).
 */
export async function isSessionHealthy(sessionName: string): Promise<HealthCheckResult> {
```

**整合性**: 良好。JSDocフォーマット、@internalアノテーション、先例への参照がパターンとして一貫している。

### 3.2 useAutoYes.tsの既存重複防止と提案の対称性

| 観点 | useAutoYes.ts (クライアント) | pollAutoYes() (サーバー設計) |
|------|---------------------------|---------------------------|
| キー保存場所 | `lastAutoRespondedRef` (React Ref) | `pollerState.lastAnsweredPromptKey` (Map内) |
| キー生成 | `${promptData.type}:${promptData.question}` | `generatePromptKey(promptData)` (共通化) |
| リセット条件 | `!isPromptWaiting` | `!promptDetection.isPrompt` |
| リセット先 | `null` | `null` |
| チェック位置 | 応答送信前 | 応答送信前 |

**整合性**: 高い対称性を維持。F002対応でpromptKey生成が共通化されることで、将来的なキー構成変更時の不整合リスクも解消される。

### 3.3 scheduleNextPoll()の現在シグネチャと変更提案

**現在の実装** (L374-381):

```typescript
function scheduleNextPoll(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerState = autoYesPollerStates.get(worktreeId);
  if (!pollerState) return;
  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId);
  }, pollerState.currentInterval);
}
```

**設計書の変更** (セクション3.4):

```typescript
function scheduleNextPoll(
  worktreeId: string,
  cliToolId: CLIToolType,
  overrideInterval?: number  // <- 追加
): void {
  // ...
  const interval = overrideInterval ?? pollerState.currentInterval;
  // ...
}
```

**整合性**: 良好。オプションパラメータ追加は既存の全呼び出し箇所（引数2個）に影響なし（後方互換性維持）。設計書のパターンA/B/C分類も現在のコードフロー（thinking中のearly return、応答不可時のearly return、try-catch後のscheduleNextPoll）と整合する。

---

## 4. Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 設計書コード例のawait欠落による実装バグ | Medium | Medium | P1 |
| 技術的リスク | HealthCheckResult形式のコード例不足による実装漏れ | Medium | Medium | P1 |
| 技術的リスク | pollAutoYes()の制御フロー変更の見落とし | Low | Low | P2 |
| セキュリティ | なし（既存セキュリティパターン維持） | - | - | - |
| 運用リスク | なし（内部リファクタリング、API変更なし） | - | - | - |

---

## 5. Detailed Findings

### Must Fix (2件)

#### S2-F001: isClaudeRunning()コード例のawait欠落

- **カテゴリ**: 設計-実装整合性
- **場所**: 設計方針書セクション3.1 L92-98
- **詳細**: isSessionHealthy()はasync関数だが、設計書のisClaudeRunning()コード例で`const result = isSessionHealthy(sessionName);`とawaitなしで呼び出している。ensureHealthySession()のコード例も同様。
- **リスク**: 実装者が設計書のコード例をコピーした場合、result.healthyがundefinedになるバグが発生する。
- **修正案**: `const result = await isSessionHealthy(sessionName);`に修正。

#### S2-F010: empty output/error patternのHealthCheckResult形式コード例の欠如

- **カテゴリ**: 設計内部整合性
- **場所**: 設計方針書セクション3.1-3.2
- **詳細**: テスト設計（6.2）では`reason: "empty output"`や`reason: "error pattern: ..."`の検証が含まれるが、セクション3.1-3.2のコード例にこれらのHealthCheckResult形式のreturn文が含まれていない。
- **リスク**: 実装者がセクション3.2のコード例のみを参照した場合、既存のempty output/error pattern判定のHealthCheckResult対応を見落とす。
- **修正案**: セクション3.2の冒頭にempty output判定とerror pattern判定のHealthCheckResult版コード例を追加する。

### Should Fix (4件)

#### S2-F002: trimmed.endsWith()からlastLine.endsWith()への変更の明示不足

- **カテゴリ**: 設計-実装整合性
- **修正案**: セクション3.2に「現在の実装（trimmed.endsWith）」と「変更後の実装（lastLine.endsWith）」の差分比較を追加。

#### S2-F003: AutoYesPollerState初期化コードの欠如

- **カテゴリ**: 設計-実装整合性
- **修正案**: セクション3.3にstartAutoYesPolling()の初期化オブジェクト変更例を追加。

#### S2-F004: pollAutoYes()のクールダウンパスへの相互参照の欠如

- **カテゴリ**: 設計内部整合性
- **修正案**: セクション3.3の応答送信コード例にセクション3.4への相互参照コメントを追加。

#### S2-F005: pollAutoYes()の変更後完全制御フローの欠如

- **カテゴリ**: 設計-実装整合性
- **修正案**: 応答成功/thinking・非検出/catchの3つの経路を明示した制御フロー図を追加。

### Nice to Have (4件)

- **S2-F006**: @internalパターンの使い分け補足
- **S2-F007**: useAutoYes.tsのgeneratePromptKey()置換コード例の明示
- **S2-F008**: テスト設計のimport文整合性（問題なし確認済み）
- **S2-F009**: 実装順序ステップ3のisClaudeRunning()変更内容具体化

---

## 6. Approval Status

**条件付き承認 (Conditionally Approved)**

以下の条件を満たした上で実装に進むこと：

1. **S2-F001**: 設計書コード例のawait追加（セクション3.1の2箇所）
2. **S2-F010**: empty output/error patternのHealthCheckResult形式コード例追加（セクション3.2）

Should Fix項目はリスクは低いものの、実装者の利便性向上のため可能な限り対応を推奨する。

---

*Generated by architecture-review-agent (Stage 2: 整合性レビュー) on 2026-02-18*
*Reviewed files: claude-session.ts, auto-yes-manager.ts, useAutoYes.ts, prompt-answer-sender.ts, cli-session.ts, session-cleanup.ts, cli-patterns.ts, models.ts, claude-session.test.ts, auto-yes-manager.test.ts*

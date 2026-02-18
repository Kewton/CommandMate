# Architecture Review Report: Issue #306 - tmuxセッション安定性改善

## レビュー情報

| 項目 | 内容 |
|------|------|
| Issue | #306 |
| Stage | 1 - 通常レビュー |
| Focus | 設計原則 (SOLID / KISS / YAGNI / DRY) |
| Status | Conditionally Approved |
| Score | 4/5 |
| Date | 2026-02-18 |
| Reviewer | Architecture Review Agent |

---

## Executive Summary

Issue #306の設計方針書は全体的に高い品質を持ち、変更スコープの限定（ビジネスロジック層のみ）、破壊的変更の防止策、代替案との比較分析が適切に行われている。YAGNI原則の適用（HealthCheckResult.reasonをstring型に限定、対策3のスコープ外判断）やOCP準拠のscheduleNextPoll拡張は特に良い設計判断である。

ただし、must_fix 1件として**多段防御の適用順序に論理的不整合**が発見された。行長チェック（第2段階）がSHELL_PROMPT_ENDINGS判定（第1段階）の後に配置されているため、長い行で末尾が`$`や`#`のケースで設計意図通りに偽陽性を防止できない可能性がある。この修正は実装前に確定すべきである。

---

## Detailed Findings

### Must Fix (1件)

#### F006: isSessionHealthy()の多段防御の適用順序に関する設計不備

| 項目 | 内容 |
|------|------|
| Severity | must_fix |
| Principle | DIP (設計意図と実装構造の整合性) |

**問題**:
設計方針書セクション3.2の擬似コードでは以下の順序で処理が実行される:

1. 第1段階: `SHELL_PROMPT_ENDINGS.some()` ループ内で`%`の個別除外を実行
2. 第2段階: `lastLine.length >= MAX_SHELL_PROMPT_LENGTH` の行長チェック

しかし、第1段階のsome()が`$`や`#`でtrueを返した場合、即座に`{ healthy: false }`が返却され、第2段階の行長チェックに到達しない。

具体例: Claude CLIが以下のような長い出力を生成した場合:
```
The total cost of the project is $1,250,000$
```
この行は60文字以上だが、末尾が`$`のため第1段階でunhealthy判定される。設計書の偽陽性防止戦略テーブルでは「行長チェックで除外」とされているにもかかわらず、コードの実行順序ではそれが機能しない。

**改善提案**:
行長チェックをSHELL_PROMPT_ENDINGSチェックの**前**に移動する:

```typescript
// (1) 最終行抽出
const lines = trimmed.split('\n').filter(line => line.trim() !== '');
const lastLine = lines[lines.length - 1]?.trim() ?? '';

// (2) 行長チェック（共通防御）を先に実行
const MAX_SHELL_PROMPT_LENGTH = 40;
if (lastLine.length >= MAX_SHELL_PROMPT_LENGTH) {
  return { healthy: true };
}

// (3) SHELL_PROMPT_ENDINGSチェック + %個別除外
if (SHELL_PROMPT_ENDINGS.some(ending => {
  if (!lastLine.endsWith(ending)) return false;
  if (ending === '%' && /\d+%$/.test(lastLine)) return false;
  return true;
})) {
  return { healthy: false, reason: `shell prompt ending detected: ${lastLine}` };
}
```

---

### Should Fix (3件)

#### F001: HealthCheckResult interfaceのexport方針

| 項目 | 内容 |
|------|------|
| Severity | should_fix |
| Principle | SRP |

**問題**:
設計方針書では`HealthCheckResult`をファイル内定義（export不要）としつつ、`isSessionHealthy()`を`@internal`でexportしてテストからreason検証を行う。この場合、テスト側で`HealthCheckResult`の型を直接参照できず、`result.reason`のアクセス時に型情報が不完全になる恐れがある。

**改善提案**:
`HealthCheckResult` interfaceも`@internal` exportとする。テストファイルから明示的にimportでき、型安全なテストが書ける。

```typescript
/**
 * @internal Exported for testing purposes only.
 */
export interface HealthCheckResult {
  healthy: boolean;
  reason?: string;
}
```

#### F002: promptKey生成ロジックの重複

| 項目 | 内容 |
|------|------|
| Severity | should_fix |
| Principle | DRY |

**問題**:
`promptKey`の生成ロジック `` `${promptData.type}:${promptData.question}` `` がクライアント側（`useAutoYes.ts:77`）とサーバー側（設計方針書セクション3.3の`pollAutoYes()`）で重複する。

**改善提案**:
共通ユーティリティ関数の切り出しを検討する:

```typescript
// src/lib/prompt-key.ts
export function generatePromptKey(promptData: PromptData): string {
  return `${promptData.type}:${promptData.question}`;
}
```

現時点では1行の式であり優先度は中程度だが、キー構成の変更時に不整合を防止できる。

#### F005: pollAutoYes()の責務集中

| 項目 | 内容 |
|------|------|
| Severity | should_fix |
| Principle | SRP |

**問題**:
設計変更により`pollAutoYes()`に7つの責務が集中する: (1)thinking検出、(2)プロンプト検出、(3)重複チェック、(4)自動応答解決、(5)応答送信、(6)タイムスタンプ更新、(7)クールダウン制御。

**改善提案**:
重複チェックロジックをヘルパー関数に抽出する:

```typescript
function isDuplicatePrompt(
  pollerState: AutoYesPollerState,
  promptKey: string
): boolean {
  return pollerState.lastAnsweredPromptKey === promptKey;
}
```

---

### Should Fix (1件 追加)

#### F009: lastAnsweredPromptKeyのリセット条件のエッジケース文書化

| 項目 | 内容 |
|------|------|
| Severity | should_fix |
| Principle | other (設計文書の完全性) |

**問題**:
プロンプト非検出時に`lastAnsweredPromptKey`をnullリセットする設計だが、Claude CLIが非検出フェーズを経由せずに同一プロンプトを連続表示するエッジケースの挙動が明示されていない。

**改善提案**:
設計書セクション7に「同一promptKeyの連続検出時は意図的にスキップ（重複応答防止の本来の目的）」という明示的な記述を追加する。

---

### Nice to Have (5件)

#### F003: SHELL_PROMPT_ENDINGS個別パターン除外のスケーラビリティ

- **Principle**: OCP
- 現在は`%`のみの除外であり、YAGNI原則とのバランスで現状維持が妥当。将来の拡張方針をコメントに記載する程度で十分。

#### F004: MAX_SHELL_PROMPT_LENGTH=40の境界値テスト

- **Principle**: KISS
- テスト設計（セクション6.1）に39文字/40文字/41文字の境界値テストケースを追加すべき。JSDocに閾値の根拠を明記する。

#### F007: HealthCheckResult.reasonのstring型は適切

- **Principle**: YAGNI
- enumを使わないstring型の判断はYAGNI原則に合致。現状維持で問題ない。肯定的所見。

#### F008: scheduleNextPoll()のoverrideIntervalパラメータ

- **Principle**: DRY
- OCPに準拠した良い拡張設計。現状で問題なし。肯定的所見。

#### F010: 対策3のスコープ外判断

- **Principle**: KISS
- UI変更を伴う大きな変更を分離する判断は適切。スコープ管理として模範的。

---

## 設計原則チェックリスト

| 原則 | 評価 | 備考 |
|------|------|------|
| SRP (単一責任) | Partial | pollAutoYes()の責務集中に注意。HealthCheckResult exportの整理が必要 |
| OCP (開放閉鎖) | Pass | SHELL_PROMPT_ENDINGS配列、scheduleNextPoll overrideInterval |
| LSP (リスコフ置換) | Pass | HealthCheckResultからbooleanへの変換で破壊的変更を防止 |
| ISP (インターフェース分離) | Pass | SHELL_PROMPT_ENDINGSのprivate定義、HealthCheckResultのスコープ限定 |
| DIP (依存性逆転) | Partial | 多段防御の実行順序が設計意図と不整合（F006） |
| KISS | Pass | 対策3スコープ外判断、reason string型、全体のシンプルさ維持 |
| YAGNI | Pass | enum未使用、必要最小限の変更スコープ |
| DRY | Partial | promptKey生成ロジックの重複（F002） |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 多段防御の順序不整合による偽陽性（F006） | Medium | Medium | P1 |
| 技術的リスク | promptKey生成の不整合 | Low | Low | P3 |
| 技術的リスク | pollAutoYes()の複雑度増加 | Low | Medium | P2 |
| セキュリティ | 新規セキュリティリスクなし | - | - | - |
| 運用リスク | クールダウンによる+3秒遅延は許容範囲 | Low | High | P3 |

---

## Approval Status

**Conditionally Approved** - must_fix 1件（F006: 多段防御の適用順序）を修正すれば承認可能。should_fix 3件は実装時に対応を検討すること。

---

*Generated by Architecture Review Agent for Issue #306 Stage 1*

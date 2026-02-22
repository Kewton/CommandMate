# Issue #323 Stage 1 レビューレポート

**レビュー日**: 2026-02-21
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目
**対象Issue**: リファクタリング - `src/lib/auto-yes-manager.ts` の `pollAutoYes()` 責務分割

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue #323は `pollAutoYes()` 関数（139行、7責務、条件分岐14個）の責務分割リファクタリングを提案している。仮説検証で事実関係は全てConfirmed済みであり、Issue記載の数値・参照は正確である。ただし、既存コードとの整合性に関して重大な問題（関数名衝突）が1件、実装方針の明確化が必要な課題が4件、改善提案が3件ある。

---

## Must Fix（必須対応）

### F001: 提案する関数名 `checkStopCondition()` が既存のL409 `checkStopCondition()` と衝突する

**カテゴリ**: 整合性
**場所**: Issue本文 > 主要な変更点 > セクション1の3番目

**問題**:

Issue本文の「主要な変更点」セクションで、`pollAutoYes()` から分割する関数の1つとして以下を挙げている:

> `checkStopCondition()` - 停止条件のデルタベース判定

しかし、現在の `auto-yes-manager.ts` のL409には既に同名の関数が存在する:

```typescript
// L409 (現在のコード)
export function checkStopCondition(worktreeId: string, cleanOutput: string): boolean {
```

この既存 `checkStopCondition()` は Issue #314 で追加された関数であり、`@internal` exportでテストにも公開されている（`tests/unit/lib/auto-yes-manager.test.ts` のL16で import済み）。

既存関数の責務は「正規表現パターンマッチング（validateStopPattern + executeRegexWithTimeout）」であり、Issueが提案する同名関数の責務は「デルタ計算（baseline比較によるnewContent抽出）+ 既存checkStopCondition()の呼び出し」であるため、同名では実装が不可能。

**証拠**:
- 既存コード: `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/auto-yes-manager.ts` L409
- テストimport: `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/tests/unit/lib/auto-yes-manager.test.ts` L16
- Issue本文: 主要な変更点セクション

**推奨対応**:

新関数の命名を変更し、既存 `checkStopCondition()` との関係を明記すること。命名案:
- `processStopConditionDelta(pollerState, worktreeId, cleanOutput)`
- `checkStopConditionWithDelta(pollerState, worktreeId, cleanOutput)`

---

## Should Fix（推奨対応）

### F002: `StopConditionChecker` クラスの導入がプロジェクトの設計パターンと不整合

**カテゴリ**: 実現可能性
**場所**: Issue本文 > 主要な変更点 > セクション2

**問題**:

Issue本文で `StopConditionChecker` クラスの導入を提案しているが、`auto-yes-manager.ts` 全体は関数ベースのモジュール設計で構成されている:

- 状態管理: `globalThis` + `Map<string, AutoYesState/AutoYesPollerState>`
- 操作: 純粋関数（`setAutoYesEnabled`, `disableAutoYes`, `checkStopCondition` 等）
- テスト: `clearAllAutoYesStates()` / `clearAllPollerStates()` による状態リセット

CLAUDE.mdの主要機能モジュール一覧を確認しても、`auto-yes-manager.ts` 内にクラスを導入している例はない。クラスインスタンスの生存期間と `globalThis` ベースの `pollerState` の生存期間が異なる場合、二重管理のリスクがある。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/auto-yes-manager.ts` L64-138（関数ベースの状態管理）
- `pollerState.stopCheckBaselineLength` がL660で `AutoYesPollerState` の一部として初期化

**推奨対応**:

以下のいずれかの方針を明記すること:

(A) クラスではなく関数群として実装（`setBaseline()`, `shouldCheckDelta()`, `calculateDelta()` 等）し、状態は `AutoYesPollerState` のフィールドとして管理（現行方式の延長）

(B) クラスを導入する場合、`AutoYesPollerState` に `StopConditionChecker` インスタンスを保持するフィールドを追加し、シリアライゼーション不要であることを明記

---

### F003: `validatePollingContext()` と `isValidWorktreeId()` の責務境界が不明確

**カテゴリ**: 実現可能性
**場所**: Issue本文 > 主要な変更点 > セクション1の1番目

**問題**:

提案されている `validatePollingContext()` は「ポーリング前提条件チェック」と記載されているが、以下の既存チェックのうちどれを担うか不明確:

| 関数 | チェック内容 | 行番号 |
|------|------------|--------|
| `startAutoYesPolling()` | `isValidWorktreeId()` | L630 |
| `startAutoYesPolling()` | `getAutoYesState()?.enabled` | L635-636 |
| `startAutoYesPolling()` | `MAX_CONCURRENT_POLLERS` | L642-644 |
| `pollAutoYes()` | `pollerState` 存在確認 | L457-458 |
| `pollAutoYes()` | `autoYesState?.enabled \|\| isAutoYesExpired()` | L461-465 |

**推奨対応**:

`validatePollingContext()` の具体的な責務範囲を明記すること:
- (A) `pollAutoYes()` 冒頭の L457-465 のみを抽出（推奨: 最小限の変更で明確）
- (B) `startAutoYesPolling()` の前提条件チェックも含めて統合（この場合は `startAutoYesPolling()` のリファクタリングも必要になるため影響範囲が拡大）

---

### F004: 機能不変の保証が「既存テスト全パス」のみでは不十分

**カテゴリ**: 受入条件
**場所**: Issue本文 > 受入条件

**問題**:

受入条件:
> - 既存テスト（`tests/unit/lib/auto-yes-manager.test.ts`）が全てパスすること
> - 機能変更がないこと（外部インターフェースは維持）

テストファイル確認の結果、`pollAutoYes()` のテストは全て結合的テスト（`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` 経由で間接的に `pollAutoYes()` を起動）であり、分割後の個別関数の単体テストは存在しない。

リファクタリングの主目的が「テスタビリティ向上」であるにもかかわらず、テスト追加が受入条件に含まれていないため、リファクタリング効果を客観的に検証できない。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/tests/unit/lib/auto-yes-manager.test.ts` L481-554（pollAutoYes関連テストは全てadvanceTimersByTimeAsync経由）

**推奨対応**:

受入条件に以下を追加:

> - 分割された各関数に対する個別テストが追加されていること（少なくとも正常系・異常系各1ケース）

---

### F005: `captureAndCleanOutput()` の責務範囲にthinkingウィンドウイングが含まれるか不明確

**カテゴリ**: 正確性
**場所**: Issue本文 > 主要な変更点 > セクション1の2番目

**問題**:

`captureAndCleanOutput()` は「tmux出力取得・ANSIクリーニング」と記載されているが、現在の `pollAutoYes()` の対応箇所には3段階の処理がある:

```
L469: captureSessionOutput()  -- tmux出力取得
L472: stripAnsi()             -- ANSIクリーニング
L492: split → slice(-50) → join  -- thinkingウィンドウイング
L493-496: detectThinking()    -- thinking状態検出
```

`captureAndCleanOutput()` がウィンドウイング（L492）を含まない場合、`captureSessionOutput()` + `stripAnsi()` のラッパー関数（実質2行）となり、抽出の価値が疑問。含む場合は `detectThinking` の外部依存も引き継ぎ、「ANSIクリーニング」以上の責務を持つ。

**推奨対応**:

`captureAndCleanOutput()` の戻り値の型を明記すること。例:

```typescript
interface CapturedOutput {
  cleanOutput: string;     // 全体のクリーン出力
  recentLines: string;     // detectThinking用のウィンドウ
  isThinking: boolean;     // thinking状態判定結果
}
```

---

## Nice to Have（あれば良い）

### F006: `detectAndRespondToPrompt()` が目標行数（20-40行）を超過する可能性

**カテゴリ**: 整合性
**場所**: Issue本文 > Before / After

Issue本文で「各関数が単一責務（20-40行）」としているが、`pollAutoYes()` のL527-582（プロンプト検出から応答完了まで）は55行あり、さらにエラーハンドリング（L583-589）も含めると60行超となる。全てを `detectAndRespondToPrompt()` に含めると目標を超過する。内部でさらに分割する可能性について言及するか、行数目標に幅を持たせることを推奨。

---

### F007: pollerState存在確認の共通化方針に具体案がない

**カテゴリ**: 整合性
**場所**: Issue本文 > 受入条件

受入条件に「pollerState存在確認の重複が解消されていること」とあるが、具体的な共通化ヘルパーのシグネチャや、6箇所以上の呼び出し元（pollAutoYes, scheduleNextPoll, stopAutoYesPolling, updateLastServerResponseTimestamp, resetErrorCount, incrementErrorCount）への適用方針が示されていない。

ヘルパー関数の戻り値が `AutoYesPollerState | null` の場合、呼び出し元でnullチェック+returnが必要となり、コード量はほぼ同じ。TypeScriptのnarrowing（`if (!state) return` パターン）自体は十分に明確なため、共通化の費用対効果を検討すること。

---

### F008: 「4-5個の単一責務関数に分割」の検証方法が不明確

**カテゴリ**: 受入条件
**場所**: Issue本文 > 受入条件

「単一責務」の判断基準が主観的であり、レビュー時に議論が生じる可能性がある。各関数の期待される入出力（引数の型と戻り値の型）を事前に定義しておくと、実装・レビュー双方の効率が向上する。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/auto-yes-manager.ts` | リファクタリング対象（706行） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/tests/unit/lib/auto-yes-manager.test.ts` | 既存テスト（1517行）- リファクタリング後も全パス必須 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/config/auto-yes-config.ts` | 依存先: validateStopPattern, AutoYesDuration等 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/prompt-key.ts` | 依存先: generatePromptKey() |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/auto-yes-resolver.ts` | 依存先: resolveAutoAnswer() |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/session-cleanup.ts` | 呼び出し元: stopAutoYesPolling() をimport |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/app/api/worktrees/[id]/auto-yes/route.ts` | 呼び出し元: APIルート（外部インターフェース） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/CLAUDE.md` | プロジェクトガイドライン・設計パターン確認 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/dev-reports/issue/323/issue-review/hypothesis-verification.md` | 仮説検証結果（全Confirmed） |

---

*Generated by issue-review-agent (Stage 1: 通常レビュー)*

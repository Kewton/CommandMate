# Issue #314 Stage 4: Security Review (OWASP Top 10)

## Executive Summary

Issue #314はAuto-Yesモードにユーザー定義の正規表現パターンによるStop条件機能を追加する設計である。ユーザー入力の正規表現をサーバーサイドで実行するという性質上、ReDoS（Regular Expression Denial of Service）が最も重大なセキュリティリスクである。

設計書では`MAX_STOP_PATTERN_LENGTH=500`と`try-catch`による構文検証をReDoS対策として挙げているが、これらはカタストロフィックバックトラッキングパターンを防止できない。Node.jsのシングルスレッド環境でReDoSが発生すると、サーバー全体が応答不能になるため、タイムアウト保護またはパターン安全性検証の追加が必須である。

その他のセキュリティ領域（入力バリデーション、XSS、アクセス制御、情報漏洩、ログ安全性）については概ね適切に設計されているが、改善の余地がある。

**Status**: conditionally_approved (Score: 3/5)

---

## Review Scope

| Item | Detail |
|------|--------|
| Issue | #314: Auto-Yesにターミナル出力のStop条件（正規表現）を追加 |
| Stage | 4 - Security Review |
| Design Doc | `dev-reports/design/issue-314-auto-yes-stop-condition-design-policy.md` |
| Previous Stages | Stage 1 (4/5), Stage 2 (4/5), Stage 3 (4/5) |
| Review Date | 2026-02-19 |

---

## OWASP Top 10 Checklist

### [x] A01: Broken Access Control

**Evaluation**: Moderate risk, acceptable for current scope.

- `auto-yes/route.ts` POSTハンドラにはworktreeIdフォーマット検証（`isValidWorktreeId()`）が実装済み
- `validateWorktreeExists()`でDB上の存在確認を実施
- `stopPattern`はworktreeIdでスコープされた`autoYesStates` Mapに保存
- **注意**: 認証・認可メカニズムは未実装だが、CommandMateはローカルツールであるため許容範囲
- **問題**: `current-output/route.ts`のGETハンドラにはworktreeIdフォーマット検証がない（DS4-F006）

### [x] A02: Cryptographic Failures

**Evaluation**: Not applicable.

- `stopPattern`は機密データではない
- 暗号化は不要

### [x] A03: Injection

**Evaluation**: Critical concern - ReDoS injection.

- **最重要リスク**: ユーザー入力の正規表現がReDoSに悪用される可能性がある（DS4-F001, DS4-F002）
- 入力バリデーション: `validateStopPattern()`による長さ制限（500文字）と構文検証は実装されているが不十分
- SQL Injection: プリペアドステートメント使用により防止済み
- XSS: Reactのエスケーピングにより防止済み（DS4-F008）
- Command Injection: `WORKTREE_ID_PATTERN`による入力検証で防止済み

### [x] A04: Insecure Design

**Evaluation**: Design gap in ReDoS timeout protection.

- Stop条件チェックにタイムアウト機構がない
- `MAX_CONCURRENT_POLLERS=50`のDoS保護は実装済みだが、ReDoSとの複合リスクが存在

### [x] A05: Security Misconfiguration

**Evaluation**: Low risk.

- `stopReason`はenum値（定型文字列）のみ返却し、パターン内容を公開しない設計は適切
- globalThisによるインメモリ管理はサーバー再起動でクリアされる（DS4-F010）

### [x] A06: Vulnerable and Outdated Components

**Evaluation**: Critical - ReDoS vulnerability in regex execution.

- `new RegExp(pattern).test(input)`はNode.jsのV8エンジンのバックトラッキング正規表現エンジンを使用
- カタストロフィックバックトラッキングに脆弱
- `safe-regex2`や`re2`の不使用は、明確なリスク受容が必要（DS4-F001）

### [x] A07: Identification and Authentication Failures

**Evaluation**: Not applicable (local tool).

### [x] A08: Software and Data Integrity Failures

**Evaluation**: Low risk.

- `validateStopPattern()`がクライアント・サーバー両方で実行されるDefense in Depth設計は適切
- サーバーサイドでの再バリデーションにより、クライアント側バイパスを防止

### [x] A09: Security Logging and Monitoring Failures

**Evaluation**: Moderate concern.

- ログ出力にworktreeIdが文字列連結されている（DS4-F005）
- stopPatternの内容がエラーログに漏洩しない設計は適切
- 構造化ログへの移行を推奨

### [x] A10: Server-Side Request Forgery (SSRF)

**Evaluation**: Not applicable.

---

## Detailed Findings

### Must Fix (2 items)

#### DS4-F001: ReDoS対策が長さ制限とtry-catchのみでカタストロフィックバックトラッキングを防止できない

| Field | Value |
|-------|-------|
| Severity | must_fix |
| Category | ReDoS |
| OWASP | A06: Vulnerable and Outdated Components |

**Problem**:

設計書セクション7のReDoS対策は以下の3点のみである:

1. `MAX_STOP_PATTERN_LENGTH = 500` によるパターン長制限
2. `new RegExp(pattern)` による構文検証
3. 照合対象の5000文字バッファ制限

しかし、これらの対策は**カタストロフィックバックトラッキング**を防止できない。以下のパターンは全て500文字以下で構文的に有効だが、5000文字の入力に対してO(2^n)の計算時間を要する:

```
(a+)+$         -- 15文字以下
(a|a)+$        -- 15文字以下
([a-zA-Z]+)*$  -- 20文字以下
(.*a){20}      -- 10文字以下
```

設計書では「500文字以下のパターンに対する実用的なReDoSリスクは低い」と記載されているが、これはパターン長とリスクの関係を誤認している。ReDoSの危険性はパターンの**構造**に依存し、パターン長には依存しない。

**Proof of Concept**:

```javascript
// 10文字のパターンで5000文字の入力 -> 指数的計算時間
const regex = new RegExp('(a+)+$');
const input = 'a'.repeat(30) + 'b';  // 31文字でも数秒
regex.test(input);  // -> Node.js event loop blocked
```

**Impact**: Node.jsイベントループがブロックされ、API応答不能、全worktreeのポーリング停止。

**Suggestion**:

多層防御の実装を推奨する:

1. **必須（初期実装）**: `checkStopCondition()`にタイムアウト保護を追加
   ```typescript
   function safeRegexTest(pattern: string, input: string, timeoutMs: number = 100): boolean {
     // Option A: vm.runInNewContext with timeout
     const vm = require('vm');
     const script = new vm.Script(`new RegExp(pattern).test(input)`);
     const context = vm.createContext({ pattern, input });
     return script.runInContext(context, { timeout: timeoutMs });
   }
   ```

2. **推奨（初期実装）**: `validateStopPattern()`にsafe-regex2によるパターン安全性チェックを追加
   ```typescript
   import safeRegex from 'safe-regex2';

   if (!safeRegex(pattern)) {
     return { valid: false, error: 'Pattern may cause performance issues' };
   }
   ```

---

#### DS4-F002: checkStopCondition()のRegExp.test()にタイムアウトが設計されていない

| Field | Value |
|-------|-------|
| Severity | must_fix |
| Category | ReDoS |
| OWASP | A06: Vulnerable and Outdated Components |

**Problem**:

`checkStopCondition()`は同期的に`regex.test(cleanOutput)`を実行する:

```typescript
// 設計書セクション6より
const regex = new RegExp(autoYesState.stopPattern);
if (regex.test(cleanOutput)) {  // <- No timeout protection
  disableAutoYes(worktreeId, 'stop_pattern_matched');
  stopAutoYesPolling(worktreeId);
  return true;
}
```

`pollAutoYes()`から2秒間隔で呼び出されるため、1回のReDoSでメインスレッドが長時間ブロックされると:

- 同一プロセス内の全APIルートが応答不能
- 他のworktreeのポーリングも停止
- クライアント側のfetchCurrentOutput()がタイムアウト

**Suggestion**:

`checkStopCondition()`にタイムアウト付き正規表現実行を実装する。DS4-F001の対策と組み合わせて多層防御とすること。

---

### Should Fix (6 items)

#### DS4-F003: validateStopPattern()がカタストロフィックバックトラッキングパターンを検出しない

| Field | Value |
|-------|-------|
| Severity | should_fix |
| Category | Injection |
| OWASP | A03 |

設計書の`validateStopPattern()`実装:

```typescript
export function validateStopPattern(pattern: string): { valid: boolean; error?: string } {
  if (pattern.length > MAX_STOP_PATTERN_LENGTH) {
    return { valid: false, error: `Pattern must be ${MAX_STOP_PATTERN_LENGTH} characters or less` };
  }
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid regular expression syntax' };
  }
}
```

この実装は構文エラーのみを検出し、意味的に危険なパターンを検出できない。`safe-regex2`パッケージ（MIT、0依存、軽量）の導入を推奨する。

---

#### DS4-F004: stopReasonの情報公開方針の明確化

| Field | Value |
|-------|-------|
| Severity | should_fix |
| Category | Information Disclosure |
| OWASP | A05 |

`stopReason`はenum値のみであり直接的な情報漏洩リスクは低いが、将来の拡張でマッチ詳細（マッチ位置、マッチ文字列）がレスポンスに含まれるリスクがある。API JSDocに「stopReasonはenum値のみを返し、パターン内容やマッチ詳細は一切返却しない」方針を明記すべきである。

---

#### DS4-F005: ログ出力の構造化とログインジェクション防止

| Field | Value |
|-------|-------|
| Severity | should_fix |
| Category | Logging |
| OWASP | A09 |

現在の設計:
```typescript
console.warn(`[Auto-Yes] Stop condition matched for worktree: ${worktreeId}`);
console.warn(`[Auto-Yes] Invalid stop pattern for worktree: ${worktreeId}`);
```

`worktreeId`は`WORKTREE_ID_PATTERN`で検証済みのため実質的なリスクは低いが、構造化ログ形式への統一を推奨:
```typescript
console.warn('[Auto-Yes] Stop condition matched', { worktreeId });
```

---

#### DS4-F006: current-output/route.tsにworktreeIdフォーマット検証がない

| Field | Value |
|-------|-------|
| Severity | should_fix |
| Category | Access Control |
| OWASP | A01 |

`auto-yes/route.ts`のPOSTハンドラには`isValidWorktreeId(params.id)`が実装されているが、`current-output/route.ts`のGETハンドラには未実装。stopReason返却機能の追加に伴い、同ルートへの入力検証を追加すべきである。

既存コード（`current-output/route.ts` L31）:
```typescript
const worktree = getWorktreeById(db, params.id);  // <- No format validation before DB query
```

---

#### DS4-F007: worktreeスコープのアクセス制御前提の明記

| Field | Value |
|-------|-------|
| Severity | should_fix |
| Category | Data Persistence |
| OWASP | A05 |

globalThisのautoYesStatesはworktreeIdでスコープされているが、認証メカニズムは不在。ローカルツールとしての前提を設計書に明記すべきである。

---

#### DS4-F008: validateStopPattern()のエラーメッセージにユーザー入力を含めない方針の維持

| Field | Value |
|-------|-------|
| Severity | should_fix |
| Category | XSS |
| OWASP | A03 |

現在の設計は固定文字列のエラーメッセージを返却しており安全だが、将来のリファクタリングでnew RegExp()のerror.messageを返却するように変更された場合、XSSリスクが発生する。コードコメントに注記を追加すること。

---

### Nice to Have (3 items)

#### DS4-F009: Stop条件マッチングのレートリミット

50並列worktreeでのReDoS複合リスクは、DS4-F001/F002の対策で軽減される。追加対策としてタイムアウト発生時のstopPattern自動無効化を検討。

#### DS4-F010: サーバー再起動時のstopPatternクリアの明示的ドキュメント

globalThisのインメモリ管理によりサーバー再起動で全状態がクリアされる。設計書にセキュリティ上の正しい動作である旨を追記。

#### DS4-F011: RegExpフラグ制御方針の明記

`checkStopCondition()`はフラグなしでRegExpを構築する設計。test()による真偽判定のみを行うため問題ないが、方針を設計書に明記。

---

## Risk Assessment

| Risk Type | Level | Description | Priority |
|-----------|-------|-------------|----------|
| Technical | Medium | ReDoSによるNode.jsイベントループブロックがサーバー全体に影響。タイムアウト保護で緩和可能 | P1 |
| Security | High | ユーザー入力正規表現のReDoS脆弱性。safe-regex2またはタイムアウトによる対策が必須 | P1 |
| Operational | Medium | 50並列worktreeでのReDoS複合リスク。運用ガイドラインの整備で緩和可能 | P2 |

---

## Security Design Strengths

本設計で評価すべきセキュリティ上の強みを記載する:

1. **Defense in Depth**: `validateStopPattern()`をクライアント・サーバー両方で実行するバリデーション設計
2. **Input Sanitization**: `body.stopPattern?.trim() || undefined`による空文字列正規化
3. **Scope Isolation**: worktreeIdによるstopPatternのスコープ分離
4. **Error Handling**: `checkStopCondition()`のtry-catchによる無効パターン防御
5. **Information Minimization**: stopReasonはenum値のみ返却し、パターン内容を公開しない
6. **Existing Security**: `WORKTREE_ID_PATTERN`による入力検証、`isAllowedDuration()`によるホワイトリスト検証

---

## Conditional Approval Requirements

本レビューは**条件付き承認**とする。以下の条件を満たすことで承認に移行する:

1. **DS4-F001**: ReDoS対策としてタイムアウト保護またはsafe-regex2によるパターン安全性検証を`checkStopCondition()`または`validateStopPattern()`に追加すること
2. **DS4-F002**: `checkStopCondition()`のRegExp.test()実行にタイムアウト機構を設けること（DS4-F001と統合可能）

上記2項目は実質的に同一の対策であり、以下のいずれかの方式で対応可能:

- **方式A（推奨）**: `validateStopPattern()`にsafe-regex2チェックを追加し、危険なパターンの登録自体を拒否 + `checkStopCondition()`にvm.runInNewContextタイムアウト保護
- **方式B（最低限）**: `checkStopCondition()`にvm.runInNewContextタイムアウト保護のみ追加
- **方式C（代替）**: `validateStopPattern()`にsafe-regex2チェックのみ追加（タイムアウトなし）

---

## Reviewed Files

| File | Review Focus |
|------|-------------|
| `dev-reports/design/issue-314-auto-yes-stop-condition-design-policy.md` | Full design document security analysis |
| `src/lib/auto-yes-manager.ts` | Existing security patterns, state management |
| `src/config/auto-yes-config.ts` | Existing validation patterns |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | API input validation, access control |
| `src/app/api/worktrees/[id]/current-output/route.ts` | Response data exposure, input validation gap |
| `src/components/worktree/AutoYesConfirmDialog.tsx` | Client-side input handling, XSS |
| `src/components/worktree/AutoYesToggle.tsx` | Component security |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Data flow, type safety |
| `src/lib/sanitize.ts` | Existing sanitization patterns |
| `src/lib/utils.ts` | escapeRegExp existing pattern |

---

*Generated by architecture-review-agent (Stage 4: Security Review) on 2026-02-19*

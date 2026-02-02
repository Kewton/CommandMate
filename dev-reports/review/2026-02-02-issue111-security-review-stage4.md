# Security Review Report - Issue #111

## Review Information

| Item | Value |
|------|-------|
| Issue | #111 - 現在の作業ブランチ可視化機能 |
| Stage | 4 - セキュリティレビュー |
| Focus | セキュリティ (OWASP Top 10) |
| Date | 2026-02-02 |
| Design Doc | `dev-reports/design/issue-111-branch-visualization-design-policy.md` |

---

## Executive Summary

設計書のセキュリティ設計は基本的に適切であり、OWASP Top 10の主要脆弱性に対する対策が講じられている。`execFile`使用によるコマンドインジェクション防止、DBからの信頼パス取得、タイムアウト設定など、重要なセキュリティプラクティスが採用されている。

**総合評価: 低リスク - セキュリティ観点で実装可能**

---

## Findings Summary

| Priority | Count | Description |
|----------|-------|-------------|
| Must Fix | 2 | 重大なセキュリティ懸念、実装前に対応必須 |
| Should Fix | 4 | 中程度の懸念、対応推奨 |
| Good | 3 | 適切なセキュリティ設計 |
| Info | 2 | 参考情報 |

---

## Must Fix Items

### SEC-MF-001: execFile timeout handling may leak error details

**Category**: Injection (A03:2021) / Security Misconfiguration (A05:2021)

**Description**:
設計書Section 8.1ではexecFile使用を明記しているが、Section 5.2のエラーハンドリングでタイムアウトエラー時に`'(unknown)'`を返すのみで、エラー詳細のログ出力方針が未記載。エラー詳細が意図せずクライアントに漏洩するリスク。

**Evidence**:
- Design Doc Section 5.2: タイムアウト時 `currentBranch = '(unknown)'`
- Concern: エラーオブジェクトの内容がログやレスポンスに含まれる可能性

**Recommendation**:
1. `getGitStatus`関数内でエラーをcatchした際、エラー詳細はサーバーログのみに出力し、クライアントには汎用エラー値(`'(unknown)'`)のみを返す方針を設計書に明記
2. worktreePathがログに含まれる場合の考慮を追記

**Affected Files**: `src/lib/git-utils.ts`

---

### SEC-MF-002: ブランチ名表示時のXSS対策が未明記

**Category**: Injection - XSS (A03:2021)

**Description**:
gitから取得したブランチ名(`currentBranch`, `initialBranch`)をフロントエンドで表示する際のXSS対策が設計書に記載されていない。Reactのデフォルトエスケープに依存する前提を明記すべき。

**Evidence**:
- Design Doc Section 6.1: BranchMismatchAlert.tsx でブランチ名を表示
- Concern: 悪意あるブランチ名（例: `<script>alert(1)</script>`）への対処

**Recommendation**:
1. Section 8にXSS対策セクションを追加
2. Reactの自動エスケープ機能への依存を明記
3. `dangerouslySetInnerHTML`使用禁止を明記
4. ブランチ名がgitコマンドの出力から直接取得される安全な経路であることを記載

**Affected Files**:
- `src/components/worktree/BranchMismatchAlert.tsx`
- `src/components/worktree/WorktreeDetailRefactored.tsx`
- `src/components/mobile/MobileHeader.tsx`

---

## Should Fix Items

### SEC-SF-001: worktreePath引数の信頼境界が暗黙的

**Category**: Command Injection (A03:2021)

**Description**:
git-utils.tsの`getGitStatus(worktreePath)`でworktreePathをcwd引数として使用する設計だが、worktreePathの信頼境界(DBから取得した値のみを使用)が設計書で暗黙的になっている。

**Recommendation**:
1. `getGitStatus`関数のJSDocに`@param worktreePath - Must be a trusted path from database, not user input`を追加
2. 呼び出し元route.tsで`worktree.path`を直接渡すことを設計書で明記

---

### SEC-SF-002: saveInitialBranch関数のパラメータ化確認

**Category**: SQL Injection (A03:2021)

**Description**:
設計書Section 3.3で提案されている`saveInitialBranch`関数のSQL実装がプリペアドステートメントを使用することを明示していない。

**Recommendation**:
Section 3.3に`saveInitialBranch`実装例を追加し、`db.prepare()`使用を明記:

```typescript
db.prepare('UPDATE worktrees SET initial_branch = ? WHERE id = ?')
  .run(branchName, worktreeId);
```

---

### SEC-SF-003: gitコマンドタイムアウト値の根拠と上限設定

**Category**: DoS Prevention

**Description**:
設計書でgitコマンドのタイムアウトを1秒と設定しているが、この値の根拠と、大規模リポジトリやネットワークマウントストレージでの動作への影響評価が未記載。

**Recommendation**:
1. 1秒の根拠を追記（ローカルSSD想定で10-50ms、10倍マージン）
2. タイムアウト時のユーザーフィードバック（ブランチ情報更新失敗）方針を明記
3. タイムアウト値を設定可能にするか検討（将来課題）

---

### SEC-SF-004: initial_branchカラムの情報漏洩リスク評価

**Category**: Sensitive Data Exposure (A02:2021)

**Description**:
`initial_branch`はブランチ名を保存するが、ブランチ名にはIssue番号やfeature名など開発情報が含まれる場合がある。APIレスポンスでの公開範囲を検討すべき。

**Recommendation**:
1. 現状の設計で問題なしと判断可能（同じリポジトリにアクセスできるユーザーのみがAPIを使用）
2. 認証済みユーザーのみがAPIアクセス可能であることを前提として記載
3. CM_AUTH_TOKEN認証との関係を確認

---

## Good Practices Identified

### SEC-G-001: execFile使用による安全なコマンド実行設計

設計書Section 8.1で`execFile`使用を明記し、引数を固定文字列のみとすることでコマンドインジェクションを防止。`exec()`からの改善として適切。

```typescript
execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
  cwd: worktreePath,
  timeout: 1000
});
```

---

### SEC-G-002: パストラバーサル対策のDB依存設計

設計書Section 8.2で`worktreePath`をDBから取得した値のみ使用と明記。外部からのパス指定を受け付けない設計で、パストラバーサル攻撃を防止。

---

### SEC-G-003: gitコマンド失敗時の安全なフォールバック

設計書Section 5.2でgitコマンド失敗時、タイムアウト時、detached HEAD時の安全なフォールバック値を定義。サービス継続性を確保。

| State | currentBranch | isBranchMismatch |
|-------|---------------|------------------|
| Normal | Branch name | true/false |
| Detached HEAD | `(detached HEAD)` | false |
| Git command failure | `(unknown)` | false |
| Timeout | `(unknown)` | false |

---

## OWASP Top 10 Compliance

| Category | Status | Risk Level |
|----------|--------|------------|
| A01: Broken Access Control | Compliant | Low |
| A02: Cryptographic Failures | N/A | None |
| A03: Injection | Mostly Compliant | Low |
| A04: Insecure Design | Compliant | Low |
| A05: Security Misconfiguration | Mostly Compliant | Low |
| A06: Vulnerable Components | N/A | None |
| A07: Authentication Failures | N/A | None |
| A08: Software/Data Integrity | Compliant | None |
| A09: Security Logging/Monitoring | Compliant | None |
| A10: SSRF | N/A | None |

### Action Required for Full Compliance

- **A03 (Injection)**: XSS対策方針の明記（SEC-MF-002）、SQL prepare文使用の明記（SEC-SF-002）
- **A05 (Security Misconfiguration)**: エラー詳細のログ出力方針明記（SEC-MF-001）

---

## Threat Model Summary

| Attack Surface | Threats | Mitigations | Residual Risk |
|----------------|---------|-------------|---------------|
| Git command execution | Command injection, Path traversal, DoS | execFile, Fixed args, DB path, Timeout | Very Low |
| API response | Information disclosure, XSS | Generic values only, React escaping | Very Low |
| Database operations | SQL injection | Prepared statements | Very Low |
| Frontend display | XSS, UI injection | React auto-escaping | Very Low |

---

## Security Checklist

| Check | Status | Notes |
|-------|--------|-------|
| Input Validation | Pass | Git args fixed, worktreePath from DB |
| Output Encoding | Pass | React auto-escaping (explicit documentation recommended) |
| Authentication | Pass | Relies on existing CM_AUTH_TOKEN |
| Authorization | Pass | Worktree owner access only |
| Cryptography | N/A | No crypto operations |
| Error Handling | Pass | Generic error values prevent leakage |
| Logging | Pass | Uses existing logging (details recommended) |
| Data Protection | Pass | Branch names are not sensitive |

---

## Recommendations for Design Doc Update

### Section 8 追加項目

```markdown
### 8.3 XSS対策

- **Reactエスケープ依存**: ブランチ名表示はReactの自動エスケープ機能に依存
- **dangerouslySetInnerHTML禁止**: BranchMismatchAlert, ヘッダーコンポーネントで使用禁止
- **データ経路の安全性**: ブランチ名はgitコマンド出力から直接取得、ユーザー入力経路なし

### 8.4 エラーログ方針

- **サーバーログ**: エラー詳細（worktreeId, エラー種別）をERRORレベルで出力
- **クライアント応答**: 汎用値('(unknown)')のみ返却、詳細情報は含めない
- **パス情報**: ログにworktreePathを含める場合はセキュリティ考慮済み（サーバーサイドのみ）
```

### Section 3.3 実装例追加

```typescript
export function saveInitialBranch(
  db: Database.Database,
  worktreeId: string,
  branchName: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET initial_branch = ?
    WHERE id = ?
  `);
  stmt.run(branchName, worktreeId);
}
```

---

## Conclusion

設計書は主要なセキュリティ対策を適切に講じている。以下の項目を対応することで、セキュリティ観点での実装準備が完了する:

1. **Must Fix (2件)**: XSS対策の明記、エラー詳細漏洩防止方針の追記
2. **Should Fix (4件)**: 信頼境界の明示化、SQLパラメータ化の明記、タイムアウト根拠、情報漏洩評価

全体的なセキュリティリスクは**低**であり、OWASP Top 10への準拠度も**高い**レベルにある。

---

*Generated by architecture-review-agent (Stage 4: Security Review)*

# Architecture Review Report: Issue #136 - Security Review (Stage 4)

**Issue Number**: #136
**Review Type**: Security Review (Stage 4 of Multi-Stage Design Review)
**Review Date**: 2026-02-03
**Reviewer**: Claude Code Architecture Review Agent
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

Issue #136 の設計方針書（Git Worktree 並列開発環境の整備）に対するセキュリティレビュー（Stage 4）を実施しました。OWASP Top 10 2021 に基づく評価の結果、基本的なセキュリティ設計は適切に行われていますが、**2件の必須修正項目**と**5件の推奨修正項目**を特定しました。

### Overall Assessment

| Category | Rating | Notes |
|----------|--------|-------|
| Injection Prevention | Concern | git worktree add の入力検証仕様が不足 |
| Authentication/Authorization | Partial | トークン共有によるセキュリティ境界の曖昧さ |
| Sensitive Data Protection | OK | 認証トークン生成・保護は適切 |
| Path Traversal Prevention | Partial | TOCTOU リスクが残存 |
| Security Misconfiguration | Partial | DoS対策とパーミッション設定に改善余地 |
| Security Logging | Partial | Worktree操作のログ記録が不足 |

---

## OWASP Top 10 2021 Compliance

### A01:2021 - Broken Access Control

**Status**: Partial Compliance

**良い点**:
- パストラバーサル対策として `fs.realpathSync()` による検証を設計 (Section 7.4)
- ホームディレクトリ外へのアクセス禁止を明記
- Issue番号の数値バリデーションを想定

**懸念点**:
- ResourcePathResolver の `validate()` メソッドで TOCTOU 脆弱性リスク (SF-SEC-001)
- 認証トークン共有によりセキュリティ境界が曖昧 (MF-SEC-002)

### A03:2021 - Injection

**Status**: Concern

**現状の設計**:
```typescript
// Section 4.3 CreateWorktreeCommand
async execute(context: SetupContext): Promise<void> {
  await this.worktreeCreator.create(context.issueNo);
  // issueNo の検証仕様が明示されていない
}
```

**リスク**:
- `git worktree add feature/${issueNo}-xxx` のようなコマンド実行時、issueNo に特殊文字が含まれるとコマンドインジェクションの可能性
- ブランチ名の入力検証仕様も未定義

**既存実装の良い例** (`src/lib/git-utils.ts`):
```typescript
// Security: Uses execFile (not exec) to prevent command injection
const { stdout } = await execFileAsync('git', args, { cwd, timeout });
```

### A04:2021 - Insecure Design

**Status**: Partial Compliance

**懸念点**:
- エラーメッセージに内部パス情報を含める設計
- `Error: Path traversal detected: /path/to/file resolves outside of /allowed/dir`
- これらは攻撃者への情報提供となる

**推奨パターン** (`src/lib/git-utils.ts`):
```typescript
// Error details are logged server-side, not exposed to client
console.error(`[git-utils] Git command failed:`, { args, error });
return null; // クライアントには詳細を返さない
```

### A05:2021 - Security Misconfiguration

**Status**: Partial Compliance

**良い点**:
- ポート範囲制限 (3001-3100)
- 特権ポート (1-1023) の使用禁止
- PIDファイル O_EXCL アトミック書き込み

**懸念点**:
- ポート枯渇攻撃への対策未記載
- pids/ ディレクトリ作成時のパーミッション設定タイミングが不明確

### A07:2021 - Identification and Authentication Failures

**Status**: Partial Compliance

**現状の設計** (Section 7.1):
```
- グローバル .env の CM_AUTH_TOKEN を全Worktreeで共有
- Worktree固有トークンが必要な場合は .env で上書き可能
```

**問題点**:
- 単一トークン漏洩で全Worktree環境へのアクセスが可能
- トークンの優先順位・検証フローが不明確

### A09:2021 - Security Logging and Monitoring Failures

**Status**: Partial Compliance

**既存の良い実装** (`src/cli/utils/security-logger.ts`):
```typescript
export function logSecurityEvent(event: SecurityEvent): void {
  // マスキング処理済みのセキュリティイベントをログに記録
}
```

**懸念点**:
- Worktree 作成/削除/起動/停止のセキュリティイベント記録が設計されていない
- NTH-IMP-002 で「将来検討」扱いになっているが、監査上重要

---

## Detailed Findings

### Must Fix (Critical/High Severity)

#### MF-SEC-001: git worktree add コマンドの入力検証不足

| Attribute | Value |
|-----------|-------|
| Severity | Critical |
| OWASP Category | A03:2021 - Injection |
| Affected Sections | 4.3, 7 |

**問題の詳細**:

設計書では `WorktreeCreator` による `git worktree add` コマンドの実行が想定されていますが、issueNo およびブランチ名の入力検証仕様が不足しています。

**攻撃シナリオ**:
```
issueNo = "123; rm -rf /"  // シェルメタキャラクタを含む入力
// git worktree add feature/123; rm -rf /-xxx
```

**推奨対応**:

1. issueNo は厳密な正の整数検証を明示:
```typescript
function validateIssueNo(issueNo: unknown): number {
  if (typeof issueNo !== 'number' ||
      !Number.isInteger(issueNo) ||
      issueNo <= 0 ||
      issueNo > 2147483647) { // MAX_SAFE_INTEGER の代わりに適切な上限
    throw new Error('Invalid issue number');
  }
  return issueNo;
}
```

2. git コマンド実行には `spawn`/`execFile` を使用（既存実装と統一）
3. ブランチ名は `[a-zA-Z0-9_/-]` のホワイトリスト検証を追加
4. 設計書 Section 7 に入力検証仕様セクションを追加

---

#### MF-SEC-002: Worktree間の認証トークン共有によるセキュリティ境界の曖昧さ

| Attribute | Value |
|-----------|-------|
| Severity | High |
| OWASP Category | A01:2021 - Broken Access Control |
| Affected Sections | 7.1 |

**問題の詳細**:

Section 7.1 で「グローバル .env の `CM_AUTH_TOKEN` を全Worktreeで共有」と記載されていますが、これにより：
- 単一のトークン漏洩で全Worktree環境へのアクセスが可能
- Worktree間のセキュリティ境界が存在しない

**リスクマトリクス**:

| シナリオ | 影響 | 発生確率 |
|---------|------|---------|
| 開発者PCの侵害 | 全Worktreeアクセス可能 | Medium |
| ログファイルへのトークン誤記録 | 全Worktreeアクセス可能 | Low |
| 環境変数の誤公開 | 全Worktreeアクセス可能 | Low |

**推奨対応**:

1. Worktree毎の独立トークン生成をデフォルトオプションとして追加:
```typescript
// commandmate init --issue 135
// -> ~/.commandmate/worktrees/135/.env に独自トークンを生成
```

2. トークンの優先順位を明確化:
   - Worktree固有 > グローバル

3. ドキュメントにリスク説明を追加:
   > **Warning**: Using a shared token across multiple worktrees means a single token compromise grants access to all environments.

4. 認証フローのシーケンス図を追加

---

### Should Fix (Medium Severity)

#### SF-SEC-001: ResourcePathResolver の validate() メソッドの TOCTOU 脆弱性リスク

| Attribute | Value |
|-----------|-------|
| Severity | Medium |
| OWASP Category | A01:2021 - Broken Access Control |
| Affected Sections | 4.1 |

**現状の設計**:
```typescript
validate(path: string): boolean {
  if (!fs.existsSync(path)) { // Time-of-Check
    // ...
  }
  const resolved = fs.realpathSync(path); // Time-of-Use (競合状態の可能性)
  return resolved.startsWith(configDir);
}
```

**推奨対応**:
```typescript
validate(path: string): boolean {
  try {
    const resolved = fs.realpathSync(path);
    return resolved.startsWith(configDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 新規作成時: 親ディレクトリを検証
      return this.validateParentDirectory(path);
    }
    throw err;
  }
}
```

---

#### SF-SEC-002: ポート枯渇攻撃への対策不足

| Attribute | Value |
|-----------|-------|
| Severity | Medium |
| OWASP Category | A05:2021 - Security Misconfiguration |
| Affected Sections | 7.2, 8.1 |

**推奨対応**:
1. 同時Worktree数の上限設定（設定可能）
2. ポート割り当てのレート制限
3. 管理者向けリソース制限設定のドキュメント化

---

#### SF-SEC-003: エラーメッセージでの内部パス露出

| Attribute | Value |
|-----------|-------|
| Severity | Medium |
| OWASP Category | A04:2021 - Insecure Design |
| Affected Sections | 4.1, 4.2, 4.3 |

**推奨対応**:
1. クライアント向けエラーとサーバーログを分離
2. クライアントには汎用エラーコードのみ返却
3. 詳細パス情報はサーバーログにのみ記録

---

#### SF-SEC-004: pids/ ディレクトリ作成時の権限設定タイミング

| Attribute | Value |
|-----------|-------|
| Severity | Medium |
| OWASP Category | A05:2021 - Security Misconfiguration |
| Affected Sections | 7.3, 4.1 |

**推奨対応**:
```typescript
// ディレクトリ作成時に明示的にパーミッション設定
mkdirSync(pidsDir, { recursive: true, mode: 0o700 });

// 既存ディレクトリの場合も確認
if (existsSync(pidsDir)) {
  chmodSync(pidsDir, 0o700);
}
```

---

#### SF-SEC-005: Worktree 操作のセキュリティイベントログ不足

| Attribute | Value |
|-----------|-------|
| Severity | Low |
| OWASP Category | A09:2021 - Security Logging and Monitoring Failures |
| Affected Sections | 4.3, 14.4 |

**推奨対応**:
```typescript
// WorktreeSetupFacade の各ステップで logSecurityEvent を呼び出し
logSecurityEvent({
  timestamp: new Date().toISOString(),
  command: 'worktree-setup',
  action: 'success',
  details: `Issue #${issueNo} worktree created on port ${port}`,
});
```

---

### Consider (Low Priority)

| ID | Title | Recommendation |
|----|-------|----------------|
| NTH-SEC-001 | Worktree間通信の暗号化 | 将来的にTLS対応のプロキシオプションを検討 |
| NTH-SEC-002 | Issue番号の上限設定 | MAX_ISSUE_NO 定数を定義（2^31-1 推奨） |
| NTH-SEC-003 | 認証トークンのローテーション機能 | トークン有効期限と更新機能を将来バージョンで追加 |

---

## Existing Security Best Practices (Reference)

設計書で参照すべき既存実装の良い例:

### 1. コマンド実行 (`src/lib/git-utils.ts`)
```typescript
// Uses execFile (not exec) to prevent command injection
const { stdout } = await execFileAsync('git', args, {
  cwd,
  timeout: GIT_COMMAND_TIMEOUT_MS,
});
```

### 2. PIDファイル管理 (`src/cli/utils/pid-manager.ts`)
```typescript
// O_EXCL: Fail if file already exists (atomic check-and-create)
const fd = openSync(
  this.pidFilePath,
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
  0o600
);
```

### 3. パストラバーサル対策 (`src/cli/utils/env-setup.ts`)
```typescript
export function resolveSecurePath(targetPath: string, allowedBaseDir: string): string {
  const realPath = realpathSync(targetPath);
  const realBaseDir = realpathSync(allowedBaseDir);

  if (!realPath.startsWith(realBaseDir)) {
    throw new Error(`Path traversal detected`);
  }
  return realPath;
}
```

### 4. 認証トークンマスキング (`src/cli/utils/security-logger.ts`)
```typescript
// Mask CM_AUTH_TOKEN values
let result = input.replace(/CM_AUTH_TOKEN=\S+/g, 'CM_AUTH_TOKEN=***masked***');
```

---

## Risk Assessment Summary

| Risk Category | Level | Justification |
|---------------|-------|---------------|
| Technical Risk | Medium | 入力検証仕様の明確化が必要 |
| Security Risk | Medium | 認証境界の曖昧さとTOCTOUリスクが残存 |
| Operational Risk | Low | 基本的な運用セキュリティは設計済み |

---

## Recommendations for Design Document Update

### Section 7 への追加項目

```markdown
### 7.5 入力検証仕様

#### 7.5.1 Issue番号検証
- 型: 正の整数（1 <= issueNo <= 2147483647）
- 検証: Number.isInteger() && issueNo > 0

#### 7.5.2 ブランチ名検証
- 許可文字: [a-zA-Z0-9_/-]
- 最大長: 255文字
- 禁止パターン: 連続スラッシュ、末尾スラッシュ

### 7.6 エラーハンドリング

#### 7.6.1 クライアント向けエラー
- 汎用エラーコードのみ返却
- 内部パス情報は含めない

#### 7.6.2 サーバーログ
- 詳細パス情報、スタックトレースを記録
- logSecurityEvent() でセキュリティイベントを記録
```

---

## Approval Status

**Status**: Conditionally Approved

本設計方針書は、以下の条件を満たすことで承認されます:

1. **MF-SEC-001**: git worktree add コマンドの入力検証仕様を Section 7 に追加
2. **MF-SEC-002**: 認証トークン共有のリスクをドキュメント化し、Worktree毎の独立トークンオプションを追加

推奨修正項目（SF-SEC-001 ~ SF-SEC-005）は、実装フェーズでの対応も許容されます。

---

## Appendix: Files Reviewed

| File | Purpose |
|------|---------|
| `dev-reports/design/issue-136-worktree-parallel-dev-design-policy.md` | 設計方針書（レビュー対象） |
| `src/cli/utils/env-setup.ts` | 環境設定ユーティリティ |
| `src/cli/utils/pid-manager.ts` | PIDファイル管理 |
| `src/cli/utils/daemon.ts` | デーモンプロセス管理 |
| `src/cli/utils/security-logger.ts` | セキュリティイベントログ |
| `src/lib/db-path-resolver.ts` | DBパス解決 |
| `src/lib/env.ts` | 環境変数管理 |
| `src/lib/git-utils.ts` | Gitユーティリティ（参照実装） |
| `src/lib/clone-manager.ts` | クローン管理（参照実装） |
| `src/types/external-apps.ts` | External Apps型定義 |
| `src/middleware.ts` | 認証ミドルウェア |

---

*Report generated by Claude Code Architecture Review Agent*
*Review Type: Security (Stage 4 of Multi-Stage Design Review)*

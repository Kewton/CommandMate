# Issue #135 Security Review (Stage 4)

**Date**: 2026-02-03
**Issue**: #135 - DBパス解決ロジック修正
**Design Doc**: `dev-reports/design/issue-135-db-path-resolution-design-policy.md`
**Reviewer**: Architecture Review Agent

---

## 1. Executive Summary

| Category | Status |
|----------|--------|
| Overall Verdict | **PROCEED_WITH_CHANGES** |
| Must Fix | 2 issues |
| Should Fix | 3 issues |
| Nice to Have | 3 issues |

設計書は OWASP Top 10 の主要項目に対する対策を考慮しているが、実装詳細において不十分な点がある。特に以下の2点が高優先度:

1. ローカルインストール時のパストラバーサル検証の欠如
2. マイグレーション処理でのシンボリックリンク脆弱性

Issue #125 で実装済みの `resolveSecurePath()` を活用することで、多くのセキュリティ懸念を解消できる。

---

## 2. OWASP Top 10 (2021) Compliance

| Vulnerability | Status | Details |
|--------------|--------|---------|
| A01:2021 Broken Access Control | **Partial** | グローバルインストール時のみパス検証あり。ローカル時は未検証。 |
| A03:2021 Injection | **Compliant** | 既存の sanitize 関数群が利用可能。 |
| A05:2021 Security Misconfiguration | **Partial** | ディレクトリ作成時の mode 未指定。 |
| A09:2021 Security Logging | **Partial** | security-logger.ts への記録が未設計。 |

---

## 3. Must Fix Issues

### SEC-001: validateDbPath() のパストラバーサル検証がグローバルインストール時のみ

**Severity**: High
**Category**: A01:2021 Broken Access Control
**Location**: Section 7.1 validateDbPath()

#### Problem

```typescript
// Section 7.1 の現在の設計
function validateDbPath(dbPath: string): string {
  const resolvedPath = path.resolve(dbPath);

  if (isGlobalInstall()) {
    const homeDir = homedir();
    if (!resolvedPath.startsWith(homeDir)) {
      throw new Error(`Security error: DB path must be within home directory: ${resolvedPath}`);
    }
  }
  // ローカルインストール時は検証なし

  return resolvedPath;
}
```

ローカルインストール時には任意のパスにDBを作成可能であり、`/etc/passwd` や `/var/log/` 等のシステムディレクトリへの書き込みを許可してしまう。

#### Recommendation

```typescript
function validateDbPath(dbPath: string): string {
  const resolvedPath = path.resolve(dbPath);

  // システムディレクトリへの書き込みを常に禁止
  const systemDirs = ['/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/root'];
  if (systemDirs.some(dir => resolvedPath.startsWith(dir))) {
    throw new Error(`Security error: DB path cannot be in system directory: ${resolvedPath}`);
  }

  if (isGlobalInstall()) {
    const homeDir = homedir();
    if (!resolvedPath.startsWith(homeDir)) {
      throw new Error(`Security error: DB path must be within home directory: ${resolvedPath}`);
    }
  }

  return resolvedPath;
}
```

---

### SEC-002: migrateDbIfNeeded() でのシンボリックリンク脆弱性

**Severity**: High
**Category**: A01:2021 Broken Access Control
**Location**: Section 9.2 migrateDbIfNeeded()

#### Problem

```typescript
// Section 9.2 の現在の設計
for (const legacyPath of legacyPaths) {
  if (fs.existsSync(legacyPath)) {
    // バックアップ作成
    const backupPath = `${legacyPath}.bak`;
    fs.copyFileSync(legacyPath, backupPath);  // realpathSync 未使用

    // 新パスにコピー
    fs.copyFileSync(legacyPath, targetPath);  // realpathSync 未使用
    // ...
  }
}
```

`legacyPath` がシンボリックリンクの場合、攻撃者が意図したファイルが上書きされる可能性がある（TOCTOU攻撃）。

#### Recommendation

Issue #125 で実装済みの `resolveSecurePath()` を活用:

```typescript
import { resolveSecurePath } from '../cli/utils/env-setup';

export async function migrateDbIfNeeded(targetPath: string): Promise<MigrationResult> {
  // targetPath を検証
  const allowedBaseDir = isGlobalInstall() ? homedir() : process.cwd();
  const resolvedTargetPath = resolveSecurePath(targetPath, allowedBaseDir);

  if (fs.existsSync(resolvedTargetPath)) {
    return { migrated: false, targetPath: resolvedTargetPath };
  }

  const legacyPaths = getLegacyDbPaths();
  for (const legacyPath of legacyPaths) {
    if (fs.existsSync(legacyPath)) {
      // シンボリックリンク解決
      const realLegacyPath = fs.realpathSync(legacyPath);

      // バックアップ作成
      const backupPath = `${realLegacyPath}.bak`;
      fs.copyFileSync(realLegacyPath, backupPath);
      fs.chmodSync(backupPath, 0o600);  // SEC-006 対応

      // 新パスにコピー
      fs.copyFileSync(realLegacyPath, resolvedTargetPath);
      // ...
    }
  }
}
```

---

## 4. Should Fix Issues

### SEC-003: ディレクトリ作成時のモード未指定

**Severity**: Medium
**Category**: A05:2021 Security Misconfiguration
**Location**: Section 4.1 getDbInstance()

#### Current Design

```typescript
fs.mkdirSync(dir, { recursive: true });  // mode 未指定
```

#### Recommendation

```typescript
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
```

Issue #119 の `getEnvPath()` (env-setup.ts:73) で既に `mode: 0o700` が使用されている。一貫性のため同様のパターンを適用すべき。

---

### SEC-004: DATABASE_PATH 使用時のセキュリティログ不足

**Severity**: Medium
**Category**: A09:2021 Security Logging and Monitoring
**Location**: Section 6.1.1, Section 7.2

#### Current Design

```typescript
function getDatabasePathWithDeprecationWarning(): string | undefined {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath) {
    console.warn('[DEPRECATED] DATABASE_PATH is deprecated. Use CM_DB_PATH instead.');
  }
  return dbPath;
}
```

#### Recommendation

```typescript
import { logSecurityEvent } from '../cli/utils/security-logger';

function getDatabasePathWithDeprecationWarning(): string | undefined {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath) {
    console.warn('[DEPRECATED] DATABASE_PATH is deprecated. Use CM_DB_PATH instead.');
    logSecurityEvent('deprecated_env_var', {
      variable: 'DATABASE_PATH',
      value_length: dbPath.length,  // 値自体はログに含めない
    });
  }
  return dbPath;
}
```

---

### SEC-005: getLegacyDbPaths() での DATABASE_PATH 未検証使用

**Severity**: Medium
**Category**: A01:2021 Broken Access Control
**Location**: Section 9.2 getLegacyDbPaths()

#### Current Design

```typescript
function getLegacyDbPaths(): string[] {
  const paths: string[] = [];
  // ...
  if (process.env.DATABASE_PATH) {
    paths.push(process.env.DATABASE_PATH);  // 検証なし
  }
  return paths;
}
```

#### Recommendation

```typescript
function getLegacyDbPaths(): string[] {
  const paths: string[] = [];
  // ...

  // DATABASE_PATH は検証してから追加
  const envDbPath = process.env.DATABASE_PATH;
  if (envDbPath) {
    const resolved = path.resolve(envDbPath);
    // システムディレクトリでないことを確認
    const systemDirs = ['/etc', '/usr', '/bin', '/sbin', '/var'];
    if (!systemDirs.some(dir => resolved.startsWith(dir))) {
      paths.push(resolved);
    } else {
      console.warn(`[Security] Ignoring DATABASE_PATH in system directory: ${resolved}`);
    }
  }

  return paths;
}
```

---

## 5. Nice to Have Issues

### SEC-006: バックアップファイルのパーミッション未指定

**Severity**: Low
**Location**: Section 9.2 migrateDbIfNeeded()

バックアップファイル作成後に `fs.chmodSync(backupPath, 0o600)` を実行することを推奨。

---

### SEC-007: DB接続後の整合性チェック未設計

**Severity**: Low
**Location**: Section 9.2

マイグレーション後に `PRAGMA integrity_check` を実行し、DBファイルの整合性を検証する処理の追加を検討。

---

### SEC-008: 環境変数値の長さ制限未設計

**Severity**: Low
**Location**: Section 6.1.1

CM_DB_PATH の最大長（例: 4096文字）を検証する処理の追加を検討。

---

## 6. Issue #125 との整合性

### 6.1 resolveSecurePath() の活用状況

| Location | Status | Notes |
|----------|--------|-------|
| validateDbPath() (Section 7.1) | Not Used | 自前実装あり。DRY違反。 |
| migrateDbIfNeeded() (Section 9.2) | Not Used | シンボリックリンク脆弱性の原因。 |
| getConfigDir() reuse | Partial | 活用可能だが設計書に明記なし。 |

### 6.2 Recommendation

Issue #125 で実装された以下の関数を積極的に活用すべき:

```typescript
// env-setup.ts からインポート
import {
  resolveSecurePath,
  getConfigDir,
  isGlobalInstall,
} from '../cli/utils/env-setup';
```

これにより:
- コードの重複を排除（DRY原則）
- 検証済みセキュリティ実装の再利用
- 一貫性のあるセキュリティ対策

---

## 7. Recommended Actions

| Priority | Action | Effort |
|----------|--------|--------|
| 1 | SEC-001: ローカルインストール時のDBパス検証追加 | Low |
| 2 | SEC-002: migrateDbIfNeeded() で resolveSecurePath() 使用 | Low |
| 3 | SEC-003: ディレクトリ作成時に mode: 0o700 指定 | Trivial |
| 4 | SEC-004: security-logger.ts への記録追加 | Low |
| 5 | SEC-005: getLegacyDbPaths() での DATABASE_PATH 検証 | Low |

---

## 8. Conclusion

設計書は全体的にセキュリティを考慮した設計となっているが、以下の点で改善が必要:

1. **パストラバーサル対策の網羅性**: グローバルインストール時のみでなく、全環境でパス検証を実施すべき

2. **既存セキュリティ機能の活用**: Issue #125 で実装された `resolveSecurePath()` を活用することで、多くの懸念事項を解消可能

3. **ファイルパーミッション**: ディレクトリ・バックアップファイル作成時のパーミッション明示

4. **セキュリティログ**: 旧環境変数使用の追跡のため `security-logger.ts` を活用

must_fix 2件を対応した上で実装を進めることを推奨する。

---

*Generated by Architecture Review Agent - Stage 4 Security Review*

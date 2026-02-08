# Issue #96 セキュリティレビュー（Stage 4）

**レビュー日**: 2026-01-31
**対象設計書**: `dev-reports/design/issue-96-npm-cli-design-policy.md`
**レビュー種別**: セキュリティレビュー
**全体リスク評価**: Medium

---

## 1. エグゼクティブサマリー

Issue #96のnpm CLI設計は、基本的なセキュリティ設計が適切に行われているが、以下の3点の重要な修正が必要である。

1. **コマンドインジェクション対策**（MF-SEC-1）: `execSync`から`spawn`への変更
2. **PIDファイルのアトミック書き込み**（MF-SEC-2）: TOCTOU問題の解消
3. **npm publishワークフローのセキュリティ強化**（MF-SEC-3）: provenance追加

認証トークン生成（`crypto.randomBytes(32)`）、PIDファイルパーミッション（`0o600`）、環境変数バリデーションは適切に設計されている。npm パッケージとしては、postinstallスクリプト不使用で安全であり、依存関係も最小限（commanderのみ）に抑えられている。

---

## 2. 検出事項一覧

### 2.1 Must Fix（3件）

| ID | カテゴリ | タイトル | リスク |
|----|---------|---------|--------|
| MF-SEC-1 | A03: インジェクション | コマンドインジェクション脆弱性のリスク | High |
| MF-SEC-2 | A05: セキュリティ設定ミス | PIDファイルのレースコンディション | Medium |
| MF-SEC-3 | npm サプライチェーン | npm publish CI/CDワークフローのセキュリティ強化 | High |

### 2.2 Should Fix（5件）

| ID | カテゴリ | タイトル | リスク |
|----|---------|---------|--------|
| SF-SEC-1 | A02: 暗号化の失敗 | 認証トークン生成のエントロピー確認 | Medium |
| SF-SEC-2 | A09: ログと監視の不備 | CLIセキュリティイベントのログ記録 | Medium |
| SF-SEC-3 | A03: インジェクション | 環境変数値のサニタイズ | Medium |
| SF-SEC-4 | A06: 脆弱なコンポーネント | 依存関係の脆弱性チェック自動化 | Medium |
| SF-SEC-5 | npm セキュリティ | .npmignoreによる機密ファイル漏洩防止の強化 | Medium |

### 2.3 Nice to Have（3件）

| ID | カテゴリ | タイトル | リスク |
|----|---------|---------|--------|
| NTH-SEC-1 | A04: 安全でない設計 | SIGTERMハンドリングのグレースフル停止 | Low |
| NTH-SEC-2 | A01: 認証の不備 | トークン比較のタイミング攻撃対策 | Low |
| NTH-SEC-3 | postinstall セキュリティ | postinstallスクリプト回避の設計 | Low |

---

## 3. 詳細分析

### 3.1 MF-SEC-1: コマンドインジェクション脆弱性のリスク

**位置**: 設計書21.8節 `getProcessUsingPort()`

**問題点**:
設計書で提案されている実装では、ポート番号を直接シェルコマンドに埋め込んでいる。

```typescript
// 設計書の現在の実装
const result = execSync(`lsof -i :${port} -t`, { encoding: 'utf-8' });
```

`port`がユーザー入力由来（`--port`オプション）の場合、シェルメタ文字を含む入力によりコマンドインジェクションが可能となる。

**推奨対応**:
```typescript
// spawnを使用した安全な実装
import { spawnSync } from 'child_process';

function getProcessUsingPort(port: number): string | null {
  // 1. 整数バリデーション
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  // 2. spawn配列引数形式で実行（シェル展開なし）
  const result = spawnSync('lsof', ['-i', `:${port}`, '-t'], {
    encoding: 'utf-8',
    timeout: 5000,
  });

  if (result.status === 0 && result.stdout) {
    const pid = result.stdout.trim();
    // ...
  }
  return null;
}
```

### 3.2 MF-SEC-2: PIDファイルのレースコンディション

**位置**: 設計書4.3.4節 `PidManager`

**問題点**:
`exists()`で確認後に`writePid()`を呼ぶ設計では、TOCTOU（Time of Check to Time of Use）問題が発生する可能性がある。

```typescript
// 問題のあるパターン
if (!pidManager.exists()) {
  pidManager.writePid(pid);  // この間に別プロセスがファイルを作成する可能性
}
```

**推奨対応**:
```typescript
// O_EXCLフラグを使用したアトミック書き込み
import { openSync, writeSync, closeSync, constants } from 'fs';

writePid(pid: number): boolean {
  try {
    // O_EXCL: ファイルが存在する場合はエラー
    const fd = openSync(this.pidFilePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    writeSync(fd, String(pid));
    closeSync(fd);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') {
      return false;  // 既に存在
    }
    throw error;
  }
}
```

### 3.3 MF-SEC-3: npm publishワークフローのセキュリティ強化

**位置**: 設計書14.2節 `.github/workflows/publish.yml`

**問題点**:
現在の設計では基本的なNPM_TOKENによる認証のみ。npm provenanceによるSLSA準拠の署名が未設定。

**推奨対応**:
```yaml
# .github/workflows/publish.yml（セキュリティ強化版）
name: Publish to npm
on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write  # npm provenance用

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-publish  # 環境による保護
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - run: npm ci

      - run: npm audit --audit-level=high

      - run: npm test

      - run: npm run build

      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 3.4 SF-SEC-3: 環境変数値のサニタイズ

**位置**: 設計書4.3.2節 `env-setup.ts`

**問題点**:
対話入力（readline）で受け付けた値のサニタイズが設計されていない。改行文字や制御文字が.envファイルに書き込まれる可能性。

**推奨対応**:
```typescript
function sanitizeEnvValue(value: string): string {
  // 制御文字を除去
  let sanitized = value.replace(/[\x00-\x1F\x7F]/g, '');

  // 改行を除去
  sanitized = sanitized.replace(/[\r\n]/g, '');

  // 先頭・末尾の空白を除去
  sanitized = sanitized.trim();

  return sanitized;
}

function sanitizePath(value: string): string {
  // パスの正規化
  return path.normalize(sanitizeEnvValue(value));
}
```

### 3.5 SF-SEC-5: .npmignoreの強化

**位置**: 設計書14.1節

**現在の設計**:
```
tests/
__tests__/
*.test.ts
# ... 省略
```

**推奨追加**:
```
# 認証・機密情報
.npmrc
.env
.env.*
!.env.example

# デバッグログ
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# OS固有ファイル
.DS_Store
Thumbs.db

# Git
.git/
.gitignore

# セキュリティ関連
secrets/
credentials/
*.key
*.pem
*.p12
```

---

## 4. OWASP Top 10 コンプライアンス

| 項目 | ステータス | 備考 |
|------|-----------|------|
| A01: 認証の不備 | Conditional Pass | 0.0.0.0バインド時のトークン必須化は適切。タイミング攻撃対策は未実装（NTH-SEC-2）。 |
| A02: 暗号化の失敗 | Pass | crypto.randomBytes(32)による適切なトークン生成。.envパーミッション設定の明示が望ましい。 |
| A03: インジェクション | Needs Fix | MF-SEC-1: execSyncでのコマンドインジェクションリスク。spawn形式への変更必須。 |
| A04: 安全でない設計 | Pass | DIP/OCP適用による安全な設計。PIDファイル管理は標準パターン。 |
| A05: 設定ミス | Needs Fix | MF-SEC-2: PIDファイルのTOCTOU問題。アトミック書き込み必要。 |
| A06: 脆弱コンポーネント | Conditional Pass | commander単一依存は最小限。npm audit自動化の追加を推奨。 |
| A07: 認証セッション不備 | Pass | 外部アクセス時のトークン必須化は適切。 |
| A08: データ整合性不備 | Needs Fix | MF-SEC-3: npm provenance未設定。SLSA準拠の設定追加必須。 |
| A09: ログ監視不備 | Needs Improvement | SF-SEC-2: CLIセキュリティイベントのログ設計が不足。 |
| A10: SSRF | N/A | CLIツールのため該当なし。 |

---

## 5. CLI固有セキュリティ評価

| 項目 | ステータス | 備考 |
|------|-----------|------|
| コマンドインジェクション | Needs Fix | execSync使用箇所あり。spawn配列引数形式への変更を推奨。 |
| 環境変数の取り扱い | Pass | getEnvByKey()による型安全なアクセス。フォールバックチェーンも適切。 |
| 認証トークン保管 | Conditional Pass | .envへの保存は一般的。パーミッション設定の明示が必要。 |
| PIDファイル権限 | Pass | mode: 0o600を明記。所有者のみ読み書き可能。 |
| パス操作の安全性 | Pass | path.resolve()、isPathSafe()による適切な処理。 |

---

## 6. npm パッケージセキュリティ評価

| 項目 | ステータス | 備考 |
|------|-----------|------|
| サプライチェーン | Needs Improvement | npm provenance設定追加が必要。 |
| 依存関係の安全性 | Conditional Pass | commander単一依存は良好。npm audit自動化を推奨。 |
| postinstallリスク | Pass | postinstallスクリプト不使用で安全。 |
| .npmignoreカバレッジ | Needs Improvement | .npmrc等の追加が必要。 |

---

## 7. リスク評価サマリー

| 分類 | 件数 |
|------|------|
| Critical | 0 |
| High | 2 |
| Medium | 6 |
| Low | 3 |
| **合計** | **11** |

**全体リスク評価**: Medium

---

## 8. 推奨対応優先度

### 最優先（リリース前に必須）

1. **MF-SEC-1**: getProcessUsingPort()のspawn形式への変更
2. **MF-SEC-3**: npm publishワークフローへのprovenance追加

### 高優先（初期リリース後に対応）

3. **MF-SEC-2**: PIDファイルのアトミック書き込み実装
4. **SF-SEC-3**: 環境変数値のサニタイズ実装
5. **SF-SEC-4**: npm audit自動化のCI追加

### 通常優先（継続的改善）

6. **SF-SEC-1**: .envファイルパーミッション自動設定
7. **SF-SEC-2**: CLIセキュリティイベントログ
8. **SF-SEC-5**: .npmignore強化

---

## 9. 結論

Issue #96のnpm CLI設計は、セキュリティを意識した適切な設計がなされているが、コマンドインジェクション対策とサプライチェーンセキュリティの2点で重要な改善が必要である。これらの対応を実施することで、セキュアなCLIツールとnpmパッケージのリリースが可能となる。

**レビュー完了**: 2026-01-31
**レビュアー**: Architecture Review Agent (Stage 4)

---

*Generated by /multi-stage-design-review command*

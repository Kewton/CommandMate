# Architecture Review: Issue #308 Security Review (Stage 4)

## Executive Summary

| 項目 | 内容 |
|------|------|
| **Issue** | #308: git clone basePath修正 |
| **Stage** | 4 - セキュリティレビュー |
| **Status** | 条件付き承認 (Conditionally Approved) |
| **Score** | 4/5 |
| **Date** | 2026-02-19 |

Issue #308の設計方針書に対するセキュリティレビューを実施した。OWASP Top 10に基づく包括的な評価を行い、パストラバーサル防止、コマンドインジェクション防止、情報漏洩防止、SSRF防止、認証・認可の各観点から分析した。設計方針書のセキュリティ設計は概ね適切であるが、Must Fixとして2点（情報漏洩リスク、入力パラメータの型検証欠如）の改善が必要である。

---

## OWASP Top 10 Checklist

| OWASP Category | Status | 評価 |
|----------------|--------|------|
| A01: Broken Access Control | Acceptable | isPathSafe()によるパストラバーサル防止が適切 |
| A02: Cryptographic Failures | N/A | 暗号化処理なし |
| A03: Injection | Needs Improvement | spawn()配列引数で防止済み。targetDir型検証の追加が必要 |
| A04: Insecure Design | Acceptable | DI設計とbasePath優先順位が明確 |
| A05: Security Misconfiguration | Acceptable | path.resolve()正規化が設計済み |
| A06: Vulnerable Components | N/A | 新たな外部依存なし |
| A07: Auth Failures | Acceptable | ローカル開発ツール（127.0.0.1バインド） |
| A08: Software/Data Integrity | Acceptable | git整合性検証に依存、DB保存値もバリデーション済み |
| A09: Logging/Monitoring | Acceptable | 適切なログ出力と重複防止 |
| A10: SSRF | Acceptable | URLホワイトリストバリデーション（https/ssh/git@のみ） |

---

## Detailed Findings

### Must Fix (2 items)

#### D4-001: エラーメッセージによるbasePath情報漏洩

| 項目 | 内容 |
|------|------|
| **Severity** | Must Fix |
| **Category** | Information Disclosure |
| **Location** | 設計方針書 Section 5.1 / `src/lib/clone-manager.ts` L303-310 |

**指摘内容**:

パストラバーサル検証失敗時のエラーメッセージに`this.config.basePath`の実際のパス値が含まれている。

```typescript
// clone-manager.ts L306-309（現在の実装）
error: {
  ...ERROR_DEFINITIONS.INVALID_TARGET_PATH,
  message: `Target path must be within ${this.config.basePath}`,
},
```

このメッセージはAPIレスポンスとしてクライアントに直接返される。Issue #308の変更後、`basePath`は`CM_ROOT_DIR`（ユーザーの実際のディレクトリパス）になるため、サーバーの内部ディレクトリ構造が攻撃者に漏洩するリスクがある。

**改善案**:

エラーメッセージからbasePath値を除去し、`ERROR_DEFINITIONS.INVALID_TARGET_PATH`のデフォルトメッセージをそのまま使用する。

```typescript
// 改善後
if (customTargetPath && !isPathSafe(customTargetPath, this.config.basePath!)) {
  return {
    success: false,
    error: ERROR_DEFINITIONS.INVALID_TARGET_PATH,  // デフォルトメッセージを使用
  };
}
```

`ERROR_DEFINITIONS.INVALID_TARGET_PATH`のデフォルトメッセージは`'Target path is invalid or outside allowed directory'`であり、内部パスを含まない。

**参考**: `src/app/api/repositories/scan/route.ts` L30-33では`'Invalid or unsafe repository path'`という汎用メッセージを使用しており、このパターンに統一すべきである。

---

#### D4-002: targetDirパラメータの型検証欠如

| 項目 | 内容 |
|------|------|
| **Severity** | Must Fix |
| **Category** | Injection |
| **Location** | 設計方針書 Section 4.2.1 / `src/app/api/repositories/clone/route.ts` L51, L75 |

**指摘内容**:

`clone/route.ts`のL51で`const { cloneUrl, targetDir } = body;`としてリクエストボディから取得されるが、`cloneUrl`には型チェック（`typeof cloneUrl !== 'string'`）がある一方、`targetDir`には一切の型検証がない。

```typescript
// 現在の実装
const { cloneUrl, targetDir } = body;

// cloneUrlは検証あり
if (!cloneUrl || typeof cloneUrl !== 'string' || cloneUrl.trim() === '') { ... }

// targetDirは検証なしにそのまま渡される
const result = await cloneManager.startCloneJob(cloneUrl.trim(), targetDir);
```

攻撃者が`targetDir`にオブジェクト（`{"toString": ...}`）や配列を送信した場合、`isPathSafe()`内の`targetPath.includes('\x00')`や`path.resolve()`で予期しない動作が発生する可能性がある。

**改善案**:

設計方針書のSection 4.2.1に`targetDir`の型検証を追加する。

```typescript
// 改善後: clone/route.ts
const { cloneUrl, targetDir } = body;

// targetDirが提供される場合は文字列型チェック
if (targetDir !== undefined && typeof targetDir !== 'string') {
  return NextResponse.json(
    {
      success: false,
      error: {
        category: 'validation',
        code: 'INVALID_TARGET_PATH',
        message: 'Target directory must be a string',
        recoverable: true,
        suggestedAction: 'Provide a valid directory path as a string',
      },
    },
    { status: 400 }
  );
}
```

---

### Should Fix (3 items)

#### D4-003: ディレクトリ存在チェックのエラーメッセージによる情報漏洩

| 項目 | 内容 |
|------|------|
| **Severity** | Should Fix |
| **Category** | Information Disclosure |
| **Location** | `src/lib/clone-manager.ts` L314-321 |

**指摘内容**:

```typescript
message: `Target directory already exists: ${targetPath}`,
```

`targetPath`の完全パスがエラーメッセージに含まれ、APIレスポンスとしてクライアントに返される。サーバーのファイルシステム構造を外部に漏洩させるリスクがある。

**改善案**:

`ERROR_DEFINITIONS.DIRECTORY_EXISTS`のデフォルトメッセージ（`'Target directory already exists'`）をそのまま使用するか、`path.basename(targetPath)`のみを含める。

---

#### D4-004: コマンドインジェクション防止の設計根拠が未記載

| 項目 | 内容 |
|------|------|
| **Severity** | Should Fix |
| **Category** | Injection |
| **Location** | 設計方針書 Section 5 |

**指摘内容**:

`clone-manager.ts` L362のspawn呼び出しは適切に配列引数を使用しており、シェルインジェクションは防止されている。

```typescript
const gitProcess = spawn('git', ['clone', '--progress', cloneUrl, targetPath], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

また、`UrlNormalizer.validate()`が`https://`、`git@`、`ssh://`のみをホワイトリストで許可しているため、`file://`プロトコルや`--`で始まる引数インジェクションは拒否される。

しかし、これらのセキュリティ判断が設計方針書に明文化されていない。

**改善案**:

設計方針書のSection 5に「コマンドインジェクション防止」サブセクションを追加し、以下を記載する:
1. `spawn()`が配列引数を使用しシェルを経由しないこと
2. `UrlNormalizer.validate()`がhttps/ssh/git@のみをホワイトリストで許可し、`file://`や`git://`プロトコルを拒否すること
3. `--`で始まるURL入力がバリデーション正規表現で自動的に拒否されること

---

#### D4-005: シンボリックリンクによるパストラバーサルのリスク評価が未記載

| 項目 | 内容 |
|------|------|
| **Severity** | Should Fix |
| **Category** | Path Traversal |
| **Location** | 設計方針書 Section 5.1 / `src/lib/path-validator.ts` |

**指摘内容**:

`isPathSafe()`は`path.resolve()`で論理パスを正規化するが、`fs.realpathSync()`による実パス解決は行っていない。basePath配下の親ディレクトリにシンボリックリンクが存在する場合、論理パスではbasePath内に見えるが実際は外部を指す可能性がある。

ただし、clone操作では`targetPath`は新規作成されるディレクトリであるため、既存シンボリックリンクを経由した攻撃のリスクは限定的（`parentDir`にシンボリックリンクが含まれる場合のみ）。`file-operations.ts`では`realpathSync()`による実パス検証を実施しており、対照的な設計となっている。

**改善案**:

設計方針書Section 5にシンボリックリンクに関するリスク評価を記載する。clone操作ではtargetPathが新規作成されるためリスクが低いこと、`file-operations.ts`との設計差異の理由を明記する。

---

### Nice to Have (3 items)

#### D4-006: 非推奨警告メッセージのサーバーログ出力

| 項目 | 内容 |
|------|------|
| **Severity** | Nice to Have |
| **Category** | Information Disclosure |
| **Location** | 設計方針書 Section 3.2 |

`console.warn`への出力のみでAPIレスポンスに含まれないため、情報漏洩リスクは低い。サーバーログへのアクセス制御が適切であれば問題なし。

---

#### D4-007: APIエンドポイントの認証・認可

| 項目 | 内容 |
|------|------|
| **Severity** | Nice to Have |
| **Category** | Auth |
| **Location** | `src/app/api/repositories/clone/route.ts`, `[jobId]/route.ts` |

clone APIエンドポイントには認証・認可の仕組みがないが、本ツールがローカル開発ツール（`CM_BIND=127.0.0.1`）として設計されているため、現時点では許容範囲内。Issue #308のスコープ外。

---

#### D4-008: 内部ネットワークURLのSSRFリスク

| 項目 | 内容 |
|------|------|
| **Severity** | Nice to Have |
| **Category** | SSRF |
| **Location** | `src/lib/url-normalizer.ts` validate() |

`https://localhost/owner/repo`や`https://169.254.169.254/owner/repo`等の内部ネットワークURLはバリデーションを通過するが、git cloneプロトコルの特性上、メタデータサービスへのアクセスは困難。ローカル開発ツールとしてリスクは限定的。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 情報漏洩 | エラーメッセージに内部パスが含まれる（D4-001, D4-003） | Medium | High | P1 |
| インジェクション | targetDirの型検証欠如（D4-002） | Medium | Medium | P1 |
| コマンドインジェクション | git clone引数（既にspawn配列で防止済み、根拠未記載）（D4-004） | Low | Low | P2 |
| パストラバーサル | シンボリックリンク経由（リスク限定的）（D4-005） | Low | Low | P2 |
| 認証・認可 | API認証なし（ローカルツール前提で許容）（D4-007） | Low | Low | P3 |
| SSRF | 内部ネットワークURL（git cloneプロトコルで限定的）（D4-008） | Low | Low | P3 |

---

## Security Positive Points

設計方針書で既に適切に対応されているセキュリティ事項:

1. **パストラバーサル防止**: `isPathSafe()`による`path.resolve()`+`path.relative()`検証が実装済み
2. **環境変数正規化**: `getEnv()`での`path.resolve(rootDir)`適用（L234）、及びD1-007による`WORKTREE_BASE_PATH`への`path.resolve()`適用
3. **シェルインジェクション防止**: `spawn()`の配列引数使用（シェル非経由）
4. **URLバリデーション**: ホワイトリスト方式（https/ssh/git@のみ）
5. **ヌルバイトインジェクション防止**: `isPathSafe()`内の`\x00`チェック
6. **URL エンコーディングバイパス防止**: `isPathSafe()`内の`decodeURIComponent()`処理
7. **非推奨警告の重複防止**: モジュールスコープ変数による1回限り出力
8. **DI設計**: `CloneManager`内部で`getEnv()`を呼ばず、テスト容易性とセキュリティの分離が適切

---

## Implementation Checklist (Stage 4 Security)

### Must Fix

- [ ] **[D4-001]** `src/lib/clone-manager.ts` L306-309 - パストラバーサル検証失敗時のエラーメッセージから`this.config.basePath`の値を除去する
  - `ERROR_DEFINITIONS.INVALID_TARGET_PATH`のデフォルトメッセージをそのまま使用
  - `scan/route.ts`のパターン（汎用メッセージ使用）に統一

- [ ] **[D4-002]** 設計方針書 Section 4.2.1 / `src/app/api/repositories/clone/route.ts` - `targetDir`パラメータの型検証を追加する
  - `typeof targetDir === 'string'`チェックを`startCloneJob()`呼び出し前に実施
  - `cloneUrl`の型検証パターンと同様のガードを追加

### Should Fix

- [ ] **[D4-003]** `src/lib/clone-manager.ts` L319 - ディレクトリ存在チェックのエラーメッセージから`targetPath`の完全パスを除去する
  - `ERROR_DEFINITIONS.DIRECTORY_EXISTS`のデフォルトメッセージを使用

- [ ] **[D4-004]** 設計方針書 Section 5 - コマンドインジェクション防止の設計根拠を追記する
  - `spawn()`配列引数、URLホワイトリスト、`--`引数拒否を明文化

- [ ] **[D4-005]** 設計方針書 Section 5 - シンボリックリンクに関するリスク評価を記載する
  - clone操作での低リスク判断の根拠、`file-operations.ts`との設計差異を明記

---

## Approval

**Status: 条件付き承認 (Conditionally Approved)**

Must Fix 2件（D4-001: 情報漏洩、D4-002: 型検証）の修正を条件として承認する。これらは攻撃面を縮小するための基本的なセキュリティ対策であり、実装工数も軽微（各2-5行程度の変更）である。Should Fix 3件は設計方針書への記載追加が主であり、セキュリティ設計の透明性向上に寄与する。

---

*Generated by architecture-review-agent for Issue #308 Stage 4 Security Review*
*Reviewed: 2026-02-19*

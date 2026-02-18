# Issue #300 セキュリティレビュー (Stage 4)

## レビュー概要

| 項目 | 値 |
|------|-----|
| Issue | #300 ルートディレクトリにディレクトリ/ファイルを追加 |
| Stage | 4 (セキュリティレビュー) |
| 実施日 | 2026-02-18 |
| 対象文書 | `dev-reports/design/issue-300-root-directory-creation-design-policy.md` |
| 全体評価 | **Good** |

## レビュー結果サマリー

| 重要度 | 件数 |
|--------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 3 |

Issue #300の設計方針書に対するセキュリティレビューを実施した。設計方針書はセキュリティ責務境界（SF-2）を明確に定義しており、パストラバーサル防御をサーバー側の`isPathSafe()`に一元化する方針は適切である。`encodePathForUrl()`から`isPathSafe()`に至る検証チェーンをトレースした結果、通常のファイル操作フローでは二重エンコード問題は発生しないことを確認した。

---

## 検証チェーン分析

### 正常フロー（特殊文字を含むパス）

```
Client:  encodePathForUrl('src/file #1.md')
         -> 'src/file%20%231.md'

Next.js: catch-all [params.path] 自動デコード
         -> ['src', 'file #1.md']

Server:  pathSegments.join('/')
         -> 'src/file #1.md'

Server:  normalize('src/file #1.md')
         -> 'src/file #1.md'

Server:  isPathSafe() -> decodeURIComponent('src/file #1.md')
         -> 'src/file #1.md' (変化なし)
         -> path.resolve(rootDir, 'src/file #1.md') 検証 -> true

Server:  join(worktreeRoot, 'src/file #1.md')
         -> 実際のファイル操作

結果: 正常動作。バリデーション対象パスとファイル操作パスが一致。
```

### パストラバーサル攻撃フロー

```
Client:  encodePathForUrl('../../etc/passwd')
         -> '../../etc/passwd'
         (ドットとスラッシュはRFC 3986 unreserved characterのためエンコードされない)

Next.js: params.path = ['..', '..', 'etc', 'passwd']

Server:  pathSegments.join('/') -> '../../etc/passwd'
         normalize() -> '../../etc/passwd'
         isPathSafe() -> path.resolve(rootDir, '../../etc/passwd')
         -> rootDir外のパス
         -> path.relative()が'..'で始まる -> false

結果: パストラバーサル攻撃が適切にブロックされる。
```

### リテラル%文字を含むファイル名のエッジケース

```
シナリオ: ファイル名にリテラル%文字が含まれる場合（例: 'report%20v2.md'）

Client:  encodePathForUrl('report%20v2.md')
         -> 'report%2520v2.md'

Next.js: params.path = ['report%20v2.md']（%25がデコードされて%20になる）

Server:  isPathSafe() -> decodeURIComponent('report%20v2.md')
         -> 'report v2.md'（%20が空白にデコード）

Server:  join(worktreeRoot, 'report%20v2.md')
         -> リテラル%20を含むファイルに対して操作

結果: バリデーション対象パスは'report v2.md'だが、
      実際のファイル操作は'report%20v2.md'に対して行われる。
      rootDir外への脱出は不可能なため、セキュリティ上の実害はない。
      これは既存のisPathSafe()設計の特性であり、
      Issue #300の変更で新たに導入される問題ではない。
```

---

## OWASP Top 10 評価

| OWASP | 項目 | 評価 | 備考 |
|-------|------|------|------|
| A01 | Broken Access Control | Acceptable | CommandMateはlocalhost専用。新規ツールバーは既存APIを使用。 |
| A03 | Injection | Acceptable | isPathSafe()のpath.resolve()+path.relative()チェーンで防御。 |
| A05 | Security Misconfiguration | Acceptable | バックエンド変更なし。既存設定維持。 |
| A06 | Vulnerable Components | Acceptable | 新規外部依存なし。 |

---

## 指摘事項

### SF-1: 二重デコード・エッジケースの分析不足

| 項目 | 内容 |
|------|------|
| 重要度 | Should Fix |
| カテゴリ | 二重デコード・エッジケース |

**問題**: `isPathSafe()`内の`decodeURIComponent`適用が、既にNext.jsにより自動デコードされたパスに対して二重デコードを行うエッジケースについて、設計方針書での分析が不十分。

具体的には、ファイル名にリテラル`%`文字が含まれる場合（例: `report%20v2.md`というファイル名が実際に`%20`をリテラル文字として持つ場合）、`isPathSafe()`がそれを空白にデコードしてしまい、バリデーション対象パスと実際のファイル操作パスに不一致が生じる可能性がある。

**該当箇所**: `src/lib/path-validator.ts` L40-47、`src/app/api/worktrees/[id]/files/[...path]/route.ts` L112

```typescript
// path-validator.ts L40-47
let decodedPath = targetPath;
try {
  decodedPath = decodeURIComponent(targetPath);
} catch {
  decodedPath = targetPath;
}
```

```typescript
// route.ts L112 - pathSegmentsはNext.jsが自動デコード済み
const requestedPath = pathSegments.join('/');
```

**推奨対応**: 設計方針書のSection 6に以下の分析を追記する。
1. Next.js catch-all routeが`pathSegments`を自動デコードするため、`getWorktreeAndValidatePath()`に渡される時点でパスは既にデコード済みである
2. `isPathSafe()`内の`decodeURIComponent`は冪等性を持つが、リテラル`%`文字を含むファイル名では挙動が変わる
3. これは既存実装の設計であり、Issue #300の変更はこの挙動を変更しないため、本Issueのスコープ外である旨を明記する

---

### SF-2: クライアント側入力バリデーションの設計判断未記載

| 項目 | 内容 |
|------|------|
| 重要度 | Should Fix |
| カテゴリ | 入力バリデーション |

**問題**: 設計方針書Section 6の入力バリデーションセクションで「window.promptの戻り値が空の場合は早期リターン」と記載されているが、悪意のある文字（`..`、ヌルバイト`\x00`、制御文字、OS禁止文字`<>:"|?*`）に対するクライアント側バリデーションが存在しない。サーバー側の`isPathSafe()`および`isValidNewName()`で防御されるため実害はないが、Defense-in-Depthの観点からの設計判断が設計方針書に記載されていない。

**該当箇所**: `src/components/worktree/WorktreeDetailRefactored.tsx` L1243, L1272

```typescript
// L1243 - ファイル名入力: null/空チェックのみ
const fileName = window.prompt('Enter file name (e.g., document.md):');
if (!fileName) return;

// L1272 - ディレクトリ名入力: null/空チェックのみ
const dirName = window.prompt('Enter directory name:');
if (!dirName) return;
```

**推奨対応**: 設計方針書のSection 6入力バリデーションに以下を追記する。
1. `window.prompt()`からの入力に対し、クライアント側でのファイル名バリデーションを実装しない設計判断とその理由（サーバー側防御で十分、クライアント側はUX向上目的のみ）を明記する
2. ユーザーが`../malicious`のようなファイル名を入力した場合、サーバーエラーで返却されるだけでクライアント側でのフィードバックがない点をUX課題として記録する

---

### SF-3: createFileOrDirectoryのisValidNewName未呼出

| 項目 | 内容 |
|------|------|
| 重要度 | Should Fix |
| カテゴリ | バリデーション不整合 |

**問題**: `createFileOrDirectory()`（`file-operations.ts` L298-335）は`isPathSafe()`のみを呼び出し、`isValidNewName()`を呼び出していない。`renameFileOrDirectory()`では`isValidNewName()`が呼び出されている（L630）ため、バリデーションが非対称となっている。制御文字やOS禁止文字を含むファイル名がcreate経由では作成可能となる。

Issue #300の変更で新たに導入される問題ではないが、新規ツールバーによりルートレベルでのファイル/ディレクトリ作成の機会が増えるため、設計方針書で既知の課題として言及すべきである。

**該当箇所**: `src/lib/file-operations.ts` L298-335 vs L618-662

```typescript
// L298-335: createFileOrDirectory - isValidNewName()未呼出
export async function createFileOrDirectory(...) {
  if (!isPathSafe(relativePath, worktreeRoot)) {  // isPathSafe のみ
    return createErrorResult('INVALID_PATH');
  }
  // ...
}

// L618-662: renameFileOrDirectory - isValidNewName()あり
export async function renameFileOrDirectory(...) {
  const nameValidation = isValidNewName(newName);  // バリデーションあり
  if (!nameValidation.valid) {
    return createErrorResult('INVALID_NAME', nameValidation.error);
  }
  // ...
}
```

**推奨対応**: 設計方針書のSection 6に既知の課題として追記し、将来的に`createFileOrDirectory()`にも`isValidNewName()`呼び出しを追加することを推奨する（別Issueで対応）。

---

### NTH-1: XSS対策セクションの追加

| 項目 | 内容 |
|------|------|
| 重要度 | Nice to Have |
| カテゴリ | XSS対策 |

**問題**: 設計方針書にXSS対策に関する分析が記載されていない。`encodePathForUrl()`の出力は`fetch()`のURL構築にのみ使用され、HTMLに直接挿入されることはないが、将来的な使用拡大を考慮すると明記しておくとよい。

**推奨対応**: 設計方針書のSection 6に「XSS対策」サブセクションを追加し、以下を記載する。
- `encodePathForUrl()`はURL構築専用であり、HTML出力には使用しない
- ツールバーボタンのイベントハンドラは静的な`onClick`関数バインドであり、DOMインジェクションのリスクはない
- ファイル名の入力/表示にはブラウザネイティブダイアログを使用しており、XSSリスクはない

---

### NTH-2: アクセス制御の前提の明記

| 項目 | 内容 |
|------|------|
| 重要度 | Nice to Have |
| カテゴリ | アクセス制御 (OWASP A01) |

**問題**: ツールバーの操作に対する認証・認可の確認が設計方針書に含まれていない。CommandMateはlocalhost専用ツールであるという前提の明記がない。

**推奨対応**: Section 6に短い注記を追加する。「CommandMateはlocalhostで動作するローカル開発ツールであり、認証・認可機構は設けていない。新規ツールバーは既存APIエンドポイントを使用するため、アクセス制御の観点で新たなリスクは生じない。」

---

### NTH-3: OWASP Top 10チェックリスト

| 項目 | 内容 |
|------|------|
| 重要度 | Nice to Have |
| カテゴリ | OWASP A03 インジェクション |

**問題**: パスインジェクション（パストラバーサル）に対する防御チェーンは適切に設計されているが、OWASP Top 10準拠の観点でのチェックリスト形式の記述がない。

**推奨対応**: Section 6にOWASP Top 10チェックリストを追加する（A01, A03, A05, A06について各項目の対応状況を記載）。

---

## 検証対象ファイル

| ファイル | 確認内容 |
|---------|---------|
| `src/lib/path-validator.ts` | `isPathSafe()`の`decodeURIComponent`処理、ヌルバイト検出、`path.resolve()`+`path.relative()`チェーン |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | `getWorktreeAndValidatePath()`のパスセグメント結合、`normalize()`、`isPathSafe()`呼び出し |
| `src/lib/file-operations.ts` | `createFileOrDirectory()`のバリデーション（`isPathSafe()`のみ、`isValidNewName()`なし） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | `handleNewFile`/`handleNewDirectory`の`window.prompt()`入力処理、`encodeURIComponent`使用箇所 |
| `src/hooks/useFileOperations.ts` | `handleMoveConfirm()`のパスエンコード未使用（既知の課題、スコープ外） |
| `src/components/worktree/FileTreeView.tsx` | 空状態ボタンおよびツールバーのコールバック呼び出し |

---

## 結論

Issue #300の設計方針書はセキュリティ面で**Good**の評価とする。Must Fixの指摘事項はなく、`encodePathForUrl()`から`isPathSafe()`に至るセキュリティ検証チェーンは正しく機能することを確認した。Should Fixの3件は主に設計方針書への分析記述の追加であり、実装面でのセキュリティリスクは生じない。`encodeURIComponent`から`encodePathForUrl()`への変更はセキュリティ検証チェーンの動作を変更せず、既存のサーバー側防御が引き続き有効である。

---

*Generated by architecture-review-agent for Issue #300 Stage 4 Security Review*

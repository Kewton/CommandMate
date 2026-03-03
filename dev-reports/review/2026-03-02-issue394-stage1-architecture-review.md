# Architecture Review Report: Issue #394 Stage 1

## Executive Summary

| 項目 | 内容 |
|------|------|
| **Issue** | #394 - security: symlink traversal in file APIs allows access outside worktree root |
| **Stage** | 1 - 通常レビュー |
| **Focus** | 設計原則 (SOLID/KISS/DRY/YAGNI) |
| **Status** | Conditionally Approved |
| **Score** | 4/5 |
| **Must Fix** | 0件 |
| **Should Fix** | 4件 |
| **Nice to Have** | 4件 |

設計方針書は全体的に優れた品質で、SOLID/KISS/DRY/YAGNI各原則への適合度が高い。Option B（新関数追加）の選択は既存コードへの影響を最小化しつつDRY原則を遵守する適切な判断である。must_fix指摘はないが、validateFileOperation()への統合方針の曖昧さ、API層の画像/動画readFile直接パスの防御漏れリスク、及びrenameFileOrDirectory()のdestinationパスに対するsymlink検証欠落について改善が必要。

---

## Design Principles Evaluation

### SOLID原則

#### SRP (Single Responsibility Principle) - 良好

`resolveAndValidateRealPath()`は「symlinkを解決してworktreeRoot配下であることを検証する」単一の責務に限定されている。既存の`isPathSafe()`の「レキシカルなパストラバーサル検出」責務と明確に分離されており、SRPを遵守している。

ただし、新関数のboolean返却は将来の拡張性（解決済みパスの再利用）において制限となる可能性がある（S1-005参照）。

#### OCP (Open/Closed Principle) - 良好

Option Bの選択により、既存の`isPathSafe()`関数は一切変更されない。新関数`resolveAndValidateRealPath()`を追加する形式であるため、既存8箇所の`isPathSafe()`呼び出し元（file-search.ts、repositories/scan等）に影響を与えない。OCPを適切に遵守している。

#### LSP (Liskov Substitution Principle) - 該当なし

新関数は独立した関数として追加されるため、LSPの直接的な適用対象ではない。既存インターフェース（FileOperationResult、FileOperationErrorCode等）との互換性は維持される。

#### ISP (Interface Segregation Principle) - 良好

`resolveAndValidateRealPath()`はsymlink検証が不要なコンテキスト（file-search.ts、repositories/scan等）には導入されない。ファイルI/Oを行うAPI層のみで使用する設計であり、ISPに適合。

#### DIP (Dependency Inversion Principle) - 該当/特記なし

新関数はNode.js標準APIの`fs.realpathSync()`に直接依存するが、パス検証ユーティリティとしては適切な抽象レベルにあり、過度な抽象化は不要。

### KISS原則 - 良好

既存の`moveFileOrDirectory()`のSEC-006パターン（realpathSync + startsWith比較）を汎用化する方式であり、新規パターンの導入を避けている。アルゴリズムは以下の明確なステップで構成される:

1. rootDirのrealpath解決
2. targetPathのrealpath解決（存在しない場合は祖先走査）
3. startsWith比較

ただし、祖先走査フォールバックの終了条件が暗黙的である点については明確化が望ましい（S1-006参照）。

### YAGNI原則 - 良好

保護対象をファイルI/OのあるAPIエンドポイント（files/upload/tree）に限定し、ファイルI/Oを行わないrepositories/scanやURL文字列のみを扱うurl-path-encoder.tsには手を加えない。file-search.tsは既存のlstat + isSymbolicLink()スキップで十分とする判断も、YAGNIに適合している。

### DRY原則 - 改善余地あり

共通関数`resolveAndValidateRealPath()`による検証ロジックの一元化はDRYに適合している。しかし、以下の2点でDRY違反のリスクがある:

1. **validateFileOperation()統合 vs 個別追加の二重定義** (S1-001): validateFileOperation()にrealpath検証を統合しつつ、各関数にも個別に追加する方針は、二重チェックのリスクがある
2. **API層とビジネスロジック層の二重検証** (S1-002): 既存のisPathSafe()二重チェックに加え、realpath検証も二重になる可能性がある

---

## Detailed Findings

### Should Fix (4件)

#### S1-001: validateFileOperation()統合と個別追加の方針重複

**Category**: SOLID (SRP/DRY)
**Location**: 設計方針書 セクション5.2 file-operations.tsテーブル

設計方針書では`validateFileOperation()`にrealpath検証を統合すると記載しつつ、readFileContent/updateFileContent/createFileOrDirectory/deleteFileOrDirectory/writeBinaryFileにも個別追加と記載している。

現在のコードを確認すると:
- `validateFileOperation()`はrenameFileOrDirectoryとmoveFileOrDirectoryのみで使用
- readFileContent/updateFileContent/createFileOrDirectory/deleteFileOrDirectory/writeBinaryFileは直接`isPathSafe()`を呼び出し

```typescript
// 現在のvalidateFileOperation() - src/lib/file-operations.ts 459行目
export function validateFileOperation(
  worktreeRoot: string,
  sourcePath: string
): { success: true; resolvedSource: string } | { success: false; error: FileOperationResult } {
  if (!isPathSafe(sourcePath, worktreeRoot)) {
    return { success: false, error: createErrorResult('INVALID_PATH') };
  }
  // ...
}
```

**Suggestion**: 方針を以下のいずれかに統一し明記する:
- (A) validateFileOperation()を拡張し、全操作関数で使用する（推奨）
- (B) 各関数に個別追加し、validateFileOperation()は既存のrenameFileOrDirectory/moveFileOrDirectoryでのみ拡張

#### S1-002: API層とビジネスロジック層の防御責務分担の曖昧さ

**Category**: DRY
**Location**: 設計方針書 セクション5.2

API層の`getWorktreeAndValidatePath()`とfile-operations.ts各関数の両方にresolveAndValidateRealPath()を追加すると、同一リクエストでrealpathSync()が4回（root解決x2 + target解決x2）実行される。

**Suggestion**: 主防御レイヤーを明確化する。例:
- file-operations.ts層を主防御（realpath検証の責務）
- API層は既存のisPathSafe()レキシカルチェックのみ維持（早期拒否の責務）

#### S1-003: renameFileOrDirectory()のdestination検証の設計根拠欠落

**Category**: 設計パターン
**Location**: 設計方針書 セクション5.2 renameFileOrDirectory行

renameFileOrDirectory()では`newRelativePath`（リネーム先）の構築後にisPathSafe()チェックを行うが、symlink検証は設計に含まれていない。リネームは同一ディレクトリ内のbasename変更であるためリスクは低いが、設計根拠を明記すべき。

```typescript
// src/lib/file-operations.ts 638-644行目
const parentDir = dirname(relativePath);
const newRelativePath = parentDir === '.' ? newName : join(parentDir, newName);
const newFullPath = join(worktreeRoot, newRelativePath);
// isPathSafe()チェックはあるが、realpath検証は設計に含まれていない
if (!isPathSafe(newRelativePath, worktreeRoot)) {
  return createErrorResult('INVALID_PATH');
}
```

#### S1-004: 画像/動画直接readFile()パスの保護箇所の不明確さ

**Category**: エラーハンドリング
**Location**: 設計方針書 セクション5.2 APIルートテーブル

files/[...path]/route.tsのGETハンドラでは画像/動画ファイルの読み取りにreadFile(absolutePath)を直接使用している:

```typescript
// src/app/api/worktrees/[id]/files/[...path]/route.ts 153行目
const absolutePath = join(worktree.path, relativePath);
// ...
const fileBuffer = await readFile(absolutePath); // readFileContent()経由ではない
```

設計方針書では「画像・動画のreadFile()直接呼び出しパスも保護」としているが、getWorktreeAndValidatePath()追加で自動保護されるのか、個別挿入が必要なのか具体的でない。

### Nice to Have (4件)

#### S1-005: resolveAndValidateRealPath()の戻り値がbooleanのみ

**Category**: SOLID (SRP)
**Location**: セクション5.1

boolean返却では解決済みパスの再利用ができない。moveFileOrDirectory()のSEC-006パターンでは解決済みパスを後続処理で使用しており、将来同様のニーズが発生する可能性がある。ただし、YAGNI原則に基づき現時点ではbooleanで十分。

#### S1-006: 祖先走査の終了条件の暗黙性

**Category**: KISS
**Location**: セクション5.1 アルゴリズム手順4

祖先走査がファイルシステムルート（/）まで到達した場合の明示的な終了条件が記載されていない。Layer 1のisPathSafe()がresolvedRoot外への走査を事前に拒否する前提を明記すべき。

#### S1-007: ERROR_CODE_TO_HTTP_STATUS重複

**Category**: DRY
**Location**: 既存コード（本Issueスコープ外）

files route.tsとupload route.tsにERROR_CODE_TO_HTTP_STATUSが重複定義されている。本Issue修正時の同時改善機会として記録。

#### S1-008: 統合テストのオプション扱い

**Category**: YAGNI
**Location**: セクション8 テストファイル構成

APIレベルのsymlinkテストがオプション扱いとなっている。セキュリティ脆弱性修正では最低1エンドポイントの統合テストを必須とすることを推奨。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | validateFileOperation()統合方針の解釈差異による実装不整合 | Medium | Medium | P2 |
| セキュリティ | 画像/動画readFile直接パスのsymlink検証漏れ | High | Low | P2 |
| セキュリティ | renameFileOrDirectory destination検証不足 | Medium | Low | P3 |
| 運用リスク | 統合テスト未整備によるAPI層の回帰見逃し | Medium | Medium | P2 |

---

## Design Pattern Assessment

### Option B（新関数追加）の妥当性: 適切

Option Bの選択は以下の根拠で妥当:

1. **影響範囲の最小化**: isPathSafe()の8呼び出し元に影響を与えない
2. **後方互換性**: 既存テストの変更が不要
3. **パフォーマンス**: file-search.tsの再帰走査にrealpathを追加する必要がない
4. **DRY原則**: Option C（各関数個別追加）のコード重複を回避

### moveFileOrDirectory SEC-006パターンの汎用化: 適切

既存の検証済みパターン（realpathSync + startsWith + sep比較）をそのまま再利用する設計は、KISSとDRYの両方を満たす。

```typescript
// 既存パターン (file-operations.ts 546-548行目)
const resolvedDest = realpathSync(destFullPath);
const resolvedRoot = realpathSync(worktreeRoot);
if (!resolvedDest.startsWith(resolvedRoot + sep) && resolvedDest !== resolvedRoot) {
```

### Defense in Depth 3層構造: 適切

Layer 1 (lexical) + Layer 2 (realpath) + Layer 3 (lstat) の構成は、各レイヤーが異なる攻撃ベクトルに対応しており、防御の冗長性が確保されている。

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

なし

### 推奨改善項目 (Should Fix)

1. **S1-001**: validateFileOperation()統合と個別追加の方針を一本化する
2. **S1-002**: API層とビジネスロジック層の防御責務分担を明記する
3. **S1-003**: renameFileOrDirectory() destination検証の設計根拠を明記する
4. **S1-004**: 画像/動画readFile()直接パスの具体的な保護箇所を明記する

### 検討事項 (Consider)

5. **S1-005**: resolveAndValidateRealPath()の戻り値を構造体にすることを将来検討
6. **S1-006**: 祖先走査の終了条件をアルゴリズム仕様に明記する
7. **S1-007**: ERROR_CODE_TO_HTTP_STATUSの共通モジュール化を将来タスクに記録
8. **S1-008**: 最低1エンドポイントの統合テストを必須化する

---

## Approval Status

**Conditionally Approved** - should_fix 4件を設計方針書に反映後、実装に進むことを推奨する。must_fix指摘がないため、実装と並行してshould_fix項目を反映するアプローチも許容される。

---

*Generated by architecture-review-agent for Issue #394 Stage 1 on 2026-03-02*

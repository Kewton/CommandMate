# Issue #394 Stage 3 影響分析レビュー

- **Issue**: #394 - security: symlink traversal in file APIs allows access outside worktree root
- **レビュー種別**: 影響分析レビュー（Stage 3）
- **対象**: 設計方針書 `dev-reports/design/issue-394-symlink-traversal-fix-design-policy.md`
- **実施日**: 2026-03-02
- **レビュー観点**: 既存テスト影響、パフォーマンス、後方互換性、間接波及、既存パターン重複、エラー動作変化

---

## サマリー

設計方針書の影響分析を6つの観点で実施した。全体として設計品質は良好であり、macOS tmpdir互換性やDefense-in-depth構造の設計は適切である。ただし、**validateFileOperation()の返却値がmacOSテスト環境で既存テストを壊すリスク**がmust_fixとして検出された。また、エラー動作変化のユーザビリティ、upload経路での二重検証フローの文書化不足がshould_fixとして指摘された。

| 重要度 | 件数 |
|--------|------|
| must_fix | 1 |
| should_fix | 3 |
| nice_to_have | 3 |
| **合計** | **7** |

---

## 指摘事項

### S3-001 [must_fix] validateFileOperation()のresolvedSource返却値がmacOS tmpdirテストで不一致になるリスク

**カテゴリ**: テスト影響

**問題**:

`validateFileOperation()` は現在 `join(worktreeRoot, sourcePath)` を `resolvedSource` として返却している（`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-operations.ts` 行476）。

```typescript
// 現在の実装（file-operations.ts 行468-476）
const fullPath = join(worktreeRoot, sourcePath);
if (!existsSync(fullPath)) {
  return { success: false, error: createErrorResult('FILE_NOT_FOUND') };
}
return { success: true, resolvedSource: fullPath };
```

既存テスト（`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/unit/lib/file-operations-validate.test.ts` 行36）では以下のように検証している。

```typescript
const result = validateFileOperation(testDir, 'test.txt');
expect(result.success).toBe(true);
if (result.success) {
  expect(result.resolvedSource).toBe(join(testDir, 'test.txt'));
}
```

`testDir` は `os.tmpdir()` ベースであり、macOSでは `/var/folders/...` を返す。しかし `fs.realpathSync()` は `/private/var/folders/...` を返す（実測確認済み）。

設計方針書の計画通り `validateFileOperation()` 内に `resolveAndValidateRealPath()` を追加する際、もし `resolvedSource` の返却値を `realpathSync()` 解決済みパスに変更すると、既存テストが失敗する。

**該当箇所**: 設計方針書 セクション5.2 validateFileOperation()行、セクション5.3 macOS tmpdir互換性

**改善提案**:

設計方針書に `validateFileOperation()` の返却値ポリシーを明記すること。推奨は選択肢A。

- **(A) resolvedSourceの返却値は変更しない（推奨）**: resolveAndValidateRealPath() はboolean検証のみを行い、resolvedSource は既存通り `join(worktreeRoot, sourcePath)` を維持
- **(B) realpath解決済みパスに変更**: 既存テストを `fs.realpathSync(join(testDir, 'test.txt'))` に更新する旨を明記

---

### S3-002 [should_fix] api-file-operations.test.tsがtmpdir使用でrealpath検証追加後に壊れるケースの未検討

**カテゴリ**: テスト影響

**問題**:

`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/integration/api-file-operations.test.ts`（行61）は `testDir` を `tmpdir()` ベースで作成し、`worktree.path` に直接設定している。`getWorktreeAndValidatePath()` に `resolveAndValidateRealPath()` を追加すると、rootDir / targetPath の双方に `realpathSync()` が適用されるため既存テストは壊れない。しかし、設計方針書のテスト設計セクション（セクション8）にはこの分析が記載されていない。

tmpdir使用テストファイルは以下の9件が確認された。

| テストファイル | 影響評価 |
|---------------|---------|
| `tests/unit/lib/file-operations.test.ts` | resolvedSource返却値に依存しなければ安全 |
| `tests/unit/lib/file-operations-validate.test.ts` | S3-001参照（resolvedSource検証あり） |
| `tests/unit/lib/file-operations-move.test.ts` | resolvedSource直接参照なし、安全 |
| `tests/unit/lib/file-tree.test.ts` | file-tree.tsは変更なし、安全 |
| `tests/unit/lib/file-tree-timestamps.test.ts` | file-tree.tsは変更なし、安全 |
| `tests/unit/lib/cmate-parser.test.ts` | 別モジュール、安全 |
| `tests/integration/api-file-operations.test.ts` | 両方realpathSync適用で一致、安全 |
| `tests/integration/security.test.ts` | 要確認 |
| `tests/integration/api-file-tree.test.ts` | tree APIルートの変更影響あり得る |

**該当箇所**: 設計方針書 セクション8 テスト設計

**改善提案**: セクション8に「既存テストへの影響分析」サブセクションを追加し、影響を受ける可能性のあるテストファイル一覧と安全性の評価を列挙すること。

---

### S3-003 [should_fix] upload APIルートの二重検証フローの文書化不足

**カテゴリ**: 既存パターン重複

**問題**:

upload APIルートでは以下の二重検証が発生する。

```
1. API層: resolveAndValidateRealPath(normalizedDir, worktree.path)
   -> normalizedDir（ディレクトリ）の検証

2. writeBinaryFile()内: resolveAndValidateRealPath(relativePath, worktreeRoot)
   -> relativePath = normalizedDir + "/" + filename（ファイル、未存在）の検証
   -> 祖先走査フォールバック -> normalizedDirに帰着
```

二重検証は安全側に倒す正しい設計だが、祖先走査がAPI層で既に検証済みのディレクトリに帰着する具体的フローが設計方針書に記載されていない。

**該当箇所**: 設計方針書 セクション5.2 API routes表 upload行

**改善提案**: upload行の備考欄に二重検証の具体的フローを補足すること。

---

### S3-004 [should_fix] symlink経由アクセスの動作変更に対するマイグレーション考慮の不足

**カテゴリ**: エラー動作変化

**問題**:

修正後、ワークツリー外を指すsymlinkが一律 `INVALID_PATH` で拒否される。これは正当なセキュリティ修正だが、以下のケースでユーザーが影響を受ける可能性がある。

1. gitリポジトリ内にコミットされたsymlink（monorepoのパッケージ間リンク等）
2. ビルドツールが生成するsymlinkディレクトリ

エラーメッセージ「Invalid path」は原因の特定が困難であり、ユーザーはsymlinkが原因であることを認識できない。

既存コードでの動作変化の箇所。

| API | 既存動作 | 修正後動作 |
|-----|---------|-----------|
| GET files (text) | symlink先のファイル内容を返却 | INVALID_PATH (400) |
| GET files (image/video) | symlink先の画像/動画を返却 | INVALID_PATH (400) |
| PUT files | symlink先のファイルを更新 | INVALID_PATH (400) |
| DELETE files | symlink先のファイルを削除 | INVALID_PATH (400) |
| GET tree | symlink先のディレクトリ内容を返却 | Access denied (403) |

**該当箇所**: 設計方針書 セクション6 脅威モデル

**改善提案**: (1) サーバーログ（console.warn）にsymlinkトラバーサル拒否の理由を出力してデバッグを容易にすること、(2) エラーメッセージの具体化（例：「Path resolves outside worktree boundary」）を検討すること。

---

### S3-005 [nice_to_have] Defense-in-depth二重チェックのrealpathSync呼び出し回数の定量評価

**カテゴリ**: パフォーマンス

**問題**:

設計方針書では「1リクエストあたり最大4回」としているが、PATCH move操作では最大8回のrealpathSync呼び出しが発生する。

```
getWorktreeAndValidatePath()    : realpathSync x2 (root + target)
validateFileOperation()         : realpathSync x2 (root + source)
SEC-006 (既存)                  : realpathSync x2 (dest + root)
ステップ8 MOVE_SAME_PATH (既存) : realpathSync x2 (source + root)
合計                            : realpathSync x8
```

VFSキャッシュにより実質的な影響は無視できるため、パフォーマンス上の問題にはならない。

**該当箇所**: 設計方針書 セクション7 パフォーマンス設計

**改善提案**: セクション7のI/O影響分析表のfiles PATCH行にmove操作時の正確な見積もりを追記すること。

---

### S3-006 [nice_to_have] moveFileOrDirectory()のSEC-006とresolveAndValidateRealPath()の防御範囲の重複整理

**カテゴリ**: 既存パターン重複

**問題**:

`moveFileOrDirectory()` では修正後、sourceパスは `resolveAndValidateRealPath()` で、destinationパスは既存のSEC-006（`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-operations.ts` 行544-553）で検証される。両方とも `realpathSync` + `startsWith` パターンだが、ルートディレクトリ自体の扱いが異なる。

```typescript
// SEC-006 (既存): resolvedDest !== resolvedRoot（ルート自体への移動を許可）
if (!resolvedDest.startsWith(resolvedRoot + sep) && resolvedDest !== resolvedRoot) {

// resolveAndValidateRealPath (新規): resolvedTarget === resolvedRootを許可
// （ルートディレクトリ自体へのアクセスを許可）
```

将来的にSEC-006をresolveAndValidateRealPath()に置き換えるかの方針が不明。

**該当箇所**: 設計方針書 セクション5.2、セクション5.1 [S2-006]

**改善提案**: セクション9の設計上の決定事項テーブルに、SEC-006を既存のまま維持する方針とその理由を追記すること。

---

### S3-007 [nice_to_have] file-tree.test.tsのsymlinkスキップテストとの整合性確認が未記載

**カテゴリ**: テスト影響

**問題**:

`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/unit/lib/file-tree.test.ts`（行359）ではsymlinkスキップテストが存在する。tree APIルートに `resolveAndValidateRealPath()` を追加しても、子エントリのsymlinkスキップは `file-tree.ts` の `lstat + isSymbolicLink()` で行われるため影響はない。しかし設計方針書にはこの分析が明記されていない。

**該当箇所**: 設計方針書 セクション5.2 変更しないファイル表

**改善提案**: file-tree.tsのエントリについても「変更しないファイル」表に記載すること。

---

## 総合評価

| 項目 | 評価 |
|------|------|
| 全体品質 | **good** |
| 既存テストへの影響把握 | 一部不足（S3-001がリスク） |
| パフォーマンス影響 | 無視できるレベル（適切） |
| 後方互換性 | 概ね考慮済み（エラー動作変化の文書化に改善余地） |
| 間接的な影響 | 適切に把握済み |
| 既存パターンとの重複 | 合理的な設計（一部文書化不足） |

## 推奨事項

1. **S3-001を最優先で対応**: validateFileOperation()のresolvedSource返却値ポリシーを確定し、設計方針書に明記すること。macOSでの既存テスト失敗に直結するため、実装前に決定が必要
2. **S3-004の検討を推奨**: セキュリティ修正の実用上の品質として、サーバーログへのsymlinkトラバーサル拒否理由の出力は低コストで実装可能であり、運用時のデバッグに有用
3. **S3-002/S3-003は実装チェックリストに反映**: 既存テスト影響分析とupload経路の二重検証フローを文書化し、実装時の確認事項に含めること

---

*Generated by architecture-review-agent for Issue #394 Stage 3*
*Review date: 2026-03-02*

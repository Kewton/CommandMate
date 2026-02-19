# Issue #308 進捗レポート

## 概要

| 項目 | 内容 |
|------|------|
| **Issue** | #308 - git clone時のディレクトリがおかしい |
| **Iteration** | 1 |
| **報告日時** | 2026-02-19 |
| **ステータス** | 完了（全フェーズ成功） |
| **ブランチ** | `feature/308-worktree` |

---

## 実装内容

### 問題の概要

CloneManagerの`basePath`未設定時に`/tmp/repos`がハードコードされており、`.env`で設定した`CM_ROOT_DIR`が無視されていた。結果として、UIからgit cloneを実行すると意図しないディレクトリにリポジトリが作成されていた。

### 解決策

Dependency Injection（DI）パターンにより、APIルートからCloneManagerへ`getEnv().CM_ROOT_DIR`を`basePath`として明示的に渡す設計に変更した。ハードコード値`/tmp/repos`を完全に除去し、3段階のフォールバック優先順位を導入した。

**basePath決定の優先順位:**
1. `config.basePath`（`getEnv().CM_ROOT_DIR`経由で注入）
2. `WORKTREE_BASE_PATH` 環境変数（非推奨、警告出力付き）
3. `process.cwd()`（最終フォールバック）

### 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/clone-manager.ts` | `resolveDefaultBasePath()`メソッド追加、`/tmp/repos`ハードコード除去、エラーメッセージからの情報漏洩修正（D4-001, D4-003）、非推奨警告の重複防止フラグ |
| `src/app/api/repositories/clone/route.ts` | `getEnv().CM_ROOT_DIR`をCloneManagerに注入、`targetDir`の型検証追加（D4-002） |
| `src/app/api/repositories/clone/[jobId]/route.ts` | `getEnv().CM_ROOT_DIR`をCloneManagerに注入（コード一貫性維持） |
| `.env.example` | `CM_ROOT_DIR`のclone先としての役割を追記 |
| `tests/unit/lib/clone-manager.test.ts` | basePath解決テスト6件 + セキュリティテスト2件 = 9件の新規テスト追加、未使用import削除 |
| `tests/integration/api-clone.test.ts` | `getEnv`モック追加（`CM_ROOT_DIR`設定）、D4-002型検証テスト追加 |
| `CLAUDE.md` | `clone-manager.ts`のモジュール説明をIssue #308の変更内容で更新 |

### 主な実装のポイント

**1. Dependency Injection によるbasePath注入**

```typescript
// src/app/api/repositories/clone/route.ts
const { CM_ROOT_DIR } = getEnv();
const cloneManager = new CloneManager(db, { basePath: CM_ROOT_DIR });
```

**2. resolveDefaultBasePath() によるフォールバック制御**

```typescript
// src/lib/clone-manager.ts
private resolveDefaultBasePath(): string {
  const worktreeBasePath = process.env.WORKTREE_BASE_PATH;
  if (worktreeBasePath) {
    if (!warnedWorktreeBasePath) {
      console.warn(
        '[DEPRECATED] WORKTREE_BASE_PATH is deprecated. Set CM_ROOT_DIR in your .env file instead.'
      );
      warnedWorktreeBasePath = true;
    }
    return path.resolve(worktreeBasePath);
  }
  return process.cwd();
}
```

**3. セキュリティ改善（D4-001, D4-002, D4-003）**

- パストラバーサルエラーメッセージから`basePath`値を除去（情報漏洩防止）
- ディレクトリ存在エラーメッセージから`targetPath`完全パスを除去
- `targetDir`パラメータの型検証（object/array injection防止）

---

## フェーズ別結果

### Phase 1: TDD実装

**ステータス**: 成功

- **テスト結果**: ユニット 47/47 パス、インテグレーション 12/12 パス
- **新規テスト**: 9件追加
- **静的解析**: TypeScript 0 errors, ESLint 0 errors

**追加されたテスト:**

| テスト | 検証内容 |
|-------|---------|
| config.basePath明示指定時の使用 | DIパターンの基本動作 |
| WORKTREE_BASE_PATHフォールバック + 非推奨警告 | レガシー環境変数対応 |
| WORKTREE_BASE_PATHのpath.resolve()正規化（D1-007） | 相対パスの安全な変換 |
| process.cwd()フォールバック | 全環境変数未設定時の動作 |
| 非推奨警告の重複防止 | 複数インスタンス化時の警告制御 |
| CM_ROOT_DIR優先（両方設定時） | 優先順位の正確さ |
| パストラバーサルエラーのbasePath非漏洩（D4-001） | セキュリティ |
| ディレクトリ存在エラーのtargetPath非漏洩（D4-003） | セキュリティ |
| targetDirの型検証（D4-002） | 入力バリデーション |

**コミット:**
- `37584ad`: fix(#308): use CM_ROOT_DIR for clone basePath instead of hardcoded /tmp/repos

---

### Phase 2: 受入テスト

**ステータス**: 全項目パス（8/8）

| 受入条件 | 結果 |
|---------|------|
| CM_ROOT_DIR反映: clone/route.tsがgetEnv().CM_ROOT_DIRをbasePathとしてCloneManagerに渡す | Pass |
| process.cwd()フォールバック: resolveDefaultBasePath()がWORKTREE_BASE_PATH未設定時にprocess.cwd()を返す | Pass |
| WORKTREE_BASE_PATH非推奨警告: 設定時にconsole.warnで警告が出力される | Pass |
| 警告重複防止: warnedWorktreeBasePathフラグで初回のみ警告 | Pass |
| CM_ROOT_DIR優先: config.basePath(CM_ROOT_DIR)がWORKTREE_BASE_PATHより優先 | Pass |
| D4-001: パストラバーサルエラーにbasePath値が含まれない | Pass |
| D4-002: targetDirの型検証（typeof !== 'string'）が追加されている | Pass |
| D4-003: ディレクトリ存在エラーにtargetPath完全パスが含まれない | Pass |

**追加テストシナリオ（7件）も全てパス。**

---

### Phase 3: リファクタリング

**ステータス**: 成功

| 変更 | ファイル | 内容 |
|------|---------|------|
| 未使用import削除 | `tests/unit/lib/clone-manager.test.ts` | `CloneResult`, `UrlNormalizer`, `getRepositoryByNormalizedUrl`の3つを除去 |
| JSDoc強化 | `src/lib/clone-manager.ts` | `resolveDefaultBasePath()`に`@returns`タグ追加、「once per process」の記述を明確化 |

**コミット:**
- `8508d1f`: refactor(#308): remove unused imports and improve JSDoc in clone-manager

---

### Phase 4: ドキュメント更新

**ステータス**: 完了

- `CLAUDE.md`: clone-manager.tsの説明をIssue #308の変更内容（resolveDefaultBasePath()追加、エラーメッセージ情報漏洩修正）で更新

---

## 品質指標

| 指標 | 結果 |
|------|------|
| TypeScript型チェック | 0 errors |
| ESLint | 0 errors, 0 warnings |
| ユニットテスト | 47/47 パス (100%) |
| インテグレーションテスト | 12/12 パス (100%) |
| 受入条件 | 8/8 パス (100%) |
| テストシナリオ | 7/7 パス (100%) |
| 新規テスト数 | 9件 |

### 静的解析の推移

| 指標 | Before | After | 変化 |
|------|--------|-------|------|
| ESLint errors | 0 | 0 | -- |
| TypeScript errors | 0 | 0 | -- |

---

## 設計方針チェックリスト達成状況

全ての設計方針項目が実装・テスト済み。

| ID | 項目 | 状態 |
|----|------|------|
| D1-003 | CM_ROOT_DIR優先 | 実装済み |
| D1-004 | WORKTREE_BASE_PATHフォールバック | 実装済み |
| D1-007 | WORKTREE_BASE_PATHのpath.resolve()正規化 | 実装済み |
| D2-001 | getEnv().CM_ROOT_DIRのDI注入 | 実装済み |
| D2-002 | CloneManagerのconfig.basePath活用 | 実装済み |
| D2-003 | jobId route.tsの一貫性維持 | 実装済み |
| D2-005 | process.cwd()最終フォールバック | 実装済み |
| D3-001 | 既存テスト維持 | 確認済み |
| D3-004 | WORKTREE_BASE_PATH非推奨テスト | 実装済み |
| D4-001 | basePath値の非漏洩 | 実装済み |
| D4-002 | targetDirの型検証 | 実装済み |
| D4-003 | targetPath値の非漏洩 | 実装済み |

---

## ブロッカー

なし。全フェーズが成功し、品質基準を満たしている。

---

## 次のアクション

1. **PR作成** - `feature/308-worktree` から `main` へのPull Requestを作成
2. **レビュー依頼** - チームメンバーにコードレビューを依頼
3. **マージ後の確認** - 本番環境で`.env`の`CM_ROOT_DIR`が正しくclone先として反映されることを確認

---

## コミット履歴

| Hash | メッセージ |
|------|----------|
| `37584ad` | fix(#308): use CM_ROOT_DIR for clone basePath instead of hardcoded /tmp/repos |
| `8508d1f` | refactor(#308): remove unused imports and improve JSDoc in clone-manager |

---

## 備考

- 全フェーズ（TDD、受入テスト、リファクタリング、ドキュメント更新）が成功
- セキュリティ改善（D4-001/D4-002/D4-003）を含む包括的な修正
- 後方互換性を維持（WORKTREE_BASE_PATHを非推奨フォールバックとして保持）
- テスト間干渉防止のため`resetWorktreeBasePathWarning()`を`@internal`エクスポート

**Issue #308の実装が完了しました。**

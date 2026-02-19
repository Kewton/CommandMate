# Issue #308 Stage 3 レビューレポート

**レビュー日**: 2026-02-19
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 2 |

## Must Fix（必須対応）

### S3-001: フロントエンド影響範囲の記載欠如

**カテゴリ**: impact_scope
**場所**: 影響範囲 - 変更対象ファイル

**問題**:
Issue の影響範囲に `RepositoryManager.tsx` が記載されていない。`repositoryApi.clone()` はクローン先パスを UI に表示しないため直接的なコード変更は不要だが、clone 完了後に `worktreeApi.getAll()` でリフレッシュされるリストのパス表示が変わる（`/tmp/repos/xxx` から `CM_ROOT_DIR/xxx` に変わる）。

修正後にクローンした新規リポジトリと、既存のクローン済みリポジトリでパス表記が混在する可能性があり、UI 上のユーザー体験に影響する。

**証拠**:
- `src/components/repository/RepositoryManager.tsx` L144: `repositoryApi.clone(cloneUrl.trim())`
- `src/lib/api-client.ts` L333-338: `repositoryApi.clone()` は `cloneUrl` のみ送信

**推奨対応**:
影響範囲の「関連コンポーネント」に以下を追加する:
- `src/components/repository/RepositoryManager.tsx` - clone 機能のフロントエンド呼び出し元（コード変更不要、ただし clone 先パスが変更になるため UI 上の表示パスが変わる）
- サイドバーのリポジトリ一覧 - 新規 clone リポジトリのパスが `CM_ROOT_DIR` 配下として表示される

---

### S3-002: 既存クローン済みリポジトリのDB整合性が未考慮

**カテゴリ**: data_integrity
**場所**: Issue本文全体 - DB・データ整合性の考慮が欠如

**問題**:
既存のクローン済みリポジトリについての考慮が Issue に全く記載されていない。`repositories` テーブルの `path` カラムには、既に `/tmp/repos/xxx`（macOS では `/private/tmp/repos/xxx`）のパスで登録されたレコードが存在しうる。basePath を変更しても既存の DB レコードは自動更新されない。

具体的な影響:
1. DB 上のパスと実ファイルシステムのパスは一致したまま（`/tmp/repos` に実体がある）
2. `isPathSafe` の検証基準が `CM_ROOT_DIR` に変わると、既存リポジトリのパス（`/tmp/repos/xxx`）に対する `customTargetPath` 検証の基準が変わりうる
3. サーバー再起動時の worktree スキャン（`server.ts` `initializeWorktrees()`）は `getRepositoryPaths()` が返す `CM_ROOT_DIR`/`WORKTREE_REPOS` 配下のみスキャンするため、`/tmp/repos` にある既存リポジトリはスキャン対象外になり、DB 上は残るが worktree の同期更新が行われなくなる

**証拠**:
- `src/lib/db-repository.ts` L132-180: `createRepository()` で `path` カラムにクローン先パスが永続化される
- `server.ts` L79: `getRepositoryPaths()` は `WORKTREE_REPOS` > `CM_ROOT_DIR` のフォールバックで取得
- `server.ts` L117: `scanMultipleRepositories(filteredPaths)` は `CM_ROOT_DIR` 配下のみスキャン

**推奨対応**:
影響範囲セクションに「既存データへの影響」サブセクションを追加し、以下を明記する:
- 既存の `/tmp/repos` 配下に clone 済みのリポジトリは DB にパスが登録されており、basePath 変更後も DB レコードはそのまま残る
- これらのリポジトリは引き続き UI 上に表示されるが、サーバー再起動時の自動 worktree スキャン対象は `CM_ROOT_DIR` 配下のみであるため、worktree 情報が更新されなくなる可能性がある
- 本バグ修正は「新規 clone の保存先」を修正するものであり、既存データのマイグレーションは本 Issue のスコープ外とすることを明示する

---

## Should Fix（推奨対応）

### S3-003: scan API との整合性の言及がない

**カテゴリ**: impact_scope
**場所**: 影響範囲 - 関連コンポーネント

**問題**:
`src/app/api/repositories/scan/route.ts` は既に `getEnv().CM_ROOT_DIR` を `isPathSafe` の基準ディレクトリとして使用している（L26-29）。clone API の basePath も `CM_ROOT_DIR` に統一されることで、scan と clone の両方が同じ `CM_ROOT_DIR` を基準としたパス検証を行うことになる。これは設計の整合性向上だが、Issue の影響範囲には scan API との関係が記載されていない。

**証拠**:
```typescript
// src/app/api/repositories/scan/route.ts L26-29
const { CM_ROOT_DIR } = getEnv();
if (!isPathSafe(repositoryPath, CM_ROOT_DIR)) {
```

**推奨対応**:
影響範囲の「関連コンポーネント」に追加: `src/app/api/repositories/scan/route.ts` - 既に `getEnv().CM_ROOT_DIR` を `isPathSafe` の基準として使用。今回の修正により clone API も同じ基準を使用することになり、整合性が向上する（変更不要）。

---

### S3-004: WORKTREE_BASE_PATH 非推奨化の実装詳細が不明確

**カテゴリ**: backward_compatibility
**場所**: 対策案 / 受入条件 - WORKTREE_BASE_PATH の非推奨化

**問題**:
WORKTREE_BASE_PATH の非推奨化に関して、以下が未定義:
1. `console.warn` はサーバーログにのみ出力され、UI 上にはユーザーに通知されない
2. 非推奨警告を CloneManager コンストラクタで出力するのか、clone API ルートで出力するのかが未定義
3. `env.ts` の既存 `getEnvWithFallback()` パターン（L57-73）では `warnedKeys` Set で重複防止しているが、`WORKTREE_BASE_PATH` は `ENV_MAPPING` に含まれないため同じパターンを使えない
4. 既存の設計方針（`issue-76-env-fallback-design-policy.md`）で `WORKTREE_BASE_PATH` は「フォールバック対象外」と記録されている

**証拠**:
- `src/lib/env.ts` L40-41: `warnedKeys` Set によるモジュールスコープの重複防止
- `dev-reports/design/issue-76-env-fallback-design-policy.md` L234: `WORKTREE_BASE_PATH` はフォールバック対象外

**推奨対応**:
実装タスクの非推奨化対応を具体化:
- 警告出力場所: CloneManager コンストラクタ内
- 重複防止: モジュールスコープ変数で初回のみ出力
- `ENV_MAPPING` には追加しない（Issue #76 設計方針準拠）

---

### S3-005: server.ts の古い警告メッセージと環境変数系統の不整合

**カテゴリ**: impact_scope
**場所**: 影響範囲 - 変更対象ファイル

**問題**:
`server.ts` L83 の警告メッセージ `'Set WORKTREE_REPOS (comma-separated) or MCBD_ROOT_DIR'` が古い表現のまま。`CM_ROOT_DIR` を clone の basePath として公式に使用するようになる以上、起動時の案内も `CM_ROOT_DIR` に更新すべき。

また、worktree スキャン（`WORKTREE_REPOS` > `CM_ROOT_DIR`）と clone（`WORKTREE_BASE_PATH` > `'/tmp/repos'`）が別の環境変数系統を使用しているという根本的な不整合が、本修正で解消されることを影響範囲に明記すべき。

**証拠**:
- `server.ts` L83: `console.warn('Set WORKTREE_REPOS (comma-separated) or MCBD_ROOT_DIR');`
- `src/lib/worktrees.ts` L123-133: `WORKTREE_REPOS` > `CM_ROOT_DIR` フォールバック
- `src/lib/clone-manager.ts` L193: `WORKTREE_BASE_PATH` > `'/tmp/repos'` フォールバック

**推奨対応**:
影響範囲に以下を追加:
- `server.ts` L83: 起動時警告メッセージの `MCBD_ROOT_DIR` 表記を `CM_ROOT_DIR` に修正（任意、本 Issue の一環として対応可能）
- worktree スキャンと clone が別の環境変数系統を使用している現状の不整合が、本修正で解消されることを明記

---

### S3-006: テスト環境でのモック方針が未定義

**カテゴリ**: test_coverage
**場所**: 実装タスク - テスト更新

**問題**:
テスト更新タスクにおいて、以下の重要な考慮事項が不足:
1. `process.cwd()` フォールバック時: テスト内で `vi.spyOn(process, 'cwd')` でモックする必要がある
2. 既存テスト（`clone-manager.test.ts`）は `new CloneManager(db)` を引数なしで呼んでおり、修正後は basePath が `process.cwd()` になるため、テスト実行ディレクトリに依存する
3. 統合テスト（`api-clone.test.ts`）は `getDbInstance` をモックしているが `getEnv` はモックしていない。clone API ルートで `getEnv().CM_ROOT_DIR` を呼ぶようになると、テスト時の挙動が変わる

**証拠**:
- `tests/unit/lib/clone-manager.test.ts` L42: `cloneManager = new CloneManager(db);`（引数なし）
- `tests/unit/lib/clone-manager.test.ts` L213: `const customPath = '/tmp/repos/custom/target/path';`（'/tmp/repos' 前提）
- `tests/integration/api-clone.test.ts` L20-22: `getDbInstance` のみモック、`getEnv` モックなし

**推奨対応**:
テスト更新タスクに以下を追記:
- `clone-manager.test.ts`: `process.cwd()` モック方針（`vi.spyOn(process, 'cwd').mockReturnValue('/test/base')`）
- `api-clone.test.ts`: `getEnv` のモック追加
- 各テストの `beforeEach` で `process.env.WORKTREE_BASE_PATH` をクリアし、テスト間の環境変数リークを防止

---

### S3-007: WORKTREE_BASE_PATH ユーザー向け移行ガイドの欠如

**カテゴリ**: migration
**場所**: Issue本文全体

**問題**:
`WORKTREE_BASE_PATH` を意図的に設定しているユーザーにとっては、非推奨化により将来的に動作が変わる。`.env.example` の更新タスクはあるが、既存ユーザー向けの移行手順が検討されていない。

特に `WORKTREE_BASE_PATH` と `CM_ROOT_DIR` の値が異なる場合（worktree スキャン先と clone 先が異なるディレクトリ）、切り替え時に注意が必要。

**推奨対応**:
影響範囲セクションまたはドキュメント整備に以下を追記:
- `WORKTREE_BASE_PATH` のみを使用しているユーザー向けの移行手順
- 本修正のリリースノートに非推奨化の告知を含めること

---

## Nice to Have（あれば良い）

### S3-008: フロントエンドが customTargetPath を送信しない事実の明記

**カテゴリ**: impact_scope
**場所**: 影響範囲 - 関連コンポーネント

**問題**:
現在のフロントエンド（`RepositoryManager.tsx`）は `targetDir`（`customTargetPath`）を送信しないため、clone 先は常に `basePath/repoName` で決定される。カスタムパス指定の UI は未実装であり、`customTargetPath` 経路への影響は限定的であるという事実の確認は影響分析上有用だが、Issue に記載がない。

**推奨対応**:
影響範囲の補足として、フロントエンドが `targetDir` を送信しない現状を記載し、影響が限定的であることを明示する。

---

### S3-009: onCloneSuccess() での DB 永続化パスの因果関係の明示

**カテゴリ**: impact_scope
**場所**: 影響範囲 - 変更対象ファイル

**問題**:
`CloneManager.onCloneSuccess()` メソッド（L452-488）で `createRepository(db, { path: targetPath })` により DB にパスが永続化される。basePath の変更が直接 DB に永続化されるパスに影響するという因果関係を明示することは、変更のトレーサビリティとして有用。

**推奨対応**:
影響範囲セクションの補足として、`onCloneSuccess()` でのパス永続化を記載する。

---

## 影響範囲マップ

### 直接的な影響

```
CloneManager.config.basePath (変更)
  |
  +-- getTargetPath() -> targetPath の変更
  |     |
  |     +-- clone_jobs.target_path (DB)
  |     +-- repositories.path (DB, onCloneSuccess経由)
  |
  +-- isPathSafe() の検証基準ディレクトリの変更
  |
  +-- WORKTREE_BASE_PATH 参照の非推奨化
```

### 間接的な影響

```
repositories.path の変更
  |
  +-- UI 上のリポジトリパス表示
  +-- サーバー起動時の worktree スキャン対象
  +-- 既存 clone 済みリポジトリとの混在

CM_ROOT_DIR の統一
  |
  +-- scan API との整合性向上
  +-- 環境変数系統の不整合解消
```

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/clone-manager.ts` | basePath デフォルト値（L193）、getTargetPath()（L251）、isPathSafe（L303）、onCloneSuccess()（L452） |
| `src/app/api/repositories/clone/route.ts` | CloneManager 初期化の呼び出し元（L71） |
| `src/app/api/repositories/scan/route.ts` | 既に CM_ROOT_DIR を isPathSafe 基準として使用（L26-29） |
| `src/lib/db-repository.ts` | createRepository() でパスを DB 永続化（L132-180） |
| `src/lib/worktrees.ts` | getRepositoryPaths() の環境変数フォールバック（L122-139） |
| `src/lib/env.ts` | getEnv().CM_ROOT_DIR の取得とフォールバック（L200, L234） |
| `src/components/repository/RepositoryManager.tsx` | clone 機能のフロントエンド呼び出し元（L144） |
| `src/lib/api-client.ts` | repositoryApi.clone() の API クライアント（L333-338） |
| `server.ts` | initializeWorktrees() の worktree スキャン（L71-126） |
| `tests/unit/lib/clone-manager.test.ts` | basePath 依存テスト（L213） |
| `tests/integration/api-clone.test.ts` | getEnv モックなし（要更新） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `dev-reports/design/issue-76-env-fallback-design-policy.md` | WORKTREE_BASE_PATH がフォールバック対象外と記録 |
| `.env.example` | CM_ROOT_DIR の説明更新が必要（L8-10） |

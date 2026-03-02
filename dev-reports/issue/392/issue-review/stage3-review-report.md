# Issue #392 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-02
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue #392 の修正の影響範囲は明確に限定されている。主要変更箇所は `clone-manager.ts` の `startCloneJob()` 内のパス検証ロジック1箇所のみ。後続メソッド（`executeClone`, `onCloneSuccess`）はコード変更不要。`getCloneJobStatus()` と `cancelCloneJob()` は `targetPath` を参照しないため完全に影響外。DB スキーマ変更なし、フロントエンドへの影響なし、破壊的変更なし。唯一の Must Fix はテストカバレッジの不足である。

---

## 影響エリアの概要

### 1. CloneManager.startCloneJob() -- パス検証・代入ロジック [HIGH]

**修正内容**: `isPathSafe()` を `validateWorktreePath()` に置換し、`targetPath` に解決済み絶対パスを代入する。

**影響分析**: この変更は `startCloneJob()` のスコープ内で完結する。`targetPath` 変数の値が相対パスから絶対パスに変わるが、型は `string` のまま変わらないため、後続の関数呼び出しのインターフェースに変更はない。

### 2. CloneManager.executeClone() -- mkdirSync と git clone [MEDIUM]

**修正内容**: コード変更なし。引数 `targetPath` が常に絶対パスになる。

**影響分析**: `mkdirSync(parentDir, { recursive: true })` は絶対パスの `path.dirname()` から親ディレクトリを取得するため、`basePath` 配下にのみディレクトリを作成する。`spawn('git', ['clone', ..., targetPath])` も絶対パスでクローン先を指定するため、`process.cwd()` 基準の相対パス解釈が排除される。

### 3. CloneManager.onCloneSuccess() -- DB 永続化 [MEDIUM]

**修正内容**: コード変更なし。引数 `targetPath` が常に絶対パスになる。

**影響分析**: `createRepository()` に渡される `path` フィールドと `path.basename(targetPath)` による `name` フィールドが、解決済み絶対パスに基づくものになる。`scanWorktrees(targetPath)` も絶対パスを受け取る。これは改善方向の変更。

### 4. route.ts -- targetDir の trim() 追加 [LOW]

**修正内容**: `targetDir?.trim() || undefined` の追加。

**影響分析**: 入力サニタイズの改善であり、既存動作に影響しない。フロントエンド `api-client.ts` は `targetDir` を送信しない（L345-349）ため、UI フローへの影響は皆無。

### 5. 既存テスト [MEDIUM]

**修正内容**: 新規テストケースの追加が必要。既存テストの修正は不要（分析済み）。

**影響分析**: 既存の customPath テスト（L208-225）は絶対パス `/tmp/repos/custom/target/path` を使用しており、`validateWorktreePath()` 適用後も同一値が返るため既存テストは通る。

---

## Must Fix（必須対応）

### IF-001: 相対パス customTargetPath に対するテストケースが完全に欠如している

**カテゴリ**: テストカバレッジ
**場所**: `tests/unit/lib/clone-manager.test.ts` (L208-235 付近)

**問題**:
既存テストでは customPath に絶対パス `'/tmp/repos/custom/target/path'` のみを使用している。Issue #392 の脆弱性の本質は相対パスの `customTargetPath` が `isPathSafe()` を通過した後に未解決のまま使用される点にある。Acceptance Criteria の6項目のうち、現行テストでカバーされているのは項目5（パストラバーサル拒否: L227-235）のみ。

**証拠**:

```typescript
// 既存テスト: 絶対パスのみ
// clone-manager.test.ts L213
const customPath = '/tmp/repos/custom/target/path';

// 以下のテストケースが欠如:
// - 相対パス 'my-repo' -> '/tmp/repos/my-repo' への解決
// - '../escape' の拒否（Option A の例外ベース）
// - 解決済みパスの existsSync/createCloneJob/git clone での一貫使用
// - DB 保存パスの絶対パス検証
```

**推奨対応**:
以下のテストケースを追加する:

1. 相対パス `'my-repo'` が `'/tmp/repos/my-repo'` に解決されて `createCloneJob` に渡されること
2. 解決後のパスが `existsSync` の引数として使用されること（`vi.mocked(existsSync)` の呼び出し引数を検証）
3. DB に保存される `targetPath` が絶対パスであること（`getCloneJob` で取得して検証）
4. `'../escape'` が `INVALID_TARGET_PATH` で拒否されること
5. エラーレスポンスに `basePath` の値が含まれないこと（D4-001）
6. `mkdirSync` に渡される親ディレクトリパスが `basePath` 配下であること

---

## Should Fix（推奨対応）

### IF-002: Option A 採用時のエラー処理パターンが既存コードと異なる

**カテゴリ**: 影響範囲
**場所**: `src/lib/clone-manager.ts` L301-367 (startCloneJob)

**問題**:
現在の `startCloneJob()` は `isPathSafe()` の boolean 返却に基づいて `CloneResult`（エラーオブジェクト）を返すパターンを採用している。Option A の `validateWorktreePath()` は例外を throw するため、try-catch によるエラー変換が必要になる。他のメソッドはいずれも boolean/null チェックパターンを使用しており、例外ベースのパターンは `startCloneJob()` 内で唯一となる。

**推奨対応**:
try-catch ブロックのスコープを `validateWorktreePath()` 呼び出しのみに最小化するか、ヘルパー関数でラップして null 返却パターンに変換する。

```typescript
// パターン案: ヘルパー関数でラップ
function resolveCustomTargetPath(
  customPath: string, basePath: string
): string | null {
  try {
    return validateWorktreePath(customPath, basePath);
  } catch {
    return null;
  }
}

// 使用箇所
const resolvedPath = resolveCustomTargetPath(customTargetPath, this.config.basePath!);
if (!resolvedPath) {
  return { success: false, error: ERROR_DEFINITIONS.INVALID_TARGET_PATH };
}
const targetPath = resolvedPath;
```

---

### IF-003: validateWorktreePath() の二重 URL デコーディング設計

**カテゴリ**: 影響範囲
**場所**: `src/lib/path-validator.ts` L41-47 (isPathSafe), L107-116 (validateWorktreePath)

**問題**:
`validateWorktreePath()` は内部で `isPathSafe()` を呼び出し（L101）、`isPathSafe()` 内で `decodeURIComponent()` が実行される。その後、`validateWorktreePath()` 自身でも再度 `decodeURIComponent()` を実行する（L109-113）。`isPathSafe()` はデコード結果を返さない（boolean のみ返す）ため実害はないが、保守時に混乱を招く設計。

**推奨対応**:
Issue #392 のスコープ外として記録に留める。将来のリファクタリング候補。

---

### IF-004: 既存テスト L208-225 の修正後互換性の明文化

**カテゴリ**: 後方互換性
**場所**: `tests/unit/lib/clone-manager.test.ts` L208-225

**問題**:
分析の結果、既存テストは修正後も通ることを確認した。根拠は以下:
- `customPath = '/tmp/repos/custom/target/path'`（絶対パス）
- `basePath = '/tmp/repos'`
- `validateWorktreePath('/tmp/repos/custom/target/path', '/tmp/repos')` は `path.resolve('/tmp/repos', '/tmp/repos/custom/target/path')` を返す
- `path.resolve()` は第2引数が絶対パスの場合そのまま返すため、結果は `'/tmp/repos/custom/target/path'`
- したがって `job?.targetPath` は `customPath` と一致する

**推奨対応**:
この分析結果を PR の checklist に含め、CI で確認する。

---

### IF-005: getCloneJobStatus() と cancelCloneJob() は影響なし（確認済み）

**カテゴリ**: 影響範囲
**場所**: `src/lib/clone-manager.ts` L594-644

**確認結果**:
- `getCloneJobStatus()` は `CloneJobDB` の `status/progress/repositoryId/error` フィールドのみを `CloneJobStatusResponse` に含める。`targetPath` は参照されない
- `cancelCloneJob()` は `activeProcesses` Map からの `jobId` 検索と DB ステータス更新のみ。`targetPath` は参照されない
- **追加対応不要**

---

## Nice to Have（あれば良い）

### IF-006: フロントエンドは targetDir を送信しないため UI への影響は皆無

**場所**: `src/lib/api-client.ts` L345-349

`api-client.ts` の `clone()` メソッドは `{ cloneUrl }` のみを送信しており、`targetDir` は含まれない。この脆弱性は直接的な HTTP リクエスト（curl 等）による攻撃のみが対象。

---

### IF-007: DB スキーマへの影響なし

**場所**: `src/lib/db-migrations.ts` L604, `src/lib/db-repository.ts` L538-568

`clone_jobs.target_path` は `TEXT NOT NULL` 型であり、相対/絶対パスいずれも格納可能。スキーマ変更不要、マイグレーション不要。

---

### IF-008: opencode-config.ts のローカル validateWorktreePath() との名前衝突なし

**場所**: `src/lib/cli-tools/opencode-config.ts` L179, `src/lib/path-validator.ts` L89

同名関数が2箇所に存在するが、スコープが異なるため実害なし。将来のリファクタリング候補。

---

## 修正の波及効果まとめ

| メソッド/ファイル | コード変更 | 動作変更 | テスト変更 |
|-------------------|:----------:|:--------:|:----------:|
| `startCloneJob()` | 必要 | パス検証ロジック変更 | 新規追加必要 |
| `executeClone()` | 不要 | targetPath が絶対パスに | 不要 |
| `onCloneSuccess()` | 不要 | DB に絶対パス格納 | 不要 |
| `getCloneJobStatus()` | 不要 | なし | 不要 |
| `cancelCloneJob()` | 不要 | なし | 不要 |
| `route.ts` | trim()追加 | 入力サニタイズ改善 | 不要 |
| `api-client.ts` | 不要 | なし | 不要 |
| DB スキーマ | 不要 | なし | 不要 |

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/lib/clone-manager.ts` | 修正対象（startCloneJob のパス検証ロジック） |
| `src/lib/path-validator.ts` | isPathSafe() から validateWorktreePath() への移行元 |
| `src/app/api/repositories/clone/route.ts` | targetDir の trim() 追加対象 |
| `src/lib/db-repository.ts` | createCloneJob/createRepository の targetPath/path 格納 |
| `src/app/api/repositories/clone/[jobId]/route.ts` | 影響なし確認済み |
| `src/lib/api-client.ts` | targetDir 未送信の確認 |
| `src/lib/cli-tools/opencode-config.ts` | 同名 validateWorktreePath の存在確認 |

### テスト

| ファイル | 関連性 |
|---------|--------|
| `tests/unit/lib/clone-manager.test.ts` | 既存テスト互換性確認 / 新規テスト追加対象 |
| `tests/unit/path-validator.test.ts` | validateWorktreePath の既存テスト確認 |

---

## 全体評価

修正の影響範囲は `clone-manager.ts` の `startCloneJob()` メソッド内に局所化されており、波及効果は制御可能。破壊的変更はなく、DB スキーマ変更も不要。フロントエンドへの影響もない。既存テストは修正後も通ることを確認済み。主要なリスクはテストカバレッジの不足であり、Acceptance Criteria に定義された6つのテストシナリオの新規追加が修正品質の鍵となる。

# Issue #135 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-02-03
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3/6

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Nice to Have | 2 |

Issue #135の修正は広範囲に影響を与える。`db-instance.ts`は**56以上のAPIルートファイル**から直接インポートされており、パス解決ロジックの変更は全てのDBアクセスに影響する。

---

## 影響範囲サマリー

### 直接的影響（修正対象ファイル）

| ファイル | 影響内容 |
|---------|---------|
| `src/lib/db-instance.ts` | DBパス解決ロジックの修正（主要修正対象） |
| `src/lib/env.ts` | CM_DB_PATHのデフォルト値参照の修正可能性 |
| `src/cli/utils/env-setup.ts` | ENV_DEFAULTS.CM_DB_PATHの絶対パス化 |
| `src/cli/commands/init.ts` | createDefaultConfig()の修正 |
| `server.ts` | getDbInstance()呼び出しへの間接的影響 |

### 間接的影響（依存モジュール）

| モジュール | 依存方法 |
|-----------|---------|
| 56+ APIルートファイル | `getDbInstance()`を直接import |
| `src/lib/response-poller.ts` | DBアクセスに依存 |
| `src/lib/claude-poller.ts` | DBアクセスに依存 |
| `scripts/migrate-cli-tool-id.ts` | `CM_DB_PATH`を参照 |
| `scripts/clean-existing-messages.ts` | `CM_DB_PATH`を参照 |

---

## Must Fix（必須対応）

### M1: 広範なAPIルートへの影響

**カテゴリ**: 影響範囲

**問題**:
`db-instance.ts`の修正は56以上のAPIルートファイルに影響を与える。全てのAPIルートが`getDbInstance()`を直接インポートして使用しており、DBパス解決ロジックの変更は全てのAPIエンドポイントの動作に影響する可能性がある。

**影響を受けるファイル例**:
```
src/app/api/worktrees/route.ts
src/app/api/worktrees/[id]/route.ts
src/app/api/worktrees/[id]/files/[...path]/route.ts
src/app/api/repositories/route.ts
src/app/api/repositories/clone/route.ts
... (他53ファイル)
```

**推奨対応**:
修正後は全APIエンドポイントでDBアクセスが正常に動作することを統合テストで検証する必要がある。特に、グローバルインストール環境でのテストを追加すること。

---

### M2: 統合テストへの影響

**カテゴリ**: 影響範囲

**問題**:
20件以上の統合テストファイルが`getDbInstance()`を使用している。これらのテストは現在`process.cwd()`ベースのパス解決を前提としており、新しいパス解決ロジックに合わせてテスト環境のセットアップを見直す必要がある。

**影響を受けるテストファイル**:
```
tests/integration/api-worktrees.test.ts
tests/integration/api-clone.test.ts
tests/integration/api-repository-delete.test.ts
tests/integration/api-file-operations.test.ts
tests/integration/security.test.ts
... (他15ファイル)
```

**推奨対応**:
統合テストのsetup/teardownで`CM_DB_PATH`環境変数を明示的に設定し、テスト間でDBファイルが干渉しないようにする。テスト実行前に既存テストが全てパスすることを確認すること。

---

### M3: DATABASE_PATH廃止による後方互換性への影響

**カテゴリ**: 後方互換性

**問題**:
`DATABASE_PATH`環境変数の廃止は後方互換性に影響する。既存ユーザーが`.env`で`DATABASE_PATH`を使用している場合、修正後はその設定が無視される可能性がある。

**現在のコード** (`src/lib/db-instance.ts:25`):
```typescript
const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
```

**env.tsでの参照** (`src/lib/env.ts:169-171`):
```typescript
const databasePath = getEnvByKey('CM_DB_PATH')
    || process.env.DATABASE_PATH
    || path.join(process.cwd(), 'data', 'cm.db');
```

**推奨対応**:
`DATABASE_PATH`から`CM_DB_PATH`への自動マイグレーションまたはフォールバック機構を実装する。少なくとも警告メッセージを出力して、ユーザーに設定変更を促す。

---

## Should Fix（推奨対応）

### S1: server.tsでの環境変数ロード順序

**カテゴリ**: 影響範囲

**問題**:
`server.ts`は`getEnvByKey('CM_PORT')`と`getEnvByKey('CM_BIND')`を使用しているが、DBアクセスには`getDbInstance()`を使用している。`db-instance.ts`が`env.ts`の`getEnv()`を使用するように修正される場合、`server.ts`での環境変数ロード順序に注意が必要。

**推奨対応**:
`server.ts`での`getDbInstance()`呼び出し前に、`.env`ファイルがロードされていることを保証する。現在は`start.ts`で`dotenvConfig()`が呼ばれるが、`server.ts`単体で実行される場合の考慮も必要。

---

### S2: init.tsのパス生成ロジック

**カテゴリ**: 影響範囲

**問題**:
`src/cli/commands/init.ts`の`createDefaultConfig()`で`ENV_DEFAULTS.CM_DB_PATH`を使用している。現在は相対パス（`'./data/cm.db'`）だが、修正後は絶対パスに変更される予定。この変更がinit時に生成される`.env`ファイルの内容に影響する。

**推奨対応**:
`init.ts`で`getConfigDir()`を使用して絶対パスを生成するよう修正する。グローバルインストールとローカルインストールで異なるパスが生成されることをドキュメント化する。

---

### S3: テストケースの更新

**カテゴリ**: テスト影響

**問題**:
- `tests/unit/env.test.ts`は`CM_DB_PATH`のフォールバック機構をテストしているが、`db-instance.ts`が`env.ts`を使用するようになった場合の統合動作はテストされていない
- `tests/unit/cli/utils/env-setup.test.ts`は`ENV_DEFAULTS`の値をテストしているが、絶対パスへの変更が必要

**推奨対応**:
`db-instance.ts`と`env.ts`の統合テストを追加する。`env-setup.test.ts`のテストケースを更新して、グローバル/ローカルインストールの両方でのパス生成をテストする。

---

### S4: ドキュメント更新

**カテゴリ**: ドキュメント影響

**問題**:
複数のドキュメントファイルが`DATABASE_PATH`に言及している:
- `.env.example`
- `docs/DEPLOYMENT.md`
- `docs/architecture.md`
- `scripts/health-check.sh`
- `scripts/status.sh`

**推奨対応**:
全てのドキュメントとスクリプトで`DATABASE_PATH`参照を`CM_DB_PATH`に更新する。移行ガイド（`docs/migration-to-commandmate.md`）に`DATABASE_PATH`廃止に関する記載を追加する。

---

## Nice to Have（あれば良い）

### N1: スクリプトでのパス解決統一

**カテゴリ**: 影響範囲

**問題**:
`scripts/migrate-cli-tool-id.ts`と`scripts/clean-existing-messages.ts`が`getEnvByKey('CM_DB_PATH')`を使用している。これらのスクリプトは`db-instance.ts`の修正後も正常に動作するはずだが、一貫性のため`db-instance.ts`と同じパス解決ロジックを使用することが望ましい。

**推奨対応**:
スクリプトで`getDbInstance()`を使用するか、`env.ts`の`getEnv().CM_DB_PATH`を使用するように統一する。

---

### N2: CI/CD設定の確認

**カテゴリ**: CI/CD影響

**問題**:
CI/CDパイプライン（`.github/workflows/ci-pr.yml`, `publish.yml`）では環境変数を明示的に設定している可能性がある。グローバルインストールのテストがCI環境で実行されるか確認が必要。

**推奨対応**:
CI/CD設定で`CM_DB_PATH`が適切に設定されていることを確認する。必要であれば、グローバルインストールをシミュレートするテストジョブを追加する。

---

## 影響を受けるファイル一覧

### APIルート（getDbInstance使用）

| カテゴリ | ファイル数 |
|---------|-----------|
| `/api/worktrees/**` | 20+ |
| `/api/repositories/**` | 5+ |
| `/api/external-apps/**` | 3+ |
| `/api/hooks/**` | 1 |
| `/proxy/**` | 1 |
| **合計** | **56+** |

### テストファイル

| カテゴリ | ファイル数 |
|---------|-----------|
| 統合テスト | 20+ |
| ユニットテスト（関連） | 2 |

### ドキュメント・スクリプト

| ファイル | 更新内容 |
|---------|---------|
| `.env.example` | DATABASE_PATH参照削除 |
| `docs/DEPLOYMENT.md` | CM_DB_PATH説明更新 |
| `docs/architecture.md` | MCBD_DB_PATH記載更新 |
| `docs/migration-to-commandmate.md` | DATABASE_PATH廃止追記 |
| `scripts/health-check.sh` | DATABASE_PATH参照更新 |
| `scripts/status.sh` | DATABASE_PATH参照更新 |
| `CLAUDE.md` | db-instance.ts説明追加 |

---

## 推奨実装順序

1. **Phase 1**: `db-instance.ts`の修正
   - `getEnv().CM_DB_PATH`を使用するよう変更
   - `DATABASE_PATH`へのフォールバック警告を追加

2. **Phase 2**: CLI関連ファイルの修正
   - `env-setup.ts`のENV_DEFAULTSを絶対パス化
   - `init.ts`でgetConfigDir()を使用

3. **Phase 3**: テストの更新
   - 既存統合テストの環境変数設定更新
   - 新規テストケース追加

4. **Phase 4**: ドキュメント更新
   - DATABASE_PATH参照をCM_DB_PATHに統一
   - 移行ガイドの更新

5. **Phase 5**: マイグレーションロジック実装
   - 旧DBファイルの検出
   - 自動マイグレーション

---

## 結論

Issue #135は技術的に正しいアプローチで問題を解決しようとしているが、影響範囲が広いため慎重な実装が必要である。特に以下の点に注意:

1. **56以上のAPIルート**への影響を考慮し、十分な統合テストを実施
2. **DATABASE_PATH廃止**による後方互換性への影響を緩和するフォールバック機構
3. **20以上の統合テスト**の更新とテスト環境のセットアップ見直し
4. **複数ドキュメント**の一貫した更新

段階的なリリースと十分なテストカバレッジにより、安全に修正を適用できる。

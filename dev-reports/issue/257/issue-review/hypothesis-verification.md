# Issue #257 仮説検証レポート

## 検証日時
- 2026-02-13

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `server.ts:46`で開発/本番モード判定 | **Confirmed** | `const dev = process.env.NODE_ENV !== 'production';` 確認 |
| 2 | `isGlobalInstall()`でインストール方式判定 | **Partially Confirmed** | 関数は存在するが、判定ロジックの説明が簡略化されすぎ |
| 3 | `schema_version`テーブルで現在のバージョンv16を管理 | **Confirmed** | `CURRENT_SCHEMA_VERSION = 16` 確認 |
| 4 | `db-instance.ts:46`で`runMigrations()`自動実行 | **Confirmed** | コード確認済み |
| 5 | `npm run db:init`は既存DBをスキップ | **Confirmed** | `CREATE TABLE IF NOT EXISTS` 使用確認 |

## 詳細検証

### 仮説 1: server.ts:46で開発/本番モード判定

**Issue内の記述**:
> `process.env.NODE_ENV !== 'production'` で開発/本番モードを判定（`server.ts:46`）

**検証手順**:
1. `server.ts:46` を確認

**判定**: ✅ **Confirmed**

**根拠**:
```typescript
// server.ts:46
const dev = process.env.NODE_ENV !== 'production';
```

**Issueへの影響**: なし（正確）

---

### 仮説 2: isGlobalInstall()でインストール方式判定

**Issue内の記述**:
> `isGlobalInstall()` - `__dirname`がnode_modules配下か（`src/cli/utils/install-context.ts`）

**検証手順**:
1. `src/cli/utils/install-context.ts` の `isGlobalInstall()` 関数を確認

**判定**: ⚠️ **Partially Confirmed**

**根拠**:
関数は存在するが、Issue内の説明「`__dirname`がnode_modules配下か」は簡略化されすぎている。

実際のコード（`install-context.ts:33-45`）:
```typescript
export function isGlobalInstall(): boolean {
  // Check if running from global node_modules
  // Global installs typically have paths like:
  // - /usr/local/lib/node_modules/
  // - /Users/xxx/.npm-global/lib/node_modules/
  // - C:\Users\xxx\AppData\Roaming\npm\node_modules\
  const currentPath = dirname(__dirname);
  return (
    currentPath.includes('/lib/node_modules/') ||
    currentPath.includes('\\node_modules\\') ||
    currentPath.includes('/node_modules/commandmate')
  );
}
```

**Issueへの影響**:
Issue記載を以下のように修正すべき：

- **現在**: 「`__dirname`がnode_modules配下か」
- **修正案**: 「`dirname(__dirname)`がグローバルnode_modulesのパターン（`/lib/node_modules/`、`\\node_modules\\`、`/node_modules/commandmate`）にマッチするか」

---

### 仮説 3: schema_versionテーブルで現在のバージョンv16を管理

**Issue内の記述**:
> `schema_version` テーブルで現在のバージョンを管理（現在: v16）

**検証手順**:
1. `src/lib/db-migrations.ts:14` を確認

**判定**: ✅ **Confirmed**

**根拠**:
```typescript
// db-migrations.ts:14
export const CURRENT_SCHEMA_VERSION = 16;
```

**Issueへの影響**: なし（正確）

---

### 仮説 4: db-instance.ts:46でrunMigrations()自動実行

**Issue内の記述**:
> サーバー起動時に `runMigrations()` が自動実行される（`db-instance.ts:46`）

**検証手順**:
1. `src/lib/db-instance.ts:46` を確認

**判定**: ✅ **Confirmed**

**根拠**:
```typescript
// db-instance.ts:30-50
export function getDbInstance(): Database.Database {
  if (!dbInstance) {
    const env = getEnv();
    const dbPath = env.CM_DB_PATH;

    // Ensure the database directory exists
    const fs = require('fs') as typeof import('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    dbInstance = new Database(dbPath);
    runMigrations(dbInstance);  // ← 46行目
  }

  return dbInstance;
}
```

**Issueへの影響**: なし（正確）

---

### 仮説 5: npm run db:initは既存DBをスキップ

**Issue内の記述**:
> `npm run db:init` (`build-and-start.sh`含む) - `CREATE TABLE IF NOT EXISTS` のため既存DBスキップ

**検証手順**:
1. `package.json:35` で `db:init` スクリプトを確認
2. `scripts/init-db.ts` で `initDatabase()` 呼び出しを確認
3. `src/lib/db.ts:44-54` で `CREATE TABLE IF NOT EXISTS` 使用を確認

**判定**: ✅ **Confirmed**

**根拠**:
```typescript
// src/lib/db.ts:44-54
export function initDatabase(db: Database.Database): void {
  // Create worktrees table
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      last_message_summary TEXT,
      updated_at INTEGER
    );
  `);
  // ... 他のテーブルも同様に IF NOT EXISTS
}
```

**Issueへの影響**: なし（正確）

---

## Stage 1レビューへの申し送り事項

### 修正が必要な箇所

**仮説 2 の説明を修正**:

**現在の記載** (Issue #257「インストール方式別のアップデート方法」セクション):
> | 判定対象 | 判定方法 | ファイル |
> |---------|---------|------------|
> | インストール方式 | `isGlobalInstall()` - `__dirname`がnode_modules配下か | `src/cli/utils/install-context.ts` |

**修正案**:
> | 判定対象 | 判定方法 | ファイル |
> |---------|---------|------------|
> | インストール方式 | `isGlobalInstall()` - `dirname(__dirname)`がグローバルnode_modulesパターンにマッチするか | `src/cli/utils/install-context.ts` |

または、より詳細に：
> | 判定対象 | 判定方法 | ファイル |
> |---------|---------|------------|
> | インストール方式 | `isGlobalInstall()` - パスに`/lib/node_modules/`、`\\node_modules\\`、`/node_modules/commandmate`を含むか | `src/cli/utils/install-context.ts` |

---

## 検証完了

- ✅ 5件の仮説・前提条件を検証
- ✅ 4件 Confirmed
- ⚠️ 1件 Partially Confirmed（説明の簡略化による不正確さ）
- ❌ 0件 Rejected
- ❓ 0件 Unverifiable

**総合評価**: Issue #257の技術的前提は概ね正確。1箇所の説明を詳細化することで、より正確な仕様書となる。

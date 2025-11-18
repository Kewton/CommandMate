# Issue #2: 機能強化 - 設計書

## 目次
1. [アーキテクチャ概要](#アーキテクチャ概要)
2. [設計方針](#設計方針)
3. [データモデル詳細設計](#データモデル詳細設計)
4. [データベース設計](#データベース設計)
5. [API設計](#api設計)
6. [UI/コンポーネント設計](#uiコンポーネント設計)
7. [データフロー](#データフロー)
8. [技術的検討事項](#技術的検討事項)
9. [代替案と選択理由](#代替案と選択理由)

## アーキテクチャ概要

### 現行アーキテクチャ

```
┌─────────────────────────────────────────┐
│         Next.js Frontend (App Router)   │
│  - WorktreeList (一覧)                   │
│  - WorktreeDetail (詳細)                 │
│  - MessageList, MessageInput            │
└────────────┬────────────────────────────┘
             │ HTTP/WebSocket
┌────────────▼────────────────────────────┐
│         Custom Node.js Server            │
│  - REST API (/api/worktrees/*)          │
│  - WebSocket (リアルタイム更新)           │
│  - Worktree Scanner                      │
└────────────┬────────────────────────────┘
             │
┌────────────▼────────────────────────────┐
│         SQLite Database                  │
│  - worktrees                             │
│  - chat_messages                         │
│  - session_states                        │
└──────────────────────────────────────────┘
```

### Phase 1 拡張アーキテクチャ

```
┌─────────────────────────────────────────┐
│         Next.js Frontend                 │
│  + RepositorySection (リポジトリグループ)  │
│  + MemoEditor (メモ編集)                  │
│  + WorktreeCard (拡張: メモ・最新メッセージ)│
└────────────┬────────────────────────────┘
             │
┌────────────▼────────────────────────────┐
│         Custom Server (拡張)              │
│  + Multi-Repository Scanner              │
│  + PATCH /api/worktrees/:id (メモ更新)   │
│  + getLatestUserMessage()                │
└────────────┬────────────────────────────┘
             │
┌────────────▼────────────────────────────┐
│         SQLite (スキーマ拡張)             │
│  worktrees:                              │
│    + repository_path                     │
│    + repository_name                     │
│    + memo                                │
│    + last_user_message                   │
│    + last_user_message_at                │
└──────────────────────────────────────────┘
```

## 設計方針

### 基本方針

1. **段階的な実装**: Phase 1（環境変数ベース）を最小限の変更で実装
2. **下位互換性の維持**: 既存の単一リポジトリ環境でも動作
3. **パフォーマンス重視**: 大量のworktree対応のための最適化
4. **TypeScript型安全性**: 型定義の拡張と厳密化

### アーキテクチャ方針

#### 1. 複数リポジトリ対応

**選択: 環境変数ベースのマルチリポジトリスキャン**

```typescript
// 環境変数設定例
WORKTREE_REPOS="/path/to/repo1,/path/to/repo2,/path/to/repo3"
```

**理由:**
- 実装が単純
- 既存コードへの影響が最小限
- 設定ファイルやUIでの管理は Phase 2 で追加可能

**実装詳細:**
```typescript
// server.ts または worktree-scanner.ts
function getRepositoryPaths(): string[] {
  const reposEnv = process.env.WORKTREE_REPOS;

  if (!reposEnv) {
    // 後方互換性: 既存の WORKTREE_BASE_PATH を使用
    const basePath = process.env.WORKTREE_BASE_PATH || process.cwd();
    return [basePath];
  }

  return reposEnv.split(',').map(p => p.trim()).filter(Boolean);
}
```

#### 2. メモ機能

**選択: DB直接保存（追加カラム）**

**理由:**
- シンプル
- トランザクション安全性
- クエリパフォーマンス良好

**代替案（却下）:**
- ファイルシステムに保存 → 同期が難しい
- 別テーブル → 複雑さが増す

#### 3. 最新ユーザーメッセージ

**選択: 非正規化（worktreesテーブルにキャッシュ）**

**理由:**
- 一覧表示のパフォーマンス向上
- 頻繁に参照される情報
- メッセージ追加時に更新するロジックを追加すれば整合性が保たれる

**トレードオフ:**
- データの重複
- 更新ロジックの追加が必要

## データモデル詳細設計

### 1. Worktree インターフェース拡張

```typescript
/**
 * Worktree representation (Phase 1拡張版)
 */
export interface Worktree {
  /** URL-safe ID (e.g., "main", "feature-foo") */
  id: string;

  /** Display name (e.g., "main", "feature/foo") */
  name: string;

  /** Absolute path to worktree directory */
  path: string;

  /** Repository root path (NEW) */
  repositoryPath: string;

  /** Repository display name (NEW) */
  repositoryName: string;

  /** User memo for this worktree (NEW) */
  memo?: string;

  /** Latest user message content (NEW) */
  lastUserMessage?: string;

  /** Timestamp of latest user message (NEW) */
  lastUserMessageAt?: Date;

  /** Summary of last Claude message (DEPRECATED, for backward compatibility) */
  lastMessageSummary?: string;

  /** Last updated timestamp */
  updatedAt?: Date;
}
```

### 2. Repository インターフェース（Phase 2用、参考）

```typescript
/**
 * Repository representation (Phase 2)
 */
export interface Repository {
  /** Unique ID (hash of path) */
  id: string;

  /** Display name */
  name: string;

  /** Absolute path to repository root */
  path: string;

  /** Whether this repository is active */
  enabled: boolean;

  /** Number of worktrees in this repository */
  worktreeCount: number;

  /** Creation timestamp */
  createdAt: Date;

  /** Last updated timestamp */
  updatedAt: Date;
}
```

### 3. WorktreeWithRepository（ビューモデル）

```typescript
/**
 * Grouped worktrees by repository
 */
export interface WorktreesByRepository {
  repositoryPath: string;
  repositoryName: string;
  worktrees: Worktree[];
}
```

## データベース設計

### 1. マイグレーション戦略

#### スキーマバージョン管理

```typescript
// src/lib/db-migrations.ts
export const CURRENT_SCHEMA_VERSION = 2;

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      // 既存のinitDatabase()の内容
    }
  },
  {
    version: 2,
    name: 'add-multi-repo-and-memo',
    up: (db) => {
      // 新しいカラムを追加
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN repository_path TEXT;
        ALTER TABLE worktrees ADD COLUMN repository_name TEXT;
        ALTER TABLE worktrees ADD COLUMN memo TEXT;
        ALTER TABLE worktrees ADD COLUMN last_user_message TEXT;
        ALTER TABLE worktrees ADD COLUMN last_user_message_at INTEGER;
      `);

      // インデックス追加
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktrees_repository
        ON worktrees(repository_path);
      `);

      // 既存データの移行
      migrateExistingWorktrees(db);
    }
  }
];

export function runMigrations(db: Database.Database): void {
  // schema_version テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  // 現在のバージョンを取得
  const current = db.prepare(
    'SELECT MAX(version) as version FROM schema_version'
  ).get() as { version: number | null };

  const currentVersion = current?.version || 0;

  // 未適用のマイグレーションを実行
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      console.log(`Applying migration ${migration.version}: ${migration.name}`);
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
      ).run(migration.version, Date.now());
    }
  }
}
```

#### データ移行ロジック

```typescript
function migrateExistingWorktrees(db: Database.Database): void {
  const worktrees = db.prepare('SELECT id, path FROM worktrees').all() as Array<{
    id: string;
    path: string;
  }>;

  const updateStmt = db.prepare(`
    UPDATE worktrees
    SET repository_path = ?,
        repository_name = ?,
        last_user_message = ?,
        last_user_message_at = ?
    WHERE id = ?
  `);

  for (const wt of worktrees) {
    // リポジトリルートを検索
    const repoPath = findGitRepositoryRoot(wt.path);
    const repoName = repoPath ? path.basename(repoPath) : 'Unknown';

    // 最新のユーザーメッセージを取得
    const latestMsg = db.prepare(`
      SELECT content, timestamp
      FROM chat_messages
      WHERE worktree_id = ? AND role = 'user'
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(wt.id) as { content: string; timestamp: number } | undefined;

    updateStmt.run(
      repoPath || wt.path,
      repoName,
      latestMsg ? truncate(latestMsg.content, 200) : null,
      latestMsg?.timestamp || null,
      wt.id
    );
  }
}

function findGitRepositoryRoot(startPath: string): string | null {
  let current = startPath;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}
```

### 2. 新しいDB関数

```typescript
// src/lib/db.ts に追加

/**
 * Update worktree memo
 */
export function updateWorktreeMemo(
  db: Database.Database,
  worktreeId: string,
  memo: string | null
): void {
  db.prepare(`
    UPDATE worktrees
    SET memo = ?, updated_at = ?
    WHERE id = ?
  `).run(memo, Date.now(), worktreeId);
}

/**
 * Update latest user message cache
 */
export function updateLatestUserMessage(
  db: Database.Database,
  worktreeId: string
): void {
  const latestMsg = db.prepare(`
    SELECT content, timestamp
    FROM chat_messages
    WHERE worktree_id = ? AND role = 'user'
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(worktreeId) as { content: string; timestamp: number } | undefined;

  db.prepare(`
    UPDATE worktrees
    SET last_user_message = ?,
        last_user_message_at = ?
    WHERE id = ?
  `).run(
    latestMsg ? truncate(latestMsg.content, 200) : null,
    latestMsg?.timestamp || null,
    worktreeId
  );
}

/**
 * Get worktrees grouped by repository
 */
export function getWorktreesByRepository(
  db: Database.Database
): WorktreesByRepository[] {
  const worktrees = getWorktrees(db);

  const grouped = new Map<string, Worktree[]>();

  for (const wt of worktrees) {
    const key = wt.repositoryPath;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(wt);
  }

  return Array.from(grouped.entries()).map(([repoPath, wts]) => ({
    repositoryPath: repoPath,
    repositoryName: wts[0]?.repositoryName || path.basename(repoPath),
    worktrees: wts
  }));
}
```

## API設計

### 1. 既存APIの拡張

#### GET /api/worktrees

**変更点:**
- レスポンスにリポジトリ情報を含める
- リポジトリごとのグループ化オプション

```typescript
// src/app/api/worktrees/route.ts

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const grouped = searchParams.get('grouped') === 'true';

  const db = getDatabase();

  if (grouped) {
    const data = getWorktreesByRepository(db);
    return NextResponse.json({ repositories: data });
  } else {
    const worktrees = getWorktrees(db);
    return NextResponse.json({ worktrees });
  }
}
```

**レスポンス例 (grouped=true):**
```json
{
  "repositories": [
    {
      "repositoryPath": "/Users/user/MySwiftAgent",
      "repositoryName": "MySwiftAgent",
      "worktrees": [
        {
          "id": "main",
          "name": "main",
          "path": "/Users/user/MySwiftAgent-worktrees/main",
          "repositoryPath": "/Users/user/MySwiftAgent",
          "repositoryName": "MySwiftAgent",
          "memo": "メインブランチ",
          "lastUserMessage": "新しい機能を追加して",
          "lastUserMessageAt": "2025-11-18T00:00:00Z",
          "updatedAt": "2025-11-18T00:00:00Z"
        }
      ]
    }
  ]
}
```

### 2. 新規API

#### PATCH /api/worktrees/:id

**目的:** メモの更新

```typescript
// src/app/api/worktrees/[id]/route.ts

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { memo } = body;

    // バリデーション
    if (memo !== undefined && memo !== null && typeof memo !== 'string') {
      return NextResponse.json(
        { error: 'Invalid memo format' },
        { status: 400 }
      );
    }

    const db = getDatabase();

    // メモ更新
    updateWorktreeMemo(db, params.id, memo || null);

    // 更新後のworktreeを取得
    const worktree = getWorktreeById(db, params.id);

    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ worktree });
  } catch (error: any) {
    console.error('Failed to update worktree:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
```

**リクエスト例:**
```json
{
  "memo": "Login APIの実装中\n- JWTトークン認証\n- リフレッシュトークンも実装予定"
}
```

**レスポンス:**
```json
{
  "worktree": {
    "id": "feature-login",
    "name": "feature/login",
    "memo": "Login APIの実装中\n- JWTトークン認証\n- リフレッシュトークンも実装予定",
    ...
  }
}
```

## UI/コンポーネント設計

### 1. コンポーネント構造

```
src/
├── app/
│   └── page.tsx                      (変更)
├── components/
│   ├── worktree/
│   │   ├── WorktreeList.tsx          (変更)
│   │   ├── WorktreeCard.tsx          (変更)
│   │   ├── WorktreeDetail.tsx        (変更)
│   │   ├── RepositorySection.tsx     (新規)
│   │   └── MemoEditor.tsx            (新規)
```

### 2. RepositorySection コンポーネント

**責務:**
- リポジトリ名とworktree数を表示
- リポジトリごとにworktreeカードをグループ化

```typescript
// src/components/worktree/RepositorySection.tsx

'use client';

import React from 'react';
import { WorktreeCard } from './WorktreeCard';
import type { Worktree } from '@/types/models';

export interface RepositorySectionProps {
  repositoryName: string;
  repositoryPath: string;
  worktrees: Worktree[];
}

export function RepositorySection({
  repositoryName,
  repositoryPath,
  worktrees
}: RepositorySectionProps) {
  return (
    <div className="mb-8">
      {/* Repository Header */}
      <div className="flex items-center justify-between mb-4 pb-2 border-b-2 border-gray-200">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">
            {repositoryName}
          </h2>
          <p className="text-sm text-gray-500 font-mono truncate">
            {repositoryPath}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">
            {worktrees.length} worktree{worktrees.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Worktree Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {worktrees.map((worktree) => (
          <WorktreeCard key={worktree.id} worktree={worktree} />
        ))}
      </div>
    </div>
  );
}
```

### 3. WorktreeCard 拡張

**変更点:**
- メモのプレビュー表示
- 最新ユーザーメッセージ表示
- 相対時間表示

```typescript
// src/components/worktree/WorktreeCard.tsx (拡張)

'use client';

import React from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { ja } from 'date-fns/locale';
import type { Worktree } from '@/types/models';

export interface WorktreeCardProps {
  worktree: Worktree;
}

export function WorktreeCard({ worktree }: WorktreeCardProps) {
  const messageCount = 0; // TODO: 実際のメッセージ数を取得

  return (
    <Link href={`/worktrees/${worktree.id}`}>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow cursor-pointer">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900 truncate flex-1">
            {worktree.name}
          </h3>
          <div className="flex items-center gap-2 ml-2">
            {/* Live badge (if applicable) */}
            <span className="text-xs text-gray-400">•••</span>
          </div>
        </div>

        {/* Path */}
        <p className="text-xs text-gray-500 font-mono truncate mb-3">
          {worktree.path}
        </p>

        {/* Memo Preview (NEW) */}
        {worktree.memo && (
          <div className="mb-3 p-2 bg-amber-50 border-l-2 border-amber-400 rounded">
            <div className="flex items-start gap-2">
              <span className="text-amber-600 text-sm">📝</span>
              <p className="text-sm text-gray-700 line-clamp-2">
                {worktree.memo}
              </p>
            </div>
          </div>
        )}

        {/* Latest User Message (NEW) */}
        {worktree.lastUserMessage && (
          <div className="mb-3 p-2 bg-blue-50 border-l-2 border-blue-400 rounded">
            <div className="flex items-start gap-2">
              <span className="text-blue-600 text-sm">👤</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-700 line-clamp-2">
                  {worktree.lastUserMessage}
                </p>
                {worktree.lastUserMessageAt && (
                  <p className="text-xs text-gray-500 mt-1">
                    🕐 {formatDistanceToNow(worktree.lastUserMessageAt, {
                      addSuffix: true,
                      locale: ja
                    })}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>💬 {messageCount} messages</span>
        </div>
      </div>
    </Link>
  );
}
```

### 4. MemoEditor コンポーネント

**責務:**
- メモの表示・編集
- 自動保存

```typescript
// src/components/worktree/MemoEditor.tsx

'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui';

export interface MemoEditorProps {
  worktreeId: string;
  initialMemo?: string;
  onSave?: (memo: string) => void;
}

export function MemoEditor({ worktreeId, initialMemo = '', onSave }: MemoEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [memo, setMemo] = useState(initialMemo);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMemo(initialMemo);
  }, [initialMemo]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/worktrees/${worktreeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memo })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save memo');
      }

      setIsEditing(false);
      onSave?.(memo);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setMemo(initialMemo);
    setIsEditing(false);
    setError(null);
  };

  if (!isEditing) {
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-700">Memo</h3>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setIsEditing(true)}
          >
            Edit
          </Button>
        </div>

        {memo ? (
          <div className="p-3 bg-gray-50 border border-gray-200 rounded whitespace-pre-wrap text-sm">
            {memo}
          </div>
        ) : (
          <div className="p-3 bg-gray-50 border border-gray-200 rounded text-sm text-gray-400 italic">
            No memo yet. Click "Edit" to add one.
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-gray-700">Edit Memo</h3>
      </div>

      <textarea
        className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
        rows={6}
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        placeholder="Enter your memo here..."
      />

      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}

      <div className="mt-3 flex gap-2">
        <Button
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          onClick={handleCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

### 5. WorktreeDetail 拡張

```typescript
// src/components/worktree/WorktreeDetail.tsx (拡張部分)

import { MemoEditor } from './MemoEditor';

// ... (既存のコードの中で、サイドバーセクションに追加)

{/* Memo Section (NEW) */}
<Card padding="lg">
  <CardHeader>
    <CardTitle>Memo</CardTitle>
  </CardHeader>
  <CardContent>
    <MemoEditor
      worktreeId={worktreeId}
      initialMemo={worktree?.memo}
      onSave={(newMemo) => {
        // Optional: worktreeステートを更新
        setWorktree(prev => prev ? { ...prev, memo: newMemo } : null);
      }}
    />
  </CardContent>
</Card>
```

## データフロー

### 1. 初期ロード時

```
1. サーバー起動
   ↓
2. マイグレーション実行 (runMigrations)
   ↓
3. 複数リポジトリパスを環境変数から読み込み
   ↓
4. 各リポジトリのworktreeスキャン
   ↓
5. DB に保存（repository_path, repository_name を設定）
   ↓
6. フロントエンドから GET /api/worktrees?grouped=true
   ↓
7. リポジトリごとにグループ化されたデータを返す
```

### 2. メモ編集フロー

```
1. ユーザーが "Edit" ボタンをクリック
   ↓
2. MemoEditor が編集モードに切り替わる
   ↓
3. ユーザーがメモを入力
   ↓
4. "Save" ボタンをクリック
   ↓
5. PATCH /api/worktrees/:id { memo: "..." }
   ↓
6. サーバーが DB を更新
   ↓
7. 更新されたworktreeを返す
   ↓
8. フロントエンドがステートを更新
   ↓
9. メモエディターが閲覧モードに戻る
```

### 3. メッセージ送信時の最新メッセージ更新

```
1. ユーザーがメッセージを送信
   ↓
2. POST /api/worktrees/:id/messages
   ↓
3. メッセージをDBに保存
   ↓
4. updateLatestUserMessage(db, worktreeId) を呼び出し
   ↓
5. worktreesテーブルの last_user_message を更新
   ↓
6. WebSocketで全クライアントに通知
   ↓
7. フロントエンドが一覧を再取得またはステート更新
```

## 技術的検討事項

### 1. パフォーマンス最適化

#### 問題
- 複数リポジトリで大量のworktree（100+）がある場合のスキャン時間

#### 対策
1. **並列スキャン**: Promise.allでリポジトリごとに並列処理
2. **キャッシング**: 前回のスキャン結果をメモリに保持
3. **差分更新**: ファイルシステムの変更を監視して差分のみ更新
4. **ページネーション**: フロントエンドでの表示を分割

```typescript
// 並列スキャン例
async function scanAllRepositories(repoPaths: string[]): Promise<Worktree[]> {
  const results = await Promise.all(
    repoPaths.map(repoPath => scanWorktrees(repoPath))
  );
  return results.flat();
}
```

### 2. リアルタイム更新

#### 要件
- メモ更新時に他のクライアントにも反映
- メッセージ追加時に最新メッセージが即座に更新

#### 実装
```typescript
// WebSocket broadcast拡張
function broadcastWorktreeUpdate(worktreeId: string, type: 'memo' | 'message') {
  const message = {
    type: 'worktree_update',
    worktreeId,
    updateType: type
  };

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}
```

### 3. エラーハンドリング

#### リポジトリパスが存在しない場合
```typescript
function validateRepositoryPaths(paths: string[]): string[] {
  return paths.filter(p => {
    if (!fs.existsSync(p)) {
      console.warn(`Repository path does not exist: ${p}`);
      return false;
    }
    if (!fs.existsSync(path.join(p, '.git'))) {
      console.warn(`Path is not a git repository: ${p}`);
      return false;
    }
    return true;
  });
}
```

### 4. セキュリティ

#### メモのサニタイゼーション
```typescript
// XSS対策
function sanitizeMemo(memo: string): string {
  // 基本的なサニタイズ（必要に応じてライブラリ使用）
  return memo
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim()
    .substring(0, 5000); // 最大5000文字
}
```

## 代替案と選択理由

### 1. 複数リポジトリの管理方法

| 方式 | メリット | デメリット | 選択 |
|------|---------|-----------|------|
| 環境変数 | シンプル、既存コードへの影響小 | 動的変更不可、再起動必要 | ✅ Phase 1 |
| 設定ファイル | 環境変数より管理しやすい | ファイル同期の考慮必要 | ❌ |
| DB管理 | 動的変更可、UI から操作可 | 実装複雑 | ⏳ Phase 2 |

### 2. メモの保存方法

| 方式 | メリット | デメリット | 選択 |
|------|---------|-----------|------|
| DBカラム | シンプル、トランザクション安全 | テーブルが肥大化 | ✅ |
| 別テーブル | 正規化された設計 | JOIN が必要、複雑 | ❌ |
| ファイル | DB負荷なし | 同期問題、バックアップ | ❌ |

### 3. 最新メッセージの取得方法

| 方式 | メリット | デメリット | 選択 |
|------|---------|-----------|------|
| 都度クエリ | データ整合性が高い | パフォーマンス悪い | ❌ |
| 非正規化（キャッシュ） | 高速、一覧表示に最適 | 更新ロジック必要 | ✅ |
| ビュー | SQLレベルで管理 | SQLite のビューは遅い | ❌ |

## まとめ

### Phase 1 実装範囲
1. ✅ 環境変数ベースの複数リポジトリ対応
2. ✅ メモ機能（DB カラム追加）
3. ✅ 最新ユーザーメッセージ表示（非正規化）
4. ✅ UI コンポーネント拡張

### 技術スタック（変更なし）
- Next.js 14 (App Router)
- TypeScript
- SQLite (better-sqlite3)
- Custom Node.js Server
- WebSocket (ws)
- Tailwind CSS

### 次のステップ
1. マイグレーションスクリプトの実装
2. DB関数の拡張
3. API エンドポイントの実装
4. UI コンポーネントの実装
5. テスト

この設計に基づいて実装を進めることで、段階的かつ安全に機能を追加できます。

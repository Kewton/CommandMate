# テスト駆動開発（TDD）ガイド
# myCodeBranchDesk - TDD実践ガイド

**作成日**: 2025-11-17
**対象**: Issue #1 - 初版開発
**アプローチ**: Test-Driven Development (Red-Green-Refactor)

---

## 目次

1. [TDDの基本原則](#tddの基本原則)
2. [開発サイクル](#開発サイクル)
3. [Phase別TDDアプローチ](#phase別tddアプローチ)
4. [テストの種類と範囲](#テストの種類と範囲)
5. [TDD実践例](#tdd実践例)
6. [ツールとセットアップ](#ツールとセットアップ)

---

## TDDの基本原則

### Red-Green-Refactor サイクル

```
🔴 Red: 失敗するテストを書く
    ↓
🟢 Green: テストを通す最小限の実装
    ↓
🔵 Refactor: コードを改善（テストは保持）
    ↓
    繰り返し
```

### TDDの利点

1. **設計の改善**: テスタブルなコードを強制
2. **バグの早期発見**: 実装前に期待動作を定義
3. **リファクタリングの安全性**: テストが安全網として機能
4. **ドキュメント効果**: テストが仕様書の役割
5. **信頼性の向上**: 高いテストカバレッジ

---

## 開発サイクル

### ステップ1: テストを書く（Red）

```typescript
// tests/unit/worktrees.test.ts

import { describe, it, expect } from 'vitest';
import { generateWorktreeId } from '@/lib/worktrees';

describe('generateWorktreeId', () => {
  it('should convert branch name to URL-safe ID', () => {
    // まだ実装していない関数をテスト
    expect(generateWorktreeId('feature/foo')).toBe('feature-foo');
  });

  it('should handle main branch', () => {
    expect(generateWorktreeId('main')).toBe('main');
  });

  it('should handle complex branch names', () => {
    expect(generateWorktreeId('feature/user-auth/v2')).toBe('feature-user-auth-v2');
  });
});
```

テスト実行 → 🔴 **失敗する**（関数がまだ存在しない）

---

### ステップ2: 実装する（Green）

```typescript
// src/lib/worktrees.ts

export function generateWorktreeId(branchName: string): string {
  // テストを通す最小限の実装
  return branchName.replace(/\//g, '-');
}
```

テスト実行 → 🟢 **成功する**

---

### ステップ3: リファクタリング（Refactor）

```typescript
// src/lib/worktrees.ts

/**
 * ブランチ名をURLセーフなIDに変換
 * @param branchName - git ブランチ名
 * @returns URLセーフなID
 * @example
 * generateWorktreeId('feature/foo') // => 'feature-foo'
 */
export function generateWorktreeId(branchName: string): string {
  // より堅牢な実装にリファクタリング
  return branchName
    .replace(/\//g, '-')      // スラッシュをハイフンに
    .replace(/[^a-zA-Z0-9-]/g, '-')  // 特殊文字をハイフンに
    .replace(/-+/g, '-')      // 連続ハイフンを1つに
    .toLowerCase();           // 小文字に統一
}
```

追加テスト:
```typescript
it('should handle special characters', () => {
  expect(generateWorktreeId('feature/foo@bar')).toBe('feature-foo-bar');
});

it('should convert to lowercase', () => {
  expect(generateWorktreeId('Feature/Foo')).toBe('feature-foo');
});
```

テスト実行 → 🟢 **すべて成功**

---

## Phase別TDDアプローチ

### Phase 2: データレイヤー（TDD優先度: 高）

#### 2.1 データベース操作のテスト

```typescript
// tests/unit/db.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase, upsertWorktree, getWorktrees } from '@/lib/db';

describe('Database Operations', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // テスト用のインメモリDB
    testDb = new Database(':memory:');
    initDatabase(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('upsertWorktree', () => {
    it('should insert new worktree', () => {
      const worktree = {
        id: 'main',
        name: 'main',
        path: '/path/to/main',
      };

      upsertWorktree(testDb, worktree);
      const result = getWorktrees(testDb);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject(worktree);
    });

    it('should update existing worktree', () => {
      const worktree = {
        id: 'main',
        name: 'main',
        path: '/path/to/main',
      };

      upsertWorktree(testDb, worktree);
      upsertWorktree(testDb, { ...worktree, name: 'main-updated' });

      const result = getWorktrees(testDb);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('main-updated');
    });
  });

  describe('createMessage', () => {
    it('should create chat message', () => {
      // 先にworktreeを作成
      upsertWorktree(testDb, {
        id: 'main',
        name: 'main',
        path: '/path/to/main',
      });

      const message = createMessage(testDb, {
        worktreeId: 'main',
        role: 'user',
        content: 'Hello',
        timestamp: new Date(),
      });

      expect(message).toHaveProperty('id');
      expect(message.content).toBe('Hello');
    });

    it('should fail if worktree does not exist', () => {
      expect(() => {
        createMessage(testDb, {
          worktreeId: 'nonexistent',
          role: 'user',
          content: 'Hello',
          timestamp: new Date(),
        });
      }).toThrow();
    });
  });
});
```

---

### Phase 3: Worktree管理（TDD優先度: 高）

#### 3.1 git worktree パーサーのテスト

```typescript
// tests/unit/worktrees.test.ts

import { describe, it, expect } from 'vitest';
import { parseWorktreeOutput } from '@/lib/worktrees';

describe('parseWorktreeOutput', () => {
  it('should parse git worktree list output', () => {
    const output = `
/path/to/main        abc123 [main]
/path/to/feature-foo def456 [feature/foo]
/path/to/hotfix-bar  ghi789 [hotfix/bar]
    `.trim();

    const result = parseWorktreeOutput(output);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      path: '/path/to/main',
      branch: 'main',
      commit: 'abc123',
    });
    expect(result[1]).toEqual({
      path: '/path/to/feature-foo',
      branch: 'feature/foo',
      commit: 'def456',
    });
  });

  it('should handle empty output', () => {
    expect(parseWorktreeOutput('')).toEqual([]);
  });

  it('should handle detached HEAD', () => {
    const output = '/path/to/detached abc123 (detached HEAD)';
    const result = parseWorktreeOutput(output);

    expect(result[0].branch).toBe('detached-abc123');
  });
});
```

---

### Phase 4: tmux統合（TDD優先度: 中）

#### 4.1 tmux コマンドラッパーのテスト

```typescript
// tests/unit/tmux.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasSession, createSession, capturePane } from '@/lib/tmux';
import { exec } from 'child_process';

// child_process.exec をモック
vi.mock('child_process');

describe('tmux operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hasSession', () => {
    it('should return true if session exists', async () => {
      // execをモック（成功ケース）
      vi.mocked(exec).mockImplementation((cmd, callback: any) => {
        callback(null, '', '');
        return {} as any;
      });

      const result = await hasSession('cw_main');
      expect(result).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        'tmux has-session -t "cw_main"',
        expect.any(Function)
      );
    });

    it('should return false if session does not exist', async () => {
      // execをモック（失敗ケース）
      vi.mocked(exec).mockImplementation((cmd, callback: any) => {
        callback(new Error('session not found'), '', '');
        return {} as any;
      });

      const result = await hasSession('cw_nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('capturePane', () => {
    it('should capture pane output', async () => {
      const mockOutput = 'line1\nline2\nline3';

      vi.mocked(exec).mockImplementation((cmd, callback: any) => {
        callback(null, mockOutput, '');
        return {} as any;
      });

      const result = await capturePane('cw_main');
      expect(result).toBe(mockOutput);
    });

    it('should capture from specific line', async () => {
      const mockOutput = 'line1\nline2\nline3';

      vi.mocked(exec).mockImplementation((cmd, callback: any) => {
        callback(null, mockOutput, '');
        return {} as any;
      });

      await capturePane('cw_main', 10);

      // コマンドに行番号が含まれることを確認
      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining('10'),
        expect.any(Function)
      );
    });
  });
});
```

**注意**: 実際のtmuxセッション操作は統合テストで検証します。

---

### Phase 5: API Routes（TDD優先度: 高）

#### 5.1 API エンドポイントのテスト

```typescript
// tests/integration/api/worktrees.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { GET } from '@/app/api/worktrees/route';
import { NextRequest } from 'next/server';

describe('GET /api/worktrees', () => {
  beforeEach(async () => {
    // テストDBをリセット
    await resetTestDatabase();
    // テストデータを投入
    await seedTestWorktrees();
  });

  it('should return list of worktrees', async () => {
    const req = new NextRequest('http://localhost:3000/api/worktrees');
    const response = await GET(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.worktrees).toBeInstanceOf(Array);
    expect(data.worktrees.length).toBeGreaterThan(0);
  });

  it('should return worktrees sorted by updatedAt', async () => {
    const req = new NextRequest('http://localhost:3000/api/worktrees');
    const response = await GET(req);
    const data = await response.json();

    const timestamps = data.worktrees.map((w: any) =>
      new Date(w.updatedAt).getTime()
    );

    // 降順であることを確認
    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]);
    }
  });

  it('should require authentication when BIND=0.0.0.0', async () => {
    // 環境変数を一時的に変更
    process.env.MCBD_BIND = '0.0.0.0';
    process.env.MCBD_AUTH_TOKEN = 'test-token';

    const req = new NextRequest('http://localhost:3000/api/worktrees');
    const response = await GET(req);

    expect(response.status).toBe(401);

    // 後片付け
    delete process.env.MCBD_BIND;
    delete process.env.MCBD_AUTH_TOKEN;
  });
});
```

---

### Phase 6: WebSocket（TDD優先度: 中）

#### 6.1 WebSocketサーバーのテスト

```typescript
// tests/unit/ws-server.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { initWebSocketServer, broadcast } from '@/lib/ws-server';
import http from 'http';

describe('WebSocket Server', () => {
  let server: http.Server;
  let wsServer: any;
  let client: WebSocket;

  beforeEach((done) => {
    server = http.createServer();
    wsServer = initWebSocketServer(server);
    server.listen(0, done);
  });

  afterEach((done) => {
    client?.close();
    server.close(done);
  });

  it('should accept client connections', (done) => {
    const port = (server.address() as any).port;
    client = new WebSocket(`ws://localhost:${port}/ws`);

    client.on('open', () => {
      expect(client.readyState).toBe(WebSocket.OPEN);
      done();
    });
  });

  it('should handle subscribe message', (done) => {
    const port = (server.address() as any).port;
    client = new WebSocket(`ws://localhost:${port}/ws`);

    client.on('open', () => {
      client.send(JSON.stringify({
        type: 'subscribe',
        worktreeId: 'main',
      }));

      // サブスクライブ成功を確認
      setTimeout(() => {
        done();
      }, 100);
    });
  });

  it('should broadcast to subscribed clients only', (done) => {
    const port = (server.address() as any).port;
    const client1 = new WebSocket(`ws://localhost:${port}/ws`);
    const client2 = new WebSocket(`ws://localhost:${port}/ws`);

    let client1Received = false;
    let client2Received = false;

    client1.on('open', () => {
      client1.send(JSON.stringify({
        type: 'subscribe',
        worktreeId: 'main',
      }));
    });

    client2.on('open', () => {
      client2.send(JSON.stringify({
        type: 'subscribe',
        worktreeId: 'feature-foo',
      }));
    });

    client1.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'chat_message_created') {
        client1Received = true;
      }
    });

    client2.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'chat_message_created') {
        client2Received = true;
      }
    });

    setTimeout(() => {
      // mainにブロードキャスト
      broadcast('main', {
        type: 'chat_message_created',
        worktreeId: 'main',
        message: { content: 'test' },
      });

      setTimeout(() => {
        expect(client1Received).toBe(true);
        expect(client2Received).toBe(false);

        client1.close();
        client2.close();
        done();
      }, 100);
    }, 100);
  });
});
```

---

## テストの種類と範囲

### 1. ユニットテスト（高優先度）

**対象**:
- `src/lib/db.ts` - データベース操作
- `src/lib/worktrees.ts` - worktree管理
- `src/lib/tmux.ts` - tmuxラッパー（モック使用）
- `src/lib/auth.ts` - 認証ロジック
- ユーティリティ関数

**カバレッジ目標**: 90%以上

**実行**: `npm test`

---

### 2. 統合テスト（中優先度）

**対象**:
- API Routes（Next.js API）
- データベース + ビジネスロジック
- WebSocketサーバー

**カバレッジ目標**: 70%以上

**実行**: `npm run test:integration`

---

### 3. E2Eテスト / 受け入れテスト（Playwright MCP）

**対象**:
- ユーザーフロー全体
- UI操作
- リアルタイム更新

**カバレッジ目標**: 主要フロー100%

**実行**: Playwright MCP経由

---

## TDD実践例

### 例1: Worktree検出機能

#### Step 1: テストを書く（Red）

```typescript
// tests/unit/worktrees.test.ts

describe('scanWorktrees', () => {
  it('should detect worktrees in root directory', async () => {
    const worktrees = await scanWorktrees('/test/root');

    expect(worktrees).toBeInstanceOf(Array);
    expect(worktrees.length).toBeGreaterThan(0);
    expect(worktrees[0]).toHaveProperty('id');
    expect(worktrees[0]).toHaveProperty('name');
    expect(worktrees[0]).toHaveProperty('path');
  });
});
```

実行 → 🔴 失敗（関数が存在しない）

---

#### Step 2: 実装する（Green）

```typescript
// src/lib/worktrees.ts

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function scanWorktrees(rootDir: string): Promise<Worktree[]> {
  const { stdout } = await execAsync('git worktree list', {
    cwd: rootDir,
  });

  return parseWorktreeOutput(stdout).map((wt) => ({
    id: generateWorktreeId(wt.branch),
    name: wt.branch,
    path: wt.path,
  }));
}
```

実行 → 🟢 成功

---

#### Step 3: リファクタリング（Refactor）

```typescript
// src/lib/worktrees.ts

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

/**
 * ルートディレクトリ配下のgit worktreeをスキャン
 */
export async function scanWorktrees(rootDir: string): Promise<Worktree[]> {
  try {
    const { stdout } = await execAsync('git worktree list', {
      cwd: rootDir,
    });

    const parsed = parseWorktreeOutput(stdout);

    return parsed.map((wt) => ({
      id: generateWorktreeId(wt.branch),
      name: wt.branch,
      path: path.resolve(wt.path),  // 絶対パスに正規化
    }));
  } catch (error) {
    // gitリポジトリでない場合は空配列
    if ((error as any).message.includes('not a git repository')) {
      return [];
    }
    throw error;
  }
}
```

追加テスト:
```typescript
it('should return empty array for non-git directory', async () => {
  const worktrees = await scanWorktrees('/tmp');
  expect(worktrees).toEqual([]);
});
```

実行 → 🟢 すべて成功

---

## ツールとセットアップ

### 依存関係のインストール

```bash
# テストフレームワーク
npm install -D vitest @vitest/ui

# テストユーティリティ
npm install -D @testing-library/react @testing-library/jest-dom

# Playwright（受け入れテスト用）
npm install -D @playwright/test

# モック用
npm install -D vitest-mock-extended
```

---

### vitest.config.ts

```typescript
// vitest.config.ts

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.config.{js,ts}',
        '**/types/',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

---

### tests/setup.ts

```typescript
// tests/setup.ts

import { beforeAll, afterAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// グローバルなテスト設定

let testDb: Database.Database;

beforeAll(() => {
  // テスト用のインメモリDBを作成
  testDb = new Database(':memory:');
});

afterEach(() => {
  // 各テスト後にテーブルをクリア
  if (testDb) {
    testDb.exec('DELETE FROM worktrees');
    testDb.exec('DELETE FROM chat_messages');
    testDb.exec('DELETE FROM session_states');
  }
});

afterAll(() => {
  // テスト終了後にDBを閉じる
  if (testDb) {
    testDb.close();
  }
});

// テストヘルパー関数をグローバルにエクスポート
export { testDb };
```

---

### package.json スクリプト

```json
{
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest --coverage",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:watch": "vitest --watch"
  }
}
```

---

## TDD開発フロー

### 日々のワークフロー

1. **朝**: 今日実装する機能を決定
2. **テスト作成**: 失敗するテストを書く（Red）
3. **実装**: テストを通す最小限のコード（Green）
4. **リファクタリング**: コード品質向上（Refactor）
5. **コミット**: テストが通った状態でコミット
6. **繰り返し**

---

### コミットメッセージ例

```
test: Add tests for worktree scanning

feat: Implement worktree scanning functionality

refactor: Improve worktree ID generation logic

test: Add edge cases for tmux session creation
```

---

## ベストプラクティス

### 1. テストは仕様書

テストコードを読めば、関数の期待動作がわかるように書く。

```typescript
// ❌ 悪い例
it('should work', () => {
  expect(generateWorktreeId('feature/foo')).toBe('feature-foo');
});

// ✅ 良い例
it('should convert branch name with slashes to hyphen-separated ID', () => {
  expect(generateWorktreeId('feature/foo')).toBe('feature-foo');
});
```

---

### 2. テストは独立させる

各テストは他のテストに依存しない。

```typescript
// ❌ 悪い例
let sharedState: any;

it('test 1', () => {
  sharedState = { foo: 'bar' };
});

it('test 2', () => {
  expect(sharedState.foo).toBe('bar'); // test 1に依存
});

// ✅ 良い例
it('test 1', () => {
  const state = { foo: 'bar' };
  expect(state.foo).toBe('bar');
});

it('test 2', () => {
  const state = { foo: 'bar' };
  expect(state.foo).toBe('bar');
});
```

---

### 3. AAA パターン

- **Arrange**: テストデータの準備
- **Act**: テスト対象を実行
- **Assert**: 結果を検証

```typescript
it('should create chat message', () => {
  // Arrange
  const message = {
    worktreeId: 'main',
    role: 'user' as const,
    content: 'Hello',
    timestamp: new Date(),
  };

  // Act
  const result = createMessage(testDb, message);

  // Assert
  expect(result).toHaveProperty('id');
  expect(result.content).toBe('Hello');
});
```

---

### 4. モックは最小限に

実際のコードを使えるならモックしない。

```typescript
// ✅ 良い例：インメモリDBを使う
const testDb = new Database(':memory:');

// ❌ 悪い例：DBをモックする（不要）
vi.mock('@/lib/db');
```

---

## まとめ

TDD を実践することで:
- ✅ 高品質なコード
- ✅ 早期バグ発見
- ✅ 安全なリファクタリング
- ✅ 自己文書化
- ✅ 設計の改善

を実現できます。

**次のステップ**: [testing-strategy.md](./testing-strategy.md) でテスト戦略全体を確認してください。

---

**作成者**: Claude (SWE Agent)
**最終更新**: 2025-11-17

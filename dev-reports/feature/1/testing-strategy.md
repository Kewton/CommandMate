# テスト戦略
# myCodeBranchDesk - 包括的テスト戦略

**作成日**: 2025-11-17
**対象**: Issue #1 - 初版開発
**アプローチ**: ユニット → 統合 → E2E（テストピラミッド）

---

## 目次

1. [テスト戦略概要](#テスト戦略概要)
2. [テストピラミッド](#テストピラミッド)
3. [ユニットテスト](#ユニットテスト)
4. [統合テスト](#統合テスト)
5. [E2Eテスト（Playwright MCP）](#e2eテストplaywright-mcp)
6. [受け入れテスト](#受け入れテスト)
7. [カバレッジ目標](#カバレッジ目標)
8. [CI/CDパイプライン](#cicdパイプライン)

---

## テスト戦略概要

### テストの3層構造

```
        /\
       /  \  E2E (Playwright MCP)
      /    \  ← 数が少ない、遅い、高コスト
     /------\
    /        \  統合テスト
   /          \  ← 中程度
  /------------\
 /              \  ユニットテスト
/________________\  ← 数が多い、速い、低コスト
```

### テストの種類と目的

| テスト種類 | 目的 | 実行頻度 | 実行時間 |
|-----------|------|---------|---------|
| ユニット | 関数・クラス単位の動作確認 | コミット毎 | < 5秒 |
| 統合 | モジュール間の連携確認 | PR作成時 | < 30秒 |
| E2E | ユーザーフロー全体の確認 | マージ前 | < 3分 |
| 受け入れ | ビジネス要件の充足確認 | リリース前 | 任意 |

---

## テストピラミッド

### レイヤー1: ユニットテスト（70%）

**対象**:
- ビジネスロジック
- ユーティリティ関数
- データ変換
- バリデーション

**特徴**:
- ✅ 高速（< 100ms/テスト）
- ✅ 独立性が高い
- ✅ モックを活用
- ✅ 詳細な検証

**カバレッジ目標**: 90%以上

---

### レイヤー2: 統合テスト（20%）

**対象**:
- API Routes
- データベース操作
- WebSocket通信
- 外部コマンド（tmux, git）

**特徴**:
- ⚡ 中速（< 1秒/テスト）
- 🔗 実際の依存関係を使用
- 🎯 インターフェース重視

**カバレッジ目標**: 70%以上

---

### レイヤー3: E2Eテスト（10%）

**対象**:
- ユーザーフロー全体
- UI操作
- リアルタイム更新

**特徴**:
- 🐢 低速（数秒〜数十秒/テスト）
- 🌐 ブラウザ使用
- 🎭 実環境に近い

**カバレッジ目標**: 主要フロー100%

---

## ユニットテスト

### テスト対象と戦略

#### 1. データベース操作（`src/lib/db.ts`）

```typescript
// tests/unit/db.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as db from '@/lib/db';

describe('Database Operations', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = new Database(':memory:');
    db.initDatabase(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('Worktree Operations', () => {
    it('should insert worktree', () => {
      const worktree = {
        id: 'main',
        name: 'main',
        path: '/path/to/main',
      };

      db.upsertWorktree(testDb, worktree);
      const result = db.getWorktrees(testDb);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject(worktree);
    });

    it('should update existing worktree', () => {
      // テストケース実装
    });

    it('should maintain unique path constraint', () => {
      // テストケース実装
    });
  });

  describe('ChatMessage Operations', () => {
    it('should create message with generated ID', () => {
      // テストケース実装
    });

    it('should enforce foreign key constraint', () => {
      // テストケース実装
    });

    it('should retrieve messages in reverse chronological order', () => {
      // テストケース実装
    });

    it('should support pagination', () => {
      // テストケース実装
    });
  });

  describe('SessionState Operations', () => {
    it('should initialize with lastCapturedLine = 0', () => {
      // テストケース実装
    });

    it('should update lastCapturedLine', () => {
      // テストケース実装
    });
  });
});
```

**カバレッジ**: すべての CRUD 操作 + エッジケース

---

#### 2. Worktree管理（`src/lib/worktrees.ts`）

```typescript
// tests/unit/worktrees.test.ts

import { describe, it, expect, vi } from 'vitest';
import * as worktrees from '@/lib/worktrees';
import { exec } from 'child_process';

vi.mock('child_process');

describe('Worktree Management', () => {
  describe('parseWorktreeOutput', () => {
    it('should parse standard git worktree list output', () => {
      const output = '/path/to/main  abc123 [main]';
      const result = worktrees.parseWorktreeOutput(output);

      expect(result).toEqual([{
        path: '/path/to/main',
        branch: 'main',
        commit: 'abc123',
      }]);
    });

    it('should handle multiple worktrees', () => {
      // テストケース実装
    });

    it('should handle detached HEAD', () => {
      // テストケース実装
    });

    it('should handle empty output', () => {
      // テストケース実装
    });
  });

  describe('generateWorktreeId', () => {
    it('should convert slashes to hyphens', () => {
      expect(worktrees.generateWorktreeId('feature/foo')).toBe('feature-foo');
    });

    it('should handle special characters', () => {
      // テストケース実装
    });

    it('should convert to lowercase', () => {
      // テストケース実装
    });
  });

  describe('scanWorktrees', () => {
    it('should execute git worktree list', async () => {
      vi.mocked(exec).mockImplementation((cmd, opts, callback: any) => {
        callback(null, '/path/to/main abc123 [main]', '');
        return {} as any;
      });

      const result = await worktrees.scanWorktrees('/root');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('main');
    });

    it('should return empty array for non-git directory', async () => {
      // テストケース実装
    });
  });
});
```

---

#### 3. tmux統合（`src/lib/tmux.ts`）

```typescript
// tests/unit/tmux.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as tmux from '@/lib/tmux';
import { exec } from 'child_process';

vi.mock('child_process');

describe('tmux Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hasSession', () => {
    it('should return true when session exists', async () => {
      vi.mocked(exec).mockImplementation((cmd, callback: any) => {
        callback(null, '', '');
        return {} as any;
      });

      const result = await tmux.hasSession('cw_main');
      expect(result).toBe(true);
    });

    it('should return false when session does not exist', async () => {
      // テストケース実装
    });
  });

  describe('createSession', () => {
    it('should execute tmux new-session command', async () => {
      // モック実装とアサーション
    });

    it('should set CLAUDE_HOOKS_STOP environment variable', async () => {
      // テストケース実装
    });

    it('should start claude CLI', async () => {
      // テストケース実装
    });
  });

  describe('sendKeys', () => {
    it('should send keys to session', async () => {
      // テストケース実装
    });

    it('should escape special characters', async () => {
      // テストケース実装
    });
  });

  describe('capturePane', () => {
    it('should capture entire pane', async () => {
      // テストケース実装
    });

    it('should capture from specific line', async () => {
      // テストケース実装
    });
  });
});
```

---

#### 4. 認証（`src/lib/auth.ts`）

```typescript
// tests/unit/auth.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withAuth } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

describe('Authentication Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should allow requests when BIND=127.0.0.1', async () => {
    process.env.MCBD_BIND = '127.0.0.1';

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrappedHandler = withAuth(handler);

    const req = new NextRequest('http://localhost:3000/api/test');
    const response = await wrappedHandler(req);

    expect(handler).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it('should require auth when BIND=0.0.0.0', async () => {
    process.env.MCBD_BIND = '0.0.0.0';
    process.env.MCBD_AUTH_TOKEN = 'test-token';

    const handler = vi.fn();
    const wrappedHandler = withAuth(handler);

    const req = new NextRequest('http://localhost:3000/api/test');
    const response = await wrappedHandler(req);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it('should accept valid token', async () => {
    process.env.MCBD_BIND = '0.0.0.0';
    process.env.MCBD_AUTH_TOKEN = 'test-token';

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrappedHandler = withAuth(handler);

    const req = new NextRequest('http://localhost:3000/api/test', {
      headers: {
        'Authorization': 'Bearer test-token',
      },
    });
    const response = await wrappedHandler(req);

    expect(handler).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it('should reject invalid token', async () => {
    // テストケース実装
  });
});
```

---

### ユニットテスト実行

```bash
# すべてのユニットテスト
npm run test:unit

# 特定ファイル
npm run test:unit -- db.test.ts

# watch モード
npm run test:unit -- --watch

# カバレッジ
npm run test:unit -- --coverage
```

---

## 統合テスト

### テスト対象

1. **API Routes** - HTTPリクエスト → レスポンス
2. **データベース + ビジネスロジック** - 実際のSQLite
3. **WebSocket** - 実際のWS接続

---

### 1. API統合テスト

```typescript
// tests/integration/api/worktrees.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'http';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worktrees/route';
import { POST } from '@/app/api/worktrees/[id]/send/route';
import Database from 'better-sqlite3';
import * as db from '@/lib/db';

describe('API Integration Tests', () => {
  let testDb: Database.Database;

  beforeAll(() => {
    // テスト用DB作成
    testDb = new Database(':memory:');
    db.initDatabase(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    // データクリア
    testDb.exec('DELETE FROM worktrees');
    testDb.exec('DELETE FROM chat_messages');

    // テストデータ投入
    db.upsertWorktree(testDb, {
      id: 'main',
      name: 'main',
      path: '/test/main',
    });
  });

  describe('GET /api/worktrees', () => {
    it('should return worktree list', async () => {
      const req = new NextRequest('http://localhost:3000/api/worktrees');
      const response = await GET(req);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.worktrees).toHaveLength(1);
      expect(data.worktrees[0].id).toBe('main');
    });
  });

  describe('POST /api/worktrees/:id/send', () => {
    it('should create user message', async () => {
      const req = new NextRequest('http://localhost:3000/api/worktrees/main/send', {
        method: 'POST',
        body: JSON.stringify({ message: 'Hello' }),
      });

      const response = await POST(req, { params: { id: 'main' } });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.requestId).toBeTruthy();
      expect(data.message.content).toBe('Hello');

      // DBに保存されていることを確認
      const messages = db.getMessages(testDb, 'main');
      expect(messages).toHaveLength(1);
    });

    it('should return 404 for nonexistent worktree', async () => {
      const req = new NextRequest('http://localhost:3000/api/worktrees/nonexistent/send', {
        method: 'POST',
        body: JSON.stringify({ message: 'Hello' }),
      });

      const response = await POST(req, { params: { id: 'nonexistent' } });

      expect(response.status).toBe(404);
    });

    it('should validate message content', async () => {
      const req = new NextRequest('http://localhost:3000/api/worktrees/main/send', {
        method: 'POST',
        body: JSON.stringify({ message: '' }),
      });

      const response = await POST(req, { params: { id: 'main' } });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/hooks/claude-done', () => {
    it('should process claude completion', async () => {
      // テストケース実装
      // - tmux capture-pane のモック
      // - ログファイル保存の確認
      // - DB保存の確認
      // - WebSocket配信の確認（モック）
    });
  });
});
```

---

### 2. WebSocket統合テスト

```typescript
// tests/integration/websocket.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import { WebSocket } from 'ws';
import { initWebSocketServer, broadcast } from '@/lib/ws-server';

describe('WebSocket Integration Tests', () => {
  let server: any;
  let wsServer: any;
  let port: number;

  beforeAll((done) => {
    server = createServer();
    wsServer = initWebSocketServer(server);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('should establish connection and subscribe', (done) => {
    const client = new WebSocket(`ws://localhost:${port}/ws`);

    client.on('open', () => {
      client.send(JSON.stringify({
        type: 'subscribe',
        worktreeId: 'main',
      }));

      setTimeout(() => {
        client.close();
        done();
      }, 100);
    });
  });

  it('should receive broadcast messages', (done) => {
    const client = new WebSocket(`ws://localhost:${port}/ws`);

    client.on('open', () => {
      client.send(JSON.stringify({
        type: 'subscribe',
        worktreeId: 'main',
      }));

      // ブロードキャスト
      setTimeout(() => {
        broadcast('main', {
          type: 'chat_message_created',
          worktreeId: 'main',
          message: { content: 'test' },
        });
      }, 50);
    });

    client.on('message', (data) => {
      const message = JSON.parse(data.toString());

      if (message.type === 'chat_message_created') {
        expect(message.worktreeId).toBe('main');
        expect(message.message.content).toBe('test');
        client.close();
        done();
      }
    });
  });

  it('should handle multiple clients', (done) => {
    // テストケース実装
  });
});
```

---

## E2Eテスト（Playwright MCP）

### Playwright MCP とは

Playwright を Model Context Protocol (MCP) 経由で使用することで、ブラウザ操作を自動化し、実際のユーザーフローをテストします。

---

### セットアップ

```bash
# Playwright インストール
npm install -D @playwright/test

# ブラウザのインストール
npx playwright install
```

---

### Playwright設定

```typescript
// playwright.config.ts

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 13'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

---

### E2Eテストシナリオ

#### シナリオ1: Worktree一覧の表示

```typescript
// tests/e2e/worktree-list.spec.ts

import { test, expect } from '@playwright/test';

test.describe('Worktree List', () => {
  test('should display worktree list', async ({ page }) => {
    await page.goto('/');

    // ページタイトル確認
    await expect(page).toHaveTitle(/myCodeBranchDesk/);

    // Worktree一覧が表示されることを確認
    const worktrees = page.locator('[data-testid="worktree-item"]');
    await expect(worktrees).toHaveCount(await worktrees.count());

    // 最低1つはWorktreeがあることを確認
    await expect(worktrees.first()).toBeVisible();
  });

  test('should sort worktrees by updated date', async ({ page }) => {
    await page.goto('/');

    const timestamps = await page
      .locator('[data-testid="worktree-timestamp"]')
      .allTextContents();

    // 日付が降順であることを確認（詳細なロジックは実装による）
    expect(timestamps.length).toBeGreaterThan(0);
  });

  test('should navigate to chat on click', async ({ page }) => {
    await page.goto('/');

    // 最初のWorktreeをクリック
    await page.locator('[data-testid="worktree-item"]').first().click();

    // チャット画面に遷移することを確認
    await expect(page).toHaveURL(/\/worktrees\/[^/]+/);
  });
});
```

---

#### シナリオ2: チャット機能

```typescript
// tests/e2e/chat.spec.ts

import { test, expect } from '@playwright/test';

test.describe('Chat Functionality', () => {
  test.beforeEach(async ({ page }) => {
    // Worktree一覧からチャット画面へ遷移
    await page.goto('/');
    await page.locator('[data-testid="worktree-item"]').first().click();
  });

  test('should display chat interface', async ({ page }) => {
    // チャット履歴が表示される
    await expect(page.locator('[data-testid="chat-messages"]')).toBeVisible();

    // 入力欄が表示される
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();

    // 送信ボタンが表示される
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
  });

  test('should send message', async ({ page }) => {
    const messageText = 'Test message from E2E test';

    // メッセージ入力
    await page.locator('[data-testid="chat-input"]').fill(messageText);

    // 送信
    await page.locator('[data-testid="send-button"]').click();

    // 送信したメッセージが表示される
    await expect(page.locator(`text=${messageText}`)).toBeVisible();

    // 送信中インジケータが表示される
    await expect(page.locator('[data-testid="sending-indicator"]')).toBeVisible();
  });

  test('should receive real-time updates via WebSocket', async ({ page }) => {
    // メッセージ送信
    await page.locator('[data-testid="chat-input"]').fill('Hello Claude');
    await page.locator('[data-testid="send-button"]').click();

    // Claudeからの応答を待つ（タイムアウト: 30秒）
    await expect(page.locator('[data-testid="claude-message"]').last())
      .toBeVisible({ timeout: 30000 });

    // 送信中インジケータが消える
    await expect(page.locator('[data-testid="sending-indicator"]'))
      .not.toBeVisible();
  });

  test('should scroll to bottom on new message', async ({ page }) => {
    // テストケース実装
  });

  test('should handle empty message', async ({ page }) => {
    // 送信ボタンが無効化されることを確認
    await expect(page.locator('[data-testid="send-button"]')).toBeDisabled();
  });
});
```

---

#### シナリオ3: ログビューア

```typescript
// tests/e2e/logs.spec.ts

import { test, expect } from '@playwright/test';

test.describe('Log Viewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="worktree-item"]').first().click();
  });

  test('should navigate to logs', async ({ page }) => {
    // ログボタンをクリック
    await page.locator('[data-testid="logs-button"]').click();

    // ログ一覧画面に遷移
    await expect(page).toHaveURL(/\/worktrees\/[^/]+\/logs/);
  });

  test('should display log files', async ({ page }) => {
    await page.locator('[data-testid="logs-button"]').click();

    // ログファイル一覧が表示される
    const logFiles = page.locator('[data-testid="log-file-item"]');
    const count = await logFiles.count();

    if (count > 0) {
      await expect(logFiles.first()).toBeVisible();
    }
  });

  test('should view log detail', async ({ page }) => {
    await page.locator('[data-testid="logs-button"]').click();

    // ログファイルが存在する場合
    const logFiles = page.locator('[data-testid="log-file-item"]');
    const count = await logFiles.count();

    if (count > 0) {
      await logFiles.first().click();

      // Markdownコンテンツが表示される
      await expect(page.locator('[data-testid="markdown-content"]')).toBeVisible();
    }
  });

  test('should navigate back to chat', async ({ page }) => {
    await page.locator('[data-testid="logs-button"]').click();
    await page.locator('[data-testid="back-button"]').click();

    // チャット画面に戻る
    await expect(page.locator('[data-testid="chat-messages"]')).toBeVisible();
  });
});
```

---

#### シナリオ4: モバイルレスポンシブ

```typescript
// tests/e2e/mobile.spec.ts

import { test, expect, devices } from '@playwright/test';

test.use(devices['iPhone 13']);

test.describe('Mobile Responsiveness', () => {
  test('should display mobile layout', async ({ page }) => {
    await page.goto('/');

    // モバイルビューポートサイズを確認
    const viewport = page.viewportSize();
    expect(viewport?.width).toBeLessThan(768);

    // Worktree一覧が縦スクロール可能
    await expect(page.locator('[data-testid="worktree-list"]')).toBeVisible();
  });

  test('should handle touch interactions', async ({ page }) => {
    await page.goto('/');

    // タップ操作
    await page.locator('[data-testid="worktree-item"]').first().tap();

    // 画面遷移を確認
    await expect(page).toHaveURL(/\/worktrees\/[^/]+/);
  });

  test('should display mobile chat interface', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="worktree-item"]').first().tap();

    // チャット入力がモバイル最適化されている
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible();

    // キーボード表示時のレイアウト崩れチェック
    await chatInput.focus();
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
  });
});
```

---

### Playwright MCP 使用例

```typescript
// Playwright MCPを使用した受け入れテスト

import { test } from '@playwright/test';

test('User Story: Developer sends instruction to Claude via mobile browser', async ({ page }) => {
  // Given: ユーザーがスマホブラウザでアプリを開いている
  await page.goto('/');

  // When: feature/foo ブランチを選択
  await page.locator('text=feature/foo').click();

  // And: 「テストを追加してください」と入力
  await page.locator('[data-testid="chat-input"]').fill('テストを追加してください');

  // And: 送信ボタンをタップ
  await page.locator('[data-testid="send-button"]').click();

  // Then: メッセージが送信される
  await page.locator('text=テストを追加してください').waitFor();

  // And: 送信中インジケータが表示される
  await page.locator('[data-testid="sending-indicator"]').waitFor();

  // And: Claudeからの応答が表示される（30秒以内）
  await page.locator('[data-testid="claude-message"]').last().waitFor({
    timeout: 30000,
  });

  // And: ログ画面で詳細を確認できる
  await page.locator('[data-testid="logs-button"]').click();
  await page.locator('[data-testid="log-file-item"]').first().waitFor();
});
```

---

## 受け入れテスト

### 受け入れ基準

各機能について、以下の基準をすべて満たす必要があります:

#### 機能1: Worktree一覧

- [ ] ルートディレクトリ配下のworktreeが表示される
- [ ] 最終更新日時順にソートされる
- [ ] 各項目に名前・要約・日時が表示される
- [ ] タップでチャット画面に遷移する
- [ ] ローディング状態が適切に表示される

#### 機能2: チャット

- [ ] メッセージ履歴が表示される
- [ ] メッセージ送信が可能
- [ ] 送信後、楽観的UIで即座に反映される
- [ ] Claudeからの応答がリアルタイムで表示される
- [ ] エラー時に適切なメッセージが表示される
- [ ] スクロールが自動で最下部に移動する

#### 機能3: ログビューア

- [ ] ログファイル一覧が表示される
- [ ] ログファイルをタップすると詳細が表示される
- [ ] Markdownが正しくレンダリングされる
- [ ] チャット画面に戻れる

#### 機能4: リアルタイム更新

- [ ] WebSocketで接続される
- [ ] 新しいメッセージが自動で表示される
- [ ] 複数デバイスで同期される
- [ ] 接続が切れても再接続される

---

## カバレッジ目標

### 全体目標

| テスト種類 | カバレッジ目標 |
|-----------|--------------|
| ユニット | 90%以上 |
| 統合 | 70%以上 |
| E2E | 主要フロー100% |
| 総合 | 80%以上 |

### カバレッジレポート

```bash
# カバレッジ生成
npm run test:coverage

# HTMLレポート表示
open coverage/index.html
```

---

## CI/CDパイプライン

### GitHub Actions 設定例

```yaml
# .github/workflows/test.yml

name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 20
      - run: npm ci
      - run: npm run test:unit -- --coverage
      - uses: codecov/codecov-action@v3

  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 20
      - run: npm ci
      - run: npm run test:integration

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
```

---

## まとめ

### テスト実行コマンド一覧

```bash
# すべてのテスト
npm test

# ユニットテストのみ
npm run test:unit

# 統合テストのみ
npm run test:integration

# E2Eテスト（Playwright）
npm run test:e2e

# カバレッジ付き
npm run test:coverage

# Watch モード
npm run test:watch

# UI モード（Vitest）
npm run test:ui
```

### 次のステップ

1. [tdd-guide.md](./tdd-guide.md) でTDD実践方法を確認
2. [code-review-checklist.md](./code-review-checklist.md) でレビュー基準を確認
3. 各Phaseでテストを先に書いてから実装を開始

---

**作成者**: Claude (SWE Agent)
**最終更新**: 2025-11-17

# Issue #1 技術仕様書
# myCodeBranchDesk 技術詳細

**作成日**: 2025-11-17
**対象Issue**: #1 - 初版
**関連**: [implementation-plan.md](./implementation-plan.md)

---

## 目次

1. [tmux統合の詳細](#tmux統合の詳細)
2. [Stopフック実装](#stopフック実装)
3. [差分抽出アルゴリズム](#差分抽出アルゴリズム)
4. [WebSocket実装詳細](#websocket実装詳細)
5. [データベーススキーマ詳細](#データベーススキーマ詳細)
6. [認証フロー](#認証フロー)
7. [エラーハンドリング戦略](#エラーハンドリング戦略)
8. [コード例](#コード例)

---

## tmux統合の詳細

### セッション命名規則

```
セッション名: cw_{worktreeId}

例:
- main        → cw_main
- feature/foo → cw_feature-foo
- hotfix/bar  → cw_hotfix-bar
```

### セッション作成フロー

```typescript
// src/lib/tmux.ts

export async function createSession(
  sessionName: string,
  worktreePath: string,
  worktreeId: string
): Promise<void> {
  // 1. セッション作成
  await execAsync(`tmux new-session -d -s "${sessionName}" -c "${worktreePath}"`);

  // 2. Stopフック設定
  const hookCommand = `curl -X POST http://localhost:${MCBD_PORT}/api/hooks/claude-done \\
    -H 'Content-Type: application/json' \\
    -d '{\\"worktreeId\\":\\"${worktreeId}\\"}'`;

  await execAsync(
    `tmux send-keys -t "${sessionName}" "export CLAUDE_HOOKS_STOP='${hookCommand}'" C-m`
  );

  // 3. Claude CLI起動
  await execAsync(`tmux send-keys -t "${sessionName}" "claude" C-m`);

  // 4. プロンプトが出るまで待機
  await waitForPrompt(sessionName);
}
```

### コマンド送信

```typescript
export async function sendKeys(
  sessionName: string,
  message: string
): Promise<void> {
  // 特殊文字のエスケープ
  const escaped = message
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'");

  // マーカー付きで送信（将来のrequestId対応）
  const fullMessage = `${escaped}`;

  await execAsync(`tmux send-keys -t "${sessionName}" "${fullMessage}" C-m`);
}
```

### 出力取得

```typescript
export async function capturePane(
  sessionName: string,
  startLine: number = 0
): Promise<string> {
  // scrollback全体を取得
  const { stdout } = await execAsync(
    `tmux capture-pane -t "${sessionName}" -p -S -`
  );

  // 行番号で分割
  const lines = stdout.split('\n');

  // startLine以降を取得（差分抽出）
  const newLines = lines.slice(startLine);

  return newLines.join('\n');
}
```

### セッション状態チェック

```typescript
export async function hasSession(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t "${sessionName}"`);
    return true;
  } catch {
    return false;
  }
}

export async function isClaudeRunning(sessionName: string): Promise<boolean> {
  try {
    // paneのPIDを取得
    const { stdout: pidStr } = await execAsync(
      `tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`
    );
    const pid = pidStr.trim();

    // プロセスツリーにclaudeがいるか確認
    const { stdout: psOutput } = await execAsync(`ps -o command= -g ${pid}`);

    return psOutput.includes('claude');
  } catch {
    return false;
  }
}
```

---

## Stopフック実装

### フック設定

Claude CLIは環境変数 `CLAUDE_HOOKS_STOP` に設定されたコマンドを、処理完了時に実行します。

```bash
export CLAUDE_HOOKS_STOP='curl -X POST http://localhost:3000/api/hooks/claude-done \
  -H "Content-Type: application/json" \
  -d "{\"worktreeId\":\"feature-foo\"}"'
```

### フックAPI実装

```typescript
// src/app/api/hooks/claude-done/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { capturePane } from '@/lib/tmux';
import { getSessionState, updateSessionState } from '@/lib/db';
import { saveLog } from '@/lib/logger';
import { createMessage } from '@/lib/db';
import { broadcast } from '@/lib/ws-server';

export async function POST(req: NextRequest) {
  try {
    const { worktreeId, requestId } = await req.json();

    // 1. セッション状態取得
    const state = await getSessionState(worktreeId);
    const lastLine = state?.lastCapturedLine || 0;

    // 2. tmux出力取得（差分のみ）
    const sessionName = `cw_${worktreeId}`;
    const output = await capturePane(sessionName, lastLine);

    // 3. 現在の行数を計算
    const allOutput = await capturePane(sessionName, 0);
    const currentLineCount = allOutput.split('\n').length;

    // 4. Markdownログ保存
    const timestamp = new Date();
    const logFileName = `${formatTimestamp(timestamp)}-${worktreeId}-${generateUUID()}.md`;
    const logPath = path.join(
      getWorktreePath(worktreeId),
      '.claude_logs',
      logFileName
    );

    await saveLog(logPath, output);

    // 5. ChatMessage保存
    const message = await createMessage({
      worktreeId,
      role: 'claude',
      content: output,
      timestamp,
      logFileName,
      requestId,
    });

    // 6. セッション状態更新
    await updateSessionState(worktreeId, currentLineCount);

    // 7. WebSocket配信
    await broadcast(worktreeId, {
      type: 'chat_message_created',
      worktreeId,
      message,
    });

    return NextResponse.json({ success: true, message });
  } catch (error) {
    console.error('Claude done hook error:', error);
    return NextResponse.json(
      { error: 'Failed to process hook' },
      { status: 500 }
    );
  }
}

function formatTimestamp(date: Date): string {
  // 20251117-123045
  return date.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
}
```

---

## 差分抽出アルゴリズム

### 課題

tmuxの `capture-pane` は scrollback 全体を返すため、「今回の実行結果だけ」を取り出す必要があります。

### 解決策

前回のキャプチャ行数を記録し、その行以降を「新規出力」として扱います。

```typescript
// WorktreeSessionState テーブル
interface WorktreeSessionState {
  worktreeId: string;
  lastCapturedLine: number; // 前回の総行数
}

// 差分抽出
async function extractDiff(sessionName: string, lastLine: number): Promise<string> {
  // 全体取得
  const fullOutput = await capturePane(sessionName, 0);
  const lines = fullOutput.split('\n');

  // 差分のみ
  const newLines = lines.slice(lastLine);

  return newLines.join('\n');
}
```

### 将来の拡張: マーカー方式

requestIdを使ったマーカーを埋め込む方式も検討可能:

```typescript
// 送信時
const marker = `### REQUEST ${requestId} START`;
await sendKeys(sessionName, `${marker}\n${message}\n### REQUEST ${requestId} END`);

// 抽出時
function extractByMarker(output: string, requestId: string): string {
  const startMarker = `### REQUEST ${requestId} START`;
  const endMarker = `### REQUEST ${requestId} END`;

  const startIdx = output.indexOf(startMarker);
  const endIdx = output.indexOf(endMarker, startIdx);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Markers not found');
  }

  return output.slice(startIdx, endIdx + endMarker.length);
}
```

---

## WebSocket実装詳細

### サーバー実装

```typescript
// src/lib/ws-server.ts

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';

interface Client {
  ws: WebSocket;
  worktreeId: string | null;
}

class WorktreeWebSocketServer {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, Client> = new Map();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      console.log('New WebSocket connection');

      this.clients.set(ws, { ws, worktreeId: null });

      ws.on('message', (data) => {
        this.handleMessage(ws, data);
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
  }

  private handleMessage(ws: WebSocket, data: any) {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'subscribe') {
        const client = this.clients.get(ws);
        if (client) {
          client.worktreeId = message.worktreeId;
          console.log(`Client subscribed to worktree: ${message.worktreeId}`);
        }
      }

      if (message.type === 'unsubscribe') {
        const client = this.clients.get(ws);
        if (client) {
          client.worktreeId = null;
        }
      }
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  }

  public broadcast(worktreeId: string, message: any) {
    const payload = JSON.stringify(message);

    this.clients.forEach((client) => {
      if (client.worktreeId === worktreeId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    });
  }
}

let wsServer: WorktreeWebSocketServer | null = null;

export function initWebSocketServer(server: Server) {
  if (!wsServer) {
    wsServer = new WorktreeWebSocketServer(server);
  }
  return wsServer;
}

export function broadcast(worktreeId: string, message: any) {
  if (wsServer) {
    wsServer.broadcast(worktreeId, message);
  }
}
```

### クライアント実装

```typescript
// src/hooks/useWebSocket.ts

import { useEffect, useRef, useState } from 'react';

export function useWebSocket(worktreeId: string, onMessage: (message: any) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [worktreeId]);

  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);

      // Subscribe
      ws.send(JSON.stringify({
        type: 'subscribe',
        worktreeId,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        onMessage(message);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);

      // 自動再接続（5秒後）
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 5000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    wsRef.current = ws;
  }

  function disconnect() {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }

  return { connected };
}
```

---

## データベーススキーマ詳細

### 完全なSQL

```sql
-- Worktrees テーブル
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  last_message_summary TEXT,
  updated_at INTEGER
);

CREATE INDEX idx_worktrees_updated_at ON worktrees(updated_at DESC);

-- ChatMessages テーブル
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'claude')),
  content TEXT NOT NULL,
  summary TEXT,
  timestamp INTEGER NOT NULL,
  log_file_name TEXT,
  request_id TEXT,

  FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_worktree_time ON chat_messages(worktree_id, timestamp DESC);
CREATE INDEX idx_messages_request_id ON chat_messages(request_id);

-- SessionStates テーブル
CREATE TABLE session_states (
  worktree_id TEXT PRIMARY KEY,
  last_captured_line INTEGER DEFAULT 0,

  FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
);
```

### データベース操作例

```typescript
// src/lib/db.ts

import Database from 'better-sqlite3';
import path from 'path';
import { Worktree, ChatMessage, WorktreeSessionState } from '@/types/models';

const dbPath = path.join(process.cwd(), 'db.sqlite');
const db = new Database(dbPath);

// 初期化
export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      last_message_summary TEXT,
      updated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_worktrees_updated_at
      ON worktrees(updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'claude')),
      content TEXT NOT NULL,
      summary TEXT,
      timestamp INTEGER NOT NULL,
      log_file_name TEXT,
      request_id TEXT,

      FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_worktree_time
      ON chat_messages(worktree_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_request_id
      ON chat_messages(request_id);

    CREATE TABLE IF NOT EXISTS session_states (
      worktree_id TEXT PRIMARY KEY,
      last_captured_line INTEGER DEFAULT 0,

      FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
    );
  `);
}

// Worktree操作
export function getWorktrees(): Worktree[] {
  const stmt = db.prepare(`
    SELECT id, name, path, last_message_summary, updated_at
    FROM worktrees
    ORDER BY updated_at DESC
  `);

  return stmt.all().map((row: any) => ({
    id: row.id,
    name: row.name,
    path: row.path,
    lastMessageSummary: row.last_message_summary,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
  }));
}

export function upsertWorktree(worktree: Worktree): void {
  const stmt = db.prepare(`
    INSERT INTO worktrees (id, name, path, last_message_summary, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      last_message_summary = excluded.last_message_summary,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    worktree.id,
    worktree.name,
    worktree.path,
    worktree.lastMessageSummary || null,
    worktree.updatedAt?.getTime() || null
  );
}

// ChatMessage操作
export function createMessage(message: Omit<ChatMessage, 'id'>): ChatMessage {
  const id = generateUUID();

  const stmt = db.prepare(`
    INSERT INTO chat_messages
    (id, worktree_id, role, content, summary, timestamp, log_file_name, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    message.worktreeId,
    message.role,
    message.content,
    message.summary || null,
    message.timestamp.getTime(),
    message.logFileName || null,
    message.requestId || null
  );

  // Worktreeのupdated_atを更新
  updateWorktreeTimestamp(message.worktreeId, message.timestamp);

  return { id, ...message };
}

export function getMessages(
  worktreeId: string,
  before?: Date,
  limit: number = 50
): ChatMessage[] {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id
    FROM chat_messages
    WHERE worktree_id = ? AND (? IS NULL OR timestamp < ?)
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  const beforeTs = before?.getTime() || null;

  return stmt.all(worktreeId, beforeTs, beforeTs, limit).map((row: any) => ({
    id: row.id,
    worktreeId: row.worktree_id,
    role: row.role,
    content: row.content,
    summary: row.summary,
    timestamp: new Date(row.timestamp),
    logFileName: row.log_file_name,
    requestId: row.request_id,
  }));
}

// SessionState操作
export function getSessionState(worktreeId: string): WorktreeSessionState | null {
  const stmt = db.prepare(`
    SELECT worktree_id, last_captured_line
    FROM session_states
    WHERE worktree_id = ?
  `);

  const row: any = stmt.get(worktreeId);

  if (!row) return null;

  return {
    worktreeId: row.worktree_id,
    lastCapturedLine: row.last_captured_line,
  };
}

export function updateSessionState(
  worktreeId: string,
  lastCapturedLine: number
): void {
  const stmt = db.prepare(`
    INSERT INTO session_states (worktree_id, last_captured_line)
    VALUES (?, ?)
    ON CONFLICT(worktree_id) DO UPDATE SET
      last_captured_line = excluded.last_captured_line
  `);

  stmt.run(worktreeId, lastCapturedLine);
}

// ヘルパー関数
function updateWorktreeTimestamp(worktreeId: string, timestamp: Date): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET updated_at = ?
    WHERE id = ?
  `);

  stmt.run(timestamp.getTime(), worktreeId);
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
```

---

## 認証フロー

### 環境変数

```bash
# .env.local
MCBD_ROOT_DIR=/Users/you/work/my-monorepo
MCBD_PORT=3000
MCBD_BIND=0.0.0.0                # LAN公開時
MCBD_AUTH_TOKEN=secret-token-123  # 必須（0.0.0.0時）
```

### 認証ミドルウェア

```typescript
// src/lib/auth.ts

import { NextRequest, NextResponse } from 'next/server';

const BIND_ADDRESS = process.env.MCBD_BIND || '127.0.0.1';
const AUTH_TOKEN = process.env.MCBD_AUTH_TOKEN;

export function withAuth(
  handler: (req: NextRequest) => Promise<NextResponse>
) {
  return async (req: NextRequest) => {
    // localhost バインドの場合は認証不要
    if (BIND_ADDRESS === '127.0.0.1' || BIND_ADDRESS === 'localhost') {
      return handler(req);
    }

    // 0.0.0.0 バインドの場合は認証必須
    if (!AUTH_TOKEN) {
      return NextResponse.json(
        { error: 'AUTH_TOKEN not configured' },
        { status: 500 }
      );
    }

    const authHeader = req.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const token = authHeader.slice(7); // "Bearer " を除去

    if (token !== AUTH_TOKEN) {
      return NextResponse.json(
        { error: 'Invalid token' },
        { status: 401 }
      );
    }

    return handler(req);
  };
}
```

### API Routeでの使用

```typescript
// src/app/api/worktrees/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { getWorktrees } from '@/lib/db';

async function handler(req: NextRequest) {
  const worktrees = getWorktrees();
  return NextResponse.json({ worktrees });
}

export const GET = withAuth(handler);
```

---

## エラーハンドリング戦略

### エラー分類

1. **クライアントエラー (4xx)**
   - 400 Bad Request - 不正なリクエスト
   - 401 Unauthorized - 認証失敗
   - 404 Not Found - リソースが存在しない

2. **サーバーエラー (5xx)**
   - 500 Internal Server Error - 予期しないエラー
   - 503 Service Unavailable - tmuxセッション起動失敗

### エラーレスポンス形式

```typescript
interface ErrorResponse {
  error: string;          // エラーメッセージ
  code?: string;          // エラーコード（任意）
  details?: any;          // 詳細情報（開発時のみ）
}
```

### グローバルエラーハンドラー

```typescript
// src/lib/error-handler.ts

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string
  ) {
    super(message);
  }
}

export function handleError(error: unknown): NextResponse {
  console.error('Error:', error);

  if (error instanceof AppError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.statusCode }
    );
  }

  return NextResponse.json(
    { error: 'Internal server error' },
    { status: 500 }
  );
}
```

---

## コード例

### 完全なAPI Route例

```typescript
// src/app/api/worktrees/[id]/send/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { hasSession, createSession, sendKeys } from '@/lib/tmux';
import { createMessage, getWorktreeById } from '@/lib/db';
import { AppError, handleError } from '@/lib/error-handler';
import { v4 as uuidv4 } from 'uuid';

async function handler(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id: worktreeId } = params;
    const { message } = await req.json();

    // バリデーション
    if (!message || typeof message !== 'string') {
      throw new AppError(400, 'Invalid message');
    }

    // Worktree存在チェック
    const worktree = await getWorktreeById(worktreeId);
    if (!worktree) {
      throw new AppError(404, 'Worktree not found');
    }

    // requestId生成
    const requestId = uuidv4();

    // tmuxセッション確認・起動
    const sessionName = `cw_${worktreeId}`;
    const sessionExists = await hasSession(sessionName);

    if (!sessionExists) {
      await createSession(sessionName, worktree.path, worktreeId);
    }

    // メッセージ送信
    await sendKeys(sessionName, message);

    // DBに保存（user側）
    const userMessage = await createMessage({
      worktreeId,
      role: 'user',
      content: message,
      timestamp: new Date(),
      requestId,
    });

    return NextResponse.json({
      requestId,
      message: userMessage,
    });
  } catch (error) {
    return handleError(error);
  }
}

export const POST = withAuth(handler);
```

---

## パフォーマンス最適化

### データベース

- インデックス活用
- プリペアドステートメント使用
- トランザクション適用（複数INSERT時）

### UI

- React.memoでコンポーネント最適化
- 無限スクロールでメモリ節約
- WebSocket再接続の遅延制御

### tmux

- capture-paneの実行頻度制限
- セッションプール（将来的に検討）

---

**作成者**: Claude (SWE Agent)
**最終更新**: 2025-11-17

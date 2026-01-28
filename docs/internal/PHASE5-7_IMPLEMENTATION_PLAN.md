# Phase 5-7 実装計画書

MyCodeBranchDesk の tmux/Claude CLI 統合機能の詳細実装計画。

## 📋 目次
3. [Phase 6: Claude CLI 統合](#phase-6-claude-cli-統合)
5. [統合テスト計画](#統合テスト計画)
6. [リスクと対策](#リスクと対策)

---

## 概要

worktree ごとに独立した tmux + Claude CLI セッションを管理し、ブラウザ UI からのメッセージ送信と Claude からの応答取得を実現する。

- **1 worktree = 1 tmux session = 1 Claude CLI process**
- **差分抽出**: tmux の scrollback から `lastCapturedLine` 以降のみを取得

**実装済み:**
- ✅ データベース（SQLite）
- ✅ WebSocket サーバー
- ✅ フロントエンド UI
- ✅ Worktree スキャン
- ✅ メッセージの DB 保存（`POST /api/worktrees/:id/send`）

**未実装（Phase 5-7）:**
- ❌ tmux セッション管理
- ❌ Claude CLI の起動と通信
- ❌ Stop フック処理
- ❌ scrollback からの差分抽出
- ❌ Markdown ログ保存

---

## Phase 5: tmux セッション管理

### 目標

tmux セッションを作成・管理し、worktree のワーキングディレクトリで操作できるようにする。

### タスク分解

#### 5.1 tmux ラッパーライブラリの拡張

**ファイル**: `src/lib/tmux.ts`

**実装内容:**

1. **セッション存在チェック**
   ```typescript
   async function hasSession(sessionName: string): Promise<boolean>
   ```
   - `tmux has-session -t {sessionName}` を実行
   - 戻り値で存在を判定

2. **セッション作成**
   ```typescript
   async function createSession(options: {
     sessionName: string;
     workingDirectory: string;
   }): Promise<void>
   ```
   - `tmux new-session -d -s {sessionName} -c {workingDirectory}`
   - detached モードで作成

3. **セッション一覧取得**
   ```typescript
   async function listSessions(): Promise<TmuxSession[]>
   ```
   - `tmux list-sessions -F "#{session_name}"`
   - パース処理

4. **セッション削除**
   ```typescript
   async function killSession(sessionName: string): Promise<void>
   ```
   - `tmux kill-session -t {sessionName}`

5. **コマンド送信**
   ```typescript
   async function sendKeys(sessionName: string, command: string): Promise<void>
   ```
   - `tmux send-keys -t {sessionName} "{command}" C-m`

6. **scrollback 取得**
   ```typescript
   async function capturePane(sessionName: string, options?: {
     startLine?: number;
     endLine?: number;
   }): Promise<string>
   ```
   - `tmux capture-pane -p -S {start} -E {end} -t {sessionName}`
   - scrollback バッファ全体を取得

**型定義:**

```typescript
interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
}

interface TmuxCaptureOptions {
  startLine?: number;  // -S オプション（デフォルト: -10000）
  endLine?: number;    // -E オプション（デフォルト: -）
}
```

#### 5.2 エラーハンドリング

- tmux が起動していない場合のエラー処理
- セッション名の衝突チェック
- コマンド実行タイムアウト（デフォルト: 5秒）

#### 5.3 ユニットテスト

**ファイル**: `tests/unit/tmux.test.ts`

**テストケース:**

1. `hasSession` - セッションの存在チェック
2. `createSession` - セッション作成
3. `listSessions` - セッション一覧取得
4. `killSession` - セッション削除
5. `sendKeys` - コマンド送信
6. `capturePane` - scrollback 取得
7. エラーケース（tmux 未起動、セッション不在など）

**モック化:**
- `child_process.exec` をモック
- tmux コマンドの出力をシミュレート

---

## Phase 6: Claude CLI 統合

### 目標

tmux セッション内で Claude CLI を起動し、Stop フックを設定する。メッセージを送信できるようにする。

### タスク分解

#### 6.1 Claude セッション管理

**ファイル**: `src/lib/claude-session.ts`

**実装内容:**

1. **Claude セッション起動**
   ```typescript
   async function startClaudeSession(options: {
     worktreeId: string;
     worktreePath: string;
     hookUrl: string;
   }): Promise<void>
   ```

   **実行手順:**
   ```bash
   # セッション作成
   tmux new-session -d -s "cw_{worktreeId}" -c "{worktreePath}"

   # Stop フック設定
   HOOK_CMD="curl -X POST {hookUrl} -H 'Content-Type: application/json' -d '{\"worktreeId\":\"{worktreeId}\"}'"
   tmux send-keys -t "cw_{worktreeId}" "export CLAUDE_HOOKS_STOP='${HOOK_CMD}'" C-m

   # Claude CLI 起動
   tmux send-keys -t "cw_{worktreeId}" "claude" C-m
   ```

2. **Claude セッション状態チェック**
   ```typescript
   async function isClaudeRunning(sessionName: string): Promise<boolean>
   ```
   - セッション内のプロセス一覧を取得
   - `claude` プロセスの存在を確認

3. **メッセージ送信**
   ```typescript
   async function sendMessageToClaude(
     worktreeId: string,
     message: string
   ): Promise<void>
   ```
   - `tmux send-keys` でメッセージを送信
   - エスケープ処理（改行、特殊文字）

#### 6.2 API エンドポイントの拡張

**ファイル**: `src/app/api/worktrees/[id]/send/route.ts`

**現在の実装:**
```typescript
// メッセージを DB に保存するだけ
createMessage(db, { worktreeId, role: 'user', content });
```

**拡張内容:**

```typescript
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    const body = await request.json();
    if (!body.content || typeof body.content !== 'string' || body.content.trim() === '') {
      return NextResponse.json({ error: 'Message content is required' }, { status: 400 });
    }

    // 1. ユーザーメッセージを DB に保存
    const userMessage = createMessage(db, {
      worktreeId: params.id,
      role: 'user',
      content: body.content,
      timestamp: new Date(),
    });

    // 2. tmux セッションの確認・起動
    const sessionName = `cw_${params.id}`;
    const sessionExists = await hasSession(sessionName);

    if (!sessionExists) {
      // セッションが存在しない場合、Claude セッションを起動
      const hookUrl = `${process.env.MCBD_BASE_URL || 'http://localhost:3000'}/api/hooks/claude-done`;
      await startClaudeSession({
        worktreeId: params.id,
        worktreePath: worktree.path,
        hookUrl,
      });

      // Claude の起動待ち（2秒）
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      // セッションが存在する場合、Claude が動作しているか確認
      const isRunning = await isClaudeRunning(sessionName);
      if (!isRunning) {
        // Claude が停止している場合、再起動
        await startClaudeSession({
          worktreeId: params.id,
          worktreePath: worktree.path,
          hookUrl: `${process.env.MCBD_BASE_URL || 'http://localhost:3000'}/api/hooks/claude-done`,
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // 3. メッセージを Claude に送信
    await sendMessageToClaude(params.id, body.content);

    // 4. WebSocket でユーザーメッセージを配信
    broadcastMessage(params.id, userMessage);

    // 5. 202 Accepted で即座に応答
    return NextResponse.json(userMessage, { status: 202 });

  } catch (error) {
    console.error('Error sending message:', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}
```

#### 6.3 環境変数の追加

**ファイル**: `.env.example`, `.env.production.example`

```env
# Base URL for hook callbacks
MCBD_BASE_URL=http://localhost:3000
```

#### 6.4 統合テスト

**ファイル**: `tests/integration/claude-session.test.ts`

**テストケース:**

1. Claude セッションの起動
2. メッセージ送信
3. セッションの再起動
4. エラーハンドリング（tmux 未起動、Claude 未インストール）

**モック化:**
- tmux コマンドをモック
- Claude CLI の動作をシミュレート

---

## Phase 7: Stop フック処理

### 目標

Claude CLI の Stop フックを受け取り、scrollback から差分を抽出してログとメッセージを保存する。

### タスク分解

#### 7.1 Stop フック API の実装

**ファイル**: `src/app/api/hooks/claude-done/route.ts`

**現在の状態**: 実装されていない

**実装内容:**

```typescript
/**
 * API Route: POST /api/hooks/claude-done
 * Claude CLI の Stop フックから呼び出される
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, createMessage, updateWorktree, getSessionState, updateSessionState } from '@/lib/db';
import { capturePane } from '@/lib/tmux';
import { saveLogFile } from '@/lib/log-manager';
import { broadcastMessage } from '@/lib/ws-server';

interface ClaudeDoneRequest {
  worktreeId: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: ClaudeDoneRequest = await request.json();
    const { worktreeId } = body;

    if (!worktreeId) {
      return NextResponse.json({ error: 'worktreeId is required' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, worktreeId);
    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    // 1. セッション状態を取得
    const sessionState = getSessionState(db, worktreeId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // 2. tmux から scrollback 全体を取得
    const sessionName = `cw_${worktreeId}`;
    const fullOutput = await capturePane(sessionName, {
      startLine: -10000,  // 十分に大きな値
    });

    // 3. 差分を抽出（lastCapturedLine 以降）
    const lines = fullOutput.split('\n');
    const newLines = lines.slice(lastCapturedLine);
    const newOutput = newLines.join('\n');

    if (newOutput.trim() === '') {
      console.log(`No new output for worktree ${worktreeId}`);
      return NextResponse.json({ message: 'No new output' }, { status: 200 });
    }

    // 4. Markdown ログとして保存
    const logFileName = await saveLogFile({
      worktreeId,
      worktreePath: worktree.path,
      content: newOutput,
      timestamp: new Date(),
    });

    // 5. ChatMessage を作成
    const claudeMessage = createMessage(db, {
      worktreeId,
      role: 'claude',
      content: newOutput,
      summary: extractSummary(newOutput),  // 要約を抽出（オプション）
      logFileName,
      timestamp: new Date(),
    });

    // 6. Worktree の lastMessageSummary と updatedAt を更新
    updateWorktree(db, {
      id: worktreeId,
      lastMessageSummary: claudeMessage.summary,
      updatedAt: claudeMessage.timestamp,
    });

    // 7. セッション状態を更新（lastCapturedLine）
    updateSessionState(db, {
      worktreeId,
      lastCapturedLine: lines.length,
    });

    // 8. WebSocket でメッセージを配信
    broadcastMessage(worktreeId, claudeMessage);

    console.log(`✓ Processed Stop hook for worktree ${worktreeId}, saved to ${logFileName}`);

    return NextResponse.json({
      message: 'Stop hook processed',
      messageId: claudeMessage.id,
      logFileName,
    }, { status: 200 });

  } catch (error) {
    console.error('Error processing Stop hook:', error);
    return NextResponse.json({ error: 'Failed to process Stop hook' }, { status: 500 });
  }
}

/**
 * 応答から要約を抽出（簡易実装）
 */
function extractSummary(content: string): string {
  // 最初の100文字を要約として使用
  const summary = content.trim().split('\n')[0];
  return summary.substring(0, 100) + (summary.length > 100 ? '...' : '');
}
```

#### 7.2 ログ管理機能

**ファイル**: `src/lib/log-manager.ts`

**実装内容:**

```typescript
import fs from 'fs/promises';
import path from 'path';
import { format } from 'date-fns';

/**
 * Markdown ログファイルを保存
 */
export async function saveLogFile(options: {
  worktreeId: string;
  worktreePath: string;
  content: string;
  timestamp: Date;
}): Promise<string> {
  const { worktreeId, worktreePath, content, timestamp } = options;

  // ログディレクトリ: {worktreePath}/.claude_logs/
  const logsDir = path.join(worktreePath, '.claude_logs');
  await fs.mkdir(logsDir, { recursive: true });

  // ファイル名: YYYYMMDD-HHMMSS-{worktreeId}-{uuid}.md
  const dateStr = format(timestamp, 'yyyyMMdd-HHmmss');
  const uuid = generateShortUuid();
  const fileName = `${dateStr}-${worktreeId}-${uuid}.md`;
  const filePath = path.join(logsDir, fileName);

  // Markdown フォーマットでログを保存
  const logContent = `# Claude Response - ${format(timestamp, 'yyyy-MM-dd HH:mm:ss')}

Worktree: ${worktreeId}

---

${content}
`;

  await fs.writeFile(filePath, logContent, 'utf-8');

  return fileName;
}

/**
 * ログファイル一覧を取得
 */
export async function listLogFiles(worktreePath: string): Promise<string[]> {
  const logsDir = path.join(worktreePath, '.claude_logs');

  try {
    const files = await fs.readdir(logsDir);
    return files
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();  // 新しい順
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * ログファイルの内容を取得
 */
export async function readLogFile(
  worktreePath: string,
  fileName: string
): Promise<string> {
  const logsDir = path.join(worktreePath, '.claude_logs');
  const filePath = path.join(logsDir, fileName);

  // パストラバーサル対策
  if (!filePath.startsWith(logsDir)) {
    throw new Error('Invalid file path');
  }

  return await fs.readFile(filePath, 'utf-8');
}

/**
 * 短い UUID を生成（8文字）
 */
function generateShortUuid(): string {
  return Math.random().toString(36).substring(2, 10);
}
```

#### 7.3 データベース関数の追加

**ファイル**: `src/lib/db.ts`

**追加する関数:**

```typescript
/**
 * セッション状態を取得
 */
export function getSessionState(
  db: Database.Database,
  worktreeId: string
): WorktreeSessionState | null {
  const row = db
    .prepare('SELECT * FROM session_states WHERE worktreeId = ?')
    .get(worktreeId) as any;

  if (!row) {
    return null;
  }

  return {
    worktreeId: row.worktreeId,
    lastCapturedLine: row.lastCapturedLine,
  };
}

/**
 * セッション状態を更新
 */
export function updateSessionState(
  db: Database.Database,
  state: {
    worktreeId: string;
    lastCapturedLine: number;
  }
): void {
  db.prepare(`
    INSERT INTO session_states (worktreeId, lastCapturedLine)
    VALUES (?, ?)
    ON CONFLICT(worktreeId)
    DO UPDATE SET lastCapturedLine = excluded.lastCapturedLine
  `).run(state.worktreeId, state.lastCapturedLine);
}

/**
 * Worktree の lastMessageSummary と updatedAt を更新
 */
export function updateWorktree(
  db: Database.Database,
  update: {
    id: string;
    lastMessageSummary?: string;
    updatedAt?: Date;
  }
): void {
  const updates: string[] = [];
  const values: any[] = [];

  if (update.lastMessageSummary !== undefined) {
    updates.push('lastMessageSummary = ?');
    values.push(update.lastMessageSummary);
  }

  if (update.updatedAt !== undefined) {
    updates.push('updatedAt = ?');
    values.push(update.updatedAt.toISOString());
  }

  if (updates.length === 0) {
    return;
  }

  values.push(update.id);

  db.prepare(`
    UPDATE worktrees
    SET ${updates.join(', ')}
    WHERE id = ?
  `).run(...values);
}
```

#### 7.4 WebSocket メッセージ配信

**ファイル**: `src/lib/ws-server.ts`

**追加する関数:**

```typescript
/**
 * 特定の worktree にメッセージを配信
 */
export function broadcastMessage(worktreeId: string, message: ChatMessage): void {
  const messageData = JSON.stringify({
    type: 'chat_message_created',
    worktreeId,
    message,
  });

  // worktreeId を購読している全クライアントに配信
  broadcast(worktreeId, messageData);
}
```

#### 7.5 ログ API エンドポイントの修正

**ファイル**: `src/app/api/worktrees/[id]/logs/route.ts`

**現在の実装**: ハードコードされたモックデータ

**修正内容:**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { listLogFiles } from '@/lib/log-manager';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);

    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    // ログファイル一覧を取得
    const logFiles = await listLogFiles(worktree.path);

    return NextResponse.json(logFiles, { status: 200 });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}
```

**ファイル**: `src/app/api/worktrees/[id]/logs/[filename]/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { readLogFile } from '@/lib/log-manager';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; filename: string } }
) {
  try {
    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);

    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    // ログファイルの内容を取得
    const content = await readLogFile(worktree.path, params.filename);

    return new NextResponse(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
      },
    });
  } catch (error) {
    console.error('Error reading log file:', error);
    return NextResponse.json({ error: 'Failed to read log file' }, { status: 500 });
  }
}
```

#### 7.6 統合テスト

**ファイル**: `tests/integration/stop-hook.test.ts`

**テストケース:**

1. Stop フック API の呼び出し
2. scrollback からの差分抽出
3. ログファイルの保存
4. ChatMessage の作成
5. WebSocket メッセージの配信
6. エラーハンドリング

---

## 統合テスト計画

### E2E テスト

**ファイル**: `tests/e2e/message-flow.spec.ts`

**テストシナリオ:**

1. **基本的なメッセージ送受信フロー**
   - ブラウザから worktree 詳細ページにアクセス
   - メッセージ入力欄に "Hello Claude" と入力
   - 送信ボタンをクリック
   - ユーザーメッセージが表示されることを確認
   - （モック）Stop フックをトリガー
   - Claude の応答が表示されることを確認

2. **ログファイルの確認**
   - Log Files タブをクリック
   - ログファイル一覧が表示されることを確認
   - ログファイルをクリック
   - Markdown 形式で内容が表示されることを確認

3. **セッション再起動**
   - tmux セッションを手動で kill
   - 新しいメッセージを送信
   - セッションが自動的に再作成されることを確認

### マニュアルテスト

**テスト環境:**
- 実際の tmux と Claude CLI を使用
- 実際の git worktree を使用

**テスト手順:**

1. サーバーを起動
2. ブラウザで worktree 詳細ページにアクセス
3. 実際にメッセージを送信
4. tmux セッションを確認（`tmux list-sessions`）
5. Claude の応答を確認
6. ログファイルが作成されることを確認（`.claude_logs/`）
7. WebSocket でリアルタイム更新されることを確認

---

## リスクと対策

### リスク 1: Claude CLI のインストール

**問題**: Claude CLI がインストールされていない、またはバージョンが古い

**対策**:
- 起動時に `claude --version` で確認
- エラーメッセージでインストール手順を案内
- README に前提条件として明記

### リスク 2: tmux の動作不良

**問題**: tmux が起動していない、またはセッションが異常終了

**対策**:
- tmux の起動確認（`tmux -V`）
- セッション状態の定期的なヘルスチェック（オプション）
- エラー時の自動再起動

### リスク 3: Stop フックの遅延・失敗

**問題**: Claude の処理が長時間かかる、Stop フックが呼ばれない

**対策**:
- UI 側でタイムアウト表示（120秒）
- ログファイルから手動確認できる仕組み
- エラーログの充実

### リスク 4: scrollback の容量制限

**問題**: tmux の scrollback バッファが制限を超える

**対策**:
- tmux の `history-limit` 設定を大きくする（デフォルト: 2000 → 10000+）
- セッション作成時に設定
  ```bash
  tmux set-option -t {sessionName} history-limit 50000
  ```

### リスク 5: 特殊文字のエスケープ

**問題**: メッセージに改行や特殊文字が含まれる場合の処理

**対策**:
- `sendMessageToClaude` 関数で適切なエスケープ
- シェルスクリプトのクォート処理
- テストで特殊文字のケースを網羅

---

## 実装順序の推奨

### Week 1: Phase 5

1. Day 1-2: `tmux.ts` の実装
2. Day 3: ユニットテスト
3. Day 4: 統合テストとデバッグ

### Week 2: Phase 6

1. Day 1-2: `claude-session.ts` の実装
2. Day 3: `send/route.ts` の拡張
3. Day 4: 統合テストとデバッグ

### Week 3: Phase 7

1. Day 1-2: `log-manager.ts` と `claude-done/route.ts` の実装
2. Day 3: ログ API の修正
3. Day 4: 統合テストとデバッグ

### Week 4: 統合とポリッシュ

1. Day 1-2: E2E テスト
2. Day 3: マニュアルテスト
3. Day 4: ドキュメント更新とリリース準備

---

## チェックリスト

### Phase 5 完了条件

- [ ] `tmux.ts` の全関数が実装され、テストがパス
- [ ] エラーハンドリングが適切に実装されている
- [ ] ユニットテストカバレッジ 80% 以上

### Phase 6 完了条件

- [ ] `claude-session.ts` の全関数が実装され、テストがパス
- [ ] `send/route.ts` が Claude にメッセージを送信できる
- [ ] セッションの自動起動・再起動が動作する
- [ ] 統合テストがパス

### Phase 7 完了条件

- [ ] `claude-done/route.ts` が Stop フックを処理できる
- [ ] scrollback からの差分抽出が正確
- [ ] ログファイルが正しく保存される
- [ ] WebSocket で応答が配信される
- [ ] E2E テストがパス

### 全体完了条件

- [ ] すべてのユニットテストがパス
- [ ] すべての統合テストがパス
- [ ] E2E テストがパス
- [ ] マニュアルテストで実際に動作確認
- [ ] ドキュメントが更新されている
- [ ] プロダクション環境でデプロイ可能

---

## 次のステップ

Phase 5-7 の実装を開始する準備ができました。

**開始コマンド:**
```bash
# Phase 5 の実装を開始
git checkout -b feature/phase5-tmux-session-management
```

**参考資料:**
- [Architecture Document](./architecture.md)
- [README](../README.md)
- [Deployment Guide](./DEPLOYMENT.md)

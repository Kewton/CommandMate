[日本語版](../../internal/PHASE5-7_IMPLEMENTATION_PLAN.md)

# Phase 5-7 Implementation Plan

Detailed implementation plan for CommandMate's tmux/Claude CLI integration features.

## Table of Contents
3. [Phase 6: Claude CLI Integration](#phase-6-claude-cli-integration)
5. [Integration Test Plan](#integration-test-plan)
6. [Risks and Mitigations](#risks-and-mitigations)

---

## Overview

Manage independent tmux + Claude CLI sessions per worktree, enabling message sending from the browser UI and response retrieval from Claude.

- **1 worktree = 1 tmux session = 1 Claude CLI process**
- **Diff extraction**: Retrieve only lines after `lastCapturedLine` from tmux scrollback

**Implemented:**
- tmux Database (SQLite)
- WebSocket server
- Frontend UI
- Worktree scanning
- Message DB persistence (`POST /api/worktrees/:id/send`)

**Not yet implemented (Phase 5-7):**
- tmux session management
- Claude CLI startup and communication
- Stop hook processing
- Diff extraction from scrollback
- Markdown log saving

---

## Phase 5: tmux Session Management

### Goal

Create and manage tmux sessions, enabling operations in the worktree's working directory.

### Task Breakdown

#### 5.1 Extending the tmux Wrapper Library

**File**: `src/lib/tmux.ts`

**Implementation:**

1. **Session existence check**
   ```typescript
   async function hasSession(sessionName: string): Promise<boolean>
   ```
   - Execute `tmux has-session -t {sessionName}`
   - Determine existence from return value

2. **Session creation**
   ```typescript
   async function createSession(options: {
     sessionName: string;
     workingDirectory: string;
   }): Promise<void>
   ```
   - `tmux new-session -d -s {sessionName} -c {workingDirectory}`
   - Create in detached mode

3. **Session list retrieval**
   ```typescript
   async function listSessions(): Promise<TmuxSession[]>
   ```
   - `tmux list-sessions -F "#{session_name}"`
   - Parse processing

4. **Session deletion**
   ```typescript
   async function killSession(sessionName: string): Promise<void>
   ```
   - `tmux kill-session -t {sessionName}`

5. **Command sending**
   ```typescript
   async function sendKeys(sessionName: string, command: string): Promise<void>
   ```
   - `tmux send-keys -t {sessionName} "{command}" C-m`

6. **Scrollback retrieval**
   ```typescript
   async function capturePane(sessionName: string, options?: {
     startLine?: number;
     endLine?: number;
   }): Promise<string>
   ```
   - `tmux capture-pane -p -S {start} -E {end} -t {sessionName}`
   - Retrieve the entire scrollback buffer

**Type definitions:**

```typescript
interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
}

interface TmuxCaptureOptions {
  startLine?: number;  // -S option (default: -10000)
  endLine?: number;    // -E option (default: -)
}
```

#### 5.2 Error Handling

- Error handling when tmux is not running
- Session name collision checking
- Command execution timeout (default: 5 seconds)

#### 5.3 Unit Tests

**File**: `tests/unit/tmux.test.ts`

**Test cases:**

1. `hasSession` - Session existence check
2. `createSession` - Session creation
3. `listSessions` - Session list retrieval
4. `killSession` - Session deletion
5. `sendKeys` - Command sending
6. `capturePane` - Scrollback retrieval
7. Error cases (tmux not running, session not found, etc.)

**Mocking:**
- Mock `child_process.exec`
- Simulate tmux command output

---

## Phase 6: Claude CLI Integration

### Goal

Start Claude CLI within a tmux session and set up the Stop hook. Enable message sending.

### Task Breakdown

#### 6.1 Claude Session Management

**File**: `src/lib/claude-session.ts`

**Implementation:**

1. **Claude session startup**
   ```typescript
   async function startClaudeSession(options: {
     worktreeId: string;
     worktreePath: string;
     hookUrl: string;
   }): Promise<void>
   ```

   **Execution steps:**
   ```bash
   # Create session
   tmux new-session -d -s "cw_{worktreeId}" -c "{worktreePath}"

   # Set Stop hook
   HOOK_CMD="curl -X POST {hookUrl} -H 'Content-Type: application/json' -d '{\"worktreeId\":\"{worktreeId}\"}'"
   tmux send-keys -t "cw_{worktreeId}" "export CLAUDE_HOOKS_STOP='${HOOK_CMD}'" C-m

   # Start Claude CLI
   tmux send-keys -t "cw_{worktreeId}" "claude" C-m
   ```

2. **Claude session state check**
   ```typescript
   async function isClaudeRunning(sessionName: string): Promise<boolean>
   ```
   - Get process list within the session
   - Confirm existence of `claude` process

3. **Message sending**
   ```typescript
   async function sendMessageToClaude(
     worktreeId: string,
     message: string
   ): Promise<void>
   ```
   - Send message via `tmux send-keys`
   - Escape handling (newlines, special characters)

#### 6.2 API Endpoint Extension

**File**: `src/app/api/worktrees/[id]/send/route.ts`

**Current implementation:**
```typescript
// Only saves message to DB
createMessage(db, { worktreeId, role: 'user', content });
```

**Extended content:**

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

    // 1. Save user message to DB
    const userMessage = createMessage(db, {
      worktreeId: params.id,
      role: 'user',
      content: body.content,
      timestamp: new Date(),
    });

    // 2. Check/start tmux session
    const sessionName = `cw_${params.id}`;
    const sessionExists = await hasSession(sessionName);

    if (!sessionExists) {
      // If session doesn't exist, start Claude session
      const hookUrl = `${process.env.MCBD_BASE_URL || 'http://localhost:3000'}/api/hooks/claude-done`;
      await startClaudeSession({
        worktreeId: params.id,
        worktreePath: worktree.path,
        hookUrl,
      });

      // Wait for Claude startup (2 seconds)
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      // If session exists, check if Claude is running
      const isRunning = await isClaudeRunning(sessionName);
      if (!isRunning) {
        // If Claude is stopped, restart
        await startClaudeSession({
          worktreeId: params.id,
          worktreePath: worktree.path,
          hookUrl: `${process.env.MCBD_BASE_URL || 'http://localhost:3000'}/api/hooks/claude-done`,
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // 3. Send message to Claude
    await sendMessageToClaude(params.id, body.content);

    // 4. Distribute user message via WebSocket
    broadcastMessage(params.id, userMessage);

    // 5. Respond immediately with 202 Accepted
    return NextResponse.json(userMessage, { status: 202 });

  } catch (error) {
    console.error('Error sending message:', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}
```

#### 6.3 Adding Environment Variables

**Files**: `.env.example`, `.env.production.example`

```env
# Base URL for hook callbacks
MCBD_BASE_URL=http://localhost:3000
```

#### 6.4 Integration Tests

**File**: `tests/integration/claude-session.test.ts`

**Test cases:**

1. Claude session startup
2. Message sending
3. Session restart
4. Error handling (tmux not running, Claude not installed)

**Mocking:**
- Mock tmux commands
- Simulate Claude CLI behavior

---

## Phase 7: Stop Hook Processing

### Goal

Receive Claude CLI's Stop hook, extract diffs from scrollback, and save logs and messages.

### Task Breakdown

#### 7.1 Stop Hook API Implementation

**File**: `src/app/api/hooks/claude-done/route.ts`

**Current state**: Not implemented

**Implementation:**

```typescript
/**
 * API Route: POST /api/hooks/claude-done
 * Called from Claude CLI's Stop hook
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

    // 1. Get session state
    const sessionState = getSessionState(db, worktreeId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // 2. Get full scrollback from tmux
    const sessionName = `cw_${worktreeId}`;
    const fullOutput = await capturePane(sessionName, {
      startLine: -10000,  // Sufficiently large value
    });

    // 3. Extract diff (after lastCapturedLine)
    const lines = fullOutput.split('\n');
    const newLines = lines.slice(lastCapturedLine);
    const newOutput = newLines.join('\n');

    if (newOutput.trim() === '') {
      console.log(`No new output for worktree ${worktreeId}`);
      return NextResponse.json({ message: 'No new output' }, { status: 200 });
    }

    // 4. Save as Markdown log
    const logFileName = await saveLogFile({
      worktreeId,
      worktreePath: worktree.path,
      content: newOutput,
      timestamp: new Date(),
    });

    // 5. Create ChatMessage
    const claudeMessage = createMessage(db, {
      worktreeId,
      role: 'claude',
      content: newOutput,
      summary: extractSummary(newOutput),  // Extract summary (optional)
      logFileName,
      timestamp: new Date(),
    });

    // 6. Update Worktree's lastMessageSummary and updatedAt
    updateWorktree(db, {
      id: worktreeId,
      lastMessageSummary: claudeMessage.summary,
      updatedAt: claudeMessage.timestamp,
    });

    // 7. Update session state (lastCapturedLine)
    updateSessionState(db, {
      worktreeId,
      lastCapturedLine: lines.length,
    });

    // 8. Distribute message via WebSocket
    broadcastMessage(worktreeId, claudeMessage);

    console.log(`Processed Stop hook for worktree ${worktreeId}, saved to ${logFileName}`);

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
 * Extract summary from response (simple implementation)
 */
function extractSummary(content: string): string {
  // Use the first 100 characters as the summary
  const summary = content.trim().split('\n')[0];
  return summary.substring(0, 100) + (summary.length > 100 ? '...' : '');
}
```

#### 7.2 Log Management Feature

**File**: `src/lib/log-manager.ts`

**Implementation:**

```typescript
import fs from 'fs/promises';
import path from 'path';
import { format } from 'date-fns';

/**
 * Save a Markdown log file
 */
export async function saveLogFile(options: {
  worktreeId: string;
  worktreePath: string;
  content: string;
  timestamp: Date;
}): Promise<string> {
  const { worktreeId, worktreePath, content, timestamp } = options;

  // Log directory: {worktreePath}/.claude_logs/
  const logsDir = path.join(worktreePath, '.claude_logs');
  await fs.mkdir(logsDir, { recursive: true });

  // File name: YYYYMMDD-HHMMSS-{worktreeId}-{uuid}.md
  const dateStr = format(timestamp, 'yyyyMMdd-HHmmss');
  const uuid = generateShortUuid();
  const fileName = `${dateStr}-${worktreeId}-${uuid}.md`;
  const filePath = path.join(logsDir, fileName);

  // Save log in Markdown format
  const logContent = `# Claude Response - ${format(timestamp, 'yyyy-MM-dd HH:mm:ss')}

Worktree: ${worktreeId}

---

${content}
`;

  await fs.writeFile(filePath, logContent, 'utf-8');

  return fileName;
}

/**
 * Get log file list
 */
export async function listLogFiles(worktreePath: string): Promise<string[]> {
  const logsDir = path.join(worktreePath, '.claude_logs');

  try {
    const files = await fs.readdir(logsDir);
    return files
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();  // Newest first
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Get log file content
 */
export async function readLogFile(
  worktreePath: string,
  fileName: string
): Promise<string> {
  const logsDir = path.join(worktreePath, '.claude_logs');
  const filePath = path.join(logsDir, fileName);

  // Path traversal protection
  if (!filePath.startsWith(logsDir)) {
    throw new Error('Invalid file path');
  }

  return await fs.readFile(filePath, 'utf-8');
}

/**
 * Generate a short UUID (8 characters)
 */
function generateShortUuid(): string {
  return Math.random().toString(36).substring(2, 10);
}
```

#### 7.3 Database Function Additions

**File**: `src/lib/db.ts`

**Functions to add:**

```typescript
/**
 * Get session state
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
 * Update session state
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
 * Update Worktree's lastMessageSummary and updatedAt
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

#### 7.4 WebSocket Message Distribution

**File**: `src/lib/ws-server.ts`

**Function to add:**

```typescript
/**
 * Distribute message to a specific worktree
 */
export function broadcastMessage(worktreeId: string, message: ChatMessage): void {
  const messageData = JSON.stringify({
    type: 'chat_message_created',
    worktreeId,
    message,
  });

  // Distribute to all clients subscribed to the worktreeId
  broadcast(worktreeId, messageData);
}
```

#### 7.5 Log API Endpoint Fix

**File**: `src/app/api/worktrees/[id]/logs/route.ts`

**Current implementation**: Hard-coded mock data

**Modified content:**

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

    // Get log file list
    const logFiles = await listLogFiles(worktree.path);

    return NextResponse.json(logFiles, { status: 200 });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}
```

**File**: `src/app/api/worktrees/[id]/logs/[filename]/route.ts`

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

    // Get log file content
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

#### 7.6 Integration Tests

**File**: `tests/integration/stop-hook.test.ts`

**Test cases:**

1. Stop hook API invocation
2. Diff extraction from scrollback
3. Log file saving
4. ChatMessage creation
5. WebSocket message distribution
6. Error handling

---

## Integration Test Plan

### E2E Tests

**File**: `tests/e2e/message-flow.spec.ts`

**Test scenarios:**

1. **Basic message send/receive flow**
   - Access worktree detail page from browser
   - Enter "Hello Claude" in the message input field
   - Click the send button
   - Verify user message is displayed
   - (Mock) Trigger the Stop hook
   - Verify Claude's response is displayed

2. **Log file verification**
   - Click the Log Files tab
   - Verify log file list is displayed
   - Click a log file
   - Verify content is displayed in Markdown format

3. **Session restart**
   - Manually kill the tmux session
   - Send a new message
   - Verify the session is automatically recreated

### Manual Tests

**Test environment:**
- Using actual tmux and Claude CLI
- Using actual git worktrees

**Test procedure:**

1. Start the server
2. Access the worktree detail page from a browser
3. Actually send a message
4. Check the tmux session (`tmux list-sessions`)
5. Verify Claude's response
6. Verify a log file is created (`.claude_logs/`)
7. Verify real-time updates via WebSocket

---

## Risks and Mitigations

### Risk 1: Claude CLI Installation

**Problem**: Claude CLI is not installed or the version is outdated

**Mitigations**:
- Check with `claude --version` at startup
- Guide installation steps in error messages
- Document as prerequisites in README

### Risk 2: tmux Malfunction

**Problem**: tmux is not running or sessions terminate abnormally

**Mitigations**:
- Verify tmux startup (`tmux -V`)
- Periodic health checking of session state (optional)
- Automatic restart on errors

### Risk 3: Stop Hook Delay/Failure

**Problem**: Claude processing takes a long time, or the Stop hook is not called

**Mitigations**:
- Display timeout on the UI side (120 seconds)
- Mechanism for manual verification from log files
- Comprehensive error logging

### Risk 4: Scrollback Capacity Limits

**Problem**: tmux scrollback buffer exceeds its limit

**Mitigations**:
- Increase tmux `history-limit` setting (default: 2000 -> 10000+)
- Set during session creation
  ```bash
  tmux set-option -t {sessionName} history-limit 50000
  ```

### Risk 5: Special Character Escaping

**Problem**: Handling when messages contain newlines or special characters

**Mitigations**:
- Proper escaping in the `sendMessageToClaude` function
- Shell script quoting
- Cover special character cases in tests

---

## Recommended Implementation Order

### Week 1: Phase 5

1. Day 1-2: Implement `tmux.ts`
2. Day 3: Unit tests
3. Day 4: Integration tests and debugging

### Week 2: Phase 6

1. Day 1-2: Implement `claude-session.ts`
2. Day 3: Extend `send/route.ts`
3. Day 4: Integration tests and debugging

### Week 3: Phase 7

1. Day 1-2: Implement `log-manager.ts` and `claude-done/route.ts`
2. Day 3: Fix log API
3. Day 4: Integration tests and debugging

### Week 4: Integration and Polish

1. Day 1-2: E2E tests
2. Day 3: Manual tests
3. Day 4: Documentation updates and release preparation

---

## Checklist

### Phase 5 Completion Criteria

- [ ] All `tmux.ts` functions implemented and tests pass
- [ ] Error handling is properly implemented
- [ ] Unit test coverage 80% or higher

### Phase 6 Completion Criteria

- [ ] All `claude-session.ts` functions implemented and tests pass
- [ ] `send/route.ts` can send messages to Claude
- [ ] Session auto-start and restart work
- [ ] Integration tests pass

### Phase 7 Completion Criteria

- [ ] `claude-done/route.ts` can process Stop hooks
- [ ] Diff extraction from scrollback is accurate
- [ ] Log files are saved correctly
- [ ] Responses are distributed via WebSocket
- [ ] E2E tests pass

### Overall Completion Criteria

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] E2E tests pass
- [ ] Operation verified through manual testing
- [ ] Documentation is updated
- [ ] Ready for production deployment

---

## Next Steps

Ready to begin Phase 5-7 implementation.

**Starting command:**
```bash
# Start Phase 5 implementation
git checkout -b feature/phase5-tmux-session-management
```

**References:**
- [Architecture Document](../architecture.md)
- [README](../../README.md)
- [Deployment Guide](../DEPLOYMENT.md)

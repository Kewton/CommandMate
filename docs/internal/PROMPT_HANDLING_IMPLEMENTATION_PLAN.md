# Claude Prompt Handling Implementation Plan

**Project**: CommandMate
**Feature**: Interactive Prompt Support (yes/no confirmations)
**Approach**: Structured Prompt Message Type (案3)
**Date**: 2025-11-17
**Target Phase**: Phase 1 - Basic yes/no Support

---

## Executive Summary

Claude CLI often requires user confirmation for operations (e.g., "Approve bash execution? (y/n)"). Currently, these prompts are not detected, leaving users unable to respond. This plan implements a structured approach to detect, display, and respond to Claude's interactive prompts within the chat interface.

**Phase 1 Goal**: Support 80-85% of Claude's prompts (yes/no format)
**Estimated Effort**: 2-3 days
**Priority**: High (blocking user workflows)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     User Workflow                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. User sends message to Claude                           │
│  2. Claude responds with prompt: "Approve? (y/n)"          │
│  3. Poller detects prompt pattern                          │
│  4. Saved as 'prompt' message type in DB                   │
│  5. UI displays with Yes/No buttons                        │
│  6. User clicks button                                      │
│  7. API sends 'y' or 'n' to tmux                           │
│  8. Polling resumes for Claude's next response             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Implementation Scope

### Included
- ✅ yes/no prompt detection: `(y/n)`, `[y/N]`, `(yes/no)`
- ✅ Database schema extension (message_type, prompt_data)
- ✅ Prompt message creation and storage
- ✅ UI component for prompt display with buttons
- ✅ API endpoint for sending responses
- ✅ Polling pause/resume on prompt detection
- ✅ Migration for existing messages

### Excluded (Future Phases)
- ❌ Multiple choice prompts (Phase 2)
- ❌ Text input prompts (Phase 3)
- ❌ Continue/any-key prompts (Phase 2)
- ❌ Timeout handling (Phase 2)

---

## Database Changes

### Schema Migration

**File**: `migrations/002_add_prompt_support.sql`

```sql
-- Add message_type column
ALTER TABLE chat_messages
ADD COLUMN message_type TEXT DEFAULT 'normal';

-- Add prompt_data column (JSON)
ALTER TABLE chat_messages
ADD COLUMN prompt_data TEXT;

-- Create index for filtering prompt messages
CREATE INDEX idx_messages_type
ON chat_messages(message_type, worktree_id);

-- Backfill existing messages
UPDATE chat_messages
SET message_type = 'normal'
WHERE message_type IS NULL;
```

### Data Model

**PromptData JSON Structure**:
```json
{
  "type": "yes_no",
  "question": "Do you want to proceed?",
  "options": ["yes", "no"],
  "status": "pending",
  "answer": null,
  "defaultOption": "no"
}
```

After user responds:
```json
{
  "type": "yes_no",
  "question": "Do you want to proceed?",
  "options": ["yes", "no"],
  "status": "answered",
  "answer": "yes",
  "defaultOption": "no",
  "answeredAt": "2025-11-17T15:30:00Z"
}
```

---

## TypeScript Type Definitions

**File**: `src/types/models.ts`

```typescript
/**
 * Message type discriminator
 */
export type MessageType = 'normal' | 'prompt' | 'prompt_response';

/**
 * Prompt type discriminator
 */
export type PromptType = 'yes_no' | 'approval' | 'choice' | 'input' | 'continue';

/**
 * Base prompt data
 */
export interface BasePromptData {
  type: PromptType;
  question: string;
  status: 'pending' | 'answered';
  answer?: string;
  answeredAt?: string;
}

/**
 * Yes/No prompt data
 */
export interface YesNoPromptData extends BasePromptData {
  type: 'yes_no';
  options: ['yes', 'no'];
  defaultOption?: 'yes' | 'no';
}

/**
 * Union type for all prompt data (extensible)
 */
export type PromptData = YesNoPromptData;

/**
 * Extended ChatMessage interface
 */
export interface ChatMessage {
  id: string;
  worktreeId: string;
  role: 'user' | 'claude';
  content: string;
  timestamp: Date;

  // New fields
  messageType: MessageType;
  promptData?: PromptData;

  // Existing fields
  summary?: string;
  logFileName?: string;
  requestId?: string;
}
```

---

## Backend Implementation

### 1. Prompt Detection Logic

**File**: `src/lib/prompt-detector.ts` (NEW)

```typescript
import type { PromptData } from '@/types/models';

/**
 * Prompt detection result
 */
export interface PromptDetectionResult {
  isPrompt: boolean;
  promptData?: PromptData;
  cleanContent: string;  // Content without prompt suffix
}

/**
 * Detect if output contains an interactive prompt
 */
export function detectPrompt(output: string): PromptDetectionResult {
  const lines = output.split('\n');
  const lastLines = lines.slice(-10).join('\n');

  // Pattern 1: (y/n)
  const yesNoPattern = /^(.+)\s+\(y\/n\)\s*$/m;
  const match1 = lastLines.match(yesNoPattern);
  if (match1) {
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: match1[1].trim(),
        options: ['yes', 'no'],
        status: 'pending'
      },
      cleanContent: match1[1].trim()
    };
  }

  // Pattern 2: [y/N] (N is default)
  const yesNoDefaultPattern = /^(.+)\s+\[y\/N\]\s*$/m;
  const match2 = lastLines.match(yesNoDefaultPattern);
  if (match2) {
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: match2[1].trim(),
        options: ['yes', 'no'],
        status: 'pending',
        defaultOption: 'no'
      },
      cleanContent: match2[1].trim()
    };
  }

  // Pattern 3: [Y/n] (Y is default)
  const yesDefaultPattern = /^(.+)\s+\[Y\/n\]\s*$/m;
  const match3 = lastLines.match(yesDefaultPattern);
  if (match3) {
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: match3[1].trim(),
        options: ['yes', 'no'],
        status: 'pending',
        defaultOption: 'yes'
      },
      cleanContent: match3[1].trim()
    };
  }

  // Pattern 4: (yes/no)
  const yesNoFullPattern = /^(.+)\s+\(yes\/no\)\s*$/m;
  const match4 = lastLines.match(yesNoFullPattern);
  if (match4) {
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: match4[1].trim(),
        options: ['yes', 'no'],
        status: 'pending'
      },
      cleanContent: match4[1].trim()
    };
  }

  // Pattern 5: Approve?
  const approvePattern = /^(.+)\s+Approve\?\s*$/m;
  const match5 = lastLines.match(approvePattern);
  if (match5) {
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: match5[1].trim() + ' Approve?',
        options: ['yes', 'no'],
        status: 'pending'
      },
      cleanContent: match5[1].trim()
    };
  }

  // No prompt detected
  return {
    isPrompt: false,
    cleanContent: output.trim()
  };
}

/**
 * Get tmux input for answer
 */
export function getAnswerInput(answer: string): string {
  const normalized = answer.toLowerCase();

  if (normalized === 'yes' || normalized === 'y') {
    return 'y';
  }

  if (normalized === 'no' || normalized === 'n') {
    return 'n';
  }

  throw new Error(`Invalid answer: ${answer}`);
}
```

---

### 2. Database Functions Update

**File**: `src/lib/db.ts` (MODIFY)

```typescript
/**
 * Create a new chat message (extended signature)
 */
export function createMessage(
  db: Database.Database,
  message: Omit<ChatMessage, 'id'>
): ChatMessage {
  const id = generateUUID();

  const stmt = db.prepare(`
    INSERT INTO chat_messages
    (id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    message.worktreeId,
    message.role,
    message.content,
    message.summary || null,
    message.timestamp.getTime(),
    message.logFileName || null,
    message.requestId || null,
    message.messageType || 'normal',
    message.promptData ? JSON.stringify(message.promptData) : null
  );

  // Update worktree's updated_at timestamp
  updateWorktreeTimestamp(db, message.worktreeId, message.timestamp);

  return { id, ...message };
}

/**
 * Get messages for a worktree (with prompt data)
 */
export function getMessages(
  db: Database.Database,
  worktreeId: string,
  before?: Date,
  limit: number = 50
): ChatMessage[] {
  const stmt = db.prepare(`
    SELECT
      id, worktree_id, role, content, summary, timestamp,
      log_file_name, request_id, message_type, prompt_data
    FROM chat_messages
    WHERE worktree_id = ? AND (? IS NULL OR timestamp < ?)
    ORDER BY timestamp ASC
    LIMIT ?
  `);

  const beforeTs = before?.getTime() || null;

  const rows = stmt.all(worktreeId, beforeTs, beforeTs, limit) as Array<{
    id: string;
    worktree_id: string;
    role: string;
    content: string;
    summary: string | null;
    timestamp: number;
    log_file_name: string | null;
    request_id: string | null;
    message_type: string | null;
    prompt_data: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    worktreeId: row.worktree_id,
    role: row.role as 'user' | 'claude',
    content: row.content,
    summary: row.summary || undefined,
    timestamp: new Date(row.timestamp),
    logFileName: row.log_file_name || undefined,
    requestId: row.request_id || undefined,
    messageType: (row.message_type as MessageType) || 'normal',
    promptData: row.prompt_data ? JSON.parse(row.prompt_data) : undefined,
  }));
}

/**
 * Update prompt data for a message
 */
export function updatePromptData(
  db: Database.Database,
  messageId: string,
  promptData: PromptData
): void {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET prompt_data = ?
    WHERE id = ?
  `);

  stmt.run(JSON.stringify(promptData), messageId);
}

/**
 * Get message by ID
 */
export function getMessageById(
  db: Database.Database,
  messageId: string
): ChatMessage | null {
  const stmt = db.prepare(`
    SELECT
      id, worktree_id, role, content, summary, timestamp,
      log_file_name, request_id, message_type, prompt_data
    FROM chat_messages
    WHERE id = ?
  `);

  const row = stmt.get(messageId) as any;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    worktreeId: row.worktree_id,
    role: row.role as 'user' | 'claude',
    content: row.content,
    summary: row.summary || undefined,
    timestamp: new Date(row.timestamp),
    logFileName: row.log_file_name || undefined,
    requestId: row.request_id || undefined,
    messageType: (row.message_type as MessageType) || 'normal',
    promptData: row.prompt_data ? JSON.parse(row.prompt_data) : undefined,
  };
}
```

---

### 3. Poller Update

**File**: `src/lib/claude-poller.ts` (MODIFY)

```typescript
import { detectPrompt } from './prompt-detector';

/**
 * Check for Claude response once
 */
async function checkForResponse(worktreeId: string): Promise<boolean> {
  const db = getDbInstance();

  try {
    // Check if Claude session is running
    const running = await isClaudeRunning(worktreeId);
    if (!running) {
      console.log(`Claude session not running for ${worktreeId}, stopping poller`);
      stopPolling(worktreeId);
      return false;
    }

    // Get session state
    const sessionState = getSessionState(db, worktreeId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output
    const output = await captureClaudeOutput(worktreeId, 10000);

    // Check for normal completion first
    const result = extractClaudeResponse(output, lastCapturedLine);

    if (!result) {
      return false;
    }

    if (!result.isComplete) {
      updateSessionState(db, worktreeId, result.lineCount);
      return false;
    }

    // Response is complete - check if it's a prompt
    const promptDetection = detectPrompt(result.response);

    if (promptDetection.isPrompt) {
      // This is a prompt!
      console.log(`✓ Detected prompt for ${worktreeId}:`, promptDetection.promptData?.question);

      const message = createMessage(db, {
        worktreeId,
        role: 'claude',
        content: promptDetection.cleanContent,
        messageType: 'prompt',
        promptData: promptDetection.promptData,
        timestamp: new Date(),
      });

      // Update session state
      updateSessionState(db, worktreeId, result.lineCount);

      // Broadcast to WebSocket clients
      broadcastMessage('message', {
        worktreeId,
        message,
      });

      console.log(`✓ Saved prompt message for ${worktreeId}`);

      // Stop polling - waiting for user response
      stopPolling(worktreeId);

      return true;
    }

    // Normal response (not a prompt)
    console.log(`✓ Detected Claude response for ${worktreeId}`);

    // Get the last user message
    const messages = getMessages(db, worktreeId);
    const lastUserMessage = messages
      .filter((m) => m.role === 'user')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    // Create Markdown log file
    if (lastUserMessage && result.response) {
      try {
        await createLog(worktreeId, lastUserMessage.content, result.response);
      } catch (error) {
        console.error('Failed to create log file:', error);
      }
    }

    // Create normal Claude message
    const message = createMessage(db, {
      worktreeId,
      role: 'claude',
      content: result.response,
      messageType: 'normal',
      timestamp: new Date(),
    });

    // Update session state
    updateSessionState(db, worktreeId, result.lineCount);

    // Broadcast to WebSocket
    broadcastMessage('message', {
      worktreeId,
      message,
    });

    console.log(`✓ Saved Claude response for ${worktreeId}`);

    // Stop polling
    stopPolling(worktreeId);

    return true;
  } catch (error: any) {
    console.error(`Error checking for response (${worktreeId}):`, error.message);
    return false;
  }
}
```

---

### 4. API Endpoint

**File**: `src/app/api/worktrees/[id]/respond/route.ts` (NEW)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getMessageById, updatePromptData } from '@/lib/db';
import { sendKeys } from '@/lib/tmux';
import { getSessionName } from '@/lib/claude-session';
import { startPolling } from '@/lib/claude-poller';
import { getAnswerInput } from '@/lib/prompt-detector';
import { broadcastMessage } from '@/lib/ws-server';

/**
 * POST /api/worktrees/[id]/respond
 * Send response to Claude prompt
 *
 * Body:
 * {
 *   "messageId": "uuid",
 *   "answer": "yes" | "no"
 * }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { messageId, answer } = await req.json();

    // Validation
    if (!messageId || !answer) {
      return NextResponse.json(
        { error: 'messageId and answer are required' },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Get message
    const message = getMessageById(db, messageId);

    if (!message) {
      return NextResponse.json(
        { error: 'Message not found' },
        { status: 404 }
      );
    }

    if (message.messageType !== 'prompt') {
      return NextResponse.json(
        { error: 'Message is not a prompt' },
        { status: 400 }
      );
    }

    if (!message.promptData) {
      return NextResponse.json(
        { error: 'Prompt data not found' },
        { status: 400 }
      );
    }

    if (message.promptData.status === 'answered') {
      return NextResponse.json(
        { error: 'Prompt already answered' },
        { status: 400 }
      );
    }

    // Update prompt data
    const updatedPromptData = {
      ...message.promptData,
      status: 'answered' as const,
      answer,
      answeredAt: new Date().toISOString(),
    };

    updatePromptData(db, messageId, updatedPromptData);

    // Send answer to tmux
    const sessionName = getSessionName(params.id);
    const input = getAnswerInput(answer);

    await sendKeys(sessionName, input, true);

    console.log(`✓ Sent answer '${input}' to ${sessionName}`);

    // Broadcast updated message
    const updatedMessage = {
      ...message,
      promptData: updatedPromptData,
    };

    broadcastMessage('message_updated', {
      worktreeId: params.id,
      message: updatedMessage,
    });

    // Resume polling for Claude's next response
    startPolling(params.id);

    console.log(`✓ Resumed polling for ${params.id}`);

    return NextResponse.json({
      success: true,
      message: updatedMessage,
    });
  } catch (error: any) {
    console.error('Failed to respond to prompt:', error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
```

---

## Frontend Implementation

### 1. Prompt Message Component

**File**: `src/components/worktree/PromptMessage.tsx` (NEW)

```tsx
'use client';

import { useState } from 'react';
import type { ChatMessage } from '@/types/models';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';

export interface PromptMessageProps {
  message: ChatMessage;
  worktreeId: string;
  onRespond: (answer: string) => Promise<void>;
}

export function PromptMessage({ message, worktreeId, onRespond }: PromptMessageProps) {
  const [responding, setResponding] = useState(false);
  const prompt = message.promptData!;
  const isPending = prompt.status === 'pending';
  const timestamp = format(new Date(message.timestamp), 'PPp', { locale: ja });

  const handleRespond = async (answer: string) => {
    setResponding(true);
    try {
      await onRespond(answer);
    } catch (error) {
      console.error('Failed to respond:', error);
      alert('Failed to send response. Please try again.');
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-4 shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">⚠️</span>
            <span className="font-bold text-yellow-800">Claudeからの確認</span>
          </div>
          <span className="text-xs text-yellow-600">{timestamp}</span>
        </div>

        {/* Question */}
        <div className="mb-4">
          <p className="text-base text-gray-800 leading-relaxed">
            {prompt.question}
          </p>
        </div>

        {/* Actions */}
        {isPending ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => handleRespond('yes')}
              disabled={responding}
              className={`
                px-6 py-2 rounded-lg font-medium transition-all
                bg-blue-600 text-white hover:bg-blue-700
                disabled:opacity-50 disabled:cursor-not-allowed
                focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
              `}
            >
              Yes
            </button>
            <button
              onClick={() => handleRespond('no')}
              disabled={responding}
              className={`
                px-6 py-2 rounded-lg font-medium transition-all
                bg-white border-2 border-gray-300 hover:bg-gray-50
                disabled:opacity-50 disabled:cursor-not-allowed
                focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2
              `}
            >
              No
            </button>
            {responding && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-blue-600" />
                <span>送信中...</span>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white border border-gray-300 rounded-lg px-4 py-2 inline-block">
            <span className="text-sm text-gray-600">
              ✅ 回答済み: <strong className="text-gray-900">{prompt.answer}</strong>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
```

---

### 2. Update MessageList Component

**File**: `src/components/worktree/MessageList.tsx` (MODIFY)

```tsx
import { PromptMessage } from './PromptMessage';

export function MessageList({ messages, worktreeId, loading = false }: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /**
   * Handle prompt response
   */
  const handlePromptResponse = async (messageId: string, answer: string) => {
    const response = await fetch(`/api/worktrees/${worktreeId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, answer }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to send response');
    }

    // Message will be updated via WebSocket broadcast
  };

  // ... loading and empty states

  return (
    <Card padding="lg" className="h-[600px] flex flex-col">
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {messages.map((message) => {
          // Render prompt message
          if (message.messageType === 'prompt') {
            return (
              <PromptMessage
                key={message.id}
                message={message}
                worktreeId={worktreeId}
                onRespond={(answer) => handlePromptResponse(message.id, answer)}
              />
            );
          }

          // Render normal message
          return <MessageBubble key={message.id} message={message} />;
        })}
        <div ref={messagesEndRef} />
      </div>
    </Card>
  );
}
```

---

### 3. Update WorktreeDetail to pass worktreeId

**File**: `src/components/worktree/WorktreeDetail.tsx` (MODIFY)

```tsx
export function WorktreeDetail({ worktree }: WorktreeDetailProps) {
  // ... existing code

  return (
    <div className="space-y-6">
      {/* ... existing components */}

      {/* Message List - pass worktreeId */}
      <MessageList
        messages={messages}
        worktreeId={worktree.id}  {/* Add this */}
        loading={messagesLoading}
      />

      {/* ... rest of components */}
    </div>
  );
}
```

---

## Migration Script

**File**: `scripts/migrate-prompt-support.ts` (NEW)

```typescript
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'mcbd.db');

function migrate() {
  const db = new Database(DB_PATH);

  try {
    console.log('Starting migration: add prompt support...');

    // Add message_type column
    db.exec(`
      ALTER TABLE chat_messages
      ADD COLUMN message_type TEXT DEFAULT 'normal';
    `);
    console.log('✓ Added message_type column');

    // Add prompt_data column
    db.exec(`
      ALTER TABLE chat_messages
      ADD COLUMN prompt_data TEXT;
    `);
    console.log('✓ Added prompt_data column');

    // Create index
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_type
      ON chat_messages(message_type, worktree_id);
    `);
    console.log('✓ Created index on message_type');

    // Backfill existing messages
    const result = db.prepare(`
      UPDATE chat_messages
      SET message_type = 'normal'
      WHERE message_type IS NULL
    `).run();
    console.log(`✓ Backfilled ${result.changes} existing messages`);

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    db.close();
  }
}

migrate();
```

---

## Testing Plan

### Unit Tests

**File**: `tests/unit/prompt-detector.test.ts` (NEW)

```typescript
import { describe, it, expect } from 'vitest';
import { detectPrompt, getAnswerInput } from '@/lib/prompt-detector';

describe('prompt-detector', () => {
  describe('detectPrompt', () => {
    it('should detect (y/n) pattern', () => {
      const output = 'Do you want to proceed? (y/n)';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('yes_no');
      expect(result.promptData?.question).toBe('Do you want to proceed?');
      expect(result.promptData?.options).toEqual(['yes', 'no']);
    });

    it('should detect [y/N] pattern with default', () => {
      const output = 'Continue? [y/N]';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.defaultOption).toBe('no');
    });

    it('should detect [Y/n] pattern with default', () => {
      const output = 'Proceed? [Y/n]';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.defaultOption).toBe('yes');
    });

    it('should not detect normal messages', () => {
      const output = 'Here is your response.';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });

    it('should handle multiline output', () => {
      const output = `
        I will delete the file.
        Do you want to proceed? (y/n)
      `;
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
    });
  });

  describe('getAnswerInput', () => {
    it('should convert "yes" to "y"', () => {
      expect(getAnswerInput('yes')).toBe('y');
    });

    it('should convert "no" to "n"', () => {
      expect(getAnswerInput('no')).toBe('n');
    });

    it('should handle case insensitive', () => {
      expect(getAnswerInput('YES')).toBe('y');
      expect(getAnswerInput('No')).toBe('n');
    });

    it('should throw on invalid input', () => {
      expect(() => getAnswerInput('maybe')).toThrow();
    });
  });
});
```

### Integration Tests

**File**: `tests/integration/prompt-flow.test.ts` (NEW)

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDbInstance } from '@/lib/db-instance';
import { createMessage, getMessageById, updatePromptData } from '@/lib/db';

describe('Prompt Flow Integration', () => {
  let db: any;

  beforeAll(() => {
    db = getDbInstance();
  });

  it('should create and retrieve prompt message', () => {
    const message = createMessage(db, {
      worktreeId: 'test-worktree',
      role: 'claude',
      content: 'Do you want to proceed?',
      messageType: 'prompt',
      promptData: {
        type: 'yes_no',
        question: 'Do you want to proceed?',
        options: ['yes', 'no'],
        status: 'pending',
      },
      timestamp: new Date(),
    });

    expect(message.id).toBeDefined();
    expect(message.messageType).toBe('prompt');

    const retrieved = getMessageById(db, message.id);
    expect(retrieved?.messageType).toBe('prompt');
    expect(retrieved?.promptData?.status).toBe('pending');
  });

  it('should update prompt data on answer', () => {
    const message = createMessage(db, {
      worktreeId: 'test-worktree',
      role: 'claude',
      content: 'Approve?',
      messageType: 'prompt',
      promptData: {
        type: 'yes_no',
        question: 'Approve?',
        options: ['yes', 'no'],
        status: 'pending',
      },
      timestamp: new Date(),
    });

    updatePromptData(db, message.id, {
      ...message.promptData!,
      status: 'answered',
      answer: 'yes',
      answeredAt: new Date().toISOString(),
    });

    const updated = getMessageById(db, message.id);
    expect(updated?.promptData?.status).toBe('answered');
    expect(updated?.promptData?.answer).toBe('yes');
  });
});
```

### Manual Testing Checklist

```
□ Create new worktree and start Claude session
□ Send message that triggers bash execution
□ Verify prompt is displayed with Yes/No buttons
□ Click "Yes" button
  □ Verify button shows loading state
  □ Verify tmux receives 'y' input
  □ Verify Claude continues execution
  □ Verify prompt status updates to "answered"
□ Click "No" button
  □ Verify tmux receives 'n' input
  □ Verify Claude cancels operation
□ Test with multiple prompts in sequence
□ Test WebSocket real-time updates
□ Test message history persistence
□ Test with worktree that has no prompts (normal flow)
```

---

## Implementation Tasks

### Phase 1 Tasks (Priority Order)

1. **Database & Types** (Day 1, Morning)
   - [ ] Add TypeScript types to `src/types/models.ts`
   - [ ] Create migration script `scripts/migrate-prompt-support.ts`
   - [ ] Run migration on development database
   - [ ] Update `src/lib/db.ts` functions
   - [ ] Add unit tests for database functions

2. **Backend Logic** (Day 1, Afternoon)
   - [ ] Create `src/lib/prompt-detector.ts`
   - [ ] Add unit tests for prompt detector
   - [ ] Update `src/lib/claude-poller.ts`
   - [ ] Test prompt detection in isolation

3. **API Endpoint** (Day 2, Morning)
   - [ ] Create `src/app/api/worktrees/[id]/respond/route.ts`
   - [ ] Add error handling and validation
   - [ ] Test API with curl/Postman
   - [ ] Add integration tests

4. **Frontend Components** (Day 2, Afternoon)
   - [ ] Create `src/components/worktree/PromptMessage.tsx`
   - [ ] Update `src/components/worktree/MessageList.tsx`
   - [ ] Update `src/components/worktree/WorktreeDetail.tsx`
   - [ ] Test UI rendering with mock data

5. **Integration Testing** (Day 3, Morning)
   - [ ] Test complete flow end-to-end
   - [ ] Test WebSocket updates
   - [ ] Test multiple prompts in sequence
   - [ ] Test error scenarios

6. **Documentation & Cleanup** (Day 3, Afternoon)
   - [ ] Update README with prompt handling info
   - [ ] Add inline code documentation
   - [ ] Clean up console logs
   - [ ] Prepare for code review

---

## Deployment Checklist

```
□ Run migration script on production database
□ Backup database before migration
□ Test migration on staging environment first
□ Verify existing messages still work
□ Monitor for errors in production logs
□ Prepare rollback plan if needed
```

---

## Future Enhancements (Phase 2+)

### Phase 2: Extended Prompt Types
- Multiple choice prompts (1/2/3)
- Character choice prompts (r/s/a)
- Timeout handling
- Default option auto-selection

### Phase 3: Advanced Inputs
- Text input prompts
- Password input (hidden)
- Multiline text input
- Validation and constraints

### Phase 4: UX Improvements
- Keyboard shortcuts (Enter for Yes, Esc for No)
- Prompt preview before sending
- Undo/cancel response
- Prompt templates and presets

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Pattern matching fails for unknown prompts | Medium | Medium | Add logging for undetected patterns, allow manual tmux access |
| Database migration fails | Low | High | Test on staging first, maintain backups, prepare rollback script |
| WebSocket updates don't reach client | Low | Medium | Add HTTP polling fallback, retry logic |
| Concurrent prompt handling | Low | Low | Implement request locking per worktree |
| Performance impact from polling | Low | Low | Optimize regex patterns, consider caching |

---

## Success Metrics

- ✅ 80%+ of Claude prompts detected correctly
- ✅ < 500ms response time for API endpoint
- ✅ Zero data loss during migration
- ✅ 100% of manual test cases pass
- ✅ No production errors in first week

---

## Appendix

### Example Prompt Patterns from Claude CLI

```
1. "Do you want to proceed? (y/n)"
2. "Continue? [y/N]"
3. "Proceed? [Y/n]"
4. "Use bash to run: git commit -m 'test'\n─────────────────────\nApprove? (y/n)"
5. "This will overwrite existing files. Continue? (yes/no)"
6. "⚠️  This command may be destructive\nProceed anyway? (y/n)"
```

### Database Schema (After Migration)

```sql
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'claude')),
  content TEXT NOT NULL,
  summary TEXT,
  timestamp INTEGER NOT NULL,
  log_file_name TEXT,
  request_id TEXT,

  -- New fields
  message_type TEXT DEFAULT 'normal',
  prompt_data TEXT,

  FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_worktree_time ON chat_messages(worktree_id, timestamp DESC);
CREATE INDEX idx_messages_request_id ON chat_messages(request_id);
CREATE INDEX idx_messages_type ON chat_messages(message_type, worktree_id);
```

---

**Plan Status**: Draft
**Last Updated**: 2025-11-17
**Next Review**: After Phase 1 completion

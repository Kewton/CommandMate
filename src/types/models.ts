/**
 * Data models for myCodeBranchDesk
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * Worktree representation
 */
export interface Worktree {
  /** URL-safe ID (e.g., "main", "feature-foo") */
  id: string;
  /** Display name (e.g., "main", "feature/foo") */
  name: string;
  /** Absolute path to worktree directory */
  path: string;
  /** Repository root path (e.g., "/path/to/repo") */
  repositoryPath: string;
  /** Repository display name (e.g., "MyProject") */
  repositoryName: string;
  /** User memo for this worktree */
  memo?: string;
  /** Latest user message content (truncated to ~200 chars) */
  lastUserMessage?: string;
  /** Timestamp of latest user message */
  lastUserMessageAt?: Date;
  /** Summary of last message (for list view) - DEPRECATED: use lastUserMessage instead */
  lastMessageSummary?: string;
  /** Latest messages per CLI tool (truncated to 50 chars each) */
  lastMessagesByCli?: {
    claude?: string;
    codex?: string;
    gemini?: string;
  };
  /** Last updated timestamp */
  updatedAt?: Date;
  /** Whether a tmux session is currently running for this worktree */
  isSessionRunning?: boolean;
  /** Whether this worktree is waiting for Claude's response */
  isWaitingForResponse?: boolean;
  /** Session status per CLI tool */
  sessionStatusByCli?: {
    claude?: { isRunning: boolean; isWaitingForResponse: boolean };
    codex?: { isRunning: boolean; isWaitingForResponse: boolean };
    gemini?: { isRunning: boolean; isWaitingForResponse: boolean };
  };
  /** Whether this worktree is marked as favorite */
  favorite?: boolean;
  /** Worktree status: todo, doing, done, or null if not set */
  status?: 'todo' | 'doing' | 'done' | null;
  /** External link URL (e.g., issue tracker, PR, documentation) */
  link?: string;
  /** CLI tool type (claude, codex, gemini) - defaults to 'claude' */
  cliToolId?: CLIToolType;
}

/**
 * Repository representation (for Phase 2 multi-repo management)
 */
export interface Repository {
  /** Repository ID (hash of path) */
  id: string;
  /** Repository display name */
  name: string;
  /** Absolute path to repository root */
  path: string;
  /** Whether this repository is enabled for scanning */
  enabled: boolean;
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
}

/**
 * Chat message role
 */
export type ChatRole = 'user' | 'assistant';

/**
 * Message type discriminator
 */
export type MessageType = 'normal' | 'prompt' | 'prompt_response';

/**
 * Prompt type discriminator
 */
export type PromptType = 'yes_no' | 'multiple_choice' | 'approval' | 'choice' | 'input' | 'continue';

/**
 * Base prompt data interface
 */
export interface BasePromptData {
  /** Type of prompt */
  type: PromptType;
  /** The question being asked */
  question: string;
  /** Current status of the prompt */
  status: 'pending' | 'answered';
  /** User's answer (if status is 'answered') */
  answer?: string;
  /** Timestamp when answered (ISO 8601) */
  answeredAt?: string;
}

/**
 * Yes/No prompt data
 */
export interface YesNoPromptData extends BasePromptData {
  type: 'yes_no';
  /** Available options (always ['yes', 'no']) */
  options: ['yes', 'no'];
  /** Default option if user doesn't respond */
  defaultOption?: 'yes' | 'no';
}

/**
 * Multiple choice option
 */
export interface MultipleChoiceOption {
  /** Option number (e.g., 1, 2, 3) */
  number: number;
  /** Option text/label */
  label: string;
  /** Whether this is the default option (indicated by ❯) */
  isDefault?: boolean;
  /** Whether this option requires text input from the user */
  requiresTextInput?: boolean;
}

/**
 * Multiple choice prompt data
 */
export interface MultipleChoicePromptData extends BasePromptData {
  type: 'multiple_choice';
  /** Available options */
  options: MultipleChoiceOption[];
}

/**
 * Union type for all prompt data types (extensible for future prompt types)
 */
export type PromptData = YesNoPromptData | MultipleChoicePromptData;

/**
 * Chat message
 */
export interface ChatMessage {
  /** Unique message ID (UUID) */
  id: string;
  /** Associated worktree ID */
  worktreeId: string;
  /** Message author role */
  role: ChatRole;
  /** Message content */
  content: string;
  /** Optional summary */
  summary?: string;
  /** Message timestamp */
  timestamp: Date;
  /** Associated log file name (relative path) */
  logFileName?: string;
  /** Request ID for tracking (future use) */
  requestId?: string;
  /** Message type (normal, prompt, etc.) */
  messageType: MessageType;
  /** Prompt data (only for prompt messages) */
  promptData?: PromptData;
  /** CLI tool type (claude, codex, gemini) - defaults to 'claude' */
  cliToolId?: CLIToolType;
}

/**
 * Worktree session state for tmux capture
 */
export interface WorktreeSessionState {
  /** Associated worktree ID */
  worktreeId: string;
  /** CLI tool identifier for this session state */
  cliToolId: CLIToolType;
  /** Last captured line number from tmux */
  lastCapturedLine: number;
  /** ID of the message currently being updated (null when no message is in progress) */
  inProgressMessageId?: string | null;
}

/**
 * File tree item representation
 */
export interface TreeItem {
  /** File or directory name */
  name: string;
  /** Item type: file or directory */
  type: 'file' | 'directory';
  /** File size in bytes (files only) */
  size?: number;
  /** File extension without dot (files only) */
  extension?: string;
  /** Number of items in directory (directories only) */
  itemCount?: number;
}

/**
 * File tree response for directory listing
 */
export interface TreeResponse {
  /** Current directory path (relative to worktree root) */
  path: string;
  /** Current directory name */
  name: string;
  /** Directory items (files and subdirectories) */
  items: TreeItem[];
  /** Parent directory path (null for root) */
  parentPath: string | null;
}

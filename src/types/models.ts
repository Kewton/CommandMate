/**
 * Data models for myCodeBranchDesk
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * Git status information for a worktree
 * Issue #111: Branch visualization feature
 *
 * @remarks
 * New fields should be optional (?) for backward compatibility
 *
 * @future Potential extensions:
 * - aheadBehind?: { ahead: number; behind: number } - Remote difference (separate Issue)
 * - stashCount?: number - Number of stashes
 * - lastCommitMessage?: string - Latest commit message
 */
export interface GitStatus {
  /** Current git branch name (e.g., "main", "feature/xxx", "(detached HEAD)", "(unknown)") */
  currentBranch: string;
  /** Branch name at session start (null if not recorded) */
  initialBranch: string | null;
  /** True if currentBranch differs from initialBranch */
  isBranchMismatch: boolean;
  /** Short commit hash (e.g., "abc1234") */
  commitHash: string;
  /** True if there are uncommitted changes */
  isDirty: boolean;
}

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
  /** User description for this worktree */
  description?: string;
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
  /** Timestamp when user last viewed this worktree (for unread tracking) */
  lastViewedAt?: Date;
  /** Timestamp of the most recent assistant message (for unread tracking) */
  lastAssistantMessageAt?: Date;
  /** Whether a tmux session is currently running for this worktree */
  isSessionRunning?: boolean;
  /** Whether this worktree is waiting for Claude's response */
  isWaitingForResponse?: boolean;
  /** Whether Claude is actively processing a request (last message from user) */
  isProcessing?: boolean;
  /** Session status per CLI tool */
  sessionStatusByCli?: {
    claude?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
    codex?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
    gemini?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
  };
  /** Whether this worktree is marked as favorite */
  favorite?: boolean;
  /** Worktree status: todo, doing, done, or null if not set */
  status?: 'todo' | 'doing' | 'done' | null;
  /** External link URL (e.g., issue tracker, PR, documentation) */
  link?: string;
  /** CLI tool type (claude, codex, gemini) - defaults to 'claude' */
  cliToolId?: CLIToolType;
  /** Git status information (Issue #111) - optional for backward compatibility */
  gitStatus?: GitStatus;
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
  /** Instruction text preceding the prompt (context for the user) - Issue #235 */
  instructionText?: string;
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
 * Individual memo item for a worktree
 * Supports up to 5 memos per worktree (position 0-4)
 */
export interface WorktreeMemo {
  /** Unique memo ID (UUID) */
  id: string;
  /** Associated worktree ID */
  worktreeId: string;
  /** Memo title (max 100 characters) */
  title: string;
  /** Memo content (max 10000 characters) */
  content: string;
  /** Position in the memo list (0-4) */
  position: number;
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
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
  /** File creation time (ISO 8601 string) - files only [CO-001] */
  birthtime?: string;
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

/**
 * File content representation
 * [MF-001] Does not include 'success' field - API response is a wrapper
 * that returns { success: true, ...FileContent }
 */
export interface FileContent {
  /** File path relative to worktree root */
  path: string;
  /** File content (text or Base64 data URI for images) */
  content: string;
  /** File extension without dot (e.g., 'md', 'png') */
  extension: string;
  /** Worktree root path */
  worktreePath: string;
  /** Whether the file is an image (optional, for image files) */
  isImage?: boolean;
  /** Whether the file is a video (optional, for video files) - Issue #302 */
  isVideo?: boolean;
  /** MIME type (optional, for image/video files) */
  mimeType?: string;
}

/**
 * API response type for file content (success wrapper)
 * [MF-001] Explicit wrapper type for API responses
 */
export type FileContentResponse = { success: true } & FileContent;

// ============================================================================
// Search Types (Issue #21)
// ============================================================================

/**
 * Search mode - determines whether to search by filename or file content
 * [Issue #21] File tree search functionality
 */
export type SearchMode = 'name' | 'content';

/**
 * Search query parameters
 * [Issue #21] File tree search functionality
 */
export interface SearchQuery {
  /** Search query string */
  query: string;
  /** Search mode: 'name' for filename, 'content' for file content */
  mode: SearchMode;
}

/**
 * Search result containing all matching files
 * [Issue #21] File tree search functionality
 */
export interface SearchResult {
  /** Search mode used */
  mode: SearchMode;
  /** Original search query */
  query: string;
  /** List of matching files */
  results: SearchResultItem[];
  /** Total number of matches found */
  totalMatches: number;
  /** Whether results were truncated (exceeds 100 items) */
  truncated: boolean;
  /** Time taken to execute search in milliseconds */
  executionTimeMs: number;
}

/**
 * Individual search result item
 * [Issue #21] File tree search functionality
 * [SEC-SF-001] filePath is relative path only (no absolute paths exposed)
 * [SEC-SF-002] content is truncated to 500 characters max
 */
export interface SearchResultItem {
  /** File path relative to worktree root (security: no absolute paths) */
  filePath: string;
  /** File name without path */
  fileName: string;
  /** Matching lines with content (for content search mode) */
  matches?: Array<{
    /** Line number (1-based) */
    line: number;
    /** Line content (truncated to 500 characters for security) */
    content: string;
  }>;
}

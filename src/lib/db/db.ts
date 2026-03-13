/**
 * Database operations barrel file
 * Re-exports all public database functions from sub-modules.
 *
 * Issue #479: db.ts split into worktree-db, chat-db, session-db, memo-db, init-db
 * Barrel file maintains backward compatibility for all existing import paths.
 *
 * Note: export * is intentionally avoided (D4-001) to prevent
 * @internal functions from being unintentionally exposed.
 */

// init-db
export { initDatabase } from './init-db';

// worktree-db
export {
  getWorktrees,
  getRepositories,
  getWorktreeById,
  upsertWorktree,
  updateWorktreeDescription,
  updateWorktreeLink,
  updateLastViewedAt,
  updateFavorite,
  updateStatus,
  updateCliToolId,
  updateSelectedAgents,
  updateVibeLocalModel,
  updateVibeLocalContextWindow,
  saveInitialBranch,
  getInitialBranch,
  getWorktreeIdsByRepository,
  deleteRepositoryWorktrees,
  deleteWorktreesByIds,
} from './worktree-db';

// chat-db
export {
  getLastAssistantMessageAt,
  createMessage,
  updateMessageContent,
  getMessages,
  getLastUserMessage,
  getLastMessage,
  deleteAllMessages,
  deleteMessageById,
  deleteMessagesByCliTool,
  updateLastUserMessage,
  getMessageById,
  updatePromptData,
  markPendingPromptsAsAnswered,
} from './chat-db';

// session-db
export {
  getSessionState,
  updateSessionState,
  setInProgressMessageId,
  clearInProgressMessageId,
  deleteSessionState,
} from './session-db';

// memo-db
export {
  getMemosByWorktreeId,
  getMemoById,
  createMemo,
  updateMemo,
  deleteMemo,
  reorderMemos,
} from './memo-db';

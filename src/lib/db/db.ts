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
  getWorktreesByRepository,
  getAllWorktreeIds,
  migrateWorktreeIdPreservingChildren,
  deleteRepositoryWorktrees,
  deleteWorktreesByIds,
} from './worktree-db';

// worktree-alias-db (Issue #1621: old IDs stay resolvable after a rename)
export {
  recordWorktreeAlias,
  resolveWorktreeIdWithAlias,
  getWorktreeAliases,
  getAliasedWorktreeIds,
  type WorktreeAlias,
} from './worktree-alias-db';

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
  deleteMessagesByInstance,
  updateLastUserMessage,
  clearLastUserMessage,
  recomputeLastUserMessage,
  getMessageById,
  updatePromptData,
  markPendingPromptsAsAnswered,
  ACTIVE_FILTER,
  getMessagesByDateRange,
} from './chat-db';
export type { GetMessagesOptions, GetMessagesByDateRangeOptions } from './chat-db';

// session-db
export {
  getSessionState,
  updateSessionState,
  setInProgressMessageId,
  clearInProgressMessageId,
  deleteSessionState,
} from './session-db';

// agent-instances-db (Issue #868)
export {
  getAgentInstances,
  getAgentInstance,
  countAgentInstances,
  setAgentInstances,
  addAgentInstance,
  removeAgentInstance,
  AgentInstanceLimitError,
  InvalidAgentInstanceError,
} from './agent-instances-db';

// memo-db
export {
  getMemosByWorktreeId,
  getMemoById,
  createMemo,
  updateMemo,
  deleteMemo,
  reorderMemos,
  MemoDbError,
} from './memo-db';

// todo-db (repository-scoped Home ToDo widget)
export {
  getTodosByRepositoryId,
  getAllTodos,
  getTodoById,
  createTodo,
  updateTodo,
  deleteTodo,
} from './todo-db';
export type { RepositoryTodo } from './todo-db';

// worktree-todo-db (branch-scoped ToDo list, Issue #1015)
// Aliased to avoid colliding with the repository-scoped todo-db exports above.
export {
  getTodosByWorktreeId,
  getTodoById as getWorktreeTodoById,
  createTodo as createWorktreeTodo,
  updateTodo as updateWorktreeTodo,
  deleteTodo as deleteWorktreeTodo,
  reorderTodos as reorderWorktreeTodos,
  isWorktreeTodoStatus,
  WORKTREE_TODO_STATUSES,
} from './worktree-todo-db';
export type { WorktreeTodo, WorktreeTodoStatus } from './worktree-todo-db';

// timer-db (Issue #534, #540)
export {
  createTimer,
  getTimersByWorktree,
  getTimerById,
  getPendingTimers,
  updateTimerStatus,
  cancelTimer,
  cancelTimersByWorktree,
  getPendingTimerCountByWorktree,
  cleanupOldTimers,
  clearTimerHistory,
  recoverStuckSendingTimers,
} from './timer-db';
export type { TimerMessage, CreateTimerParams, GetTimerOptions } from './timer-db';

// daily-report-db (Issue #607)
export {
  getDailyReport,
  saveDailyReport,
  updateDailyReportContent,
} from './daily-report-db';
export type { DailyReport } from './daily-report-db';

// assistant-conversation-db
export {
  getAssistantConversationById,
  getAssistantConversationByRepositoryAndCliTool,
  createAssistantConversation,
  updateAssistantConversation,
  createAssistantMessage,
  updateAssistantMessageStatus,
  getAssistantMessages,
  getAssistantMessageById,
  archiveAllAssistantMessages,
  archiveAssistantMessagesFrom,
  createAssistantExecution,
  updateAssistantExecution,
  getAssistantExecutionById,
  getLatestAssistantExecutionByConversation,
  getRunningAssistantExecutionByConversation,
  listRunningAssistantExecutions,
  getAssistantSessionState,
  updateAssistantSessionState,
  deleteAssistantSessionState,
} from './assistant-conversation-db';
export type {
  AssistantConversation,
  AssistantConversationStatus,
  AssistantConversationExecutionMode,
  AssistantMessage,
  AssistantMessageRole,
  AssistantMessageType,
  AssistantMessageDeliveryStatus,
  AssistantExecution,
  AssistantExecutionStatus,
  AssistantSessionState,
} from './assistant-conversation-db';

// push-subscriptions-db (Web Push, Issue #1125)
export {
  upsertPushSubscription,
  getPushSubscriptionByEndpoint,
  getAllPushSubscriptions,
  getPushSubscriptionsForKind,
  updatePushSubscriptionPreferences,
  deletePushSubscriptionByEndpoint,
} from './push-subscriptions-db';
export type {
  PushSubscriptionRecord,
  UpsertPushSubscriptionInput,
  PushNotificationKind,
} from './push-subscriptions-db';

// verification-db (verification gate runs, Issue #1542)
export {
  createVerificationRun,
  finishVerificationRun,
  createGateResult,
  finishGateResult,
  getVerificationRun,
  listVerificationRuns,
  getRunningVerificationRun,
  listRunningVerificationRuns,
  listVerificationRunsForPeriod,
  DEFAULT_RUN_HISTORY_LIMIT,
  MAX_RUN_HISTORY_LIMIT,
  MAX_RUN_HISTORY_DAYS,
  VERIFICATION_TRIGGERS,
} from './verification-db';
export type {
  VerificationRun,
  VerificationRunWithGates,
  VerificationRunWithGateSummaries,
  VerificationGateResult,
  VerificationGateSummary,
  ListVerificationRunsForPeriodOptions,
  VerificationTrigger,
  VerificationRunStatus,
  VerificationRunTerminalStatus,
  VerificationGateStatus,
  VerificationGateTerminalStatus,
  CreateVerificationRunInput,
  CreateGateResultInput,
  FinishGateResultPatch,
  GateExecutionWindow,
} from './verification-db';

// tasks-db (execution contracts, Issue #1545)
export {
  createTask,
  getTask,
  listTasks,
  getActiveTask,
  getActiveTaskForInstance,
  isTerminalTaskStatus,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  ACTIVE_TASK_STATUSES,
} from './tasks-db';
export type {
  Task,
  TaskStatus,
  TerminalTaskStatus,
  CreateTaskInput,
  UpdateTaskStatusPatch,
} from './tasks-db';

// task-events-db (task state machine log, Issue #1548).
// `updateTaskStatus` and `insertTaskEvent` are intentionally absent from this
// barrel: `applyTaskEvent` (@/lib/tasks/task-transition-service) is the only
// writer of either, and reaching around it would put a status in the table with
// no event explaining it.
export { listTaskEvents } from './task-events-db';
export type { TaskEventRecord, TaskEventPayload, InsertTaskEventInput } from './task-events-db';

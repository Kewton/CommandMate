/**
 * ToDo Configuration Constants
 *
 * Worktree(branch)-scoped ToDo list (Issue #1015):
 *   - API route: src/app/api/worktrees/[id]/todos/route.ts (POST validation)
 *   - Client component: src/components/worktree/TodoPane.tsx
 *
 * The repository-scoped Home ToDo UI was removed in Issue #2643; its API and
 * DB access module were removed in Issue #2650.
 */

/** Maximum number of ToDo items allowed per worktree (branch), Issue #1015. */
export const MAX_TODOS_PER_WORKTREE = 50;

/** Maximum length (characters) of a single ToDo's content. */
export const MAX_TODO_CONTENT_LENGTH = 2000;

/**
 * Maximum length (characters) of a worktree ToDo's free-text detail (Issue #1034).
 */
export const MAX_TODO_DETAIL_LENGTH = 4000;

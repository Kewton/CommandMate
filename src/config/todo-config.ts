/**
 * ToDo Configuration Constants
 *
 * Two independent, coexisting ToDo features (Issue #1015):
 * - Repository-scoped Home ToDo widget:
 *   - API route: src/app/api/repositories/[id]/todos/route.ts (POST validation)
 *   - Client component: src/components/home/TodoWidget.tsx
 * - Worktree(branch)-scoped ToDo list:
 *   - API route: src/app/api/worktrees/[id]/todos/route.ts (POST validation)
 *   - Client component: src/components/worktree/TodoPane.tsx
 *
 * The per-scope count limits are separate constants (semantically distinct
 * scopes), while the content-length limit is shared.
 */

/** Maximum number of ToDo items allowed per repository. */
export const MAX_TODOS_PER_REPOSITORY = 50;

/** Maximum number of ToDo items allowed per worktree (branch), Issue #1015. */
export const MAX_TODOS_PER_WORKTREE = 50;

/** Maximum length (characters) of a single ToDo's content (shared by both scopes). */
export const MAX_TODO_CONTENT_LENGTH = 2000;

/**
 * Maximum length (characters) of a worktree ToDo's free-text detail (Issue #1034).
 * Scoped to branch ToDos only; repository ToDos have no detail field.
 */
export const MAX_TODO_DETAIL_LENGTH = 4000;

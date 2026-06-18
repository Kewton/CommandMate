/**
 * Repository ToDo Configuration Constants
 *
 * Global Home ToDo feature: lightweight, checkbox-style notes scoped to a
 * repository. Shared between the API route and the Home TodoWidget component.
 *
 * - API route: src/app/api/repositories/[id]/todos/route.ts (POST validation)
 * - Client component: src/components/home/TodoWidget.tsx (UI display control)
 */

/** Maximum number of ToDo items allowed per repository. */
export const MAX_TODOS_PER_REPOSITORY = 50;

/** Maximum length (characters) of a single ToDo's content. */
export const MAX_TODO_CONTENT_LENGTH = 2000;

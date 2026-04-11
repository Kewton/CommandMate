/**
 * Repository Configuration Constants
 *
 * Issue #644: Repository list display and inline display_name edit UI.
 *
 * Shared constants used across:
 * - API route: src/app/api/repositories/[id]/route.ts (PUT validation)
 * - Client component: src/components/repository/RepositoryList.tsx (client-side validation)
 */

/**
 * Maximum length for repository display_name (alias).
 *
 * Defined once here to keep the server-side validation and the client-side
 * validation (RepositoryList) in sync. Changing this value will propagate to
 * both the API route and the inline editor UI automatically.
 */
export const MAX_DISPLAY_NAME_LENGTH = 100;

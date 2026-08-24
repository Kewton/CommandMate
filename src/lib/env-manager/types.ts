/**
 * Env Manager — the shape of what crosses the wire (Issue #1968).
 *
 * Lives in `src/lib/env-manager/` rather than in the route because a Next.js
 * App Router `route.ts` may only export the HTTP method handlers and the route
 * segment config — `scripts/check-route-exports.mjs` fails the build for
 * anything else, and an `export interface` there would be exactly that.
 */

import type { EnvEntry, EnvIssue } from './env-parser';

/** One env file as offered in the picker. */
export interface EnvFileSummary {
  /** Allow-listed file name, e.g. `.env` (always a bare name, never a path). */
  name: string;
  /** False for a name that is offered so it can be created. */
  exists: boolean;
  /** Size in bytes; 0 when the file does not exist. */
  size: number;
  /** Last modification time (ISO-8601), or null when the file does not exist. */
  mtime: string | null;
  /** True for `.env.example` / `.env.sample` — the suggestion sources. */
  isExample: boolean;
}

/** A key present in a template file but missing from the file being edited. */
export interface EnvKeySuggestion {
  key: string;
  /** Which template it came from, e.g. `.env.example`. */
  source: string;
  /**
   * The template's own value for the key, when it is safe to prefill.
   *
   * A template value is a placeholder by convention (`API_KEY=your-key-here`),
   * but a template can be committed with a real value by mistake, so this is
   * masked in the UI exactly like any other value.
   */
  value: string;
}

/** Everything the pane needs about the file currently being edited. */
export interface EnvFileDetail {
  name: string;
  exists: boolean;
  /** Raw file text. Empty string for a file that does not exist yet. */
  content: string;
  /** Parsed entries, in file order. */
  entries: EnvEntry[];
  /** Parse/validation problems. Value-free by construction. */
  issues: EnvIssue[];
  /** Keys defined in a template but not here. */
  suggestions: EnvKeySuggestion[];
}

/** GET /api/worktrees/:id/env response body. */
export interface EnvManagerResponse {
  success: true;
  files: EnvFileSummary[];
  /** Present only when the request named a file. */
  selected?: EnvFileDetail;
}

/** PUT /api/worktrees/:id/env response body. */
export interface EnvSaveResponse {
  success: true;
  file: EnvFileSummary;
  /** Non-blocking problems (e.g. a duplicate key) accepted with the save. */
  issues: EnvIssue[];
}

/** Error body shared by both methods; mirrors the files API. */
export interface EnvErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    /** Present when the failure was a content validation. Never carries values. */
    issues?: EnvIssue[];
  };
}

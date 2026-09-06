/**
 * Is this path a file the worktree actually has? (Issue #2274, shared by #2352)
 *
 * ## Why this is its own module
 *
 * A chat body is prose written by a language model, so even a correctly
 * detected path is only a CLAIM about this worktree. #2274 taught the chat
 * surface to ask the server before opening a tab; #2345 then put the SAME path
 * normalization on both the chat surface and the History column — but the
 * probe stayed a module-private function inside `ChatTranscript.tsx`, so History
 * kept opening a dead tab for a path that chat would have refused with a toast
 * (Issue #2352, measured 2026-09-06 against `:3000`).
 *
 * History importing from `ChatTranscript` would point the dependency the wrong
 * way, so the probe lives here, beside `chat-file-path` (the normalization it
 * follows), and both surfaces import it. Keeping it free of React is what lets
 * the status → verdict table be pinned as a table.
 *
 * ## Why the URL is built exactly the way the file panel builds it
 *
 * `FilePanelContent`, `FileViewer` and `useFileContentPolling` all request
 * `/api/worktrees/<id>/files/<encodePathForUrl(path)>`, and so does this. That
 * is the one property that makes the probe worth having: it has to be as
 * capable as the OPEN it is gating, or it becomes a second, differently-wrong
 * opinion about which paths work.
 *
 * ## Which statuses mean "no" — and why the table must not grow
 *
 * 404 (nothing there, or a directory), 400 (outside the worktree — a path
 * belonging to a different repository) and 403 ([Issue #2014] a deny-tier path,
 * which the panel could not show either). Everything else — 5xx, an aborted
 * request, an offline browser — is `'unknown'`, and the caller opens the panel
 * and lets it report its own error. Widening `'missing'` to cover 500 would
 * announce "not here" for what is really an internal error and hide it; #2349
 * made the files API answer 404 for an absent text file, so this table is
 * correct as it stands and is pinned by `chat-file-probe-2352.test.ts`.
 *
 * @module lib/chat/chat-file-probe
 */

import { encodePathForUrl } from '@/lib/url-path-encoder';

/**
 * The server's answer, reduced to what a click handler can act on.
 *
 * Only `'missing'` stops the open. `'unknown'` deliberately opens: a probe that
 * never reached the server has established nothing about the file.
 */
export type ChatFilePathProbe = 'present' | 'missing' | 'unknown';

/** The slice of a `Response` the verdict depends on. */
export type ChatFileProbeResponse = Pick<Response, 'ok' | 'status'>;

/**
 * The transport the probe goes through. `fetch` itself, or a stand-in in a test
 * — the arguments are exactly the two `fetch` receives.
 */
export type ChatFileProbeFetch = (
  input: string,
  init: RequestInit,
) => Promise<ChatFileProbeResponse>;

/** How the probe asks: a HEAD, never served from cache. */
const PROBE_INIT: RequestInit = { method: 'HEAD', cache: 'no-store' };

/**
 * The URL a probe for `filePath` goes to — identical, by construction, to the
 * URL the file panel would GET for the same path.
 */
export function chatFileProbeUrl(worktreeId: string, filePath: string): string {
  return `/api/worktrees/${encodeURIComponent(worktreeId)}/files/${encodePathForUrl(filePath)}`;
}

/**
 * Turn one response into a verdict. Pure; this IS the table the header
 * describes, and the only place it is written down.
 */
export function classifyChatFileProbeResponse(response: ChatFileProbeResponse): ChatFilePathProbe {
  if (response.ok) return 'present';
  if (response.status === 404 || response.status === 400 || response.status === 403) {
    return 'missing';
  }
  return 'unknown';
}

/** Resolved at call time so a test that stubs the global sees its stub. */
const globalFetch: ChatFileProbeFetch = (input, init) => fetch(input, init);

/**
 * Ask whether `filePath` is a file this worktree actually has.
 *
 * `fetchImpl` defaults to the global `fetch`; a caller that wants the probe
 * without the network (a test, mostly) hands in its own.
 */
export async function probeChatFilePath(
  worktreeId: string,
  filePath: string,
  fetchImpl: ChatFileProbeFetch = globalFetch,
): Promise<ChatFilePathProbe> {
  try {
    const response = await fetchImpl(chatFileProbeUrl(worktreeId, filePath), PROBE_INIT);
    return classifyChatFileProbeResponse(response);
  } catch {
    return 'unknown';
  }
}

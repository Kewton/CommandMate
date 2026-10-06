/**
 * One answer, five replies, every path (Issue #3292) — the shared table.
 *
 * Four places POST an answer to an approval: the PC split
 * (`TerminalSplitPaneContent`), the detail screen's controller
 * (`useWorktreeDetailController`, the phone's `/prompt-response`), the phone's
 * `/respond` (`WorktreeDetailRefactored`) and browser-side Auto-Yes
 * (`useAutoYes`). They were written at different times and read the reply
 * differently: a reply that was not 2xx reached the user on one of them and
 * only the console on two.
 *
 * Each `*.test.ts(x)` beside this file drives ONE path with every row here and
 * reports what the user was left with, so "the paths agree" is a property of
 * the rows rather than of somebody having edited each file. `expected` is what
 * the three handlers a person presses leave behind; `auto-yes.test.ts` says
 * what it can and cannot hold the hook to. `outcome` is what the paths that
 * raise no toast — browser-side Auto-Yes and Command Code's plan review — are
 * held to (Issue #3331, `../prompt-response-outcome-3331/`).
 *
 * Not a test file: vitest collects `*.test.*` only.
 */

/** What the POST comes back with: a reply, or nothing at all. */
export type PromptResponseReply =
  | { status: number; body: unknown }
  | 'network-error';

/** What the user is left with once the handler has finished. */
export interface PromptResponseObserved {
  /** The toast as `[message key, type]`, or null when nothing was said. */
  toast: readonly [string, string] | null;
  /** The approval card is still on screen. */
  cardKept: boolean;
  /** The screen was fetched again. */
  refetched: boolean;
}

export interface PromptResponseCase {
  name: string;
  reply: PromptResponseReply;
  /**
   * What `readPromptResponseOutcome` makes of the reply; a request with no
   * reply is `failed` (Issue #3331: what the paths with no toast are held to).
   */
  outcome: 'answered' | 'refused' | 'failed';
  expected: PromptResponseObserved;
}

const REFUSED = ['worktree.promptResponse.refused', 'warning'] as const;
const FAILED = ['worktree.promptResponse.failed', 'error'] as const;

export const PROMPT_RESPONSE_CASES: readonly PromptResponseCase[] = [
  {
    name: '200 success — the answer was taken',
    reply: { status: 200, body: { success: true } },
    outcome: 'answered',
    expected: { toast: null, cardKept: false, refetched: true },
  },
  {
    name: '200 success:false — the route refused it (#2468)',
    reply: { status: 200, body: { success: false, reason: 'prompt_no_longer_active', answer: '1' } },
    outcome: 'refused',
    expected: { toast: REFUSED, cardKept: true, refetched: true },
  },
  {
    name: '404 decision_not_found — the approval is no longer pending',
    reply: {
      status: 404,
      body: {
        error: "Decision 'per_3292' is not pending for this worktree instance",
        code: 'decision_not_found',
        reason: 'decision_not_found',
      },
    },
    outcome: 'refused',
    expected: { toast: REFUSED, cardKept: true, refetched: true },
  },
  {
    name: '500 — the server failed',
    reply: { status: 500, body: { error: 'Failed to send answer to tmux: no server running' } },
    outcome: 'failed',
    expected: { toast: FAILED, cardKept: true, refetched: true },
  },
  {
    name: 'no reply — the request itself failed',
    reply: 'network-error',
    outcome: 'failed',
    expected: { toast: FAILED, cardKept: true, refetched: true },
  },
];

/** `it.each` rows. */
export const PROMPT_RESPONSE_ROWS = PROMPT_RESPONSE_CASES.map(
  (testCase) => [testCase.name, testCase] as const,
);

/** A JSON reply shaped for both raw `fetch` and the api-client wrapper. */
export function jsonReply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: '',
    headers: {
      get: (name: string) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
  } as unknown as Response;
}

/** What the mocked `fetch` returns for the answer's POST. */
export function replyOf(testCase: PromptResponseCase): Promise<Response> {
  if (testCase.reply === 'network-error') {
    return Promise.reject(new TypeError('Failed to fetch'));
  }
  return Promise.resolve(jsonReply(testCase.reply.status, testCase.reply.body));
}

/** The toast a `showToast` spy was asked for about the answer, or null. */
export function promptResponseToast(
  showToast: { mock: { calls: unknown[][] } },
): readonly [string, string] | null {
  const call = showToast.mock.calls.find(
    ([message]) => typeof message === 'string' && message.startsWith('worktree.promptResponse.'),
  );
  return call ? [String(call[0]), String(call[1])] : null;
}

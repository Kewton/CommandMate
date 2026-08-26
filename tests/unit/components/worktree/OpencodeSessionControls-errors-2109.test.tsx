/**
 * A refused opencode session/share action says why (Issue #2109).
 *
 * The defect this suite pins is not "the wrong message" — it is *no message*.
 * Before #2109 every failure in `OpencodeSessionControls` ended at
 * `console.error`, so the only thing a press produced was the `pending`
 * spinner: it appeared for a frame and left, which is indistinguishable from a
 * button wired to nothing. Both 409s that the routes return are reachable in
 * ordinary use, so this is not a rare path:
 *
 *   - `NO_OPENCODE_PORT` — the pane was stopped, or launched with
 *     `CM_AGENT_HOOKS_INJECT=0`. #2108 reduces it; it does not remove it.
 *   - `NO_OPENCODE_SESSION` — the pane has not run a turn yet. That is a
 *     *normal* state, not a fault.
 *
 * Three properties are asserted, and each of them is a thing a plausible
 * refactor would break:
 *
 *  1. **The two machine-readable codes get dedicated wording, everything else
 *     passes the route's `error` through.** A map that swallowed unknown codes
 *     into one generic sentence would go green on the two named cases and hide
 *     every future code the routes grow.
 *  2. **Exactly one surface fires.** `showToast` when the mount lends one, an
 *     inline chip when it does not — never both, and never neither. The inline
 *     fallback is load-bearing because `WorktreeDetailRefactored.tsx` renders
 *     `MessageInput` *without* `showToast`, so a toast-only fix would leave the
 *     single-pane desktop view as silent as it was before.
 *  3. **Success is unchanged.** An accepted call announces nothing. A fix that
 *     reports outcomes rather than failures would be its own regression.
 *
 * `console.error` is deliberately still called and is stubbed here rather than
 * asserted away: it is the record a bug report needs, and it carries the raw
 * body that the operator-facing sentence does not.
 *
 * The `next-intl` stub returns the key, so the assertions below pin *which
 * string the component asks for*. Whether both dictionaries answer is a
 * separate `describe` at the bottom reading `locales/**` off disk — the split
 * the #2051 suite already uses.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));

import { OpencodeSessionControls } from '@/components/worktree/OpencodeSessionControls';
import { ConfirmProvider } from '@/components/ui';
import type { ShowToast } from '@/types/markdown-editor';
import type { OpencodeShareState } from '@/types/opencode-share';

const WORKTREE_ID = 'wt-2109';
const SESSION_ID = 'ses_2109fc35f3dadffe2uirJpjJ';
const SHARE_URL = 'https://opncd.ai/share/2109abcd';

/** One HTTP answer, in the shape the component's `fetch` calls consume. */
interface Answer {
  ok: boolean;
  status: number;
  statusText?: string;
  body: unknown;
}

const OK_SESSION: Answer = { ok: true, status: 200, body: { action: 'new', accepted: true } };

function shareState(overrides: Partial<OpencodeShareState> = {}): OpencodeShareState {
  return {
    instanceId: 'opencode',
    shareMode: 'manual',
    canShare: true,
    sessionId: SESSION_ID,
    lastShareUrl: null,
    ...overrides,
  };
}

function toResponse(answer: Answer) {
  return {
    ok: answer.ok,
    status: answer.status,
    statusText: answer.statusText ?? '',
    json: async () => answer.body,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
/** Typed as the prop it stands in for, so a signature drift is a type error. */
let showToast: ReturnType<typeof vi.fn<ShowToast>>;

/**
 * Route `fetch` by URL and verb.
 *
 * `session`/`post`/`del` may be an {@link Answer} or a thrower, so the
 * "request never left" path can be driven the same way as a refusal.
 */
function stubFetch(options: {
  state?: OpencodeShareState;
  session?: Answer | (() => never);
  post?: Answer | (() => never);
  del?: Answer | (() => never);
} = {}) {
  const resolve = (answer: Answer | (() => never) | undefined, fallback: Answer) => {
    // `return` rather than a bare call so the union narrows below: the thrower's
    // `never` only makes this branch terminal in a return position.
    if (typeof answer === 'function') return answer();
    return toResponse(answer ?? fallback);
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (String(url).includes('/opencode/share')) {
      if (method === 'POST') {
        return resolve(options.post, { ok: true, status: 200, body: { url: SHARE_URL } });
      }
      if (method === 'DELETE') {
        return resolve(options.del, {
          ok: true,
          status: 200,
          body: { sessionId: SESSION_ID, removed: true },
        });
      }
      return toResponse({ ok: true, status: 200, body: options.state ?? shareState() });
    }
    return resolve(options.session, OK_SESSION);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Mount with the toast surface wired, as `MessageInput` does. */
function renderWithToast() {
  return render(
    <ConfirmProvider>
      <OpencodeSessionControls
        worktreeId={WORKTREE_ID}
        cliToolId="opencode"
        showToast={showToast}
      />
    </ConfirmProvider>
  );
}

/** Mount without one, as `WorktreeDetailRefactored`'s composer does. */
function renderWithoutToast() {
  return render(
    <ConfirmProvider>
      <OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />
    </ConfirmProvider>
  );
}

/** Press share and answer its confirmation dialog. */
async function share() {
  fireEvent.click(await screen.findByTestId('opencode-session-share'));
  fireEvent.click(await screen.findByRole('button', { name: 'shareConfirmLabel' }));
}

/** The message handed to whichever surface fired. */
function toastedMessage(): string {
  expect(showToast).toHaveBeenCalledTimes(1);
  return String(showToast.mock.calls[0][0]);
}

beforeEach(() => {
  showToast = vi.fn<ShowToast>();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the session route’s 409s (the Issue’s reproduction)', () => {
  it('names the missing server when the pane has no opencode port', async () => {
    stubFetch({
      session: {
        ok: false,
        status: 409,
        body: { error: 'No opencode server is attached to this instance', code: 'NO_OPENCODE_PORT' },
      },
    });
    renderWithToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('errorNoPort');
    expect(showToast.mock.calls[0][1]).toBe('error');
  });

  it('names the missing session when fork runs before the first turn', async () => {
    stubFetch({
      session: {
        ok: false,
        status: 409,
        body: { error: 'No opencode session to fork yet', code: 'NO_OPENCODE_SESSION' },
      },
    });
    renderWithToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('errorNoSessionFork');
  });

  it.each(['new', 'list', 'fork'] as const)('reports a refused %s, not only fork', async (action) => {
    stubFetch({
      session: {
        ok: false,
        status: 409,
        body: { error: 'No opencode server is attached to this instance', code: 'NO_OPENCODE_PORT' },
      },
    });
    renderWithToast();

    fireEvent.click(screen.getByTestId(`opencode-session-${action}`));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('errorNoPort');
  });
});

describe('everything that is not one of the two codes', () => {
  it('passes the route’s own error string through unaltered', async () => {
    // The `sync` rule: this component does not have to know every code the
    // routes will ever return, so an unmapped failure shows what the route said.
    stubFetch({
      session: { ok: false, status: 502, body: { error: 'Fork was refused by opencode' } },
    });
    renderWithToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('Fork was refused by opencode');
  });

  it('passes an unmapped code’s error through rather than inventing wording', async () => {
    stubFetch({
      post: {
        ok: false,
        status: 409,
        body: { error: 'Sharing is disabled in this opencode configuration', code: 'SHARE_DISABLED' },
      },
    });
    renderWithToast();
    await share();

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('Sharing is disabled in this opencode configuration');
  });

  it('falls back to statusText when the body carries no error string', async () => {
    stubFetch({
      session: { ok: false, status: 500, statusText: 'Internal Server Error', body: {} },
    });
    renderWithToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('Internal Server Error');
  });

  it('still says something when there is neither an error nor a statusText', async () => {
    stubFetch({ session: { ok: false, status: 500, statusText: '', body: {} } });
    renderWithToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('errorUnknown');
  });

  it('reports a request that never left the browser', async () => {
    stubFetch({
      session: () => {
        throw new Error('Failed to fetch');
      },
    });
    renderWithToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('errorRequestFailed');
  });
});

describe('the share controls (an outcome the operator must not have to guess)', () => {
  it('says why a publish was refused', async () => {
    stubFetch({
      post: {
        ok: false,
        status: 409,
        body: { error: 'No opencode server is attached to this instance', code: 'NO_OPENCODE_PORT' },
      },
    });
    renderWithToast();
    await share();

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('errorNoPort');
    expect(screen.queryByTestId('opencode-share-result')).not.toBeInTheDocument();
  });

  it('uses share wording, not fork wording, for NO_OPENCODE_SESSION', async () => {
    // Same code, different surface. "no session to fork yet" on a share button
    // would name an action the operator did not take.
    stubFetch({
      post: {
        ok: false,
        status: 409,
        body: { error: 'No opencode session to share yet', code: 'NO_OPENCODE_SESSION' },
      },
    });
    renderWithToast();
    await share();

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('errorNoSessionShare');
  });

  it('reports a publish whose 200 carried no url', async () => {
    // `!response.ok || typeof detail.url !== 'string'` is one branch in the
    // component; a 200 with no URL used to leave the operator with no link and
    // no reason, which is the exact failure the Issue describes.
    stubFetch({ post: { ok: true, status: 200, body: { error: 'nothing was minted' } } });
    renderWithToast();
    await share();

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('nothing was minted');
  });

  it('says the page is still up when a revoke fails', async () => {
    stubFetch({ del: { ok: false, status: 502, body: { error: 'opencode refused to unshare' } } });
    renderWithToast();
    await share();

    fireEvent.click(await screen.findByTestId('opencode-session-unshare'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('opencode refused to unshare');
    // The link must stay reachable — it is the only way back to the live page.
    expect(screen.getByTestId('opencode-share-result')).toBeInTheDocument();
  });

  it('says the link was not copied when the clipboard refuses', async () => {
    // Reached on plain HTTP, which is how CommandMate is opened from a phone on
    // the LAN: `navigator.clipboard` is absent and the icon never changed.
    stubFetch();
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('NotAllowedError');
        }),
      },
    });
    renderWithToast();
    await share();

    fireEvent.click(await screen.findByTestId('opencode-share-copy'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastedMessage()).toBe('errorCopyFailed');
  });
});

describe('which surface the message lands on', () => {
  it('renders the reason inline when the mount lends no toast surface', async () => {
    stubFetch({
      session: {
        ok: false,
        status: 409,
        body: { error: 'No opencode server is attached to this instance', code: 'NO_OPENCODE_PORT' },
      },
    });
    renderWithoutToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    const alert = await screen.findByTestId('opencode-session-error');
    expect(alert).toHaveTextContent('errorNoPort');
    expect(alert).toHaveAttribute('role', 'alert');
  });

  it('does not also render the chip when a toast surface exists', async () => {
    stubFetch({
      session: { ok: false, status: 409, body: { error: 'nope', code: 'NO_OPENCODE_PORT' } },
    });
    renderWithToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(screen.queryByTestId('opencode-session-error')).not.toBeInTheDocument();
  });

  it('clears a stale inline reason when the next press succeeds', async () => {
    stubFetch({
      session: { ok: false, status: 409, body: { error: 'nope', code: 'NO_OPENCODE_PORT' } },
    });
    const { rerender } = renderWithoutToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));
    await screen.findByTestId('opencode-session-error');

    // The port came back; the message must not outlive the condition it names.
    stubFetch();
    rerender(
      <ConfirmProvider>
        <OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() =>
      expect(screen.queryByTestId('opencode-session-error')).not.toBeInTheDocument()
    );
  });
});

describe('what must not change', () => {
  it.each(['new', 'list', 'fork'] as const)('announces nothing when %s is accepted', async (action) => {
    stubFetch();
    renderWithToast();

    fireEvent.click(screen.getByTestId(`opencode-session-${action}`));

    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [string, RequestInit?][]).some(([url]) =>
          url.endsWith('/opencode/session')
        )
      ).toBe(true)
    );
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.queryByTestId('opencode-session-error')).not.toBeInTheDocument();
  });

  it('announces nothing when a publish succeeds', async () => {
    stubFetch();
    renderWithToast();
    await share();

    expect(await screen.findByTestId('opencode-share-url')).toHaveAttribute('href', SHARE_URL);
    expect(showToast).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', 'gemini', 'copilot'] as const)(
    'still renders nothing at all for %s',
    (cliToolId) => {
      const { container } = render(
        <OpencodeSessionControls
          worktreeId={WORKTREE_ID}
          cliToolId={cliToolId}
          showToast={showToast}
        />
      );
      expect(container).toBeEmptyDOMElement();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
    }
  );

  it('keeps writing the raw failure to the console for bug reports', async () => {
    stubFetch({
      session: { ok: false, status: 409, body: { error: 'raw body', code: 'NO_OPENCODE_PORT' } },
    });
    renderWithToast();

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(console.error).toHaveBeenCalled());
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .map(String)
      .join(' ');
    expect(logged).toContain('raw body');
  });
});

describe('the dictionaries behind the messages', () => {
  const KEYS = [
    'errorNoPort',
    'errorNoSessionFork',
    'errorNoSessionShare',
    'errorRequestFailed',
    'errorUnknown',
    'errorCopyFailed',
  ];

  function dictionary(locale: string): Record<string, string> {
    const parsed = JSON.parse(
      readFileSync(join(process.cwd(), `locales/${locale}/worktree.json`), 'utf8')
    ) as { opencodeSession: Record<string, string> };
    return parsed.opencodeSession;
  }

  it.each(['ja', 'en'])('locales/%s/worktree.json answers every key', (locale) => {
    // A missing key renders the key path, which would put "errorNoPort" on
    // screen — visible, but no more of an explanation than the silence was.
    const section = dictionary(locale);
    for (const key of KEYS) {
      expect(typeof section[key]).toBe('string');
      expect(section[key]).not.toBe('');
    }
  });

  it.each(['ja', 'en'])('the %s wording names the server that is missing', (locale) => {
    const text = dictionary(locale).errorNoPort;
    expect(text).toMatch(locale === 'ja' ? /opencode サーバ/ : /opencode server/i);
  });

  it.each(['ja', 'en'])('the %s wording distinguishes fork from share', (locale) => {
    const section = dictionary(locale);
    expect(section.errorNoSessionFork).not.toBe(section.errorNoSessionShare);
    expect(section.errorNoSessionFork).toMatch(locale === 'ja' ? /fork/ : /fork/i);
    expect(section.errorNoSessionShare).toMatch(locale === 'ja' ? /共有/ : /share/i);
  });
});

/**
 * The "files this turn changed" panel (Issue #2043).
 *
 * Organised around the Issue's two acceptance criteria:
 *
 *  1. **opencode's files reach the panel, and revert/unrevert act on them.**
 *     The rows here are the ones measured off a live 1.18.22 session
 *     (`docs/design/opencode-server-live-verification.md` §16).
 *  2. **claude / codex never see an empty panel.** Asserted by rendering the
 *     same component with the same props under a different `cliToolId` and
 *     requiring an empty DOM, not by eyeballing a snapshot.
 *
 * next-intl is mocked with the REAL `locales/en/*.json` rather than the echo
 * mock in `tests/setup.ts`, which drops interpolation parameters — a `{count}`
 * that never reached the template would otherwise pass.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OpencodeTurnDiffPanel } from '@/components/worktree/OpencodeTurnDiffPanel';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import type { AgentSessionDiffView } from '@/types/agent-session';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeAll(() => installRadixJsdomPolyfills());

/** The turn measured in §16.2: one file created, one modified. */
const TURN: AgentSessionDiffView = {
  sessionId: 'ses_fc65b58b2ffe0kur0cUkuLmkrr',
  turnMessageId: 'msg_cmatee6cc7a4ab0b7aa86d103841a',
  files: [
    {
      file: 'added.txt',
      patch: 'Index: added.txt\n@@ -0,0 +1,1 @@\n+banana\n',
      additions: 1,
      deletions: 0,
      status: 'added',
    },
    {
      file: 'sample.txt',
      patch: 'Index: sample.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE-TWO-EDITED\n line3\n',
      additions: 1,
      deletions: 1,
      status: 'modified',
    },
  ],
  filesAt: 1_700_000_000_000,
  revertedFiles: [],
  revertedMessageId: null,
  at: 1_700_000_000_000,
};

/** The same session once a revert is holding that turn back (§16.4). */
const HELD: AgentSessionDiffView = {
  ...TURN,
  files: [],
  revertedFiles: TURN.files,
  revertedMessageId: 'msg_cmatee6cc7a4ab0b7aa86d103841a',
};

function renderPanel(props: Partial<React.ComponentProps<typeof OpencodeTurnDiffPanel>> = {}) {
  return render(
    <ConfirmProvider>
      <OpencodeTurnDiffPanel
        worktreeId="wt-2043"
        cliToolId="opencode"
        diff={TURN}
        {...props}
      />
    </ConfirmProvider>
  );
}

/**
 * Click, and let React flush.
 *
 * `act` around the event rather than a bare `fireEvent`: the confirm dialog and
 * the fetch reply both resolve on microtasks, and an update outside `act` is
 * deferred — which makes a negative assertion ("the dialog is not there")
 * pass for the wrong reason.
 */
async function click(element: HTMLElement | Promise<HTMLElement>): Promise<void> {
  const target = await element;
  await act(async () => {
    fireEvent.click(target);
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ action: 'revert', applied: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('acceptance: no empty panel on claude or codex', () => {
  it.each(['claude', 'codex', 'gemini', 'copilot'] as const)(
    'renders nothing at all for %s',
    (cliToolId) => {
      const { container } = renderPanel({ cliToolId, diff: TURN });

      expect(container).toBeEmptyDOMElement();
    }
  );

  it('renders nothing for opencode when the payload has no diff', () => {
    const { container } = renderPanel({ diff: null });

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for opencode when both lists are empty', () => {
    // The ordinary state between turns, and the one that would otherwise put an
    // empty box under every opencode composer.
    const { container } = renderPanel({
      diff: { ...TURN, files: [], revertedFiles: [], filesAt: null },
    });

    expect(container).toBeEmptyDOMElement();
  });
});

describe('acceptance: the turn’s files reach the panel', () => {
  it('lists each file with its status and counts', () => {
    renderPanel();

    expect(screen.getByTestId('opencode-turn-diff-panel')).toBeInTheDocument();
    expect(screen.getByText('Files this turn changed')).toBeInTheDocument();
    // The interpolated count, which is why the real dictionary is loaded.
    expect(screen.getByText('2 files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'added.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sample.txt' })).toBeInTheDocument();
    expect(screen.getByText('+1 −1')).toBeInTheDocument();
  });

  it('opens the existing diff viewer on the measured patch', async () => {
    renderPanel();

    await click(screen.getByRole('button', { name: 'sample.txt' }));

    // DiffViewer renders the unified diff line by line; the added line is the
    // one that proves the patch reached it rather than a placeholder.
    await waitFor(() => {
      expect(screen.getByText('+LINE-TWO-EDITED')).toBeInTheDocument();
    });
  });

  it('renders a row with no patch as text rather than a link to nothing', () => {
    renderPanel({
      diff: {
        ...TURN,
        files: [{ file: 'opaque.bin', patch: null, additions: 3, deletions: 0, status: 'added' }],
      },
    });

    expect(screen.queryByRole('button', { name: 'opaque.bin' })).not.toBeInTheDocument();
    expect(screen.getByText('opaque.bin')).toBeInTheDocument();
  });

  it('names a file the agent did not name', () => {
    renderPanel({
      diff: {
        ...TURN,
        files: [{ file: null, patch: null, additions: 1, deletions: 1, status: null }],
      },
    });

    expect(screen.getByText('(unnamed file)')).toBeInTheDocument();
  });
});

describe('revert', () => {
  it('confirms before it sends anything', async () => {
    renderPanel();

    await click(screen.getByRole('button', { name: /Revert this turn/ }));

    // The dialog is up and the request has NOT gone out.
    expect(await screen.findByText('Revert this turn?')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    renderPanel();

    await click(screen.getByRole('button', { name: /Revert this turn/ }));
    await click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Revert this turn?')).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the action once confirmed', async () => {
    renderPanel({ instanceId: 'opencode-2' });

    await click(screen.getByRole('button', { name: /Revert this turn/ }));
    await click(await screen.findByRole('button', { name: 'Revert' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-2043/opencode/diff');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'revert',
      instanceId: 'opencode-2',
    });
  });

  it('says so when opencode answered 200 but changed nothing', async () => {
    // The measured trap: a revert whose messageID opencode could not place
    // answers 200. `applied: false` is the only signal.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ action: 'revert', applied: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    renderPanel();

    await click(screen.getByRole('button', { name: /Revert this turn/ }));
    await click(await screen.findByRole('button', { name: 'Revert' }));

    expect(
      await screen.findByText('opencode changed nothing (it could not find that turn).')
    ).toBeInTheDocument();
  });

  it('reports the mid-turn 409 as retryable rather than as a failure', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'busy', code: 'SESSION_BUSY' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    );
    renderPanel();

    await click(screen.getByRole('button', { name: /Revert this turn/ }));
    await click(await screen.findByRole('button', { name: 'Revert' }));

    expect(
      await screen.findByText('The agent is mid-turn. Try again once the turn finishes.')
    ).toBeInTheDocument();
  });
});

describe('unrevert', () => {
  it('shows the held-back files and offers Restore instead of Revert', () => {
    renderPanel({ diff: HELD });

    expect(screen.getByText('Changes held back by a revert')).toBeInTheDocument();
    expect(screen.getByText('2 files are reverted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revert this turn/ })).not.toBeInTheDocument();
  });

  it('confirms, then POSTs unrevert', async () => {
    renderPanel({ diff: HELD });

    await click(screen.getByRole('button', { name: /Restore/ }));
    expect(await screen.findByText('Restore the reverted changes?')).toBeInTheDocument();
    // The panel's own button also reads "Restore", so the dialog's is addressed
    // by its testid rather than by a name both of them match.
    await click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).action).toBe('unrevert');
  });

  it('offers Restore even before the held-back file list has arrived', () => {
    // `revertedMessageId` is what decides, not the list: `session.updated` can
    // report the revert before `session.diff` delivers its files.
    renderPanel({
      diff: { ...HELD, revertedFiles: [], files: TURN.files },
    });

    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
  });
});

describe('disabled', () => {
  it('disables both actions while nothing is running', () => {
    renderPanel({ disabled: true });

    expect(screen.getByRole('button', { name: /Revert this turn/ })).toBeDisabled();
  });
});

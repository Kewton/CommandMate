/**
 * `AgentUpdatesCard` — the update affordance rendered on More and inside the
 * agent pane (Issue #2069).
 *
 * next-intl is mocked through the REAL `locales/en/common.json`, not the global
 * echoing mock, because two of this card's assertions are about wording that
 * only means something if the dictionary resolves: the restart warning has to
 * name the live sessions, and the success line has to name both versions.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

import { AgentUpdatesCard } from '@/components/settings/AgentUpdatesCard';

const VERSIONS = {
  status: 'success',
  updatable: ['codex'],
  tools: [
    {
      tool: 'claude',
      installed: '2.1.251',
      latestVersion: null,
      dismissedVersion: null,
      updateAvailable: false,
      dismissedInCodex: false,
      updatable: false,
      source: null,
    },
    {
      tool: 'codex',
      installed: '0.149.1',
      latestVersion: '0.151.0',
      dismissedVersion: null,
      updateAvailable: true,
      dismissedInCodex: false,
      updatable: true,
      source: 'version.json',
    },
    {
      tool: 'opencode',
      installed: null,
      latestVersion: null,
      dismissedVersion: null,
      updateAvailable: false,
      dismissedInCodex: false,
      updatable: false,
      source: null,
    },
    {
      // A tool CommandMate KNOWS how to update that is not installed here.
      // Without this row `canUpdate = updatable && installed !== null` has an
      // unobservable half: every other row fails both halves at once, so
      // dropping the `installed !== null` test changed nothing visible and the
      // card would offer to update a CLI that is not on the machine.
      tool: 'gemini',
      installed: null,
      latestVersion: null,
      dismissedVersion: null,
      updateAvailable: false,
      dismissedInCodex: false,
      updatable: true,
      source: null,
    },
  ],
};

const INSTANCES = [
  { id: 'codex', cliTool: 'codex', alias: 'Codex' },
  { id: 'claude', cliTool: 'claude', alias: 'Claude' },
];

/** Build a Response whose body streams `lines` as NDJSON. */
function ndjson(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** Route every fetch this card makes. `update` may be overridden per test. */
function mockFetch(options: {
  update?: () => Response;
  running?: Record<string, { isRunning: boolean }>;
  versions?: typeof VERSIONS;
  versionsAfter?: typeof VERSIONS;
} = {}) {
  const killed: string[] = [];
  let versionsCalls = 0;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith('/api/agents/versions')) {
      versionsCalls += 1;
      const body =
        versionsCalls > 1 && options.versionsAfter
          ? options.versionsAfter
          : (options.versions ?? VERSIONS);
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.startsWith('/api/agents/update')) {
      return (
        options.update?.() ??
        ndjson([
          { type: 'plan', tool: 'codex', strategy: 'native', command: 'codex update', installed: '0.149.1' },
          { type: 'output', stream: 'stdout', text: 'Updating Codex via npm...' },
          { type: 'done', ok: true, exitCode: 0, previousVersion: '0.149.1', installed: '0.151.0' },
        ])
      );
    }
    if (url.includes('/kill-session')) {
      killed.push(url);
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    // The worktree read behind the "sessions are running" warning.
    return new Response(
      JSON.stringify({ sessionStatusByInstance: options.running ?? {} }),
      { status: 200 }
    );
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, killed };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('[#2069] AgentUpdatesCard — what it shows', () => {
  beforeEach(() => mockFetch());

  it('lists an installed version for every probed tool', async () => {
    render(<AgentUpdatesCard />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-installed-claude')).toHaveTextContent('2.1.251');
    });
    expect(screen.getByTestId('agent-updates-installed-codex')).toHaveTextContent('0.149.1');
  });

  it('says "Not installed" rather than inventing a version', async () => {
    render(<AgentUpdatesCard />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-installed-opencode')).toHaveTextContent(
        'Not installed'
      );
    });
  });

  it('shows the update badge for codex, with the version from version.json', async () => {
    render(<AgentUpdatesCard />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-available-codex')).toHaveTextContent('0.151.0');
    });
  });

  it('offers an Update button ONLY for a tool with an update flow', async () => {
    render(<AgentUpdatesCard />);
    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    // 実装内容 2: every other tool reports its installed version and nothing more.
    expect(screen.queryByTestId('agent-updates-update-claude')).toBeNull();
    expect(screen.queryByTestId('agent-updates-update-opencode')).toBeNull();
  });

  it('offers no Update button for an UPDATABLE tool that is not installed', async () => {
    // `gemini` in the fixture: `updatable: true`, `installed: null`. There is
    // nothing on this machine to update, so a button here would run an
    // installer for a CLI the user never asked for.
    render(<AgentUpdatesCard />);
    await waitFor(() => expect(screen.getByTestId('agent-updates-rows')).toBeInTheDocument());
    expect(screen.getByTestId('agent-updates-row-gemini')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-updates-update-gemini')).toBeNull();
  });

  it('offers no Update button for a tool that is neither updatable nor installed', async () => {
    render(<AgentUpdatesCard />);
    await waitFor(() => expect(screen.getByTestId('agent-updates-rows')).toBeInTheDocument());
    expect(screen.queryByTestId('agent-updates-update-opencode')).toBeNull();
  });

  it('shows the generic restart notice when there is no worktree to name', async () => {
    render(<AgentUpdatesCard />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-restart-notice-codex')).toHaveTextContent(
        /keeps its current version until it is restarted/
      );
    });
  });

  it.each([
    ['with a live session', { codex: { isRunning: true } }],
    ['with nothing running', {}],
  ])('does NOT show the generic notice on a worktree surface, %s', async (_label, running) => {
    // The pane has a worktree, so it either names its live sessions or says
    // nothing. The `worktreeId === undefined` half of the guard is only
    // observable in the SECOND row: with a session running the notice is
    // suppressed by `liveInstances.length === 0` anyway, so a test that only
    // covered that case would stay green with the worktree check deleted and
    // the pane would grow a second, vaguer paragraph under every row.
    mockFetch({ running });
    render(<AgentUpdatesCard worktreeId="wt-1" instances={INSTANCES} />);

    await waitFor(() =>
      expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('agent-updates-restart-notice-codex')).toBeNull();
  });
});

describe('[#2069] AgentUpdatesCard — a dismissed version', () => {
  const dismissed = {
    ...VERSIONS,
    tools: VERSIONS.tools.map((row) =>
      row.tool === 'codex'
        ? { ...row, dismissedVersion: '0.151.0', dismissedInCodex: true }
        : row
    ),
  };

  beforeEach(() => mockFetch({ versions: dismissed as typeof VERSIONS }));

  it('marks the version dismissed WITHOUT saying the user did it', async () => {
    // On the default #2068 policy CommandMate answers codex's update dialog
    // itself with the digit that writes `dismissed_version`, so on a stock
    // install this marker appears without anybody deciding anything. Copy that
    // says "you dismissed this" would blame the user for the server's own
    // automatic answer. Resolved through the real locales/en dictionary, so
    // this reads the shipped wording rather than a key.
    render(<AgentUpdatesCard />);

    const badge = await screen.findByTestId('agent-updates-dismissed-codex');
    expect(badge.textContent ?? '').toMatch(/dismissed/i);
    expect(badge.textContent ?? '').not.toMatch(/\byou\b|\byour\b/i);
  });

  it('still offers the update, and still says one is available', async () => {
    // A dismissal is a statement about codex's own banner, not a statement
    // that the update is unwanted — and after #2068 it may not even be the
    // user's statement. Hiding the button here would make CommandMate disagree
    // with `codex --version` for a reason the screen never showed.
    render(<AgentUpdatesCard />);
    await waitFor(() =>
      expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument()
    );
    expect(screen.getByTestId('agent-updates-available-codex')).toHaveTextContent('0.151.0');
  });
});

describe('[#2069] AgentUpdatesCard — the running-session warning', () => {
  it('names the live sessions of the tool being updated', async () => {
    mockFetch({ running: { codex: { isRunning: true } } });
    render(<AgentUpdatesCard worktreeId="wt-1" instances={INSTANCES} />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-restart-warning-codex')).toHaveTextContent('Codex');
    });
  });

  it('stays silent when nothing is running', async () => {
    mockFetch({ running: {} });
    render(<AgentUpdatesCard worktreeId="wt-1" instances={INSTANCES} />);

    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    expect(screen.queryByTestId('agent-updates-restart-warning-codex')).toBeNull();
  });

  it('does not warn about a live session of a DIFFERENT tool', async () => {
    mockFetch({ running: { claude: { isRunning: true } } });
    render(<AgentUpdatesCard worktreeId="wt-1" instances={INSTANCES} />);

    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    expect(screen.queryByTestId('agent-updates-restart-warning-codex')).toBeNull();
  });
});

describe('[#2069] AgentUpdatesCard — running an update', () => {
  it('streams the updater output and reports both versions', async () => {
    mockFetch({ versionsAfter: VERSIONS });
    render(<AgentUpdatesCard />);

    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-updates-update-codex'));

    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-output')).toHaveTextContent('Updating Codex via npm');
    });
    expect(screen.getByTestId('agent-updates-command')).toHaveTextContent('codex update');
    await waitFor(() => {
      const success = screen.getByTestId('agent-updates-success');
      expect(success).toHaveTextContent('0.149.1');
      expect(success).toHaveTextContent('0.151.0');
    });
  });

  it('reassembles an event split across two network chunks', async () => {
    // A JSON object straddling a chunk boundary is ordinary, and parsing
    // per-chunk instead of per-line would silently drop it.
    const encoder = new TextEncoder();
    const whole = `${JSON.stringify({ type: 'output', stream: 'stdout', text: 'halves-rejoined' })}\n`;
    const cut = Math.floor(whole.length / 2);

    mockFetch({
      update: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(whole.slice(0, cut)));
              controller.enqueue(encoder.encode(whole.slice(cut)));
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({ type: 'done', ok: true, exitCode: 0, previousVersion: '0.149.1', installed: '0.151.0' })}\n`
                )
              );
              controller.close();
            },
          }),
          { status: 200 }
        ),
    });

    render(<AgentUpdatesCard />);
    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-updates-update-codex'));

    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-output')).toHaveTextContent('halves-rejoined');
    });
  });

  it('reports a failed update rather than claiming success', async () => {
    mockFetch({
      update: () =>
        ndjson([
          {
            type: 'done',
            ok: false,
            exitCode: 1,
            previousVersion: '0.149.1',
            installed: '0.149.1',
            error: 'npm ERR! EACCES',
          },
        ]),
    });

    render(<AgentUpdatesCard />);
    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-updates-update-codex'));

    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-failure')).toHaveTextContent('EACCES');
    });
    expect(screen.queryByTestId('agent-updates-success')).toBeNull();
  });

  it('surfaces a refused request (409 in_progress) as a failure', async () => {
    mockFetch({
      update: () =>
        new Response(
          JSON.stringify({ status: 'error', code: 'in_progress', error: 'already running' }),
          { status: 409 }
        ),
    });

    render(<AgentUpdatesCard />);
    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-updates-update-codex'));

    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-failure')).toHaveTextContent('already running');
    });
  });

  it('re-reads the versions with the cache bypassed once the update finishes', async () => {
    const { fetchMock } = mockFetch();
    render(<AgentUpdatesCard />);
    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-updates-update-codex'));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls).toContain('/api/agents/versions?refresh=1');
    });
  });
});

describe('[#2069] AgentUpdatesCard — the restart button', () => {
  it('appears after a successful update, and ends exactly that instance', async () => {
    const { killed } = mockFetch({ running: { codex: { isRunning: true } } });
    render(<AgentUpdatesCard worktreeId="wt-1" instances={INSTANCES} />);

    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-updates-update-codex'));

    await waitFor(() => expect(screen.getByTestId('agent-updates-restart-codex')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-updates-restart-codex'));

    await waitFor(() => expect(killed).toHaveLength(1));
    expect(killed[0]).toContain('/api/worktrees/wt-1/kill-session');
    expect(killed[0]).toContain('cliTool=codex');
    expect(killed[0]).toContain('instance=codex');
    // The roster's other instance is a different tool and must not be touched.
    expect(killed[0]).not.toContain('instance=claude');
  });

  it('does not appear before an update has succeeded', async () => {
    mockFetch({ running: { codex: { isRunning: true } } });
    render(<AgentUpdatesCard worktreeId="wt-1" instances={INSTANCES} />);

    await waitFor(() => expect(screen.getByTestId('agent-updates-update-codex')).toBeInTheDocument());
    expect(screen.queryByTestId('agent-updates-restart-codex')).toBeNull();
  });
});

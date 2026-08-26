/**
 * The opencode launch-settings pane (Issue #2048).
 *
 * The pane has one behaviour that is not obvious from its markup and is the
 * whole reason Issue #2048 asks for candidate lists at all: **the lists come
 * from a running opencode**, because `GET /config/providers` and `GET /agent`
 * are served by the TUI itself once it has a port. A worktree whose panes are
 * stopped has no catalogue, and the Issue's answer to that is free text
 * ("port 未接続時は自由入力") rather than an empty dropdown the operator cannot
 * escape from. Both halves are asserted here.
 *
 * The second is the variant. It is offered like any other setting, but it is not
 * a launch flag — the TUI has no `--variant` (measured on 1.18.22,
 * `docs/design/opencode-server-live-verification.md` §20.3) — so the pane owes
 * the operator a note about when it takes effect. That note is rendered from the
 * real dictionary here, not from a key echo, so a missing translation fails.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

import { OpencodeInstanceSettings } from '@/components/worktree/AgentSettingsPane';
import type { OpencodeInstanceSettingsResponse } from '@/types/opencode-instance-settings';

const CONNECTED: OpencodeInstanceSettingsResponse = {
  settings: {
    opencode: {
      agent: 'plan',
      providerId: 'github-copilot',
      modelId: 'claude-sonnet-4.6',
      variant: 'high',
    },
  },
  catalog: {
    connected: true,
    providers: [
      {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        models: [
          {
            id: 'claude-sonnet-4.6',
            name: 'Claude Sonnet 4.6',
            variants: ['high', 'low', 'max', 'medium'],
          },
          { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', variants: [] },
        ],
      },
    ],
    agents: [
      { name: 'build', mode: 'primary', description: 'The default agent.' },
      { name: 'plan', mode: 'primary', description: 'Plan mode.' },
      { name: 'explore', mode: 'subagent', description: 'Fast agent.' },
    ],
  },
};

const OFFLINE: OpencodeInstanceSettingsResponse = {
  settings: { opencode: { agent: null, providerId: null, modelId: null, variant: null } },
  catalog: { connected: false, providers: [], agents: [] },
};

const INSTANCES = [{ id: 'opencode', label: 'OpenCode' }];

const mockFetch = vi.fn();

function respondWith(body: OpencodeInstanceSettingsResponse) {
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ instanceId: sent.instanceId, settings: sent }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpencodeInstanceSettings — a live server (Issue #2048)', () => {
  beforeEach(() => respondWith(CONNECTED));

  it('offers only the PRIMARY agents — a subagent cannot start a session', async () => {
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);

    const select = (await screen.findByTestId('opencode-agent-select-opencode')) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'build',
      'plan',
    ]);
    expect(select.value).toBe('plan');
  });

  it('offers models as `provider/model`, grouped by provider', async () => {
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);

    const select = (await screen.findByTestId('opencode-model-select-opencode')) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'github-copilot/claude-sonnet-4.6',
      'github-copilot/kimi-k2.7-code',
    ]);
    expect(select.value).toBe('github-copilot/claude-sonnet-4.6');
  });

  it('offers the chosen model s own variants, and nothing else', async () => {
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);

    const select = (await screen.findByTestId(
      'opencode-variant-select-opencode'
    )) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'high',
      'low',
      'max',
      'medium',
    ]);
  });

  it('PUTs the whole settings object when one field changes', async () => {
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);
    const select = await screen.findByTestId('opencode-variant-select-opencode');

    fireEvent.change(select, { target: { value: 'max' } });

    await waitFor(() => {
      const put = mockFetch.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(put).toBeDefined();
      expect(put![0]).toBe('/api/worktrees/wt/instances/opencode');
      expect(JSON.parse(String(put![1].body))).toEqual({
        instanceId: 'opencode',
        agent: 'plan',
        providerId: 'github-copilot',
        modelId: 'claude-sonnet-4.6',
        variant: 'max',
      });
    });
  });

  it('clears the variant when the model changes — variants belong to one model', async () => {
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);
    const select = await screen.findByTestId('opencode-model-select-opencode');

    fireEvent.change(select, { target: { value: 'github-copilot/kimi-k2.7-code' } });

    await waitFor(() => {
      const put = mockFetch.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(put![1].body))).toMatchObject({
        modelId: 'kimi-k2.7-code',
        variant: null,
      });
    });
  });

  it('says so when the chosen model has no variants at all', async () => {
    respondWith({
      ...CONNECTED,
      settings: {
        opencode: {
          agent: null,
          providerId: 'github-copilot',
          modelId: 'kimi-k2.7-code',
          variant: null,
        },
      },
    });
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);

    expect(await screen.findByText('This model has no variants.')).toBeInTheDocument();
  });

  it('tells the operator that the variant is not a launch flag', async () => {
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);

    const note = await screen.findByText(/has no --variant/);
    expect(note).toBeInTheDocument();
    expect(note.textContent).toContain('take effect the next time this instance starts');
  });
});

describe('OpencodeInstanceSettings — no server to ask (Issue #2048)', () => {
  beforeEach(() => respondWith(OFFLINE));

  it('falls back to free text for all three fields', async () => {
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);

    expect(await screen.findByTestId('opencode-agent-input-opencode')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-model-input-opencode')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-variant-input-opencode')).toBeInTheDocument();
    expect(screen.queryByTestId('opencode-agent-select-opencode')).toBeNull();
  });

  it('explains why there are no candidates', async () => {
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);
    expect(await screen.findByTestId('opencode-settings-offline')).toHaveTextContent(
      'opencode is not running'
    );
  });

  it('splits free text at the FIRST slash, so `org/model` ids survive', async () => {
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);
    const input = await screen.findByTestId('opencode-model-input-opencode');

    fireEvent.blur(input, { target: { value: 'lmstudio/qwen/qwen3-coder-30b' } });

    await waitFor(() => {
      const put = mockFetch.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(put![1].body))).toMatchObject({
        providerId: 'lmstudio',
        modelId: 'qwen/qwen3-coder-30b',
      });
    });
  });
});

describe('OpencodeInstanceSettings — failures (Issue #2048)', () => {
  it('surfaces a failed read instead of rendering nothing', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    render(<OpencodeInstanceSettings worktreeId="wt" instances={INSTANCES} />);

    expect(await screen.findByTestId('opencode-settings-error')).toBeInTheDocument();
  });
});

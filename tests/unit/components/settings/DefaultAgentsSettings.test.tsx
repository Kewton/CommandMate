/**
 * @vitest-environment jsdom
 *
 * The "default agents for new branches" settings card (Issue #2065).
 *
 * The setting is ORDERED — `agents[0]` is the primary — so the assertions that
 * matter are about order, not about which boxes are ticked: what the reorder
 * controls send, and that the primary badge follows position 1. A test that only
 * checked membership would stay green through a PUT that sorted the list.
 *
 * The real dictionary is used (`createRealIntlMock`) rather than the global
 * key-echoing mock, so a missing `common.settings.defaultAgents.*` entry is red
 * here instead of shipping as a raw key on the More screen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

import { DefaultAgentsSettings } from '@/components/settings';
import {
  getClientDefaultSelectedAgents,
  resetClientDefaultSelectedAgents,
} from '@/config/default-agents';

const GET_BODY = {
  success: true,
  defaultSelectedAgents: ['claude', 'codex', 'antigravity'],
  configured: false,
  constantDefault: ['claude', 'codex', 'antigravity'],
  available: ['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot', 'antigravity'],
  minAgents: 2,
  maxAgents: 6,
  installed: ['claude', 'codex'],
};

/**
 * A STORED setting, deliberately different from `DEFAULT_SELECTED_AGENTS` in
 * both membership and order.
 *
 * `GET_BODY` above is the unconfigured case, and its `defaultSelectedAgents` is
 * the constant — so every assertion made against it alone is also satisfied by
 * a component that ignores the response and renders the constant. This body is
 * what makes the load path falsifiable.
 */
const CONFIGURED_BODY = {
  ...GET_BODY,
  defaultSelectedAgents: ['codex', 'claude'],
  configured: true,
};

let putBodies: unknown[] = [];
const originalFetch = globalThis.fetch;

function installFetch(
  overrides: { put?: Record<string, unknown>; get?: Record<string, unknown> } = {}
) {
  const getBody = overrides.get ?? GET_BODY;
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      putBodies.push(JSON.parse(String(init.body)));
      const sent = JSON.parse(String(init.body)).agents;
      return {
        ok: true,
        json: async () => ({
          ...getBody,
          defaultSelectedAgents: sent ?? GET_BODY.constantDefault,
          configured: sent !== null,
          ...overrides.put,
        }),
      } as Response;
    }
    expect(String(url)).toContain('include=installed');
    return { ok: true, json: async () => getBody } as Response;
  }) as unknown as typeof fetch;
}

async function renderCard() {
  render(<DefaultAgentsSettings />);
  await screen.findByTestId('default-agents-settings');
}

function selectedOrder(): string[] {
  return Array.from(
    screen.getByTestId('default-agents-selected').querySelectorAll('li')
  ).map((li) => li.getAttribute('data-testid')!.replace('default-agents-row-', ''));
}

describe('DefaultAgentsSettings (Issue #2065)', () => {
  beforeEach(() => {
    putBodies = [];
    resetClientDefaultSelectedAgents();
    installFetch();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    resetClientDefaultSelectedAgents();
  });

  /**
   * The load path, made falsifiable.
   *
   * Everything below uses `GET_BODY`, whose `defaultSelectedAgents` IS the
   * compiled-in constant — so a component that threw the response away and
   * rendered the constant would satisfy all of it. These cases serve a stored
   * value that differs from the constant in membership and order, which is the
   * only shape that can tell the two apart.
   */
  describe('reads the STORED setting, not the constant', () => {
    beforeEach(() => {
      installFetch({ get: CONFIGURED_BODY });
    });

    it('renders the stored list, in the stored order', async () => {
      await renderCard();

      expect(selectedOrder()).toEqual(['codex', 'claude']);
      expect(selectedOrder()).not.toEqual(GET_BODY.constantDefault);
    });

    it('marks the stored primary, not the constant primary', async () => {
      await renderCard();

      expect(screen.getByTestId('default-agents-row-codex')).toContainElement(
        screen.getByTestId('default-agents-primary-badge')
      );
      expect(screen.getByTestId('default-agents-row-claude')).not.toContainElement(
        screen.getByTestId('default-agents-primary-badge')
      );
    });

    it('offers the rest as additions, so antigravity is no longer selected', async () => {
      await renderCard();

      expect(screen.getByTestId('default-agents-add-antigravity')).toBeTruthy();
      expect(screen.queryByTestId('default-agents-row-antigravity')).toBeNull();
    });

    /**
     * The load-side store update (`setClientDefaultSelectedAgents` in `load()`).
     * The save-side one is asserted further down; without this case, deleting
     * the load-side call is invisible, because opening the More screen is the
     * one place that learns the setting without saving anything.
     */
    it('seeds the client-side fallback store on LOAD, before any save', async () => {
      await renderCard();

      expect(getClientDefaultSelectedAgents()).toEqual(['codex', 'claude']);
      expect(putBodies).toHaveLength(0);
    });

    it('says what "reset" returns to, using the constant the server sent', async () => {
      await renderCard();

      expect(screen.getByTestId('default-agents-builtin').textContent).toBe(
        'Built-in default: Claude, Codex, Antigravity'
      );
      expect(screen.getByTestId('default-agents-reset')).toHaveProperty('disabled', false);
      expect(screen.getByTestId('default-agents-state').textContent).toBe('Configured');
    });

    it('saves what the user reordered on top of the stored value', async () => {
      await renderCard();

      fireEvent.click(screen.getByTestId('default-agents-down-codex'));
      expect(selectedOrder()).toEqual(['claude', 'codex']);

      fireEvent.click(screen.getByTestId('default-agents-save'));
      await waitFor(() => expect(putBodies).toHaveLength(1));
      expect(putBodies[0]).toEqual({ agents: ['claude', 'codex'] });
    });
  });

  it('hides the built-in hint while nothing is stored', async () => {
    await renderCard();
    expect(screen.queryByTestId('default-agents-builtin')).toBeNull();
  });

  it('renders the current default in order, with the first marked primary', async () => {
    await renderCard();
    expect(selectedOrder()).toEqual(['claude', 'codex', 'antigravity']);
    const badges = screen.getAllByTestId('default-agents-primary-badge');
    expect(badges).toHaveLength(1);
    expect(screen.getByTestId('default-agents-row-claude')).toContainElement(badges[0]);
  });

  it('annotates each choice with whether that CLI is installed', async () => {
    await renderCard();
    expect(screen.getByTestId('default-agents-installed-claude')).toBeTruthy();
    expect(screen.getByTestId('default-agents-installed-codex')).toBeTruthy();
    expect(screen.queryByTestId('default-agents-installed-antigravity')).toBeNull();
    expect(screen.getAllByText('Not installed').length).toBeGreaterThan(0);
  });

  it('says the setting applies to new branches only', async () => {
    await renderCard();
    expect(
      screen.getByText('Existing branches are left alone. Their tabs stay exactly as they are.')
    ).toBeTruthy();
  });

  it('moves the primary and SAVES the new order', async () => {
    await renderCard();

    fireEvent.click(screen.getByTestId('default-agents-up-codex'));
    expect(selectedOrder()).toEqual(['codex', 'claude', 'antigravity']);
    expect(screen.getByTestId('default-agents-row-codex')).toContainElement(
      screen.getByTestId('default-agents-primary-badge')
    );

    fireEvent.click(screen.getByTestId('default-agents-save'));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({ agents: ['codex', 'claude', 'antigravity'] });
  });

  it('moves an entry down as well as up', async () => {
    await renderCard();
    fireEvent.click(screen.getByTestId('default-agents-down-claude'));
    expect(selectedOrder()).toEqual(['codex', 'claude', 'antigravity']);
  });

  it('adds an available tool to the end and removes a selected one', async () => {
    await renderCard();

    fireEvent.click(screen.getByTestId('default-agents-add-gemini'));
    expect(selectedOrder()).toEqual(['claude', 'codex', 'antigravity', 'gemini']);

    fireEvent.click(screen.getByTestId('default-agents-remove-claude'));
    expect(selectedOrder()).toEqual(['codex', 'antigravity', 'gemini']);
  });

  it('will not let the list fall below the minimum', async () => {
    await renderCard();

    fireEvent.click(screen.getByTestId('default-agents-remove-antigravity'));
    expect(selectedOrder()).toEqual(['claude', 'codex']);

    // At the floor every remove control is disabled, so the list cannot reach a
    // state the API would reject.
    expect(screen.getByTestId('default-agents-remove-claude')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('default-agents-remove-codex')).toHaveProperty('disabled', true);
  });

  it('updates the client-side fallback store after a save', async () => {
    await renderCard();

    fireEvent.click(screen.getByTestId('default-agents-up-codex'));
    fireEvent.click(screen.getByTestId('default-agents-save'));

    await waitFor(() =>
      expect(getClientDefaultSelectedAgents()).toEqual(['codex', 'claude', 'antigravity'])
    );
  });

  it('sends agents:null to reset, and only when something is stored', async () => {
    await renderCard();

    // configured=false in the GET body, so there is nothing to reset yet.
    expect(screen.getByTestId('default-agents-reset')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('default-agents-state').textContent).toBe(
      'Using the built-in default'
    );

    fireEvent.click(screen.getByTestId('default-agents-save'));
    await waitFor(() =>
      expect(screen.getByTestId('default-agents-reset')).toHaveProperty('disabled', false)
    );

    fireEvent.click(screen.getByTestId('default-agents-reset'));
    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1]).toEqual({ agents: null });
  });

  it('surfaces the server error text instead of claiming success', async () => {
    installFetch();
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return { ok: false, json: async () => ({ success: false, error: 'nope' }) } as Response;
      }
      return { ok: true, json: async () => GET_BODY } as Response;
    }) as unknown as typeof fetch;

    await renderCard();
    fireEvent.click(screen.getByTestId('default-agents-save'));

    await waitFor(() =>
      expect(screen.getByTestId('default-agents-error').textContent).toBe('nope')
    );
    expect(screen.getByTestId('default-agents-state').textContent).not.toBe('Saved');
  });

  it('shows an error rather than an empty card when the GET fails', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    render(<DefaultAgentsSettings />);
    await waitFor(() =>
      expect(screen.getByTestId('default-agents-load-error').textContent).toBe(
        'Could not load the setting.'
      )
    );
  });

  /**
   * The failure that took the whole More page down before the payload guard:
   * an unrelated 200 body (a server older than this screen, or the page-level
   * fetch stub in `tests/unit/app/more/page.test.tsx`) reached render, where
   * `payload.available.filter` threw and unmounted Notifications and External
   * Apps along with this card.
   */
  it('does not throw on a 200 that is not this route\'s body', async () => {
    for (const body of [{}, { apps: [] }, { defaultSelectedAgents: [] }, null, 'nope']) {
      cleanup();
      globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => body }) as Response) as unknown as typeof fetch;
      render(<DefaultAgentsSettings />);
      await waitFor(() =>
        expect(screen.getByTestId('default-agents-load-error')).toBeTruthy()
      );
    }
  });

  it('keeps the card usable when the PUT answers 200 with a body it cannot read', async () => {
    let putCount = 0;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putCount++;
        return { ok: true, json: async () => ({ unrelated: true }) } as Response;
      }
      return { ok: true, json: async () => GET_BODY } as Response;
    }) as unknown as typeof fetch;

    await renderCard();
    fireEvent.click(screen.getByTestId('default-agents-save'));

    await waitFor(() => expect(putCount).toBe(1));
    await waitFor(() =>
      expect(screen.getByTestId('default-agents-error').textContent).toBe('Could not save.')
    );
    // Still rendering the list it loaded, not a blank card.
    expect(selectedOrder()).toEqual(['claude', 'codex', 'antigravity']);
  });
});

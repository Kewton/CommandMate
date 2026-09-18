/**
 * @vitest-environment jsdom
 */

/**
 * Tests for the What's-new dialog (Issue #2651).
 *
 * Two things here can only fail silently in production, so both are pinned
 * exhaustively. The first is the mount-time decision: this component runs on
 * every page of the app, and a wrong branch either spams a dialog the user
 * already dismissed or swallows the one release note they were meant to see —
 * and because the "remember" branches write to localStorage, a wrong one is
 * self-concealing after the first run. The decision table is therefore covered
 * row by row, both as the pure `decideWhatsNew` and through the rendered
 * component, where the localStorage write is the observable half.
 *
 * The second is that release-note text is server-supplied and rendered as
 * plain React children on purpose: the "no Markdown, no HTML" test below is
 * the guard, since nothing else would notice a `MarkdownPreview` creeping in.
 *
 * Wording is asserted against the real dictionary (createRealIntlMock) rather
 * than the global key-echoing mock, because the ja/en switch is the feature.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import type { ReleaseNote } from '@/lib/app-update/release-notes';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    appApi: { ...actual.appApi, getReleaseNotes: vi.fn() },
  };
});

import { appApi, ApiError } from '@/lib/api-client';
import {
  WhatsNewDialog,
  decideWhatsNew,
  LAST_SEEN_APP_VERSION_STORAGE_KEY,
} from '@/components/common/WhatsNewDialog';

const fixtureNotes: ReleaseNote[] = [
  {
    version: '0.39.0',
    date: '2026-09-18',
    highlight: { ja: '更新の目玉です', en: 'The headline of this release' },
    added: [{ ja: '新しいダイアログ', en: 'A new dialog' }],
    improved: [],
    fixed: [{ ja: '古い不具合の修正', en: 'An old bug is gone' }],
  },
  {
    version: '0.38.1',
    date: '2026-09-10',
    highlight: null,
    added: [],
    improved: [],
    fixed: [{ ja: '小さな修正', en: 'A small fix' }],
  },
];

const ORIGINAL_APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION;

function storedVersion(): string | null {
  return window.localStorage.getItem(LAST_SEEN_APP_VERSION_STORAGE_KEY);
}

beforeEach(() => {
  locale.current = 'en';
  window.localStorage.clear();
  process.env.NEXT_PUBLIC_APP_VERSION = '0.39.0';
  // vi.restoreAllMocks() leaves a vi.fn()'s call history and its queued
  // one-shot responses in place, so reset the stub explicitly each time.
  vi.mocked(appApi.getReleaseNotes).mockReset().mockResolvedValue({ notes: fixtureNotes });
});

afterEach(() => {
  if (ORIGINAL_APP_VERSION === undefined) {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
  } else {
    process.env.NEXT_PUBLIC_APP_VERSION = ORIGINAL_APP_VERSION;
  }
  cleanup();
  vi.restoreAllMocks();
});

describe('[#2651] decideWhatsNew', () => {
  it.each([
    ['no stored version (first visit)', null, '0.39.0', { kind: 'remember' }],
    ['an unparsable stored version', 'garbage', '0.39.0', { kind: 'remember' }],
    ['the same version', '0.39.0', '0.39.0', { kind: 'none' }],
    ['the same version, v-prefixed', 'v0.39.0', '0.39.0', { kind: 'none' }],
    ['a downgrade', '0.40.0', '0.39.0', { kind: 'remember' }],
    ['an upgrade', '0.38.0', '0.39.0', { kind: 'show', from: '0.38.0' }],
    ['an unset bundle version', '0.38.0', '', { kind: 'none' }],
    ['a prerelease bundle version', '0.38.0', '0.39.0-rc.1', { kind: 'none' }],
  ])('decides %s', (_name, stored, current, expected) => {
    expect(decideWhatsNew(stored as string | null, current as string)).toEqual(expected);
  });
});

describe('[#2651] WhatsNewDialog mount decision', () => {
  it('records the current version and shows nothing on a first visit', async () => {
    render(<WhatsNewDialog />);

    await waitFor(() => expect(storedVersion()).toBe('0.39.0'));
    expect(appApi.getReleaseNotes).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does nothing when the stored version is the one running', async () => {
    window.localStorage.setItem(LAST_SEEN_APP_VERSION_STORAGE_KEY, '0.39.0');

    render(<WhatsNewDialog />);

    expect(appApi.getReleaseNotes).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(storedVersion()).toBe('0.39.0');
  });

  it('records the running version after a downgrade, without showing anything', async () => {
    window.localStorage.setItem(LAST_SEEN_APP_VERSION_STORAGE_KEY, '0.40.0');

    render(<WhatsNewDialog />);

    await waitFor(() => expect(storedVersion()).toBe('0.39.0'));
    expect(appApi.getReleaseNotes).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('overwrites an unparsable stored version without showing anything', async () => {
    window.localStorage.setItem(LAST_SEEN_APP_VERSION_STORAGE_KEY, 'garbage');

    render(<WhatsNewDialog />);

    await waitFor(() => expect(storedVersion()).toBe('0.39.0'));
    expect(appApi.getReleaseNotes).not.toHaveBeenCalled();
  });

  it('touches nothing when the bundle version is unset (the unit-test default)', () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    window.localStorage.setItem(LAST_SEEN_APP_VERSION_STORAGE_KEY, '0.38.0');

    render(<WhatsNewDialog />);

    expect(appApi.getReleaseNotes).not.toHaveBeenCalled();
    expect(storedVersion()).toBe('0.38.0');
  });

  it('fetches the gap and opens the dialog when the bundle is newer', async () => {
    window.localStorage.setItem(LAST_SEEN_APP_VERSION_STORAGE_KEY, '0.38.0');

    render(<WhatsNewDialog />);

    await waitFor(() => expect(screen.getByTestId('whats-new-dialog')).toBeInTheDocument());
    expect(appApi.getReleaseNotes).toHaveBeenCalledTimes(1);
    expect(appApi.getReleaseNotes).toHaveBeenCalledWith('0.38.0', '0.39.0');
    // Still the old version while the dialog is open: it is recorded on close.
    expect(storedVersion()).toBe('0.38.0');
  });

  it('keeps the stored version when the fetch fails, so the next mount retries', async () => {
    window.localStorage.setItem(LAST_SEEN_APP_VERSION_STORAGE_KEY, '0.38.0');
    vi.mocked(appApi.getReleaseNotes).mockRejectedValue(new ApiError('boom', 500));

    render(<WhatsNewDialog />);

    await waitFor(() => expect(appApi.getReleaseNotes).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('whats-new-dialog')).not.toBeInTheDocument();
    expect(storedVersion()).toBe('0.38.0');
  });

  it('renders without throwing when localStorage cannot be read at all', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => render(<WhatsNewDialog />)).not.toThrow();
    expect(appApi.getReleaseNotes).not.toHaveBeenCalled();
  });
});

describe('[#2651] WhatsNewDialog contents', () => {
  beforeEach(() => {
    window.localStorage.setItem(LAST_SEEN_APP_VERSION_STORAGE_KEY, '0.38.0');
  });

  it('shows the versions newest first, with only the sections that have content (en)', async () => {
    render(<WhatsNewDialog />);

    await waitFor(() => expect(screen.getByTestId('whats-new-dialog')).toBeInTheDocument());

    expect(screen.getByText("What's new (v0.38.0 → v0.39.0)")).toBeInTheDocument();

    const newer = screen.getByTestId('whats-new-version-0.39.0');
    const older = screen.getByTestId('whats-new-version-0.38.1');
    expect(newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(newer.querySelector('[data-testid="whats-new-highlight"]')).not.toBeNull();
    expect(newer.querySelector('[data-testid="whats-new-added"]')).not.toBeNull();
    expect(newer.querySelector('[data-testid="whats-new-fixed"]')).not.toBeNull();
    expect(newer.querySelector('[data-testid="whats-new-improved"]')).toBeNull();
    expect(older.querySelector('[data-testid="whats-new-highlight"]')).toBeNull();

    expect(screen.getByText('The headline of this release')).toBeInTheDocument();
    expect(screen.getByText('A new dialog')).toBeInTheDocument();
    expect(screen.getByText('An old bug is gone')).toBeInTheDocument();
    expect(screen.getByText('A small fix')).toBeInTheDocument();
    expect(screen.getByText('Highlights')).toBeInTheDocument();
    expect(screen.getAllByText('New')).toHaveLength(1);
  });

  it('follows the UI locale to Japanese', async () => {
    locale.current = 'ja';

    render(<WhatsNewDialog />);

    await waitFor(() => expect(screen.getByTestId('whats-new-dialog')).toBeInTheDocument());

    expect(screen.getByText('新機能と改善（v0.38.0 → v0.39.0）')).toBeInTheDocument();
    expect(screen.getByText('ハイライト')).toBeInTheDocument();
    expect(screen.getByText('新機能')).toBeInTheDocument();
    expect(screen.getAllByText('修正').length).toBeGreaterThan(0);
    expect(screen.getByText('更新の目玉です')).toBeInTheDocument();
    expect(screen.getByText('新しいダイアログ')).toBeInTheDocument();
    expect(screen.getByText('古い不具合の修正')).toBeInTheDocument();
    expect(screen.getByText('小さな修正')).toBeInTheDocument();
  });

  it('renders note text as plain text, not as Markdown or HTML', async () => {
    vi.mocked(appApi.getReleaseNotes).mockResolvedValueOnce({
      notes: [
        {
          version: '0.39.0',
          date: '2026-09-18',
          highlight: null,
          added: [{ ja: '**太字** <b>x</b>', en: '**bold** <b>x</b>' }],
          improved: [],
          fixed: [],
        },
      ],
    });

    render(<WhatsNewDialog />);

    const dialog = await screen.findByTestId('whats-new-dialog');
    const item = dialog.querySelector('li');
    expect(item?.textContent).toBe('**bold** <b>x</b>');
    expect(dialog.querySelector('b')).toBeNull();
    expect(dialog.querySelector('strong')).toBeNull();
  });

  it('shows the release-page pointer alone when there are no notes', async () => {
    vi.mocked(appApi.getReleaseNotes).mockResolvedValueOnce({ notes: [] });

    render(<WhatsNewDialog />);

    const dialog = await screen.findByTestId('whats-new-dialog');
    expect(screen.getByTestId('whats-new-empty')).toHaveTextContent(
      'See the release page for the details of this update.'
    );
    expect(dialog.querySelectorAll('section')).toHaveLength(0);
    expect(screen.getByTestId('whats-new-release-link')).toBeInTheDocument();
  });

  it.each([
    ['with notes', undefined],
    ['with no notes', { notes: [] as ReleaseNote[] }],
  ])('links to the running version on GitHub, in a new tab (%s)', async (_name, override) => {
    if (override) vi.mocked(appApi.getReleaseNotes).mockResolvedValueOnce(override);

    render(<WhatsNewDialog />);

    const link = await screen.findByTestId('whats-new-release-link');
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/Kewton/CommandMate/releases/tag/v0.39.0'
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('[#2651] WhatsNewDialog close', () => {
  beforeEach(() => {
    window.localStorage.setItem(LAST_SEEN_APP_VERSION_STORAGE_KEY, '0.38.0');
  });

  it('records the running version and dismisses when the close button is pressed', async () => {
    render(<WhatsNewDialog />);

    fireEvent.click(await screen.findByTestId('whats-new-close'));

    expect(storedVersion()).toBe('0.39.0');
    // The Modal keeps its panel mounted for the 200ms exit animation.
    await waitFor(() =>
      expect(screen.queryByTestId('whats-new-dialog')).not.toBeInTheDocument()
    );
  });

  it('records the running version on Escape too', async () => {
    render(<WhatsNewDialog />);
    await screen.findByTestId('whats-new-dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(storedVersion()).toBe('0.39.0'));
  });

  it('still closes when localStorage refuses the write', async () => {
    render(<WhatsNewDialog />);
    const closeButton = await screen.findByTestId('whats-new-close');

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(() => fireEvent.click(closeButton)).not.toThrow();
    await waitFor(() =>
      expect(screen.queryByTestId('whats-new-dialog')).not.toBeInTheDocument()
    );
  });
});

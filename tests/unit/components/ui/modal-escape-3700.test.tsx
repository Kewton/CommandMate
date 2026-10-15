/**
 * The shared Modal follows the Escape layer rule (Issue #3700)
 *
 * A layer inside the Modal that closes on Escape — a search bar marking the
 * press (`markEscapeClosedLayer`), or one claiming it (`preventDefault`) —
 * takes that press alone: the Modal stays and closes on the next one. An
 * Escape nobody marked or claimed closes the Modal as before, and
 * `disableClose` still keeps it open either way.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { Modal } from '@/components/ui/Modal';
import { FileViewer } from '@/components/worktree/FileViewer';
import { __resetApiReachabilityReporting } from '@/lib/api-client';
import { markEscapeClosedLayer } from '@/lib/escape-key';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('highlight.js', () => ({
  default: {
    highlightAuto: (code: string) => ({ value: `<span class="hljs">${code}</span>` }),
    highlight: (code: string) => ({ value: `<span class="hljs">${code}</span>` }),
    getLanguage: () => undefined,
  },
}));

beforeEach(() => {
  __resetApiReachabilityReporting();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function pressEscape(target: Element | Document): void {
  act(() => {
    fireEvent.keyDown(target, { key: 'Escape' });
  });
}

type InnerLayer = 'mark' | 'preventDefault' | 'none';

/** A Modal with an inner input that reacts to Escape the way `layer` says. */
function renderModal(
  layer: InnerLayer,
  { disableClose = false }: { disableClose?: boolean } = {}
): { onClose: ReturnType<typeof vi.fn>; input: HTMLElement } {
  const onClose = vi.fn();
  render(
    <Modal isOpen onClose={onClose} title="Dialog" disableClose={disableClose}>
      <input
        data-testid="inner-layer"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          if (layer === 'mark') markEscapeClosedLayer(e.nativeEvent);
          if (layer === 'preventDefault') e.preventDefault();
        }}
      />
    </Modal>
  );
  return { onClose, input: screen.getByTestId('inner-layer') };
}

describe('[#3700] Modal Escape after an inner layer', () => {
  it('stays open on the press an inner layer closed on and marked (positive)', () => {
    const { onClose, input } = renderModal('mark');
    pressEscape(input);
    expect(onClose).not.toHaveBeenCalled();

    pressEscape(document);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on the press an inner layer claimed with preventDefault (positive)', () => {
    const { onClose, input } = renderModal('preventDefault');
    pressEscape(input);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on an Escape nobody marked or claimed (negative control)', () => {
    const { onClose, input } = renderModal('none');
    pressEscape(input);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps disableClose: neither an unmarked nor a marked press closes it', () => {
    const { onClose, input } = renderModal('none', { disableClose: true });
    pressEscape(input);
    pressEscape(document);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('[#3700] FileViewer in its Modal: the search bar closes alone', () => {
  const TS_PATH = 'src/index.ts';

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        path: TS_PATH,
        content: 'const x = 1;\n',
        extension: 'ts',
        worktreePath: '/wt',
      }),
    }) as unknown as typeof fetch;
  });

  it('closes the search bar on the first Escape, the Modal on the second (positive)', async () => {
    const onClose = vi.fn();
    render(<FileViewer isOpen onClose={onClose} worktreeId="wt-3700" filePath={TS_PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: /search in file/i }));
    const input = await screen.findByPlaceholderText(/.+/);

    pressEscape(input);
    expect(screen.queryByPlaceholderText(/.+/)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    pressEscape(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

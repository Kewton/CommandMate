/**
 * Tests for ConfirmDialog / ConfirmProvider / useConfirm (Issue #1113)
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  waitForElementToBeRemoved,
} from '@testing-library/react';
import {
  ConfirmDialog,
  ConfirmProvider,
  useConfirm,
} from '@/components/ui/ConfirmDialog';

afterEach(() => {
  cleanup();
  document.body.style.overflow = 'unset';
  vi.restoreAllMocks();
});

describe('ConfirmDialog (presentational)', () => {
  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog
        isOpen={false}
        description="desc"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('renders description, default title and default labels when open', () => {
    render(
      <ConfirmDialog
        isOpen
        description="Delete this?"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete this?')).toBeInTheDocument();
    // next-intl mock returns full key strings
    expect(screen.getByText('common.confirmDialog.title')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent(
      'common.confirmDialog.confirm'
    );
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveTextContent(
      'common.cancel'
    );
  });

  it('renders custom title and labels when provided', () => {
    render(
      <ConfirmDialog
        isOpen
        title="My Title"
        description="desc"
        confirmLabel="Yes"
        cancelLabel="No"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Yes');
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveTextContent('No');
  });

  it('calls onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog isOpen description="d" onConfirm={onConfirm} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel when the cancel button is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog isOpen description="d" onConfirm={onConfirm} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog isOpen description="d" onConfirm={() => {}} onCancel={onCancel} />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('uses danger styling on the confirm button for variant="danger"', () => {
    render(
      <ConfirmDialog
        isOpen
        variant="danger"
        description="d"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('confirm-dialog-confirm').className).toContain(
      'bg-danger'
    );
  });

  it('focuses the confirm button initially for the default variant', () => {
    render(
      <ConfirmDialog isOpen description="d" onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(document.activeElement).toBe(screen.getByTestId('confirm-dialog-confirm'));
  });

  it('focuses the cancel button initially for variant="danger"', () => {
    render(
      <ConfirmDialog
        isOpen
        variant="danger"
        description="d"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(document.activeElement).toBe(screen.getByTestId('confirm-dialog-cancel'));
  });
});

function Harness({ variant }: { variant?: 'default' | 'danger' }) {
  const confirm = useConfirm();
  const [result, setResult] = useState('none');
  return (
    <div>
      <button
        data-testid="open"
        onClick={() => {
          void confirm({ description: 'harness description', variant }).then((ok) =>
            setResult(String(ok))
          );
        }}
      >
        open
      </button>
      <span data-testid="result">{result}</span>
    </div>
  );
}

describe('useConfirm + ConfirmProvider', () => {
  it('resolves true when the user confirms', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByText('harness description')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('true'));
    // [Issue #1114] The Modal plays a 200ms exit animation before unmounting,
    // so the dialog leaves the DOM after the exit window instead of instantly.
    await waitForElementToBeRemoved(() => screen.queryByTestId('confirm-dialog'));
  });

  it('resolves false when the user cancels', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByTestId('open'));
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
    // [Issue #1114] Content must stay intact (not blank out) while the exit
    // animation plays, then the dialog unmounts after the exit window.
    expect(screen.getByText('harness description')).toBeInTheDocument();
    await waitForElementToBeRemoved(() => screen.queryByTestId('confirm-dialog'));
  });

  it('resolves false when dismissed with Escape', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByTestId('open'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
  });

  it('passes the variant through to the dialog', () => {
    render(
      <ConfirmProvider>
        <Harness variant="danger" />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByTestId('confirm-dialog-confirm').className).toContain(
      'bg-danger'
    );
    expect(document.activeElement).toBe(screen.getByTestId('confirm-dialog-cancel'));
  });

  it('restores focus to the trigger element after the dialog settles', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>
    );
    const opener = screen.getByTestId('open');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('true'));
    expect(document.activeElement).toBe(opener);
  });

  it('resolves false and warns when used without a provider', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Harness />);
    fireEvent.click(screen.getByTestId('open'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});

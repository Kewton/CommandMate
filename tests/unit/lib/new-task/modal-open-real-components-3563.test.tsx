/**
 * isAnyModalOpen against the real components (Issue #3563): FullScreenModal and
 * FileViewer are modals without a `tabindex`; the inline PromptPanel is not a
 * modal although it carries role="dialog" aria-modal="true".
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

import { isAnyModalOpen } from '@/lib/new-task/modal-open';
import { FullScreenModal } from '@/components/common/FullScreenModal';
import { FileViewer } from '@/components/worktree/FileViewer';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { Modal } from '@/components/ui/Modal';
import type { YesNoPromptData } from '@/types/models';

const yesNoPrompt: YesNoPromptData = {
  type: 'yes_no',
  status: 'pending',
  question: 'Proceed?',
  options: ['yes', 'no'],
};

function panel() {
  return (
    <PromptPanel
      promptData={yesNoPrompt}
      messageId="m1"
      visible
      answering={false}
      onRespond={async () => {}}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe('[#3563] isAnyModalOpen with real components', () => {
  it('counts an open FullScreenModal (no tabindex)', () => {
    render(
      <FullScreenModal isOpen onClose={() => {}} title="Edit">
        body
      </FullScreenModal>,
    );
    expect(screen.getByTestId('full-screen-modal').hasAttribute('tabindex')).toBe(false);
    expect(isAnyModalOpen()).toBe(true);
  });

  it('counts an open FileViewer markdown screen (no tabindex)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path: 'a.md', content: '# hi', extension: 'md', worktreePath: '/wt' }),
    }) as unknown as typeof fetch;
    render(<FileViewer isOpen onClose={() => {}} worktreeId="wt" filePath="a.md" />);
    const screenEl = await screen.findByTestId('markdown-file-screen');
    expect(screenEl.hasAttribute('tabindex')).toBe(false);
    expect(isAnyModalOpen()).toBe(true);
  });

  it('counts the ui/Modal that holds the help (existing control)', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Help">
        body
      </Modal>,
    );
    expect(isAnyModalOpen()).toBe(true);
  });

  it('does not count the inline PromptPanel', () => {
    render(panel());
    expect(screen.getByTestId('prompt-panel').getAttribute('aria-modal')).toBe('true');
    expect(isAnyModalOpen()).toBe(false);
  });

  it('does not count a PromptPanel inside a hidden split', () => {
    render(<div style={{ display: 'none' }}>{panel()}</div>);
    expect(isAnyModalOpen()).toBe(false);
  });

  it('counts a modal even while an inline PromptPanel is up', () => {
    render(
      <>
        {panel()}
        <FullScreenModal isOpen onClose={() => {}} title="Edit">
          body
        </FullScreenModal>
      </>,
    );
    expect(isAnyModalOpen()).toBe(true);
  });

  it('does not count a closed FullScreenModal', () => {
    render(
      <FullScreenModal isOpen={false} onClose={() => {}} title="Edit">
        body
      </FullScreenModal>,
    );
    expect(isAnyModalOpen()).toBe(false);
  });
});

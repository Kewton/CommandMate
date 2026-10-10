/**
 * @vitest-environment jsdom
 *
 * Issue #3522: the standalone file viewer page draws ```mermaid as a diagram.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useParams: () => ({ id: 'wt-1', path: ['docs', 'a.md'] }),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/components/worktree/MermaidCodeBlock', () => ({
  MermaidCodeBlock: ({ className, children }: { className?: string; children?: React.ReactNode }) =>
    className?.includes('language-mermaid') ? (
      <div data-testid="mermaid-block-frame">
        <details data-testid="mermaid-source">
          <summary>source</summary>
          {children}
        </details>
      </div>
    ) : (
      <code className={className}>{children}</code>
    ),
}));

import FileViewerPage from '@/app/worktrees/[id]/files/[...path]/page';

const MARKDOWN = [
  '# Title',
  '',
  'Inline `foo` here.',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '```ts',
  'const x = 1;',
  '```',
].join('\n');

describe('FileViewerPage mermaid (Issue #3522)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          path: 'docs/a.md',
          extension: 'md',
          worktreePath: '/wt',
          content: MARKDOWN,
        }),
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a mermaid fence as a diagram frame with a closed source', async () => {
    const { container } = render(<FileViewerPage />);
    const frame = await screen.findByTestId('mermaid-block-frame');
    expect(frame).toBeTruthy();
    expect(frame.closest('pre')).toBeNull();
    const source = screen.getByTestId('mermaid-source') as HTMLDetailsElement;
    expect(source.open).toBe(false);
    // the mermaid fence gets no copy button of its own
    expect(frame.querySelector('button')).toBeNull();
    // only the ```ts block is wrapped (one <pre>)
    expect(container.querySelectorAll('pre').length).toBe(1);
  });

  it('keeps the copy button on other code blocks and inline code styling', async () => {
    const { container } = render(<FileViewerPage />);
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());
    const pre = container.querySelector('pre') as HTMLElement;
    expect(pre.textContent).toContain('const x = 1;');
    expect(pre.parentElement?.querySelector('button')).not.toBeNull();
    const inline = Array.from(container.querySelectorAll('code')).find((c) => c.textContent === 'foo');
    expect(inline?.className).toContain('bg-gray-100');
  });
});

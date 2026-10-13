/**
 * Tests for the Repositories page (/repositories)
 *
 * Issue #880: The action area (RepositoryManager: "+ Add Repository" / "Sync All")
 * must be rendered ABOVE the repository list so the buttons appear at the top
 * of the page.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Issue #3579: the heading comes from `common.nav.repositories`; resolve it
// through the real en dictionary instead of the global key-echoing mock.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
import RepositoriesPage from '@/app/repositories/page';

// Stub the heavy child components with identifiable markers so we can assert
// their relative order in the DOM.
vi.mock('@/components/repository', () => ({
  RepositoryManager: () => <div data-testid="repository-manager" />,
  RepositoryList: () => <div data-testid="repository-list" />,
}));

describe('RepositoriesPage (Issue #880)', () => {
  it('renders RepositoryManager (action buttons) above RepositoryList', () => {
    render(<RepositoriesPage />);

    const manager = screen.getByTestId('repository-manager');
    const list = screen.getByTestId('repository-list');

    expect(manager).toBeInTheDocument();
    expect(list).toBeInTheDocument();

    // Manager must precede the list in document order (top of the page).
    const position = manager.compareDocumentPosition(list);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the page title', () => {
    render(<RepositoriesPage />);
    expect(screen.getByRole('heading', { name: 'Repositories' })).toBeInTheDocument();
  });
});

/**
 * Unit Tests for PdfPreview Component
 * Issue #673: PDF viewer implementation
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { PdfPreview } from '@/components/worktree/PdfPreview';

// ----------------------------------------------------------------------------
// Test doubles for URL.createObjectURL / revokeObjectURL
// ----------------------------------------------------------------------------

let createdUrls: string[] = [];
let revokedUrls: string[] = [];
let urlCounter = 0;

function installUrlStubs(): void {
  createdUrls = [];
  revokedUrls = [];
  urlCounter = 0;

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((_blob: Blob) => {
      urlCounter += 1;
      const url = `blob:mock://pdf-${urlCounter}`;
      createdUrls.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revokedUrls.push(url);
    }),
  });
}

function installFetchStub(buffer: ArrayBuffer = new ArrayBuffer(8)): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob([buffer], { type: 'application/pdf' }),
  }) as unknown as typeof fetch;
}

function installFailingFetchStub(): void {
  global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
}

// ----------------------------------------------------------------------------

describe('PdfPreview', () => {
  const defaultProps = {
    dataUri: 'data:application/pdf;base64,JVBERi0xLjQK',
    filePath: 'docs/sample.pdf',
  };

  beforeEach(() => {
    installUrlStubs();
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders an iframe without the sandbox attribute (Chrome PDF viewer compat) and correct title after blob URL is ready', async () => {
    render(<PdfPreview {...defaultProps} />);

    await waitFor(() => {
      const iframe = screen.getByTitle(`PDF Preview: ${defaultProps.filePath}`);
      expect(iframe).toBeInTheDocument();
      expect(iframe.hasAttribute('sandbox')).toBe(false);
    });
  });

  it('sets the iframe src to the generated blob URL', async () => {
    render(<PdfPreview {...defaultProps} />);

    await waitFor(() => {
      const iframe = screen.getByTitle(
        `PDF Preview: ${defaultProps.filePath}`,
      ) as HTMLIFrameElement;
      expect(iframe.src).toBe(createdUrls[0]);
    });
  });

  it('calls URL.createObjectURL exactly once for a stable filePath', async () => {
    render(<PdfPreview {...defaultProps} />);

    await waitFor(() => {
      expect(createdUrls).toHaveLength(1);
    });
  });

  it('revokes the blob URL on unmount (cleanup)', async () => {
    const { unmount } = render(<PdfPreview {...defaultProps} />);

    await waitFor(() => {
      expect(createdUrls).toHaveLength(1);
    });

    unmount();

    await waitFor(() => {
      expect(revokedUrls).toContain(createdUrls[0]);
    });
  });

  it('revokes the old blob URL when filePath changes', async () => {
    const { rerender } = render(<PdfPreview {...defaultProps} />);

    await waitFor(() => {
      expect(createdUrls).toHaveLength(1);
    });

    const oldUrl = createdUrls[0];

    rerender(
      <PdfPreview
        dataUri="data:application/pdf;base64,JVBERi0xLjQKBB=="
        filePath="docs/other.pdf"
      />,
    );

    await waitFor(() => {
      expect(createdUrls.length).toBeGreaterThanOrEqual(2);
      expect(revokedUrls).toContain(oldUrl);
    });
  });

  it('renders an error fallback with a download link when fetch fails', async () => {
    installFailingFetchStub();
    render(<PdfPreview {...defaultProps} />);

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /download/i });
      expect(link).toBeInTheDocument();
      expect(link.getAttribute('href')).toBe(defaultProps.dataUri);
    });
  });

  it('shows a loading indicator before the blob URL is ready', () => {
    render(<PdfPreview {...defaultProps} />);
    // Loading element is present synchronously on first render.
    expect(screen.getByTestId('pdf-preview-loading')).toBeInTheDocument();
  });
});

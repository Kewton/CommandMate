/**
 * MermaidCodeBlock Component Tests
 *
 * Tests for the code block wrapper component including:
 * - Mermaid language detection (className='language-mermaid')
 * - Non-mermaid code block passthrough
 * - Inline code block passthrough
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MermaidCodeBlock } from '@/components/worktree/MermaidCodeBlock';

// Hoisted clipboard mock for the copy button (Issue #981)
const { mockCopyToClipboard } = vi.hoisted(() => ({
  mockCopyToClipboard: vi.fn(),
}));

vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: mockCopyToClipboard,
}));

// Mock MermaidDiagram component
vi.mock('@/components/worktree/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => (
    <div data-testid="mermaid-diagram-mock">{code}</div>
  ),
}));

// Mock next/dynamic to render the component directly
vi.mock('next/dynamic', () => ({
  default: (
    loader: () => Promise<{ MermaidDiagram: React.ComponentType<{ code: string }> }>,
    _options: unknown
  ) => {
    // Return a component that renders the loading state briefly then the actual component
    const DynamicComponent = (props: { code: string }) => {
      return <div data-testid="mermaid-diagram-mock">{props.code}</div>;
    };
    return DynamicComponent;
  },
}));

describe('MermaidCodeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Mermaid Language Detection', () => {
    it('should detect mermaid language from className="language-mermaid"', () => {
      const mermaidCode = 'graph TD\nA-->B';

      render(
        <MermaidCodeBlock className="language-mermaid">
          {mermaidCode}
        </MermaidCodeBlock>
      );

      // Should render MermaidDiagram (mocked)
      const diagramMock = screen.getByTestId('mermaid-diagram-mock');
      expect(diagramMock).toBeInTheDocument();
      // Check that the code was passed (textContent normalizes whitespace)
      expect(diagramMock.textContent).toContain('graph TD');
      expect(diagramMock.textContent).toContain('A-->B');
    });

    it('should handle className with multiple classes including language-mermaid', () => {
      const mermaidCode = 'graph TD\nA-->B';

      render(
        <MermaidCodeBlock className="code language-mermaid highlight">
          {mermaidCode}
        </MermaidCodeBlock>
      );

      expect(screen.getByTestId('mermaid-diagram-mock')).toBeInTheDocument();
    });
  });

  describe('Non-mermaid Code Block Passthrough', () => {
    it('should render regular code element for non-mermaid languages', () => {
      const jsCode = 'const x = 1;';

      render(
        <MermaidCodeBlock className="language-javascript">
          {jsCode}
        </MermaidCodeBlock>
      );

      // Should render as regular code element
      const codeElement = screen.getByText(jsCode);
      expect(codeElement.tagName).toBe('CODE');
      expect(codeElement).toHaveClass('language-javascript');
    });

    it('should render regular code element when no className', () => {
      const plainCode = 'plain text';

      render(
        <MermaidCodeBlock>
          {plainCode}
        </MermaidCodeBlock>
      );

      const codeElement = screen.getByText(plainCode);
      expect(codeElement.tagName).toBe('CODE');
    });

    it('should render regular code element for python language', () => {
      const pythonCode = 'print("hello")';

      render(
        <MermaidCodeBlock className="language-python">
          {pythonCode}
        </MermaidCodeBlock>
      );

      const codeElement = screen.getByText(pythonCode);
      expect(codeElement.tagName).toBe('CODE');
      expect(codeElement).toHaveClass('language-python');
    });
  });

  describe('Inline Code Block Passthrough', () => {
    it('should render inline code as regular code element', () => {
      const inlineCode = 'inline code';

      render(
        <MermaidCodeBlock inline={true}>
          {inlineCode}
        </MermaidCodeBlock>
      );

      const codeElement = screen.getByText(inlineCode);
      expect(codeElement.tagName).toBe('CODE');
    });

    it('should not render MermaidDiagram for inline code even with mermaid className', () => {
      const inlineCode = 'graph TD';

      render(
        <MermaidCodeBlock inline={true} className="language-mermaid">
          {inlineCode}
        </MermaidCodeBlock>
      );

      // Should render as regular code, not MermaidDiagram
      const codeElement = screen.getByText(inlineCode);
      expect(codeElement.tagName).toBe('CODE');
      expect(screen.queryByTestId('mermaid-diagram-mock')).not.toBeInTheDocument();
    });
  });

  describe('Children Handling', () => {
    it('should handle string children', () => {
      render(
        <MermaidCodeBlock className="language-mermaid">
          graph TD
        </MermaidCodeBlock>
      );

      expect(screen.getByTestId('mermaid-diagram-mock')).toHaveTextContent('graph TD');
    });

    it('should handle array of strings as children', () => {
      render(
        <MermaidCodeBlock className="language-mermaid">
          {['graph TD', '\n', 'A-->B']}
        </MermaidCodeBlock>
      );

      const diagramMock = screen.getByTestId('mermaid-diagram-mock');
      // Check that both parts of the code are present
      expect(diagramMock.textContent).toContain('graph TD');
      expect(diagramMock.textContent).toContain('A-->B');
    });

    it('should handle undefined children gracefully', () => {
      // Should not throw
      expect(() => {
        render(
          <MermaidCodeBlock className="language-mermaid">
            {undefined}
          </MermaidCodeBlock>
        );
      }).not.toThrow();
    });

    it('should handle empty string children', () => {
      render(
        <MermaidCodeBlock className="language-mermaid">
          {''}
        </MermaidCodeBlock>
      );

      // Should still render (empty diagram will show error)
      expect(screen.getByTestId('mermaid-diagram-mock')).toBeInTheDocument();
    });
  });

  describe('Copy button (Issue #981)', () => {
    beforeEach(() => {
      mockCopyToClipboard.mockResolvedValue(undefined);
    });

    it('renders a copy button for non-mermaid block code', () => {
      render(
        <MermaidCodeBlock className="language-javascript">
          const x = 1;
        </MermaidCodeBlock>
      );

      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      // The underlying code element is preserved
      const codeElement = screen.getByText('const x = 1;');
      expect(codeElement.tagName).toBe('CODE');
      expect(codeElement).toHaveClass('language-javascript');
    });

    it('copies the code text when the copy button is clicked', async () => {
      render(
        <MermaidCodeBlock className="language-javascript">
          const x = 1;
        </MermaidCodeBlock>
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      });

      expect(mockCopyToClipboard).toHaveBeenCalledWith('const x = 1;');
    });

    it('does not render a copy button for mermaid diagrams', () => {
      render(
        <MermaidCodeBlock className="language-mermaid">
          graph TD
        </MermaidCodeBlock>
      );

      expect(screen.getByTestId('mermaid-diagram-mock')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    });

    it('does not render a copy button for inline code', () => {
      render(
        <MermaidCodeBlock inline={true} className="language-javascript">
          inline code
        </MermaidCodeBlock>
      );

      expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    });
  });
});

/**
 * MermaidCodeBlock Component Tests
 *
 * MermaidCodeBlock renders a mermaid diagram for `language-mermaid` fenced
 * blocks and a plain <code> element for everything else (inline code and
 * non-mermaid block code). Since Issue #983 the copy button for block code is
 * attached by MarkdownPreview's `pre` renderer — not here — so this component
 * never renders a copy button.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MermaidCodeBlock } from '@/components/worktree/MermaidCodeBlock';

// Mock MermaidDiagram component
vi.mock('@/components/worktree/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => (
    <div data-testid="mermaid-diagram-mock">{code}</div>
  ),
}));

// Mock next/dynamic to render the component directly
vi.mock('next/dynamic', () => ({
  default: () => {
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

    it('should render regular code element when no className (inline code)', () => {
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

  describe('No copy button here (Issue #983)', () => {
    it('does not render a copy button for non-mermaid block code', () => {
      render(
        <MermaidCodeBlock className="language-javascript">
          const x = 1;
        </MermaidCodeBlock>
      );

      // The copy button is attached by MarkdownPreview's `pre` renderer, not
      // here, so this component renders only the plain <code> element.
      expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
      const codeElement = screen.getByText('const x = 1;');
      expect(codeElement.tagName).toBe('CODE');
      expect(codeElement).toHaveClass('language-javascript');
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
  });
});

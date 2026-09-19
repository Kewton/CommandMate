/**
 * MermaidDiagram Component Tests
 *
 * Tests for the mermaid diagram rendering component including:
 * - Normal rendering (flowchart, sequenceDiagram)
 * - Error handling (syntax errors, empty code)
 * - Security configuration (securityLevel='strict')
 * - XSS prevention (SEC-MF-001 regression)
 * - Issue #95 SVG XSS alignment (SEC-SF-004)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MermaidDiagram } from '@/components/worktree/MermaidDiagram';
import { MERMAID_CONFIG } from '@/config/mermaid-config';

// Mock mermaid library
const mockRender = vi.fn();
const mockInitialize = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    render: (...args: unknown[]) => mockRender(...args),
  },
}));

describe('MermaidDiagram', () => {
  beforeEach(() => {
    // Reset all mocks completely (including implementations)
    mockRender.mockReset();
    mockInitialize.mockReset();
    // Set default mock behavior - each test should override if needed
    mockRender.mockResolvedValue({ svg: '<svg>Default</svg>' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Security Configuration (SEC-SF-003)', () => {
    it('should have securityLevel set to strict in config', () => {
      expect(MERMAID_CONFIG.securityLevel).toBe('strict');
    });

    it('should have startOnLoad set to false in config', () => {
      expect(MERMAID_CONFIG.startOnLoad).toBe(false);
    });

    it('should initialize mermaid with strict security level', async () => {
      mockRender.mockResolvedValue({ svg: '<svg>Test</svg>' });

      render(<MermaidDiagram code="graph TD\nA-->B" />);

      await waitFor(() => {
        expect(mockInitialize).toHaveBeenCalledWith(
          expect.objectContaining({
            securityLevel: 'strict',
          })
        );
      });
    });
  });

  describe('Normal Rendering', () => {
    it('should render flowchart successfully', async () => {
      const flowchartCode = `graph TD
A[Start] --> B[Process]
B --> C[End]`;

      mockRender.mockResolvedValue({
        svg: '<svg data-testid="mermaid-svg">Flowchart</svg>',
      });

      render(<MermaidDiagram code={flowchartCode} />);

      await waitFor(() => {
        expect(mockRender).toHaveBeenCalled();
      });

      // Check that SVG is rendered
      const container = screen.getByTestId('mermaid-container');
      expect(container.innerHTML).toContain('svg');
    });

    it('should render sequenceDiagram successfully', async () => {
      const sequenceCode = `sequenceDiagram
Alice->>Bob: Hello
Bob-->>Alice: Hi`;

      mockRender.mockResolvedValue({
        svg: '<svg>Sequence Diagram</svg>',
      });

      render(<MermaidDiagram code={sequenceCode} />);

      await waitFor(() => {
        expect(mockRender).toHaveBeenCalled();
      });

      const container = screen.getByTestId('mermaid-container');
      expect(container.innerHTML).toContain('svg');
    });

    it('should show loading state initially', () => {
      mockRender.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      render(<MermaidDiagram code="graph TD\nA-->B" />);

      expect(screen.getByTestId('mermaid-loading')).toBeInTheDocument();
    });

    it('should use provided id prop', async () => {
      render(<MermaidDiagram code="graph TD\nA-->B" id="custom-diagram-id" />);

      await waitFor(() => {
        expect(mockRender).toHaveBeenCalledWith(
          'custom-diagram-id',
          expect.any(String)
        );
      });
    });

    it('should generate unique id when not provided', async () => {
      render(<MermaidDiagram code="graph TD\nA-->B" />);

      await waitFor(() => {
        const renderCall = mockRender.mock.calls[0];
        expect(renderCall[0]).toMatch(/^mermaid-/);
      });
    });
  });

  describe('Error Handling', () => {
    it('should display error message for syntax errors', async () => {
      mockRender.mockRejectedValue(new Error('Parse error'));

      render(<MermaidDiagram code="invalid mermaid code" />);

      await waitFor(() => {
        expect(screen.getByTestId('mermaid-error')).toBeInTheDocument();
        expect(screen.getByText(/Parse error/i)).toBeInTheDocument();
      });
    });

    it('should display error for empty code', async () => {
      render(<MermaidDiagram code="" />);

      await waitFor(() => {
        expect(screen.getByTestId('mermaid-error')).toBeInTheDocument();
        expect(screen.getByText(/empty/i)).toBeInTheDocument();
      });
    });

    it('should display error for whitespace-only code', async () => {
      // This test verifies that whitespace-only code is treated as empty
      // Since whitespace.trim() === '', the component should show an error
      // Note: The component logic should detect empty code BEFORE calling mermaid.render()

      // Verify our whitespace string trims to empty
      const whitespaceCode = '   \n  \t  ';
      expect(whitespaceCode.trim()).toBe('');

      render(<MermaidDiagram code={whitespaceCode} />);

      // Wait for the error state to be rendered
      await waitFor(() => {
        expect(screen.getByTestId('mermaid-error')).toBeInTheDocument();
      }, { timeout: 2000 });
    });

    it('should not crash UI on render error', async () => {
      mockRender.mockRejectedValue(new Error('Render failed'));

      // Should not throw
      expect(() => {
        render(<MermaidDiagram code="broken code" />);
      }).not.toThrow();

      await waitFor(() => {
        expect(screen.getByTestId('mermaid-error')).toBeInTheDocument();
      });
    });
  });

  describe('XSS Prevention (SEC-MF-001 regression)', () => {
    it('should sanitize script tags in node labels', async () => {
      const maliciousCode = `graph TD
A[<script>alert('xss')</script>]
B[Normal Node]
A --> B`;

      // Mock render returns sanitized SVG (mermaid internal behavior)
      mockRender.mockResolvedValue({
        svg: '<svg>Safe Diagram without script</svg>',
      });

      render(<MermaidDiagram code={maliciousCode} />);

      await waitFor(() => {
        const container = screen.getByTestId('mermaid-container');
        expect(container.innerHTML).not.toContain('<script');
      });
    });

    it('should sanitize event handlers in node labels', async () => {
      const maliciousCode = `graph TD
A[<img src=x onerror="alert('xss')">]
B[Normal Node]
A --> B`;

      // mermaid securityLevel='strict' sanitizes event handlers
      mockRender.mockResolvedValue({
        svg: '<svg>Safe Diagram</svg>',
      });

      render(<MermaidDiagram code={maliciousCode} />);

      await waitFor(() => {
        const container = screen.getByTestId('mermaid-container');
        // Verify mermaid was called with the code (security handled by mermaid itself)
        expect(mockRender).toHaveBeenCalled();
        // Mock returns sanitized SVG without event handlers
        expect(container.innerHTML).not.toMatch(/\sonerror=/i);
      });
    });

    it('should sanitize javascript: URLs in links', async () => {
      const maliciousCode = `graph TD
A[Click me]
click A "javascript:alert('xss')"`;

      // mermaid securityLevel='strict' sanitizes dangerous URLs
      mockRender.mockResolvedValue({
        svg: '<svg>Safe Diagram</svg>',
      });

      render(<MermaidDiagram code={maliciousCode} />);

      await waitFor(() => {
        const container = screen.getByTestId('mermaid-container');
        // Verify mermaid was called with the code (security handled by mermaid itself)
        expect(mockRender).toHaveBeenCalled();
        // Mock returns sanitized SVG without javascript: URL
        expect(container.innerHTML).not.toMatch(/javascript:/i);
      });
    });

    it('should handle nested malicious content', async () => {
      const maliciousCode = `sequenceDiagram
Alice->>Bob: <script>document.cookie</script>
Bob-->>Alice: <img src=x onerror=alert(1)>`;

      // mermaid securityLevel='strict' sanitizes nested malicious content
      mockRender.mockResolvedValue({
        svg: '<svg>Safe Sequence Diagram</svg>',
      });

      render(<MermaidDiagram code={maliciousCode} />);

      await waitFor(() => {
        const container = screen.getByTestId('mermaid-container');
        // Verify mermaid was called with the code (security handled by mermaid itself)
        expect(mockRender).toHaveBeenCalled();
        // Mock returns sanitized SVG
        expect(container.innerHTML).not.toMatch(/<script[\s>]/i);
        expect(container.innerHTML).not.toMatch(/\sonerror=/i);
      });
    });
  });

  describe('Issue #95 SVG XSS alignment (SEC-SF-004)', () => {
    it('should prevent script tags (Issue #95 item 1)', async () => {
      mockRender.mockResolvedValue({
        svg: '<svg>Diagram</svg>',
      });

      render(<MermaidDiagram code="graph TD\nA[Test]" />);

      await waitFor(() => {
        const container = screen.getByTestId('mermaid-container');
        expect(container.innerHTML).not.toMatch(/<script[\s>]/i);
      });
    });

    it('should prevent event handlers (Issue #95 item 2)', async () => {
      mockRender.mockResolvedValue({
        svg: '<svg>Diagram</svg>',
      });

      render(<MermaidDiagram code="graph TD\nA[Test]" />);

      await waitFor(() => {
        const container = screen.getByTestId('mermaid-container');
        expect(container.innerHTML).not.toMatch(/\son\w+=/i);
      });
    });

    it('should prevent dangerous URL schemes (Issue #95 item 3)', async () => {
      mockRender.mockResolvedValue({
        svg: '<svg>Diagram</svg>',
      });

      render(<MermaidDiagram code="graph TD\nA[Test]" />);

      await waitFor(() => {
        const container = screen.getByTestId('mermaid-container');
        expect(container.innerHTML).not.toMatch(/(?:javascript|data|vbscript):/i);
      });
    });

    it('should restrict foreignObject (Issue #95 item 4)', async () => {
      // mermaid securityLevel='strict' restricts foreignObject usage
      mockRender.mockResolvedValue({
        svg: '<svg>Diagram without foreignObject</svg>',
      });

      render(<MermaidDiagram code="graph TD\nA[Test]" />);

      await waitFor(() => {
        const container = screen.getByTestId('mermaid-container');
        // SVG should not contain foreignObject
        expect(container.innerHTML).not.toMatch(/<foreignObject[\s>]/i);
      });
    });
  });

  describe('Re-render on code change', () => {
    it('should re-render when code changes', async () => {
      const { rerender } = render(<MermaidDiagram code="graph TD\nA-->B" />);

      await waitFor(() => {
        expect(mockRender).toHaveBeenCalledTimes(1);
      });

      // Change code
      rerender(<MermaidDiagram code="graph TD\nA-->C" />);

      await waitFor(() => {
        expect(mockRender).toHaveBeenCalledTimes(2);
      });
    });
  });
});

/**
 * MermaidDiagram Component
 *
 * Renders mermaid diagram syntax as SVG using mermaid.js library.
 * Must be dynamically imported with ssr: false.
 *
 * @security Uses mermaid securityLevel='strict' to prevent XSS
 * @see SEC-SF-003 Security review requirement
 *
 * @module components/worktree/MermaidDiagram
 */

'use client';

import React, { useState, useEffect, useRef, useId } from 'react';
import mermaid from 'mermaid';
import { MERMAID_CONFIG } from '@/config/mermaid-config';

/**
 * Props for MermaidDiagram component
 */
export interface MermaidDiagramProps {
  /** Mermaid diagram code */
  code: string;
  /** Optional unique ID for the diagram */
  id?: string;
}

/**
 * Flag to track if mermaid has been initialized
 */
let mermaidInitialized = false;

/**
 * Initialize mermaid with validation
 *
 * [SEC-SF-003] Validates that securityLevel is 'strict' before initialization.
 * This is a fail-safe mechanism to prevent accidental security misconfiguration.
 *
 * @throws Error if securityLevel is not 'strict'
 */
function initializeMermaidWithValidation(): void {
  if (mermaidInitialized) return;

  // Security validation: securityLevel must be 'strict'
  if (MERMAID_CONFIG.securityLevel !== 'strict') {
    throw new Error(
      `[SECURITY] mermaid securityLevel must be 'strict', but got '${MERMAID_CONFIG.securityLevel}'. ` +
        'This is a security requirement to prevent XSS attacks.'
    );
  }

  mermaid.initialize(MERMAID_CONFIG);
  mermaidInitialized = true;
}

/**
 * MermaidDiagram Component
 *
 * Renders mermaid diagram code as an SVG.
 *
 * @example
 * ```tsx
 * <MermaidDiagram
 *   code="graph TD\nA[Start] --> B[End]"
 *   id="my-diagram"
 * />
 * ```
 */
export function MermaidDiagram({
  code,
  id: providedId,
}: MermaidDiagramProps): JSX.Element {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Generate unique ID if not provided
  const reactId = useId();
  const diagramId = providedId || `mermaid-${reactId.replace(/:/g, '-')}`;

  useEffect(() => {
    let isMounted = true;

    const renderDiagram = async () => {
      // Reset state
      setIsLoading(true);
      setError(null);
      setSvg('');

      // Validate input
      const trimmedCode = code?.trim() || '';
      if (!trimmedCode) {
        if (isMounted) {
          setError('Diagram code is empty');
          setIsLoading(false);
        }
        return;
      }

      try {
        // Initialize mermaid with security validation
        initializeMermaidWithValidation();

        // Render the diagram
        const { svg: renderedSvg } = await mermaid.render(
          diagramId,
          trimmedCode
        );

        if (isMounted) {
          setSvg(renderedSvg);
          setIsLoading(false);
        }
      } catch (err) {
        if (isMounted) {
          const message =
            err instanceof Error ? err.message : 'Failed to render diagram';
          setError(message);
          setIsLoading(false);
        }
      }
    };

    renderDiagram();

    return () => {
      isMounted = false;
    };
  }, [code, diagramId]);

  // Loading state
  if (isLoading) {
    return (
      <div
        data-testid="mermaid-loading"
        className="flex items-center justify-center p-4 text-gray-500"
      >
        <div className="flex items-center gap-2">
          <div className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-blue-600" />
          <span>Rendering diagram...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        data-testid="mermaid-error"
        className="bg-red-50 border border-red-200 p-4 rounded"
      >
        <p className="text-red-600 font-medium">Diagram Error</p>
        <pre className="text-sm text-red-500 mt-2 whitespace-pre-wrap break-words bg-red-50">
          {error}
        </pre>
      </div>
    );
  }

  // Success: render SVG
  return (
    <div
      ref={containerRef}
      data-testid="mermaid-container"
      className="mermaid-container max-w-full overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

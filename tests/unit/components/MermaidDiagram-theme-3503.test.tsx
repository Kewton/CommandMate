/**
 * MermaidDiagram follows the app theme, through one serialized queue
 * (Issue #3503).
 *
 * mermaid's configuration is global, so `initialize(theme)` and `render` for
 * every diagram on screen run one after another: a theme switch re-initializes
 * once and then redraws each diagram with the new theme.
 *
 * mermaid is mocked here to observe the call order; the real runtime is in
 * `worktree/MermaidDiagram-real-3503.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock('mermaid', () => ({ default: mermaidMock }));

const themeState = vi.hoisted(() => ({ resolvedTheme: 'light' as string | undefined }));
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: themeState.resolvedTheme, setTheme: () => {} }),
}));

import { MermaidDiagram } from '@/components/worktree/MermaidDiagram';
import { resolveMermaidTheme, buildMermaidConfig, MERMAID_CONFIG } from '@/config/mermaid-config';

/** A promise and its resolver. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The theme `initialize` was last called with before the n-th render call. */
function themeAtRender(n: number): string | undefined {
  const renderOrder = mermaidMock.render.mock.invocationCallOrder[n];
  let theme: string | undefined;
  mermaidMock.initialize.mock.calls.forEach((call, i) => {
    if (mermaidMock.initialize.mock.invocationCallOrder[i] < renderOrder) {
      theme = (call[0] as { theme: string }).theme;
    }
  });
  return theme;
}

beforeEach(() => {
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset();
  mermaidMock.render.mockImplementation(async (id: string) => ({ svg: `<svg id="${id}"></svg>` }));
  themeState.resolvedTheme = 'light';
  document.documentElement.classList.remove('dark');
});

describe('[#3503] the app theme picks the mermaid theme', () => {
  it('maps light → default and dark → dark, and nothing else', () => {
    expect(resolveMermaidTheme('light')).toBe('default');
    expect(resolveMermaidTheme('dark')).toBe('dark');
    expect(resolveMermaidTheme('system')).toBeNull();
    expect(resolveMermaidTheme(undefined)).toBeNull();
  });

  it('draws with `dark` on the dark theme', async () => {
    themeState.resolvedTheme = 'dark';
    render(<MermaidDiagram code="graph TD\nA-->B" />);
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));
    expect(themeAtRender(0)).toBe('dark');
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark', securityLevel: 'strict' }),
    );
    expect(await screen.findByTestId('mermaid-container')).toHaveAttribute('data-mermaid-theme', 'dark');
  });

  it('falls back to the `dark` class on <html> when next-themes has no answer', async () => {
    themeState.resolvedTheme = undefined;
    document.documentElement.classList.add('dark');
    render(<MermaidDiagram code="graph TD\nA-->C" />);
    expect(await screen.findByTestId('mermaid-container')).toHaveAttribute('data-mermaid-theme', 'dark');
  });

  it('switching the theme redraws every diagram, each after the re-initialize', async () => {
    const { rerender } = render(
      <>
        <MermaidDiagram code="graph TD\nA-->B" />
        <MermaidDiagram code="graph TD\nA-->B" />
        <MermaidDiagram code="graph LR\nX-->Y" />
      </>,
    );
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(3));
    expect([0, 1, 2].map(themeAtRender)).toEqual(['default', 'default', 'default']);

    themeState.resolvedTheme = 'dark';
    rerender(
      <>
        <MermaidDiagram code="graph TD\nA-->B" />
        <MermaidDiagram code="graph TD\nA-->B" />
        <MermaidDiagram code="graph LR\nX-->Y" />
      </>,
    );
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(6));
    expect([3, 4, 5].map(themeAtRender)).toEqual(['dark', 'dark', 'dark']);
    // One initialize per theme, not one per diagram.
    const themes = mermaidMock.initialize.mock.calls.map((c) => (c[0] as { theme: string }).theme);
    expect(themes.filter((t) => t === 'dark')).toHaveLength(1);
  });

  it('renders one diagram at a time (the queue)', async () => {
    const first = deferred<{ svg: string }>();
    mermaidMock.render.mockImplementationOnce(() => first.promise);
    render(
      <>
        <MermaidDiagram code="graph TD\nA-->B" />
        <MermaidDiagram code="graph TD\nC-->D" />
      </>,
    );
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));
    // The second render waits for the first to finish.
    await new Promise((r) => setTimeout(r, 20));
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve({ svg: '<svg></svg>' });
    });
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
  });

  it('a failed render does not jam the queue', async () => {
    mermaidMock.render.mockImplementationOnce(async () => {
      throw new Error('Parse error');
    });
    render(
      <>
        <MermaidDiagram code="broken" />
        <MermaidDiagram code="graph TD\nA-->B" />
      </>,
    );
    expect(await screen.findByTestId('mermaid-error')).toBeInTheDocument();
    expect(await screen.findByTestId('mermaid-container')).toBeInTheDocument();
  });

  it('two diagrams with the same source render under different ids', async () => {
    render(
      <>
        <MermaidDiagram code="graph TD\nA-->B" />
        <MermaidDiagram code="graph TD\nA-->B" />
      </>,
    );
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
    const ids = mermaidMock.render.mock.calls.map((c) => c[0] as string);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^mermaid-[A-Za-z0-9_-]+$/);
  });

  it('reports each finished render to the caller', async () => {
    const onRenderStateChange = vi.fn();
    mermaidMock.render.mockImplementationOnce(async () => {
      throw new Error('Parse error');
    });
    const { rerender } = render(
      <MermaidDiagram code="broken" onRenderStateChange={onRenderStateChange} />,
    );
    await waitFor(() => expect(onRenderStateChange).toHaveBeenLastCalledWith('error'));
    rerender(<MermaidDiagram code="graph TD\nA-->B" onRenderStateChange={onRenderStateChange} />);
    await waitFor(() => expect(onRenderStateChange).toHaveBeenLastCalledWith('rendered'));
  });
});

describe('[#3503] the config handed to mermaid', () => {
  it('keeps securityLevel strict for both themes', () => {
    expect(MERMAID_CONFIG.securityLevel).toBe('strict');
    expect(buildMermaidConfig('default').securityLevel).toBe('strict');
    expect(buildMermaidConfig('dark').securityLevel).toBe('strict');
  });

  it('locks the theme keys against the diagram source, and keeps mermaid’s own locks', () => {
    const { secure } = buildMermaidConfig('dark');
    for (const key of ['theme', 'themeVariables', 'themeCSS', 'darkMode']) {
      expect(secure).toContain(key);
    }
    for (const key of ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges']) {
      expect(secure).toContain(key);
    }
  });

  it('suppresses mermaid’s error rendering (no temporary SVG left in <body>)', () => {
    expect(buildMermaidConfig('default').suppressErrorRendering).toBe(true);
  });
});

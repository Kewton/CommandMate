/**
 * MermaidDiagram against the REAL mermaid runtime (Issue #3503).
 *
 * The diagram's SVG is inserted after `rehypeSanitize` has run (sanitize never
 * sees it), so what keeps a chat answer from injecting script is mermaid's own
 * `securityLevel: 'strict'`. These tests run real mermaid 11 in jsdom:
 *
 * - script / event-handler / `javascript:` payloads do not survive into the SVG;
 * - a syntax error leaves no temporary SVG in `document.body`;
 * - the app theme wins over a `theme:` written in the diagram's frontmatter;
 * - a theme switch redraws with the new theme;
 * - two diagrams with the same source never share an element id.
 *
 * jsdom has no SVG layout, so `getBBox` / `getComputedTextLength` are stubbed
 * with a fixed box — enough for mermaid's flowchart to lay out. A label holding
 * `<img>` is not tested here: mermaid waits for the image's load event, which
 * jsdom never fires (the render never settles).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const themeState = vi.hoisted(() => ({ resolvedTheme: 'light' as string | undefined }));
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: themeState.resolvedTheme, setTheme: () => {} }),
}));

import { MermaidDiagram } from '@/components/worktree/MermaidDiagram';

/** mainBkg of mermaid's themes — painted on every flowchart node. */
const DEFAULT_BKG = /#ececff/i;
const DARK_BKG = /#1f2020/i;
const FOREST_BKG = /#cde498/i;

const RENDER_TIMEOUT = { timeout: 10_000 };

beforeAll(() => {
  const proto = window.SVGElement.prototype as unknown as {
    getBBox?: () => DOMRect;
    getComputedTextLength?: () => number;
  };
  proto.getBBox ??= () => ({ x: 0, y: 0, width: 60, height: 20 }) as DOMRect;
  proto.getComputedTextLength ??= () => 60;
});

afterEach(() => {
  cleanup();
  themeState.resolvedTheme = 'light';
});

async function drawn(code: string): Promise<HTMLElement> {
  render(<MermaidDiagram code={code} />);
  return screen.findByTestId('mermaid-container', {}, RENDER_TIMEOUT);
}

/** Temporary elements mermaid adds directly under <body> while rendering. */
function strayTemporaries(): Element[] {
  return Array.from(document.body.children).filter((el) => /^d?mermaid-/.test(el.id));
}

describe('[#3503] strict security with the real mermaid', () => {
  const PAYLOADS: Array<[string, string]> = [
    ['a <script> in a label', 'graph TD\nA["<script>alert(1)</script>x"] --> B'],
    ['an event handler in a label', 'graph TD\nA["<b onmouseover=alert(2)>x</b>"] --> B'],
    ['a javascript: link in a label', "graph TD\nA[\"<a href='javascript:alert(3)'>x</a>\"] --> B"],
    ['a javascript: click directive', 'graph TD\nA-->B\nclick A "javascript:alert(4)"'],
    ['an svg onload and an iframe', 'graph TD\nA["<svg onload=alert(5)></svg>x"] --> B["<iframe src=javascript:alert(6)></iframe>"]'],
  ];

  it.each(PAYLOADS)('drops %s', { timeout: 15_000 }, async (_label, code) => {
    const container = await drawn(code);
    const html = container.innerHTML;
    expect(html).toContain('<svg');
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<iframe[\s>]/i);
    expect(strayTemporaries()).toEqual([]);
  });

  it('a syntax error shows the error and leaves nothing in <body>', { timeout: 15_000 }, async () => {
    render(<MermaidDiagram code={'graph TD\nA -->'} />);
    expect(await screen.findByTestId('mermaid-error', {}, RENDER_TIMEOUT)).toBeInTheDocument();
    expect(strayTemporaries()).toEqual([]);
    expect(document.querySelectorAll('svg')).toHaveLength(0);
  });
});

describe('[#3503] the app theme, with the real mermaid', () => {
  it('draws light on the light theme and dark on the dark theme', { timeout: 20_000 }, async () => {
    const light = await drawn('graph TD\nA-->B');
    expect(light.innerHTML).toMatch(DEFAULT_BKG);
    cleanup();

    themeState.resolvedTheme = 'dark';
    const dark = await drawn('graph TD\nA-->B');
    expect(dark.innerHTML).toMatch(DARK_BKG);
    expect(dark.innerHTML).not.toMatch(DEFAULT_BKG);
  });

  it('the app theme wins over `theme:` in the frontmatter', { timeout: 20_000 }, async () => {
    themeState.resolvedTheme = 'dark';
    const container = await drawn('---\nconfig:\n  theme: forest\n---\ngraph TD\nA-->B');
    expect(container.innerHTML).toMatch(DARK_BKG);
    expect(container.innerHTML).not.toMatch(FOREST_BKG);
  });

  it('the app theme wins over a %%{init}%% directive too', { timeout: 20_000 }, async () => {
    themeState.resolvedTheme = 'light';
    const container = await drawn("%%{init: {'theme': 'dark'}}%%\ngraph TD\nA-->B");
    expect(container.innerHTML).toMatch(DEFAULT_BKG);
    expect(container.innerHTML).not.toMatch(DARK_BKG);
  });

  it('switching the theme redraws the diagram in the new colours', { timeout: 20_000 }, async () => {
    const { rerender } = render(<MermaidDiagram code={'graph TD\nA-->B'} />);
    const container = await screen.findByTestId('mermaid-container', {}, RENDER_TIMEOUT);
    await waitFor(() => expect(container.innerHTML).toMatch(DEFAULT_BKG), RENDER_TIMEOUT);

    themeState.resolvedTheme = 'dark';
    rerender(<MermaidDiagram code={'graph TD\nA-->B'} />);
    await waitFor(
      () => expect(screen.getByTestId('mermaid-container').innerHTML).toMatch(DARK_BKG),
      RENDER_TIMEOUT,
    );
    expect(screen.getByTestId('mermaid-container')).toHaveAttribute('data-mermaid-theme', 'dark');
  });
});

describe('[#3503] ids with the real mermaid', () => {
  it('two diagrams with the same source share no element id', { timeout: 20_000 }, async () => {
    render(
      <>
        <MermaidDiagram code={'graph TD\nA[same]-->B[same]'} />
        <MermaidDiagram code={'graph TD\nA[same]-->B[same]'} />
      </>,
    );
    await waitFor(
      () => expect(screen.getAllByTestId('mermaid-container')).toHaveLength(2),
      RENDER_TIMEOUT,
    );
    const ids = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
    expect(ids.length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length);
    // Each SVG's own style rules are scoped to its own id.
    const svgs = Array.from(document.querySelectorAll('svg'));
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) {
      expect(svg.querySelector('style')?.textContent).toContain(`#${svg.id}`);
      // Every in-SVG reference still resolves, and to an element of this SVG.
      const refs = Array.from(svg.querySelectorAll('*')).flatMap((el) =>
        Array.from(el.attributes)
          .map((a) => /url\(['"]?#([^'")]+)['"]?\)/.exec(a.value)?.[1])
          .filter((id): id is string => Boolean(id)),
      );
      expect(refs.length).toBeGreaterThan(0);
      for (const id of refs) {
        expect(svg.querySelector(`[id="${id}"]`), id).not.toBeNull();
      }
    }
  });
});

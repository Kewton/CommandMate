/**
 * Controls for the mermaid config of Issue #3503, against the REAL runtime.
 *
 * `MermaidDiagram-real-3503.test.tsx` shows the component leaves no temporary
 * SVG behind and keeps the app theme. This file shows those results come from
 * the config and not from luck: the same diagrams under the config that shipped
 * before #3503 (strict, `theme: 'default'`, nothing else) DO leave the element
 * behind and DO let the source pick its theme.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import mermaid from 'mermaid';
import { buildMermaidConfig } from '@/config/mermaid-config';

/** `MERMAID_CONFIG` as it was before #3503. */
const PRE_3503_CONFIG = { securityLevel: 'strict', startOnLoad: false, theme: 'default' } as const;

const DEFAULT_BKG = /#ececff/i;
const DARK_BKG = /#1f2020/i;
const SYNTAX_ERROR = 'graph TD\nA -->';
const DARK_FRONTMATTER = '---\nconfig:\n  theme: dark\n---\ngraph TD\nA-->B';

let seq = 0;
const nextId = () => `mermaid-control-${seq++}`;

beforeAll(() => {
  const proto = window.SVGElement.prototype as unknown as {
    getBBox?: () => DOMRect;
    getComputedTextLength?: () => number;
  };
  proto.getBBox ??= () => ({ x: 0, y: 0, width: 60, height: 20 }) as DOMRect;
  proto.getComputedTextLength ??= () => 60;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('[#3503] suppressErrorRendering: a syntax error leaves nothing in <body>', () => {
  it('positive control: the pre-#3503 config leaves the temporary element behind', async () => {
    mermaid.initialize({ ...PRE_3503_CONFIG });
    const id = nextId();
    await expect(mermaid.render(id, SYNTAX_ERROR)).rejects.toThrow();
    expect(document.getElementById(`d${id}`)).not.toBeNull();
  });

  it('the #3503 config removes it', async () => {
    mermaid.initialize(buildMermaidConfig('default'));
    const id = nextId();
    await expect(mermaid.render(id, SYNTAX_ERROR)).rejects.toThrow();
    expect(document.getElementById(`d${id}`)).toBeNull();
    expect(document.body.children).toHaveLength(0);
  });
});

describe('[#3503] secure theme keys: the app theme beats the source', () => {
  it('positive control: under the pre-#3503 config the frontmatter picks the theme', async () => {
    mermaid.initialize({ ...PRE_3503_CONFIG });
    const { svg } = await mermaid.render(nextId(), DARK_FRONTMATTER);
    expect(svg).toMatch(DARK_BKG);
  });

  it('under the #3503 config the initialized theme stays', async () => {
    mermaid.initialize(buildMermaidConfig('default'));
    const { svg } = await mermaid.render(nextId(), DARK_FRONTMATTER);
    expect(svg).toMatch(DEFAULT_BKG);
    expect(svg).not.toMatch(DARK_BKG);
  });

  it('a non-theme frontmatter setting is still honoured', async () => {
    mermaid.initialize(buildMermaidConfig('default'));
    const plain = await mermaid.render(nextId(), 'graph TD\nA-->B');
    const configured = await mermaid.render(
      nextId(),
      '---\nconfig:\n  theme: dark\n  fontFamily: KeptFont3503\n---\ngraph TD\nA-->B',
    );
    expect(plain.svg).not.toContain('KeptFont3503');
    expect(configured.svg).toContain('KeptFont3503');
    expect(configured.svg).toMatch(DEFAULT_BKG);
  });
});

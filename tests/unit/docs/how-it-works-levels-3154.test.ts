/**
 * Issue #3154: how-it-works (en / ja) follows the README's Level order.
 *
 * The `##` sections run Level 1 → Level 2 → Level 3 → Next → Anywhere →
 * Supported agents → Security → Measured, each Level states the human role
 * with the same role names as the README, and the contract YAML example
 * appears only once.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const DOCS = [
  {
    file: 'docs/en/user-guide/how-it-works.md',
    order: [
      'Level 1 — Parallel',
      'Level 2 — Delegate',
      'Level 3 — Manage',
      'Next — Learn',
      'Anywhere',
      'Supported agents',
      'Security',
      'Measured',
    ],
    roles: [
      'Your role: the operator.',
      'Your role: the product or tech lead.',
      'Your role: the owner.',
    ],
  },
  {
    file: 'docs/user-guide/how-it-works.md',
    order: [
      'Level 1 — Parallel',
      'Level 2 — Delegate',
      'Level 3 — Manage',
      'Next — Learn',
      'Anywhere',
      '対応エージェント',
      'セキュリティ',
      '実測',
    ],
    roles: [
      'あなたの役割: Operator。',
      'あなたの役割: Product / Tech lead。',
      'あなたの役割: Owner。',
    ],
  },
] as const;

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

function h2(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());
}

/** The body of the `## heading` section, up to the next `## `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n## ', start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

describe.each(DOCS)('$file (#3154)', ({ file, order, roles }) => {
  const text = read(file);

  it('keeps the Level order in its ## headings', () => {
    const headings = h2(text);
    const positions = order.map((heading) => headings.indexOf(heading));
    expect(positions.every((p) => p >= 0), headings.join(' | ')).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('states the human role in each Level', () => {
    order.slice(0, 3).forEach((heading, i) => {
      expect(section(text, heading)).toContain(roles[i]);
    });
  });

  it('has no duplicated theme sections and one contract YAML example', () => {
    const headings = h2(text);
    expect(new Set(headings).size).toBe(headings.length);
    expect(text.match(/^version: 1$/gm) ?? []).toHaveLength(1);
  });
});

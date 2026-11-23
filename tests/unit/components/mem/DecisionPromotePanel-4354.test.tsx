/**
 * The decision panel and Issue #4354 I-B3: a decision stored before the write refused its
 * destination (an agent's instruction file, `.git`, not a `.md`) is still listed, and its card
 * says why the destination cannot be used and what to choose instead — one sentence per reason,
 * in Japanese and in English. A decision whose destination can be used shows no such line.
 *
 * Positive control: before #4354 the card showed the destination only, so every row fails there.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ja from '../../../../locales/ja/common.json';
import en from '../../../../locales/en/common.json';

const locale = vi.hoisted(() => ({ current: 'ja' as 'ja' | 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

import { DecisionPromotePanel } from '@/components/mem/DecisionPromotePanel';

const REASONS = ['agent_instructions', 'git_dir', 'not_markdown'] as const;
const PATHS = { agent_instructions: 'path:CLAUDE.md', git_dir: 'path:.git/x.md', not_markdown: 'path:docs/x.txt' } as const;

const view = (id: string, promoteTo: string, promoteToRefusal?: string) => ({
  id,
  kind: 'decision',
  state: 'open',
  text: `決定 ${id}`,
  closeWhen: null,
  promoteTo,
  quote: null,
  quoteAt: null,
  evidence: [],
  closeNote: null,
  owner: {},
  createdBy: 'agent',
  updatedBy: 'agent',
  version: 1,
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
  closedAt: null,
  closeReason: null,
  stale: false,
  frozen: false,
  ...(promoteToRefusal ? { promoteToRefusal } : {}),
});

let listBody: Record<string, unknown>;

beforeEach(() => {
  locale.current = 'ja';
  listBody = {
    ok: true,
    mode: 'on',
    branch: 'feature/x',
    counts: { mode: 'on', approvable: true, open: 4, recorded: 0 },
    decisions: [
      ...REASONS.map((reason) => ({ item: view(`d-${reason}`, PATHS[reason], reason), unreflected: false, operations: [] })),
      { item: view('d-ok', 'path:docs/d.md'), unreflected: false, operations: [] },
    ],
    unresolved: [],
    worktrees: [{ id: 'wt', path: '/w', name: 'wt', branch: 'feature/x' }],
  };
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => listBody }) as Response) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const messages = { ja, en } as const;
const sentenceOf = (lang: 'ja' | 'en', reason: (typeof REASONS)[number]) =>
  (messages[lang] as unknown as { mem: { decisions: { destinationRefused: Record<string, string> } } }).mem.decisions.destinationRefused[reason];

describe('I-B3: the card says why a stored destination cannot be used', () => {
  it.each(REASONS.flatMap((reason) => (['ja', 'en'] as const).map((lang) => [reason, lang] as const)))(
    '%s (%s): the item is listed and its sentence is shown',
    async (reason, lang) => {
      locale.current = lang;
      render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
      const line = await screen.findByTestId(`decision-destination-refused-d-${reason}`);
      expect(sentenceOf(lang, reason)).toBeTruthy();
      expect(line).toHaveTextContent(sentenceOf(lang, reason));
      expect(screen.getByTestId(`decision-d-${reason}`)).toHaveTextContent(PATHS[reason]);
    }
  );

  it('the instruction-file sentence names the way out (docs/ or an Issue, the file by hand)', () => {
    expect(sentenceOf('ja', 'agent_instructions')).toMatch(/docs\/.*Issue.*手で/);
    expect(sentenceOf('en', 'agent_instructions')).toMatch(/docs\/.*Issue.*by hand/);
  });

  it('(control) a decision whose destination can be used has no such line', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    await screen.findByTestId('decision-d-ok');
    expect(screen.queryByTestId('decision-destination-refused-d-ok')).toBeNull();
  });
});

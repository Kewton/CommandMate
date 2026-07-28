/**
 * CompatibilityEvidence (Issue #1246)
 *
 * What this screen owes the user is the *provenance* of an Agent support badge:
 * whose claim it is, whether CommandMate measured it, on which CLI version and
 * when, and — separately — whether the Agent lists the Skill as a slash command.
 *
 * These tests pin the statements it is not allowed to drop: an unmeasured Agent
 * must say so rather than render an empty block, a measurement that contradicts
 * the manifest must stay visible, an ageing measurement must be flagged, and
 * every Agent must carry a reload instruction.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations:
    (namespace?: string) =>
    (key: string, params?: Record<string, string | number>) => {
      const full = namespace ? `${namespace}.${key}` : key;
      if (!params) return full;
      const rendered = Object.entries(params)
        .map(([name, value]) => `${name}=${value}`)
        .join(',');
      return `${full}(${rendered})`;
    },
  useLocale: () => 'en',
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { CompatibilityEvidence } from '@/components/skills/CompatibilityEvidence';
import { describeAgentCompatibility } from '@/lib/skills/compatibility';
import type { SkillAgentSupport } from '@/types/skills';

const FRESH = new Date('2026-07-27T00:00:00Z');
const LONG_AFTER = new Date('2030-01-01T00:00:00Z');

function viewFor(
  agent: string,
  support: SkillAgentSupport,
  now: Date = FRESH,
  evidence = 'Publisher ran the conformance suite.'
) {
  const [view] = describeAgentCompatibility(
    [{ agent: agent as 'claude', support, evidence }],
    now
  );
  return view;
}

describe('a measured Agent shows what was measured', () => {
  it('renders both axes separately, so discovery and slash command do not merge', () => {
    render(<CompatibilityEvidence agent={viewFor('codex', 'native')} />);

    expect(screen.getByTestId('skill-agent-axis-discovery-verified')).toBeInTheDocument();
    expect(screen.getByTestId('skill-agent-axis-invocation-unsupported')).toBeInTheDocument();
  });

  it('states the limitation that a discovered-but-unlisted Skill carries', () => {
    render(<CompatibilityEvidence agent={viewFor('codex', 'native')} />);
    expect(screen.getByTestId('skill-agent-axis-invocation-limitation')).toHaveTextContent(
      'skills.compatibility.limitation.noSlashCommand'
    );
  });

  it('names the CLI version and the date the measurement was taken', () => {
    const block = render(<CompatibilityEvidence agent={viewFor('claude', 'native')} />).container;
    expect(block).toHaveTextContent('version=2.1.220');
    expect(block).toHaveTextContent('date=2026-07-26');
  });

  it('names the install root the Agent was measured to read', () => {
    const block = render(<CompatibilityEvidence agent={viewFor('claude', 'native')} />).container;
    expect(block).toHaveTextContent('roots=.claude/skills');
  });

  it('cites the evidence source without exposing a machine path', () => {
    const block = render(<CompatibilityEvidence agent={viewFor('claude', 'native')} />).container;
    expect(block).toHaveTextContent('github.com/Kewton/CommandMate');
    expect(block.textContent ?? '').not.toContain('/Users/');
  });

  it('keeps the publisher claim readable next to the measurement', () => {
    const block = render(
      <CompatibilityEvidence agent={viewFor('claude', 'native', FRESH, 'Vendor said so.')} />
    ).container;
    expect(block).toHaveTextContent('Vendor said so.');
    expect(block).toHaveTextContent('support=skills.compatibility.native');
  });

  it('labels a manifest that has fallen behind the measurement', () => {
    // Publisher declares `unknown`, CommandMate measured discovery. The screen
    // must show the discrepancy rather than silently promoting the claim.
    render(<CompatibilityEvidence agent={viewFor('claude', 'unknown')} />);
    expect(screen.getByTestId('skill-agent-verification-claude')).toHaveTextContent(
      'skills.compatibility.verification.staleDeclaration'
    );
  });
});

describe('an unmeasured Agent says so', () => {
  it('renders the skip reason instead of an empty evidence block', () => {
    render(<CompatibilityEvidence agent={viewFor('gemini', 'native')} />);
    expect(screen.getByTestId('skill-agent-skip-reason-gemini')).toHaveTextContent(
      'skills.compatibility.skipReason.notMeasured'
    );
  });

  it('shows no measurement detail it does not have', () => {
    render(<CompatibilityEvidence agent={viewFor('gemini', 'native')} />);
    expect(screen.queryByTestId('skill-agent-axis-discovery')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-agent-evidence-stale-gemini')).not.toBeInTheDocument();
  });

  it('marks the claim unverified rather than confirmed', () => {
    render(<CompatibilityEvidence agent={viewFor('gemini', 'native')} />);
    expect(screen.getByTestId('skill-agent-verification-gemini')).toHaveTextContent(
      'skills.compatibility.verification.unverified'
    );
  });
});

describe('staleness', () => {
  it('stays quiet while the measurement is recent', () => {
    render(<CompatibilityEvidence agent={viewFor('claude', 'native', FRESH)} />);
    expect(screen.queryByTestId('skill-agent-evidence-stale-claude')).not.toBeInTheDocument();
  });

  it('warns with the age once the measurement is old', () => {
    render(<CompatibilityEvidence agent={viewFor('claude', 'native', LONG_AFTER)} />);
    expect(screen.getByTestId('skill-agent-evidence-stale-claude')).toHaveTextContent('days=');
  });
});

describe('reload guidance is always reachable', () => {
  it.each([
    ['claude', 'skills.compatibility.reload.sessionRestart'],
    ['codex', 'skills.compatibility.reload.sessionRestartNoSlash'],
    ['gemini', 'skills.compatibility.reload.unknown'],
  ])('%s reaches a reload instruction from its support status', (agent, key) => {
    // 受入条件 (manual): every support status must lead to its evidence and its
    // reload steps — including the Agents CommandMate never measured.
    const block = render(<CompatibilityEvidence agent={viewFor(agent, 'native')} />).container;
    expect(block).toHaveTextContent(key);
  });

  it('renders only the reload line in the pre-install variant', () => {
    render(
      <ul>
        <CompatibilityEvidence agent={viewFor('codex', 'native')} variant="reload" />
      </ul>
    );
    expect(screen.getByTestId('skill-agent-reload-codex')).toHaveTextContent(
      'skills.compatibility.reload.sessionRestartNoSlash'
    );
    expect(screen.queryByTestId('skill-agent-evidence-codex')).not.toBeInTheDocument();
  });
});

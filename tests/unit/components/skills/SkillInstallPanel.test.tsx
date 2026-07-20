/**
 * SkillInstallPanel (Issue #1431)
 *
 * These tests pin the promises the flow makes about writing to a worktree:
 * that nothing is applied before a plan has been shown, that a plan reporting
 * blockers cannot be applied at all, that a high-risk package is never applied
 * without an explicit acknowledgement leaving the browser, and that a typed
 * refusal is reported as the specific thing that happened rather than as a
 * generic failure.
 *
 * The fetch mock answers per URL with the real request/response shapes, so a
 * change to what the routes accept breaks these tests rather than sliding past
 * them.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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

import { SkillInstallPanel } from '@/components/skills/SkillInstallPanel';
import {
  makeInstallPlan,
  makeInstallResponse,
  makeUninstallFile,
  makeUninstallPlan,
  makeUninstallResponse,
  makeWorktree,
} from './fixtures';

interface Route {
  status?: number;
  body: unknown;
}

const fetchMock = vi.fn();

/** Routes by URL suffix, so a request to an unexpected route fails loudly. */
function routeFetch(routes: Record<string, Route>) {
  fetchMock.mockImplementation(async (url: string) => {
    const match = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    if (!match) throw new Error(`unexpected request: ${url}`);
    const route = routes[match];
    const status = route.status ?? 200;
    return { ok: status < 400, status, json: async () => route.body } as unknown as Response;
  });
}

const WORKTREES = { body: { worktrees: [makeWorktree()] } };

function bodyOf(suffix: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((call: unknown[]) => (call[0] as string).endsWith(suffix));
  if (!call) throw new Error(`no request to ${suffix}`);
  return JSON.parse(call[1].body as string);
}

function requestsTo(suffix: string): number {
  return fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).endsWith(suffix)).length;
}

async function selectTarget() {
  fireEvent.click(await screen.findByTestId('skill-target-option-demo-wt'));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SkillInstallPanel happy path', () => {
  it('walks target → plan → preview → install and reports what landed', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': { body: { plan: makeInstallPlan() } },
      '/install': { body: makeInstallResponse() },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);

    // Nothing can be planned until a target is chosen.
    expect(await screen.findByTestId('skill-install-action')).toBeDisabled();
    await selectTarget();
    expect(screen.getByTestId('skill-install-action')).toBeEnabled();

    fireEvent.click(screen.getByTestId('skill-install-action'));

    const preview = await screen.findByTestId('skill-install-plan');
    expect(preview).toHaveTextContent('.agents/skills/release-helper');
    expect(screen.getByTestId('skill-plan-stats')).toHaveTextContent('added=1');
    expect(
      screen.getByTestId('skill-plan-file-.agents/skills/release-helper/SKILL.md')
    ).toBeInTheDocument();

    // Building a plan writes nothing.
    expect(requestsTo('/install')).toBe(0);

    fireEvent.click(screen.getByTestId('skill-install-confirm'));

    const result = await screen.findByTestId('skill-install-result');
    expect(result).toHaveTextContent('skills.install.nextAction.succeeded');
    expect(screen.getByTestId('skill-operation-reload')).toHaveTextContent(
      'skills.install.reload.native'
    );
    expect(screen.queryByTestId('skill-install-plan')).not.toBeInTheDocument();
  });

  it('spends the plan token on the version the plan was built for', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': { body: { plan: makeInstallPlan() } },
      '/install': { body: makeInstallResponse() },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));
    fireEvent.click(await screen.findByTestId('skill-install-confirm'));
    await screen.findByTestId('skill-install-result');

    expect(bodyOf('/plan')).toEqual({ version: '1.2.0' });
    const install = bodyOf('/install');
    expect(install.planToken).toBe(makeInstallPlan().token);
    expect(install.version).toBe('1.2.0');
    // The routes reject a body naming a location or an artifact outright.
    for (const forbidden of ['path', 'worktreePath', 'installRoot', 'url', 'artifactUrl', 'files']) {
      expect(install).not.toHaveProperty(forbidden);
    }
  });

  it('never asks the API where to install, only which worktree', async () => {
    routeFetch({ '/api/worktrees': WORKTREES, '/plan': { body: { plan: makeInstallPlan() } } });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));
    await screen.findByTestId('skill-install-plan');

    const planCall = fetchMock.mock.calls.find((call: unknown[]) => (call[0] as string).endsWith('/plan'));
    expect(planCall?.[0]).toBe('/api/worktrees/demo-wt/skills/release-helper/plan');
  });
});

describe('SkillInstallPanel blockers', () => {
  it('refuses to apply a plan that reports blockers, and says what is in the way', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': {
        body: {
          plan: makeInstallPlan({
            installable: false,
            blockers: [
              {
                code: 'SKILL_DIFF_LOCAL_MODIFICATION',
                path: '.agents/skills/release-helper/SKILL.md',
              },
            ],
          }),
        },
      },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));

    const blockers = await screen.findByTestId('skill-install-blockers');
    expect(blockers).toHaveTextContent('skills.plan.diffReason.localModification');
    expect(blockers).toHaveTextContent('.agents/skills/release-helper/SKILL.md');
    expect(screen.getByTestId('skill-install-confirm')).toBeDisabled();

    fireEvent.click(screen.getByTestId('skill-install-confirm'));
    expect(requestsTo('/install')).toBe(0);
  });

  it('keeps the Catalog-level reason on the button when no version applies here', async () => {
    routeFetch({ '/api/worktrees': WORKTREES });

    render(
      <SkillInstallPanel
        skillId="future-skill"
        version={null}
        blockedReason="skills.detail.install.blockedNoVersion"
      />
    );
    await selectTarget();

    expect(screen.getByTestId('skill-install-action')).toBeDisabled();
    expect(screen.getByTestId('skill-install-reason')).toHaveTextContent(
      'skills.detail.install.blockedNoVersion'
    );
    // Uninstall stays reachable: a Skill that no longer runs here is exactly
    // the one a user needs to be able to remove.
    expect(screen.getByTestId('skill-uninstall-action')).toBeEnabled();
  });
});

describe('SkillInstallPanel high-risk acknowledgement', () => {
  const highRiskPlan = () =>
    makeInstallPlan({
      requiresRiskAcknowledgement: true,
      riskAcknowledgementMessageKey: 'skills.plan.highRiskAcknowledgement',
      skill: { ...makeInstallPlan().skill, computedRisk: 'high', effectiveRisk: 'high' },
    });

  it('gates a high-risk install behind a confirmation the ordinary path does not have', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': { body: { plan: highRiskPlan() } },
      '/install': { body: makeInstallResponse() },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));

    const acknowledgement = await screen.findByTestId('skill-install-risk-acknowledgement');
    expect(acknowledgement).toHaveTextContent('skills.plan.highRiskAcknowledgement');
    expect(screen.getByTestId('skill-plan-risk-effective-high')).toBeInTheDocument();
    expect(screen.getByTestId('skill-install-confirm')).toBeDisabled();

    fireEvent.click(screen.getByTestId('skill-install-risk-checkbox'));
    await waitFor(() => expect(screen.getByTestId('skill-install-confirm')).toBeEnabled());

    fireEvent.click(screen.getByTestId('skill-install-confirm'));
    await screen.findByTestId('skill-install-result');

    expect(bodyOf('/install').acknowledgeRisk).toBe(true);
  });

  it('sends no install request at all while the acknowledgement is unchecked', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': { body: { plan: highRiskPlan() } },
      '/install': { body: makeInstallResponse() },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));
    await screen.findByTestId('skill-install-risk-acknowledgement');

    fireEvent.click(screen.getByTestId('skill-install-confirm'));
    await waitFor(() => expect(requestsTo('/plan')).toBe(1));
    expect(requestsTo('/install')).toBe(0);
  });

  it('omits acknowledgeRisk entirely when the plan does not require it', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': { body: { plan: makeInstallPlan() } },
      '/install': { body: makeInstallResponse() },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));
    expect(await screen.findByTestId('skill-install-plan')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-install-risk-acknowledgement')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('skill-install-confirm'));
    await screen.findByTestId('skill-install-result');
    expect(bodyOf('/install')).not.toHaveProperty('acknowledgeRisk');
  });
});

describe('SkillInstallPanel typed refusals', () => {
  it.each([
    ['SKILL_PLAN_STALE', 409, 'skills.operation.error.planStale'],
    ['SKILL_INSTALL_LOCKED', 409, 'skills.operation.error.installLocked'],
    ['SKILL_INSTALL_DESTINATION_EXISTS', 409, 'skills.operation.error.installDestinationExists'],
  ])('explains %s rather than reporting a generic failure', async (code, status, expected) => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': { body: { plan: makeInstallPlan() } },
      '/install': { status, body: { error: 'refused', code } },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));
    fireEvent.click(await screen.findByTestId('skill-install-confirm'));

    const error = await screen.findByTestId('skill-operation-error');
    expect(error).toHaveTextContent(expected);
    expect(error).toHaveTextContent(code);
    // The plan stays on screen, so the user can see what they had approved.
    expect(screen.getByTestId('skill-install-plan')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-install-result')).not.toBeInTheDocument();
  });

  it('names an unmapped code without inventing a diagnosis for it', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': { status: 500, body: { error: 'boom', code: 'SKILL_PLAN_INTERNAL_ERROR' } },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));

    const error = await screen.findByTestId('skill-operation-error');
    expect(error).toHaveTextContent('skills.operation.error.unexpected');
    expect(error).toHaveTextContent('SKILL_PLAN_INTERNAL_ERROR');
  });

  it('reports a failure with no typed code as a request failure, not a Catalog failure', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': { status: 404, body: { error: 'Worktree not found' } },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));

    expect(await screen.findByTestId('skill-operation-error')).toHaveTextContent(
      'skills.operation.error.requestFailed'
    );
  });
});

describe('SkillInstallPanel uninstall', () => {
  it('walks plan → preview → remove and reports what was removed', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/uninstall-plan': { body: { plan: makeUninstallPlan() } },
      '/uninstall': { body: makeUninstallResponse() },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-uninstall-action'));

    const preview = await screen.findByTestId('skill-uninstall-plan');
    expect(preview).toHaveTextContent('skills.uninstall.disposition.remove');
    expect(preview).toHaveTextContent('skills.uninstall.nextAction.removable');
    // Building the uninstall plan deletes nothing.
    expect(requestsTo('/skills/release-helper/uninstall')).toBe(0);

    fireEvent.click(screen.getByTestId('skill-uninstall-confirm'));

    expect(await screen.findByTestId('skill-uninstall-result')).toHaveTextContent(
      'skills.uninstall.nextAction.succeeded'
    );
    expect(bodyOf('/skills/release-helper/uninstall').planToken).toBe(makeUninstallPlan().token);
  });

  it('will not remove anything when the plan says paths are not CommandMate’s to delete', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/uninstall-plan': {
        body: {
          plan: makeUninstallPlan({
            removable: false,
            nextActionKey: 'skills.uninstall.nextAction.blocked',
            blockers: [
              {
                code: 'SKILL_UNINSTALL_LOCAL_MODIFICATION',
                path: '.agents/skills/release-helper/SKILL.md',
                messageKey: 'skills.uninstall.reason.localModification',
              },
            ],
            removals: [],
            retained: [
              makeUninstallFile({
                disposition: 'modified',
                reason: 'SKILL_UNINSTALL_LOCAL_MODIFICATION',
              }),
            ],
            stats: { removable: 0, modified: 1, missing: 0, unknown: 0, irregular: 0 },
          }),
        },
      },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-uninstall-action'));

    expect(await screen.findByTestId('skill-uninstall-blockers')).toHaveTextContent(
      'skills.uninstall.reason.localModification'
    );
    expect(screen.getByTestId('skill-uninstall-confirm')).toBeDisabled();

    fireEvent.click(screen.getByTestId('skill-uninstall-confirm'));
    expect(bodyOf('/uninstall-plan')).toEqual({});
    expect(requestsTo('/skills/release-helper/uninstall')).toBe(0);
  });

  it('renders the blockers a refused uninstall names in its error body', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/uninstall-plan': { body: { plan: makeUninstallPlan() } },
      '/skills/release-helper/uninstall': {
        status: 409,
        body: {
          error: 'refused',
          code: 'SKILL_UNINSTALL_FILE_CHANGED',
          nextActionKey: 'skills.uninstall.nextAction.blocked',
          blockers: [
            {
              code: 'SKILL_UNINSTALL_LOCAL_MODIFICATION',
              path: '.agents/skills/release-helper/SKILL.md',
              messageKey: 'skills.uninstall.reason.localModification',
            },
          ],
        },
      },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-uninstall-action'));
    fireEvent.click(await screen.findByTestId('skill-uninstall-confirm'));

    const error = await screen.findByTestId('skill-operation-error');
    expect(error).toHaveTextContent('skills.operation.error.uninstallFileChanged');
    expect(error).toHaveTextContent('skills.uninstall.nextAction.blocked');
    expect(screen.getByTestId('skill-operation-error-blockers')).toHaveTextContent(
      '.agents/skills/release-helper/SKILL.md'
    );
  });
});

describe('SkillInstallPanel state hygiene', () => {
  it('drops a plan built for one worktree when another is chosen', async () => {
    routeFetch({
      '/api/worktrees': { body: { worktrees: [makeWorktree(), makeWorktree({ id: 'other-wt', name: 'main' })] } },
      '/plan': { body: { plan: makeInstallPlan() } },
    });

    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));
    await screen.findByTestId('skill-install-plan');

    fireEvent.click(screen.getByTestId('skill-target-option-other-wt'));
    await waitFor(() => expect(screen.queryByTestId('skill-install-plan')).not.toBeInTheDocument());
  });

  it('clears an earlier refusal when a new plan is built', async () => {
    routeFetch({
      '/api/worktrees': WORKTREES,
      '/plan': { status: 409, body: { error: 'refused', code: 'SKILL_INSTALL_LOCKED' } },
    });
    render(<SkillInstallPanel skillId="release-helper" version="1.2.0" blockedReason={null} />);
    await selectTarget();
    fireEvent.click(screen.getByTestId('skill-install-action'));
    await screen.findByTestId('skill-operation-error');

    routeFetch({ '/api/worktrees': WORKTREES, '/plan': { body: { plan: makeInstallPlan() } } });
    fireEvent.click(screen.getByTestId('skill-install-action'));

    await screen.findByTestId('skill-install-plan');
    expect(screen.queryByTestId('skill-operation-error')).not.toBeInTheDocument();
  });
});

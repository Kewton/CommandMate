/**
 * API integration tests - Skill Catalog routes (Issue #1231)
 *
 * The Catalog client is mocked, so no test touches the network. What is under
 * test here is the API contract: status codes, freshness reporting, prerelease
 * opt-in and the fields the routes are allowed to expose.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SkillCatalog } from '@/types/skills';
import type { SkillCatalogResult, SkillCatalogSnapshot } from '@/lib/skills/catalog-client';
import type { SkillDetailResponse, SkillListResponse } from '@/lib/api/skills-api';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

vi.mock('@/lib/skills/catalog-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skills/catalog-client')>();
  return { ...actual, getSkillCatalog: vi.fn() };
});

vi.mock('@/lib/version-checker', () => ({
  getServerVersion: vi.fn(() => '0.11.4'),
}));

import { GET as listSkills } from '@/app/api/skills/route';
import { GET as getSkill } from '@/app/api/skills/[id]/route';
import { getSkillCatalog, SkillCatalogStaleReason } from '@/lib/skills/catalog-client';
import { getServerVersion } from '@/lib/version-checker';

const getSkillCatalogMock = vi.mocked(getSkillCatalog);
const getServerVersionMock = vi.mocked(getServerVersion);

const CATALOG: SkillCatalog = {
  schema_version: 1,
  entries: [
    {
      id: 'release-notes',
      name: 'release-notes',
      summary: 'Draft release notes from merged pull requests.',
      provider: { name: 'CommandMate', url: 'https://github.com/Kewton/CommandMate' },
      license: 'MIT',
      latest: '1.2.0',
      versions: [
        {
          version: '1.2.0',
          changelog: 'Release 1.2.0',
          published_at: '2026-07-16T09:30:00Z',
          source: {
            repository: 'Kewton/commandmate-skills',
            ref: 'release-notes-v1.2.0',
            commit: '7dba1ec2e66342ef578ab57bbdaa9b4327897d47',
          },
          artifact: {
            asset_name: 'release-notes-1.2.0.tar.gz',
            url: 'https://github.com/Kewton/commandmate-skills/releases/download/release-notes-v1.2.0/release-notes-1.2.0.tar.gz',
            sha256: '4bdb91f46683de4df48783d57b75248f7c7e8c34619e5cbb090ba69a6c781c21',
            size: 4096,
            content_type: 'application/gzip',
            format: 'tar.gz',
          },
          compatibility: {
            commandmate: '>=0.11.0 <1.0.0',
            agents: [{ agent: 'claude', support: 'native', evidence: 'verified on claude CLI 2.x' }],
          },
          declared_risk: 'low',
        },
        {
          version: '1.3.0-beta.1',
          changelog: 'Release 1.3.0-beta.1',
          published_at: '2026-07-17T09:30:00Z',
          source: {
            repository: 'Kewton/commandmate-skills',
            ref: 'release-notes-v1.3.0-beta.1',
            commit: 'ef754e3638b357eee53a626541aca267bd57e45c',
          },
          artifact: {
            asset_name: 'release-notes-1.3.0-beta.1.tar.gz',
            url: 'https://github.com/Kewton/commandmate-skills/releases/download/release-notes-v1.3.0-beta.1/release-notes-1.3.0-beta.1.tar.gz',
            sha256: '481be185fb462c8d41c09e118ed631a7e10d670c13413f669dce72ba3aeee97e',
            size: 4096,
            content_type: 'application/gzip',
            format: 'tar.gz',
          },
          compatibility: {
            commandmate: '>=0.11.0 <1.0.0',
            agents: [{ agent: 'claude', support: 'unknown', evidence: 'not verified' }],
          },
          declared_risk: 'moderate',
        },
      ],
    },
  ],
};

function snapshot(overrides: Partial<SkillCatalogSnapshot> = {}): SkillCatalogSnapshot {
  return {
    catalog: CATALOG,
    fetchedAt: '2026-07-20T00:00:00.000Z',
    revalidatedAt: '2026-07-20T00:00:00.000Z',
    state: 'fresh',
    stale: false,
    offline: false,
    staleReason: null,
    source: { repository: 'Kewton/commandmate-skills', ref: 'main', revision: '"rev-1"' },
    ...overrides,
  };
}

function ok(overrides: Partial<SkillCatalogSnapshot> = {}): SkillCatalogResult {
  return { ok: true, snapshot: snapshot(overrides) };
}

function listRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/skills${query}`);
}

function detailRequest(id: string, query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/skills/${id}${query}`);
}

function detailParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getServerVersionMock.mockReturnValue('0.11.4');
});

describe('GET /api/skills', () => {
  it('returns the Catalog with freshness metadata', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const response = await listSkills(listRequest());
    const body = (await response.json()) as SkillListResponse;

    expect(response.status).toBe(200);
    expect(body.catalog.schemaVersion).toBe(1);
    expect(body.catalog.fetchedAt).toBe('2026-07-20T00:00:00.000Z');
    expect(body.catalog.stale).toBe(false);
    expect(body.catalog.offline).toBe(false);
    expect(body.catalog.source).toEqual({
      repository: 'Kewton/commandmate-skills',
      ref: 'main',
      revision: '"rev-1"',
    });
    expect(body.skills).toHaveLength(1);
  });

  it('resolves the recommended version and its compatibility reason', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const body = (await (await listSkills(listRequest())).json()) as SkillListResponse;
    const skill = body.skills[0];

    expect(skill.recommendedVersion).toBe('1.2.0');
    expect(skill.recommendedReason).toBe('SKILL_RECOMMEND_HIGHEST_COMPATIBLE');
    expect(skill.compatibility?.status).toBe('compatible');
    expect(skill.compatibility?.reasonCode).toBe('SKILL_COMPAT_SATISFIED');
    expect(skill.compatibility?.messageKey.length).toBeGreaterThan(0);
    expect(skill.compatibility?.message.length).toBeGreaterThan(0);
  });

  it('hides prereleases unless they are explicitly requested', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const plain = (await (await listSkills(listRequest())).json()) as SkillListResponse;
    expect(plain.skills[0].versions.map((v) => v.version)).toEqual(['1.2.0']);

    getSkillCatalogMock.mockResolvedValue(ok());
    const withPrerelease = (await (
      await listSkills(listRequest('?prerelease=true'))
    ).json()) as SkillListResponse;
    expect(withPrerelease.skills[0].versions.map((v) => v.version)).toEqual([
      '1.3.0-beta.1',
      '1.2.0',
    ]);
    expect(withPrerelease.skills[0].versions[0].prerelease).toBe(true);
  });

  it('treats any prerelease value other than "true" as opt-out', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const body = (await (await listSkills(listRequest('?prerelease=1'))).json()) as SkillListResponse;
    expect(body.skills[0].versions.map((v) => v.version)).toEqual(['1.2.0']);
  });

  it('never exposes the artifact download URL', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const response = await listSkills(listRequest('?prerelease=true'));
    const raw = await response.text();

    expect(raw).not.toContain('releases/download');
    const body = JSON.parse(raw) as SkillListResponse;
    for (const version of body.skills[0].versions) {
      expect(version.artifact).not.toHaveProperty('url');
      expect(version.artifact.sha256.length).toBe(64);
      expect(version.source.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('marks a stale snapshot as stale rather than presenting it as current', async () => {
    getSkillCatalogMock.mockResolvedValue(
      ok({
        state: 'stale',
        stale: true,
        offline: true,
        staleReason: SkillCatalogStaleReason.FETCH_FAILED,
      })
    );

    const response = await listSkills(listRequest());
    const body = (await response.json()) as SkillListResponse;

    expect(response.status).toBe(200);
    expect(body.catalog.stale).toBe(true);
    expect(body.catalog.offline).toBe(true);
    expect(body.catalog.staleReason).toBe(SkillCatalogStaleReason.FETCH_FAILED);
    expect(body.skills).toHaveLength(1);
  });

  it('returns 503 with a machine code instead of an empty list when unavailable', async () => {
    getSkillCatalogMock.mockResolvedValue({
      ok: false,
      failure: {
        code: SkillCatalogStaleReason.INVALID_SCHEMA,
        message: 'The Skill Catalog response did not match the supported Catalog schema.',
        errors: [],
      },
    });

    const response = await listSkills(listRequest());
    const body = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe(SkillCatalogStaleReason.INVALID_SCHEMA);
    expect(body).not.toHaveProperty('skills');
  });

  it('reports unknown, not incompatible, when the host version is undeterminable', async () => {
    getServerVersionMock.mockReturnValue('0.0.0');
    getSkillCatalogMock.mockResolvedValue(ok());

    const body = (await (await listSkills(listRequest())).json()) as SkillListResponse;

    expect(body.skills[0].compatibility?.status).toBe('unknown');
    expect(body.skills[0].compatibility?.reasonCode).toBe('SKILL_COMPAT_HOST_VERSION_UNKNOWN');
    expect(body.skills[0].recommendedReason).toBe('SKILL_RECOMMEND_LATEST_UNVERIFIED');
  });

  it('explains the required version when nothing is compatible', async () => {
    getServerVersionMock.mockReturnValue('2.0.0');
    getSkillCatalogMock.mockResolvedValue(ok());

    const body = (await (await listSkills(listRequest())).json()) as SkillListResponse;

    expect(body.skills[0].recommendedVersion).toBeNull();
    expect(body.skills[0].recommendedReason).toBe('SKILL_RECOMMEND_NONE_COMPATIBLE');
    expect(body.skills[0].compatibility?.status).toBe('incompatible');
    expect(body.skills[0].compatibility?.requiredRange).toBe('>=0.11.0 <1.0.0');
    expect(body.skills[0].compatibility?.message).toContain('>=0.11.0 <1.0.0');
  });

  it('forbids intermediary caching of Catalog responses', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const response = await listSkills(listRequest());

    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('returns 500 when the Catalog client throws', async () => {
    getSkillCatalogMock.mockRejectedValue(new Error('boom'));

    const response = await listSkills(listRequest());
    const body = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(500);
    expect(body.code).toBe('SKILL_CATALOG_INTERNAL_ERROR');
    expect(body.error).not.toContain('boom');
  });
});

describe('GET /api/skills/[id]', () => {
  it('returns one Skill with the same shape as the list entry', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const response = await getSkill(detailRequest('release-notes'), detailParams('release-notes'));
    const body = (await response.json()) as SkillDetailResponse;

    expect(response.status).toBe(200);
    expect(body.skill.id).toBe('release-notes');
    expect(body.skill.recommendedVersion).toBe('1.2.0');
    expect(body.skill.versions[0].compatibility.agents[0].labelKey).toBe(
      'skills.compatibility.native'
    );
    expect(body.catalog.fetchedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('honours the prerelease opt-in', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const response = await getSkill(
      detailRequest('release-notes', '?prerelease=true'),
      detailParams('release-notes')
    );
    const body = (await response.json()) as SkillDetailResponse;

    expect(body.skill.versions.map((v) => v.version)).toEqual(['1.3.0-beta.1', '1.2.0']);
  });

  it('returns 404 for an id that is well-formed but absent', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const response = await getSkill(detailRequest('missing-skill'), detailParams('missing-skill'));
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(404);
    expect(body.code).toBe('SKILL_NOT_FOUND');
  });

  it('rejects malformed and reserved ids with 400 before any lookup', async () => {
    for (const id of ['Release-Notes', '../etc/passwd', 'con', '']) {
      getSkillCatalogMock.mockResolvedValue(ok());
      const response = await getSkill(detailRequest(id), detailParams(id));

      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toMatch(/^SKILL_ID_/);
      expect(getSkillCatalogMock).not.toHaveBeenCalled();
      vi.clearAllMocks();
      getServerVersionMock.mockReturnValue('0.11.4');
    }
  });

  it('returns 503 when the Catalog is unavailable', async () => {
    getSkillCatalogMock.mockResolvedValue({
      ok: false,
      failure: {
        code: SkillCatalogStaleReason.FETCH_FAILED,
        message: 'The Skill Catalog could not be retrieved.',
        errors: [],
      },
    });

    const response = await getSkill(detailRequest('release-notes'), detailParams('release-notes'));

    expect(response.status).toBe(503);
  });

  it('never exposes the artifact download URL', async () => {
    getSkillCatalogMock.mockResolvedValue(ok());

    const response = await getSkill(
      detailRequest('release-notes', '?prerelease=true'),
      detailParams('release-notes')
    );

    expect(await response.text()).not.toContain('releases/download');
  });
});

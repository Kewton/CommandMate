/**
 * Shared fixtures for the Skill fetch/snapshot tests (Issue #1229)
 */

import { createHash } from 'crypto';
import type { SkillCatalogVersion } from '@/types/skills';

export const SKILL_ID = 'demo-skill';
export const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

export const ARTIFACT_BYTES = Buffer.from('demo-skill artifact payload bytes');
export const ARTIFACT_SHA256 = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');

export const ARTIFACT_URL =
  'https://github.com/Kewton/commandmate-skills/releases/download/demo-skill-v1.2.3/demo-skill-1.2.3.tar.gz';

export const CDN_URL =
  'https://objects.githubusercontent.com/github-production-release-asset/1/2?X-Amz-Signature=deadbeef';

/** A well-formed catalog version bound to {@link ARTIFACT_BYTES}. */
export function makeCatalogVersion(
  overrides: Partial<SkillCatalogVersion> = {}
): SkillCatalogVersion {
  return {
    version: '1.2.3',
    changelog: 'Initial release.',
    published_at: '2026-07-01T00:00:00Z',
    source: {
      repository: 'Kewton/commandmate-skills',
      ref: 'demo-skill-v1.2.3',
      commit: COMMIT,
    },
    artifact: {
      asset_name: 'demo-skill-1.2.3.tar.gz',
      url: ARTIFACT_URL,
      sha256: ARTIFACT_SHA256,
      size: ARTIFACT_BYTES.byteLength,
      content_type: 'application/gzip',
      format: 'tar.gz',
    },
    compatibility: { commandmate: '>=0.11.0', agents: [] },
    declared_risk: 'low',
    ...overrides,
  };
}

/** A response body that yields `bytes` in small chunks, like a real transfer. */
export function bodyStream(bytes: Uint8Array, chunkSize = 8): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

/** A 200 response carrying `bytes`. */
export function artifactResponse(
  bytes: Uint8Array = ARTIFACT_BYTES,
  headerOverrides: Record<string, string> = {}
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/gzip',
    'content-length': String(bytes.byteLength),
    ...headerOverrides,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === '') delete headers[name];
  }
  return new Response(bodyStream(bytes), { status: 200, headers });
}

/** A redirect response pointing at `location`. */
export function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

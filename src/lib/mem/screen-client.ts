/**
 * The mem settings API as the screen calls it (Issue #4221, design §11). Every write
 * carries the screen's mark; the CLI has no copy of this. Answers a result rather
 * than throwing. Nothing here reaches the database or `fs`.
 *
 * @module lib/mem/screen-client
 */

import { screenRequestHeaders } from '@/lib/security/screen-request';
import type { MemBranchOverride, MemBranchRule, MemFeatures, MemRepositorySettings } from '@/types/mem';

export const MEM_SETTINGS_TIMEOUT_MS = 15000;

export type MemSettingsResult =
  | { ok: true; settings: MemRepositorySettings }
  | { ok: false; status: number; code?: string; settings?: MemRepositorySettings };

async function call(url: string, init?: RequestInit): Promise<MemSettingsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEM_SETTINGS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json()) as { ok?: boolean; settings?: MemRepositorySettings; code?: string };
    if (response.ok && body.ok === true && body.settings) return { ok: true, settings: body.settings };
    return { ok: false, status: response.status ?? 0, code: body.code, settings: body.settings };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

const base = (repositoryId: string) => `/api/repositories/${encodeURIComponent(repositoryId)}/mem-settings`;
const writeHeaders = () => ({ 'Content-Type': 'application/json', ...screenRequestHeaders() });

export const memSettingsApi = {
  read: (repositoryId: string) => call(base(repositoryId)),
  save: (repositoryId: string, input: { version: number; features: MemFeatures; rules: MemBranchRule[] }) =>
    call(base(repositoryId), { method: 'PUT', headers: writeHeaders(), body: JSON.stringify(input) }),
  saveOverride: (repositoryId: string, version: number, override: MemBranchOverride) =>
    call(`${base(repositoryId)}/branches`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({ version, ...override }),
    }),
  removeOverride: (repositoryId: string, version: number, branch: string) =>
    call(
      `${base(repositoryId)}/branches?branch=${encodeURIComponent(branch)}&version=${encodeURIComponent(String(version))}`,
      { method: 'DELETE', headers: writeHeaders() }
    ),
};

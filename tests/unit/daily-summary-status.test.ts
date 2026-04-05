/**
 * Unit tests for GET /api/daily-summary/status endpoint
 * Issue #638: Report generation status visibility
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@/lib/daily-summary-generator', () => ({
  isGenerating: vi.fn(),
  getGeneratingState: vi.fn(),
}));

import { GET } from '@/app/api/daily-summary/status/route';
import { isGenerating, getGeneratingState } from '@/lib/daily-summary-generator';

const mockIsGenerating = vi.mocked(isGenerating);
const mockGetGeneratingState = vi.mocked(getGeneratingState);

describe('GET /api/daily-summary/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return generating: false when idle', async () => {
    mockIsGenerating.mockReturnValue(false);
    mockGetGeneratingState.mockReturnValue(null);

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ generating: false });
  });

  it('should return generating: true with metadata when active', async () => {
    const startedAt = Date.now() - 5000;
    mockIsGenerating.mockReturnValue(true);
    mockGetGeneratingState.mockReturnValue({
      active: true,
      startedAt,
      date: '2026-04-05',
      tool: 'claude',
    });

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.generating).toBe(true);
    expect(data.date).toBe('2026-04-05');
    expect(data.tool).toBe('claude');
    expect(data.startedAt).toBe(new Date(startedAt).toISOString());
  });

  it('should return generating: false when state is stale (failsafe)', async () => {
    mockIsGenerating.mockReturnValue(false);
    mockGetGeneratingState.mockReturnValue(null);

    const res = await GET();
    const data = await res.json();
    expect(data.generating).toBe(false);
  });
});

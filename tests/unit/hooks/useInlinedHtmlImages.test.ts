/**
 * Unit tests for useInlinedHtmlImages (Issue #2861)
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useInlinedHtmlImages,
  MAX_INLINED_HTML_IMAGES,
  MAX_INLINED_HTML_IMAGE_CHARS,
} from '@/hooks/useInlinedHtmlImages';

const FILE_PATH = 'docs/report/index.html';

function imageResponse(content: string, isImage = true): Response {
  return {
    ok: true,
    json: async () => ({ content, isImage }),
  } as unknown as Response;
}

function notFound(): Response {
  return { ok: false, json: async () => ({}) } as unknown as Response;
}

function srcsOf(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
}

describe('useInlinedHtmlImages', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replaces relative images with data URIs fetched from the file API', async () => {
    fetchMock.mockResolvedValue(imageResponse('data:image/png;base64,AAAA'));
    const html = '<html><body><img src="shots/a b.png"></body></html>';

    const { result } = renderHook(() => useInlinedHtmlImages('wt-1', FILE_PATH, html));

    // Before the fetch resolves, the input is returned as-is
    expect(result.current).toBe(html);
    await waitFor(() => expect(srcsOf(result.current)).toEqual(['data:image/png;base64,AAAA']));
    expect(fetchMock).toHaveBeenCalledWith('/api/worktrees/wt-1/files/docs/report/shots/a%20b.png');
  });

  it('returns the input as-is and does not fetch when there are no relative images', async () => {
    const html = '<html><body><img src="https://example.com/a.png"><p>hi</p></body></html>';
    const { result } = renderHook(() => useInlinedHtmlImages('wt-1', FILE_PATH, html));
    await act(async () => {});
    expect(result.current).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the original src for 404 and non-image responses', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/missing.png')) return notFound();
      if (url.endsWith('/text.png')) return imageResponse('hello', false);
      if (url.endsWith('/throws.png')) throw new Error('network');
      return imageResponse('data:image/png;base64,OK');
    });
    const html = '<img src="missing.png"><img src="text.png"><img src="throws.png"><img src="ok.png">';

    const { result } = renderHook(() => useInlinedHtmlImages('wt-1', FILE_PATH, html));

    await waitFor(() => expect(srcsOf(result.current)).toEqual([
      'missing.png',
      'text.png',
      'throws.png',
      'data:image/png;base64,OK',
    ]));
  });

  it(`keeps the original src beyond ${MAX_INLINED_HTML_IMAGES} images`, async () => {
    fetchMock.mockResolvedValue(imageResponse('data:image/png;base64,X'));
    const count = MAX_INLINED_HTML_IMAGES + 1;
    const html = Array.from({ length: count }, (_, i) => `<img src="img${i}.png">`).join('');

    const { result } = renderHook(() => useInlinedHtmlImages('wt-1', FILE_PATH, html));

    await waitFor(() => expect(srcsOf(result.current)[0]).toBe('data:image/png;base64,X'));
    const srcs = srcsOf(result.current);
    expect(srcs.slice(0, MAX_INLINED_HTML_IMAGES).every((s) => s === 'data:image/png;base64,X')).toBe(true);
    expect(srcs[MAX_INLINED_HTML_IMAGES]).toBe(`img${MAX_INLINED_HTML_IMAGES}.png`);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_INLINED_HTML_IMAGES);
  });

  it('keeps the original src once the total data URI length exceeds the limit', async () => {
    const big = `data:image/png;base64,${'A'.repeat(MAX_INLINED_HTML_IMAGE_CHARS - 100)}`;
    fetchMock.mockImplementation(async (url: string) => (
      url.endsWith('/big.png') ? imageResponse(big) : imageResponse(`data:image/png;base64,${'B'.repeat(200)}`)
    ));
    const html = '<img src="big.png"><img src="second.png">';

    const { result } = renderHook(() => useInlinedHtmlImages('wt-1', FILE_PATH, html));

    await waitFor(() => expect(srcsOf(result.current)[0]).toBe(big));
    expect(srcsOf(result.current)[1]).toBe('second.png');
  });

  it('does not return stale results after htmlContent changes', async () => {
    let resolveFirst: (res: Response) => void = () => {};
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/old.png')) {
        return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve(imageResponse('data:image/png;base64,NEW'));
    });
    const oldHtml = '<img src="old.png">';
    const newHtml = '<img src="new.png">';

    const { result, rerender } = renderHook(
      ({ html }) => useInlinedHtmlImages('wt-1', FILE_PATH, html),
      { initialProps: { html: oldHtml } },
    );
    rerender({ html: newHtml });
    await waitFor(() => expect(srcsOf(result.current)).toEqual(['data:image/png;base64,NEW']));

    await act(async () => {
      resolveFirst(imageResponse('data:image/png;base64,OLD'));
    });
    expect(srcsOf(result.current)).toEqual(['data:image/png;base64,NEW']);
  });

  it('returns the new htmlContent immediately (not the previous inlined result) after a change', async () => {
    fetchMock.mockResolvedValue(imageResponse('data:image/png;base64,AAAA'));
    const first = '<img src="a.png">';
    const { result, rerender } = renderHook(
      ({ html }) => useInlinedHtmlImages('wt-1', FILE_PATH, html),
      { initialProps: { html: first } },
    );
    await waitFor(() => expect(srcsOf(result.current)).toEqual(['data:image/png;base64,AAAA']));

    const second = '<p>no images</p>';
    rerender({ html: second });
    expect(result.current).toBe(second);
  });
});

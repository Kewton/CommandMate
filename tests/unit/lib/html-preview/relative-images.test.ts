/**
 * Unit tests for relative image helpers of the HTML preview (Issue #2861)
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  collectRelativeImageSources,
  replaceImageSources,
} from '@/lib/html-preview/relative-images';

const FILE_PATH = 'workspace/mvp/m1/ui-report/index.html';

describe('collectRelativeImageSources', () => {
  it('resolves relative sources against the file directory', () => {
    const html = '<img src="shots/a.png"><img src="./shots/b.png"><img src="../img/c.png">';
    expect(collectRelativeImageSources(html, FILE_PATH)).toEqual([
      { src: 'shots/a.png', resolvedPath: 'workspace/mvp/m1/ui-report/shots/a.png' },
      { src: './shots/b.png', resolvedPath: 'workspace/mvp/m1/ui-report/shots/b.png' },
      { src: '../img/c.png', resolvedPath: 'workspace/mvp/m1/img/c.png' },
    ]);
  });

  it('ignores absolute, data, protocol-relative, root, fragment and empty sources', () => {
    const html = [
      '<img src="http://example.com/a.png">',
      '<img src="HTTPS://example.com/b.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="blob:xyz">',
      '<img src="//cdn.example.com/c.png">',
      '<img src="/abs.png">',
      '<img src="#x">',
      '<img src="">',
      '<img src="mailto:a@b">',
      '<img src="javascript:void(0)">',
      '<img alt="no src">',
    ].join('');
    expect(collectRelativeImageSources(html, FILE_PATH)).toEqual([]);
  });

  it('deduplicates the same src', () => {
    const html = '<img src="shots/a.png"><p><img src="shots/a.png"></p>';
    expect(collectRelativeImageSources(html, FILE_PATH)).toEqual([
      { src: 'shots/a.png', resolvedPath: 'workspace/mvp/m1/ui-report/shots/a.png' },
    ]);
  });

  it('ignores relative sources of non-img elements', () => {
    const html = '<a href="shots/a.png">a</a><source src="v.mp4"><script src="x.js"></script>';
    expect(collectRelativeImageSources(html, FILE_PATH)).toEqual([]);
  });
});

describe('replaceImageSources', () => {
  it('returns the input string as-is when replacements are empty', () => {
    const html = '<!doctype html>\n<html><body>  <img src="shots/a.png"></body></html>';
    expect(replaceImageSources(html, new Map())).toBe(html);
  });

  it('replaces only matching img src and keeps other elements, attributes and doctype', () => {
    const html = [
      '<!DOCTYPE html>',
      '<html lang="ja"><head><title>Report</title></head><body>',
      '<img src="shots/a.png" alt="A" class="shot">',
      '<img src="shots/b.png" alt="B">',
      '<a href="shots/a.png">open</a>',
      '</body></html>',
    ].join('\n');
    const result = replaceImageSources(
      html,
      new Map([['shots/a.png', 'data:image/png;base64,AAAA']]),
    );

    expect(result.startsWith('<!DOCTYPE html>\n')).toBe(true);
    const doc = new DOMParser().parseFromString(result, 'text/html');
    const imgs = doc.querySelectorAll('img');
    expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(imgs[0].getAttribute('alt')).toBe('A');
    expect(imgs[0].getAttribute('class')).toBe('shot');
    expect(imgs[1].getAttribute('src')).toBe('shots/b.png');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('shots/a.png');
    expect(doc.documentElement.getAttribute('lang')).toBe('ja');
    expect(doc.title).toBe('Report');
  });

  it('does not prepend a doctype when the input has none', () => {
    const result = replaceImageSources(
      '<p><img src="a.png"></p>',
      new Map([['a.png', 'data:image/png;base64,BBBB']]),
    );
    expect(result.startsWith('<html>')).toBe(true);
    expect(result).toContain('src="data:image/png;base64,BBBB"');
  });

  it('keeps script contents intact', () => {
    const html = '<html><body><img src="a.png"><script>if (1 < 2 && "<img>") {}</script></body></html>';
    const result = replaceImageSources(html, new Map([['a.png', 'data:image/png;base64,CC']]));
    expect(result).toContain('<script>if (1 < 2 && "<img>") {}</script>');
  });
});

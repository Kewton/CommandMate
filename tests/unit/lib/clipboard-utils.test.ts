/**
 * Tests for the clipboard helper.
 *
 * [Issue #1939] This file used to carry no `@vitest-environment` docblock, so it
 * ran under `node` (the vitest.config.ts default) where `navigator` exists but
 * `document` does not. Every assertion that reached the #438 textarea fallback
 * died on `document is not defined` instead of testing anything.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyToClipboard } from '@/lib/clipboard-utils';

describe('copyToClipboard', () => {
  let writeTextMock: ReturnType<typeof vi.fn>;
  let execCommandMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Clipboard API のモック
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });
    // jsdom does not implement execCommand at all, so the fallback path needs a
    // stub to be observable rather than a TypeError.
    execCommandMock = vi.fn().mockReturnValue(true);
    Object.assign(document, { execCommand: execCommandMock });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should copy plain text to clipboard', async () => {
    const text = 'Hello, World!';
    await copyToClipboard(text);

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(text);
  });

  it('should strip ANSI escape codes before copying', async () => {
    const textWithAnsi = '\x1b[31mRed Text\x1b[0m';
    await copyToClipboard(textWithAnsi);

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith('Red Text');
  });

  it('should handle multiple ANSI codes in text', async () => {
    const textWithMultipleAnsi = '\x1b[1m\x1b[31mBold Red\x1b[0m \x1b[32mGreen\x1b[0m';
    await copyToClipboard(textWithMultipleAnsi);

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith('Bold Red Green');
  });

  it('should not call clipboard API for empty string', async () => {
    await copyToClipboard('');

    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it('should not call clipboard API for whitespace-only string', async () => {
    await copyToClipboard('   \t\n  ');

    expect(writeTextMock).not.toHaveBeenCalled();
  });

  // [Issue #1939] This block used to be a single `should throw error if clipboard
  // API fails` test asserting that a rejected `writeText` propagates. That
  // contract was deliberately replaced in #438 (commit 319b9be8, "fix(ui): add
  // content copy buttons and fix mobile clipboard/MARP/path copy"), which added
  // the textarea + execCommand fallback so copying still works over plain HTTP
  // on mobile — where `navigator.clipboard` is either missing or rejects. The
  // test was never updated because this file never ran. Assert the fallback that
  // actually exists instead of restoring a contract the product dropped.
  describe('fallback when the Clipboard API is unavailable (Issue #438)', () => {
    it('should fall back to execCommand instead of rejecting when writeText fails', async () => {
      writeTextMock.mockRejectedValueOnce(new Error('Clipboard write failed'));

      await expect(copyToClipboard('test')).resolves.toBeUndefined();

      expect(writeTextMock).toHaveBeenCalledWith('test');
      expect(execCommandMock).toHaveBeenCalledWith('copy');
    });

    it('should stage the ANSI-stripped text in a textarea and remove it afterwards', async () => {
      writeTextMock.mockRejectedValueOnce(new Error('Clipboard write failed'));

      let staged: string | undefined;
      execCommandMock.mockImplementation(() => {
        staged = (document.activeElement as HTMLTextAreaElement | null)?.value;
        return true;
      });

      await copyToClipboard('\x1b[31mRed Text\x1b[0m');

      expect(staged).toBe('Red Text');
      expect(document.querySelector('textarea')).toBeNull();
    });

    it('should use the fallback directly when navigator.clipboard is absent', async () => {
      delete (navigator as { clipboard?: unknown }).clipboard;

      await copyToClipboard('no secure context here');

      expect(execCommandMock).toHaveBeenCalledWith('copy');
    });

    it('should still remove the textarea when execCommand throws', async () => {
      delete (navigator as { clipboard?: unknown }).clipboard;
      execCommandMock.mockImplementation(() => {
        throw new Error('execCommand unsupported');
      });

      await expect(copyToClipboard('boom')).rejects.toThrow('execCommand unsupported');
      expect(document.querySelector('textarea')).toBeNull();
    });
  });

  it('should preserve line breaks in copied text', async () => {
    const multilineText = 'Line 1\nLine 2\nLine 3';
    await copyToClipboard(multilineText);

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(multilineText);
  });

  it('should handle text with special characters', async () => {
    const specialText = 'Hello <world> & "quotes" \'test\'';
    await copyToClipboard(specialText);

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(specialText);
  });

  it('should strip ANSI codes but preserve surrounding whitespace', async () => {
    const text = '  \x1b[31mRed\x1b[0m  ';
    await copyToClipboard(text);

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith('  Red  ');
  });
});

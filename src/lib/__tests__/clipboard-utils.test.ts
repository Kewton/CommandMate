import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyToClipboard } from '../clipboard-utils';

describe('copyToClipboard', () => {
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Clipboard API のモック
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });
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

  it('should throw error if clipboard API fails', async () => {
    const error = new Error('Clipboard write failed');
    writeTextMock.mockRejectedValueOnce(error);

    await expect(copyToClipboard('test')).rejects.toThrow('Clipboard write failed');
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

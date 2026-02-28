/**
 * Unit tests for opencode-config.ts
 * Issue #379: OpenCode configuration file generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  ensureOpencodeConfig,
  OLLAMA_API_URL,
  OLLAMA_BASE_URL,
  MAX_OLLAMA_MODELS,
  OLLAMA_MODEL_PATTERN,
} from '@/lib/cli-tools/opencode-config';

// Mock fs module
vi.mock('fs', () => {
  return {
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    lstatSync: vi.fn(),
    realpathSync: vi.fn(),
  };
});

// Mock global fetch
const mockFetch = vi.fn();

describe('opencode-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch;

    // Default: path exists and is a directory
    vi.mocked(fs.lstatSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats);
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    // Default: writeFileSync succeeds
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
    // Default: existsSync returns false (config does not exist yet)
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constants', () => {
    it('should have OLLAMA_API_URL as localhost [SEC-001]', () => {
      expect(OLLAMA_API_URL).toBe('http://localhost:11434/api/tags');
    });

    it('should have OLLAMA_BASE_URL as localhost [SEC-001]', () => {
      expect(OLLAMA_BASE_URL).toBe('http://localhost:11434/v1');
    });

    it('should have MAX_OLLAMA_MODELS = 100', () => {
      expect(MAX_OLLAMA_MODELS).toBe(100);
    });
  });

  describe('OLLAMA_MODEL_PATTERN', () => {
    it('should match valid model names', () => {
      expect(OLLAMA_MODEL_PATTERN.test('qwen3:8b')).toBe(true);
      expect(OLLAMA_MODEL_PATTERN.test('llama3.1')).toBe(true);
      expect(OLLAMA_MODEL_PATTERN.test('codellama/7b')).toBe(true);
      expect(OLLAMA_MODEL_PATTERN.test('mistral-nemo')).toBe(true);
      expect(OLLAMA_MODEL_PATTERN.test('deepseek-coder-v2:16b')).toBe(true);
    });

    it('should reject empty string', () => {
      expect(OLLAMA_MODEL_PATTERN.test('')).toBe(false);
    });

    it('should reject names over 100 characters [D4-003]', () => {
      const longName = 'a'.repeat(101);
      expect(OLLAMA_MODEL_PATTERN.test(longName)).toBe(false);
    });

    it('should accept names exactly 100 characters', () => {
      const exactName = 'a'.repeat(100);
      expect(OLLAMA_MODEL_PATTERN.test(exactName)).toBe(true);
    });

    it('should reject names with special characters', () => {
      expect(OLLAMA_MODEL_PATTERN.test('model name')).toBe(false);
      expect(OLLAMA_MODEL_PATTERN.test('model;rm -rf /')).toBe(false);
      expect(OLLAMA_MODEL_PATTERN.test('model$(cmd)')).toBe(false);
    });
  });

  describe('ensureOpencodeConfig()', () => {
    it('should skip if opencode.json already exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);

      await ensureOpencodeConfig('/test/worktree');

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fetch models from Ollama API and generate config', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          models: [
            { name: 'qwen3:8b', details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } },
            { name: 'llama3.1', details: { parameter_size: '7.6B' } },
          ],
        })),
      });

      await ensureOpencodeConfig('/test/worktree');

      expect(mockFetch).toHaveBeenCalledWith(
        OLLAMA_API_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(filePath).toBe(path.join('/test/worktree', 'opencode.json'));

      // Verify JSON.stringify was used (valid JSON) [D4-005]
      const config = JSON.parse(content as string);
      expect(config.$schema).toBe('https://opencode.ai/config.json');
      expect(config.provider.ollama.options.baseURL).toBe(OLLAMA_BASE_URL);
      expect(config.provider.ollama.models).toHaveProperty('qwen3:8b');
      expect(config.provider.ollama.models).toHaveProperty('llama3.1');
    });

    it('should handle Ollama API timeout (non-fatal)', async () => {
      const abortError = new Error('AbortError');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      // Should not throw
      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should handle Ollama API network failure (non-fatal)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should handle non-200 API response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should reject response exceeding size limit [D4-007]', async () => {
      const largeResponse = 'x'.repeat(2 * 1024 * 1024); // 2MB
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(largeResponse),
      });

      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should reject invalid API response structure [D4-007]', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ notModels: [] })),
      });

      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should limit models to MAX_OLLAMA_MODELS [D4-007]', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Generate 150 models (exceeds MAX_OLLAMA_MODELS = 100)
      const models = Array.from({ length: 150 }, (_, i) => ({
        name: `model${i}`,
        details: {},
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ models })),
      });

      await ensureOpencodeConfig('/test/worktree');

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const config = JSON.parse(content);
      const modelCount = Object.keys(config.provider.ollama.models).length;
      expect(modelCount).toBeLessThanOrEqual(MAX_OLLAMA_MODELS);
    });

    it('should skip invalid model names (OLLAMA_MODEL_PATTERN validation)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          models: [
            { name: 'valid-model' },
            { name: 'invalid model name' },  // Space not allowed
            { name: 'valid:tag' },
            { name: 123 },  // Not a string
            { name: null },  // Not a string
            {},  // No name
          ],
        })),
      });

      await ensureOpencodeConfig('/test/worktree');

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const config = JSON.parse(content);
      const modelNames = Object.keys(config.provider.ollama.models);
      expect(modelNames).toContain('valid-model');
      expect(modelNames).toContain('valid:tag');
      expect(modelNames).not.toContain('invalid model name');
      expect(modelNames).toHaveLength(2);
    });

    it('should throw on path traversal detection [D4-004]', async () => {
      vi.mocked(fs.lstatSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await expect(ensureOpencodeConfig('/nonexistent/path')).rejects.toThrow('Path does not exist');
    });

    it('should throw if path is not a directory [D4-004]', async () => {
      vi.mocked(fs.lstatSync).mockReturnValue({
        isDirectory: () => false,
      } as fs.Stats);

      await expect(ensureOpencodeConfig('/test/file.txt')).rejects.toThrow('Path is not a directory');
    });

    it('should handle write failure gracefully (non-fatal)', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          models: [{ name: 'test-model' }],
        })),
      });

      // Should not throw (write failure is non-fatal)
      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
    });

    it('should include model display name with parameter_size and quantization', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          models: [
            {
              name: 'qwen3:8b',
              details: { parameter_size: '8B', quantization_level: 'Q4_K_M' },
            },
          ],
        })),
      });

      await ensureOpencodeConfig('/test/worktree');

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const config = JSON.parse(content);
      expect(config.provider.ollama.models['qwen3:8b'].name).toBe('qwen3:8b (8B, Q4_K_M)');
    });
  });
});

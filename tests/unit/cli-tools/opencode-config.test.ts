/**
 * Unit tests for opencode-config.ts
 * Issue #379: OpenCode configuration file generation
 * Issue #398: LM Studio provider support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  ensureOpencodeConfig,
  fetchOllamaModels,
  fetchLmStudioModels,
  OLLAMA_API_URL,
  OLLAMA_BASE_URL,
  MAX_OLLAMA_MODELS,
  OLLAMA_MODEL_PATTERN,
  LM_STUDIO_API_URL,
  LM_STUDIO_BASE_URL,
  MAX_LM_STUDIO_MODELS,
  LM_STUDIO_MODEL_PATTERN,
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

  // ===========================================================================
  // Constants
  // ===========================================================================

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

    it('should have LM_STUDIO_API_URL as localhost [SEC-001]', () => {
      expect(LM_STUDIO_API_URL).toBe('http://localhost:1234/v1/models');
    });

    it('should have LM_STUDIO_BASE_URL as localhost [SEC-001]', () => {
      expect(LM_STUDIO_BASE_URL).toBe('http://localhost:1234/v1');
    });

    it('should have MAX_LM_STUDIO_MODELS = 100', () => {
      expect(MAX_LM_STUDIO_MODELS).toBe(100);
    });
  });

  // ===========================================================================
  // OLLAMA_MODEL_PATTERN
  // ===========================================================================

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

  // ===========================================================================
  // LM_STUDIO_MODEL_PATTERN
  // ===========================================================================

  describe('LM_STUDIO_MODEL_PATTERN', () => {
    it('should match valid LM Studio model IDs', () => {
      expect(LM_STUDIO_MODEL_PATTERN.test('lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF')).toBe(true);
      expect(LM_STUDIO_MODEL_PATTERN.test('TheBloke/Mistral-7B-Instruct-v0.2-GGUF')).toBe(true);
      expect(LM_STUDIO_MODEL_PATTERN.test('simple-model')).toBe(true);
    });

    it('should accept @ character for HuggingFace revision format', () => {
      expect(LM_STUDIO_MODEL_PATTERN.test('org/model@revision')).toBe(true);
      expect(LM_STUDIO_MODEL_PATTERN.test('lmstudio-community/model@v1.0')).toBe(true);
    });

    it('should reject empty string', () => {
      expect(LM_STUDIO_MODEL_PATTERN.test('')).toBe(false);
    });

    it('should reject names over 200 characters', () => {
      const longName = 'a'.repeat(201);
      expect(LM_STUDIO_MODEL_PATTERN.test(longName)).toBe(false);
    });

    it('should accept names exactly 200 characters', () => {
      const exactName = 'a'.repeat(200);
      expect(LM_STUDIO_MODEL_PATTERN.test(exactName)).toBe(true);
    });

    it('should reject names with special characters', () => {
      expect(LM_STUDIO_MODEL_PATTERN.test('model name')).toBe(false);
      expect(LM_STUDIO_MODEL_PATTERN.test('model;rm -rf /')).toBe(false);
      expect(LM_STUDIO_MODEL_PATTERN.test('model$(cmd)')).toBe(false);
    });
  });

  // ===========================================================================
  // fetchOllamaModels()
  // ===========================================================================

  describe('fetchOllamaModels()', () => {
    it('should fetch models from Ollama API and return ProviderModels', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          models: [
            { name: 'qwen3:8b', details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } },
            { name: 'llama3.1', details: { parameter_size: '7.6B' } },
          ],
        })),
      });

      const result = await fetchOllamaModels();

      expect(mockFetch).toHaveBeenCalledWith(
        OLLAMA_API_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toHaveProperty('qwen3:8b');
      expect(result).toHaveProperty('llama3.1');
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

      const result = await fetchOllamaModels();

      expect(result['qwen3:8b'].name).toBe('qwen3:8b (8B, Q4_K_M)');
    });

    it('should handle Ollama API timeout (non-fatal)', async () => {
      const abortError = new Error('AbortError');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      const result = await fetchOllamaModels();

      expect(result).toEqual({});
    });

    it('should handle Ollama API network failure (non-fatal)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await fetchOllamaModels();

      expect(result).toEqual({});
    });

    it('should handle non-200 API response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await fetchOllamaModels();

      expect(result).toEqual({});
    });

    it('should reject response exceeding size limit [D4-007]', async () => {
      const largeResponse = 'x'.repeat(2 * 1024 * 1024); // 2MB
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(largeResponse),
      });

      const result = await fetchOllamaModels();

      expect(result).toEqual({});
    });

    it('should reject invalid API response structure [D4-007]', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ notModels: [] })),
      });

      const result = await fetchOllamaModels();

      expect(result).toEqual({});
    });

    it('should limit models to MAX_OLLAMA_MODELS [D4-007]', async () => {
      // Generate 150 models (exceeds MAX_OLLAMA_MODELS = 100)
      const models = Array.from({ length: 150 }, (_, i) => ({
        name: `model${i}`,
        details: {},
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ models })),
      });

      const result = await fetchOllamaModels();

      const modelCount = Object.keys(result).length;
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

      const result = await fetchOllamaModels();

      const modelNames = Object.keys(result);
      expect(modelNames).toContain('valid-model');
      expect(modelNames).toContain('valid:tag');
      expect(modelNames).not.toContain('invalid model name');
      expect(modelNames).toHaveLength(2);
    });

    it('should return empty object on unexpected error type [S1-004]', async () => {
      // Inject unexpected error type (not Error instance)
      mockFetch.mockRejectedValue('unexpected string error');

      const result = await fetchOllamaModels();

      expect(result).toEqual({});
    });
  });

  // ===========================================================================
  // fetchLmStudioModels()
  // ===========================================================================

  describe('fetchLmStudioModels()', () => {
    it('should fetch models from LM Studio API and return ProviderModels', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          data: [
            { id: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF', object: 'model' },
            { id: 'TheBloke/Mistral-7B-Instruct-v0.2-GGUF', object: 'model' },
          ],
        })),
      });

      const result = await fetchLmStudioModels();

      expect(mockFetch).toHaveBeenCalledWith(
        LM_STUDIO_API_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toHaveProperty('lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF');
      expect(result).toHaveProperty('TheBloke/Mistral-7B-Instruct-v0.2-GGUF');
      // Display name should be the model ID itself
      expect(result['lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF'].name)
        .toBe('lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF');
    });

    it('should handle LM Studio API not running (ECONNREFUSED)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await fetchLmStudioModels();

      expect(result).toEqual({});
    });

    it('should handle LM Studio API timeout', async () => {
      const abortError = new Error('AbortError');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      const result = await fetchLmStudioModels();

      expect(result).toEqual({});
    });

    it('should handle non-200 API response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await fetchLmStudioModels();

      expect(result).toEqual({});
    });

    it('should reject response exceeding size limit', async () => {
      const largeResponse = 'x'.repeat(2 * 1024 * 1024); // 2MB
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(largeResponse),
      });

      const result = await fetchLmStudioModels();

      expect(result).toEqual({});
    });

    it('should reject invalid API response structure', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ notData: [] })),
      });

      const result = await fetchLmStudioModels();

      expect(result).toEqual({});
    });

    it('should limit models to MAX_LM_STUDIO_MODELS', async () => {
      // Generate 150 models (exceeds MAX_LM_STUDIO_MODELS = 100)
      const data = Array.from({ length: 150 }, (_, i) => ({
        id: `model${i}`,
        object: 'model',
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data })),
      });

      const result = await fetchLmStudioModels();

      const modelCount = Object.keys(result).length;
      expect(modelCount).toBeLessThanOrEqual(MAX_LM_STUDIO_MODELS);
    });

    it('should skip invalid model IDs', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          data: [
            { id: 'valid-model/name' },
            { id: 'invalid model name' },  // Space not allowed
            { id: 'valid:tag' },
            { id: 123 },  // Not a string
            { id: null },  // Not a string
            {},  // No id
          ],
        })),
      });

      const result = await fetchLmStudioModels();

      const modelIds = Object.keys(result);
      expect(modelIds).toContain('valid-model/name');
      expect(modelIds).toContain('valid:tag');
      expect(modelIds).not.toContain('invalid model name');
      expect(modelIds).toHaveLength(2);
    });

    it('should accept model IDs with @ character (HuggingFace format)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          data: [
            { id: 'org/model@revision' },
            { id: 'lmstudio-community/model@v1.0' },
          ],
        })),
      });

      const result = await fetchLmStudioModels();

      expect(result).toHaveProperty('org/model@revision');
      expect(result).toHaveProperty('lmstudio-community/model@v1.0');
    });

    it('should return empty object on unexpected error type [S1-004]', async () => {
      // Inject unexpected error type (not Error instance)
      mockFetch.mockRejectedValue('unexpected string error');

      const result = await fetchLmStudioModels();

      expect(result).toEqual({});
    });
  });

  // ===========================================================================
  // ensureOpencodeConfig() - Integration Tests
  // ===========================================================================

  describe('ensureOpencodeConfig()', () => {
    /**
     * Helper: create URL-branching mockFetch implementation.
     * Returns specified responses for Ollama and LM Studio URLs.
     */
    function setupMockFetch(options: {
      ollama?: { ok: boolean; status?: number; body?: string } | 'reject';
      lmStudio?: { ok: boolean; status?: number; body?: string } | 'reject';
    }) {
      mockFetch.mockImplementation((url: string) => {
        if (url === OLLAMA_API_URL) {
          const ollamaOpt = options.ollama;
          if (ollamaOpt === 'reject' || !ollamaOpt) {
            return Promise.reject(new Error('ECONNREFUSED'));
          }
          const body = ollamaOpt.body ?? '{}';
          return Promise.resolve({
            ok: ollamaOpt.ok,
            status: ollamaOpt.status ?? (ollamaOpt.ok ? 200 : 500),
            text: () => Promise.resolve(body),
          });
        }
        if (url === LM_STUDIO_API_URL) {
          const lmOpt = options.lmStudio;
          if (lmOpt === 'reject' || !lmOpt) {
            return Promise.reject(new Error('ECONNREFUSED'));
          }
          const body = lmOpt.body ?? '{}';
          return Promise.resolve({
            ok: lmOpt.ok,
            status: lmOpt.status ?? (lmOpt.ok ? 200 : 500),
            text: () => Promise.resolve(body),
          });
        }
        return Promise.reject(new Error(`Unknown URL: ${url}`));
      });
    }

    it('should skip if opencode.json already exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);

      await ensureOpencodeConfig('/test/worktree');

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should generate config with both Ollama and LM Studio models', async () => {
      setupMockFetch({
        ollama: {
          ok: true,
          body: JSON.stringify({
            models: [{ name: 'qwen3:8b', details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } }],
          }),
        },
        lmStudio: {
          ok: true,
          body: JSON.stringify({
            data: [{ id: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF', object: 'model' }],
          }),
        },
      });

      await ensureOpencodeConfig('/test/worktree');

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content, options] = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(filePath).toBe(path.join('/test/worktree', 'opencode.json'));
      expect(options).toEqual({ encoding: 'utf-8', flag: 'wx' });

      const config = JSON.parse(content as string);
      expect(config.$schema).toBe('https://opencode.ai/config.json');

      // Ollama provider
      expect(config.provider.ollama).toBeDefined();
      expect(config.provider.ollama.npm).toBe('@ai-sdk/openai-compatible');
      expect(config.provider.ollama.name).toBe('Ollama (local)');
      expect(config.provider.ollama.options.baseURL).toBe(OLLAMA_BASE_URL);
      expect(config.provider.ollama.models).toHaveProperty('qwen3:8b');

      // LM Studio provider
      expect(config.provider.lmstudio).toBeDefined();
      expect(config.provider.lmstudio.npm).toBe('@ai-sdk/openai-compatible');
      expect(config.provider.lmstudio.name).toBe('LM Studio (local)');
      expect(config.provider.lmstudio.options.baseURL).toBe(LM_STUDIO_BASE_URL);
      expect(config.provider.lmstudio.models).toHaveProperty('lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF');
    });

    it('should generate config with Ollama only when LM Studio is not running', async () => {
      setupMockFetch({
        ollama: {
          ok: true,
          body: JSON.stringify({
            models: [{ name: 'qwen3:8b' }],
          }),
        },
        lmStudio: 'reject',
      });

      await ensureOpencodeConfig('/test/worktree');

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const config = JSON.parse(content);

      expect(config.provider.ollama).toBeDefined();
      expect(config.provider.ollama.models).toHaveProperty('qwen3:8b');
      expect(config.provider.lmstudio).toBeUndefined();
    });

    it('should generate config with LM Studio only when Ollama is not running', async () => {
      setupMockFetch({
        ollama: 'reject',
        lmStudio: {
          ok: true,
          body: JSON.stringify({
            data: [{ id: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF', object: 'model' }],
          }),
        },
      });

      await ensureOpencodeConfig('/test/worktree');

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const config = JSON.parse(content);

      expect(config.provider.ollama).toBeUndefined();
      expect(config.provider.lmstudio).toBeDefined();
      expect(config.provider.lmstudio.models).toHaveProperty('lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF');
    });

    it('should not generate opencode.json when both providers have 0 models', async () => {
      setupMockFetch({
        ollama: 'reject',
        lmStudio: 'reject',
      });

      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should not generate opencode.json when APIs succeed but return 0 models [S2-003]', async () => {
      setupMockFetch({
        ollama: {
          ok: true,
          body: JSON.stringify({ models: [] }),
        },
        lmStudio: {
          ok: true,
          body: JSON.stringify({ data: [] }),
        },
      });

      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
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
      setupMockFetch({
        ollama: {
          ok: true,
          body: JSON.stringify({ models: [{ name: 'test-model' }] }),
        },
        lmStudio: 'reject',
      });

      // Should not throw (write failure is non-fatal)
      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
    });

    it('should treat concurrent file creation as non-fatal', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
      });
      setupMockFetch({
        ollama: {
          ok: true,
          body: JSON.stringify({ models: [{ name: 'test-model' }] }),
        },
        lmStudio: 'reject',
      });

      await expect(ensureOpencodeConfig('/test/worktree')).resolves.toBeUndefined();
    });

    it('should call both fetch functions in parallel via Promise.all', async () => {
      // Verify that both Ollama and LM Studio APIs are called
      setupMockFetch({
        ollama: {
          ok: true,
          body: JSON.stringify({ models: [{ name: 'ollama-model' }] }),
        },
        lmStudio: {
          ok: true,
          body: JSON.stringify({ data: [{ id: 'lmstudio-model', object: 'model' }] }),
        },
      });

      await ensureOpencodeConfig('/test/worktree');

      // Both URLs should have been called
      const calledUrls = mockFetch.mock.calls.map((call) => call[0]);
      expect(calledUrls).toContain(OLLAMA_API_URL);
      expect(calledUrls).toContain(LM_STUDIO_API_URL);
    });
  });
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Ensure NODE_ENV=test regardless of shell environment (Issue #304)
(process.env as Record<string, string>).NODE_ENV = 'test';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
  test: {
    globals: true,
    environment: 'node',
    env: { NODE_ENV: 'test' },
    setupFiles: ['./tests/setup.ts'],
    // CI環境ではメモリ使用量を抑えるため同時実行を制限
    maxConcurrency: process.env.CI === 'true' ? 1 : 10,
    fileParallelism: process.env.CI !== 'true',
    // CI のランナーはワーカーの検証・UAT と同じ機械で走り、load average が 40〜55 に
    // なる。ふだん 1 秒のテストが 5 秒を超えて落ちる（2026-10-05 の PR #3317 の CI:
    // vi.resetModules() の後の動的 import が 5000ms 超）。テストごとの延長は
    // いたちごっこなので、CI だけ既定を 20 秒にする。手元は vitest 既定の 5 秒のまま。
    // tests/setup.ts の実シェルの予算（vi.setConfig）と it() 自身の指定が優先される。
    testTimeout: process.env.CI === 'true' ? 20_000 : 5_000,
    hookTimeout: process.env.CI === 'true' ? 20_000 : 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.config.{js,ts}',
        '**/types/',
        '.next/',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
});

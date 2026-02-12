// Vitest setup file
import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Mock next-intl for all component tests
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    return (key: string, params?: Record<string, string | number>) => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      if (params) {
        return Object.entries(params).reduce(
          (str, [k, v]) => str.replace(`{${k}}`, String(v)),
          fullKey
        );
      }
      return fullKey;
    };
  },
  useLocale: () => 'en',
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// グローバルなテスト設定

beforeAll(() => {
  // テスト開始時の初期化処理

  // Mock Element.scrollTo for jsdom (only in browser-like environments)
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = function(options?: ScrollToOptions | number) {
      if (typeof options === 'object') {
        this.scrollTop = options.top ?? 0;
        this.scrollLeft = options.left ?? 0;
      }
    };
  }
});

afterEach(() => {
  // 各テスト後のクリーンアップ
});

afterAll(() => {
  // すべてのテスト終了後のクリーンアップ
});

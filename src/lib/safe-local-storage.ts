/**
 * 例外を投げない localStorage の入口（Issue #4257）。
 *
 * プライベートモードの一部・サイトデータのブロックでは Storage の呼び出しが例外を投げる。
 * 読み出しの失敗は null（呼び出し側の既定値）、書き込み・削除の失敗は無視する。
 */

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const safeLocalStorage = {
  getItem(key: string): string | null {
    try {
      return getStorage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      getStorage()?.setItem(key, value);
    } catch {
      /* unavailable or quota exceeded */
    }
  },
  removeItem(key: string): void {
    try {
      getStorage()?.removeItem(key);
    } catch {
      /* unavailable */
    }
  },
};

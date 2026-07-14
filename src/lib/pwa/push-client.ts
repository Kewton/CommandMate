/**
 * Client-side Web Push helpers (Issue #1125).
 *
 * Browser-only utilities: capability detection, iOS/standalone detection, and
 * the VAPID key encoding required by PushManager.subscribe(). This module must
 * NOT import anything from '@/lib/push' (that pulls the Node `web-push` package
 * into the client bundle). Keep it dependency-free.
 */

/** Convert a base64url VAPID public key into the Uint8Array PushManager expects. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** True when the browser has the APIs required for Web Push. */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Detect iOS/iPadOS (which only allows push from a Home-Screen-installed PWA). */
export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  // iPadOS 13+ reports as MacIntel but is touch-capable.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** True when the app is running as an installed / standalone PWA. */
export function isStandalonePWA(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari exposes navigator.standalone instead of display-mode.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * Whether the current environment can subscribe to push. On iOS this is only
 * possible from an installed PWA — used to show the "add to Home Screen" hint.
 */
export function canSubscribeToPush(): { supported: boolean; iosNeedsInstall: boolean } {
  const supported = isPushSupported();
  const iosNeedsInstall = isIOSDevice() && !isStandalonePWA();
  return { supported: supported && !iosNeedsInstall, iosNeedsInstall };
}

/**
 * Notifications settings (More screen, Issue #1125).
 *
 * Lets the user enable Web Push on this device, toggle which agent events they
 * are notified about, and unsubscribe. Handles the unsupported-browser and
 * iOS-not-installed cases with guidance instead of a dead button.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bell } from 'lucide-react';
import { Button, Card, Spinner, Switch } from '@/components/ui';
import { useToast } from '@/components/common/Toast';
import {
  urlBase64ToUint8Array,
  isPushSupported,
  canSubscribeToPush,
} from '@/lib/pwa/push-client';

interface Prefs {
  prompt: boolean;
  completion: boolean;
}

export function NotificationsSettings() {
  const t = useTranslations('notifications');
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({ prompt: true, completion: true });

  const subscribed = endpoint !== null;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const cap = canSubscribeToPush();
      if (!cancelled) {
        setSupported(isPushSupported());
        setIosNeedsInstall(cap.iosNeedsInstall);
        if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
          setPermissionDenied(true);
        }
      }

      try {
        const res = await fetch('/api/push/vapid');
        const data = (await res.json()) as { configured: boolean; publicKey: string | null };
        if (!cancelled) {
          setConfigured(data.configured);
          setPublicKey(data.publicKey);
        }
      } catch {
        if (!cancelled) setConfigured(false);
      }

      if (isPushSupported()) {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          const sub = reg ? await reg.pushManager.getSubscription() : null;
          if (sub && !cancelled) {
            setEndpoint(sub.endpoint);
            const r = await fetch(
              `/api/push/subscriptions?endpoint=${encodeURIComponent(sub.endpoint)}`
            );
            const d = (await r.json()) as {
              subscribed: boolean;
              subscription?: { preferences: Prefs };
            };
            if (d.subscribed && d.subscription && !cancelled) {
              setPrefs(d.subscription.preferences);
            }
          }
        } catch {
          // No registration / push manager — leave as not subscribed.
        }
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnable = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPermissionDenied(permission === 'denied');
        showToast(t('toast.error'), 'error');
        return;
      }

      const existing = await navigator.serviceWorker.getRegistration();
      if (!existing) {
        // SW not registered (e.g. dev build) — cannot subscribe.
        showToast(t('toast.error'), 'error');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const res = await fetch('/api/push/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          deviceLabel: navigator.userAgent.slice(0, 120),
        }),
      });
      if (!res.ok) throw new Error('subscribe request failed');
      const data = (await res.json()) as { subscription?: { preferences: Prefs } };

      setEndpoint(sub.endpoint);
      if (data.subscription?.preferences) setPrefs(data.subscription.preferences);
      setPermissionDenied(false);
      showToast(t('toast.enabled'), 'success');
    } catch {
      showToast(t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  }, [publicKey, showToast, t]);

  const handleUnsubscribe = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      const ep = sub?.endpoint ?? endpoint;
      if (sub) await sub.unsubscribe();
      if (ep) {
        await fetch('/api/push/subscriptions', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: ep }),
        });
      }
      setEndpoint(null);
      showToast(t('toast.disabled'), 'info');
    } catch {
      showToast(t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  }, [endpoint, showToast, t]);

  const updatePref = useCallback(
    async (key: keyof Prefs, value: boolean) => {
      if (!endpoint) return;
      const previous = prefs;
      const next = { ...prefs, [key]: value };
      setPrefs(next);
      try {
        const res = await fetch('/api/push/subscriptions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint, preferences: next }),
        });
        if (!res.ok) throw new Error('update failed');
        showToast(t('toast.updated'), 'success');
      } catch {
        setPrefs(previous);
        showToast(t('toast.error'), 'error');
      }
    },
    [endpoint, prefs, showToast, t]
  );

  const renderBody = () => {
    if (loading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
        </div>
      );
    }

    if (!supported) {
      return <p className="text-sm text-muted-foreground">{t('unsupported')}</p>;
    }

    if (iosNeedsInstall) {
      return (
        <p className="text-sm text-muted-foreground" data-testid="notifications-ios-guidance">
          {t('ios.guidance')}
        </p>
      );
    }

    if (configured === false) {
      return <p className="text-sm text-muted-foreground">{t('notConfigured')}</p>;
    }

    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('description')}</p>

        {permissionDenied && (
          <p className="text-sm text-danger-foreground" data-testid="notifications-permission-denied">
            {t('permission.denied')}
          </p>
        )}

        {!subscribed ? (
          <Button
            variant="primary"
            onClick={handleEnable}
            disabled={busy || permissionDenied || !publicKey}
            data-testid="notifications-enable"
          >
            <Bell className="h-4 w-4" />
            {busy ? t('enabling') : t('enable')}
          </Button>
        ) : (
          <div className="space-y-4">
            <p className="text-sm font-medium text-foreground">{t('enabledOnThisDevice')}</p>

            <div className="space-y-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('types.heading')}
              </div>

              <label className="flex items-center justify-between gap-4">
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    {t('types.promptWaiting')}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t('types.promptWaitingDesc')}
                  </span>
                </span>
                <Switch
                  checked={prefs.prompt}
                  onCheckedChange={(v) => updatePref('prompt', v)}
                  disabled={busy}
                  aria-label={t('types.promptWaiting')}
                  data-testid="notifications-toggle-prompt"
                />
              </label>

              <label className="flex items-center justify-between gap-4">
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    {t('types.completion')}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t('types.completionDesc')}
                  </span>
                </span>
                <Switch
                  checked={prefs.completion}
                  onCheckedChange={(v) => updatePref('completion', v)}
                  disabled={busy}
                  aria-label={t('types.completion')}
                  data-testid="notifications-toggle-completion"
                />
              </label>
            </div>

            <Button
              variant="secondary"
              onClick={handleUnsubscribe}
              disabled={busy}
              data-testid="notifications-unsubscribe"
            >
              {t('unsubscribe')}
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <Card>
      {renderBody()}
    </Card>
  );
}

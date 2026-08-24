/**
 * Notifications settings (More screen, Issue #1125).
 *
 * Lets the user enable Web Push on this device, toggle which agent events they
 * are notified about, and unsubscribe. Handles the unsupported-browser and
 * iOS-not-installed cases with guidance instead of a dead button.
 *
 * Issue #1788 adds the in-app toast toggle **above** the push card, outside
 * every one of the guards below. That placement is the decision, not an
 * accident: `renderBody` returns early when the browser has no Push API, when
 * iOS has not been "Add to Home Screen"-ed, and when the server has no VAPID
 * keys — and those are precisely the installs where the in-app toast is the only
 * notification the user can get. Putting its switch inside that body would hide
 * the control exactly where it matters most.
 *
 * Issue #2056 adds the one-off defaults notice, and it goes the other way for
 * the mirror-image reason: it is about *this device's stored subscription*, so
 * it belongs directly above the two switches it describes, inside the subscribed
 * branch. A browser with no Push API has no subscription to be owed a notice
 * about.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bell } from 'lucide-react';
import { Button, Card, Spinner, Switch } from '@/components/ui';
import { useToast } from '@/components/common/Toast';
import { useInAppWaitingToast, useInAppWaitingSound } from '@/hooks/useInAppNotificationPrefs';
import {
  urlBase64ToUint8Array,
  isPushSupported,
  canSubscribeToPush,
} from '@/lib/pwa/push-client';

/**
 * The two stored toggles, named after their columns.
 *
 * Issue #2000 changed what they mean without changing their shape: `prompt` is
 * now the whole "you need to act" bucket (a prompt waiting, a failed
 * verification, an upstream fault, a session that could not start) and
 * `completion` is the optional "for information" one. The copy under
 * `notifications.types.*` is what says so to the reader.
 */
interface Prefs {
  prompt: boolean;
  completion: boolean;
}

/**
 * Issue #1790. Declared here rather than imported from `@/lib/push` on purpose:
 * that module is server-only (web-push, better-sqlite3), and this file is a
 * client component. The server sends its own defaults and choices with the GET,
 * so these two only cover the window before that response lands.
 */
interface EscalationSettings {
  enabled: boolean;
  thresholdMinutes: number;
}

const DEFAULT_ESCALATION_UI: EscalationSettings = { enabled: true, thresholdMinutes: 10 };
const ESCALATION_CHOICES_FALLBACK = [5, 10, 30, 60];

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
  /**
   * Issue #2000: mirrors `NEW_SUBSCRIPTION_DEFAULTS` on the server. Only visible
   * in the window before the GET lands (the body renders a spinner until then),
   * but a placeholder that disagreed with the server would flash the wrong
   * switch position on a device that has just registered.
   */
  const [prefs, setPrefs] = useState<Prefs>({ prompt: true, completion: false });
  /**
   * Issue #2056: whether this device is still owed the "the defaults changed"
   * notice. Server-decided — the client never computes it from `prefs`, because
   * a reader who deliberately turned completions back ON after acknowledging is
   * indistinguishable from one who was never told.
   *
   * Starts false so the notice can only ever *appear* once the GET has spoken;
   * a placeholder true would flash a banner at every newly registered device.
   */
  const [defaultsNoticePending, setDefaultsNoticePending] = useState(false);

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
              subscription?: { preferences: Prefs; defaultsNoticePending?: boolean };
            };
            if (d.subscribed && d.subscription && !cancelled) {
              setPrefs(d.subscription.preferences);
              setDefaultsNoticePending(d.subscription.defaultsNoticePending === true);
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
      const data = (await res.json()) as {
        subscription?: { preferences: Prefs; defaultsNoticePending?: boolean };
      };

      setEndpoint(sub.endpoint);
      if (data.subscription?.preferences) setPrefs(data.subscription.preferences);
      // A device registering now is created at the current defaults generation,
      // so the server says false here. Read it rather than assuming: an endpoint
      // that already existed comes back through the same ON CONFLICT path and
      // may well still be owed the notice.
      setDefaultsNoticePending(data.subscription?.defaultsNoticePending === true);
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

  /**
   * Answer the one-off defaults notice (Issue #2056).
   *
   * Both answers clear the notice — that is what makes the change *consented to*
   * rather than silent, which is the only way Epic #2002's criterion 3 ("ordinary
   * completions are not notified by default") and criterion 6 ("no notification
   * stops unintentionally") can both hold for a row that already existed.
   *
   * "Adopt" rides the completion toggle and the acknowledgement into one PATCH,
   * so a half-applied write cannot leave the reader with completions still on
   * and no notice left to offer turning them off.
   */
  const resolveDefaultsNotice = useCallback(
    async (adopt: boolean) => {
      if (!endpoint) return;
      const previousPrefs = prefs;
      const nextPrefs = adopt ? { ...prefs, completion: false } : prefs;

      setDefaultsNoticePending(false);
      if (adopt) setPrefs(nextPrefs);
      setBusy(true);
      try {
        const res = await fetch('/api/push/subscriptions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint,
            // Declining sends no `preferences` at all: "keep this device as it
            // is" must not rewrite toggles it is not changing.
            ...(adopt ? { preferences: nextPrefs } : {}),
            acknowledgeDefaultsNotice: true,
          }),
        });
        if (!res.ok) throw new Error('acknowledge failed');
        showToast(t(adopt ? 'defaultsNotice.adopted' : 'defaultsNotice.kept'), 'success');
      } catch {
        setPrefs(previousPrefs);
        setDefaultsNoticePending(true);
        showToast(t('toast.error'), 'error');
      } finally {
        setBusy(false);
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

            {defaultsNoticePending && (
              <div
                className="space-y-3 rounded-lg border border-info-border bg-info-subtle p-3"
                data-testid="notifications-defaults-notice"
              >
                <p className="text-sm font-semibold text-info-foreground">
                  {t('defaultsNotice.heading')}
                </p>
                <p className="text-xs text-foreground">{t('defaultsNotice.completionChanged')}</p>
                <p className="text-xs text-foreground">{t('defaultsNotice.failuresAdded')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    onClick={() => resolveDefaultsNotice(true)}
                    disabled={busy}
                    data-testid="notifications-defaults-notice-adopt"
                  >
                    {t('defaultsNotice.adopt')}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => resolveDefaultsNotice(false)}
                    disabled={busy}
                    data-testid="notifications-defaults-notice-keep"
                  >
                    {t('defaultsNotice.keep')}
                  </Button>
                </div>
              </div>
            )}

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
    <div className="space-y-4">
      <Card>
        <InAppNotificationSettings />
      </Card>
      <Card>
        {renderBody()}
      </Card>
      <Card>
        <EscalationNotificationSettings />
      </Card>
    </div>
  );
}

/**
 * In-app (cross-screen toast) notifications — Issue #1788.
 *
 * Always rendered: it needs no permission, no service worker and no server
 * configuration, so none of the push guards apply to it.
 */
/**
 * The "still waiting" reminder — Issue #1790.
 *
 * Rendered outside the push card's guards for the same reason the in-app switch
 * is, plus one of its own: this setting lives on the server and applies to every
 * subscribed device, so the phone that will actually receive the reminder need
 * not be the browser the user changes it from. A laptop with no Push API is a
 * perfectly ordinary place to turn it off.
 */
function EscalationNotificationSettings() {
  const t = useTranslations('notifications');
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<EscalationSettings>(DEFAULT_ESCALATION_UI);
  const [choices, setChoices] = useState<number[]>([...ESCALATION_CHOICES_FALLBACK]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/push/escalation');
        const data = (await res.json()) as {
          settings?: EscalationSettings;
          choices?: number[];
        };
        if (!cancelled) {
          if (data.settings) setSettings(data.settings);
          if (Array.isArray(data.choices) && data.choices.length > 0) setChoices(data.choices);
        }
      } catch {
        // Leave the defaults in place — they are what the server would use too.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (next: EscalationSettings) => {
      const previous = settings;
      setSettings(next);
      setSaving(true);
      try {
        const res = await fetch('/api/push/escalation', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: next }),
        });
        if (!res.ok) throw new Error('update failed');
        showToast(t('toast.updated'), 'success');
      } catch {
        setSettings(previous);
        showToast(t('toast.error'), 'error');
      } finally {
        setSaving(false);
      }
    },
    [settings, showToast, t]
  );

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('escalation.heading')}
      </div>
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-medium text-foreground">
            {t('escalation.toggle')}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t('escalation.toggleDesc')}
          </span>
        </span>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(v) => save({ ...settings, enabled: v })}
          disabled={loading || saving}
          aria-label={t('escalation.toggle')}
          data-testid="notifications-toggle-escalation"
        />
      </label>
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm text-foreground">{t('escalation.threshold')}</span>
        <select
          className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={String(settings.thresholdMinutes)}
          disabled={loading || saving || !settings.enabled}
          aria-label={t('escalation.threshold')}
          data-testid="notifications-escalation-threshold"
          onChange={(e) => save({ ...settings, thresholdMinutes: Number(e.target.value) })}
        >
          {choices.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {t('escalation.minutes', { count: minutes })}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function InAppNotificationSettings() {
  const t = useTranslations('notifications');
  const { enabled, setEnabled } = useInAppWaitingToast();
  // Issue #1789: the waiting chime, default off — see
  // `INAPP_WAITING_SOUND_DEFAULT` for why it defaults the other way to the toast.
  const { enabled: soundEnabled, setEnabled: setSoundEnabled } = useInAppWaitingSound();

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('inApp.heading')}
      </div>
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-medium text-foreground">
            {t('inApp.waitingToggle')}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t('inApp.waitingToggleDesc')}
          </span>
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t('inApp.waitingToggle')}
          data-testid="notifications-toggle-inapp-waiting"
        />
      </label>
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-medium text-foreground">
            {t('inApp.soundToggle')}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t('inApp.soundToggleDesc')}
          </span>
        </span>
        <Switch
          checked={soundEnabled}
          onCheckedChange={setSoundEnabled}
          aria-label={t('inApp.soundToggle')}
          data-testid="notifications-toggle-inapp-sound"
        />
      </label>
    </div>
  );
}

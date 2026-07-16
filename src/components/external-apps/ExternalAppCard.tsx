/**
 * ExternalAppCard Component
 * Displays a single external app with status, actions, and info
 * Issue #42: Proxy routing for multiple frontend applications
 */

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, Button, Badge } from '@/components/ui';
import { ExternalAppStatus } from './ExternalAppStatus';
import type { ExternalApp, ExternalAppType } from '@/types/external-apps';

export interface ExternalAppCardProps {
  /** External app data */
  app: ExternalApp;
  /** Callback when edit button is clicked */
  onEdit: (app: ExternalApp) => void;
  /** Callback when delete is confirmed */
  onDelete: (appId: string) => void;
}

/**
 * Get display label for app type
 */
function getAppTypeLabel(appType: ExternalAppType): string {
  const labels: Record<ExternalAppType, string> = {
    sveltekit: 'SvelteKit',
    streamlit: 'Streamlit',
    nextjs: 'Next.js',
    other: 'Other',
  };
  return labels[appType] || appType;
}

/**
 * Get badge variant for app type
 */
function getAppTypeBadgeVariant(appType: ExternalAppType): 'success' | 'warning' | 'error' | 'info' | 'gray' {
  const variants: Record<ExternalAppType, 'success' | 'warning' | 'error' | 'info' | 'gray'> = {
    sveltekit: 'warning',
    streamlit: 'error',
    nextjs: 'info',
    other: 'gray',
  };
  return variants[appType] || 'gray';
}

/**
 * ExternalAppCard component
 * Displays external app info with status and actions
 *
 * @example
 * ```tsx
 * <ExternalAppCard
 *   app={app}
 *   onEdit={(app) => openEditModal(app)}
 *   onDelete={(id) => deleteApp(id)}
 * />
 * ```
 */
export function ExternalAppCard({ app, onEdit, onDelete }: ExternalAppCardProps) {
  const t = useTranslations('externalApps');
  const tCommon = useTranslations('common');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onDelete(app.id);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const proxyUrl = `/proxy/${app.pathPrefix}/`;

  return (
    <Card padding="md" className="relative">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h4 className="text-base font-semibold text-foreground truncate">
            {app.displayName}
          </h4>
          <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
            {app.name}
          </p>
        </div>
        <Badge variant={getAppTypeBadgeVariant(app.appType)}>
          {getAppTypeLabel(app.appType)}
        </Badge>
      </div>

      {/* Info */}
      <div className="space-y-2 mb-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t('card.status')}</span>
          <ExternalAppStatus appId={app.id} pollInterval={30000} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t('card.port')}</span>
          <span className="text-sm font-mono text-foreground">:{app.targetPort}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t('card.path')}</span>
          <span className="text-sm font-mono text-foreground truncate max-w-[150px]">
            /proxy/{app.pathPrefix}/
          </span>
        </div>
        {app.websocketEnabled && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{t('card.websocket')}</span>
            <Badge variant="info">{t('card.enabled')}</Badge>
          </div>
        )}
        {!app.enabled && (
          <div className="mt-2 py-1 px-2 bg-warning-subtle border border-warning-border rounded text-xs text-warning-foreground">
            {t('card.disabledNotice')}
          </div>
        )}
      </div>

      {/* Actions */}
      {showDeleteConfirm ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t('card.deleteConfirm', { name: app.displayName })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              disabled={isDeleting}
              loading={isDeleting}
            >
              {t('card.delete')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="primary"
            size="sm"
            onClick={() => window.open(proxyUrl, '_blank')}
            disabled={!app.enabled}
          >
            {t('card.open')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onEdit(app)}
          >
            {t('card.settings')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDeleteConfirm(true)}
            className="text-danger-foreground hover:bg-danger-subtle"
          >
            {t('card.delete')}
          </Button>
        </div>
      )}
    </Card>
  );
}

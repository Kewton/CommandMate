/**
 * ExternalAppCard Component
 * Displays a single external app with status, actions, and info
 * Issue #42: Proxy routing for multiple frontend applications
 */

'use client';

import { useState } from 'react';
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
          <h4 className="text-base font-semibold text-gray-900 truncate">
            {app.displayName}
          </h4>
          <p className="text-xs text-gray-500 mt-0.5 font-mono truncate">
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
          <span className="text-sm text-gray-600">Status</span>
          <ExternalAppStatus appId={app.id} pollInterval={30000} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Port</span>
          <span className="text-sm font-mono text-gray-900">:{app.targetPort}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Path</span>
          <span className="text-sm font-mono text-gray-900 truncate max-w-[150px]">
            /proxy/{app.pathPrefix}/
          </span>
        </div>
        {app.websocketEnabled && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">WebSocket</span>
            <Badge variant="info">Enabled</Badge>
          </div>
        )}
        {!app.enabled && (
          <div className="mt-2 py-1 px-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-700">
            This app is disabled
          </div>
        )}
      </div>

      {/* Actions */}
      {showDeleteConfirm ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">
            Delete &quot;{app.displayName}&quot;?
          </p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              disabled={isDeleting}
              loading={isDeleting}
            >
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
            >
              Cancel
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
            Open
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onEdit(app)}
          >
            Settings
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDeleteConfirm(true)}
            className="text-red-600 hover:bg-red-50"
          >
            Delete
          </Button>
        </div>
      )}
    </Card>
  );
}

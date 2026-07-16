/**
 * ExternalAppsManager Component
 * Main component for managing external apps (top page section)
 * Issue #42: Proxy routing for multiple frontend applications
 */

'use client';

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, Spinner } from '@/components/ui';
import { ExternalAppCard } from './ExternalAppCard';
import { ExternalAppForm } from './ExternalAppForm';
import type { ExternalApp } from '@/types/external-apps';
import { EXTERNAL_APPS_POLL_INTERVAL_MS } from '@/config/external-apps-config';

/**
 * ExternalAppsManager component
 * Section for managing external apps on the top page
 *
 * @example
 * ```tsx
 * <ExternalAppsManager />
 * ```
 */
export function ExternalAppsManager() {
  const t = useTranslations('externalApps');
  const tCommon = useTranslations('common');
  // Data state
  const [apps, setApps] = useState<ExternalApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showForm, setShowForm] = useState(false);
  const [editApp, setEditApp] = useState<ExternalApp | null>(null);

  // Fetch apps
  const fetchApps = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch('/api/external-apps');
      if (!response.ok) {
        throw new Error('Failed to fetch external apps');
      }
      const data = await response.json();
      setApps(data.apps || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch and polling
  useEffect(() => {
    fetchApps();

    // Poll every 60 seconds
    const interval = setInterval(fetchApps, EXTERNAL_APPS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchApps]);

  // Handle edit
  const handleEdit = useCallback((app: ExternalApp) => {
    setEditApp(app);
    setShowForm(true);
  }, []);

  // Handle add
  const handleAdd = useCallback(() => {
    setEditApp(null);
    setShowForm(true);
  }, []);

  // Handle delete
  const handleDelete = useCallback(
    async (appId: string) => {
      try {
        const response = await fetch(`/api/external-apps/${appId}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to delete app');
        }

        // Refresh the list
        fetchApps();
      } catch (err) {
        console.error('Failed to delete app:', err);
        // Could show toast notification here
      }
    },
    [fetchApps]
  );

  // Handle form save
  const handleSave = useCallback(() => {
    fetchApps();
  }, [fetchApps]);

  // Handle form close
  const handleFormClose = useCallback(() => {
    setShowForm(false);
    setEditApp(null);
  }, []);

  return (
    <div className="space-y-4">
      {/* Heading is owned by the parent page (More) — this section only
          provides the add-app action to avoid a duplicate "External Apps" title. */}
      <div className="flex items-center justify-end">
        <Button variant="primary" size="sm" onClick={handleAdd}>
          {t('manager.addApp')}
        </Button>
      </div>

      {/* Content */}
      {isLoading ? (
        <Card padding="lg">
          <div className="flex items-center justify-center py-8">
            <Spinner size="xl" variant="accent" />
            <span className="ml-3 text-muted-foreground">{t('manager.loading')}</span>
          </div>
        </Card>
      ) : error ? (
        <Card padding="lg">
          <div className="text-center py-8">
            <p className="text-danger-foreground mb-4">{t('manager.loadError')}</p>
            <Button variant="secondary" size="sm" onClick={fetchApps}>
              {tCommon('retry')}
            </Button>
          </div>
        </Card>
      ) : apps.length === 0 ? (
        <Card padding="lg">
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">
              {t('manager.empty')}
            </p>
            <p className="text-sm text-muted-foreground mb-4">
              {t('manager.emptyHelp')}
            </p>
            <Button variant="primary" size="sm" onClick={handleAdd}>
              {t('manager.addFirst')}
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {apps.map((app) => (
            <ExternalAppCard
              key={app.id}
              app={app}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Form Modal */}
      <ExternalAppForm
        isOpen={showForm}
        onClose={handleFormClose}
        editApp={editApp}
        onSave={handleSave}
      />
    </div>
  );
}

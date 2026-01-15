/**
 * ExternalAppsManager Component
 * Main component for managing external apps (top page section)
 * Issue #42: Proxy routing for multiple frontend applications
 */

'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button, Card } from '@/components/ui';
import { ExternalAppCard } from './ExternalAppCard';
import { ExternalAppForm } from './ExternalAppForm';
import type { ExternalApp } from '@/types/external-apps';

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
      setApps(data);
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
    const interval = setInterval(fetchApps, 60000);
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-900">External Apps</h2>
        <Button variant="primary" size="sm" onClick={handleAdd}>
          + Add App
        </Button>
      </div>

      {/* Content */}
      {isLoading ? (
        <Card padding="lg">
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            <span className="ml-3 text-gray-600">Loading apps...</span>
          </div>
        </Card>
      ) : error ? (
        <Card padding="lg">
          <div className="text-center py-8">
            <p className="text-red-600 mb-4">Failed to load external apps</p>
            <Button variant="secondary" size="sm" onClick={fetchApps}>
              Retry
            </Button>
          </div>
        </Card>
      ) : apps.length === 0 ? (
        <Card padding="lg">
          <div className="text-center py-8">
            <p className="text-gray-500 mb-4">
              No external apps registered yet.
            </p>
            <p className="text-sm text-gray-400 mb-4">
              Add an external app to proxy requests to other frontend
              applications.
            </p>
            <Button variant="primary" size="sm" onClick={handleAdd}>
              Add Your First App
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

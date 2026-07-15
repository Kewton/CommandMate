/**
 * RepositoryManager Component
 * Allows users to add and manage git repositories
 * Issue #71: Extended with Clone URL registration feature
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, Input, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import { repositoryApi, handleApiError } from '@/lib/api-client';
import { UrlNormalizer } from '@/lib/url-normalizer';
import { CLONE_STATUS_POLL_INTERVAL_MS } from '@/config/repository-config';

export interface RepositoryManagerProps {
  onRepositoryAdded?: () => void;
}

/** Input mode type */
type InputMode = 'local' | 'url';

/**
 * Repository management component
 *
 * @example
 * ```tsx
 * <RepositoryManager onRepositoryAdded={() => refreshWorktrees()} />
 * ```
 */
export function RepositoryManager({ onRepositoryAdded }: RepositoryManagerProps) {
  const t = useTranslations('common');
  const [showAddForm, setShowAddForm] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('local');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  const [cloneJobId, setCloneJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const urlNormalizer = UrlNormalizer.getInstance();

  /**
   * Poll clone job status
   */
  const pollCloneStatus = useCallback(async (jobId: string) => {
    try {
      const status = await repositoryApi.getCloneStatus(jobId);

      if (status.status === 'completed') {
        setSuccess(t('repositories.cloneSuccess'));
        setIsCloning(false);
        setCloneJobId(null);
        setCloneUrl('');
        setShowAddForm(false);

        // Notify parent to refresh
        if (onRepositoryAdded) {
          onRepositoryAdded();
        }
      } else if (status.status === 'failed') {
        setError(status.error?.message || t('repositories.cloneFailed'));
        setIsCloning(false);
        setCloneJobId(null);
      } else if (status.status === 'running' || status.status === 'pending') {
        // Continue polling
        setTimeout(() => pollCloneStatus(jobId), CLONE_STATUS_POLL_INTERVAL_MS);
      }
    } catch (err) {
      setError(handleApiError(err));
      setIsCloning(false);
      setCloneJobId(null);
    }
  }, [onRepositoryAdded, t]);

  /**
   * Start polling when we have a job ID
   */
  useEffect(() => {
    if (cloneJobId && isCloning) {
      pollCloneStatus(cloneJobId);
    }
    // Keyed on the job, not pollCloneStatus: `t` churns identity every render,
    // so keying on it re-enters polling per render — 5 re-renders during a clone
    // left 6 concurrent setTimeout chains instead of 1 (Issue #1032).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneJobId, isCloning]);

  /**
   * Handle adding a new repository (local path mode)
   */
  const handleAddRepository = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!repositoryPath.trim()) {
      setError(t('repositories.pathRequired'));
      return;
    }

    setError(null);
    setSuccess(null);
    setIsScanning(true);

    try {
      const result = await repositoryApi.scan(repositoryPath);
      setSuccess(result.message);
      setRepositoryPath('');
      setShowAddForm(false);

      // Notify parent to refresh
      if (onRepositoryAdded) {
        onRepositoryAdded();
      }
    } catch (err) {
      setError(handleApiError(err));
    } finally {
      setIsScanning(false);
    }
  };

  /**
   * Handle cloning a repository (URL mode)
   */
  const handleCloneRepository = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate URL
    if (!cloneUrl.trim()) {
      setError(t('repositories.urlRequired'));
      return;
    }

    const validation = urlNormalizer.validate(cloneUrl.trim());
    if (!validation.valid) {
      if (validation.error === 'EMPTY_URL') {
        setError(t('repositories.urlRequired'));
      } else {
        setError(t('repositories.urlInvalid'));
      }
      return;
    }

    setError(null);
    setSuccess(null);
    setIsCloning(true);

    try {
      const result = await repositoryApi.clone(cloneUrl.trim());
      setCloneJobId(result.jobId);
      // Polling will be started by useEffect
    } catch (err) {
      setError(handleApiError(err));
      setIsCloning(false);
    }
  };

  /**
   * Handle syncing all repositories
   */
  const handleSyncRepositories = async () => {
    setError(null);
    setSuccess(null);
    setIsSyncing(true);

    try {
      const result = await repositoryApi.sync();
      setSuccess(result.message);

      // Notify parent to refresh
      if (onRepositoryAdded) {
        onRepositoryAdded();
      }
    } catch (err) {
      setError(handleApiError(err));
    } finally {
      setIsSyncing(false);
    }
  };

  /**
   * Handle form cancellation
   */
  const handleCancel = () => {
    setShowAddForm(false);
    setRepositoryPath('');
    setCloneUrl('');
    setError(null);
    setInputMode('local');
  };

  return (
    <div className="space-y-4">
      {/* Action Buttons */}
      <div className="flex gap-2 flex-wrap">
        {!showAddForm && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowAddForm(true)}
          >
            + {t('repositories.add')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSyncRepositories}
          disabled={isSyncing}
        >
          {isSyncing ? t('repositories.syncing') : t('repositories.syncAll')}
        </Button>
      </div>

      {/* Add Repository Form */}
      {showAddForm && (
        <Card padding="lg">
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2 text-foreground">{t('repositories.addNewTitle')}</h3>
            </div>

            {/* Mode Toggle Tabs */}
            <Tabs
              value={inputMode}
              onValueChange={(value) => setInputMode(value as InputMode)}
            >
              <TabsList className="w-full">
                <TabsTrigger value="local">{t('repositories.localPathTab')}</TabsTrigger>
                <TabsTrigger value="url">{t('repositories.cloneUrlTab')}</TabsTrigger>
              </TabsList>

              {/* Local Path Mode */}
              <TabsContent value="local">
                <form onSubmit={handleAddRepository} className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground mb-4">
                      {t('repositories.localPathDescription')}
                    </p>
                    <label htmlFor="repositoryPath" className="block text-sm font-medium text-foreground mb-2">
                      {t('repositories.localPathLabel')}
                    </label>
                    <Input
                      id="repositoryPath"
                      type="text"
                      value={repositoryPath}
                      onChange={(e) => setRepositoryPath(e.target.value)}
                      placeholder="/absolute/path/to/repository"
                      className="font-mono"
                      disabled={isScanning}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('repositories.localPathExample')}
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={isScanning || !repositoryPath.trim()}
                    >
                      {isScanning ? t('repositories.scanning') : t('repositories.scan')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleCancel}
                      disabled={isScanning}
                    >
                      {t('cancel')}
                    </Button>
                  </div>
                </form>
              </TabsContent>

              {/* Clone URL Mode */}
              <TabsContent value="url">
                <form onSubmit={handleCloneRepository} className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground mb-4">
                      {t('repositories.cloneUrlDescription')}
                    </p>
                    <label htmlFor="cloneUrl" className="block text-sm font-medium text-foreground mb-2">
                      {t('repositories.cloneUrlLabel')}
                    </label>
                    <Input
                      id="cloneUrl"
                      type="text"
                      value={cloneUrl}
                      onChange={(e) => setCloneUrl(e.target.value)}
                      placeholder="https://github.com/user/repo.git"
                      className="font-mono"
                      disabled={isCloning}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('repositories.cloneUrlHelp')}
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={isCloning || !cloneUrl.trim()}
                    >
                      {isCloning ? t('repositories.cloning') : t('repositories.clone')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleCancel}
                      disabled={isCloning}
                    >
                      {t('cancel')}
                    </Button>
                  </div>
                </form>
              </TabsContent>
            </Tabs>
          </div>
        </Card>
      )}

      {/* Success Message */}
      {success && (
        <div className="p-4 bg-success-subtle border border-success-border rounded-lg">
          <p className="text-sm text-success-foreground">{success}</p>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="p-4 bg-danger-subtle border border-danger-border rounded-lg">
          <p className="text-sm text-danger-foreground">{error}</p>
        </div>
      )}
    </div>
  );
}

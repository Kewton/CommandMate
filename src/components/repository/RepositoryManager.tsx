/**
 * RepositoryManager Component
 * Allows users to add and manage git repositories
 * Issue #71: Extended with Clone URL registration feature
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card } from '@/components/ui';
import { repositoryApi, handleApiError } from '@/lib/api-client';
import { UrlNormalizer } from '@/lib/url-normalizer';

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
        setSuccess('Repository cloned successfully');
        setIsCloning(false);
        setCloneJobId(null);
        setCloneUrl('');
        setShowAddForm(false);

        // Notify parent to refresh
        if (onRepositoryAdded) {
          onRepositoryAdded();
        }
      } else if (status.status === 'failed') {
        setError(status.error?.message || 'Clone failed');
        setIsCloning(false);
        setCloneJobId(null);
      } else if (status.status === 'running' || status.status === 'pending') {
        // Continue polling
        setTimeout(() => pollCloneStatus(jobId), 2000);
      }
    } catch (err) {
      setError(handleApiError(err));
      setIsCloning(false);
      setCloneJobId(null);
    }
  }, [onRepositoryAdded]);

  /**
   * Start polling when we have a job ID
   */
  useEffect(() => {
    if (cloneJobId && isCloning) {
      pollCloneStatus(cloneJobId);
    }
  }, [cloneJobId, isCloning, pollCloneStatus]);

  /**
   * Handle adding a new repository (local path mode)
   */
  const handleAddRepository = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!repositoryPath.trim()) {
      setError('Repository path is required');
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
      setError('Clone URL is required');
      return;
    }

    const validation = urlNormalizer.validate(cloneUrl.trim());
    if (!validation.valid) {
      if (validation.error === 'EMPTY_URL') {
        setError('Clone URL is required');
      } else {
        setError('Invalid URL format');
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
            + Add Repository
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSyncRepositories}
          disabled={isSyncing}
        >
          {isSyncing ? 'Syncing...' : 'Sync All'}
        </Button>
      </div>

      {/* Add Repository Form */}
      {showAddForm && (
        <Card padding="lg">
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2 dark:text-gray-100">Add New Repository</h3>
            </div>

            {/* Mode Toggle Tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-700" role="tablist">
              <button
                role="tab"
                aria-selected={inputMode === 'local'}
                onClick={() => setInputMode('local')}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  inputMode === 'local'
                    ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Local Path
              </button>
              <button
                role="tab"
                aria-selected={inputMode === 'url'}
                onClick={() => setInputMode('url')}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  inputMode === 'url'
                    ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Clone URL
              </button>
            </div>

            {/* Local Path Mode */}
            {inputMode === 'local' && (
              <form onSubmit={handleAddRepository} className="space-y-4">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                    Enter the absolute path to a git repository containing worktrees.
                  </p>
                  <label htmlFor="repositoryPath" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                    Repository Path
                  </label>
                  <input
                    id="repositoryPath"
                    type="text"
                    value={repositoryPath}
                    onChange={(e) => setRepositoryPath(e.target.value)}
                    placeholder="/absolute/path/to/repository"
                    className="input w-full font-mono text-sm"
                    disabled={isScanning}
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Example: /Users/username/projects/my-repo
                  </p>
                </div>

                <div className="flex gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={isScanning || !repositoryPath.trim()}
                  >
                    {isScanning ? 'Scanning...' : 'Scan & Add'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleCancel}
                    disabled={isScanning}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {/* Clone URL Mode */}
            {inputMode === 'url' && (
              <form onSubmit={handleCloneRepository} className="space-y-4">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                    Enter a git clone URL to clone a remote repository.
                  </p>
                  <label htmlFor="cloneUrl" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                    Clone URL
                  </label>
                  <input
                    id="cloneUrl"
                    type="text"
                    value={cloneUrl}
                    onChange={(e) => setCloneUrl(e.target.value)}
                    placeholder="https://github.com/user/repo.git"
                    className="input w-full font-mono text-sm"
                    disabled={isCloning}
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Supports HTTPS and SSH URLs
                  </p>
                </div>

                <div className="flex gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={isCloning || !cloneUrl.trim()}
                  >
                    {isCloning ? 'Cloning...' : 'Clone'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleCancel}
                    disabled={isCloning}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Card>
      )}

      {/* Success Message */}
      {success && (
        <div className="p-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg">
          <p className="text-sm text-green-800 dark:text-green-300">{success}</p>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}
    </div>
  );
}

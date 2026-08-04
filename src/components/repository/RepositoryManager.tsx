/**
 * RepositoryManager Component
 * Allows users to add and manage git repositories
 * Issue #71: Extended with Clone URL registration feature
 * Issue #1662: Warns — and asks — when the path being added is the same git
 *              repository as an existing scan root. It WARNS; it never blocks.
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { FolderOpen } from 'lucide-react';
import { Button, Card, ConfirmDialog, Input, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import {
  repositoryApi,
  fsApi,
  handleApiError,
  type ValidatePathResponse,
} from '@/lib/api-client';
import { UrlNormalizer } from '@/lib/url-normalizer';
import { DirectoryPickerModal } from './DirectoryPickerModal';
import { CLONE_STATUS_POLL_INTERVAL_MS } from '@/config/repository-config';

export interface RepositoryManagerProps {
  onRepositoryAdded?: () => void;
}

/** Input mode type */
type InputMode = 'local' | 'url';

/** Debounce for the while-typing path check (Issue #1517). */
const PATH_VALIDATION_DEBOUNCE_MS = 400;

/**
 * How long submit will wait for a duplicate verdict before registering without
 * one (Issue #1662).
 *
 * Submitting faster than the debounce above means no verdict is in hand yet, so
 * submit re-asks — otherwise the warning would be skippable by clicking
 * quickly. But the check is ADVISORY: an endpoint that never answers must not
 * leave "Scan & Add" wedged forever. Past the deadline the registration
 * proceeds silently and the Repositories list still flags the duplicate
 * afterwards, which is the other half of this Issue.
 */
const DUPLICATE_CHECK_DEADLINE_MS = 400;

/** Fallback example when the allowed roots have not loaded yet. */
const FALLBACK_PATH_EXAMPLE = '/Users/username/projects/my-repo';

type Translate = ReturnType<typeof useTranslations<'common'>>;

/**
 * Turn a validate-path result into the single line shown under the input.
 * `intent` picks the colour so a rejected path never reads as neutral help text.
 */
function describeValidation(
  t: Translate,
  validation: ValidatePathResponse
): { message: string; intent: 'ok' | 'warn' | 'error' } {
  if (!validation.valid) {
    if (validation.reason === 'not-found') {
      return { message: t('repositories.validationNotFound'), intent: 'error' };
    }
    return {
      message: t('repositories.validationOutsideRoots', {
        roots: validation.allowedRootsLabel,
      }),
      intent: 'error',
    };
  }

  if (!validation.isGitRepo) {
    return { message: t('repositories.validationNotGitRepo'), intent: 'warn' };
  }

  return {
    message: t('repositories.validationGitRepo', {
      count: validation.worktreeCount ?? 1,
    }),
    intent: 'ok',
  };
}

const VALIDATION_INTENT_CLASS = {
  ok: 'text-success-foreground',
  warn: 'text-warning-foreground',
  error: 'text-danger-foreground',
} as const;

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
  const [forkBeforeClone, setForkBeforeClone] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  const [cloneJobId, setCloneJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [allowedRoots, setAllowedRoots] = useState<string[]>([]);
  const [pathValidation, setPathValidation] = useState<ValidatePathResponse | null>(null);
  /**
   * Which input `pathValidation` describes (Issue #1662).
   *
   * The while-typing check is debounced, so at submit time the held result may
   * belong to a shorter prefix of what is now in the box. Submitting fast would
   * then consult a validation for a DIFFERENT path — and the duplicate warning
   * would be skippable simply by pressing the button quickly. Tracking the
   * subject lets submit notice the mismatch and re-check.
   */
  const [validatedPath, setValidatedPath] = useState<string | null>(null);
  /** Duplicate scan roots awaiting the user's decision, or null. */
  const [pendingDuplicate, setPendingDuplicate] = useState<
    { path: string; duplicates: string[] } | null
  >(null);

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
        setForkBeforeClone(false);
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
   * Issue #1517: the allowed roots drive the example path and the hint, so a
   * repository outside them stops looking like a typo.
   */
  useEffect(() => {
    if (!showAddForm) return;

    let cancelled = false;
    fsApi
      .browse()
      .then((listing) => {
        if (!cancelled) setAllowedRoots(listing.roots);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [showAddForm]);

  /**
   * Issue #1517: answer "will Scan & Add accept this?" while the user types,
   * instead of after they submit.
   */
  useEffect(() => {
    const candidate = repositoryPath.trim();
    if (!candidate) {
      setPathValidation(null);
      setValidatedPath(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      repositoryApi
        .validatePath(candidate)
        .then((result) => {
          if (cancelled) return;
          setPathValidation(result);
          setValidatedPath(candidate);
        })
        .catch(() => {
          if (cancelled) return;
          setPathValidation(null);
          setValidatedPath(null);
        });
    }, PATH_VALIDATION_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repositoryPath]);

  /**
   * Scan roots that already point at this path's git repository (Issue #1662).
   *
   * Prefers the while-typing result, but only when it actually describes the
   * path being submitted; otherwise it re-asks. A failure here returns an empty
   * list on purpose — the duplicate check is advisory, and an unreachable
   * endpoint must not stop someone from registering a repository.
   */
  const resolveDuplicateScanRoots = useCallback(
    async (candidate: string): Promise<string[]> => {
      if (validatedPath === candidate && pathValidation) {
        return pathValidation.duplicateScanRoots ?? [];
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const fresh = await Promise.race([
          repositoryApi.validatePath(candidate).then((result) => {
            setPathValidation(result);
            setValidatedPath(candidate);
            return result;
          }),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), DUPLICATE_CHECK_DEADLINE_MS);
          }),
        ]);
        return fresh?.duplicateScanRoots ?? [];
      } catch {
        return [];
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    [pathValidation, validatedPath]
  );

  /**
   * Register a local path. Split out of the submit handler so the
   * duplicate-confirmation path (Issue #1662) reaches exactly the same code as
   * the ordinary one — the confirmation must change WHETHER we scan, never HOW.
   */
  const runScan = useCallback(
    async (candidate: string) => {
      try {
        const result = await repositoryApi.scan(candidate);
        setSuccess(result.message);
        setRepositoryPath('');
        setShowAddForm(false);

        // Notify parent to refresh
        if (onRepositoryAdded) {
          onRepositoryAdded();
        }
      } catch (err) {
        setError(handleApiError(err));
      }
    },
    [onRepositoryAdded]
  );

  /**
   * Handle adding a new repository (local path mode)
   */
  const handleAddRepository = async (e: React.FormEvent) => {
    e.preventDefault();

    const candidate = repositoryPath.trim();
    if (!candidate) {
      setError(t('repositories.pathRequired'));
      return;
    }

    setError(null);
    setSuccess(null);
    setIsScanning(true);

    try {
      // Issue #1662: ask before creating a second scan root for a repository
      // that already has one. Nothing is registered until the user answers.
      const duplicates = await resolveDuplicateScanRoots(candidate);
      if (duplicates.length > 0) {
        setPendingDuplicate({ path: candidate, duplicates });
        return;
      }

      await runScan(candidate);
    } finally {
      setIsScanning(false);
    }
  };

  /** Issue #1662: the user chose to register the duplicate anyway. */
  const handleConfirmDuplicate = useCallback(() => {
    const target = pendingDuplicate;
    setPendingDuplicate(null);
    if (!target) return;

    setIsScanning(true);
    void runScan(target.path).finally(() => setIsScanning(false));
  }, [pendingDuplicate, runScan]);

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
      const result = await repositoryApi.clone(cloneUrl.trim(), { fork: forkBeforeClone });
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
    setForkBeforeClone(false);
    setError(null);
    setInputMode('local');
    setPendingDuplicate(null);
  };

  const validationDisplay = pathValidation ? describeValidation(t, pathValidation) : null;
  // Issue #1662: shown alongside the validation line, not instead of it — the
  // path is perfectly valid, it just already has a scan root.
  const duplicateScanRoots = pathValidation?.duplicateScanRoots ?? [];

  return (
    <div className="space-y-4">
      {/* Action Buttons */}
      <div className="flex gap-2 flex-wrap">
        {!showAddForm && (
          <Button
            data-testid="add-repository-button"
            variant="primary"
            size="sm"
            onClick={() => setShowAddForm(true)}
          >
            + {t('repositories.add')}
          </Button>
        )}
        <Button
          data-testid="sync-all-button"
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
                    {/* The free-text field stays: it is the only way to reach a
                        path on a differently-mounted host (Issue #1517). */}
                    <div className="flex gap-2">
                      <Input
                        id="repositoryPath"
                        data-testid="repository-path-input"
                        type="text"
                        value={repositoryPath}
                        onChange={(e) => setRepositoryPath(e.target.value)}
                        placeholder="/absolute/path/to/repository"
                        className="font-mono flex-1"
                        disabled={isScanning}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setIsPickerOpen(true)}
                        disabled={isScanning}
                        className="min-h-[44px] flex-shrink-0"
                      >
                        <FolderOpen className="w-4 h-4 mr-1" aria-hidden />
                        {t('repositories.browse')}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('repositories.localPathExample', {
                        example: allowedRoots[0]
                          ? `${allowedRoots[0]}/my-repo`
                          : FALLBACK_PATH_EXAMPLE,
                      })}
                    </p>
                    {allowedRoots.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1 font-mono break-all">
                        {t('repositories.localPathAllowedRoots', {
                          roots: allowedRoots.join(', '),
                        })}
                      </p>
                    )}
                    {validationDisplay && (
                      <p className={`text-xs mt-1 ${VALIDATION_INTENT_CLASS[validationDisplay.intent]}`}>
                        {validationDisplay.message}
                      </p>
                    )}
                    {duplicateScanRoots.length > 0 && (
                      <p
                        className="text-xs mt-1 text-warning-foreground break-all"
                        data-testid="duplicate-scan-root-warning"
                      >
                        {t('repositories.duplicateScanRootWarning', {
                          paths: duplicateScanRoots.join(', '),
                        })}
                      </p>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      data-testid="repository-scan-submit"
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

                  <div className="flex items-start gap-2">
                    <input
                      id="forkBeforeClone"
                      type="checkbox"
                      checked={forkBeforeClone}
                      onChange={(e) => setForkBeforeClone(e.target.checked)}
                      disabled={isCloning}
                      className="mt-1"
                    />
                    <label htmlFor="forkBeforeClone" className="text-sm text-foreground">
                      {t('repositories.forkOptionLabel')}
                      <span className="block text-xs text-muted-foreground">
                        {t('repositories.forkOptionHelp')}
                      </span>
                    </label>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={isCloning || !cloneUrl.trim()}
                    >
                      {isCloning
                        ? t('repositories.cloning')
                        : forkBeforeClone
                          ? t('repositories.forkAndClone')
                          : t('repositories.clone')}
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

      <DirectoryPickerModal
        isOpen={isPickerOpen}
        onClose={() => setIsPickerOpen(false)}
        onSelect={(selectedPath) => {
          setRepositoryPath(selectedPath);
          setError(null);
        }}
      />

      {/*
        Issue #1662: a confirmation, not a refusal. Managing two worktrees of one
        repository as independent scan roots is a legitimate choice, so the
        dialog explains the cost (every shared worktree registered twice, the
        stored repository path alternating between the roots) and lets the user
        proceed. variant="default": nothing here is destructive.
      */}
      <ConfirmDialog
        isOpen={pendingDuplicate !== null}
        title={t('repositories.duplicateConfirmTitle')}
        description={t('repositories.duplicateConfirmBody', {
          path: pendingDuplicate?.path ?? '',
          paths: (pendingDuplicate?.duplicates ?? []).join('\n'),
        })}
        confirmLabel={t('repositories.duplicateConfirmAction')}
        variant="default"
        onConfirm={handleConfirmDuplicate}
        onCancel={() => setPendingDuplicate(null)}
      />
    </div>
  );
}

/**
 * useUpdateCheck Hook
 * Issue #257: Version update notification feature
 *
 * Custom hook for checking application updates via the update-check API.
 * Fetches on component mount and manages loading/error/data states.
 *
 * @module hooks/useUpdateCheck
 */

'use client';

import { useState, useEffect } from 'react';
import { appApi, type UpdateCheckResponse } from '@/lib/api-client';

/** Hook state for update check */
export interface UseUpdateCheckState {
  data: UpdateCheckResponse | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hook to check for application updates.
 * Calls /api/app/update-check on mount.
 *
 * @returns State object with data, loading, and error
 */
export function useUpdateCheck(): UseUpdateCheckState {
  const [data, setData] = useState<UpdateCheckResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchUpdate() {
      try {
        setLoading(true);
        setError(null);
        const result = await appApi.checkForUpdate();
        if (!cancelled) {
          setData(result);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to check for updates');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchUpdate();

    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

/**
 * A repository's mem settings (Issue #4221, design §11.1): the branch rules (first
 * match wins), each branch's own mode, and the three switches. The only place a mode
 * is changed; the CLI reads it. Opened from the repository list, as the roles are,
 * so the PC and the phone share it.
 */

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { memSettingsApi, type MemSettingsResult } from '@/lib/mem/screen-client';
import {
  MEM_FEATURE_KEYS,
  MEM_MODES,
  type MemBranchRule,
  type MemFeatures,
  type MemMode,
  type MemRepositorySettings,
} from '@/types/mem';

type SaveState = null | 'saving' | 'saved' | 'conflict' | 'invalid' | 'failed';

const INPUT_CLASS =
  'rounded border border-border bg-surface px-2 py-1 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function RepositoryMemSettings({ repositoryId }: { repositoryId: string }): React.ReactElement {
  const t = useTranslations('common');
  const [settings, setSettings] = useState<MemRepositorySettings | null>(null);
  const [rules, setRules] = useState<MemBranchRule[]>([]);
  const [features, setFeatures] = useState<MemFeatures>({ injectOnStart: false, promptOnEvents: false, popup: false });
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(null);
  const [newBranch, setNewBranch] = useState('');
  const [newBranchMode, setNewBranchMode] = useState<MemMode>('on');
  const requestRef = useRef(0);

  const adopt = useCallback((next: MemRepositorySettings) => {
    setSettings(next);
    setRules(next.rules);
    setFeatures(next.features);
  }, []);

  const load = useCallback(async () => {
    requestRef.current += 1;
    const request = requestRef.current;
    const result = await memSettingsApi.read(repositoryId);
    if (request !== requestRef.current) return;
    if (result.ok) adopt(result.settings);
    setLoadFailed(!result.ok);
  }, [adopt, repositoryId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const settle = useCallback(
    (result: MemSettingsResult) => {
      if (result.ok) {
        adopt(result.settings);
        setSaveState('saved');
        return;
      }
      if (result.status === 409) {
        if (result.settings) adopt(result.settings);
        setSaveState('conflict');
        return;
      }
      setSaveState(result.status === 400 ? 'invalid' : 'failed');
    },
    [adopt]
  );

  const saveRules = useCallback(async () => {
    if (!settings) return;
    setSaveState('saving');
    settle(await memSettingsApi.save(repositoryId, { version: settings.version, features, rules }));
  }, [features, repositoryId, rules, settings, settle]);

  const addOverride = useCallback(async () => {
    if (!settings || newBranch.trim().length === 0) return;
    setSaveState('saving');
    const result = await memSettingsApi.saveOverride(repositoryId, settings.version, {
      branch: newBranch.trim(),
      mode: newBranchMode,
      injectOnStart: null,
      promptOnEvents: null,
      popup: null,
    });
    settle(result);
    if (result.ok) setNewBranch('');
  }, [newBranch, newBranchMode, repositoryId, settings, settle]);

  const removeOverride = useCallback(
    async (branch: string) => {
      if (!settings) return;
      setSaveState('saving');
      settle(await memSettingsApi.removeOverride(repositoryId, settings.version, branch));
    },
    [repositoryId, settings, settle]
  );

  const updateRule = (index: number, patch: Partial<MemBranchRule>) =>
    setRules((current) =>
      current.map((rule, i) => {
        if (i !== index) return rule;
        const next = { ...rule, ...patch };
        return next.match === 'detached' ? { ...next, pattern: null } : { ...next, pattern: next.pattern ?? '' };
      })
    );
  const moveRule = (index: number, delta: number) =>
    setRules((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  if (loadFailed && !settings) {
    return (
      <p role="alert" data-testid={`repository-mem-error-${repositoryId}`} className="text-xs text-danger-foreground">
        {t('mem.loadError')}
      </p>
    );
  }
  if (!settings) return <p className="text-xs text-muted-foreground">{t('mem.loading')}</p>;

  const modeLabel = (mode: MemMode) => t(`mem.mode.${mode}`);

  return (
    <div className="space-y-3" data-testid={`repository-mem-${repositoryId}`}>
      <p className="text-xs text-muted-foreground">{t('mem.description')}</p>
      <p className="text-xs text-muted-foreground">{t('mem.limits')}</p>

      <section className="space-y-2">
        <h4 className="text-xs font-medium text-foreground">{t('mem.rules.title')}</h4>
        {rules.length === 0 && <p className="text-xs text-muted-foreground">{t('mem.rules.none')}</p>}
        <ol className="space-y-1">
          {rules.map((rule, index) => (
            <li key={index} className="flex flex-wrap items-center gap-1" data-testid={`repository-mem-rule-${repositoryId}-${index}`}>
              <select
                aria-label={t('mem.rules.match')}
                className={INPUT_CLASS}
                value={rule.match}
                onChange={(e) => updateRule(index, { match: e.target.value as MemBranchRule['match'] })}
              >
                <option value="glob">{t('mem.rules.glob')}</option>
                <option value="detached">{t('mem.rules.detached')}</option>
              </select>
              {rule.match === 'glob' && (
                <input
                  type="text"
                  aria-label={t('mem.rules.pattern')}
                  data-testid={`repository-mem-rule-pattern-${repositoryId}-${index}`}
                  className={`${INPUT_CLASS} min-w-0 flex-1`}
                  value={rule.pattern ?? ''}
                  onChange={(e) => updateRule(index, { pattern: e.target.value })}
                />
              )}
              <select
                aria-label={t('mem.rules.modeLabel')}
                data-testid={`repository-mem-rule-mode-${repositoryId}-${index}`}
                className={INPUT_CLASS}
                value={rule.mode}
                onChange={(e) => updateRule(index, { mode: e.target.value as MemMode })}
              >
                {MEM_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {modeLabel(mode)}
                  </option>
                ))}
              </select>
              <Button variant="ghost" size="sm" aria-label={t('mem.rules.up')} onClick={() => moveRule(index, -1)}>
                ↑
              </Button>
              <Button variant="ghost" size="sm" aria-label={t('mem.rules.down')} onClick={() => moveRule(index, 1)}>
                ↓
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('mem.rules.remove')}
                onClick={() => setRules((current) => current.filter((_, i) => i !== index))}
              >
                ×
              </Button>
            </li>
          ))}
        </ol>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`repository-mem-rule-add-${repositoryId}`}
          onClick={() => setRules((current) => [...current, { match: 'glob', pattern: '', mode: 'off' }])}
        >
          {t('mem.rules.add')}
        </Button>
      </section>

      <section className="space-y-1">
        <h4 className="text-xs font-medium text-foreground">{t('mem.features.title')}</h4>
        {MEM_FEATURE_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              data-testid={`repository-mem-feature-${repositoryId}-${key}`}
              checked={features[key]}
              onChange={(e) => setFeatures((current) => ({ ...current, [key]: e.target.checked }))}
            />
            {t(`mem.features.${key}`)}
          </label>
        ))}
      </section>

      <Button
        size="sm"
        data-testid={`repository-mem-save-${repositoryId}`}
        disabled={saveState === 'saving'}
        onClick={() => void saveRules()}
      >
        {t('mem.save')}
      </Button>

      <section className="space-y-2">
        <h4 className="text-xs font-medium text-foreground">{t('mem.overrides.title')}</h4>
        {settings.overrides.length === 0 && <p className="text-xs text-muted-foreground">{t('mem.overrides.none')}</p>}
        <ul className="space-y-1">
          {settings.overrides.map((override) => (
            <li key={override.branch} className="flex flex-wrap items-center gap-2 text-xs text-foreground">
              <span className="break-all font-mono">{override.branch}</span>
              <span className="text-muted-foreground">{override.mode ? modeLabel(override.mode) : t('mem.overrides.inherit')}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('mem.overrides.remove', { branch: override.branch })}
                onClick={() => void removeOverride(override.branch)}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-1">
          <input
            type="text"
            aria-label={t('mem.overrides.branch')}
            placeholder={t('mem.overrides.branch')}
            data-testid={`repository-mem-override-branch-${repositoryId}`}
            className={`${INPUT_CLASS} min-w-0 flex-1`}
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
          />
          <select
            aria-label={t('mem.rules.modeLabel')}
            data-testid={`repository-mem-override-mode-${repositoryId}`}
            className={INPUT_CLASS}
            value={newBranchMode}
            onChange={(e) => setNewBranchMode(e.target.value as MemMode)}
          >
            {MEM_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {modeLabel(mode)}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`repository-mem-override-add-${repositoryId}`}
            onClick={() => void addOverride()}
          >
            {t('mem.overrides.add')}
          </Button>
        </div>
      </section>

      {saveState && saveState !== 'saving' && (
        <p
          role={saveState === 'saved' ? 'status' : 'alert'}
          data-testid={`repository-mem-status-${repositoryId}`}
          className={`text-xs ${saveState === 'saved' ? 'text-muted-foreground' : 'text-danger-foreground'}`}
        >
          {t(`mem.status.${saveState}`)}
        </p>
      )}
    </div>
  );
}

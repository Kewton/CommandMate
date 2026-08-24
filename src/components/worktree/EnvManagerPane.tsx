/**
 * EnvManagerPane Component (Issue #1968)
 *
 * The dedicated, masked editor for a worktree's `.env` files. Shared verbatim
 * by both surfaces:
 *   - PC:     Activity Bar `env` activity (WorktreeDetailDesktop.activityContent)
 *   - Mobile: `Tools` tab sub-tab (NotesAndLogsPane)
 *
 * WHY THIS EXISTS AS ITS OWN SURFACE
 * ----------------------------------
 * `.env*` is in `EXCLUDED_PATTERNS` (`src/lib/file-tree.ts`) so it never shows
 * up in the file tree, and it is not in `EDITABLE_EXTENSIONS` so the general
 * file PUT refuses it. Both of those stay exactly as they are. This pane is the
 * *other* door: a narrow one, with masking on by default, a server-side name
 * allow-list, and syntax validation — none of which the general file editor has
 * or should have.
 *
 * MASKING IS THE DEFAULT, IN BOTH VIEWS
 * -------------------------------------
 * A hidden row renders `ENV_MASK` (a FIXED eight dots — see `env-masking.ts`
 * for why the mask does not preserve length) and is `readOnly`: you cannot type
 * over a secret you cannot see. Revealing a row makes it editable. The Raw view
 * masks the right-hand side of every `=` the same way.
 *
 * TOUCH AND THEME
 * ---------------
 * Nothing here is hover-gated. The row actions sit at `opacity-80` and sharpen
 * on hover, with `[@media(hover:none)]:opacity-100` so a touch device — which
 * never delivers a hover — gets them at full strength. Every control is a
 * `ui/Button` (>=44px tall on the touch paths) and every colour is a semantic
 * token, so light and dark both read correctly.
 */

'use client';

import React, { memo, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Spinner } from '@/components/ui/Spinner';
import { useEnvManager } from '@/hooks/useEnvManager';
import { ENV_MASK, maskEnvRawText, maskEnvValue } from '@/lib/env-manager/env-masking';
import { parseEnvContent, type EnvIssue, type EnvIssueCode } from '@/lib/env-manager/env-parser';

export interface EnvManagerPaneProps {
  /** Worktree whose root env files are edited. */
  worktreeId: string;
  /** Additional CSS classes for the root container. */
  className?: string;
}

/**
 * Row-action affordance.
 *
 * `opacity-80` (not `opacity-0`) is the point: the buttons are always visible.
 * The hover step is polish, and the `hover:none` branch restores full opacity
 * on touch devices, which never fire hover at all.
 */
const ROW_ACTION_CLASS =
  'flex-shrink-0 px-2 opacity-80 transition-opacity hover:opacity-100 [@media(hover:none)]:opacity-100';

/**
 * Issue code -> translation key. An explicit table rather than a template
 * literal so every code is greppable and a new code cannot silently render as
 * a raw identifier.
 */
const ISSUE_LABEL_KEY: Record<EnvIssueCode, string> = {
  'invalid-syntax': 'envManager.issues.invalidSyntax',
  'invalid-key': 'envManager.issues.invalidKey',
  'unterminated-quote': 'envManager.issues.unterminatedQuote',
  'duplicate-key': 'envManager.issues.duplicateKey',
  'control-character': 'envManager.issues.controlCharacter',
  'too-large': 'envManager.issues.tooLarge',
  'too-many-entries': 'envManager.issues.tooManyEntries',
};

export const EnvManagerPane = memo(function EnvManagerPane({
  worktreeId,
  className = '',
}: EnvManagerPaneProps) {
  const t = useTranslations('worktree');
  const env = useEnvManager(worktreeId);

  const { mode, rows, revealedKeys, rawRevealed } = env;

  const errors = useMemo(
    () => env.issues.filter((issue) => issue.severity === 'error'),
    [env.issues],
  );
  const warnings = useMemo(
    () => env.issues.filter((issue) => issue.severity === 'warning'),
    [env.issues],
  );

  /** Whether the "reveal everything" control is currently in the revealed state. */
  const allRevealed =
    mode === 'raw'
      ? rawRevealed
      : rows.length > 0 && rows.every((row) => revealedKeys.has(row.key));

  const handleToggleAll = useCallback(() => {
    if (mode === 'raw') {
      env.toggleRawReveal();
      return;
    }
    if (allRevealed) {
      env.hideAll();
    } else {
      env.revealAll();
    }
  }, [mode, allRevealed, env]);

  /** Masked mirror of the raw draft. Recomputed only while the Raw view is hidden. */
  const maskedRaw = useMemo(() => {
    if (mode !== 'raw' || rawRevealed) return '';
    return maskEnvRawText(env.rawDraft, parseEnvContent(env.rawDraft).entries);
  }, [mode, rawRevealed, env.rawDraft]);

  const renderIssue = useCallback(
    (issue: EnvIssue, index: number) => (
      <li key={`${issue.code}-${issue.line ?? 'file'}-${index}`}>
        {t(ISSUE_LABEL_KEY[issue.code], {
          line: issue.line ?? 0,
          // The key NAME is safe to show — it is the half of the line the user
          // has to fix. A value is never passed to a translation.
          key: issue.key ?? '',
        })}
      </li>
    ),
    [t],
  );

  return (
    <div
      data-testid="env-manager-pane"
      role="region"
      aria-label={t('envManager.title')}
      className={`flex flex-col h-full min-h-0 bg-background ${className}`.trim()}
    >
      {/* ---------------------------------------------------------------- */}
      {/* Header: file picker, view switch, reveal / reload / save         */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex-shrink-0 border-b border-border bg-surface dark:bg-surface-2 p-2 space-y-2">
        <div
          role="group"
          aria-label={t('envManager.filePickerLabel')}
          // Scrolls instead of wrapping on a ~320px phone; `scrollbar-hide` is
          // defined in globals.css and used by the other mobile tab rows.
          className="flex gap-1 overflow-x-auto scrollbar-hide"
        >
          {env.files.map((file) => (
            <Button
              key={file.name}
              size="sm"
              variant={file.name === env.selectedFile ? 'primary' : 'ghost'}
              onClick={() => env.selectFile(file.name)}
              aria-pressed={file.name === env.selectedFile}
              data-testid={`env-file-${file.name}`}
              className="flex-shrink-0 whitespace-nowrap min-h-[44px] gap-1.5 font-mono text-xs"
            >
              {file.name}
              {!file.exists && (
                <Badge variant="gray">{t('envManager.notCreated')}</Badge>
              )}
              {file.isExample && (
                <Badge variant="info">{t('envManager.templateBadge')}</Badge>
              )}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t('envManager.viewModeLabel')} className="flex gap-1">
            <Button
              size="sm"
              variant={mode === 'kv' ? 'primary' : 'ghost'}
              onClick={() => env.setMode('kv')}
              aria-pressed={mode === 'kv'}
              data-testid="env-mode-kv"
              className="min-h-[44px]"
            >
              {t('envManager.viewKeyValue')}
            </Button>
            <Button
              size="sm"
              variant={mode === 'raw' ? 'primary' : 'ghost'}
              onClick={() => env.setMode('raw')}
              aria-pressed={mode === 'raw'}
              data-testid="env-mode-raw"
              className="min-h-[44px]"
            >
              {t('envManager.viewRaw')}
            </Button>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleToggleAll}
              data-testid="env-toggle-all"
              aria-pressed={allRevealed}
              className="min-h-[44px] gap-1.5"
            >
              {allRevealed ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Eye size={16} aria-hidden="true" />
              )}
              <span className="hidden sm:inline">
                {allRevealed ? t('envManager.hideAll') : t('envManager.revealAll')}
              </span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={env.reload}
              data-testid="env-reload"
              aria-label={t('envManager.reload')}
              className="min-h-[44px]"
            >
              <RefreshCw size={16} aria-hidden="true" />
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={env.save}
              loading={env.saving}
              disabled={!env.canSave || !env.dirty}
              data-testid="env-save"
              className="min-h-[44px] gap-1.5"
            >
              <Save size={16} aria-hidden="true" />
              {t('envManager.save')}
            </Button>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Body                                                              */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-3">
        {/* Stated once, in the body rather than a tooltip: "values are hidden by
            default" is the security property of this pane, and a reader who
            never hovers (touch) would otherwise never be told. */}
        <p data-testid="env-description" className="text-xs text-muted-foreground">
          {t('envManager.description')}
        </p>

        {env.loading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner size="sm" />
            {t('envManager.loading')}
          </div>
        )}

        {env.error && (
          <div
            role="alert"
            data-testid="env-error"
            className="rounded-md border border-danger-border bg-danger-subtle p-2 text-sm text-danger-foreground"
          >
            {t('envManager.loadError')}
          </div>
        )}

        {!env.loading && env.detail && !env.detail.exists && (
          <p
            data-testid="env-not-created"
            className="rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground"
          >
            {t('envManager.notCreatedHint', { file: env.selectedFile })}
          </p>
        )}

        {env.saved && !env.dirty && (
          <p data-testid="env-saved" className="text-xs text-success-foreground">
            {t('envManager.saved')}
          </p>
        )}

        {errors.length > 0 && (
          <div
            role="alert"
            data-testid="env-errors"
            className="rounded-md border border-danger-border bg-danger-subtle p-2 text-xs text-danger-foreground"
          >
            <p className="flex items-center gap-1.5 font-medium">
              <AlertTriangle size={14} aria-hidden="true" />
              {t('envManager.validationFailed')}
            </p>
            <ul className="mt-1 list-disc pl-5 space-y-0.5">{errors.map(renderIssue)}</ul>
          </div>
        )}

        {warnings.length > 0 && (
          <div
            data-testid="env-warnings"
            className="rounded-md border border-warning-border bg-warning-subtle p-2 text-xs text-warning-foreground"
          >
            <ul className="list-disc pl-5 space-y-0.5">{warnings.map(renderIssue)}</ul>
          </div>
        )}

        {/* ------------------------- Key-Value view ------------------------ */}
        {!env.loading && mode === 'kv' && (
          <div data-testid="env-kv-view" className="space-y-2">
            {rows.length === 0 && (
              <p data-testid="env-empty" className="px-1 py-4 text-center text-sm text-muted-foreground">
                {t('envManager.empty')}
              </p>
            )}

            {rows.map((row) => {
              const revealed = revealedKeys.has(row.key);
              return (
                <div
                  key={row.id}
                  data-testid="env-row"
                  data-env-key={row.key}
                  // Stacks on a phone, one line from `sm` up.
                  className="flex flex-col gap-1 rounded-md border border-border bg-surface dark:bg-surface-2 p-2 sm:flex-row sm:items-center sm:gap-2"
                >
                  <Input
                    inputSize="sm"
                    value={row.key}
                    onChange={(e) => env.updateRow(row.id, { key: e.target.value })}
                    aria-label={t('envManager.keyLabel')}
                    spellCheck={false}
                    autoComplete="off"
                    data-testid="env-row-key"
                    className="font-mono text-xs sm:w-2/5"
                  />
                  <div className="flex flex-1 items-center gap-1">
                    <Input
                      inputSize="sm"
                      // A masked row is READ-ONLY on purpose: typing over a
                      // value you cannot see is how secrets get destroyed.
                      readOnly={!revealed}
                      value={revealed ? row.value : maskEnvValue(row.value)}
                      onChange={(e) => env.updateRow(row.id, { value: e.target.value })}
                      aria-label={t('envManager.valueLabel', { key: row.key })}
                      spellCheck={false}
                      autoComplete="off"
                      data-testid="env-row-value"
                      data-masked={revealed ? 'false' : 'true'}
                      className="flex-1 font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => env.toggleReveal(row.key)}
                      aria-label={
                        revealed
                          ? t('envManager.hideValue', { key: row.key })
                          : t('envManager.showValue', { key: row.key })
                      }
                      aria-pressed={revealed}
                      data-testid="env-row-reveal"
                      className={`${ROW_ACTION_CLASS} min-h-[44px]`}
                    >
                      {revealed ? (
                        <EyeOff size={16} aria-hidden="true" />
                      ) : (
                        <Eye size={16} aria-hidden="true" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => env.removeRow(row.id)}
                      aria-label={t('envManager.removeRow', { key: row.key })}
                      data-testid="env-row-remove"
                      className={`${ROW_ACTION_CLASS} min-h-[44px] text-danger`}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              );
            })}

            <Button
              size="sm"
              variant="secondary"
              onClick={() => env.addRow()}
              data-testid="env-add-row"
              className="min-h-[44px] gap-1.5"
            >
              <Plus size={16} aria-hidden="true" />
              {t('envManager.addRow')}
            </Button>

            {env.suggestions.length > 0 && (
              <Card data-testid="env-suggestions" className="mt-3">
                <CardHeader>
                  <CardTitle className="text-sm">{t('envManager.suggestionsTitle')}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {t('envManager.suggestionsHint')}
                  </p>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {env.suggestions.map((suggestion) => (
                    <Button
                      key={`${suggestion.source}:${suggestion.key}`}
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        env.addRow({ key: suggestion.key, value: suggestion.value })
                      }
                      data-testid={`env-suggestion-${suggestion.key}`}
                      className="min-h-[44px] gap-1.5 font-mono text-xs"
                    >
                      <Plus size={14} aria-hidden="true" />
                      {suggestion.key}
                      <span className="font-sans text-muted-foreground">{suggestion.source}</span>
                    </Button>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* ---------------------------- Raw view --------------------------- */}
        {!env.loading && mode === 'raw' && (
          <div data-testid="env-raw-view" className="space-y-2">
            {rawRevealed ? (
              <Textarea
                value={env.rawDraft}
                onChange={(e) => env.setRawDraft(e.target.value)}
                aria-label={t('envManager.rawLabel')}
                spellCheck={false}
                data-testid="env-raw-editor"
                className="min-h-[240px] font-mono text-xs"
              />
            ) : (
              <>
                <Textarea
                  readOnly
                  value={maskedRaw}
                  aria-label={t('envManager.rawMaskedLabel')}
                  spellCheck={false}
                  data-testid="env-raw-masked"
                  className="min-h-[240px] font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  {t('envManager.rawMaskedHint', { mask: ENV_MASK })}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default EnvManagerPane;

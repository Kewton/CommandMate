/**
 * ExternalAppForm Component
 * Form for creating and editing external apps (in modal)
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * @module components/external-apps/ExternalAppForm
 */

'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Input, Modal, Switch, Textarea, inputVariants } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import {
  validateFormData,
  VALID_APP_TYPES,
  APP_TYPE_LABELS,
  PORT_CONSTRAINTS,
  type FormValidationErrors,
} from '@/lib/external-apps/validation';
import type {
  ExternalApp,
  ExternalAppType,
  CreateExternalAppInput,
  UpdateExternalAppInput,
} from '@/types/external-apps';

/**
 * Props for ExternalAppForm component
 */
export interface ExternalAppFormProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** Existing app to edit (null for create mode) */
  editApp?: ExternalApp | null;
  /** Callback on successful save */
  onSave: () => void;
}

/**
 * App type options for the select dropdown
 * Generated from shared validation constants
 */
const appTypeOptions: { value: ExternalAppType; label: string }[] = VALID_APP_TYPES.map(
  (type) => ({
    value: type,
    label: APP_TYPE_LABELS[type],
  })
);

/**
 * ExternalAppForm component
 * Modal form for creating/editing external apps
 *
 * @example
 * ```tsx
 * <ExternalAppForm
 *   isOpen={showForm}
 *   onClose={() => setShowForm(false)}
 *   editApp={selectedApp}
 *   onSave={refreshApps}
 * />
 * ```
 */
export function ExternalAppForm({
  isOpen,
  onClose,
  editApp,
  onSave,
}: ExternalAppFormProps) {
  const t = useTranslations('externalApps');
  const tCommon = useTranslations('common');
  const isEdit = !!editApp;

  // Form state
  const [displayName, setDisplayName] = useState('');
  const [name, setName] = useState('');
  const [pathPrefix, setPathPrefix] = useState('');
  const [targetPort, setTargetPort] = useState<number | ''>('');
  const [appType, setAppType] = useState<ExternalAppType | ''>('');
  const [websocketEnabled, setWebsocketEnabled] = useState(false);
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);

  // UI state
  const [errors, setErrors] = useState<FormValidationErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Initialize form when editing
  useEffect(() => {
    if (isOpen) {
      if (editApp) {
        setDisplayName(editApp.displayName);
        setName(editApp.name);
        setPathPrefix(editApp.pathPrefix);
        setTargetPort(editApp.targetPort);
        setAppType(editApp.appType);
        setWebsocketEnabled(editApp.websocketEnabled);
        setDescription(editApp.description || '');
        setEnabled(editApp.enabled);
      } else {
        // Reset form for create mode
        setDisplayName('');
        setName('');
        setPathPrefix('');
        setTargetPort('');
        setAppType('');
        setWebsocketEnabled(false);
        setDescription('');
        setEnabled(true);
      }
      setErrors({});
      setSubmitError(null);
    }
  }, [isOpen, editApp]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    const validationErrors = validateFormData(
      {
        displayName,
        name,
        pathPrefix,
        targetPort,
        appType,
      },
      isEdit
    );
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});
    setIsSubmitting(true);

    try {
      if (isEdit && editApp) {
        // Update existing app
        const updateData: UpdateExternalAppInput = {
          displayName,
          description: description || undefined,
          targetPort: targetPort || undefined,
          websocketEnabled,
          enabled,
        };

        const response = await fetch(`/api/external-apps/${editApp.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || t('form.updateFailed'));
        }
      } else {
        // Create new app
        const createData: CreateExternalAppInput = {
          displayName,
          name,
          pathPrefix,
          targetPort: targetPort as number,
          appType: appType as ExternalAppType,
          websocketEnabled,
          description: description || undefined,
        };

        const response = await fetch('/api/external-apps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createData),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || t('form.createFailed'));
        }
      }

      onSave();
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : t('form.genericError')
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? t('form.editTitle') : t('form.addTitle')}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Issue #395: Security warning about same-origin proxy risks */}
        <div className="rounded-md bg-warning-subtle p-3 mb-4 border border-warning-border">
          <p className="text-sm text-warning-foreground">
            {t('form.securityWarning')}
          </p>
        </div>

        {/* Display Name */}
        <div>
          <label
            htmlFor="displayName"
            className="block text-sm font-medium text-foreground mb-1"
          >
            {t('form.displayName')} <span className="text-danger">*</span>
          </label>
          <Input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={errors.displayName ? 'border-danger' : ''}
            placeholder={t('form.displayNamePlaceholder')}
            disabled={isSubmitting}
          />
          {errors.displayName && (
            <p className="mt-1 text-xs text-danger">{errors.displayName}</p>
          )}
        </div>

        {/* Identifier Name (only for create) */}
        {!isEdit && (
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-foreground mb-1"
            >
              {t('form.identifierName')} <span className="text-danger">*</span>
            </label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`font-mono ${errors.name ? 'border-danger' : ''}`}
              placeholder={t('form.identifierNamePlaceholder')}
              disabled={isSubmitting}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('form.identifierNameHelp')}
            </p>
            {errors.name && (
              <p className="mt-1 text-xs text-danger">{errors.name}</p>
            )}
          </div>
        )}

        {/* Path Prefix (only for create) */}
        {!isEdit && (
          <div>
            <label
              htmlFor="pathPrefix"
              className="block text-sm font-medium text-foreground mb-1"
            >
              {t('form.pathPrefix')} <span className="text-danger">*</span>
            </label>
            <div className="flex items-center">
              <span className="text-sm text-muted-foreground mr-1">/proxy/</span>
              <Input
                id="pathPrefix"
                type="text"
                value={pathPrefix}
                onChange={(e) => setPathPrefix(e.target.value)}
                className={`w-auto flex-1 font-mono ${errors.pathPrefix ? 'border-danger' : ''}`}
                placeholder={t('form.pathPrefixPlaceholder')}
                disabled={isSubmitting}
              />
              <span className="text-sm text-muted-foreground ml-1">/</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('form.pathPrefixHelp')}
            </p>
            {errors.pathPrefix && (
              <p className="mt-1 text-xs text-danger">{errors.pathPrefix}</p>
            )}
          </div>
        )}

        {/* Port Number */}
        <div>
          <label
            htmlFor="targetPort"
            className="block text-sm font-medium text-foreground mb-1"
          >
            {t('form.portNumber')} <span className="text-danger">*</span>
          </label>
          <Input
            id="targetPort"
            type="number"
            value={targetPort}
            onChange={(e) =>
              setTargetPort(e.target.value ? parseInt(e.target.value, 10) : '')
            }
            className={`font-mono ${errors.targetPort ? 'border-danger' : ''}`}
            placeholder={t('form.portNumberPlaceholder')}
            min={PORT_CONSTRAINTS.MIN}
            max={PORT_CONSTRAINTS.MAX}
            disabled={isSubmitting}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t('form.portNumberHelp', {
              min: PORT_CONSTRAINTS.MIN,
              max: PORT_CONSTRAINTS.MAX,
            })}
          </p>
          {errors.targetPort && (
            <p className="mt-1 text-xs text-danger">{errors.targetPort}</p>
          )}
        </div>

        {/* App Type (only for create) */}
        {!isEdit && (
          <div>
            <label
              htmlFor="appType"
              className="block text-sm font-medium text-foreground mb-1"
            >
              {t('form.appType')} <span className="text-danger">*</span>
            </label>
            <select
              id="appType"
              value={appType}
              onChange={(e) => setAppType(e.target.value as ExternalAppType)}
              className={cn(inputVariants(), errors.appType && 'border-danger')}
              disabled={isSubmitting}
            >
              <option value="">{t('form.appTypePlaceholder')}</option>
              {appTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {errors.appType && (
              <p className="mt-1 text-xs text-danger">{errors.appType}</p>
            )}
          </div>
        )}

        {/* Description */}
        <div>
          <label
            htmlFor="description"
            className="block text-sm font-medium text-foreground mb-1"
          >
            {t('form.description')}
          </label>
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('form.descriptionPlaceholder')}
            rows={2}
            disabled={isSubmitting}
          />
        </div>

        {/* WebSocket */}
        <div className="flex items-center gap-2">
          <Switch
            id="websocketEnabled"
            checked={websocketEnabled}
            onCheckedChange={setWebsocketEnabled}
            disabled={isSubmitting}
          />
          <label
            htmlFor="websocketEnabled"
            className="text-sm text-foreground"
          >
            {t('form.websocketLabel')}
          </label>
        </div>

        {/* Enabled (only for edit) */}
        {isEdit && (
          <div className="flex items-center gap-2">
            <Switch
              id="enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={isSubmitting}
            />
            <label htmlFor="enabled" className="text-sm text-foreground">
              {t('form.enabledLabel')}
            </label>
          </div>
        )}

        {/* Submit Error */}
        {submitError && (
          <div className="p-3 bg-danger-subtle border border-danger-border rounded text-sm text-danger-foreground">
            {submitError}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isSubmitting}
          >
            {tCommon('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={isSubmitting}>
            {isEdit ? t('form.save') : t('form.add')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

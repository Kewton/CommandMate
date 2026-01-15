/**
 * ExternalAppForm Component
 * Form for creating and editing external apps (in modal)
 * Issue #42: Proxy routing for multiple frontend applications
 */

'use client';

import { useState, useEffect } from 'react';
import { Button, Modal } from '@/components/ui';
import type {
  ExternalApp,
  ExternalAppType,
  CreateExternalAppInput,
  UpdateExternalAppInput,
} from '@/types/external-apps';

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
 * Validation errors type
 */
interface ValidationErrors {
  displayName?: string;
  name?: string;
  pathPrefix?: string;
  targetPort?: string;
  appType?: string;
}

/**
 * Validate the form data
 */
function validateForm(
  data: Partial<CreateExternalAppInput>,
  isEdit: boolean
): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!data.displayName?.trim()) {
    errors.displayName = 'Display name is required';
  }

  if (!isEdit) {
    if (!data.name?.trim()) {
      errors.name = 'Identifier name is required';
    } else if (!/^[a-zA-Z0-9-]+$/.test(data.name)) {
      errors.name = 'Only alphanumeric characters and hyphens are allowed';
    }

    if (!data.pathPrefix?.trim()) {
      errors.pathPrefix = 'Path prefix is required';
    } else if (!/^[a-zA-Z0-9-]+$/.test(data.pathPrefix)) {
      errors.pathPrefix = 'Only alphanumeric characters and hyphens are allowed';
    }
  }

  if (!data.targetPort) {
    errors.targetPort = 'Port number is required';
  } else if (data.targetPort < 1024 || data.targetPort > 65535) {
    errors.targetPort = 'Port must be between 1024 and 65535';
  }

  if (!data.appType) {
    errors.appType = 'App type is required';
  }

  return errors;
}

/**
 * App type options
 */
const appTypeOptions: { value: ExternalAppType; label: string }[] = [
  { value: 'sveltekit', label: 'SvelteKit' },
  { value: 'streamlit', label: 'Streamlit' },
  { value: 'nextjs', label: 'Next.js' },
  { value: 'other', label: 'Other' },
];

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
  const [errors, setErrors] = useState<ValidationErrors>({});
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

    const formData: Partial<CreateExternalAppInput> = {
      displayName,
      name,
      pathPrefix,
      targetPort: targetPort || undefined,
      appType: appType || undefined,
      websocketEnabled,
      description: description || undefined,
    };

    const validationErrors = validateForm(formData, isEdit);
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
          throw new Error(data.error || 'Failed to update app');
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
          throw new Error(data.error || 'Failed to create app');
        }
      }

      onSave();
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : 'An error occurred'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? 'Edit External App' : 'Add External App'}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Display Name */}
        <div>
          <label
            htmlFor="displayName"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Display Name <span className="text-red-500">*</span>
          </label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={`input w-full ${errors.displayName ? 'border-red-500' : ''}`}
            placeholder="My App"
            disabled={isSubmitting}
          />
          {errors.displayName && (
            <p className="mt-1 text-xs text-red-500">{errors.displayName}</p>
          )}
        </div>

        {/* Identifier Name (only for create) */}
        {!isEdit && (
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Identifier Name <span className="text-red-500">*</span>
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`input w-full font-mono ${errors.name ? 'border-red-500' : ''}`}
              placeholder="my-app"
              disabled={isSubmitting}
            />
            <p className="mt-1 text-xs text-gray-500">
              Alphanumeric and hyphens only. Cannot be changed later.
            </p>
            {errors.name && (
              <p className="mt-1 text-xs text-red-500">{errors.name}</p>
            )}
          </div>
        )}

        {/* Path Prefix (only for create) */}
        {!isEdit && (
          <div>
            <label
              htmlFor="pathPrefix"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Path Prefix <span className="text-red-500">*</span>
            </label>
            <div className="flex items-center">
              <span className="text-sm text-gray-500 mr-1">/proxy/</span>
              <input
                id="pathPrefix"
                type="text"
                value={pathPrefix}
                onChange={(e) => setPathPrefix(e.target.value)}
                className={`input flex-1 font-mono ${errors.pathPrefix ? 'border-red-500' : ''}`}
                placeholder="app-name"
                disabled={isSubmitting}
              />
              <span className="text-sm text-gray-500 ml-1">/</span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              URL path for accessing this app. Cannot be changed later.
            </p>
            {errors.pathPrefix && (
              <p className="mt-1 text-xs text-red-500">{errors.pathPrefix}</p>
            )}
          </div>
        )}

        {/* Port Number */}
        <div>
          <label
            htmlFor="targetPort"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Port Number <span className="text-red-500">*</span>
          </label>
          <input
            id="targetPort"
            type="number"
            value={targetPort}
            onChange={(e) =>
              setTargetPort(e.target.value ? parseInt(e.target.value, 10) : '')
            }
            className={`input w-full font-mono ${errors.targetPort ? 'border-red-500' : ''}`}
            placeholder="5173"
            min={1024}
            max={65535}
            disabled={isSubmitting}
          />
          <p className="mt-1 text-xs text-gray-500">
            Target port (1024-65535)
          </p>
          {errors.targetPort && (
            <p className="mt-1 text-xs text-red-500">{errors.targetPort}</p>
          )}
        </div>

        {/* App Type (only for create) */}
        {!isEdit && (
          <div>
            <label
              htmlFor="appType"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              App Type <span className="text-red-500">*</span>
            </label>
            <select
              id="appType"
              value={appType}
              onChange={(e) => setAppType(e.target.value as ExternalAppType)}
              className={`input w-full ${errors.appType ? 'border-red-500' : ''}`}
              disabled={isSubmitting}
            >
              <option value="">Select app type...</option>
              {appTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {errors.appType && (
              <p className="mt-1 text-xs text-red-500">{errors.appType}</p>
            )}
          </div>
        )}

        {/* Description */}
        <div>
          <label
            htmlFor="description"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Description
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input w-full"
            placeholder="Optional description..."
            rows={2}
            disabled={isSubmitting}
          />
        </div>

        {/* WebSocket */}
        <div className="flex items-center">
          <input
            id="websocketEnabled"
            type="checkbox"
            checked={websocketEnabled}
            onChange={(e) => setWebsocketEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            disabled={isSubmitting}
          />
          <label
            htmlFor="websocketEnabled"
            className="ml-2 text-sm text-gray-700"
          >
            Enable WebSocket support
          </label>
        </div>

        {/* Enabled (only for edit) */}
        {isEdit && (
          <div className="flex items-center">
            <input
              id="enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              disabled={isSubmitting}
            />
            <label htmlFor="enabled" className="ml-2 text-sm text-gray-700">
              App is enabled
            </label>
          </div>
        )}

        {/* Submit Error */}
        {submitError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {submitError}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-gray-200">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={isSubmitting}>
            {isEdit ? 'Save Changes' : 'Add App'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

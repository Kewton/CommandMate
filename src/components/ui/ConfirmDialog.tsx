/**
 * ConfirmDialog Component
 * Styled replacement for window.confirm() (Issue #1113)
 *
 * Use `useConfirm()` inside a `ConfirmProvider` (mounted in AppProviders):
 * `const confirmed = await confirm({ description, variant: 'danger' })`
 */

'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

export type ConfirmVariant = 'default' | 'danger';

export interface ConfirmOptions {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useTranslations('common');
  const isDanger = variant === 'danger';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title ?? t('confirmDialog.title')}
      size="sm"
      showCloseButton={false}
    >
      <div className="space-y-4" data-testid="confirm-dialog">
        <p className="text-sm text-foreground whitespace-pre-line">{description}</p>
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            // Data-loss prevention: danger confirms start focused on cancel
            autoFocus={isDanger}
            onClick={onCancel}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel ?? t('cancel')}
          </Button>
          <Button
            type="button"
            variant={isDanger ? 'danger' : 'primary'}
            size="sm"
            autoFocus={!isDanger}
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel ?? t('confirmDialog.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (result: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPending((prev) => {
        // A second confirm() while one is open cancels the first (no queueing)
        prev?.resolve(false);
        return { options, resolve };
      });
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    setPending((prev) => {
      prev?.resolve(result);
      return null;
    });
    restoreFocusRef.current?.focus();
    restoreFocusRef.current = null;
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        isOpen={pending !== null}
        title={pending?.options.title}
        description={pending?.options.description ?? ''}
        confirmLabel={pending?.options.confirmLabel}
        cancelLabel={pending?.options.cancelLabel}
        variant={pending?.options.variant}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  );
}

const fallbackConfirm: ConfirmFn = async () => {
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      '[useConfirm] No ConfirmProvider found in the tree; resolving to false.'
    );
  }
  return false;
};

/**
 * Promise-based confirmation hook.
 * Without a ConfirmProvider it resolves to false (and warns outside production)
 * so plain component tests do not need the provider.
 */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? fallbackConfirm;
}
